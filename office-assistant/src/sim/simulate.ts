import type { NormalizedCall, NormalizedEvent } from "../connectors/types";
import { db } from "../lib/db";
import { enqueue } from "../lib/queue";
import { ingestEvent, PROCESS_CALL } from "../pipeline/ingest";
import type { Scenario } from "./scenarios";

let counter = 0;

/** Feeds a scenario through the same ingest path real webhooks use. Returns the call id. */
export async function simulateCall(tenantId: string, scenario: Scenario, toNumber = "+15555550100"): Promise<string> {
  const callId = `SIM${Date.now()}${++counter}`;
  const now = new Date().toISOString();
  const missed = scenario.answeredBy === "missed";
  const call: NormalizedCall = {
    providerId: callId,
    conversationId: `SIMCN${callId}`,
    phoneNumberId: "SIMLINE",
    direction: "incoming",
    from: scenario.from,
    to: toNumber,
    status: missed ? "missed" : "completed",
    startedAt: now,
    durationSec: missed ? 0 : 60,
    answeredBy: scenario.answeredBy,
    voicemail: scenario.voicemail ? { url: null, durationSec: 20, transcript: scenario.voicemail } : null,
  };
  const completed: NormalizedEvent = { kind: "call_completed", eventId: `${callId}:completed`, type: "call.completed", call };
  await ingestEvent(tenantId, "mock", completed, { simulated: true, callId });

  if (scenario.lines.length) {
    const transcript: NormalizedEvent = {
      kind: "call_transcript",
      eventId: `${callId}:transcript`,
      type: "call.transcript.completed",
      callId,
      transcript: scenario.lines.map((l, i) => ({
        identifier: l.who === "caller" ? scenario.from : null,
        userId: null,
        text: l.text,
        start: i * 5,
      })),
    };
    await ingestEvent(tenantId, "mock", transcript, { simulated: true, callId });
  }

  // Demos should not wait out the real world transcript delay.
  const { rows } = await db().query<{ id: string }>("SELECT id FROM interactions WHERE provider = 'mock' AND provider_id = $1", [callId]);
  if (rows[0]) await enqueue(PROCESS_CALL, { interactionId: rows[0].id }, { dedupeKey: `call:${rows[0].id}` });
  return callId;
}
