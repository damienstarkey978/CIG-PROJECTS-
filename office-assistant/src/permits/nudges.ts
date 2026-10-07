import { db } from "../lib/db";
import { dayName, localDate } from "../subs/paperwork";

export type PermitKind = "permit" | "inspection";
export type PermitStatus = "needed" | "applied" | "issued" | "scheduled" | "passed" | "failed" | "expired" | "not_needed";

const DAY = 86_400_000;
const SOON_DAYS = 3;

export interface PermitLike { kind: PermitKind; status: PermitStatus; dueDate: string | null }
export type Attention = { state: "overdue" | "soon" | "attention"; days: number; why: string } | null;

/** Is there something a person must do about this permit or inspection today? */
export function permitAttention(p: PermitLike, today: string): Attention {
  if (p.status === "expired") return { state: "attention", days: 0, why: "Permit expired. Renew it before work continues." };
  if (p.status === "failed") return { state: "attention", days: 0, why: "Inspection failed. Fix the issues and schedule a reinspection." };
  const open = p.kind === "permit" ? p.status === "needed" || p.status === "applied" : p.status === "needed" || p.status === "scheduled";
  if (!open || !p.dueDate) return null;
  const days = Math.round((Date.parse(p.dueDate + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / DAY);
  if (days < 0) return { state: "overdue", days: -days, why: `${-days} day${days === -1 ? "" : "s"} overdue` };
  if (days <= SOON_DAYS) return { state: "soon", days, why: days === 0 ? "due today" : days === 1 ? "due tomorrow" : `due ${dayName(p.dueDate)}` };
  return null;
}

/**
 * Opens a task, once, for each permit or inspection that needs attention. The task goes to the
 * job's project manager when there is one. A changed status or date earns a fresh task.
 */
export async function runPermitNudges(tenantId: string, timezone: string, now = new Date()): Promise<number> {
  const today = localDate(timezone, now);
  const { rows } = await db().query(
    `SELECT p.id, p.kind, p.status, p.title, p.due_date::text AS due_date, p.job_id, j.name AS job_name, j.pm_user_id
     FROM permits p JOIN jobs j ON j.id = p.job_id
     WHERE p.tenant_id = $1 AND p.status NOT IN ('passed','not_needed','issued')`,
    [tenantId],
  );
  let created = 0;
  for (const p of rows) {
    const a = permitAttention({ kind: p.kind, status: p.status, dueDate: p.due_date }, today);
    if (!a) continue;
    const ref = `permit:${p.id}:${p.status}:${p.due_date ?? "none"}:${a.state === "overdue" ? "overdue" : a.state}`;
    const dupe = await db().query("SELECT 1 FROM tasks WHERE tenant_id = $1 AND status = 'open' AND external_ids->>'ref' = $2", [tenantId, ref]);
    if (dupe.rowCount) continue;
    const noun = p.kind === "permit" ? "Permit" : "Inspection";
    await db().query(
      "INSERT INTO tasks (tenant_id, type, title, body, job_id, assignee_user_id, external_ids) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [tenantId, p.kind === "permit" ? "permit_due" : "inspection_due", `${noun}: ${p.title} at ${p.job_name} (${a.why})`, a.state === "attention" ? a.why : `${noun} status is ${p.status}. ${p.due_date ? "Date: " + p.due_date + "." : ""}`.trim(), p.job_id, p.pm_user_id, JSON.stringify({ ref })],
    );
    created++;
  }
  return created;
}

/** Records a change so the Friday report can say what moved. Nothing is logged when nothing changed. */
export async function logPermitEvent(tenantId: string, permitId: string, from: { status: string | null; due: string | null }, to: { status: string | null; due: string | null }): Promise<void> {
  if (from.status === to.status && from.due === to.due) return;
  await db().query("INSERT INTO permit_events (tenant_id, permit_id, from_status, to_status, from_due, to_due) VALUES ($1,$2,$3,$4,$5,$6)", [tenantId, permitId, from.status, to.status, from.due, to.due]);
}
