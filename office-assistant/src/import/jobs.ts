import { toE164 } from "../lib/phone";
import { upsertContact } from "./contactStore";
import { allHints, mapColumns, pick, readTable, splitName } from "./csv";
import { runImport, type ImportResult } from "./run";

const SYNONYMS = {
  name: ["job name", "job", "project name", "project", "job title", "name"],
  street: ["street address", "job address", "site address", "project address", "address", "street", "location"],
  city: ["city", "job city"],
  state: ["state", "job state"],
  zip: ["zip", "zip code", "postal code", "job zip"],
  client: ["clients", "client", "client name", "owner", "customer", "customer name", "homeowner"],
  clientPhone: ["client phone", "client cell", "customer phone", "client mobile"],
  clientEmail: ["client email", "customer email"],
  status: ["job status", "project status", "status", "stage"],
  start: ["start date", "scheduled start", "begin date", "start"],
  end: ["end date", "scheduled end", "completion date", "finish date", "due date", "end"],
  externalId: ["job id", "project id", "job number", "job no", "job #", "id"],
};

export function mapJobStatus(raw: string): "lead" | "active" | "on_hold" | "complete" | "cancelled" {
  const s = raw.toLowerCase();
  if (/complete|closed|finished|done|warranty/.test(s)) return "complete";
  if (/hold|paused/.test(s)) return "on_hold";
  if (/cancel|lost|declin/.test(s)) return "cancelled";
  if (/lead|prospect|estimat|proposal|bid|open sales/.test(s)) return "lead";
  return "active";
}

function toDate(raw: string): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Buildertrend marks some jobs with a leading "*". */
const cleanJobName = (s: string) => s.replace(/^[*\s]+/, "").replace(/\s+/g, " ").trim();

export async function importJobs(tenantId: string, input: string | Buffer, opts: { dryRun: boolean }): Promise<ImportResult> {
  const { headers, rows } = await readTable(input, allHints(SYNONYMS));
  const { map, ignored } = mapColumns(headers, SYNONYMS);
  if (!map.name) throw new Error("Couldn't find a job name column. Expected something like Job Name or Project.");

  return runImport(opts.dryRun, async (tx) => {
    const res: ImportResult = { dryRun: opts.dryRun, created: 0, updated: 0, unchanged: 0, skipped: 0, warnings: [], columns: { recognized: map, ignored } };
    let badDates = 0, extraClients = 0, badPhones = 0;
    for (const row of rows) {
      const name = cleanJobName(pick(row, map, "name"));
      if (!name) { res.skipped++; continue; }
      const street = pick(row, map, "street");
      const cityLine = [pick(row, map, "city"), [pick(row, map, "state"), pick(row, map, "zip")].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      const address = [street, cityLine].filter(Boolean).join(", ") || null;
      const startRaw = pick(row, map, "start"), endRaw = pick(row, map, "end");
      const start = toDate(startRaw), end = toDate(endRaw);
      if ((startRaw && !start) || (endRaw && !end)) badDates++;
      const status = mapJobStatus(pick(row, map, "status"));
      const extId = pick(row, map, "externalId");

      // Several clients can be stacked in one cell; the first is the one we link.
      const clientNames = pick(row, map, "client").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (clientNames.length > 1) extraClients++;
      let clientId: string | null = null;
      if (clientNames.length) {
        const p = splitName(clientNames[0]);
        const rawPhone = pick(row, map, "clientPhone");
        const phone = toE164(rawPhone);
        if (rawPhone && !phone) badPhones++;
        const c = await upsertContact(tx, tenantId, {
          type: "client", first: p.first, last: p.last, company: p.label ?? "", email: pick(row, map, "clientEmail"),
          phones: phone ? [phone] : [], notes: "", trades: [], coiExpiresOn: null,
        });
        clientId = c.id;
      }

      const found = await tx.query<{ id: string; address: string | null; client_contact_id: string | null; start_date: Date | null; end_date: Date | null }>(
        "SELECT id, address, client_contact_id, start_date, end_date FROM jobs WHERE tenant_id = $1 AND lower(name) = lower($2) LIMIT 1",
        [tenantId, name],
      );
      if (!found.rows[0]) {
        await tx.query(
          "INSERT INTO jobs (tenant_id, name, address, client_contact_id, status, start_date, end_date, external_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [tenantId, name, address, clientId, status, start, end, JSON.stringify(extId ? { import: extId } : {})],
        );
        res.created++;
        continue;
      }
      const j = found.rows[0];
      const sets: string[] = [];
      const vals: unknown[] = [];
      const fill = (col: string, cur: unknown, next: unknown) => { if (!cur && next) { vals.push(next); sets.push(`${col} = $${vals.length + 2}`); } };
      fill("address", j.address, address); fill("client_contact_id", j.client_contact_id, clientId);
      fill("start_date", j.start_date, start); fill("end_date", j.end_date, end);
      if (sets.length) { await tx.query(`UPDATE jobs SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2`, [j.id, tenantId, ...vals]); res.updated++; }
      else res.unchanged++;
    }
    if (badDates) res.warnings.push(`${badDates} job(s) had a date that couldn't be read`);
    if (badPhones) res.warnings.push(`${badPhones} client phone number(s) couldn't be read`);
    if (extraClients) res.warnings.push(`${extraClients} job(s) list more than one client; only the first is linked`);
    if (!map.status) res.warnings.push("No job status column found, so every job is marked active");
    return res;
  });
}
