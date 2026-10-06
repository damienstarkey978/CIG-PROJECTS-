// Pure helpers for the books features. No database, no network.

export type Bucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

export interface AgeTotals {
  total: number;
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
}

const DAY = 86_400_000;
const midnightUtc = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Whole days past due as of today (negative or zero means not yet due). No due date counts as due now. */
export function daysOverdue(dueDate: string | null, today: Date): number {
  if (!dueDate) return 0;
  return Math.floor((midnightUtc(today) - Date.parse(dueDate + "T00:00:00Z")) / DAY);
}

export function bucketOf(days: number): Bucket {
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

export function ageTotals(items: { dueDate: string | null; balance: number }[], today: Date): AgeTotals {
  const t: AgeTotals = { total: 0, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const i of items) {
    const b = bucketOf(daysOverdue(i.dueDate, today));
    t[b] = round2(t[b] + i.balance);
    t.total = round2(t.total + i.balance);
  }
  return t;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const LEGAL = /\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|pllc|lp)\b/g;
/** For matching a vendor to a contact: ignores punctuation and legal suffixes. */
export const normCompany = (s: string) => normName(s).replace(LEGAL, " ").replace(/\s+/g, " ").trim();

export interface JobRef { id: string; name: string; address: string | null }
export interface JobSuggestion { jobId: string; confidence: "high" | "medium"; why: string }

const tokens = (s: string) => normName(s).split(" ").filter((t) => t.length >= 4);

/**
 * Which job does a cost or invoice belong to? Looks at the texts that name it: the
 * customer:job reference on a QuickBooks line, line descriptions, the memo. Returns
 * nothing rather than guessing when two jobs fit equally well.
 */
export function suggestJob(texts: (string | null | undefined)[], jobs: JobRef[]): JobSuggestion | null {
  const hay = normName(texts.filter(Boolean).join(" | "));
  if (!hay) return null;
  const hayTokens = new Set(tokens(hay));
  const tokenFreq = new Map<string, number>();
  for (const j of jobs) for (const t of new Set(tokens(j.name))) tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1);

  const scored = jobs.map((j) => {
    const name = normName(j.name.replace(/^[*\s]+/, ""));
    const street = j.address ? normName(j.address.split(",")[0]) : "";
    if (street.length >= 6 && hay.includes(street)) return { j, score: 3, why: `mentions the address ${j.address!.split(",")[0]}` };
    if (name.length >= 6 && hay.includes(name)) return { j, score: 3, why: `mentions the job name "${j.name}"` };
    const shared = [...new Set(tokens(j.name))].filter((t) => hayTokens.has(t));
    if (shared.length >= 2) return { j, score: 2, why: `shares "${shared.join(" ")}" with the job name` };
    if (shared.length === 1 && shared[0].length >= 6 && tokenFreq.get(shared[0]) === 1) return { j, score: 2, why: `shares "${shared[0]}" with the job name` };
    return { j, score: 0, why: "" };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
  return { jobId: scored[0].j.id, confidence: scored[0].score >= 3 ? "high" : "medium", why: scored[0].why };
}

export interface VendorPaperwork {
  /** Is the vendor in the contact list at all? */
  known: boolean;
  /** Present only for subs; suppliers need no paperwork. */
  sub: { w9OnFile: boolean; coiExpiresOn: string | null; lienWaiverStatus: string | null } | null;
}

/** What should be sorted out before this vendor is paid. A person decides; this only lists. */
export function paymentBlockers(v: VendorPaperwork, today: Date): string[] {
  if (!v.known) return ["Vendor isn't in your contact list"];
  if (!v.sub) return [];
  const out: string[] = [];
  if (!v.sub.w9OnFile) out.push("No W9 on file");
  if (!v.sub.coiExpiresOn) out.push("No insurance certificate date on file");
  else if (Date.parse(v.sub.coiExpiresOn + "T00:00:00Z") < midnightUtc(today)) out.push(`Insurance certificate expired ${v.sub.coiExpiresOn}`);
  if (v.sub.lienWaiverStatus && /need|missing|pending|request/i.test(v.sub.lienWaiverStatus)) out.push("Lien waiver outstanding");
  return out;
}
