// Password gate for the whole site. Works in Netlify Edge (Deno) and Node,
// using Web Crypto only. Passwords are stored as PBKDF2 SHA-256 hashes.
// To add a user: node scripts/add-user.mjs <username> <password>, then paste
// the printed line into USERS.

export const USERS = {
  mindy: { name: "Mindy", salt: "3422363df17aa308422740ddcec5fe63", hash: "ecd982c29bbaede635ed0722bc7d59f055ccc95a85ff1b421bfaca2ed61a7f59" },
};

const COOKIE = "wb_session";
const DAYS = 30;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

export async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: 100000 }, key, 256);
  return hex(bits);
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function secretKey(secret) {
  // AUTH_SECRET env var if set; otherwise derived from the stored hashes.
  const base = secret || `wb|${Object.values(USERS).map((u) => u.hash).join("|")}`;
  return crypto.subtle.importKey("raw", enc.encode(base), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(value, secret) {
  return hex(await crypto.subtle.sign("HMAC", await secretKey(secret), enc.encode(value)));
}

export async function checkLogin(username, password) {
  const u = USERS[String(username || "").trim().toLowerCase()];
  if (!u) { await hashPassword(String(password || ""), "00"); return null; }
  return same(await hashPassword(String(password || ""), u.salt), u.hash) ? String(username).trim().toLowerCase() : null;
}

export async function makeCookie(user, secret) {
  const exp = Date.now() + DAYS * 864e5;
  const value = `${user}.${exp}`;
  return `${COOKIE}=${value}.${await sign(value, secret)}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export async function sessionUser(cookieHeader, secret) {
  const m = String(cookieHeader || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [user, exp, sig] = m[1].split(".");
  if (!user || !exp || !sig || !USERS[user] || Number(exp) < Date.now()) return null;
  return same(await sign(`${user}.${exp}`, secret), sig) ? user : null;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function loginPage(error = "", next = "/") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Wine Babe sign in</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Outfit:wght@300;400;500&display=swap" rel="stylesheet" />
<style>
:root { --bg: #f7f1ec; --card: #fffaf6; --ink: #2b1d1f; --muted: #8b7b78; --wine: #8c2f45; --line: #eadfd8; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font-family: Outfit, system-ui, sans-serif; padding: 16px; }
.card { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--line); border-radius: 22px; padding: 32px 24px; box-shadow: 0 10px 30px rgba(80, 30, 40, 0.08); text-align: center; }
img { width: 220px; max-width: 80%; height: auto; margin-bottom: 8px; }
h1 { font-family: "Cormorant Garamond", serif; font-weight: 600; font-size: 1.6rem; margin: 8px 0 20px; }
label { display: block; text-align: left; font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 14px 0 6px; }
input { width: 100%; padding: 13px 14px; border: 1px solid var(--line); border-radius: 12px; font: inherit; font-size: 16px; background: #fff; color: var(--ink); }
button { width: 100%; margin-top: 22px; padding: 14px; border: 0; border-radius: 999px; background: var(--wine); color: #fff; font: inherit; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; }
.err { color: var(--wine); font-size: 0.9rem; margin: 0 0 4px; }
</style></head><body>
<form class="card" method="post" action="/login">
  <img src="/images/logo-small.png" alt="Wine Babe" />
  <h1>Sign in</h1>
  ${error ? `<p class="err">${esc(error)}</p>` : ""}
  <input type="hidden" name="next" value="${esc(next)}" />
  <label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" required />
  <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required />
  <button type="submit">Enter</button>
</form></body></html>`;
}

// Shared request handler. Returns a Response to send, or null to let the
// request through.
export async function gate(req, secret) {
  const url = new URL(req.url);
  const p = url.pathname;
  const html = (body, status = 200, extra = {}) => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra } });
  const safeNext = (n) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") ? n : "/");

  // The login page needs its logo before sign in.
  if (p === "/images/logo-small.png") return null;
  if (p === "/logout") return new Response(null, { status: 302, headers: { Location: "/login", "Set-Cookie": clearCookie() } });
  if (p === "/login") {
    if (req.method === "POST") {
      const form = await req.formData().catch(() => null);
      const user = form ? await checkLogin(form.get("username"), form.get("password")) : null;
      const next = safeNext(form?.get("next"));
      if (!user) return html(loginPage("Wrong username or password.", next), 401);
      return new Response(null, { status: 303, headers: { Location: next, "Set-Cookie": await makeCookie(user, secret), "Cache-Control": "no-store" } });
    }
    return html(loginPage("", safeNext(url.searchParams.get("next"))));
  }
  if (await sessionUser(req.headers.get("cookie"), secret)) return null;
  if (p.startsWith("/api/")) return Response.json({ error: "Please sign in again." }, { status: 401 });
  return new Response(null, { status: 302, headers: { Location: `/login?next=${encodeURIComponent(p + url.search)}`, "Cache-Control": "no-store" } });
}
