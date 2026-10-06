import assert from "node:assert/strict";
import { test } from "node:test";
import { offlineClassifier } from "../src/ai/offline";
import { SCENARIOS } from "../src/sim/scenarios";

const classify = offlineClassifier();
const run = (id: string) => {
  const s = SCENARIOS.find((x) => x.id === id)!;
  return classify({
    companyName: "Test Co",
    callerPhone: s.from,
    knownContact: null,
    answeredBy: s.answeredBy,
    transcript: s.lines.map((l) => ({ identifier: l.who === "caller" ? s.from : null, userId: null, text: l.text, start: 0 })),
    summary: null,
    voicemailTranscript: s.voicemail ?? null,
  });
};

test("each demo scenario lands on its expected type", async () => {
  const expected: Record<string, string> = {
    lead_bathroom: "lead",
    lead_roof_voicemail: "lead",
    sub_lien_waiver: "sub_vendor",
    solicitor_seo: "solicitor",
    client_change_order: "existing_client",
    unclear: "unknown",
  };
  for (const [id, type] of Object.entries(expected)) assert.equal((await run(id)).caller_type, type, id);
});

test("lead details are pulled out", async () => {
  const c = await run("lead_bathroom");
  assert.equal(c.caller_name, "Jane Smith");
  assert.equal(c.job_address, "4410 Riverside Ave");
  assert.equal(c.timeline, "next spring");
  assert.equal(c.job_type, "bathroom");
  assert.ok(c.confidence >= 0.7);
});

test("urgent roof leak is flagged", async () => {
  assert.equal((await run("lead_roof_voicemail")).urgency, "urgent");
});
