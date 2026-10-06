import { toE164 } from "../lib/phone";
import { upsertContact, type ImportContactType } from "./contactStore";
import { allHints, mapColumns, pick, readTable, splitName } from "./csv";
import { runImport, type ImportResult } from "./run";

export type { ImportContactType };

// Order matters: a column feeds only one field, earlier fields first. Cell comes
// before Phone so the number people actually text is the main one.
const SYNONYMS = {
  name: ["name", "full name", "contact", "contact name", "primary contact", "client name", "sub name", "vendor name", "display name"],
  first: ["first name", "firstname", "first", "given name"],
  last: ["last name", "lastname", "last", "surname", "family name"],
  company: ["company", "company name", "business", "business name", "organization", "trade partner", "vendor", "subcontractor company"],
  email: ["email", "e mail", "email address", "primary email"],
  phone: ["cell", "cell phone", "mobile", "mobile phone", "primary phone", "phone", "phone number", "telephone", "work phone"],
  phone2: ["phone", "phone 2", "secondary phone", "other phone", "home phone", "alternate phone", "work phone"],
  type: ["type", "contact type", "category", "role", "kind"],
  trades: ["trade", "trades", "division", "specialty", "specialties", "service", "services"],
  notes: ["notes", "note", "comments", "memo"],
  coiExpires: ["liability exp", "liability expiration", "liability insurance exp", "coi expires", "coi expiration", "insurance exp", "insurance expiration"],
  jobs: ["jobs", "job count", "number of jobs"],
  leads: ["lead opportunities", "leads", "lead count"],
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

function toDate(raw: string): string | null {
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

export async function importContacts(tenantId: string, input: string | Buffer, opts: { defaultType: ImportContactType; dryRun: boolean }): Promise<ImportResult> {
  const { headers, rows } = await readTable(input, allHints(SYNONYMS));
  const { map, ignored } = mapColumns(headers, SYNONYMS);
  if (!map.name && !map.first && !map.company) throw new Error("Couldn't find a name or company column. Expected something like Name, First Name or Company.");

  return runImport(opts.dryRun, async (tx) => {
    const res: ImportResult = { dryRun: opts.dryRun, created: 0, updated: 0, unchanged: 0, skipped: 0, warnings: [], columns: { recognized: map, ignored } };
    let badPhones = 0, badDates = 0;
    for (const row of rows) {
      const person = map.name ? splitName(pick(row, map, "name")) : { first: null, last: null, label: null };
      const first = pick(row, map, "first") || person.first;
      const last = pick(row, map, "last") || person.last;
      const company = pick(row, map, "company") || person.label || "";
      const email = pick(row, map, "email");
      const rawPhones = [pick(row, map, "phone"), pick(row, map, "phone2")].filter(Boolean);
      const phones = [...new Set(rawPhones.map(toE164).filter((p): p is string => Boolean(p)))];
      badPhones += rawPhones.length - rawPhones.map(toE164).filter(Boolean).length;
      if (!first && !last && !company && !email && !phones.length) { res.skipped++; continue; }

      // A Buildertrend style client list says who has jobs and who is only a lead.
      let type = mapType(pick(row, map, "type"), opts.defaultType);
      if (!map.type && map.jobs && map.leads && (type === "client" || type === "other")) {
        if (Number(pick(row, map, "jobs")) > 0) type = "client";
        else if (Number(pick(row, map, "leads")) > 0) type = "prospect";
      }
      const coiRaw = pick(row, map, "coiExpires");
      const coi = toDate(coiRaw);
      if (coiRaw && !coi) badDates++;

      const out = await upsertContact(tx, tenantId, {
        type, first, last, company, email, phones,
        notes: pick(row, map, "notes"),
        trades: pick(row, map, "trades").split(/[;,/]/).map((t) => t.trim()).filter(Boolean),
        coiExpiresOn: coi,
      });
      res[out.outcome]++;
    }
    if (badPhones) res.warnings.push(`${badPhones} phone number(s) couldn't be read and were skipped`);
    if (badDates) res.warnings.push(`${badDates} insurance date(s) couldn't be read`);
    return res;
  });
}
