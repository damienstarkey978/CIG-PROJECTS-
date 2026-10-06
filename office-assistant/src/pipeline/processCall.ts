import { CLASSIFIER_VERSION, type Classification, type Classifier } from "../ai/classify";
import { config } from "../config";
import type { AnsweredBy, NormalizedCall, TelephonyProvider, TranscriptLine } from "../connectors/types";
import { db, withTx } from "../lib/db";
import { log } from "../lib/log";
import { enqueue, RetryLater } from "../lib/queue";
import { getTenantById, type Tenant } from "../tenants";
import { officeAlert, renderTemplate, shadowReport } from "./alerts";
import { PROCESS_CALL, upsertCall } from "./ingest";
import { decideRoute, type ContactType, type RouteDecision } from "./route";

export interface Deps {
  telephony: (tenantId: string) => Promise<TelephonyProvider>;
  classify: Classifier;
  now?: () => Date;
}

interface InteractionRow {
  id: string;
  tenant_id: string;
  direction: "incoming" | "outgoing";
  handled_by: AnsweredBy | null;
  provider_id: string;
  from_phone: string | null;
  to_phone: string | null;
  created_at: Date;
  transcript: TranscriptLine[] | null;
  summary: string[] | null;
  voicemail: NormalizedCall["voicemail"];
  processed_at: Date | null;
}

interface KnownContact {
  id: string;
  type: ContactType;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
}

async function findContactByPhone(tenantId: string, phone: string | null): Promise<KnownContact | null> {
  if (!phone) return null;
  const { rows } = await db().query<KnownContact>(
    `SELECT c.id, c.type, c.first_name, c.last_name, c.company FROM contact_phones p
     JOIN contacts c ON c.id = p.contact_id WHERE p.tenant_id = $1 AND p.phone = $2`,
    [tenantId, phone],
  );
  return rows[0] ?? null;
}

const MISSED_NO_MESSAGE: Classification = {
  caller_type: "unknown",
  confidence: 0,
  reasoning: "Missed call with no voicemail or transcript.",
  caller_name: null,
  company: null,
  job_type: null,
  job_address: null,
  timeline: null,
  budget_hint: null,
  job_reference: null,
  urgency: "normal",
  callback_requested: false,
  office_summary: "Missed call, no voicemail left.",
};

/** Fills in transcript/summary from the API when webhooks have not delivered them yet. */
async function backfill(row: InteractionRow, tel: TelephonyProvider): Promise<InteractionRow> {
  if (row.handled_by === "missed" || row.transcript?.length) return row;
  const [transcript, summary] = await Promise.all([tel.getTranscript(row.provider_id), tel.getSummary(row.provider_id)]);
  if (transcript?.length || summary?.summary.length) {
    await db().query("UPDATE interactions SET transcript = COALESCE($2, transcript), summary = COALESCE($3, summary) WHERE id = $1", [
      row.id,
      transcript?.length ? JSON.stringify(transcript) : null,
      summary?.summary.length ? summary.summary : null,
    ]);
    return { ...row, transcript: transcript?.length ? transcript : row.transcript, summary: summary?.summary ?? row.summary };
  }
  return row;
}

export async function processCall(deps: Deps, interactionId: string): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const { rows } = await db().query<InteractionRow>("SELECT * FROM interactions WHERE id = $1", [interactionId]);
  let row = rows[0];
  if (!row || row.processed_at || row.direction !== "incoming") return;

  const tenant = await getTenantById(row.tenant_id);
  const tel = await deps.telephony(tenant.id);
  const answeredBy: AnsweredBy = row.handled_by ?? "missed";

  row = await backfill(row, tel);
  const hasContent = Boolean(row.transcript?.length || row.voicemail?.transcript || row.summary?.length);
  if (!hasContent) {
    const waiting = answeredBy !== "missed" || row.voicemail;
    const age = now.getTime() - new Date(row.created_at).getTime();
    if (waiting && age < config.transcriptWaitMs) throw new RetryLater(60_000, "transcript not ready");
  }

  const known = await findContactByPhone(tenant.id, row.from_phone);
  const knownName = known ? [known.first_name, known.last_name].filter(Boolean).join(" ") || null : null;

  const classification = hasContent
    ? await deps.classify({
        companyName: tenant.name,
        callerPhone: row.from_phone,
        knownContact: known ? { type: known.type, name: knownName, company: known.company } : null,
        answeredBy,
        transcript: row.transcript,
        summary: row.summary,
        voicemailTranscript: row.voicemail?.transcript ?? null,
      })
    : { ...MISSED_NO_MESSAGE, caller_name: knownName, company: known?.company ?? null };

  const decision = decideRoute({
    classification,
    knownContactType: known?.type ?? null,
    confidenceThreshold: tenant.settings.confidenceThreshold ?? 0.7,
  });

  const claimed = await persist(tenant, row, known, classification, decision);
  if (!claimed) return; // another worker got here first
  await notify(tenant, tel, row, answeredBy, classification, decision);
}

/** Writes records and marks the call processed. Returns false if already processed. */
async function persist(
  tenant: Tenant,
  row: InteractionRow,
  known: KnownContact | null,
  c: Classification,
  d: RouteDecision,
): Promise<boolean> {
  return withTx(async (tx) => {
    const lock = await tx.query("SELECT 1 FROM interactions WHERE id = $1 AND processed_at IS NULL FOR UPDATE", [row.id]);
    if (lock.rowCount === 0) return false;

    let contactId = known?.id ?? null;
    if (!contactId && d.newContactType && row.from_phone) {
      const [first, ...rest] = (c.caller_name ?? "").trim().split(/\s+/).filter(Boolean);
      const ins = await tx.query<{ id: string }>(
        "INSERT INTO contacts (tenant_id, type, first_name, last_name, company) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [tenant.id, d.newContactType, first ?? null, rest.join(" ") || null, c.company],
      );
      contactId = ins.rows[0].id;
      await tx.query("INSERT INTO contact_phones (tenant_id, phone, contact_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [
        tenant.id,
        row.from_phone,
        contactId,
      ]);
    }

    await tx.query(
      `UPDATE interactions SET contact_id = $2, caller_type = $3, confidence = $4, extracted = $5,
         classifier_version = $6, processed_at = now() WHERE id = $1`,
      [row.id, contactId, d.callerType, c.confidence, JSON.stringify(c), CLASSIFIER_VERSION],
    );

    if (d.createLead && contactId) {
      await tx.query(
        `INSERT INTO leads (tenant_id, contact_id, interaction_id, source, job_type, address, timeline, budget_hint, status)
         VALUES ($1,$2,$3,'call',$4,$5,$6,$7,'callback')`,
        [tenant.id, contactId, row.id, c.job_type, c.job_address, c.timeline, c.budget_hint],
      );
    }
    if (d.task) {
      await tx.query(
        "INSERT INTO tasks (tenant_id, type, title, body, contact_id, interaction_id) VALUES ($1,$2,$3,$4,$5,$6)",
        [tenant.id, d.task.type, d.task.title, c.office_summary, contactId, row.id],
      );
    }
    return true;
  });
}

async function send(
  tenant: Tenant,
  tel: TelephonyProvider,
  interactionId: string,
  purpose: "follow_up" | "office_alert" | "shadow_report",
  from: string,
  to: string,
  body: string,
) {
  let providerId: string | null = null;
  let error: string | null = null;
  try {
    providerId = (await tel.sendSms(from, to, body)).id;
  } catch (err) {
    error = String(err);
    log.error("sms send failed", { tenant: tenant.slug, purpose, error });
  }
  await db().query(
    `INSERT INTO outbound_messages (tenant_id, interaction_id, purpose, to_phone, body, mode, provider_message_id, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenant.id, interactionId, purpose, to, body, tenant.settings.mode, providerId, error],
  );
}

/** Texts go out after the transaction commits, once, with no retry: a duplicate text is worse than a logged failure. */
async function notify(
  tenant: Tenant,
  tel: TelephonyProvider,
  row: InteractionRow,
  answeredBy: AnsweredBy,
  c: Classification,
  d: RouteDecision,
) {
  const from = row.to_phone; // reply from the line they called
  if (!from) return;
  const template = d.followUpTemplate ? tenant.settings.templates?.[d.followUpTemplate] : undefined;
  const followUp = template
    ? renderTemplate(template, { company: tenant.name, first_name: c.caller_name?.split(" ")[0] ?? null })
    : null;

  if (tenant.settings.mode !== "live") {
    const to = tenant.settings.shadowRecipientPhone;
    if (to) await send(tenant, tel, row.id, "shadow_report", from, to, shadowReport(d, c, row.from_phone, answeredBy, followUp));
    return;
  }

  if (followUp && row.from_phone) await send(tenant, tel, row.id, "follow_up", from, row.from_phone, followUp);
  if (d.alertOffice) {
    const { rows: staff } = await db().query<{ phone: string }>(
      "SELECT phone FROM users WHERE tenant_id = $1 AND alerts_enabled AND phone IS NOT NULL",
      [tenant.id],
    );
    const alert = officeAlert(d, c, row.from_phone, answeredBy);
    for (const s of staff) await send(tenant, tel, row.id, "office_alert", from, s.phone, alert);
  }
}

/** Handles transcript/summary events that arrived before (or without) call.completed. */
export async function fetchCall(deps: Deps, tenantId: string, callId: string): Promise<void> {
  const tel = await deps.telephony(tenantId);
  const call = await tel.getCall(callId);
  if (!call) throw new Error(`Call ${callId} not found at provider`);
  const id = await withTx((tx) => upsertCall(tx, tenantId, tel.name, call));
  if (call.direction === "incoming") await enqueue(PROCESS_CALL, { interactionId: id }, { dedupeKey: `call:${id}` });
}

export function handlers(deps: Deps) {
  return {
    [PROCESS_CALL]: (p: { interactionId: string }) => processCall(deps, p.interactionId),
    fetch_call: (p: { tenantId: string; callId: string }) => fetchCall(deps, p.tenantId, p.callId),
  };
}
