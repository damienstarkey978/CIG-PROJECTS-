import crypto from "node:crypto";
import type { Classification } from "../src/ai/classify";
import type { NormalizedCall, TelephonyProvider, TranscriptLine } from "../src/connectors/types";
import { parseQuoWebhook, verifyQuoSignature } from "../src/connectors/quo";
import { db, migrate } from "../src/lib/db";

export const hasDb = Boolean(process.env.DATABASE_URL);
process.env.APP_ENCRYPTION_KEY ??= crypto.randomBytes(32).toString("base64");

export const SIGNING_KEY = Buffer.from("test-signing-key").toString("base64");

export function sign(body: string, key = SIGNING_KEY, ts = Date.now()): string {
  const digest = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(`${ts}.${body}`).digest("base64");
  return `hmac;1;${ts};${digest}`;
}

export async function resetDb(): Promise<void> {
  await db().query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate();
}

export async function makeTenant(settings: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO tenants (slug, name, settings) VALUES ('wci', 'World Construction Inc.', $1) RETURNING id`,
    [JSON.stringify({ mode: "shadow", confidenceThreshold: 0.7, templates: {}, shadowRecipientPhone: "+19045550100", ...settings })],
  );
  return rows[0].id;
}

export class FakeTelephony implements TelephonyProvider {
  readonly name = "quo";
  sent: { from: string; to: string; body: string }[] = [];
  calls = new Map<string, NormalizedCall>();
  transcripts = new Map<string, TranscriptLine[]>();
  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>) {
    return verifyQuoSignature(raw, headers["openphone-signature"] as string, [SIGNING_KEY]);
  }
  parseWebhook(raw: Buffer) {
    return parseQuoWebhook(raw);
  }
  async sendSms(from: string, to: string, body: string) {
    this.sent.push({ from, to, body });
    return { id: `MS${this.sent.length}` };
  }
  async getCall(id: string) {
    return this.calls.get(id) ?? null;
  }
  async getTranscript(id: string) {
    return this.transcripts.get(id) ?? null;
  }
  async getSummary() {
    return null;
  }
}

export function classification(over: Partial<Classification> = {}): Classification {
  return {
    caller_type: "lead",
    confidence: 0.92,
    reasoning: "Asked for a kitchen remodel estimate.",
    caller_name: "Jane Smith",
    company: null,
    job_type: "kitchen remodel",
    job_address: "12 Oak St",
    timeline: "this spring",
    budget_hint: null,
    job_reference: null,
    urgency: "normal",
    callback_requested: true,
    office_summary: "Jane wants an estimate on a kitchen remodel at 12 Oak St, starting this spring.",
    ...over,
  };
}

let seq = 0;
export function quoEvent(type: string, object: Record<string, unknown>) {
  return JSON.stringify({ id: `EV${++seq}`, object: "event", type, createdAt: new Date().toISOString(), data: { object } });
}

export function callObject(over: Record<string, unknown> = {}) {
  return {
    id: "AC1",
    object: "call",
    direction: "incoming",
    from: "+19045551234",
    to: "+19047171729",
    status: "completed",
    createdAt: new Date().toISOString(),
    answeredAt: new Date().toISOString(),
    completedAt: new Date(Date.now() + 90_000).toISOString(),
    userId: null,
    phoneNumberId: "PNEYAAmj7S",
    conversationId: "CN1",
    ...over,
  };
}
