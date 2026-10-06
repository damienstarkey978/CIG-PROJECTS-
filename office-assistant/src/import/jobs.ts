import type { PoolClient } from "pg";
import { mapColumns, parseCsv, pick, splitName } from "./csv";
import { runImport, type ImportResult } from "./run";

const SYNONYMS = {
  name: ["job", "job name", "project", "project name", "name", "job title"],
  address: ["address", "job address", "site address", "street", "project address", "location"],
  client: ["client", "client name", "owner", "customer", "customer name", "homeowner"],
  status: ["status", "job status", "project status", "stage"],
  start: ["start", "start date", "scheduled start", "begin date"],
  end: ["end", "end date", "scheduled end", "completion date", "finish date", "due date"],
  externalId: ["job id", "project id", "id", "job number", "job no", "job #"],
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

async function clientIdFor(tx: PoolClient, tenantId: string, raw: string): Promise<{ id: string; created: boolean }> {
  const { first, last } = splitName(raw);
  const found = await tx.query<{ id: string }>(
    `SELECT id FROM contacts WHERE tenant_id = $1 AND (
       lower(trim(concat_ws(' ', first_name, last_name))) = lower($2) OR lower(company) = lower($2)) ORDER BY (type = 'client') DESC LIMIT 1`,
    [tenantId, [first, last].filter(Boolean).join(" ")],
  );
  if (found.rows[0]) return { id: found.rows[0].id, created: false };
  const ins = await tx.query<{ id: string }>("INSERT INTO contacts (tenant_id, type, first_name, last_name) VALUES ($1,'client',$2,$3) RETURNING id", [tenantId, first, last]);
  await tx.query("INSERT INTO client_profiles (contact_id) VALUES ($1)", [ins.rows[0].id]);
  return { id: ins.rows[0].id, created: true };
}

export async function importJobs(tenantId: string, csvText: string, opts: { dryRun: boolean }): Promise<ImportResult> {
  const { headers, rows } = parseCsv(csvText);
  const { map, ignored } = mapColumns(headers, SYNONYMS);
  if (!map.name) throw new Error("Couldn't find a job name column. Expected something like Job Name or Project.");

  return runImport(opts.dryRun, async (tx) => {
    const res: ImportResult = { dryRun: opts.dryRun, created: 0, updated: 0, unchanged: 0, skipped: 0, warnings: [], columns: { recognized: map, ignored } };
    for (const [idx, row] of rows.entries()) {
      const line = idx + 2;
      const name = pick(row, map, "name");
      if (!name) { res.skipped++; continue; }
      const address = pick(row, map, "address") || null;
      const startRaw = pick(row, map, "start"), endRaw = pick(row, map, "end");
      const start = toDate(startRaw), end = toDate(endRaw);
      if (startRaw && !start) res.warnings.push(`Row ${line}: start date "${startRaw}" couldn't be read`);
      if (endRaw && !end) res.warnings.push(`Row ${line}: end date "${endRaw}" couldn't be read`);
      const status = mapJobStatus(pick(row, map, "status"));
      const extId = pick(row, map, "externalId");

      let clientId: string | null = null;
      const clientRaw = pick(row, map, "client");
      if (clientRaw) {
        const c = await clientIdFor(tx, tenantId, clientRaw);
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
    return res;
  });
}
