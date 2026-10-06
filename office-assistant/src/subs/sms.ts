import { offlineDrafter } from "../changeorders/draft";
import { draftChangeOrder } from "../changeorders/store";
import { db } from "../lib/db";
import { sendLogged } from "../lib/outbound";
import type { Deps } from "../pipeline/processCall";
import { getTenantById } from "../tenants";
import { outboundNumberFor } from "./automation";
import { prettyPhone } from "../lib/phone";
import { suggestJob } from "../books/analyze";
import { localDate, looksLikeMaterialRequest, paperworkNeeds, parseConfirmReply } from "./paperwork";

/** Reads one inbound text, files it, and opens the right task. Texts are never answered automatically. */
export async function processSms(interactionId: string, deps?: Pick<Deps, "telephony" | "draft">): Promise<void> {
  const { rows } = await db().query(
    "SELECT id, tenant_id, from_phone, body, media FROM interactions WHERE id = $1 AND channel = 'sms' AND direction = 'incoming' AND processed_at IS NULL",
    [interactionId],
  );
  const m = rows[0];
  if (!m) return;
  const body: string = m.body ?? "";
  const hasMedia = Array.isArray(m.media) && m.media.length > 0;
  const { rows: tz } = await db().query<{ timezone: string }>("SELECT timezone FROM tenants WHERE id = $1", [m.tenant_id]);
  const today = localDate(tz[0].timezone, new Date());
  const contact = m.from_phone
    ? (await db().query<{ id: string; type: string; first_name: string | null; last_name: string | null; company: string | null }>(
        "SELECT c.id, c.type, c.first_name, c.last_name, c.company FROM contact_phones p JOIN contacts c ON c.id = p.contact_id WHERE p.tenant_id = $1 AND p.phone = $2",
        [m.tenant_id, m.from_phone],
      )).rows[0]
    : undefined;
  const who = contact ? ([contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.company || prettyPhone(m.from_phone)) : prettyPhone(m.from_phone);
  const task = (type: string, title: string, jobId: string | null = null) =>
    db().query("INSERT INTO tasks (tenant_id, type, title, body, contact_id, job_id, interaction_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [m.tenant_id, type, title, body || (hasMedia ? "(photo or file attached)" : ""), contact?.id ?? null, jobId, m.id]);

  let jobId: string | null = null;

  // Staff can text "change order, <what changed>" to start a draft. A person reviews it in the app.
  const staff = m.from_phone
    ? (await db().query<{ id: string; name: string; phone: string }>("SELECT id, name, phone FROM users WHERE tenant_id = $1 AND phone = $2", [m.tenant_id, m.from_phone])).rows[0]
    : undefined;
  const co = staff ? /^\s*(?:co|change order)\b[\s:,.\-]*(.*)$/is.exec(body) : null;
  if (staff && co) {
    const text = co[1].trim();
    const jobs = (await db().query<{ id: string; name: string; address: string | null }>("SELECT id, name, address FROM jobs WHERE tenant_id = $1 AND status IN ('active','lead','on_hold')", [m.tenant_id])).rows;
    const job = text ? suggestJob([text], jobs) : null;
    if (!job) {
      await db().query("INSERT INTO tasks (tenant_id, type, title, body, assignee_user_id, interaction_id) VALUES ($1,'change_order_unplaced',$2,$3,$4,$5)",
        [m.tenant_id, `Change order text from ${staff.name}: which job?`, body, staff.id, m.id]);
    } else {
      const tenant = await getTenantById(m.tenant_id);
      const draft = await draftChangeOrder(deps?.draft ?? offlineDrafter(), tenant, job.jobId, text, { source: "text", userId: staff.id });
      await db().query("INSERT INTO tasks (tenant_id, type, title, body, job_id, assignee_user_id, interaction_id) VALUES ($1,'change_order_review',$2,$3,$4,$5,$6)",
        [m.tenant_id, `Review change order ${draft.label} for ${draft.jobName}`, draft.questions.length ? `Still needed: ${draft.questions.join(" ")}` : "Check the wording and price, then send it.", draft.jobId, staff.id, m.id]);
      if (tenant.settings.mode === "live" && deps?.telephony) {
        const from = await outboundNumberFor(tenant);
        if (from) await sendLogged(tenant, await deps.telephony(tenant.id), m.id, "office_alert", from, staff.phone, `Draft ${draft.label} for ${draft.jobName} is saved. Review it in the app before it goes to the client.`);
      }
      jobId = draft.jobId;
    }
    await db().query("UPDATE interactions SET job_id = $2, processed_at = now() WHERE id = $1", [m.id, jobId]);
    return;
  }

  if (!contact && staff) {
    await task("staff_text", `Text from ${staff.name}`);
  } else if (!contact) {
    await task("sms_unknown", `Text from unknown number ${who}`);
  } else if (contact.type === "sub" || contact.type === "vendor") {
    // Is this the answer to a "can you be there?" text?
    const waiting = (await db().query<{ id: string; job_id: string; start_date: string; job_name: string }>(
      `SELECT a.id, a.job_id, a.start_date::text, j.name AS job_name FROM job_assignments a JOIN jobs j ON j.id = a.job_id
       WHERE a.tenant_id = $1 AND a.sub_contact_id = $2 AND a.confirmation_status IN ('pending','no_response') AND a.confirm_requested_at > now() - interval '3 days' AND a.start_date >= $3::date - 1
       ORDER BY a.start_date`,
      [m.tenant_id, contact.id, today],
    )).rows;
    const reply = waiting.length ? parseConfirmReply(body) : "unclear";
    const profile = (await db().query<{ w9_on_file: boolean; coi_expires_on: string | null; lien_waiver_status: string | null }>(
      "SELECT w9_on_file, coi_expires_on::text, lien_waiver_status FROM sub_profiles WHERE contact_id = $1", [contact.id])).rows[0];
    const needs = profile ? paperworkNeeds({ w9OnFile: profile.w9_on_file, coiExpiresOn: profile.coi_expires_on, lienWaiverStatus: profile.lien_waiver_status }, new Date(today + "T12:00:00Z")) : [];
    const sameDay = waiting.filter((w) => w.start_date === waiting[0]?.start_date);
    if (reply !== "unclear" && sameDay.length === 1) {
      const a = sameDay[0];
      await db().query("UPDATE job_assignments SET confirmation_status = $2, confirm_reply = $3 WHERE id = $1", [a.id, reply, body]);
      if (reply === "declined") await task("sub_declined", `${who} can't make ${a.job_name} on ${a.start_date}`, a.job_id);
    } else if (reply !== "unclear") {
      await task("sub_reply_ambiguous", `${who} replied "${body.slice(0, 40)}" but has ${sameDay.length} jobs that day`, null);
    } else if (hasMedia && needs.length) {
      // A photo from a sub we are chasing is probably the paperwork. A person checks it and marks it on file.
      await task("paperwork_received", `${who} sent a file (we need: ${needs.join(", ")})`);
    } else if (looksLikeMaterialRequest(body)) {
      const mine = (await db().query<{ id: string; name: string; address: string | null }>(
        `SELECT DISTINCT j.id, j.name, j.address FROM job_assignments a JOIN jobs j ON j.id = a.job_id
         WHERE a.tenant_id = $1 AND a.sub_contact_id = $2 AND a.start_date >= $3::date - 30`, [m.tenant_id, contact.id, today],
      )).rows;
      const all = (await db().query<{ id: string; name: string; address: string | null }>("SELECT id, name, address FROM jobs WHERE tenant_id = $1 AND status IN ('active','lead')", [m.tenant_id])).rows;
      jobId = suggestJob([body], mine)?.jobId ?? suggestJob([body], all)?.jobId ?? (mine.length === 1 ? mine[0].id : null);
      await task("material_request", `${who} needs materials or help`, jobId);
    } else {
      await task("sub_text", `Text from ${who}`);
    }
  } else {
    await task("client_text", `Text from ${who}`);
  }
  await db().query("UPDATE interactions SET contact_id = $2, job_id = $3, processed_at = now() WHERE id = $1", [m.id, contact?.id ?? null, jobId]);
}
