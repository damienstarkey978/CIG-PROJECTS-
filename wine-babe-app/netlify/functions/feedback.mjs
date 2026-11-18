// POST /api/feedback { type: bug|idea|other, text, email?, appVersion, platform, screen }
// Stores every submission and emails it to FEEDBACK_TO.
import { AppError } from "../../lib/accounts.mjs";
import { submitFeedback } from "../../lib/feedback.mjs";
import { stores, whoIs, json } from "../../lib/who.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  const s = stores();
  const who = await whoIs(req, s);
  try {
    const body = await req.json().catch(() => ({}));
    const out = await submitFeedback({ store: s.feedback, limits: s.usage, body, who });
    return json({ ok: true, id: out.id }, { cookies: who.setCookies });
  } catch (err) {
    if (err instanceof AppError) return json({ error: err.message, code: err.code }, { status: err.status, cookies: who.setCookies });
    console.error("[feedback]", err);
    return json({ error: "We couldn't send that. Please try again." }, { status: 500, cookies: who.setCookies });
  }
};

export const config = { path: "/api/feedback" };
