import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuoWebhook, verifyQuoSignature } from "../src/connectors/quo";
import { callObject, quoEvent, sign, SIGNING_KEY } from "./helpers";

test("accepts a valid signature", () => {
  const body = quoEvent("call.completed", callObject());
  assert.equal(verifyQuoSignature(Buffer.from(body), sign(body), [SIGNING_KEY]), true);
});

test("accepts when any one of several webhook keys matches", () => {
  const body = quoEvent("call.completed", callObject());
  const other = Buffer.from("other").toString("base64");
  assert.equal(verifyQuoSignature(Buffer.from(body), sign(body), [other, SIGNING_KEY]), true);
});

test("rejects tampered body, wrong key, stale or malformed header", () => {
  const body = quoEvent("call.completed", callObject());
  const header = sign(body);
  assert.equal(verifyQuoSignature(Buffer.from(body + " "), header, [SIGNING_KEY]), false);
  assert.equal(verifyQuoSignature(Buffer.from(body), header, [Buffer.from("nope").toString("base64")]), false);
  assert.equal(verifyQuoSignature(Buffer.from(body), sign(body, SIGNING_KEY, Date.now() - 2 * 3600_000), [SIGNING_KEY]), false);
  assert.equal(verifyQuoSignature(Buffer.from(body), "garbage", [SIGNING_KEY]), false);
  assert.equal(verifyQuoSignature(Buffer.from(body), undefined, [SIGNING_KEY]), false);
});

test("normalizes call.completed: AI answered, person answered, missed", () => {
  const ai = parseQuoWebhook(Buffer.from(quoEvent("call.completed", callObject())));
  assert.equal(ai.kind, "call_completed");
  if (ai.kind !== "call_completed") return;
  assert.equal(ai.call.answeredBy, "ai_agent");
  assert.equal(ai.call.from, "+19045551234");
  assert.equal(ai.call.durationSec, 90);

  const person = parseQuoWebhook(Buffer.from(quoEvent("call.completed", callObject({ userId: "US1" }))));
  assert.equal(person.kind === "call_completed" && person.call.answeredBy, "person");

  const missed = parseQuoWebhook(
    Buffer.from(
      quoEvent("call.completed", callObject({ status: "missed", answeredAt: null, voicemail: { url: "https://x/vm.mp3", duration: 20, transcript: "Hi it's Bob" } })),
    ),
  );
  assert.equal(missed.kind === "call_completed" && missed.call.answeredBy, "missed");
  assert.equal(missed.kind === "call_completed" && missed.call.voicemail?.transcript, "Hi it's Bob");
});

test("normalizes transcript, summary, and message events", () => {
  const t = parseQuoWebhook(
    Buffer.from(quoEvent("call.transcript.completed", { callId: "AC1", dialogue: [{ content: "Hello", start: 0, end: 1, identifier: "+19045551234", userId: null }] })),
  );
  assert.deepEqual(t.kind === "call_transcript" && t.transcript, [{ identifier: "+19045551234", userId: null, text: "Hello", start: 0 }]);

  const s = parseQuoWebhook(Buffer.from(quoEvent("call.summary.completed", { callId: "AC1", summary: ["a"], nextSteps: ["b"] })));
  assert.deepEqual(s.kind === "call_summary" && [s.summary, s.nextSteps], [["a"], ["b"]]);

  const m = parseQuoWebhook(Buffer.from(quoEvent("message.received", { id: "AC9", from: "9045551234", to: ["+19047171729"], text: "need tile", direction: "incoming" })));
  assert.equal(m.kind === "message_received" && m.message.from, "+19045551234");

  assert.equal(parseQuoWebhook(Buffer.from(quoEvent("contact.updated", {}))).kind, "ignored");
});
