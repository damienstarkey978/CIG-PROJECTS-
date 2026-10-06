import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import { PRODUCT_NAME } from "./brand";
import { adminToken } from "./config";
import { findManifest, publicCatalog, splitFields } from "./connectors/registry";
import { decryptJson } from "./lib/crypto";
import { db } from "./lib/db";
import { toE164 } from "./lib/phone";
import { findScenario, SCENARIOS } from "./sim/scenarios";
import { simulateCall } from "./sim/simulate";
import { importContacts, type ImportContactType } from "./import/contacts";
import { importJobs } from "./import/jobs";
import { getTenantBySlug, saveConnector, type Tenant } from "./tenants";

export const TEMPLATE_KEYS = ["lead_callback", "ack_sub_vendor", "ack_client", "generic"] as const;

const SettingsBody = z.object({
  mode: z.enum(["shadow", "live"]),
  confidenceThreshold: z.number().min(0.3).max(0.99),
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

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expected = adminToken();
  if (!expected) return void res.status(503).json({ error: "ADMIN_TOKEN is not set on the server" });
  const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  if (!given || !safeEqual(given, expected)) return void res.status(401).json({ error: "Wrong or missing token" });
  next();
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

async function tenantOf(req: Request, res: Response): Promise<Tenant | null> {
  const t = await getTenantBySlug(String(req.params.slug));
  if (!t) res.status(404).json({ error: "Unknown company" });
  return t;
}

export function apiRouter(): Router {
  const r = Router();
  r.use(express.json({ limit: "3mb" })); // CSV imports arrive as text in the body
  r.use(requireAdmin);

  r.get("/meta", (_req, res) => {
    res.json({ product: PRODUCT_NAME, connectors: publicCatalog(), scenarios: SCENARIOS.map((s) => ({ id: s.id, label: s.label })), templateKeys: TEMPLATE_KEYS });
  });

  r.get("/tenants", wrap(async (_req, res) => {
    const { rows } = await db().query("SELECT slug, name, timezone, settings->>'mode' AS mode FROM tenants ORDER BY name");
    res.json(rows);
  }));

  r.post("/tenants", wrap(async (req, res) => {
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
    if (!t) return;
    const body = SettingsBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: body.error.issues[0].message });
    const phone = body.data.shadowRecipientPhone ? toE164(body.data.shadowRecipientPhone) : undefined;
    if (body.data.shadowRecipientPhone && !phone) return void res.status(400).json({ error: "Shadow phone is not a valid number" });
    const next = {
      mode: body.data.mode,
      confidenceThreshold: body.data.confidenceThreshold,
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
    if (!t) return;
    const m = findManifest(String(req.params.kind), String(req.params.provider));
    if (!m) return void res.status(404).json({ error: "Unknown connector" });
    if (m.status !== "ready") return void res.status(400).json({ error: `${m.label} is not available yet` });
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

  const ImportBody = z.object({
    csv: z.string().min(1),
    defaultType: z.enum(["client", "sub", "vendor", "prospect", "other"]).default("other"),
    dryRun: z.boolean().default(true),
  });

  r.post("/t/:slug/import/:kind", wrap(async (req, res) => {
    const t = await tenantOf(req, res);
    if (!t) return;
    const body = ImportBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "Send the file text as csv" });
    try {
      const result =
        req.params.kind === "contacts"
          ? await importContacts(t.id, body.data.csv, { defaultType: body.data.defaultType as ImportContactType, dryRun: body.data.dryRun })
          : req.params.kind === "jobs"
            ? await importJobs(t.id, body.data.csv, { dryRun: body.data.dryRun })
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
    if (!t) return;
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
