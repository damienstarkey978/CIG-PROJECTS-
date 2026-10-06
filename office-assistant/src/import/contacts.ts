import type { PoolClient } from "pg";
import { toE164 } from "../lib/phone";
import { mapColumns, parseCsv, pick, splitName } from "./csv";
import { runImport, type ImportResult } from "./run";

export type ImportContactType = "client" | "sub" | "vendor" | "prospect" | "other";

const SYNONYMS = {
  name: ["name", "full name", "contact", "contact name", "client name", "sub name", "subcontractor", "vendor name", "display name"],
  first: ["first name", "firstname", "first", "given name"],
  last: ["last name", "lastname", "last", "surname", "family name"],
  company: ["company", "company name", "business", "business name", "organization", "trade partner", "vendor", "subcontractor company"],
  email: ["email", "e mail", "email address", "primary email"],
  phone: ["phone", "phone number", "mobile", "cell", "cell phone", "mobile phone", "primary phone", "work phone", "telephone"],
  phone2: ["phone 2", "secondary phone", "other phone", "home phone", "alternate phone"],
  type: ["type", "contact type", "category", "role", "kind"],
  trades: ["trade", "trades", "specialty", "specialties", "service", "services"],
  notes: ["notes", "note", "comments", "memo"],
};

export function mapType(raw: string, fallback: ImportContactType): ImportContactType {
  const t = raw.toLowerCase();
  if (!t) return fallback;
  if (/sub|trade partner|contractor/.test(t)) return "sub";
  if (/vendor|supplier|supply/.test(t)) return "vendor";
  if (/client|customer|owner|homeowner/.test(t)) return "client";
  if (/lead|prospect/.test(t)) return "prospect";
  return fallback;
}

interface Existing { id: string; type: string; first_name: string | null; last_name: string | null; company: string | null; email: string | null; notes: string | null }

async function findExisting(tx: PoolClient, tenantId: string, phones: string[], email: string, first: string | null, last: string | null, company: string): Promise<Existing | null> {
  const cols = "c.id, c.type, c.first_name, c.last_name, c.company, c.email, c.notes";
  if (phones.length) {
    const r = await tx.query<Existing>(`SELECT ${cols} FROM contact_phones p JOIN contacts c ON c.id = p.contact_id WHERE p.tenant_id = $1 AND p.phone = ANY($2) LIMIT 1`, [tenantId, phones]);
    if (r.rows[0]) return r.rows[0];
  }
  if (email) {
    const r = await tx.query<Existing>(`SELECT ${cols} FROM contacts c WHERE c.tenant_id = $1 AND lower(c.email) = lower($2) LIMIT 1`, [tenantId, email]);
    if (r.rows[0]) return r.rows[0];
  }
  if (first || last || company) {
    const r = await tx.query<Existing>(
      `SELECT ${cols} FROM contacts c WHERE c.tenant_id = $1
         AND lower(coalesce(c.first_name,'')) = lower($2) AND lower(coalesce(c.last_name,'')) = lower($3) AND lower(coalesce(c.company,'')) = lower($4) LIMIT 1`,
      [tenantId, first ?? "", last ?? "", company],
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

export async function importContacts(tenantId: string, csvText: string, opts: { defaultType: ImportContactType; dryRun: boolean }): Promise<ImportResult> {
  const { headers, rows } = parseCsv(csvText);
  const { map, ignored } = mapColumns(headers, SYNONYMS);
  if (!map.name && !map.first && !map.company) throw new Error("Couldn't find a name or company column. Expected something like Name, First Name or Company.");

  return runImport(opts.dryRun, async (tx) => {
    const res: ImportResult = { dryRun: opts.dryRun, created: 0, updated: 0, unchanged: 0, skipped: 0, warnings: [], columns: { recognized: map, ignored } };
    for (const [idx, row] of rows.entries()) {
      const line = idx + 2;
      let { first, last } = map.name ? splitName(pick(row, map, "name")) : { first: null, last: null };
      first = pick(row, map, "first") || first;
      last = pick(row, map, "last") || last;
      const company = pick(row, map, "company");
      const email = pick(row, map, "email");
      const rawPhones = [pick(row, map, "phone"), pick(row, map, "phone2")].filter(Boolean);
      const phones = rawPhones.map(toE164).filter((p): p is string => Boolean(p));
      if (rawPhones.length > phones.length) res.warnings.push(`Row ${line}: a phone number couldn't be read and was skipped`);
      if (!first && !last && !company && !email && !phones.length) { res.skipped++; continue; }

      const type = mapType(pick(row, map, "type"), opts.defaultType);
      const trades = pick(row, map, "trades").split(/[;,/]/).map((t) => t.trim()).filter(Boolean);
      const notes = pick(row, map, "notes");

      const found = await findExisting(tx, tenantId, phones, email, first, last, company);
      let contactId: string;
      let changed = false;
      if (found) {
        contactId = found.id;
        const sets: string[] = [];
        const vals: unknown[] = [];
        const fill = (col: string, cur: string | null, next: string | null | undefined) => {
          if (!cur && next) { vals.push(next); sets.push(`${col} = $${vals.length + 2}`); }
        };
        fill("first_name", found.first_name, first); fill("last_name", found.last_name, last);
        fill("company", found.company, company); fill("email", found.email, email); fill("notes", found.notes, notes);
        if (found.type === "other" && type !== "other") { vals.push(type); sets.push(`type = $${vals.length + 2}`); }
        if (sets.length) { await tx.query(`UPDATE contacts SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [contactId, tenantId, ...vals]); changed = true; }
      } else {
        const ins = await tx.query<{ id: string }>(
          "INSERT INTO contacts (tenant_id, type, first_name, last_name, company, email, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
          [tenantId, type, first, last, company || null, email || null, notes || null],
        );
        contactId = ins.rows[0].id;
        changed = true;
      }
      for (const phone of phones) {
        const r = await tx.query("INSERT INTO contact_phones (tenant_id, phone, contact_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [tenantId, phone, contactId]);
        if (r.rowCount) changed = true;
      }
      const effectiveType = found ? (found.type === "other" ? type : found.type) : type;
      if (effectiveType === "sub") {
        const r = await tx.query(
          `INSERT INTO sub_profiles (contact_id, trades) VALUES ($1, $2)
           ON CONFLICT (contact_id) DO UPDATE SET trades = (SELECT array_agg(DISTINCT t) FROM unnest(sub_profiles.trades || EXCLUDED.trades) t)
           WHERE NOT sub_profiles.trades @> EXCLUDED.trades`,
          [contactId, trades],
        );
        if (r.rowCount && (trades.length || !found)) changed = true;
      } else if (effectiveType === "client") {
        await tx.query("INSERT INTO client_profiles (contact_id) VALUES ($1) ON CONFLICT DO NOTHING", [contactId]);
      }
      if (!found) res.created++;
      else if (changed) res.updated++;
      else res.unchanged++;
    }
    return res;
  });
}
