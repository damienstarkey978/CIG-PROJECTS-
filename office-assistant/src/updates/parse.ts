import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { normName } from "../books/analyze";
import { config } from "../config";

// Turns the project manager's weekly progress email (internal notes for every job) into one
// client ready update per job. Facts come only from the notes. A person reviews every draft.

export const ProgressEmailSchema = z.object({
  jobs: z.array(z.object({
    address: z.string().describe("The job address exactly as the project manager wrote it"),
    client_name: z.string().nullable().describe("The client's name only if the notes give it"),
    skip: z.boolean().describe("True when the notes say not to send this one, e.g. skip this week or already sent"),
    skip_reason: z.string().nullable(),
    intro: z.string().describe("One or two sentences summing up the week. No promises, no new facts."),
    progress: z.array(z.string()).describe("This week's progress, rewritten for a client, close to the notes' wording"),
    upcoming: z.array(z.string()).describe("Planned next work, only what the notes say. Empty if none."),
    held_back: z.array(z.string()).describe("Internal remarks you left out of the client email, so the reviewer can see them"),
  })),
});
export type ParsedEmail = z.infer<typeof ProgressEmailSchema>;
export type ParsedJob = ParsedEmail["jobs"][number];
export type EmailParser = (input: { text: string; business: string }) => Promise<ParsedEmail>;

const SYSTEM = `You prepare weekly client progress updates for a small residential contracting company. The project manager sends one internal email covering every active job, written as shorthand notes. You turn each job's notes into a short, warm, client ready update.

Rules:
- One entry per job or address in the email, in the order given.
- Respect explicit exclusions. If the email says to skip a job this week, or that it was already sent, set skip to true with the reason, and still return the entry.
- Use only facts in that job's notes. Never add dates, names, quantities, costs or promises that are not written there. Keep close to the project manager's wording; rewrite shorthand into plain client friendly language.
- Leave internal matters out of the client update and list them in held_back: pricing or margin talk, problems with subs or suppliers, the client's behavior or payment, anything critical of anyone.
- Put work that already happened under progress. Put planned or scheduled next steps under upcoming. If the notes give none, leave upcoming empty.
- The intro is one or two sentences, friendly and specific to the week's work.
- Do not write greetings, headings, closings or signatures; those are added automatically.
- If the email contains no job updates at all, return an empty jobs list.`;

export function claudeEmailParser(client = new Anthropic()): EmailParser {
  return async ({ text, business }) => {
    const res = await client.beta.messages.parse({
      model: config.classifierModel,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: `Company: ${business}\n\nProject manager's email:\n${text}` }],
      output_config: { effort: "medium", format: betaZodOutputFormat(ProgressEmailSchema) },
    });
    if (res.stop_reason === "refusal") throw new Error("The drafter declined this email");
    if (!res.parsed_output) throw new Error(`The drafter returned nothing usable (stop_reason=${res.stop_reason})`);
    return res.parsed_output;
  };
}

/** Numbers and dates in a draft that never appear in the source notes: a reviewer should look. */
export function unsupportedNumbers(job: Pick<ParsedJob, "intro" | "progress" | "upcoming">, source: string): string[] {
  const seen = new Set([...source.replace(/,/g, "").matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]));
  const out = new Set<string>();
  for (const t of [job.intro, ...job.progress, ...job.upcoming]) for (const m of t.replace(/,/g, "").matchAll(/\d+(?:\.\d+)?/g)) if (!seen.has(m[0])) out.add(m[0]);
  return [...out];
}

// ---- address matching ----

export interface JobRef { id: string; name: string; address: string | null }
export type AddressMatch = { job: JobRef } | { ambiguous: string[] } | null;

/** "157 Sea Marsh Rd" finds the job whose address or name starts the same: house number plus first street word. */
export function matchJobByAddress(address: string, jobs: JobRef[]): AddressMatch {
  const m = /^\s*(\d+)\s+(\S+)/.exec(normName(address));
  if (!m) return null;
  const re = new RegExp(`(^| )${m[1]} ${m[2].replace(/[^a-z0-9]/g, "")}`);
  const hits = jobs.filter((j) => re.test(normName(`${j.address ?? ""} ${j.name}`)) || re.test(normName(j.name)));
  if (hits.length === 1) return { job: hits[0] };
  if (hits.length > 1) {
    // Prefer a job whose street address (not just its name) carries the match.
    const byAddress = hits.filter((j) => j.address && re.test(normName(j.address)));
    if (byAddress.length === 1) return { job: byAddress[0] };
    return { ambiguous: hits.map((h) => h.name) };
  }
  return null;
}

// ---- offline demo parser: crude, used only without Claude credentials ----

const SUFFIX = "St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Cir|Circle|Way|Pl|Place|Ter|Terrace|Pkwy|Parkway|Trl|Trail";
const ADDRESS_LINE = new RegExp(`^\\s*(?:[-*\\u2022]\\s*)?(\\d{1,6}\\s+[A-Za-z0-9.' ]+?\\b(?:${SUFFIX})\\b\\.?)\\s*(?:[-:,\\u2013\\u2014]\\s*(.*))?$`, "i");
const UPCOMING = /^(?:next|upcoming|coming up|planned|plan to|will|scheduled|starting|to do|going forward)\b|\bnext week\b|\bnext up\b/i;
const SKIP = /\b(?:skip|don'?t send|no update)\s+(?:the\s+)?([A-Za-z0-9 .']+?)(?:\s+(?:this week|for now|today))?(?:[.,;]|$)|\balready sent to\s+([A-Za-z]+)/gi;

export function offlineEmailParser(): EmailParser {
  return async ({ text }) => {
    const lines = text.split(/\r?\n/);
    const hints: { hint: string; reason: string }[] = [];
    for (const m of text.matchAll(SKIP)) hints.push({ hint: (m[1] ?? m[2] ?? "").trim().toLowerCase(), reason: m[0].trim().replace(/[.,;]+$/, "") });
    const jobs: ParsedJob[] = [];
    let cur: { address: string; client: string | null; lines: string[] } | null = null;
    const flush = () => {
      if (!cur) return;
      const items = cur.lines
        .flatMap((l) => l.split(/(?<=[.!])\s+/)) // several sentences on one line
        .map((l) => l.replace(/^\s*[-*\u2022]\s*/, "").trim())
        .filter(Boolean);
      const progress: string[] = [], upcoming: string[] = [];
      for (const raw of items) {
        const isNext = UPCOMING.test(raw);
        const t = raw.replace(/^(?:next(?: week)?|upcoming|planned|coming up)\s*[:\-]\s*/i, "").trim();
        (isNext ? upcoming : progress).push(t.charAt(0).toUpperCase() + t.slice(1));
      }
      const addr = normName(cur.address);
      const hit = hints.find((h) => h.hint && (addr.includes(normName(h.hint)) || normName(h.hint).split(" ").some((w) => w.length > 3 && addr.includes(w))));
      jobs.push({ address: cur.address, client_name: cur.client, skip: Boolean(hit), skip_reason: hit?.reason ?? null,
        intro: progress.length ? "Here is where things stand on your project this week." : "Here is a quick update on your project.", progress, upcoming, held_back: [] });
      cur = null;
    };
    for (const line of lines) {
      if (/^\s*(?:thanks|thank you|regards|best|sincerely|cheers)\b/i.test(line)) { flush(); continue; } // sign off ends the last job
      const a = ADDRESS_LINE.exec(line);
      if (a) {
        flush();
        // After the address often comes "- client name - job type". A short bit with no verbs is that, not a note.
        const rest = (a[2] ?? "").trim();
        const first = rest.split(/\s+[-\u2013\u2014]\s+/)[0] ?? "";
        const isName = rest && first.split(/\s+/).length <= 3 && !/[.:;]/.test(first);
        cur = { address: a[1].trim().replace(/[.,]$/, ""), client: isName ? first : null, lines: rest && !isName ? [rest] : [] };
      } else if (cur) cur.lines.push(line);
    }
    flush();
    return { jobs };
  };
}
