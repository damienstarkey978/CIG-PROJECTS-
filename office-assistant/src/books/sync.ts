import type { PoolClient } from "pg";
import type { AccountingProvider } from "../connectors/types";
import { db, withTx } from "../lib/db";
import { daysOverdue, money, normCompany, normName, paymentBlockers, suggestJob, type JobRef } from "./analyze";

export const DEFAULT_CHASE_AFTER_DAYS = 14;
const BILL_SOON_DAYS = 7;

interface ContactRow { id: string; type: string; first_name: string | null; last_name: string | null; company: string | null }

/** Every way a contact might be written in the books. */
function contactKeys(c: ContactRow): string[] {
  const person = [c.first_name, c.last_name].filter(Boolean);
  const keys = [c.company ? normCompany(c.company) : "", person.length ? normName(person.join(" ")) : "", person.length === 2 ? normName(`${person[1]} ${person[0]}`) : ""];
  return keys.filter((k) => k.length >= 3);
}

function buildContactIndex(rows: ContactRow[]): Map<string, ContactRow> {
  const idx = new Map<string, ContactRow>();
  for (const c of rows) for (const k of contactKeys(c)) if (!idx.has(k)) idx.set(k, c);
  return idx;
}

async function createTaskOnce(tx: PoolClient, tenantId: string, ref: string, t: { type: string; title: string; body: string; contactId: string | null; jobId: string | null }): Promise<boolean> {
  const dupe = await tx.query("SELECT 1 FROM tasks WHERE tenant_id = $1 AND type = $2 AND status = 'open' AND external_ids->>'ref' = $3", [tenantId, t.type, ref]);
  if (dupe.rowCount) return false;
  await tx.query(
    "INSERT INTO tasks (tenant_id, type, title, body, contact_id, job_id, external_ids) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [tenantId, t.type, t.title, t.body, t.contactId, t.jobId, JSON.stringify({ ref })],
  );
  return true;
}

export interface SyncResult { bills: number; invoices: number; tasksCreated: number }

/**
 * Copies open bills and invoices from the books into our tables, links them to contacts
 * and jobs, and opens follow up tasks. Read only: nothing is ever written back, and no
 * text or email goes to anyone from here.
 */
export async function syncBooks(tenantId: string, provider: AccountingProvider, opts: { today?: Date; chaseAfterDays?: number } = {}): Promise<SyncResult> {
  const today = opts.today ?? new Date();
  const chaseAfter = opts.chaseAfterDays ?? DEFAULT_CHASE_AFTER_DAYS;
  const run = await db().query<{ id: string }>("INSERT INTO acct_sync_runs (tenant_id, provider) VALUES ($1,$2) RETURNING id", [tenantId, provider.name]);
  try {
    const [bills, invoices] = [await provider.listOpenBills(), await provider.listOpenInvoices()];
    const result = await withTx(async (tx) => {
      const startedAt = (await tx.query<{ now: Date }>("SELECT now()")).rows[0].now;
      const contacts = (await tx.query<ContactRow>("SELECT id, type, first_name, last_name, company FROM contacts WHERE tenant_id = $1", [tenantId])).rows;
      const idx = buildContactIndex(contacts);
      const jobs = (await tx.query<JobRef & { client_contact_id: string | null }>("SELECT id, name, address, client_contact_id FROM jobs WHERE tenant_id = $1", [tenantId])).rows;
      const profiles = new Map(
        (await tx.query<{ contact_id: string; w9_on_file: boolean; coi_expires_on: string | null; lien_waiver_status: string | null }>(
          "SELECT s.contact_id, s.w9_on_file, s.coi_expires_on::text, s.lien_waiver_status FROM sub_profiles s JOIN contacts c ON c.id = s.contact_id WHERE c.tenant_id = $1", [tenantId],
        )).rows.map((p) => [p.contact_id, p]),
      );
      let tasksCreated = 0;

      for (const b of bills) {
        const contact = idx.get(normCompany(b.vendorName)) ?? idx.get(normName(b.vendorName)) ?? null;
        const job = suggestJob([...b.lines.map((l) => l.customerRef), ...b.lines.map((l) => l.description), b.memo], jobs);
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO acct_bills (tenant_id, provider, external_id, vendor_external_id, vendor_name, contact_id, txn_date, due_date, amount, balance, doc_number, memo, lines, suggested_job_id, suggestion_note, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
           ON CONFLICT (tenant_id, provider, external_id) DO UPDATE SET vendor_external_id = EXCLUDED.vendor_external_id, vendor_name = EXCLUDED.vendor_name,
             contact_id = EXCLUDED.contact_id, txn_date = EXCLUDED.txn_date, due_date = EXCLUDED.due_date, amount = EXCLUDED.amount, balance = EXCLUDED.balance,
             doc_number = EXCLUDED.doc_number, memo = EXCLUDED.memo, lines = EXCLUDED.lines, suggested_job_id = EXCLUDED.suggested_job_id,
             suggestion_note = EXCLUDED.suggestion_note, synced_at = now() RETURNING id`,
          [tenantId, provider.name, b.externalId, b.vendorExternalId, b.vendorName, contact?.id ?? null, b.txnDate, b.dueDate, b.amount, b.balance, b.docNumber, b.memo, JSON.stringify(b.lines), job?.jobId ?? null, job ? `${job.confidence}: ${job.why}` : null],
        );
        void ins;
        // Flag bills that are due soon (or late) and can't be paid cleanly yet.
        if (daysOverdue(b.dueDate, today) >= -BILL_SOON_DAYS) {
          const p = contact ? profiles.get(contact.id) : undefined;
          const blockers = paymentBlockers(
            { known: Boolean(contact), sub: p ? { w9OnFile: p.w9_on_file, coiExpiresOn: p.coi_expires_on, lienWaiverStatus: p.lien_waiver_status } : null },
            today,
          );
          if (blockers.length) {
            const made = await createTaskOnce(tx, tenantId, `bill:${provider.name}:${b.externalId}`, {
              type: "bill_blocked",
              title: `Hold payment: ${b.vendorName} ${money(b.balance)}${b.docNumber ? ` (#${b.docNumber})` : ""}`,
              body: `Due ${b.dueDate ?? "no date"}. Before paying: ${blockers.join("; ")}.`,
              contactId: contact?.id ?? null,
              jobId: job?.jobId ?? null,
            });
            if (made) tasksCreated++;
          }
        }
      }

      for (const i of invoices) {
        // QuickBooks writes jobs as "Customer:Job". The part before the colon is the client.
        const clientPart = i.customerName.split(":")[0];
        const job = suggestJob([i.customerName], jobs);
        const jobRow = job ? jobs.find((j) => j.id === job.jobId) : undefined;
        const contact = idx.get(normName(clientPart)) ?? idx.get(normCompany(clientPart)) ?? (jobRow?.client_contact_id ? contacts.find((c) => c.id === jobRow.client_contact_id) : undefined) ?? null;
        await tx.query(
          `INSERT INTO acct_invoices (tenant_id, provider, external_id, customer_external_id, customer_name, contact_id, job_id, txn_date, due_date, amount, balance, doc_number, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
           ON CONFLICT (tenant_id, provider, external_id) DO UPDATE SET customer_external_id = EXCLUDED.customer_external_id, customer_name = EXCLUDED.customer_name,
             contact_id = EXCLUDED.contact_id, job_id = EXCLUDED.job_id, txn_date = EXCLUDED.txn_date, due_date = EXCLUDED.due_date, amount = EXCLUDED.amount,
             balance = EXCLUDED.balance, doc_number = EXCLUDED.doc_number, synced_at = now()`,
          [tenantId, provider.name, i.externalId, i.customerExternalId, i.customerName, contact?.id ?? null, job?.jobId ?? null, i.txnDate, i.dueDate, i.amount, i.balance, i.docNumber],
        );
        const late = daysOverdue(i.dueDate, today);
        if (late >= chaseAfter) {
          const made = await createTaskOnce(tx, tenantId, `invoice:${provider.name}:${i.externalId}`, {
            type: "chase_invoice",
            title: `Chase payment: ${i.customerName} ${money(i.balance)}${i.docNumber ? ` (#${i.docNumber})` : ""}`,
            body: `${late} days past due (due ${i.dueDate}). Balance ${money(i.balance)} of ${money(i.amount)}.`,
            contactId: contact?.id ?? null,
            jobId: job?.jobId ?? null,
          });
          if (made) tasksCreated++;
        }
      }

      // Anything not returned this time has been paid or voided in the books.
      await tx.query("DELETE FROM acct_bills WHERE tenant_id = $1 AND provider = $2 AND synced_at < $3", [tenantId, provider.name, startedAt]);
      await tx.query("DELETE FROM acct_invoices WHERE tenant_id = $1 AND provider = $2 AND synced_at < $3", [tenantId, provider.name, startedAt]);
      return { bills: bills.length, invoices: invoices.length, tasksCreated };
    });
    await db().query("UPDATE acct_sync_runs SET finished_at = now(), bills = $2, invoices = $3 WHERE id = $1", [run.rows[0].id, result.bills, result.invoices]);
    return result;
  } catch (err) {
    await db().query("UPDATE acct_sync_runs SET finished_at = now(), error = $2 WHERE id = $1", [run.rows[0].id, String(err)]);
    throw err;
  }
}
