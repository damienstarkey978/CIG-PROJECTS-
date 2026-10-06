import type { CallerType, Classification, Classifier } from "./classify";

// Keyword classifier used ONLY when no Claude credentials are configured, so the
// demo and tests run offline. It is crude on purpose; never use it with live callers.

const RULES: Record<Exclude<CallerType, "unknown">, RegExp[]> = {
  solicitor: [/\bseo\b/i, /google ads/i, /marketing/i, /lead generation|more (booked )?jobs|leads for/i, /financing|merchant|extended warranty/i, /special offer|limited time/i, /we help contractors/i],
  sub_vendor: [/lien waiver/i, /\binvoice\b/i, /\bdraw\b/i, /\bw-?9\b|\bcoi\b|certificate of insurance/i, /my (crew|guys)/i, /delivery|purchase order|(?<!change )\border\b/i, /we're on|we are on|on site|on the job/i],
  existing_client: [/our (job|project)|my (job|project)/i, /change order/i, /punch ?list/i, /warranty/i, /you('| a)re (working|building)/i, /when will (you|they)/i],
  lead: [/\bquote\b|estimate|how much (would|does)/i, /remodel|renovat|addition|bathroom|kitchen|roof|deck|basement/i, /looking (to|for)|interested in|\b(we|i) (want|need) (to|a|an|some|our)\b/i, /referred|recommended/i],
};

const JOBS = ["kitchen remodel", "bathroom remodel", "bathroom", "kitchen", "roof", "addition", "deck", "basement", "siding", "flooring", "painting", "windows"];
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";

export function offlineClassifier(): Classifier {
  return async (ctx) => {
    const text = [
      ...(ctx.transcript ?? []).filter((l) => l.identifier !== null || l.userId === null).map((l) => l.text),
      ctx.voicemailTranscript ?? "",
      ...(ctx.summary ?? []),
    ].join(" ");

    const hits = Object.fromEntries(
      Object.entries(RULES).map(([k, rs]) => [k, rs.filter((r) => r.test(text)).length]),
    ) as Record<string, number>;
    const ranked = Object.entries(hits).sort((a, b) => b[1] - a[1]);
    const [best, bestN] = ranked[0];
    const second = ranked[1][1];
    const tied = bestN === second;
    const callerType: CallerType = bestN === 0 || tied ? "unknown" : (best as CallerType);
    const confidence = callerType === "unknown" ? 0.3 : Math.min(0.9, 0.55 + 0.12 * bestN);

    const name = /(?:this is|my name is|it's|it is) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/.exec(text)?.[1] ?? null;
    const company = /(?:with|from|at) ([A-Z][\w&]+(?: [A-Z][\w&]+)*)/.exec(text)?.[1] ?? null;
    const address = /\b\d{2,5} [A-Z][a-z]+(?: [A-Z][a-z]+)? (?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Ct|Court)\b/.exec(text)?.[0] ?? null;
    const timeline =
      new RegExp(`\\b(?:this|next) (?:spring|summer|fall|winter|month|week|year)\\b|\\bin (?:${MONTHS})\\b|\\b(?:${MONTHS}) \\d{0,2}`, "i").exec(text)?.[0] ?? null;
    const jobType = JOBS.find((j) => new RegExp(`\\b${j}\\b`, "i").test(text)) ?? null;

    const who = name ?? "Caller";
    const summary = {
      lead: `${who} wants ${jobType ?? "work"} done${address ? ` at ${address}` : ""}${timeline ? `, ${timeline}` : ""}. Call back with an estimate visit.`,
      sub_vendor: `${company ?? who} left a message about a job or paperwork. Needs a reply from the office.`,
      existing_client: `${who} called about their current job. Needs a reply from the project manager.`,
      solicitor: `${who} was selling something. No action needed.`,
      unknown: `${who} called but the reason was unclear. Needs a quick look.`,
    }[callerType];

    const out: Classification = {
      caller_type: callerType,
      confidence,
      reasoning: callerType === "unknown" ? "Offline keyword demo: no clear match." : `Offline keyword demo: ${bestN} ${callerType} cue(s).`,
      caller_name: name,
      company: callerType === "lead" ? null : company,
      job_type: callerType === "lead" ? jobType : null,
      job_address: callerType === "lead" ? address : null,
      timeline: callerType === "lead" ? timeline : null,
      budget_hint: null,
      job_reference: null,
      urgency: /urgent|emergency|asap|leak|flood/i.test(text) ? "urgent" : "normal",
      callback_requested: callerType === "lead" || /call (me )?back/i.test(text),
      office_summary: summary,
    };
    return out;
  };
}
