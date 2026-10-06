import type { TelephonyProvider } from "../connectors/types";
import { db } from "../lib/db";
import { sendLogged } from "../lib/outbound";
import { prettyPhone } from "../lib/phone";
import { renderTemplate } from "../pipeline/alerts";
import type { Tenant } from "../tenants";
import { dayName, inSendWindow, localDate, paperworkNeeds } from "./paperwork";

const ESCALATE_CONFIRM_AFTER_HOURS = 20;
const PAPERWORK_REPEAT_DAYS = 7;
const PAPERWORK_MAX_REQUESTS = 3;

export interface AutomationResult {
  skipped?: string;
  confirmRequests: number;
  escalations: number;
  paperworkRequests: number;
}

interface Target { contactId: string; firstName: string | null; company: string | null; phone: string | null }

const subName = (t: { firstName: string | null; company: string | null }) => t.company || t.firstName || "the sub";

/** The line texts go out from: a setting, else the line people last called, else the first Quo line. */
export async function outboundNumberFor(tenant: Tenant): Promise<string | null> {
  const s = (tenant.settings as any).outboundNumber as string | undefined;
  if (s) return s;
  const r = await db().query<{ to_phone: string }>("SELECT to_phone FROM interactions WHERE tenant_id = $1 AND direction = 'incoming' AND to_phone IS NOT NULL ORDER BY created_at DESC LIMIT 1", [tenant.id]);
  if (r.rows[0]) return r.rows[0].to_phone;
  const c = await db().query<{ config: any }>("SELECT config FROM connector_accounts WHERE tenant_id = $1 AND kind = 'telephony' LIMIT 1", [tenant.id]);
  return c.rows[0]?.config?.inboxPhoneNumberIds?.[0] ?? null;
}

async function alreadyDid(tenantId: string, kind: string, refId: string, mode: string, withinHours?: number): Promise<number> {
  const r = await db().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM nudges WHERE tenant_id = $1 AND kind = $2 AND ref_id = $3 AND mode = $4
       AND ($5::int IS NULL OR created_at > now() - ($5 || ' hours')::interval)`,
    [tenantId, kind, refId, mode, withinHours ?? null],
  );
  return r.rows[0].n;
}

const note = (tenantId: string, kind: string, refId: string, mode: string, detail: object) =>
  db().query("INSERT INTO nudges (tenant_id, kind, ref_id, mode, detail) VALUES ($1,$2,$3,$4,$5)", [tenantId, kind, refId, mode, JSON.stringify(detail)]);

const task = (tenantId: string, type: string, title: string, body: string, contactId: string | null, jobId: string | null) =>
  db().query("INSERT INTO tasks (tenant_id, type, title, body, contact_id, job_id) VALUES ($1,$2,$3,$4,$5,$6)", [tenantId, type, title, body, contactId, jobId]);

/**
 * One pass of the sub automation for a company. Shadow mode texts nobody: it records what it
 * would have done and sends one digest to the shadow number. Live mode texts subs, but only with
 * copy the owner has written in Settings; with no copy it opens a task for the office instead.
 */
export async function runAutomation(tenant: Tenant, tel: TelephonyProvider, opts: { now?: Date; ignoreWindow?: boolean } = {}): Promise<AutomationResult> {
  const now = opts.now ?? new Date();
  const result: AutomationResult = { confirmRequests: 0, escalations: 0, paperworkRequests: 0 };
  if (!opts.ignoreWindow && !inSendWindow(tenant.timezone, now)) return { ...result, skipped: "outside the 9 to 5 send window" };
  const live = tenant.settings.mode === "live";
  const mode = live ? "live" : "shadow";
  const from = await outboundNumberFor(tenant);
  const templates = tenant.settings.templates ?? {};
  const digest: string[] = [];
  const today = localDate(tenant.timezone, now);
  const horizon = localDate(tenant.timezone, now, 2);

  const phoneOf = async (contactId: string) => (await db().query<{ phone: string }>("SELECT phone FROM contact_phones WHERE contact_id = $1 LIMIT 1", [contactId])).rows[0]?.phone ?? null;
  const textSub = async (purpose: "sub_confirm" | "sub_paperwork", to: string, body: string) => {
    if (!from) return false;
    return sendLogged(tenant, tel, null, purpose, from, to, body);
  };

  // ---- 1. Ask subs starting soon to confirm ----
  const { rows: upcoming } = await db().query(
    `SELECT a.id, a.start_date::text AS start_date, a.scope, a.job_id, j.name AS job_name, j.address,
            c.id AS contact_id, c.first_name, c.company
     FROM job_assignments a JOIN jobs j ON j.id = a.job_id JOIN contacts c ON c.id = a.sub_contact_id
     WHERE a.tenant_id = $1 AND a.confirmation_status = 'pending' AND a.start_date BETWEEN $2 AND $3 ORDER BY a.start_date`,
    [tenant.id, today, horizon],
  );
  for (const a of upcoming) {
    const t: Target = { contactId: a.contact_id, firstName: a.first_name, company: a.company, phone: await phoneOf(a.contact_id) };
    const asked = await alreadyDid(tenant.id, "confirm_request", a.id, mode);
    if (!asked) {
      const copy = templates.schedule_confirm
        ? renderTemplate(templates.schedule_confirm, { first_name: t.firstName, company: t.company, job: a.job_name, address: a.address, date: dayName(a.start_date), scope: a.scope })
        : null;
      if (!t.phone) {
        if (live) await task(tenant.id, "sub_no_phone", `No phone number for ${subName(t)}`, `Needs to confirm ${a.job_name} on ${a.start_date}.`, t.contactId, a.job_id);
        digest.push(`Can't text ${subName(t)} for ${a.job_name}: no phone number`);
      } else if (!copy) {
        if (live) await task(tenant.id, "sub_confirm_manual", `Confirm ${subName(t)} for ${a.job_name} on ${a.start_date}`, "No approved confirmation text is set in Settings, so nothing was sent.", t.contactId, a.job_id);
        digest.push(`Would ask ${subName(t)} to confirm ${a.job_name} on ${a.start_date} (no approved copy yet)`);
      } else {
        const sent = live ? await textSub("sub_confirm", t.phone, copy) : true;
        if (live && sent) await db().query("UPDATE job_assignments SET confirm_requested_at = now() WHERE id = $1", [a.id]);
        if (!live) digest.push(`Would text ${subName(t)} (${prettyPhone(t.phone)}): "${copy}"`);
        if (!live || sent) result.confirmRequests++;
      }
      await note(tenant.id, "confirm_request", a.id, mode, { to: t.phone });
    }
  }

  // ---- 2. Escalate subs who never answered (live only: in shadow nobody was asked) ----
  if (live) {
    const { rows: waiting } = await db().query(
      `SELECT a.id, a.start_date::text AS start_date, a.job_id, j.name AS job_name, c.id AS contact_id, c.first_name, c.company
       FROM job_assignments a JOIN jobs j ON j.id = a.job_id JOIN contacts c ON c.id = a.sub_contact_id
       WHERE a.tenant_id = $1 AND a.confirmation_status = 'pending' AND a.confirm_requested_at < now() - ($2 || ' hours')::interval AND a.start_date >= $3`,
      [tenant.id, String(ESCALATE_CONFIRM_AFTER_HOURS), today],
    );
    for (const a of waiting) {
      if (await alreadyDid(tenant.id, "confirm_escalated", a.id, "live")) continue;
      await db().query("UPDATE job_assignments SET confirmation_status = 'no_response' WHERE id = $1", [a.id]);
      await task(tenant.id, "sub_unconfirmed", `${subName({ firstName: a.first_name, company: a.company })} hasn't confirmed ${a.job_name}`, `Starts ${a.start_date}. Asked more than ${ESCALATE_CONFIRM_AFTER_HOURS} hours ago with no answer. Call them.`, a.contact_id, a.job_id);
      await note(tenant.id, "confirm_escalated", a.id, "live", {});
      result.escalations++;
    }
  }

  // ---- 3. Chase paperwork from subs who are working or about to be paid ----
  const { rows: subs } = await db().query(
    `SELECT c.id, c.first_name, c.company, s.w9_on_file, s.coi_expires_on::text AS coi_expires_on, s.lien_waiver_status
     FROM contacts c JOIN sub_profiles s ON s.contact_id = c.id
     WHERE c.tenant_id = $1 AND (
       EXISTS (SELECT 1 FROM job_assignments a WHERE a.sub_contact_id = c.id AND a.start_date BETWEEN $2::date - 7 AND $2::date + 14)
       OR EXISTS (SELECT 1 FROM acct_bills b WHERE b.contact_id = c.id))`,
    [tenant.id, today],
  );
  for (const s of subs) {
    const needs = paperworkNeeds({ w9OnFile: s.w9_on_file, coiExpiresOn: s.coi_expires_on, lienWaiverStatus: s.lien_waiver_status }, new Date(today + "T12:00:00Z"));
    if (!needs.length) continue;
    const t: Target = { contactId: s.id, firstName: s.first_name, company: s.company, phone: await phoneOf(s.id) };
    if (await alreadyDid(tenant.id, "paperwork_request", s.id, mode, PAPERWORK_REPEAT_DAYS * 24)) continue;
    const tries = await alreadyDid(tenant.id, "paperwork_request", s.id, mode);
    if (tries >= PAPERWORK_MAX_REQUESTS) {
      if (live && !(await alreadyDid(tenant.id, "paperwork_escalated", s.id, "live"))) {
        await task(tenant.id, "sub_paperwork_stuck", `${subName(t)} still hasn't sent: ${needs.join(", ")}`, `Asked ${tries} times by text. Call them.`, t.contactId, null);
        await note(tenant.id, "paperwork_escalated", s.id, "live", { needs });
        result.escalations++;
      }
      continue;
    }
    const copy = templates.paperwork_request
      ? renderTemplate(templates.paperwork_request, { first_name: t.firstName, company: t.company, missing: needs.join(" and ") })
      : null;
    if (!t.phone) {
      digest.push(`Can't ask ${subName(t)} for ${needs.join(", ")}: no phone number`);
    } else if (!copy) {
      digest.push(`Would ask ${subName(t)} for ${needs.join(", ")} (no approved copy yet)`);
    } else if (live) {
      if (await textSub("sub_paperwork", t.phone, copy)) result.paperworkRequests++;
    } else {
      digest.push(`Would text ${subName(t)} (${prettyPhone(t.phone)}): "${copy}"`);
      result.paperworkRequests++;
    }
    await note(tenant.id, "paperwork_request", s.id, mode, { needs });
  }

  // ---- shadow digest: one text, only if something would have happened ----
  const shadowTo = tenant.settings.shadowRecipientPhone;
  if (!live && digest.length && shadowTo && from) {
    await sendLogged(tenant, tel, null, "shadow_report", from, shadowTo, `[SHADOW] Sub automation would have:\n${digest.slice(0, 12).join("\n")}${digest.length > 12 ? `\n...and ${digest.length - 12} more` : ""}`);
  }
  return result;
}
