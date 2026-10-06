import crypto from "node:crypto";
import { db } from "./lib/db";

export type Role = "owner" | "office" | "pm";
export type Auth =
  | { kind: "operator" }
  | { kind: "user"; userId: string; tenantId: string; slug: string; role: Role; name: string };

const SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt1$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string | null): boolean {
  // Always do the work so a missing user takes as long as a wrong password.
  const [scheme, saltB64, keyB64] = (stored ?? "scrypt1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64")).split("$");
  const key = Buffer.from(keyB64, "base64");
  const test = crypto.scryptSync(pw, Buffer.from(saltB64, "base64"), 64);
  return Boolean(stored) && scheme === "scrypt1" && key.length === test.length && crypto.timingSafeEqual(key, test);
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await db().query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)", [sha(token), userId, String(SESSION_DAYS)]);
  return token;
}

export async function endSession(token: string): Promise<void> {
  await db().query("DELETE FROM sessions WHERE token_hash = $1", [sha(token)]);
}

export async function authFromSession(token: string): Promise<Auth | null> {
  if (!token) return null;
  const { rows } = await db().query(
    `SELECT u.id, u.name, u.role, u.tenant_id, t.slug FROM sessions s
     JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = u.tenant_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha(token)],
  );
  const r = rows[0];
  return r ? { kind: "user", userId: r.id, tenantId: r.tenant_id, slug: r.slug, role: r.role, name: r.name } : null;
}

/** Returns a session token, or null for any wrong email or password. */
export async function login(email: string, password: string): Promise<string | null> {
  const { rows } = await db().query<{ id: string; password_hash: string | null }>("SELECT id, password_hash FROM users WHERE lower(email) = lower($1)", [email.trim()]);
  const ok = verifyPassword(password, rows[0]?.password_hash ?? null);
  if (!rows[0] || !ok) return null;
  await db().query("UPDATE users SET last_login_at = now() WHERE id = $1", [rows[0].id]);
  return createSession(rows[0].id);
}

// Slows password guessing: 10 failures per email and address per 15 minutes.
const failures = new Map<string, { n: number; resetAt: number }>();
export function tooManyAttempts(key: string, now = Date.now()): boolean {
  const f = failures.get(key);
  return Boolean(f && f.resetAt > now && f.n >= 10);
}
export function noteFailure(key: string, now = Date.now()) {
  const f = failures.get(key);
  if (!f || f.resetAt <= now) failures.set(key, { n: 1, resetAt: now + 15 * 60_000 });
  else f.n++;
}
export function clearFailures(key: string) {
  failures.delete(key);
}
