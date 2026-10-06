// Provider neutral shapes. Core logic only sees these; adapters translate.

export type AnsweredBy = "person" | "ai_agent" | "missed";

export interface NormalizedCall {
  providerId: string;
  conversationId: string | null;
  phoneNumberId: string | null;
  direction: "incoming" | "outgoing";
  from: string | null;
  to: string | null;
  status: string;
  startedAt: string | null;
  durationSec: number | null;
  answeredBy: AnsweredBy;
  voicemail: { url: string | null; durationSec: number | null; transcript: string | null } | null;
}

export interface TranscriptLine {
  identifier: string | null; // phone number of the speaker when known
  userId: string | null; // set when a teammate spoke
  text: string;
  start: number | null;
}

export interface NormalizedMessage {
  providerId: string;
  conversationId: string | null;
  phoneNumberId: string | null;
  direction: "incoming" | "outgoing";
  from: string | null;
  to: string | null;
  body: string;
  createdAt: string | null;
}

export type NormalizedEvent =
  | { kind: "call_completed"; eventId: string; type: string; call: NormalizedCall }
  | { kind: "call_transcript"; eventId: string; type: string; callId: string; transcript: TranscriptLine[] }
  | { kind: "call_summary"; eventId: string; type: string; callId: string; summary: string[]; nextSteps: string[] }
  | { kind: "message_received"; eventId: string; type: string; message: NormalizedMessage }
  | { kind: "ignored"; eventId: string; type: string };

export interface TelephonyProvider {
  readonly name: string;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(rawBody: Buffer): NormalizedEvent;
  sendSms(from: string, to: string, body: string): Promise<{ id: string | null }>;
  getCall(callId: string): Promise<NormalizedCall | null>;
  getTranscript(callId: string): Promise<TranscriptLine[] | null>;
  getSummary(callId: string): Promise<{ summary: string[]; nextSteps: string[] } | null>;
}

// Phase 1 step 6 (booking). Interface fixed now so the pipeline can target it.
export interface CalendarProvider {
  readonly name: string;
  findSlots(window: { from: Date; to: Date }, durationMin: number): Promise<{ start: Date; end: Date }[]>;
  book(slot: { start: Date; end: Date }, attendee: { name: string; phone: string }, details: string): Promise<{ ref: string }>;
  cancel(ref: string): Promise<void>;
}

// ---- accounting (Phase 3). Read only by design: no method here moves money or edits books. ----

export interface AcctLine {
  description: string | null;
  amount: number;
  account: string | null;
  /** In QuickBooks a "customer:job" reference is how a cost is tied to a job. */
  customerRef: string | null;
}

export interface AcctBill {
  externalId: string;
  vendorExternalId: string | null;
  vendorName: string;
  txnDate: string | null; // YYYY-MM-DD
  dueDate: string | null;
  amount: number;
  balance: number;
  docNumber: string | null;
  memo: string | null;
  lines: AcctLine[];
}

export interface AcctInvoice {
  externalId: string;
  customerExternalId: string | null;
  customerName: string;
  txnDate: string | null;
  dueDate: string | null;
  amount: number;
  balance: number;
  docNumber: string | null;
}

export interface AccountingProvider {
  readonly name: string;
  /** Bills with a balance still owed. */
  listOpenBills(): Promise<AcctBill[]>;
  /** Invoices with a balance still owed to us. */
  listOpenInvoices(): Promise<AcctInvoice[]>;
}
