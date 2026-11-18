// Share feedback: validate, store every submission, email it to the team.
import { AppError, sha } from "./accounts.mjs";
import { sendEmail, feedbackRecipients } from "./email.mjs";

export const FEEDBACK_SUBJECT = "Wine Babe Scanner App: New Feedback";
const TYPES = { bug: "Bug", idea: "Idea", other: "Other" };
const MAX_TEXT = 4000;
const PER_IP_PER_HOUR = 10;

export function parseFeedback(body) {
  const text = String(body?.text || "").trim();
  if (!text) throw new AppError(400, "empty", "Tell us a little about it first.");
  if (text.length > MAX_TEXT) throw new AppError(400, "too_long", `Please keep it under ${MAX_TEXT} characters.`);
  const type = TYPES[body?.type] ? body.type : "other";
  const email = String(body?.email || "").trim().slice(0, 254);
  return {
    type,
    text,
    email,
    honeypot: String(body?.website || "").trim(),
    appVersion: String(body?.appVersion || "").slice(0, 60),
    platform: String(body?.platform || "").slice(0, 60),
    screen: String(body?.screen || "").slice(0, 60),
  };
}

const stamp = (now) => new Date(now).toISOString();
const newKey = (now) => `${stamp(now).replace(/[:.]/g, "-")}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}`;

// store: feedback store. limits: usage store (rate limit counters).
// who: { account, team, ipHash, userAgent }
export async function submitFeedback({ store, limits, body, who, now = Date.now(), send = sendEmail }) {
  const f = parseFeedback(body);
  if (f.honeypot) return { ok: true, id: null }; // bots fill hidden fields; pretend it worked
  if (who.ipHash && limits) {
    const k = `fb/${stamp(now).slice(0, 13)}/${who.ipHash}`;
    const cur = (await limits.get(k, { type: "json" })) || { count: 0 };
    if (cur.count >= PER_IP_PER_HOUR) throw new AppError(429, "slow_down", "Thanks! That's a lot of feedback at once. Try again in a bit.");
    await limits.setJSON(k, { count: cur.count + 1 });
  }
  const entry = {
    id: newKey(now),
    at: stamp(now),
    type: f.type,
    text: f.text,
    accountId: who.account?.id || null,
    name: who.account?.name || (who.team ? `Team (${who.team})` : ""),
    email: who.account?.email || f.email || "",
    signedIn: Boolean(who.account),
    appVersion: f.appVersion,
    platform: f.platform,
    screen: f.screen,
    userAgent: String(who.userAgent || "").slice(0, 300),
    emailed: null,
  };
  await store.setJSON(`entry/${entry.id}`, entry);
  const mail = await send({ to: feedbackRecipients(), subject: FEEDBACK_SUBJECT, text: feedbackEmailText(entry), replyTo: entry.email || undefined });
  entry.emailed = mail.sent ? { ok: true, id: mail.id } : { ok: false, reason: mail.reason };
  await store.setJSON(`entry/${entry.id}`, entry);
  return { ok: true, id: entry.id, emailed: mail.sent };
}

export function feedbackEmailText(e) {
  return [
    `New ${TYPES[e.type] || "Other"} from the Wine Babe Scanner app`,
    "",
    e.text,
    "",
    "----",
    `From: ${e.name || "Not signed in"}${e.email ? ` <${e.email}>` : ""}`,
    `Signed in: ${e.signedIn ? "yes" : "no"}`,
    `App version: ${e.appVersion || "unknown"}`,
    `Device: ${e.platform || "unknown"}${e.screen ? `, screen ${e.screen}` : ""}`,
    `Browser: ${e.userAgent || "unknown"}`,
    `Sent: ${e.at}`,
  ].join("\n");
}

export async function listFeedback(store) {
  const { blobs } = await store.list({ prefix: "entry/" });
  const rows = await Promise.all((blobs || []).map((b) => store.get(b.key, { type: "json" })));
  return rows.filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1));
}

// Account deletion: keep the feedback text, drop who sent it.
export async function scrubAccountFeedback(store, accountId) {
  for (const e of await listFeedback(store)) {
    if (e.accountId === accountId) await store.setJSON(`entry/${e.id}`, { ...e, accountId: null, name: "Deleted account", email: "" });
  }
}

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
export function feedbackCsv(rows) {
  const cols = ["at", "type", "text", "name", "email", "signedIn", "appVersion", "platform", "screen", "userAgent"];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
}

export const ipHashOf = async (req) => {
  const ip = req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return ip ? (await sha(`ip|${ip}`)).slice(0, 24) : null;
};
