import crypto from "node:crypto";
import { config } from "../config";
import { toE164 } from "../lib/phone";
import type {
  AnsweredBy,
  NormalizedCall,
  NormalizedEvent,
  TelephonyProvider,
  TranscriptLine,
} from "./types";

// Quo (formerly OpenPhone). Webhook and REST shapes follow the OpenPhone v1 API.
// Field names marked VERIFY are inferred and should be checked against the first
// real payloads captured in webhook_events.

export interface QuoSecrets {
  apiKey: string;
  // Quo issues one signing key per webhook (calls, transcripts, summaries, messages).
  signingKeys: string[];
}

const SIGNATURE_HEADERS = ["openphone-signature", "quo-signature"];
const MAX_SIGNATURE_AGE_MS = 60 * 60_000;

/**
 * Header format: "hmac;1;<timestamp ms>;<base64 digest>".
 * Digest = HMAC-SHA256(key = base64 decoded signing key, data = "<timestamp>.<raw body>").
 */
export function verifyQuoSignature(
  rawBody: Buffer,
  header: string | undefined,
  signingKeys: string[],
  now = Date.now(),
): boolean {
  if (!header) return false;
  const [scheme, version, timestamp, digest] = header.split(";");
  if (scheme !== "hmac" || version !== "1" || !timestamp || !digest) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SIGNATURE_AGE_MS) return false;
  const provided = Buffer.from(digest, "base64");
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]);
  return signingKeys.some((k) => {
    const expected = crypto.createHmac("sha256", Buffer.from(k, "base64")).update(signed).digest();
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  });
}

const MISSED_STATUSES = new Set(["missed", "no-answer", "abandoned", "busy", "failed", "canceled"]);

function answeredBy(o: any): AnsweredBy {
  if (MISSED_STATUSES.has(o.status) || !o.answeredAt) return "missed";
  // VERIFY: Sona handled calls are assumed to be answered with no teammate userId,
  // or flagged with an aiHandled/answeredBy field.
  if (o.aiHandled === true || o.answeredBy === "ai" || o.answeredBy === "sona") return "ai_agent";
  return o.userId ? "person" : "ai_agent";
}

function durationSec(o: any): number | null {
  if (typeof o.duration === "number") return o.duration;
  if (o.answeredAt && o.completedAt) {
    return Math.round((Date.parse(o.completedAt) - Date.parse(o.answeredAt)) / 1000);
  }
  return null;
}

export function normalizeCall(o: any): NormalizedCall {
  const vm = o.voicemail;
  return {
    providerId: o.id,
    conversationId: o.conversationId ?? null,
    phoneNumberId: o.phoneNumberId ?? null,
    direction: o.direction === "outgoing" ? "outgoing" : "incoming",
    from: toE164(o.from),
    to: toE164(Array.isArray(o.to) ? o.to[0] : o.to),
    status: o.status ?? "unknown",
    startedAt: o.createdAt ?? null,
    durationSec: durationSec(o),
    answeredBy: answeredBy(o),
    voicemail: vm
      ? {
          url: vm.url ?? null,
          durationSec: vm.duration ?? null,
          transcript: vm.transcript ?? vm.transcription ?? null, // VERIFY
        }
      : null,
  };
}

export function normalizeTranscript(o: any): TranscriptLine[] {
  return (o.dialogue ?? []).map((d: any) => ({
    identifier: toE164(d.identifier) ?? d.identifier ?? null,
    userId: d.userId ?? null,
    text: String(d.content ?? ""),
    start: typeof d.start === "number" ? d.start : null,
  }));
}

export function parseQuoWebhook(rawBody: Buffer): NormalizedEvent {
  const evt = JSON.parse(rawBody.toString("utf8"));
  const eventId: string = evt.id;
  const type: string = evt.type;
  const o = evt.data?.object ?? {};
  if (!eventId || !type) throw new Error("Not a Quo webhook event");

  switch (type) {
    case "call.completed":
      return { kind: "call_completed", eventId, type, call: normalizeCall(o) };
    case "call.transcript.completed":
      return { kind: "call_transcript", eventId, type, callId: o.callId, transcript: normalizeTranscript(o) };
    case "call.summary.completed":
      return {
        kind: "call_summary",
        eventId,
        type,
        callId: o.callId,
        summary: o.summary ?? [],
        nextSteps: o.nextSteps ?? [],
      };
    case "message.received":
      return {
        kind: "message_received",
        eventId,
        type,
        message: {
          providerId: o.id,
          conversationId: o.conversationId ?? null,
          phoneNumberId: o.phoneNumberId ?? null,
          direction: o.direction === "outgoing" ? "outgoing" : "incoming",
          from: toE164(o.from),
          to: toE164(Array.isArray(o.to) ? o.to[0] : o.to),
          body: String(o.text ?? o.body ?? ""),
          media: Array.isArray(o.media) ? o.media.filter((m: any) => typeof m?.url === "string").map((m: any) => ({ url: m.url, type: String(m.type ?? "") })) : [], // VERIFY field name
          createdAt: o.createdAt ?? null,
        },
      };
    default:
      return { kind: "ignored", eventId, type };
  }
}

export class QuoClient implements TelephonyProvider {
  readonly name = "quo";

  constructor(
    private readonly secrets: QuoSecrets,
    private readonly base = config.quoApiBase,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const header = SIGNATURE_HEADERS.map((h) => headers[h]).find((v) => typeof v === "string") as string | undefined;
    return verifyQuoSignature(rawBody, header, this.secrets.signingKeys);
  }

  parseWebhook(rawBody: Buffer): NormalizedEvent {
    return parseQuoWebhook(rawBody);
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: this.secrets.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Quo ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async sendSms(from: string, to: string, body: string): Promise<{ id: string | null }> {
    const out = await this.request("POST", "/messages", { from, to: [to], content: body });
    return { id: out?.data?.id ?? null };
  }

  async getCall(callId: string) {
    const out = await this.request("GET", `/calls/${encodeURIComponent(callId)}`);
    return out?.data ? normalizeCall(out.data) : null;
  }

  async getTranscript(callId: string) {
    const out = await this.request("GET", `/call-transcripts/${encodeURIComponent(callId)}`);
    return out?.data ? normalizeTranscript(out.data) : null;
  }

  async getSummary(callId: string) {
    const out = await this.request("GET", `/call-summaries/${encodeURIComponent(callId)}`);
    return out?.data ? { summary: out.data.summary ?? [], nextSteps: out.data.nextSteps ?? [] } : null;
  }

  /** Registers one webhook; returns its id and signing key. */
  async createWebhook(
    kind: "calls" | "call-transcripts" | "call-summaries" | "messages",
    url: string,
    events: string[],
    resourceIds: string[],
    label: string,
  ): Promise<{ id: string; key: string }> {
    const out = await this.request("POST", `/webhooks/${kind}`, { url, events, resourceIds, label });
    return { id: out.data.id, key: out.data.key };
  }
}
