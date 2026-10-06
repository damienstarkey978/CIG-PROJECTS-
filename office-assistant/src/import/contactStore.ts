import type { PoolClient } from "pg";

export type ImportContactType = "client" | "sub" | "vendor" | "prospect" | "other";

export interface ContactInput {
  type: ImportContactType;
  first: string | null;
  last: string | null;
  company: string;
  email: string;
  phones: string[];
  notes: string;
  trades: string[];
  coiExpiresOn: string | null;
}

export type Outcome = "created" | "updated" | "unchanged";

interface Existing { id: string; type: string; first_name: string | null; last_name: string | null; company: string | null; email: string | null; notes: string | null }

const COLS = "c.id, c.type, c.first_name, c.last_name, c.company, c.email, c.notes";

/**
 * Phone, then email. Name alone is only trusted when the row has no phone or email,
 * so two different people who share a name (common in real exports) stay separate.
 */
async function findExisting(tx: PoolClient, tenantId: string, c: ContactInput): Promise<Existing | null> {
  if (c.phones.length) {
    const r = await tx.query<Existing>(`SELECT ${COLS} FROM contact_phones p JOIN contacts c ON c.id = p.contact_id WHERE p.tenant_id = $1 AND p.phone = ANY($2) LIMIT 1`, [tenantId, c.phones]);
    if (r.rows[0]) return r.rows[0];
  }
  if (c.email) {
    const r = await tx.query<Existing>(`SELECT ${COLS} FROM contacts c WHERE c.tenant_id = $1 AND lower(c.email) = lower($2) LIMIT 1`, [tenantId, c.email]);
    if (r.rows[0]) return r.rows[0];
  }
  if (!c.phones.length && !c.email && (c.first || c.last || c.company)) {
    const r = await tx.query<Existing>(
      `SELECT ${COLS} FROM contacts c WHERE c.tenant_id = $1
         AND lower(coalesce(c.first_name,'')) = lower($2) AND lower(coalesce(c.last_name,'')) = lower($3) AND lower(coalesce(c.company,'')) = lower($4) LIMIT 1`,
      [tenantId, c.first ?? "", c.last ?? "", c.company],
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

const UPGRADABLE_FROM = new Set(["other", "prospect"]);

export async function upsertContact(tx: PoolClient, tenantId: string, c: ContactInput): Promise<{ id: string; outcome: Outcome }> {
  const found = await findExisting(tx, tenantId, c);
  let id: string;
  let changed = false;
  if (found) {
    id = found.id;
    const sets: string[] = [];
    const vals: unknown[] = [];
    const fill = (col: string, cur: string | null, next: string | null | undefined) => {
      if (!cur && next) { vals.push(next); sets.push(`${col} = $${vals.length + 2}`); }
    };
    fill("first_name", found.first_name, c.first); fill("last_name", found.last_name, c.last);
    fill("company", found.company, c.company); fill("email", found.email, c.email); fill("notes", found.notes, c.notes);
    if (UPGRADABLE_FROM.has(found.type) && c.type !== "other" && c.type !== found.type && c.type !== "prospect") { vals.push(c.type); sets.push(`type = $${vals.length + 2}`); }
    if (sets.length) { await tx.query(`UPDATE contacts SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [id, tenantId, ...vals]); changed = true; }
  } else {
    const ins = await tx.query<{ id: string }>(
      "INSERT INTO contacts (tenant_id, type, first_name, last_name, company, email, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [tenantId, c.type, c.first, c.last, c.company || null, c.email || null, c.notes || null],
    );
    id = ins.rows[0].id;
  }
  for (const phone of c.phones) {
    const r = await tx.query("INSERT INTO contact_phones (tenant_id, phone, contact_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [tenantId, phone, id]);
    if (r.rowCount && found) changed = true;
  }
  const effective = found ? (UPGRADABLE_FROM.has(found.type) && c.type !== "other" && c.type !== "prospect" ? c.type : found.type) : c.type;
  if (effective === "sub") {
    const r = await tx.query(
      `INSERT INTO sub_profiles (contact_id, trades, coi_expires_on) VALUES ($1, $2, $3)
       ON CONFLICT (contact_id) DO UPDATE SET
         trades = (SELECT coalesce(array_agg(DISTINCT t), '{}') FROM unnest(sub_profiles.trades || EXCLUDED.trades) t),
         coi_expires_on = coalesce(sub_profiles.coi_expires_on, EXCLUDED.coi_expires_on)
       WHERE NOT sub_profiles.trades @> EXCLUDED.trades OR (sub_profiles.coi_expires_on IS NULL AND EXCLUDED.coi_expires_on IS NOT NULL)`,
      [id, c.trades, c.coiExpiresOn],
    );
    if (r.rowCount && found) changed = true;
  } else if (effective === "client") {
    await tx.query("INSERT INTO client_profiles (contact_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
  }
  return { id, outcome: !found ? "created" : changed ? "updated" : "unchanged" };
}
