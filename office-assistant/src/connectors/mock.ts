import { toE164 } from "../lib/phone";
import { parseQuoWebhook } from "./quo";
import type { NormalizedEvent, TelephonyProvider } from "./types";

/**
 * Demo phone. Nothing leaves the building: texts are only recorded (the pipeline
 * logs every send to outbound_messages), and calls enter through the simulator.
 */
export class MockTelephony implements TelephonyProvider {
  readonly name = "mock";
  verifyWebhook() {
    return false; // the simulator calls ingest directly; no public webhook for the mock
  }
  parseWebhook(rawBody: Buffer): NormalizedEvent {
    return parseQuoWebhook(rawBody);
  }
  async sendSms(from: string, to: string) {
    if (!toE164(from) || !toE164(to)) throw new Error("mock sendSms needs E.164 numbers");
    return { id: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
  }
  async getCall() {
    return null;
  }
  async getTranscript() {
    return null;
  }
  async getSummary() {
    return null;
  }
}
