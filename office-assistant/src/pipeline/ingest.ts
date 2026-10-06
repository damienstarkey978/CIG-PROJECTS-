import type { PoolClient } from "pg";
import { config } from "../config";
import type { NormalizedCall, NormalizedEvent } from "../connectors/types";
import { withTx } from "../lib/db";
import { enqueue } from "../lib/queue";

export const PROCESS_CALL = "process_call";
export const FETCH_CALL = "fetch_call";
export const PROCESS_SMS = "process_sms";

export async function upsertCall(c: PoolClient, tenantId: string, provider: string, call: NormalizedCall): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO interactions (tenant_id, channel, direction, handled_by, provider, provider_id,
       provider_conversation_id, provider_phone_number_id, from_phone, to_phone, status, started_at, duration_sec, voicemail)
     VALUES ($1,'call',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (provider, provider_id) DO UPDATE SET
       direction = EXCLUDED.direction, handled_by = EXCLUDED.handled_by,
       provider_conversation_id = EXCLUDED.provider_conversation_id,
       provider_phone_number_id = EXCLUDED.provider_phone_number_id,
       from_phone = EXCLUDED.from_phone, to_phone = EXCLUDED.to_phone, status = EXCLUDED.status,
       started_at = EXCLUDED.started_at, duration_sec = EXCLUDED.duration_sec,
       voicemail = COALESCE(EXCLUDED.voicemail, interactions.voicemail)
     RETURNING id`,
    [
      tenantId,
      call.direction,
      call.answeredBy,
      provider,
      call.providerId,
      call.conversationId,
      call.phoneNumberId,
      call.from,
      call.to,
      call.status,
      call.startedAt,
      call.durationSec,
      call.voicemail ? JSON.stringify(call.voicemail) : null,
    ],
  );
  return rows[0].id;
}

/**
 * Records one webhook event and the state change it causes, in one transaction.
 * Returns false when the event was already seen (provider retry).
 */
export async function ingestEvent(
  tenantId: string,
  provider: string,
  evt: NormalizedEvent,
  rawPayload: unknown,
  now = new Date(),
): Promise<boolean> {
  return withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO webhook_events (provider, event_id, tenant_id, type, payload)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider, event_id) DO NOTHING`,
      [provider, evt.eventId, tenantId, evt.type, JSON.stringify(rawPayload)],
    );
    if (ins.rowCount === 0) return false;

    switch (evt.kind) {
      case "call_completed": {
        const id = await upsertCall(c, tenantId, provider, evt.call);
        if (evt.call.direction === "incoming") {
          // Missed with nothing to wait for: go now. Otherwise give transcripts a head start.
          const nothingComing = evt.call.answeredBy === "missed" && !evt.call.voicemail;
          const runAt = new Date(now.getTime() + (nothingComing ? 0 : config.firstLookDelayMs));
          await enqueue(PROCESS_CALL, { interactionId: id }, { runAt, dedupeKey: `call:${id}` }, c);
        }
        break;
      }
      case "call_transcript":
      case "call_summary": {
        const upd =
          evt.kind === "call_transcript"
            ? await c.query(
                "UPDATE interactions SET transcript = $3 WHERE provider = $1 AND provider_id = $2 RETURNING id, direction",
                [provider, evt.callId, JSON.stringify(evt.transcript)],
              )
            : await c.query(
                "UPDATE interactions SET summary = $3, next_steps = $4 WHERE provider = $1 AND provider_id = $2 RETURNING id, direction",
                [provider, evt.callId, evt.summary, evt.nextSteps],
              );
        if (upd.rowCount === 0) {
          // Arrived before call.completed (or that event was lost): fetch the call ourselves.
          await enqueue(FETCH_CALL, { tenantId, callId: evt.callId }, { dedupeKey: `fetch:${evt.callId}` }, c);
        } else if (upd.rows[0].direction === "incoming") {
          await enqueue(PROCESS_CALL, { interactionId: upd.rows[0].id }, { runAt: now, dedupeKey: `call:${upd.rows[0].id}` }, c);
        }
        break;
      }
      case "message_received": {
        const m = evt.message;
        const ins = await c.query<{ id: string }>(
          `INSERT INTO interactions (tenant_id, channel, direction, provider, provider_id, provider_conversation_id,
             provider_phone_number_id, from_phone, to_phone, body, started_at, media)
           VALUES ($1,'sms',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (provider, provider_id) DO NOTHING RETURNING id`,
          [tenantId, m.direction, provider, m.providerId, m.conversationId, m.phoneNumberId, m.from, m.to, m.body, m.createdAt, m.media?.length ? JSON.stringify(m.media) : null],
        );
        // Incoming texts are read by the sub text handler; ones we sent ourselves just get logged.
        if (ins.rows[0] && m.direction === "incoming") await enqueue(PROCESS_SMS, { interactionId: ins.rows[0].id }, { dedupeKey: `sms:${ins.rows[0].id}` }, c);
        else if (ins.rows[0]) await c.query("UPDATE interactions SET processed_at = now() WHERE id = $1", [ins.rows[0].id]);
        break;
      }
      case "ignored":
        break;
    }
    return true;
  });
}
