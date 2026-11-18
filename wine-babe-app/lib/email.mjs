// Outbound email through Resend's REST API (no SDK). Optional: with no
// RESEND_API_KEY set, sendEmail returns { sent: false, reason } and nothing goes out.
const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? "").trim();

export const emailConfigured = () => Boolean(env("RESEND_API_KEY"));
export const fromAddress = () => env("EMAIL_FROM") || "Wine Babe Scanner <hello@winebabescanner.com>";

export async function sendEmail({ to, subject, text, replyTo }) {
  const recipients = (Array.isArray(to) ? to : String(to || "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!recipients.length) return { sent: false, reason: "no recipients" };
  if (!emailConfigured()) return { sent: false, reason: "email not configured" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromAddress(), to: recipients, subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { sent: false, reason: `resend ${res.status}: ${String(body.message || body.name || "").slice(0, 200)}` };
    return { sent: true, id: body.id };
  } catch (err) {
    return { sent: false, reason: `network: ${String(err.message || err).slice(0, 200)}` };
  }
}

export const feedbackRecipients = () => env("FEEDBACK_TO");
