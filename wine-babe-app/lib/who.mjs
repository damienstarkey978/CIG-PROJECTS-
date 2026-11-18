// Works out who is making a request: a team member (password session), a
// signed in account, or an anonymous device. Shared by the Netlify functions.
import { getStore } from "@netlify/blobs";
import { sessionUser } from "./auth.mjs";
import { signingKey, sessionAccountId, getAccount, deviceId, newDeviceCookie, memoryStore } from "./accounts.mjs";
import { ipHashOf } from "./feedback.mjs";

const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? "") || undefined;

const NAMES = ["accounts", "usage", "config", "feedback", "costs"];
let local = null;
// Netlify Blobs on Netlify; in-memory stores when run locally (server.js).
export function stores() {
  try {
    return Object.fromEntries(NAMES.map((n) => [n, getStore(n)]));
  } catch {
    if (!local) local = Object.fromEntries(NAMES.map((n) => [n, memoryStore()]));
    return local;
  }
}

// Returns { team, account, accountId, deviceId, ipHash, userAgent, key, setCookies }.
// setCookies holds a new device cookie when the request had none.
export async function whoIs(req, s = stores()) {
  const cookie = req.headers.get("cookie");
  const key = await signingKey(s.config);
  const team = await sessionUser(cookie, env("AUTH_SECRET"));
  const accountId = await sessionAccountId(key, cookie);
  const account = accountId ? await getAccount(s.accounts, accountId) : null;
  const setCookies = [];
  let dev = deviceId(cookie);
  if (!dev) {
    const d = newDeviceCookie();
    dev = d.id;
    setCookies.push(d.cookie);
  }
  return {
    team,
    account,
    accountId: account ? account.id : null,
    deviceId: dev,
    ipHash: await ipHashOf(req),
    userAgent: req.headers.get("user-agent") || "",
    key,
    setCookies,
  };
}

// JSON response with any cookies to set.
export function json(body, { status = 200, cookies = [] } = {}) {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}
