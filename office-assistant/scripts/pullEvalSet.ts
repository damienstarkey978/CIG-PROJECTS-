// Exports incoming calls with content to data/eval/calls.jsonl for labeling.
// Fill each row's "label" with one of: lead, sub_vendor, existing_client, solicitor, unknown.
// Existing labels in the file are kept. Call content is customer data: data/ is gitignored, keep it that way.
//   npm run eval:pull -- --slug wci
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { closeDb, db } from "../src/lib/db";
import { getTenantBySlug } from "../src/tenants";

export const EVAL_FILE = path.resolve(__dirname, "../data/eval/calls.jsonl");

async function main() {
  const { values } = parseArgs({ options: { slug: { type: "string" } } });
  const tenant = values.slug ? await getTenantBySlug(values.slug) : null;
  if (!tenant) throw new Error("Unknown --slug");

  const existing = new Map<string, any>();
  if (fs.existsSync(EVAL_FILE)) {
    for (const line of fs.readFileSync(EVAL_FILE, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line);
      existing.set(r.id, r);
    }
  }

  const { rows } = await db().query(
    `SELECT i.id, i.from_phone, i.handled_by, i.transcript, i.summary, i.voicemail->>'transcript' AS voicemail_transcript,
            i.caller_type AS predicted, c.type AS contact_type, c.first_name, c.last_name, c.company
     FROM interactions i LEFT JOIN contacts c ON c.id = i.contact_id
     WHERE i.tenant_id = $1 AND i.channel = 'call' AND i.direction = 'incoming'
       AND (jsonb_array_length(COALESCE(i.transcript, '[]'::jsonb)) > 0 OR i.voicemail->>'transcript' IS NOT NULL)
     ORDER BY i.created_at`,
    [tenant.id],
  );

  fs.mkdirSync(path.dirname(EVAL_FILE), { recursive: true });
  const out = rows.map((r) =>
    JSON.stringify({
      id: r.id,
      label: existing.get(r.id)?.label ?? null,
      predicted_in_prod: r.predicted,
      callerPhone: r.from_phone,
      answeredBy: r.handled_by ?? "missed",
      knownContact: r.contact_type ? { type: r.contact_type, name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null, company: r.company } : null,
      transcript: r.transcript,
      summary: r.summary,
      voicemailTranscript: r.voicemail_transcript,
    }),
  );
  fs.writeFileSync(EVAL_FILE, out.join("\n") + "\n");
  const labeled = rows.filter((r) => existing.get(r.id)?.label).length;
  console.log(`Wrote ${rows.length} calls to ${EVAL_FILE} (${labeled} already labeled)`);
}

main().finally(closeDb);
