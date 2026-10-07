import { db } from "../lib/db";
import { permitAttention, type PermitKind, type PermitStatus } from "../permits/nudges";
import { localDate, localParts } from "../subs/paperwork";
import type { Tenant } from "../tenants";

export interface PermitRow { id: string; jobName: string; kind: PermitKind; title: string; status: PermitStatus; dueDate: string | null; reference: string | null }
export interface PermitEventRow { permitId: string; fromStatus: string | null; toStatus: string | null; fromDue: string | null; toDue: string | null; createdAt: Date }

const SAY: Record<string, string> = { needed: "needed", applied: "applied for", issued: "issued", scheduled: "scheduled", passed: "passed", failed: "failed", expired: "expired", not_needed: "not needed" };
const DAY = 86_400_000;

const fmtDate = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const longDate = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const label = (p: Pick<PermitRow, "title" | "kind" | "reference">) => `${p.title}${p.kind === "inspection" ? " inspection" : ""}${p.reference ? ` (#${p.reference})` : ""}`;

function grouped(lines: { job: string; text: string }[]): string {
  const by = new Map<string, string[]>();
  for (const l of lines) by.set(l.job, [...(by.get(l.job) ?? []), l.text]);
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([job, items]) => `${job}\n${items.map((i) => `• ${i}`).join("\n")}`).join("\n\n");
}

/** Deterministic: every line comes from the permit records and their change history, nothing is written freehand. */
export function buildPermitReport(o: { business: string; fridayDate: string; today: string; permits: PermitRow[]; events: PermitEventRow[]; signature?: string }): { subject: string; body: string; empty: boolean } {
  const byId = new Map(o.permits.map((p) => [p.id, p]));
  const attention: { job: string; text: string }[] = [];
  const inAttention = new Set<string>();
  for (const p of o.permits) {
    const a = permitAttention({ kind: p.kind, status: p.status, dueDate: p.dueDate }, o.today);
    if (!a) continue;
    inAttention.add(p.id);
    attention.push({ job: p.jobName, text: `${label(p)}: ${a.state === "attention" ? a.why : `${SAY[p.status]}, ${a.why}`}` });
  }

  const weekAgo = new Date(o.today + "T00:00:00Z").getTime() - 7 * DAY;
  const changed: { job: string; text: string }[] = [];
  for (const e of o.events.filter((x) => x.createdAt.getTime() >= weekAgo).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const p = byId.get(e.permitId);
    if (!p) continue;
    if (e.fromStatus === null) changed.push({ job: p.jobName, text: `${label(p)}: added, ${SAY[e.toStatus ?? p.status]}${p.dueDate ? `, ${fmtDate(p.dueDate)}` : ""}` });
    else if (e.fromStatus !== e.toStatus) changed.push({ job: p.jobName, text: `${label(p)}: ${SAY[e.fromStatus]} to ${SAY[e.toStatus ?? ""] ?? e.toStatus}` });
    else if (e.fromDue !== e.toDue && e.toDue) changed.push({ job: p.jobName, text: `${label(p)}: date moved${e.fromDue ? ` from ${fmtDate(e.fromDue)}` : ""} to ${fmtDate(e.toDue)}` });
  }

  const open = (p: PermitRow) => (p.kind === "permit" ? p.status === "needed" || p.status === "applied" : p.status === "needed" || p.status === "scheduled");
  const soon: { job: string; text: string }[] = [];
  const rest: { job: string; text: string }[] = [];
  for (const p of o.permits) {
    if (!open(p) || inAttention.has(p.id)) continue;
    const days = p.dueDate ? Math.round((Date.parse(p.dueDate + "T00:00:00Z") - Date.parse(o.today + "T00:00:00Z")) / DAY) : null;
    if (days !== null && days >= 0 && days <= 14) soon.push({ job: p.jobName, text: `${label(p)}: ${SAY[p.status]}, ${fmtDate(p.dueDate!)}` });
    else rest.push({ job: p.jobName, text: `${label(p)}: ${SAY[p.status]}${p.dueDate ? `, ${fmtDate(p.dueDate)}` : ""}` });
  }

  const sections = [
    attention.length ? `NEEDS ATTENTION\n\n${grouped(attention)}` : "",
    changed.length ? `WHAT CHANGED THIS WEEK\n\n${grouped(changed)}` : "",
    soon.length ? `COMING UP IN THE NEXT 14 DAYS\n\n${grouped(soon)}` : "",
    rest.length ? `STILL IN PROGRESS\n\n${grouped(rest)}` : "",
  ].filter(Boolean);
  const empty = sections.length === 0;
  const body = [
    "Hello,",
    `Here is this week's plans and permitting progress report for ${o.business}. Week ending Friday, ${longDate(o.fridayDate)}.`,
    ...(empty ? ["No permit or inspection activity this week."] : sections),
    ...(o.signature?.trim() ? [o.signature.trim()] : []),
  ].join("\n\n");
  return { subject: `Plans and Permitting Progress Report - ${longDate(o.fridayDate)}`, body, empty };
}

/** The Friday on or after a date, in the company's time zone. */
export function fridayOnOrAfter(timezone: string, now: Date): string {
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * DAY);
    if (localParts(timezone, d).weekday === "Fri") return localDate(timezone, now, i);
  }
  return localDate(timezone, now);
}

export interface PermitReportResult { draftId: string | null; alreadyExists: boolean; weekOf: string }

/** Drafts this week's report once. A person reviews and sends it; nothing goes out by itself. */
export async function createPermitReportDraft(tenant: Tenant, now = new Date(), source: "schedule" | "paste" = "schedule"): Promise<PermitReportResult> {
  const today = localDate(tenant.timezone, now);
  const friday = fridayOnOrAfter(tenant.timezone, now);
  const existing = await db().query<{ id: string }>("SELECT d.id FROM update_batches b JOIN update_drafts d ON d.batch_id = b.id WHERE b.tenant_id = $1 AND b.kind = 'permits' AND b.week_of = $2 LIMIT 1", [tenant.id, friday]);
  if (existing.rows[0]) return { draftId: existing.rows[0].id, alreadyExists: true, weekOf: friday };

  const permits = (await db().query<PermitRow & { job_name: string; due_date: string | null }>(
    `SELECT p.id, j.name AS "jobName", p.kind, p.title, p.status, p.due_date::text AS "dueDate", p.reference
     FROM permits p JOIN jobs j ON j.id = p.job_id WHERE p.tenant_id = $1 AND p.status <> 'not_needed'`, [tenant.id])).rows as unknown as PermitRow[];
  const events = (await db().query(
    `SELECT permit_id AS "permitId", from_status AS "fromStatus", to_status AS "toStatus", from_due::text AS "fromDue", to_due::text AS "toDue", created_at AS "createdAt"
     FROM permit_events WHERE tenant_id = $1 AND created_at > now() - interval '8 days'`, [tenant.id])).rows as PermitEventRow[];
  const cfg = tenant.settings.permitReport ?? {};
  const report = buildPermitReport({ business: tenant.name, fridayDate: friday, today, permits, events, signature: cfg.signature ?? tenant.settings.weeklyUpdates?.signature });
  const to = (cfg.to ?? []).filter(Boolean);
  const flags = to.length ? [] : ["No recipients set. Add who this goes to before sending."];

  const batch = (await db().query<{ id: string }>(
    "INSERT INTO update_batches (tenant_id, kind, source, subject, raw_text, week_of) VALUES ($1,'permits',$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
    [tenant.id, source === "schedule" ? "schedule" : "paste", report.subject, report.body, friday])).rows[0];
  if (!batch) return { draftId: null, alreadyExists: true, weekOf: friday }; // another run won the race
  const draft = (await db().query<{ id: string }>(
    "INSERT INTO update_drafts (tenant_id, batch_id, address, to_emails, cc, subject, body, flags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    [tenant.id, batch.id, "Plans and Permitting", to, tenant.settings.weeklyUpdates?.cc ?? [], report.subject, report.body, flags])).rows[0];
  await db().query("INSERT INTO tasks (tenant_id, type, title, body, external_ids) VALUES ($1,'permit_report_review',$2,$3,$4)",
    [tenant.id, "Review and send the Friday permitting report", "A draft is ready on the Updates tab. Check the statuses, then send it.", JSON.stringify({ ref: `permit_report:${friday}` })]);
  return { draftId: draft.id, alreadyExists: false, weekOf: friday };
}

/**
 * Twice a week, a reminder to check the permitting software and bring Heather up to date. On
 * Friday morning, the report draft. Only for companies that turned it on in Settings.
 */
export async function runPermitReportTick(tenant: Tenant, now = new Date()): Promise<{ checkTask: boolean; report: boolean }> {
  const out = { checkTask: false, report: false };
  if (!tenant.settings.permitReport?.enabled) return out;
  const { weekday, hour } = localParts(tenant.timezone, now);
  const today = localDate(tenant.timezone, now);
  if ((weekday === "Tue" || weekday === "Thu") && hour >= 8) {
    const ref = `permit_check:${today}`;
    const dupe = await db().query("SELECT 1 FROM tasks WHERE tenant_id = $1 AND external_ids->>'ref' = $2", [tenant.id, ref]);
    if (!dupe.rowCount) {
      await db().query("INSERT INTO tasks (tenant_id, type, title, body, external_ids) VALUES ($1,'permit_check',$2,$3,$4)",
        [tenant.id, "Check permit and inspection statuses", "Look at the permitting software and update any status or date changes on the Permits tab. Friday's report is built from them.", JSON.stringify({ ref })]);
      out.checkTask = true;
    }
  }
  if (weekday === "Fri" && hour >= 7) out.report = !(await createPermitReportDraft(tenant, now)).alreadyExists;
  return out;
}
