import type { EmailProvider, OutgoingEmail } from "./types";

/** Demo email: nothing leaves. Every send "succeeds" so the whole flow can be tried safely. */
export class MockEmail implements EmailProvider {
  readonly name = "demo_email";
  async send(_msg: OutgoingEmail) {
    return { id: `demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
  }
}
