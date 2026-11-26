// Public accounts, free scan limits and sessions for the public app.
// Storage is a key-value store with get(key, { type: "json" }), setJSON(key,
// value), delete(key) and list({ prefix }) (Netlify Blobs on Netlify, a Map
// locally). Web Crypto only, so it runs in Netlify functions and Node.

export const LIMITS = {
  // Scans someone can run before a free account is required (Damien, Nov 18: 5).
  freeScans: Number(process.env.WB_FREE_SCANS || 5),
  // Scans per day for a signed in account (safety cap on AI cost).
  dailyScans: Number(process.env.WB_DAILY_SCANS || 20),
  // Safety cap on all non team scans per day, so a flood can't run up the bill.
  globalDaily: Number(process.env.WB_GLOBAL_DAILY || 300),
  // Scans per day from one internet address before sign up, so clearing
  // cookies can't give unlimited free scans.
  anonPerIpPerDay: Number(process.env.WB_ANON_IP_DAILY || 15),
};


import { REVIEW_CODE_HASH } from "./review-code.mjs";
import { teamUserForEmail } from "./auth.mjs";

// Team access by email (Damien, Nov 26: the downloaded app should know him).
// The email has to be proven: signed in with an emailed code, or the team
// account that already existed before this went live (sign up doesn't check
// email, so a newer unproven sign up with a team email gets nothing).
const TEAM_EMAIL_TRUSTED_BEFORE = "2026-11-26T22:00:00.000Z";
export function teamUserForAccount(account) {
  if (!account) return null;
  const user = teamUserForEmail(account.email);
  if (!user) return null;
  return account.emailVerified || String(account.createdAt || "9") < TEAM_EMAIL_TRUSTED_BEFORE ? user : null;
}
export async function markEmailVerified(store, account) {
  if (!account || account.emailVerified) return account;
  const next = { ...account, emailVerified: true };
  await store.setJSON(`acct/${account.id}`, next);
  return next;
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(String(s))));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// ---------- validation ----------
export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const validEmail = (e) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e);
export function normPhone(p) {
  const raw = String(p || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/[^\d+]/g, "");
  const count = digits.replace(/\D/g, "").length;
  if (count < 7 || count > 15) throw new AppError(400, "bad_phone", "That phone number doesn't look right.");
  return digits;
}

export function parseSignup(body) {
  const name = String(body?.name || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const email = normEmail(body?.email);
  if (!name) throw new AppError(400, "need_name", "Please add your name.");
  if (!validEmail(email)) throw new AppError(400, "bad_email", "Please add a valid email address.");
  return { name, email, phone: normPhone(body?.phone) };
}

// ---------- signing key ----------
let cachedKey = null;
export async function signingKey(config) {
  if (cachedKey) return cachedKey;
  let secret = process.env.AUTH_SECRET ? `acct|${process.env.AUTH_SECRET}` : null;
  if (!secret) {
    secret = await config.get("signing-key", { type: "json" }).catch(() => null);
    if (!secret) { secret = randomHex(32); await config.setJSON("signing-key", secret); }
  }
  cachedKey = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return cachedKey;
}
const hmac = async (key, value) => hex(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- cookies ----------
export const ACCOUNT_COOKIE = "wb_acct";
export const DEVICE_COOKIE = "wb_dev";
const YEAR = 365 * 86400;
const cookieValue = (header, name) => (String(header || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)) || [])[1] || null;

export async function accountCookie(key, id) {
  const exp = Date.now() + YEAR * 1000;
  const v = `${id}.${exp}`;
  return `${ACCOUNT_COOKIE}=${v}.${await hmac(key, v)}; Path=/; Max-Age=${YEAR}; HttpOnly; Secure; SameSite=Lax`;
}
export const clearAccountCookie = () => `${ACCOUNT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export async function sessionAccountId(key, cookieHeader) {
  const raw = cookieValue(cookieHeader, ACCOUNT_COOKIE);
  if (!raw) return null;
  const [id, exp, sig] = raw.split(".");
  if (!/^[a-f0-9]{24}$/.test(id || "") || !(Number(exp) > Date.now()) || !sig) return null;
  return same(await hmac(key, `${id}.${exp}`), sig) ? id : null;
}

// A random id per phone/browser, used to count free scans before sign up.
export function deviceId(cookieHeader) {
  const v = cookieValue(cookieHeader, DEVICE_COOKIE);
  return /^[a-f0-9]{24}$/.test(v || "") ? v : null;
}
export const newDeviceCookie = () => {
  const id = randomHex(12);
  return { id, cookie: `${DEVICE_COOKIE}=${id}; Path=/; Max-Age=${YEAR * 5}; HttpOnly; Secure; SameSite=Lax` };
};

// ---------- accounts ----------
const emailKey = async (email) => `email/${await sha(email)}`;

export async function findByEmail(store, email) {
  const id = await store.get(await emailKey(email), { type: "json" });
  return id ? getAccount(store, id) : null;
}
export const getAccount = (store, id) => store.get(`acct/${id}`, { type: "json" });

export async function createAccount(store, body, { deviceId: dev, now = Date.now() } = {}) {
  const { name, email, phone } = parseSignup(body);
  if (await findByEmail(store, email)) throw new AppError(409, "exists", "There's already an account with that email. Sign in instead.");
  const account = { id: randomHex(12), name, email, phone, createdAt: new Date(now).toISOString(), emailVerified: false, signupDevice: dev || null };
  await store.setJSON(`acct/${account.id}`, account);
  await store.setJSON(await emailKey(email), account.id);
  return account;
}

export async function deleteAccount(store, usage, id) {
  const account = await getAccount(store, id);
  if (!account) return false;
  await store.delete(await emailKey(account.email));
  await store.delete(`acct/${id}`);
  await store.delete(`code/${await sha(account.email)}`);
  const { blobs } = await usage.list({ prefix: `acct/${id}/` });
  for (const b of blobs || []) await usage.delete(b.key);
  return true;
}

export const publicAccount = (a) => (a ? { name: a.name, email: a.email, phone: a.phone || "", createdAt: a.createdAt } : null);

// ---------- email sign in codes ----------
const CODE_TTL = 10 * 60 * 1000;
export async function issueCode(store, email, now = Date.now()) {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  await store.setJSON(`code/${await sha(email)}`, { hash: await sha(`${email}|${code}`), exp: now + CODE_TTL, tries: 0 });
  return code;
}
export async function checkCode(store, email, code, now = Date.now()) {
  const k = `code/${await sha(email)}`;
  const rec = await store.get(k, { type: "json" });
  if (!rec || rec.exp < now) throw new AppError(400, "code_expired", "That code expired. Send a new one.");
  if (rec.tries >= 5) { await store.delete(k); throw new AppError(429, "code_tries", "Too many tries. Send a new code."); }
  if (!same(await sha(`${email}|${String(code || "").trim()}`), rec.hash)) {
    await store.setJSON(k, { ...rec, tries: rec.tries + 1 });
    throw new AppError(400, "code_wrong", "That code isn't right. Check the email and try again.");
  }
  await store.delete(k);
}

// ---------- App Store review sign in ----------
// Apple's reviewer can't read an inbox, so one demo email (WB_REVIEW_EMAIL)
// signs in with a fixed code (WB_REVIEW_CODE, at least 8 characters) instead
// of an emailed one. The code is WB_REVIEW_CODE (at least 8 characters) or the
// one whose salted hash is in review-code.mjs. No email or no code = no demo
// login. The account is made on first sign in, so deleting it during review is fine.
const reviewEnv = (hashed = REVIEW_CODE_HASH) => ({
  email: normEmail(process.env.WB_REVIEW_EMAIL),
  code: String(process.env.WB_REVIEW_CODE || "").trim(),
  hashed: hashed && hashed.salt && hashed.hash ? hashed : null,
});
export function isReviewEmail(email, hashed) {
  const r = reviewEnv(hashed);
  return Boolean(r.email && (r.code.length >= 8 || r.hashed) && normEmail(email) === r.email);
}
async function reviewCodeOk(r, code) {
  const c = String(code || "").trim();
  if (!c) return false;
  if (r.code.length >= 8 && same(await sha(c), await sha(r.code))) return true;
  return Boolean(r.hashed && same(await sha(r.hashed.salt + c), r.hashed.hash));
}
export async function reviewSignIn(store, email, code, now = Date.now(), hashed) {
  const r = reviewEnv(hashed);
  if (!isReviewEmail(email, hashed) || !(await reviewCodeOk(r, code))) {
    throw new AppError(400, "code_wrong", "That code isn't right. Check the email and try again.");
  }
  return (await findByEmail(store, r.email)) || createAccount(store, { name: "App Review", email: r.email }, { now });
}

// ---------- scan limits ----------
async function bump(usage, key) {
  const cur = (await usage.get(key, { type: "json" })) || { count: 0 };
  await usage.setJSON(key, { count: cur.count + 1 });
}
const count = async (usage, key) => ((await usage.get(key, { type: "json" })) || { count: 0 }).count;

// who: { team: bool, accountId, deviceId, ipHash }
export async function scanAllowance(usage, who, now = Date.now()) {
  if (who.team) return { ok: true, unlimited: true };
  if ((await count(usage, `global/${day(now)}`)) >= LIMITS.globalDaily) {
    return { ok: false, status: 503, code: "busy", error: "Wine Babe is very busy today. Please try again tomorrow." };
  }
  if (who.accountId) {
    const used = await count(usage, `acct/${who.accountId}/${day(now)}`);
    return used < LIMITS.dailyScans
      ? { ok: true, signedIn: true, usedToday: used, dailyLimit: LIMITS.dailyScans }
      : { ok: false, status: 429, code: "daily_limit", error: `You've hit today's limit of ${LIMITS.dailyScans} scans. Come back tomorrow.` };
  }
  const used = who.deviceId ? await count(usage, `dev/${who.deviceId}`) : 0;
  const ipUsed = who.ipHash ? await count(usage, `ip/${day(now)}/${who.ipHash}`) : 0;
  const remaining = Math.max(0, LIMITS.freeScans - used);
  if (remaining <= 0 || ipUsed >= LIMITS.anonPerIpPerDay) {
    return { ok: false, status: 403, code: "need_account", needAccount: true, error: `You've used your ${LIMITS.freeScans} free scans. Create a free account to keep scanning.` };
  }
  return { ok: true, signedIn: false, freeRemaining: remaining, freeScans: LIMITS.freeScans };
}

export async function recordScan(usage, who, now = Date.now()) {
  if (who.team) return;
  await bump(usage, `global/${day(now)}`);
  if (who.accountId) return bump(usage, `acct/${who.accountId}/${day(now)}`);
  if (who.deviceId) await bump(usage, `dev/${who.deviceId}`);
  if (who.ipHash) await bump(usage, `ip/${day(now)}/${who.ipHash}`);
}

// Memory store with the same interface, for local runs and tests.
export function memoryStore() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
    setJSON: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
  };
}
