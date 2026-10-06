import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config";

// Drafts a change order from a plain description of extra work. The hard rule, in the prompt
// and in the code: never invent a price, quantity, or date. Anything not stated is left empty
// and listed under `questions` for a person to fill in. A person always reviews and sends it.

export const DraftSchema = z.object({
  title: z.string().describe("Short title, 3 to 8 words, e.g. Add recessed lights in kitchen"),
  description: z.string().describe("Client facing description of the extra work in 1 to 4 plain sentences"),
  items: z.array(z.object({
    description: z.string(),
    quantity: z.number().nullable().describe("Only if stated"),
    unit: z.string().nullable().describe("Only if stated, e.g. each, sq ft"),
    unit_price: z.number().nullable().describe("Only if a price per unit was stated"),
  })),
  amount: z.number().nullable().describe("Total price, only if one was stated or can be added up from stated prices"),
  schedule_days: z.number().int().nullable().describe("Extra days added to the schedule, only if stated"),
  questions: z.array(z.string()).describe("Things a person must supply before this can go to the client, such as a missing price"),
});
export type Draft = z.infer<typeof DraftSchema>;

export interface DraftInput {
  text: string;
  companyName: string;
  jobName: string;
  address: string | null;
}

export type Drafter = (input: DraftInput) => Promise<Draft>;

export interface CoItem { description: string; quantity: number | null; unit: string | null; unitPrice: number | null }

export const toItems = (d: Draft): CoItem[] => d.items.map((i) => ({ description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unit_price }));

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The price to show: the stated total, else the sum of fully priced items, else nothing (a person decides). */
export function changeOrderTotal(items: CoItem[], amount: number | null): number | null {
  if (amount !== null && amount !== undefined) return r2(amount);
  if (!items.length || items.some((i) => i.unitPrice === null || i.unitPrice === undefined)) return null;
  return r2(items.reduce((n, i) => n + (i.quantity ?? 1) * (i.unitPrice as number), 0));
}

const SYSTEM = `You write change orders for a small residential general contracting and remodeling company. Someone from the office or the field describes extra or changed work; you turn it into a clear change order that a person will review before it goes to the client.

Rules:
- Never invent a price, quantity, unit, or date. Use only numbers that appear in what you were given. If a price is missing, leave it null and add a question such as "What is the price?".
- If several prices are given, put each on its own item and the total in amount only if the total is stated or every item is priced.
- The description is for the client: plain, specific, polite, no legal language, no mention of markup or overhead unless the person said so. Describe only the work that was mentioned.
- Keep the title short. Put the job address or name nowhere in the title.
- If the request is vague about what the work is, or which part of the house, add a question.
- If the text is not a change order request at all, return an empty items list and a question saying so.`;

export function claudeDrafter(client = new Anthropic()): Drafter {
  return async (input) => {
    const res = await client.beta.messages.parse({
      model: config.classifierModel,
      max_tokens: 3000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: `Company: ${input.companyName}\nJob: ${input.jobName}${input.address ? ` (${input.address})` : ""}\n\nDescription of the extra work:\n${input.text}` }],
      output_config: { effort: "medium", format: betaZodOutputFormat(DraftSchema) },
    });
    if (res.stop_reason === "refusal") throw new Error("The drafter declined this request");
    if (!res.parsed_output) throw new Error(`The drafter returned nothing usable (stop_reason=${res.stop_reason})`);
    return enforceNoInvention(res.parsed_output, input.text);
  };
}

/** Belt and braces: drop any number the model reported that does not appear in the source text. */
export function enforceNoInvention(d: Draft, source: string): Draft {
  const nums = new Set([...source.replace(/,/g, "").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])));
  const spoken = (n: number | null) => n === null || nums.has(n);
  const items = d.items.map((i) => ({ ...i, quantity: spoken(i.quantity) ? i.quantity : null, unit_price: spoken(i.unit_price) ? i.unit_price : null }));
  const sumOfItems = items.length && items.every((i) => i.unit_price !== null) ? r2(items.reduce((n, i) => n + (i.quantity ?? 1) * (i.unit_price as number), 0)) : null;
  const amountOk = d.amount === null || nums.has(d.amount) || (sumOfItems !== null && sumOfItems === r2(d.amount));
  const questions = [...d.questions];
  const amount = amountOk ? d.amount : null;
  if (!amountOk && !questions.some((q) => /price|cost|amount/i.test(q))) questions.push("What is the total price?");
  return { ...d, items, amount, schedule_days: spoken(d.schedule_days) ? d.schedule_days : null, questions };
}

// ---- offline demo drafter: crude, used only when there are no Claude credentials ----

export function offlineDrafter(): Drafter {
  return async (input) => {
    const text = input.text.trim().replace(/\s+/g, " ");
    const prices = [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
    const days = /(\d+)\s*(?:extra\s+|additional\s+)?days?/i.exec(text);
    const clean = text
      .replace(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g, "")
      .replace(/[,;]?\s*(?:adds?\s+|plus\s+)?\d+\s*(?:extra\s+|additional\s+)?days?\b/i, "") // the schedule note is not a work item
      .replace(/[,;]\s*(?=[,;]|$)/g, "")
      .replace(/\b(?:for|at|plus|add)\s*$/i, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    const parts = clean.split(/\s*(?:,|;|\band\b)\s*/i).map((p) => p.trim()).filter((p) => p.length > 3);
    const first = (parts[0] ?? clean).replace(/^(?:co|change order)[:\s]*/i, "");
    const title = first.charAt(0).toUpperCase() + first.slice(1, 60);
    const items = parts.map((p, i) => ({ description: p.charAt(0).toUpperCase() + p.slice(1), quantity: null, unit: null, unit_price: parts.length === prices.length ? prices[i] : null }));
    const amount = prices.length ? r2(prices.reduce((a, b) => a + b, 0)) : null;
    const questions: string[] = [];
    if (amount === null) questions.push("What is the price?");
    return { title: title || "Change order", description: `Additional work requested: ${clean}.`, items, amount, schedule_days: days ? Number(days[1]) : null, questions };
  };
}
