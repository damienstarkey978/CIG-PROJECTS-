import { db, withTx } from "../lib/db";
import { changeOrderTotal, toItems, type CoItem, type Drafter } from "./draft";

export type CoStatus = "draft" | "sent" | "approved" | "declined" | "void";

// A person decides when a change order has gone out or been answered. Heather only records it.
export const TRANSITIONS: Record<CoStatus, CoStatus[]> = {
  draft: ["sent", "void"],
  sent: ["approved", "declined", "void"],
  approved: [],
  declined: ["void"],
  void: [],
};

export interface ChangeOrder {
  id: string;
  jobId: string;
  jobName: string;
  jobAddress: string | null;
  number: number;
  label: string;
  title: string;
  description: string;
  items: CoItem[];
  amount: number | null;
  total: number | null;
  scheduleDays: number | null;
  questions: string[];
  status: CoStatus;
  source: "app" | "text";
  createdAt: string;
}

const SELECT = `SELECT c.id, c.job_id, j.name AS job_name, j.address AS job_address, c.number, c.title, c.description, c.items,
                       c.amount::float8 AS amount, c.schedule_days, c.questions, c.status, c.source, c.created_at
                FROM change_orders c JOIN jobs j ON j.id = c.job_id`;

export function shape(r: any): ChangeOrder {
  const items: CoItem[] = r.items ?? [];
  return {
    id: r.id, jobId: r.job_id, jobName: r.job_name, jobAddress: r.job_address, number: r.number, label: `CO-${r.number}`,
    title: r.title, description: r.description, items, amount: r.amount, total: changeOrderTotal(items, r.amount),
    scheduleDays: r.schedule_days, questions: r.questions ?? [], status: r.status, source: r.source, createdAt: r.created_at,
  };
}

export async function listChangeOrders(tenantId: string, status?: string): Promise<ChangeOrder[]> {
  const { rows } = await db().query(`${SELECT} WHERE c.tenant_id = $1 AND ($2::text IS NULL OR c.status = $2) ORDER BY c.created_at DESC LIMIT 300`, [tenantId, status ?? null]);
  return rows.map(shape);
}

export async function getChangeOrder(tenantId: string, id: string): Promise<ChangeOrder | null> {
  const { rows } = await db().query(`${SELECT} WHERE c.tenant_id = $1 AND c.id = $2`, [tenantId, id]);
  return rows[0] ? shape(rows[0]) : null;
}

/** Drafts a change order from plain words and saves it as a draft. Never marks anything sent. */
export async function draftChangeOrder(
  drafter: Drafter,
  tenant: { id: string; name: string },
  jobId: string,
  text: string,
  by: { source: "app" | "text"; userId: string | null },
): Promise<ChangeOrder> {
  const job = (await db().query<{ name: string; address: string | null }>("SELECT name, address FROM jobs WHERE id = $1 AND tenant_id = $2", [jobId, tenant.id])).rows[0];
  if (!job) throw new Error("Unknown job");
  const d = await drafter({ text, companyName: tenant.name, jobName: job.name, address: job.address });
  const id = await withTx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`co:${jobId}`]); // two drafts at once must not share a number
    const n = (await tx.query<{ n: number }>("SELECT coalesce(max(number), 0) + 1 AS n FROM change_orders WHERE tenant_id = $1 AND job_id = $2", [tenant.id, jobId])).rows[0].n;
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO change_orders (tenant_id, job_id, number, title, description, items, amount, schedule_days, questions, source_text, source, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [tenant.id, jobId, n, d.title.slice(0, 120), d.description, JSON.stringify(toItems(d)), d.amount, d.schedule_days, JSON.stringify(d.questions), text, by.source, by.userId],
    );
    return ins.rows[0].id;
  });
  return (await getChangeOrder(tenant.id, id))!;
}
