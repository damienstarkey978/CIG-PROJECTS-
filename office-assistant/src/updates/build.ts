import { db, withTx } from "../lib/db";
import type { Tenant } from "../tenants";
import { matchJobByAddress, unsupportedNumbers, type EmailParser, type JobRef, type ParsedJob } from "./parse";

export const DEFAULT_CLOSING = "Please let us know if you have any questions. Thank you again for choosing {business}.";

const bullets = (items: string[]) => items.map((i) => `• ${i.replace(/^\s*[-*•]\s*/, "").trim()}`).join("\n");

/** The exact shape clients get: greeting, intro, This Week's Progress, Upcoming Work, closing, signature. */
export function renderBody(o: { firstName: string | null; intro: string; progress: string[]; upcoming: string[]; closing: string; signature: string; business: string }): string {
  const parts = [`${o.firstName ? `Hi ${o.firstName},` : "Hello,"}`, o.intro.trim()];
  if (o.progress.length) parts.push(`This Week's Progress:\n${bullets(o.progress)}`);
  if (o.upcoming.length) parts.push(`Upcoming Work:\n${bullets(o.upcoming)}`);
  parts.push(o.closing.replace(/\{business\}/g, o.business).replace(/([A-Za-z])\.\.(?!\.)/g, "$1.").trim()); // "Inc." + "." is one full stop
  if (o.signature.trim()) parts.push(o.signature.trim());
  return parts.join("\n\n");
}

export const subjectFor = (address: string) => `Weekly Progress Update - ${address}`;

export interface BuildResult {
  batchId: string;
  drafted: { id: string; address: string; flags: string[] }[];
  skipped: { address: string; reason: string }[];
  alreadyDone: string[];
  unreadable: boolean;
}

/**
 * Parses the project manager's email and saves one draft per client. Nothing is sent. A job that
 * already has a draft or a sent update from the last two days is left alone, so running the same
 * email twice does not double up.
 */
export async function buildClientUpdates(
  parser: EmailParser,
  tenant: Tenant,
  email: { text: string; from?: string | null; subject?: string | null; source: "paste" | "email"; userId?: string | null },
  opts: { force?: boolean } = {},
): Promise<BuildResult> {
  const parsed = await parser({ text: email.text, business: tenant.name });
  const cfg = tenant.settings.weeklyUpdates ?? {};
  const cc = (cfg.cc ?? []).filter(Boolean);
  const closing = cfg.closing?.trim() || DEFAULT_CLOSING;
  const signature = cfg.signature ?? "";

  const jobs = (await db().query<JobRef & { client_contact_id: string | null }>("SELECT id, name, address, client_contact_id FROM jobs WHERE tenant_id = $1", [tenant.id])).rows;
  const contacts = new Map((await db().query<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>(
    "SELECT id, first_name, last_name, email FROM contacts WHERE tenant_id = $1 AND type IN ('client','prospect','other')", [tenant.id])).rows.map((c) => [c.id, c]));

  return withTx(async (tx) => {
    const batch = (await tx.query<{ id: string }>(
      "INSERT INTO update_batches (tenant_id, kind, source, from_address, subject, raw_text, created_by_user_id) VALUES ($1,'progress',$2,$3,$4,$5,$6) RETURNING id",
      [tenant.id, email.source, email.from ?? null, email.subject ?? null, email.text, email.userId ?? null])).rows[0].id;
    const out: BuildResult = { batchId: batch, drafted: [], skipped: [], alreadyDone: [], unreadable: parsed.jobs.length === 0 };

    for (const j of parsed.jobs as ParsedJob[]) {
      const flags: string[] = [];
      const match = matchJobByAddress(j.address, jobs);
      const job = match && "job" in match ? match.job : null;
      if (!match) flags.push("Job not found. Check the address.");
      else if ("ambiguous" in match) flags.push(`Address matches more than one job: ${match.ambiguous.join("; ")}`);
      const jobRow = job ? jobs.find((x) => x.id === job.id) : undefined;
      const contact = jobRow?.client_contact_id ? contacts.get(jobRow.client_contact_id) : undefined;

      if (j.skip) {
        await tx.query(
          "INSERT INTO update_drafts (tenant_id, batch_id, job_id, address, client_contact_id, subject, body, flags, status) VALUES ($1,$2,$3,$4,$5,$6,'',$7,'skipped')",
          [tenant.id, batch, job?.id ?? null, j.address, contact?.id ?? null, subjectFor(j.address), [j.skip_reason ?? "Skipped as the project manager asked"]]);
        out.skipped.push({ address: j.address, reason: j.skip_reason ?? "Skipped as the project manager asked" });
        continue;
      }

      if (!opts.force) {
        const dupe = await tx.query(
          `SELECT 1 FROM update_drafts d JOIN update_batches b ON b.id = d.batch_id
           WHERE d.tenant_id = $1 AND b.kind = 'progress' AND d.status IN ('draft','sending','sent') AND d.created_at > now() - interval '2 days'
             AND (($2::uuid IS NOT NULL AND d.job_id = $2) OR ($2::uuid IS NULL AND lower(d.address) = lower($3)))`,
          [tenant.id, job?.id ?? null, j.address]);
        if (dupe.rowCount) { out.alreadyDone.push(j.address); continue; }
      }

      const firstName = contact?.first_name ?? (j.client_name ? j.client_name.trim().split(/\s+/)[0] : null);
      if (!contact?.email) flags.push(job ? "No client email on file. Add one before sending." : "Add the client's email before sending.");
      if (!j.progress.length) flags.push("The notes had no progress items for this job.");
      if (!j.upcoming.length) flags.push("No upcoming work in the notes, so that section is left out.");
      const odd = unsupportedNumbers(j, email.text);
      if (odd.length) flags.push(`Check these numbers or dates, they are not in the notes: ${odd.join(", ")}`);
      for (const h of j.held_back) flags.push(`Left out as internal: ${h}`);

      const body = renderBody({ firstName, intro: j.intro, progress: j.progress, upcoming: j.upcoming, closing, signature, business: tenant.name });
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO update_drafts (tenant_id, batch_id, job_id, address, client_contact_id, to_emails, cc, subject, body, flags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [tenant.id, batch, job?.id ?? null, j.address, contact?.id ?? null, contact?.email ? [contact.email] : [], cc, subjectFor(j.address), body, flags]);
      out.drafted.push({ id: ins.rows[0].id, address: j.address, flags });
    }
    return out;
  });
}
