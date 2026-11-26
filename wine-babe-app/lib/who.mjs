// Works out who is making a request: a team member (password session), a
// signed in account, or an anonymous device. Shared by the Netlify functions.
import { getStore } from "@netlify/blobs";
import { sessionUser, makeCookie, clearCookie, isEmailTeamUser } from "./auth.mjs";
import { signingKey, sessionAccountId, getAccount, deviceId, newDeviceCookie, memoryStore, teamUserForAccount } from "./accounts.mjs";
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
  const teamCookie = await sessionUser(cookie, env("AUTH_SECRET"));
  const accountId = await sessionAccountId(key, cookie);
  const account = accountId ? await getAccount(s.accounts, accountId) : null;
  // A team member signed in with their own email account is team too.
  // An email team cookie only counts while its account is still signed in.
  const team = (teamCookie && !isEmailTeamUser(teamCookie) ? teamCookie : null) || teamUserForAccount(account);
  const setCookies = [];
  let dev = deviceId(cookie);
  if (!dev) {
    const d = newDeviceCookie();
    dev = d.id;
    setCookies.push(d.cookie);
  }
  return {
    team,
    teamCookie,
    account,
    accountId: account ? account.id : null,
    deviceId: dev,
    ipHash: await ipHashOf(req),
    userAgent: req.headers.get("user-agent") || "",
    key,
    setCookies,
  };
}

// Cookies that keep the team session in step with the email account:
// a team email account gets the team cookie (so the /admin gate lets it in),
// and signing that account out drops it.
export async function teamCookieFor(account, teamCookie) {
  const user = teamUserForAccount(account);
  if (user && teamCookie !== user) return [await makeCookie(user, env("AUTH_SECRET"))];
  if (!user && teamCookie && isEmailTeamUser(teamCookie)) return [clearCookie()];
  return [];
}

// JSON response with any cookies to set.
export function json(body, { status = 200, cookies = [] } = {}) {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}
