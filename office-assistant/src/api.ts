import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import { PRODUCT_NAME } from "./brand";
import { adminToken, config } from "./config";
import { authFromSession, clearFailures, createSession, endSession, hashPassword, login, MIN_PASSWORD, noteFailure, tooManyAttempts, type Auth } from "./auth";
import { findManifest, publicCatalog, splitFields } from "./connectors/registry";
import { decryptJson } from "./lib/crypto";
import { db } from "./lib/db";
import { toE164 } from "./lib/phone";
import { findScenario, SCENARIOS } from "./sim/scenarios";
import { simulateCall } from "./sim/simulate";
import { importContacts, type ImportContactType } from "./import/contacts";
import { importJobs } from "./import/jobs";
import { accountingFor, getTenantBySlug, saveConnector, type Tenant } from "./tenants";
import { ageTotals, daysOverdue, paymentBlockers, round2 } from "./books/analyze";
import { DEFAULT_CHASE_AFTER_DAYS, syncBooks } from "./books/sync";
import { authorizeUrl, exchangeCode, qboAppFromEnv, signState, verifyState } from "./connectors/quickbooks";

export const TEMPLATE_KEYS = ["lead_callback", "ack_sub_vendor", "ack_client", "generic"] as const;

const SettingsBody = z.object({
  mode: z.enum(["shadow", "live"]),
  confidenceThreshold: z.number().min(0.3).max(0.99),
  chaseAfterDays: z.number().int().min(1).max(90).optional(),
  shadowRecipientPhone: z.string().nullable().optional(),
  templates: z.partialRecord(z.enum(TEMPLATE_KEYS), z.string().max(320)),
});

const NewTenantBody = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9_]{1,30}$/, "Use lowercase letters, numbers and underscores"),
  name: z.string().min(2).max(120),
  timezone: z.string().default("America/New_York"),
});

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const bearerOf = (req: Request) => /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
const authOf = (res: Response) => res.locals.auth as Auth;

/** Operator token (all companies) or a signed in user's session (one company, by role). */
function authenticate(req: Request, res: Response, next: NextFunction) {
  const given = bearerOf(req);
  const expected = adminToken();
  if (expected && given && safeEqual(given, expected)) {
    res.locals.auth = { kind: "operator" } satisfies Auth;
    return next();
  }
  authFromSession(given).then((a) => {
    if (!a) return void res.status(401).json({ error: "Wrong or missing sign in" });
    res.locals.auth = a;
    next();
  }, next);
}

/** Owners (and the operator) pass; others get a 403. */
function allow(res: Response, ...roles: Array<"owner" | "office" | "pm">): boolean {
  const a = authOf(res);
  if (a.kind === "operator" || roles.includes(a.role)) return true;
  res.status(403).json({ error: "Your role can't do that" });
  return false;
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

async function tenantOf(req: Request, res: Response): Promise<Tenant | null> {
  const a = authOf(res);
  if (a.kind === "user" && a.slug !== String(req.params.slug)) {
    res.status(403).json({ error: "That isn't your company" });
    return null;
  }
  const t = await getTenantBySlug(String(req.params.slug));
  if (!t) res.status(404).json({ error: "Unknown company" });
  return t;
}

export function apiRouter(): Router {
  const r = Router();
  r.use(express.json({ limit: "8mb" })); // CSV imports arrive as text in the body

  r.post("/login", wrap(async (req, res) => {
    const body = z.object({ email: z.string().min(3), password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "Enter your email and password" });
    const key = `${body.data.email.toLowerCase()}|${req.ip}`;
    if (tooManyAttempts(key)) return void res.status(429).json({ error: "Too many tries. Wait 15 minutes." });
    const token = await login(body.data.email, body.data.password);
    if (!token) {
      noteFailure(key);
      return void res.status(401).json({ error: "Wrong email or password" });
    }
    clearFailures(key);
    res.json({ token });
  }));

  // Intuit sends the browser back here, so it cannot carry our sign in. The signed state ties it to one company.
  r.get("/oauth/quickbooks/callback", wrap(async (req, res) => {
    const app = qboAppFromEnv();
    const state = String(req.query.state ?? "");
    const slug = app ? verifyState(state, Buffer.from(config.encryptionKey(), "base64")) : null;
    const t = slug ? await getTenantBySlug(slug) : null;
    if (!app || !t || !req.query.code || !req.query.realmId) return void res.status(400).send("That QuickBooks link expired or is invalid. Start again from Connectors.");
    try {
      const secrets = await exchangeCode(app, String(req.query.code), `${config.publicBaseUrl()}/api/oauth/quickbooks/callback`, String(req.query.realmId));
      await saveConnector(t.id, "accounting", "quickbooks", { realmId: secrets.realmId }, secrets);
      res.redirect("/?connected=quickbooks");
    } catch (err) {
      res.status(502).send("QuickBooks didn't accept the sign in. Try again from Connectors.");
    }
  }));

  r.use(authenticate);

  r.post("/logout", wrap(async (req, res) => {
    await endSession(bearerOf(req));
    res.json({ ok: true });
  }));

  r.get("/me", (_req, res) => {
    const a = authOf(res);
    res.json(a.kind === "operator" ? { role: "operator", name: "Operator", slug: null } : { role: a.role, name: a.name, slug: a.slug });
  });

  r.get("/meta", (_req, res) => {
    res.json({ product: PRODUCT_NAME, connectors: publicCatalog(), scenarios: SCENARIOS.map((s) => ({ id: s.id, label: s.label })), templateKeys: TEMPLATE_KEYS });
  });

  r.get("/tenants", wrap(async (_req, res) => {
    const a = authOf(res);
    const { rows } = await db().query(
      "SELECT slug, name, timezone, settings->>'mode' AS mode FROM tenants WHERE ($1::text IS NULL OR slug = $1) ORDER BY name",
      [a.kind === "user" ? a.slug : null],
    );
    res.json(rows);
  }));

  r.post("/tenants", wrap(async (req, res) => {
    if (authOf(res).kind !== "operator") return void res.status(403).json({ error: "Only the operator can add companies" });
    const body = NewTenantBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: body.error.issues[0].message });
    if (await getTenantBySlug(body.data.slug)) return void res.status(409).json({ error: "That short name is taken" });
    await db().query("INSERT INTO tenants (slug, name, timezone) VALUES ($1,$2,$3)", [body.data.slug, body.data.name, body.data.timezone]);
    res.status(201).json({ slug: body.data.slug });
  }));

  r.get("/t/:slug/summary", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t) return;
    const { rows } = await db().query(
      `SELECT
         (SELECT count(*)::int FROM interactions WHERE tenant_id = $1 AND channel = 'call') AS calls,
         (SELECT count(*)::int FROM tasks WHERE tenant_id = $1 AND status = 'open') AS open_tasks,
         (SELECT count(*)::int FROM leads WHERE tenant_id = $1 AND status IN ('new','callback')) AS open_leads,
         (SELECT count(*)::int FROM contacts WHERE tenant_id = $1) AS contacts`,
      [t.id],
    );
    res.json({ tenant: { slug: t.slug, name: t.name, mode: t.settings.mode }, ...rows[0] });
  }));

  r.get("/t/:slug/interactions", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t) return;
    const { rows } = await db().query(
      `SELECT i.id, i.channel, i.direction, i.handled_by, i.from_phone, i.to_phone, i.status, i.body,
              i.caller_type, i.confidence, i.processed_at, i.created_at, i.duration_sec,
              i.extracted->>'office_summary' AS summary, i.extracted->>'reasoning' AS reasoning,
              i.transcript, i.voicemail->>'transcript' AS voicemail_transcript,
              NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS contact_name, c.type AS contact_type
       FROM interactions i LEFT JOIN contacts c ON c.id = i.contact_id
       WHERE i.tenant_id = $1 ORDER BY i.created_at DESC LIMIT 100`,
      [t.id],
    );
    res.json(rows);
  }));

  r.get("/t/:slug/tasks", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t) return;
    const status = req.query.status === "done" ? "done" : "open";
    const { rows } = await db().query(
      `SELECT k.id, k.type, k.title, k.body, k.status, k.created_at, i.from_phone
       FROM tasks k LEFT JOIN interactions i ON i.id = k.interaction_id
       WHERE k.tenant_id = $1 AND k.status = $2 ORDER BY k.created_at DESC LIMIT 200`,
      [t.id, status],
    );
    res.json(rows);
  }));

  r.patch("/t/:slug/tasks/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t) return;
    const status = z.enum(["open", "done", "cancelled"]).safeParse(req.body?.status);
    if (!status.success) return void res.status(400).json({ error: "status must be open, done or cancelled" });
    const out = await db().query("UPDATE tasks SET status = $3 WHERE id = $1 AND tenant_id = $2", [req.params.id, t.id, status.data]);
    res.status(out.rowCount ? 200 : 404).json({ ok: Boolean(out.rowCount) });
  }));

  r.get("/t/:slug/leads", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t) return;
    const { rows } = await db().query(
      `SELECT l.id, l.status, l.job_type, l.address, l.timeline, l.budget_hint, l.created_at,
              NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS name,
              (SELECT phone FROM contact_phones WHERE contact_id = c.id LIMIT 1) AS phone
       FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.tenant_id = $1 ORDER BY l.created_at DESC LIMIT 200`,
      [t.id],
    );
    res.json(rows);
  }));

  r.get("/t/:slug/contacts", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t) return;
    const { rows } = await db().query(
      `SELECT c.id, c.type, c.first_name, c.last_name, c.company, c.email, array_remove(array_agg(p.phone), NULL) AS phones
       FROM contacts c LEFT JOIN contact_phones p ON p.contact_id = c.id
       WHERE c.tenant_id = $1 GROUP BY c.id ORDER BY c.created_at DESC LIMIT 300`,
      [t.id],
    );
    res.json(rows);
  }));

  r.get("/t/:slug/outbound", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t) return;
    const { rows } = await db().query(
      "SELECT id, purpose, to_phone, body, mode, error, created_at FROM outbound_messages WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100",
      [t.id],
    );
    res.json(rows);
  }));

  r.get("/t/:slug/settings", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (t) res.json(t.settings);
  }));

  r.put("/t/:slug/settings", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner")) return;
    const body = SettingsBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: body.error.issues[0].message });
    const phone = body.data.shadowRecipientPhone ? toE164(body.data.shadowRecipientPhone) : undefined;
    if (body.data.shadowRecipientPhone && !phone) return void res.status(400).json({ error: "Shadow phone is not a valid number" });
    const next = {
      mode: body.data.mode,
      confidenceThreshold: body.data.confidenceThreshold,
      chaseAfterDays: body.data.chaseAfterDays ?? t.settings.chaseAfterDays,
      templates: Object.fromEntries(Object.entries(body.data.templates).filter(([, v]) => v && v.trim())),
      ...(phone ? { shadowRecipientPhone: phone } : {}),
    };
    await db().query("UPDATE tenants SET settings = $2 WHERE id = $1", [t.id, JSON.stringify(next)]);
    res.json(next);
  }));

  r.get("/t/:slug/connectors", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t) return;
    const { rows } = await db().query<{ kind: string; provider: string; config: any; secrets_enc: string | null }>(
      "SELECT kind, provider, config, secrets_enc FROM connector_accounts WHERE tenant_id = $1",
      [t.id],
    );
    // Never return secret values, only which ones are set.
    res.json(rows.map((c) => ({
      kind: c.kind,
      provider: c.provider,
      config: c.config,
      secretsSet: c.secrets_enc ? Object.keys(decryptJson<Record<string, unknown>>(c.secrets_enc)) : [],
    })));
  }));

  r.put("/t/:slug/connectors/:kind/:provider", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner")) return;
    const m = findManifest(String(req.params.kind), String(req.params.provider));
    if (!m) return void res.status(404).json({ error: "Unknown connector" });
    if (m.status !== "ready") return void res.status(400).json({ error: `${m.label} is not available yet` });
    if (m.oauth) return void res.status(400).json({ error: `Use the Connect button to sign in to ${m.label}` });
    const { rows } = await db().query<{ secrets_enc: string | null }>(
      "SELECT secrets_enc FROM connector_accounts WHERE tenant_id = $1 AND kind = $2 AND provider = $3",
      [t.id, m.kind, m.provider],
    );
    const existing = rows[0]?.secrets_enc ? decryptJson<Record<string, unknown>>(rows[0].secrets_enc) : {};
    let split;
    try {
      split = splitFields(m, req.body ?? {}, existing);
    } catch (err) {
      return void res.status(400).json({ error: (err as Error).message });
    }
    if (typeof split.config.inboxPhoneNumberIds === "string") {
      split.config.inboxPhoneNumberIds = split.config.inboxPhoneNumberIds.split(",").map((s: string) => s.trim()).filter(Boolean);
    }
    if (m.kind === "telephony" && m.provider === "quo") split.secrets.signingKeys ??= [];
    await saveConnector(t.id, m.kind, m.provider, split.config, split.secrets);
    res.json({ ok: true });
  }));

  r.get("/t/:slug/connectors/accounting/quickbooks/authorize", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner")) return;
    const app = qboAppFromEnv();
    if (!app) return void res.status(400).json({ error: "QuickBooks isn't set up on this server yet (needs QBO_CLIENT_ID and QBO_CLIENT_SECRET)" });
    const state = signState(t.slug, Buffer.from(config.encryptionKey(), "base64"));
    res.json({ url: authorizeUrl(app, `${config.publicBaseUrl()}/api/oauth/quickbooks/callback`, state) });
  }));

  r.post("/t/:slug/books/sync", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office")) return;
    let provider;
    try {
      provider = await accountingFor(t.id);
    } catch (err) {
      return void res.status(400).json({ error: (err as Error).message });
    }
    if (!provider) return void res.status(400).json({ error: "Connect QuickBooks (or Demo books) first" });
    try {
      res.json(await syncBooks(t.id, provider, { chaseAfterDays: t.settings.chaseAfterDays }));
    } catch (err) {
      res.status(502).json({ error: `Couldn't read the books: ${(err as Error).message}` });
    }
  }));

  r.get("/t/:slug/books", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office")) return;
    const today = new Date();
    const [bills, invoices, last, conn] = await Promise.all([
      db().query(
        `SELECT b.id, b.vendor_name, b.due_date::text, b.balance::float8 AS balance, b.amount::float8 AS amount, b.doc_number, b.memo, b.suggestion_note,
                j.name AS job_name, c.type AS contact_type, s.w9_on_file, s.coi_expires_on::text AS coi_expires_on, s.lien_waiver_status
         FROM acct_bills b LEFT JOIN jobs j ON j.id = b.suggested_job_id LEFT JOIN contacts c ON c.id = b.contact_id LEFT JOIN sub_profiles s ON s.contact_id = b.contact_id
         WHERE b.tenant_id = $1 ORDER BY b.due_date NULLS LAST`, [t.id]),
      db().query(
        `SELECT i.id, i.customer_name, i.due_date::text, i.balance::float8 AS balance, i.amount::float8 AS amount, i.doc_number, j.name AS job_name
         FROM acct_invoices i LEFT JOIN jobs j ON j.id = i.job_id WHERE i.tenant_id = $1 ORDER BY i.due_date NULLS LAST`, [t.id]),
      db().query("SELECT provider, finished_at, error FROM acct_sync_runs WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1", [t.id]),
      db().query("SELECT provider FROM connector_accounts WHERE tenant_id = $1 AND kind = 'accounting' LIMIT 1", [t.id]),
    ]);
    const billRows = bills.rows.map((b) => ({
      id: b.id, vendor: b.vendor_name, dueDate: b.due_date, balance: b.balance, docNumber: b.doc_number, memo: b.memo,
      daysOverdue: daysOverdue(b.due_date, today), job: b.job_name, jobNote: b.suggestion_note,
      blockers: paymentBlockers({ known: Boolean(b.contact_type), sub: b.w9_on_file === null ? null : { w9OnFile: b.w9_on_file, coiExpiresOn: b.coi_expires_on, lienWaiverStatus: b.lien_waiver_status } }, today),
    }));
    const invoiceRows = invoices.rows.map((i) => ({ id: i.id, customer: i.customer_name, dueDate: i.due_date, balance: i.balance, amount: i.amount, docNumber: i.doc_number, daysOverdue: daysOverdue(i.due_date, today), job: i.job_name }));
    res.json({
      connected: conn.rows[0]?.provider ?? null,
      lastSync: last.rows[0] ?? null,
      chaseAfterDays: t.settings.chaseAfterDays ?? DEFAULT_CHASE_AFTER_DAYS,
      payable: ageTotals(billRows, today),
      receivable: ageTotals(invoiceRows, today),
      held: round2(billRows.filter((b) => b.blockers.length).reduce((n, b) => n + b.balance, 0)),
      bills: billRows,
      invoices: invoiceRows,
    });
  }));

  const NewUserBody = z.object({
    name: z.string().min(1).max(120),
    email: z.string().email(),
    phone: z.string().optional(),
    role: z.enum(["owner", "office", "pm"]),
    password: z.string().min(MIN_PASSWORD, `Password needs at least ${MIN_PASSWORD} characters`),
  });

  r.get("/t/:slug/users", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner")) return;
    const { rows } = await db().query(
      "SELECT id, name, email, phone, role, alerts_enabled, last_login_at FROM users WHERE tenant_id = $1 ORDER BY created_at",
      [t.id],
    );
    res.json(rows);
  }));

  r.post("/t/:slug/users", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner")) return;
    const body = NewUserBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: body.error.issues[0].message });
    const phone = body.data.phone ? toE164(body.data.phone) : null;
    if (body.data.phone && !phone) return void res.status(400).json({ error: "That phone number isn't valid" });
    const dupe = await db().query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [body.data.email]);
    if (dupe.rowCount) return void res.status(409).json({ error: "That email already has an account" });
    const { rows } = await db().query<{ id: string }>(
      "INSERT INTO users (tenant_id, name, email, phone, role, password_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [t.id, body.data.name, body.data.email, phone, body.data.role, hashPassword(body.data.password)],
    );
    res.status(201).json({ id: rows[0].id });
  }));

  r.patch("/t/:slug/users/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner")) return;
    const body = z.object({ alertsEnabled: z.boolean().optional(), phone: z.string().nullable().optional(), password: z.string().min(MIN_PASSWORD).optional() }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: body.error.issues[0].message });
    const phone = body.data.phone ? toE164(body.data.phone) : body.data.phone;
    if (body.data.phone && !phone) return void res.status(400).json({ error: "That phone number isn't valid" });
    if (body.data.alertsEnabled !== undefined) await db().query("UPDATE users SET alerts_enabled = $3 WHERE id = $1 AND tenant_id = $2", [req.params.id, t.id, body.data.alertsEnabled]);
    if (phone !== undefined) await db().query("UPDATE users SET phone = $3 WHERE id = $1 AND tenant_id = $2", [req.params.id, t.id, phone]);
    if (body.data.password) {
      await db().query("UPDATE users SET password_hash = $3 WHERE id = $1 AND tenant_id = $2", [req.params.id, t.id, hashPassword(body.data.password)]);
      await db().query("DELETE FROM sessions WHERE user_id = $1", [req.params.id]); // a reset signs the person out everywhere
    }
    res.json({ ok: true });
  }));

  r.delete("/t/:slug/users/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner")) return;
    const a = authOf(res);
    if (a.kind === "user" && a.userId === req.params.id) return void res.status(400).json({ error: "You can't remove yourself" });
    const out = await db().query("DELETE FROM users WHERE id = $1 AND tenant_id = $2", [req.params.id, t.id]);
    res.status(out.rowCount ? 200 : 404).json({ ok: Boolean(out.rowCount) });
  }));

  const ImportBody = z.object({
    csv: z.string().min(1).optional(),
    xlsxBase64: z.string().min(1).optional(),
    defaultType: z.enum(["client", "sub", "vendor", "prospect", "other"]).default("other"),
    dryRun: z.boolean().default(true),
  });

  r.post("/t/:slug/import/:kind", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner")) return;
    const body = ImportBody.safeParse(req.body);
    if (!body.success || (!body.data.csv && !body.data.xlsxBase64)) return void res.status(400).json({ error: "Send the file as csv text or xlsxBase64" });
    const input: string | Buffer = body.data.xlsxBase64 ? Buffer.from(body.data.xlsxBase64, "base64") : body.data.csv!;
    try {
      const result =
        req.params.kind === "contacts"
          ? await importContacts(t.id, input, { defaultType: body.data.defaultType as ImportContactType, dryRun: body.data.dryRun })
          : req.params.kind === "jobs"
            ? await importJobs(t.id, input, { dryRun: body.data.dryRun })
            : null;
      if (!result) return void res.status(404).json({ error: "Import contacts or jobs" });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  // Only allowed on the demo phone, so a simulated call can never text a real number.
  r.post("/t/:slug/simulate", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner")) return;
    const scenario = findScenario(String(req.body?.scenario));
    if (!scenario) return void res.status(400).json({ error: "Unknown scenario" });
    const { rows } = await db().query("SELECT 1 FROM connector_accounts WHERE tenant_id = $1 AND kind = 'telephony' AND provider = 'mock'", [t.id]);
    if (!rows.length) return void res.status(400).json({ error: "Connect the Demo phone first. Simulated calls only run on it." });
    const other = await db().query("SELECT 1 FROM connector_accounts WHERE tenant_id = $1 AND kind = 'telephony' AND provider <> 'mock'", [t.id]);
    if (other.rowCount) return void res.status(400).json({ error: "This company has a real phone connected. Simulate on a demo company." });
    res.json({ callId: await simulateCall(t.id, scenario) });
  }));

  r.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return r;
}
