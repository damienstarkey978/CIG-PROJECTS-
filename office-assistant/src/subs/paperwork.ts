// Pure rules for sub paperwork and schedule replies. No database, no network.

export interface SubPaperwork {
  w9OnFile: boolean;
  coiExpiresOn: string | null;
  lienWaiverStatus: string | null;
}

const DAY = 86_400_000;
const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** What we need from this sub, in the words used in a request. Expiring within `soonDays` counts. */
export function paperworkNeeds(p: SubPaperwork, today: Date, soonDays = 30): string[] {
  const out: string[] = [];
  if (!p.w9OnFile) out.push("W9");
  if (!p.coiExpiresOn) out.push("certificate of insurance");
  else {
    const left = Math.floor((Date.parse(p.coiExpiresOn + "T00:00:00Z") - utcDay(today)) / DAY);
    if (left < 0) out.push("updated certificate of insurance (expired)");
    else if (left <= soonDays) out.push("updated certificate of insurance (expires soon)");
  }
  if (p.lienWaiverStatus && /need|missing|pending|request/i.test(p.lienWaiverStatus)) out.push("lien waiver");
  return out;
}

export type Reply = "confirmed" | "declined" | "unclear";

/** Reads a sub's answer to "are you on site tomorrow?". Anything that is not clearly yes or no needs a person. */
export function parseConfirmReply(text: string): Reply {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(?:(?:y|yes|yep|yeah|yup|confirmed?|ok|okay|sure|will do|we'?ll be there|i'?ll be there|on it)\b|👍)/.test(t) && !/\b(not|can'?t|cannot|won'?t|but)\b/.test(t)) return "confirmed";
  if (/^(n|no|nope|nah|can'?t|cannot|won'?t|not (going|able|coming)|unable)\b/.test(t) || /\b(can'?t make it|cannot make it|won'?t be there|not coming)\b/.test(t)) return "declined";
  return "unclear";
}

/** A text from a sub that asks for materials or help, as opposed to chatter. */
export function looksLikeMaterialRequest(text: string): boolean {
  return /\b(need|needs|more|short|run(ning)? out|out of|order|deliver|delivery|missing|forgot|bring)\b/i.test(text);
}

/** Hours 9 to 17 local time, Monday to Saturday. Texts to subs only go out then. */
export function inSendWindow(timezone: string, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false, weekday: "short" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  const weekday = parts.find((p) => p.type === "weekday")!.value;
  return weekday !== "Sun" && hour >= 9 && hour < 17;
}

/** Today's date as YYYY-MM-DD in the company's time zone. */
export function localDate(timezone: string, now: Date, plusDays = 0): string {
  const d = new Date(now.getTime() + plusDays * DAY);
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function dayName(isoDate: string): string {
  return new Date(isoDate + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}
