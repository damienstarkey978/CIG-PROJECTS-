import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import { PRODUCT_NAME } from "./brand";
import { DEFAULT_TEMPLATES, TEMPLATE_INFO, TEMPLATE_KEYS } from "./copy";
import { adminToken, config } from "./config";
import { authFromSession, clearFailures, createSession, endSession, hashPassword, login, MIN_PASSWORD, noteFailure, tooManyAttempts, type Auth } from "./auth";
import { findManifest, publicCatalog, splitFields } from "./connectors/registry";
import { decryptJson } from "./lib/crypto";
import { db } from "./lib/db";
import { toE164 } from "./lib/phone";
import { findScenario, SCENARIOS } from "./sim/scenarios";
import { simulateCall } from "./sim/simulate";
import { offlineDrafter, type Drafter } from "./changeorders/draft";
import { draftChangeOrder, getChangeOrder, listChangeOrders, TRANSITIONS, type CoStatus } from "./changeorders/store";
import { importContacts, type ImportContactType } from "./import/contacts";
import { importJobs } from "./import/jobs";
import { accountingFor, emailFor, getTenantBySlug, saveConnector, telephonyFor, type Tenant } from "./tenants";
import { paperworkNeeds } from "./subs/paperwork";
import { logPermitEvent, permitAttention, runPermitNudges } from "./permits/nudges";
import { buildClientUpdates } from "./updates/build";
import { offlineEmailParser, type EmailParser } from "./updates/parse";
import { createPermitReportDraft } from "./updates/permitReport";
import { sendDraft, validEmails } from "./updates/send";
import { runAutomation } from "./subs/automation";
import { ingestEvent } from "./pipeline/ingest";
import { ageTotals, daysOverdue, paymentBlockers, round2 } from "./books/analyze";
import { DEFAULT_CHASE_AFTER_DAYS, syncBooks } from "./books/sync";
import { authorizeUrl, exchangeCode, qboAppFromEnv, signState, verifyState } from "./connectors/quickbooks";


const SettingsBody = z.object({
  mode: z.enum(["shadow", "live"]),
  confidenceThreshold: z.number().min(0.3).max(0.99),
  chaseAfterDays: z.number().int().min(1).max(90).optional(),
  outboundNumber: z.string().nullable().optional(),
  weeklyUpdates: z.object({
    cc: z.array(z.string().email()).max(10),
    closing: z.string().max(500),
    signature: z.string().max(1500),
    senders: z.array(z.string().email()).max(10),
  }).optional(),
  permitReport: z.object({ enabled: z.boolean(), to: z.array(z.string().email()).max(15), signature: z.string().max(1500).optional() }).optional(),
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

export function apiRouter(opts: { draft?: Drafter; parseEmail?: EmailParser } = {}): Router {
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

  // Mail forwarding (Zapier, Mailgun, a Gmail filter, etc.) posts the project manager's email here.
  // A per company secret in the x-inbound-token header, and an allowed sender list, gate it.
  r.post("/inbound/email/:slug", wrap(async (req, res) => {
    const t = await getTenantBySlug(String(req.params.slug));
    const given = String(req.headers["x-inbound-token"] ?? "");
    const stored = t?.settings.weeklyUpdates?.inboundTokenHash;
    if (!t || !stored || !given || !safeEqual(crypto.createHash("sha256").update(given).digest("hex"), stored)) return void res.status(401).json({ error: "Bad token" });
    const b = z.object({ from: z.string().min(3), subject: z.string().max(300).optional(), text: z.string().min(20).max(60000) }).safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "Send from, subject and text" });
    const sender = (/<([^>]+)>/.exec(b.data.from)?.[1] ?? b.data.from).trim().toLowerCase();
    const allowed = (t.settings.weeklyUpdates?.senders ?? []).map((e) => e.toLowerCase());
    if (!allowed.includes(sender)) return void res.status(202).json({ ok: true, ignored: "sender is not on the allowed list" });
    const out = await buildClientUpdates(opts.parseEmail ?? offlineEmailParser(), t, { text: b.data.text, from: sender, subject: b.data.subject ?? null, source: "email" });
    res.status(202).json({ ok: true, drafted: out.drafted.length, skipped: out.skipped.length, alreadyDone: out.alreadyDone.length });
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
    res.json({ product: PRODUCT_NAME, connectors: publicCatalog(), scenarios: SCENARIOS.map((s) => ({ id: s.id, label: s.label })), templateKeys: TEMPLATE_KEYS, templateInfo: TEMPLATE_INFO });
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
    // New companies start with the suggested wording so shadow reports show real text. Mode stays shadow.
    await db().query("INSERT INTO tenants (slug, name, timezone, settings) VALUES ($1,$2,$3,$4)", [body.data.slug, body.data.name, body.data.timezone, JSON.stringify({ mode: "shadow", confidenceThreshold: 0.7, templates: DEFAULT_TEMPLATES })]);
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
      `SELECT k.id, k.type, k.title, k.body, k.status, k.created_at, i.from_phone, i.media
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

  // Never send the inbound secret's hash back to the browser, only whether one exists.
  const publicSettings = (st: any) => ({ ...st, weeklyUpdates: st.weeklyUpdates ? { ...st.weeklyUpdates, inboundTokenHash: undefined, hasInboundToken: Boolean(st.weeklyUpdates.inboundTokenHash) } : undefined });
  r.get("/t/:slug/settings", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (t) res.json(publicSettings(t.settings));
  }));

  r.put("/t/:slug/settings", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner")) return;
    const body = SettingsBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: body.error.issues[0].message });
    const phone = body.data.shadowRecipientPhone ? toE164(body.data.shadowRecipientPhone) : undefined;
    if (body.data.shadowRecipientPhone && !phone) return void res.status(400).json({ error: "Shadow phone is not a valid number" });
    const outbound = body.data.outboundNumber ? toE164(body.data.outboundNumber) : null;
    if (body.data.outboundNumber && !outbound) return void res.status(400).json({ error: "Business line is not a valid number" });
    const next = {
      mode: body.data.mode,
      confidenceThreshold: body.data.confidenceThreshold,
      chaseAfterDays: body.data.chaseAfterDays ?? t.settings.chaseAfterDays,
      weeklyUpdates: body.data.weeklyUpdates ? { ...body.data.weeklyUpdates, inboundTokenHash: t.settings.weeklyUpdates?.inboundTokenHash } : t.settings.weeklyUpdates,
      permitReport: body.data.permitReport ?? t.settings.permitReport,
      ...(outbound ? { outboundNumber: outbound } : body.data.outboundNumber === undefined && t.settings.outboundNumber ? { outboundNumber: t.settings.outboundNumber } : {}),
      templates: Object.fromEntries(Object.entries(body.data.templates).filter(([, v]) => v && v.trim())),
      ...(phone ? { shadowRecipientPhone: phone } : {}),
    };
    await db().query("UPDATE tenants SET settings = $2 WHERE id = $1", [t.id, JSON.stringify(next)]);
    res.json(publicSettings(next));
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

  // ---- subs paperwork and the job schedule ----

  r.get("/t/:slug/subs", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office")) return;
    const { rows } = await db().query(
      `SELECT c.id, c.first_name, c.last_name, c.company, s.trades, s.w9_on_file, s.coi_expires_on::text AS coi_expires_on, s.lien_waiver_status,
              (SELECT phone FROM contact_phones WHERE contact_id = c.id LIMIT 1) AS phone,
              (SELECT count(*)::int FROM job_assignments a WHERE a.sub_contact_id = c.id AND a.start_date >= current_date) AS upcoming
       FROM contacts c JOIN sub_profiles s ON s.contact_id = c.id WHERE c.tenant_id = $1 ORDER BY coalesce(c.company, c.last_name, c.first_name)`, [t.id]);
    const today = new Date();
    res.json(rows.map((s) => ({
      id: s.id, name: [s.first_name, s.last_name].filter(Boolean).join(" ") || null, company: s.company, phone: s.phone, trades: s.trades, upcoming: s.upcoming,
      w9OnFile: s.w9_on_file, coiExpiresOn: s.coi_expires_on, lienWaiverStatus: s.lien_waiver_status,
      needs: paperworkNeeds({ w9OnFile: s.w9_on_file, coiExpiresOn: s.coi_expires_on, lienWaiverStatus: s.lien_waiver_status }, today),
    })));
  }));

  r.patch("/t/:slug/subs/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office")) return;
    const body = z.object({
      w9OnFile: z.boolean().optional(),
      coiExpiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      lienWaiverStatus: z.string().max(40).nullable().optional(),
      trades: z.array(z.string().max(60)).max(20).optional(),
    }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "Check the dates (YYYY-MM-DD) and fields" });
    const owns = await db().query("SELECT 1 FROM contacts WHERE id = $1 AND tenant_id = $2", [req.params.id, t.id]);
    if (!owns.rowCount) return void res.status(404).json({ error: "Not found" });
    await db().query("INSERT INTO sub_profiles (contact_id) VALUES ($1) ON CONFLICT DO NOTHING", [req.params.id]);
    const d = body.data;
    if (d.w9OnFile !== undefined) await db().query("UPDATE sub_profiles SET w9_on_file = $2 WHERE contact_id = $1", [req.params.id, d.w9OnFile]);
    if (d.coiExpiresOn !== undefined) await db().query("UPDATE sub_profiles SET coi_expires_on = $2 WHERE contact_id = $1", [req.params.id, d.coiExpiresOn]);
    if (d.lienWaiverStatus !== undefined) await db().query("UPDATE sub_profiles SET lien_waiver_status = $2 WHERE contact_id = $1", [req.params.id, d.lienWaiverStatus || null]);
    if (d.trades !== undefined) await db().query("UPDATE sub_profiles SET trades = $2 WHERE contact_id = $1", [req.params.id, d.trades]);
    res.json({ ok: true });
  }));

  // ---- permits and inspections ----
  const PermitBody = z.object({
    jobId: z.string().uuid(),
    kind: z.enum(["permit", "inspection"]),
    title: z.string().min(1).max(120),
    status: z.enum(["needed", "applied", "issued", "scheduled", "passed", "failed", "expired", "not_needed"]).optional(),
    reference: z.string().max(60).nullable().optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  });

  r.get("/t/:slug/permits", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const { rows } = await db().query(
      `SELECT p.id, p.job_id, p.kind, p.title, p.status, p.reference, p.due_date::text AS due_date, p.notes, j.name AS job_name
       FROM permits p JOIN jobs j ON j.id = p.job_id WHERE p.tenant_id = $1
       ORDER BY (p.status IN ('passed','not_needed','issued')), p.due_date NULLS LAST, j.name LIMIT 500`, [t.id]);
    const today = new Date().toISOString().slice(0, 10);
    res.json(rows.map((p) => ({ ...p, attention: permitAttention({ kind: p.kind, status: p.status, dueDate: p.due_date }, today)?.why ?? null })));
  }));

  r.post("/t/:slug/permits", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const b = PermitBody.safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "Pick a job, a type and a title. Dates are YYYY-MM-DD." });
    const job = await db().query("SELECT 1 FROM jobs WHERE id = $1 AND tenant_id = $2", [b.data.jobId, t.id]);
    if (!job.rowCount) return void res.status(400).json({ error: "Unknown job" });
    const { rows } = await db().query<{ id: string }>(
      "INSERT INTO permits (tenant_id, job_id, kind, title, status, reference, due_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [t.id, b.data.jobId, b.data.kind, b.data.title, b.data.status ?? "needed", b.data.reference ?? null, b.data.dueDate ?? null, b.data.notes ?? null]);
    await logPermitEvent(t.id, rows[0].id, { status: null, due: null }, { status: b.data.status ?? "needed", due: b.data.dueDate ?? null });
    await runPermitNudges(t.id, t.timezone); // a permit entered already overdue should not wait for the next tick
    res.status(201).json({ id: rows[0].id });
  }));

  r.patch("/t/:slug/permits/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const b = PermitBody.omit({ jobId: true, kind: true }).partial().safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "Check the fields. Dates are YYYY-MM-DD." });
    const d = b.data;
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length + 2}`); };
    if (d.title !== undefined) add("title", d.title);
    if (d.status !== undefined) add("status", d.status);
    if (d.reference !== undefined) add("reference", d.reference);
    if (d.dueDate !== undefined) add("due_date", d.dueDate);
    if (d.notes !== undefined) add("notes", d.notes);
    if (!sets.length) return void res.json({ ok: true });
    const before = (await db().query<{ status: string; due_date: string | null }>("SELECT status, due_date::text FROM permits WHERE id = $1 AND tenant_id = $2", [req.params.id, t.id])).rows[0];
    const out = await db().query(`UPDATE permits SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [req.params.id, t.id, ...vals]);
    if (!out.rowCount) return void res.status(404).json({ ok: false });
    if (before) await logPermitEvent(t.id, String(req.params.id), { status: before.status, due: before.due_date }, { status: d.status ?? before.status, due: d.dueDate !== undefined ? d.dueDate : before.due_date });
    await runPermitNudges(t.id, t.timezone);
    res.json({ ok: true });
  }));

  r.delete("/t/:slug/permits/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const out = await db().query("DELETE FROM permits WHERE id = $1 AND tenant_id = $2", [req.params.id, t.id]);
    res.status(out.rowCount ? 200 : 404).json({ ok: Boolean(out.rowCount) });
  }));

  // ---- change orders ----
  const CoItemBody = z.object({ description: z.string().min(1).max(300), quantity: z.number().nullable().optional(), unit: z.string().max(30).nullable().optional(), unitPrice: z.number().min(0).nullable().optional() });

  r.get("/t/:slug/change-orders", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    res.json(await listChangeOrders(t.id, typeof req.query.status === "string" ? req.query.status : undefined));
  }));

  r.post("/t/:slug/change-orders", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const b = z.object({ jobId: z.string().uuid(), text: z.string().min(5).max(2000) }).safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "Pick a job and describe the extra work in a sentence or two" });
    const a = authOf(res);
    try {
      const co = await draftChangeOrder(opts.draft ?? offlineDrafter(), t, b.data.jobId, b.data.text, { source: "app", userId: a.kind === "user" ? a.userId : null });
      res.status(201).json(co);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  r.get("/t/:slug/change-orders/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const co = await getChangeOrder(t.id, String(req.params.id));
    res.status(co ? 200 : 404).json(co ?? { error: "Not found" });
  }));

  r.patch("/t/:slug/change-orders/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const b = z.object({
      title: z.string().min(1).max(120).optional(),
      description: z.string().min(1).max(3000).optional(),
      items: z.array(CoItemBody).max(40).optional(),
      amount: z.number().min(0).nullable().optional(),
      scheduleDays: z.number().int().min(0).max(365).nullable().optional(),
      questions: z.array(z.string().max(200)).max(20).optional(),
      status: z.enum(["draft", "sent", "approved", "declined", "void"]).optional(),
    }).safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "Check the fields" });
    const cur = await getChangeOrder(t.id, String(req.params.id));
    if (!cur) return void res.status(404).json({ error: "Not found" });
    const d = b.data;
    const edits = d.title !== undefined || d.description !== undefined || d.items !== undefined || d.amount !== undefined || d.scheduleDays !== undefined || d.questions !== undefined;
    if (edits && cur.status !== "draft") return void res.status(400).json({ error: "Only a draft can be edited. Void it and draft a new one." });
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length + 2}`); };
    if (d.title !== undefined) add("title", d.title);
    if (d.description !== undefined) add("description", d.description);
    if (d.items !== undefined) add("items", JSON.stringify(d.items.map((i) => ({ description: i.description, quantity: i.quantity ?? null, unit: i.unit ?? null, unitPrice: i.unitPrice ?? null }))));
    if (d.amount !== undefined) add("amount", d.amount);
    if (d.scheduleDays !== undefined) add("schedule_days", d.scheduleDays);
    if (d.questions !== undefined) add("questions", JSON.stringify(d.questions));
    if (d.status !== undefined && d.status !== cur.status) {
      if (!TRANSITIONS[cur.status as CoStatus].includes(d.status)) return void res.status(400).json({ error: `A ${cur.status} change order can't become ${d.status}` });
      // Merge pending edits before checking, so "set the price and mark sent" works in one save.
      const nextItems = d.items ?? cur.items.map((i) => ({ ...i }));
      const total = d.amount !== undefined ? d.amount : cur.amount;
      const priced = total !== null || (nextItems.length > 0 && nextItems.every((i: any) => (i.unitPrice ?? null) !== null));
      if (d.status === "sent" && !priced) return void res.status(400).json({ error: "Add a price before marking it sent" });
      add("status", d.status);
    }
    if (sets.length) await db().query(`UPDATE change_orders SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [cur.id, t.id, ...vals]);
    res.json(await getChangeOrder(t.id, cur.id));
  }));

  r.delete("/t/:slug/change-orders/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const out = await db().query("DELETE FROM change_orders WHERE id = $1 AND tenant_id = $2 AND status = 'draft'", [req.params.id, t.id]);
    res.status(out.rowCount ? 200 : 400).json(out.rowCount ? { ok: true } : { error: "Only drafts can be deleted. Void it instead." });
  }));

  r.get("/t/:slug/lookups", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const [jobs, subs] = await Promise.all([
      db().query("SELECT id, name FROM jobs WHERE tenant_id = $1 AND status IN ('active','lead','on_hold') ORDER BY name LIMIT 600", [t.id]),
      db().query("SELECT c.id, coalesce(nullif(c.company,''), trim(concat_ws(' ', c.first_name, c.last_name))) AS name FROM contacts c JOIN sub_profiles s ON s.contact_id = c.id WHERE c.tenant_id = $1 ORDER BY 2", [t.id]),
    ]);
    res.json({ jobs: jobs.rows, subs: subs.rows });
  }));

  r.get("/t/:slug/schedule", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const { rows } = await db().query(
      `SELECT a.id, a.start_date::text, a.end_date::text, a.scope, a.confirmation_status, a.confirm_reply, j.name AS job_name,
              coalesce(nullif(c.company,''), trim(concat_ws(' ', c.first_name, c.last_name))) AS sub_name
       FROM job_assignments a JOIN jobs j ON j.id = a.job_id JOIN contacts c ON c.id = a.sub_contact_id
       WHERE a.tenant_id = $1 AND a.start_date >= current_date - 7 ORDER BY a.start_date, j.name LIMIT 300`, [t.id]);
    res.json(rows);
  }));

  r.post("/t/:slug/schedule", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const body = z.object({ jobId: z.string().uuid(), subId: z.string().uuid(), scope: z.string().max(200).optional(), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "Pick a job, a sub and a start date" });
    const ok = await db().query("SELECT (SELECT count(*) FROM jobs WHERE id = $1 AND tenant_id = $3) AS j, (SELECT count(*) FROM contacts WHERE id = $2 AND tenant_id = $3) AS c", [body.data.jobId, body.data.subId, t.id]);
    if (Number(ok.rows[0].j) !== 1 || Number(ok.rows[0].c) !== 1) return void res.status(400).json({ error: "Unknown job or sub" });
    const { rows } = await db().query<{ id: string }>(
      "INSERT INTO job_assignments (tenant_id, job_id, sub_contact_id, scope, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [t.id, body.data.jobId, body.data.subId, body.data.scope ?? null, body.data.startDate, body.data.endDate ?? body.data.startDate]);
    res.status(201).json({ id: rows[0].id });
  }));

  r.patch("/t/:slug/schedule/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const status = z.enum(["pending", "confirmed", "declined", "no_response"]).safeParse(req.body?.confirmationStatus);
    if (!status.success) return void res.status(400).json({ error: "Bad status" });
    const out = await db().query("UPDATE job_assignments SET confirmation_status = $3 WHERE id = $1 AND tenant_id = $2", [req.params.id, t.id, status.data]);
    res.status(out.rowCount ? 200 : 404).json({ ok: Boolean(out.rowCount) });
  }));

  r.delete("/t/:slug/schedule/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office", "pm")) return;
    const out = await db().query("DELETE FROM job_assignments WHERE id = $1 AND tenant_id = $2", [req.params.id, t.id]);
    res.status(out.rowCount ? 200 : 404).json({ ok: Boolean(out.rowCount) });
  }));

  // Run the sub automation now. In live mode with a real phone it still respects the 9 to 5 window.
  r.post("/t/:slug/automation/run", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office")) return;
    let tel;
    try { tel = await telephonyFor(t.id); } catch { return void res.status(400).json({ error: "Connect a phone first" }); }
    res.json(await runAutomation(t, tel, { ignoreWindow: t.settings.mode !== "live" || tel.name === "mock" }));
  }));

  // Demo only: pretend a sub texted in. Refused on any company with a real phone.
  r.post("/t/:slug/simulate-text", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner")) return;
    const body = z.object({ from: z.string(), text: z.string().min(1).max(500) }).safeParse(req.body);
    const from = body.success ? toE164(body.data.from) : null;
    if (!body.success || !from) return void res.status(400).json({ error: "Need a valid from number and text" });
    const kinds = (await db().query<{ provider: string }>("SELECT provider FROM connector_accounts WHERE tenant_id = $1 AND kind = 'telephony'", [t.id])).rows.map((x) => x.provider);
    if (!kinds.includes("mock") || kinds.some((k) => k !== "mock")) return void res.status(400).json({ error: "Texts can only be simulated on the Demo phone" });
    const id = `SIMSMS${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await ingestEvent(t.id, "mock", { kind: "message_received", eventId: id, type: "message.received", message: { providerId: id, conversationId: null, phoneNumberId: "SIMLINE", direction: "incoming", from, to: "+15555550100", body: body.data.text, createdAt: new Date().toISOString() } }, { simulated: true });
    res.json({ ok: true });
  }));

  // ---- client progress updates and the Friday permitting report: drafts a person reviews and sends ----
  const DraftRow = `SELECT d.id, d.address, d.to_emails, d.cc, d.subject, d.body, d.flags, d.status, d.error, d.sent_at, d.created_at,
                           b.kind, b.source, j.name AS job_name
                    FROM update_drafts d JOIN update_batches b ON b.id = d.batch_id LEFT JOIN jobs j ON j.id = d.job_id`;

  r.post("/t/:slug/updates", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office")) return;
    const b = z.object({ text: z.string().min(20).max(60000), subject: z.string().max(300).optional(), force: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "Paste the project manager's email" });
    const a = authOf(res);
    try {
      res.status(201).json(await buildClientUpdates(opts.parseEmail ?? offlineEmailParser(), t, { text: b.data.text, subject: b.data.subject ?? null, source: "paste", userId: a.kind === "user" ? a.userId : null }, { force: b.data.force }));
    } catch (err) {
      res.status(502).json({ error: `Couldn't read that email: ${(err as Error).message}` });
    }
  }));

  r.get("/t/:slug/updates", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office")) return;
    const { rows } = await db().query(`${DraftRow} WHERE d.tenant_id = $1 ORDER BY d.created_at DESC LIMIT 200`, [t.id]);
    res.json(rows);
  }));

  r.patch("/t/:slug/updates/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office")) return;
    const b = z.object({
      toEmails: z.array(z.string()).max(15).optional(),
      cc: z.array(z.string()).max(15).optional(),
      subject: z.string().min(1).max(300).optional(),
      body: z.string().max(20000).optional(),
      status: z.enum(["draft", "skipped"]).optional(),
    }).safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: "Check the fields" });
    const d = b.data;
    for (const list of [d.toEmails, d.cc]) if (list && !validEmails(list)) return void res.status(400).json({ error: "One of the email addresses doesn't look right" });
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length + 2}`); };
    if (d.toEmails !== undefined) add("to_emails", d.toEmails);
    if (d.cc !== undefined) add("cc", d.cc);
    if (d.subject !== undefined) add("subject", d.subject);
    if (d.body !== undefined) add("body", d.body);
    if (d.status !== undefined) add("status", d.status);
    if (!sets.length) return void res.json({ ok: true });
    const out = await db().query(`UPDATE update_drafts SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 AND status IN ('draft','failed','skipped')`, [req.params.id, t.id, ...vals]);
    res.status(out.rowCount ? 200 : 400).json(out.rowCount ? { ok: true } : { error: "That email was already sent or can't be edited" });
  }));

  r.post("/t/:slug/updates/:id/send", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office")) return;
    const a = authOf(res);
    let email;
    try { email = await emailFor(t.id); } catch (err) { return void res.status(400).json({ error: (err as Error).message }); }
    const out = await sendDraft(t, String(req.params.id), a.kind === "user" ? a.userId : null, email);
    res.status(out.ok ? 200 : out.status).json(out.ok ? { ok: true } : { error: out.error });
  }));

  r.delete("/t/:slug/updates/:id", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office")) return;
    const out = await db().query("DELETE FROM update_drafts WHERE id = $1 AND tenant_id = $2 AND status IN ('draft','failed','skipped')", [req.params.id, t.id]);
    res.status(out.rowCount ? 200 : 400).json(out.rowCount ? { ok: true } : { error: "Sent emails can't be deleted" });
  }));

  r.post("/t/:slug/updates/permit-report", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner", "office")) return;
    res.status(201).json(await createPermitReportDraft(t, new Date(), "paste"));
  }));

  r.post("/t/:slug/updates/inbound-token", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t || !allow(res, "owner")) return;
    const token = crypto.randomBytes(24).toString("base64url");
    await db().query(
      "UPDATE tenants SET settings = jsonb_set(settings, '{weeklyUpdates}', coalesce(settings->'weeklyUpdates', '{}'::jsonb) || jsonb_build_object('inboundTokenHash', $2::text)) WHERE id = $1",
      [t.id, crypto.createHash("sha256").update(token).digest("hex")]);
    res.json({ token, url: `${req.protocol}://${req.get("host")}/api/inbound/email/${t.slug}` });
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
