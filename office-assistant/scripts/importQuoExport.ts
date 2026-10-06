// Converts a Quo transcript export (JSON with named speakers) into data/eval/calls.jsonl.
// Existing labels in that file are kept. Calls from numbers already on file in the
// tenant are tagged with the contact's type, as they would be in production.
//   npm run eval:import-export -- --file path/to/quo-call-transcripts.json [--slug wci]
// Customer data: data/ is gitignored, keep it that way.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { closeDb, db } from "../src/lib/db";
import { getTenantBySlug } from "../src/tenants";

const EVAL_FILE = path.resolve(__dirname, "../data/eval/calls.jsonl");

interface ExportCall {
  id: string;
  type: "live_call" | "voicemail";
  direction: "incoming" | "outgoing";
  participant: string;
  summary?: string;
  dialogue?: { t: number; speaker: string; text: string }[];
  transcriptText?: string;
}

/** The AI agent is "Sona"; any other non caller speaker is a person in the office. */
export function toEvalRow(c: ExportCall, known: { type: string; name: string | null; company: string | null } | null, prevLabel: string | null) {
  const speakers = new Set((c.dialogue ?? []).map((d) => d.speaker));
  const answeredBy = c.type === "voicemail" ? "missed" : speakers.has("Sona") ? "ai_agent" : "person";
  return {
    id: c.id,
    label: prevLabel,
    note: c.summary ?? null,
    callerPhone: c.participant,
    answeredBy,
    knownContact: known,
    transcript: c.dialogue?.length
      ? c.dialogue.map((d) => ({
          identifier: d.speaker === "Caller" ? c.participant : null,
          userId: d.speaker !== "Caller" && d.speaker !== "Sona" ? "staff" : null,
          text: d.text,
          start: d.t,
        }))
      : null,
    summary: null,
    voicemailTranscript: c.transcriptText ?? null,
  };
}

async function main() {
  const { values } = parseArgs({ options: { file: { type: "string" }, slug: { type: "string" } } });
  if (!values.file) throw new Error("--file is required");
  const data = JSON.parse(fs.readFileSync(values.file, "utf8")) as { transcripts: ExportCall[] };
  const tenant = values.slug ? await getTenantBySlug(values.slug) : null;

  const existing = new Map<string, any>();
  if (fs.existsSync(EVAL_FILE)) for (const l of fs.readFileSync(EVAL_FILE, "utf8").split("\n").filter(Boolean)) existing.set(JSON.parse(l).id, JSON.parse(l));

  const rows = [];
  let skippedOutgoing = 0;
  for (const c of data.transcripts) {
    if (c.direction !== "incoming") { skippedOutgoing++; continue; }
    let known = null;
    if (tenant) {
      const r = await db().query(
        `SELECT c.type, NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS name, c.company FROM contact_phones p JOIN contacts c ON c.id = p.contact_id WHERE p.tenant_id = $1 AND p.phone = $2`,
        [tenant.id, c.participant],
      );
      known = r.rows[0] ?? null;
    }
    rows.push(toEvalRow(c, known, existing.get(c.id)?.label ?? null));
  }
  fs.mkdirSync(path.dirname(EVAL_FILE), { recursive: true });
  fs.writeFileSync(EVAL_FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`Wrote ${rows.length} incoming calls to ${EVAL_FILE} (${skippedOutgoing} outgoing skipped, ${rows.filter((r) => r.knownContact).length} callers already on file, ${rows.filter((r) => r.label).length} labeled)`);
}

if (require.main === module) main().finally(closeDb);
