// Scores the classifier against labeled calls. Each run makes one Claude call per
// labeled row, so it costs money: pass --yes to run.
//   npm run eval:run -- --yes [--file data/eval/calls.jsonl]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CALLER_TYPES, CLASSIFIER_VERSION, claudeClassifier, type CallerType } from "../src/ai/classify";
import { config } from "../src/config";
import { decideRoute } from "../src/pipeline/route";

export interface EvalRow {
  id: string;
  label: CallerType | null;
  callerPhone: string | null;
  answeredBy: "person" | "ai_agent" | "missed";
  knownContact: { type: string; name: string | null; company: string | null } | null;
  transcript: any[] | null;
  summary: string[] | null;
  voicemailTranscript: string | null;
}

export function score(results: { label: CallerType; routed: CallerType }[]) {
  const confusion: Record<string, Record<string, number>> = {};
  for (const t of CALLER_TYPES) confusion[t] = Object.fromEntries(CALLER_TYPES.map((p) => [p, 0]));
  for (const r of results) confusion[r.label][r.routed]++;
  const correct = results.filter((r) => r.label === r.routed).length;
  // A real lead brushed off as a solicitor is the costliest mistake; track it on its own.
  const leadsLostToSolicitor = confusion.lead.solicitor;
  const perClass = Object.fromEntries(
    CALLER_TYPES.map((t) => {
      const tp = confusion[t][t];
      const actual = CALLER_TYPES.reduce((s, p) => s + confusion[t][p], 0);
      const predicted = CALLER_TYPES.reduce((s, l) => s + confusion[l][t], 0);
      return [t, { recall: actual ? tp / actual : null, precision: predicted ? tp / predicted : null, n: actual }];
    }),
  );
  return { n: results.length, accuracy: results.length ? correct / results.length : null, leadsLostToSolicitor, perClass, confusion };
}

async function main() {
  const { values } = parseArgs({
    options: { yes: { type: "boolean", default: false }, file: { type: "string" }, threshold: { type: "string", default: "0.7" } },
  });
  const file = path.resolve(values.file ?? path.join(__dirname, "../data/eval/calls.jsonl"));
  const rows: EvalRow[] = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const labeled = rows.filter((r) => r.label && (CALLER_TYPES as readonly string[]).includes(r.label));
  console.log(`${labeled.length} labeled of ${rows.length} rows; model ${config.classifierModel}, effort ${config.classifierEffort}`);
  if (!values.yes) return console.log("Dry run. Pass --yes to call the model.");

  const classify = claudeClassifier();
  const threshold = Number(values.threshold);
  const results = [];
  for (const r of labeled) {
    const c = await classify({
      companyName: process.env.EVAL_COMPANY_NAME ?? "the company",
      callerPhone: r.callerPhone,
      knownContact: r.knownContact,
      answeredBy: r.answeredBy,
      transcript: r.transcript,
      summary: r.summary,
      voicemailTranscript: r.voicemailTranscript,
    });
    const routed = decideRoute({ classification: c, knownContactType: (r.knownContact?.type as any) ?? null, confidenceThreshold: threshold }).callerType;
    results.push({ id: r.id, label: r.label as CallerType, model: c.caller_type, confidence: c.confidence, routed, reasoning: c.reasoning });
    process.stdout.write(r.label === routed ? "." : "x");
  }
  const summary = score(results);
  console.log("\n" + JSON.stringify({ ...summary, confusion: undefined }, null, 2));
  console.table(summary.confusion);
  const outFile = path.join(path.dirname(file), `results-${CLASSIFIER_VERSION}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ version: CLASSIFIER_VERSION, model: config.classifierModel, threshold, summary, results }, null, 2));
  console.log(`Details: ${outFile}`);
}

if (require.main === module) main();
