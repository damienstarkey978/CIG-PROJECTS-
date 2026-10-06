import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config";
import type { TranscriptLine } from "../connectors/types";

// Bump when the prompt or schema changes; stored on each interaction so evals
// and production results can be compared by version.
export const CLASSIFIER_VERSION = "call-v1";

export const CALLER_TYPES = ["lead", "sub_vendor", "existing_client", "solicitor", "unknown"] as const;
export type CallerType = (typeof CALLER_TYPES)[number];

export const ClassificationSchema = z.object({
  caller_type: z.enum(CALLER_TYPES),
  confidence: z.number().describe("0 to 1, how sure you are about caller_type"),
  reasoning: z.string().describe("One sentence on what in the call decided caller_type"),
  caller_name: z.string().nullable(),
  company: z.string().nullable(),
  job_type: z.string().nullable().describe("Kind of work, e.g. kitchen remodel, roof repair, addition"),
  job_address: z.string().nullable(),
  timeline: z.string().nullable().describe("When they want the work, in their words"),
  budget_hint: z.string().nullable(),
  job_reference: z.string().nullable().describe("Existing job, address, or client name the caller referred to"),
  urgency: z.enum(["low", "normal", "urgent"]),
  callback_requested: z.boolean(),
  office_summary: z.string().describe("Two sentences max for the office: who, what they need, what to do next"),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export interface CallContext {
  companyName: string;
  callerPhone: string | null;
  knownContact: { type: string; name: string | null; company: string | null } | null;
  answeredBy: "person" | "ai_agent" | "missed";
  transcript: TranscriptLine[] | null;
  summary: string[] | null;
  voicemailTranscript: string | null;
}

export type Classifier = (ctx: CallContext) => Promise<Classification>;

const SYSTEM = `You review phone calls for the office of a small general contracting and remodeling company and sort each caller so the office knows what to do.

Caller types:
- lead: a homeowner or property owner asking about new work (estimates, quotes, remodels, repairs, additions). Referrals count.
- sub_vendor: a subcontractor, supplier, inspector, or other trade partner calling about scheduling, materials, invoices, paperwork (COIs, W9s, lien waivers), or an existing job.
- existing_client: someone whose job the company is already doing or finished, calling about that job (progress, questions, draws, warranty).
- solicitor: anyone selling to the company: marketing, SEO, lead generation, financing, insurance offers, software, robocalls.
- unknown: not enough information, wrong numbers, silence, or genuinely ambiguous.

Construction context: "draw" is a scheduled progress payment, "CO" or "change order" is extra scope on an existing job, "punch list" is final fix items, "COI" is a certificate of insurance. A sub talking about a job is sub_vendor even if they also mention money. A vendor offering to sell a new service is a solicitor, but a supplier following up on an order is sub_vendor.

Set confidence honestly. Use below 0.6 when the call is short, garbled, or could reasonably be two types. Only extract details that were actually said; use null otherwise. The office summary is read on a phone between job sites, so keep it plain and short.`;

function speakerLabel(line: TranscriptLine, callerPhone: string | null): string {
  if (callerPhone && line.identifier === callerPhone) return "Caller";
  if (line.userId) return "Office";
  return line.identifier ? "Caller" : "Agent";
}

export function renderCallForModel(ctx: CallContext): string {
  const parts: string[] = [];
  parts.push(`Company: ${ctx.companyName}`);
  parts.push(`Caller number: ${ctx.callerPhone ?? "unknown"}`);
  parts.push(
    `Answered by: ${{ person: "a person in the office", ai_agent: "the AI phone agent", missed: "nobody (missed call)" }[ctx.answeredBy]}`,
  );
  if (ctx.knownContact) {
    const k = ctx.knownContact;
    parts.push(`This number is already on file as: ${k.type}${k.name ? `, ${k.name}` : ""}${k.company ? ` (${k.company})` : ""}`);
  }
  if (ctx.transcript?.length) {
    parts.push("Transcript:");
    for (const l of ctx.transcript) parts.push(`${speakerLabel(l, ctx.callerPhone)}: ${l.text}`);
  }
  if (ctx.voicemailTranscript) parts.push(`Voicemail transcript:\n${ctx.voicemailTranscript}`);
  if (ctx.summary?.length && !ctx.transcript?.length) parts.push(`Phone system summary:\n${ctx.summary.join("\n")}`);
  return parts.join("\n");
}

export function claudeClassifier(client = new Anthropic()): Classifier {
  return async (ctx) => {
    const res = await client.beta.messages.parse({
      model: config.classifierModel,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: renderCallForModel(ctx) }],
      output_config: { effort: config.classifierEffort, format: betaZodOutputFormat(ClassificationSchema) },
    });
    if (res.stop_reason === "refusal") throw new Error("Classifier declined the call content");
    const out = res.parsed_output;
    if (!out) throw new Error(`Classifier returned no parsed output (stop_reason=${res.stop_reason})`);
    return { ...out, confidence: Math.min(1, Math.max(0, out.confidence)) };
  };
}
