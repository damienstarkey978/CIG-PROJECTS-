import type { EmailProvider } from "../connectors/types";
import { db } from "../lib/db";
import type { Tenant } from "../tenants";

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
export const validEmails = (list: string[]) => list.every((e) => EMAIL.test(e));

export type SendOutcome = { ok: true } | { ok: false; status: number; error: string };

/**
 * Sends one approved draft. This only ever runs because a person pressed Send. The office's
 * always copy list is added every time, even if someone removed it from the draft.
 */
export async function sendDraft(tenant: Tenant, draftId: string, userId: string | null, email: EmailProvider | null): Promise<SendOutcome> {
  if (!email) return { ok: false, status: 400, error: "Connect an email account first (Connectors tab)" };
  // Claim the draft so a double click cannot send it twice.
  const claimed = await db().query<{ to_emails: string[]; cc: string[]; subject: string; body: string }>(
    `UPDATE update_drafts SET status = 'sending', error = NULL WHERE id = $1 AND tenant_id = $2 AND status IN ('draft','failed')
     RETURNING to_emails, cc, subject, body`, [draftId, tenant.id]);
  const d = claimed.rows[0];
  if (!d) return { ok: false, status: 400, error: "That email was already sent, skipped, or is being sent" };
  const release = (status: "draft" | "failed", error: string | null) =>
    db().query("UPDATE update_drafts SET status = $2, error = $3 WHERE id = $1", [draftId, status, error]);

  const alwaysCc = (tenant.settings.weeklyUpdates?.cc ?? []).filter(Boolean);
  const cc = [...new Set([...d.cc, ...alwaysCc].map((e) => e.trim()).filter(Boolean))].filter((e) => !d.to_emails.includes(e));
  if (!d.to_emails.length) { await release("draft", null); return { ok: false, status: 400, error: "Add who this goes to first" }; }
  if (!validEmails([...d.to_emails, ...cc])) { await release("draft", null); return { ok: false, status: 400, error: "One of the email addresses doesn't look right" }; }
  if (!d.body.trim()) { await release("draft", null); return { ok: false, status: 400, error: "The email is empty" }; }

  try {
    const sent = await email.send({ to: d.to_emails.join(", "), cc, subject: d.subject, text: d.body });
    await db().query("UPDATE update_drafts SET status = 'sent', sent_at = now(), provider_message_id = $2, approved_by_user_id = $3, cc = $4 WHERE id = $1", [draftId, sent.id, userId, cc]);
    return { ok: true };
  } catch (err) {
    await release("failed", String(err instanceof Error ? err.message : err));
    return { ok: false, status: 502, error: `The email didn't go out: ${err instanceof Error ? err.message : err}` };
  }
}
