// Team access from a team member's own email account (no team password).
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.AUTH_SECRET = "test-secret";
const { stores } = await import("../lib/who.mjs");
const { accountCookie, signingKey, teamUserForAccount, markEmailVerified } = await import("../lib/accounts.mjs");
const { teamUserForEmail, checkLogin, sessionUser } = await import("../lib/auth.mjs");
const account = (await import("../netlify/functions/account.mjs")).default;
const admin = (await import("../netlify/functions/admin.mjs")).default;

const s = stores();
const base = "https://winebabescanner.com";
const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]);
const req = (path, cookies = [], body) => new Request(base + path, {
  method: body ? "POST" : "GET",
  headers: { cookie: cookies.join("; "), "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
});

async function seed(id, email, createdAt, extra = {}) {
  const a = { id, name: "T", email, phone: "", createdAt, emailVerified: false, ...extra };
  await s.accounts.setJSON(`acct/${id}`, a);
  return `wb_acct=${(await accountCookie(await signingKey(s.config), id)).split(";")[0].split("=")[1]}`;
}

test("only listed emails map to team, never by password", async () => {
  assert.equal(teamUserForEmail("DamienStarkey978@gmail.com"), "damien");
  assert.equal(teamUserForEmail("someone@else.com"), null);
  assert.equal(await checkLogin("damien", ""), null);
  assert.equal(await checkLogin("damien", "anything"), null);
});

test("Damien's existing email account gets team in the app: Team tools, unlimited, /admin/users", async () => {
  const acct = await seed("a".repeat(24), "damienstarkey978@gmail.com", "2026-11-26T21:35:00.000Z");
  const res = await account(req("/api/account", [acct]));
  const body = await res.json();
  assert.equal(body.team, true);
  assert.equal(body.allowance.unlimited, true);
  const team = cookiesOf(res).find((c) => c.startsWith("wb_session="));
  assert.ok(team, "team cookie issued so the /admin gate lets him in");
  assert.equal(await sessionUser(team, "test-secret"), "damien");
  const page = await admin(req("/admin/users", [acct, team]));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<h1>Users<\/h1>/);
  // Sign out drops the team cookie, and the cookie alone opens nothing.
  const out = await account(req("/api/account/signout", [acct, team], {}));
  assert.ok(cookiesOf(out).includes("wb_session="));
  assert.equal((await admin(req("/admin/users", [team]))).status, 302);
});

test("a newer unproven sign up with a team email gets nothing until it signs in by code", async () => {
  const id = "b".repeat(24);
  const acct = await seed(id, "damienstarkey978@gmail.com", "2026-11-27T10:00:00.000Z");
  const body = await (await account(req("/api/account", [acct]))).json();
  assert.equal(body.team, false);
  assert.equal((await admin(req("/admin/users", [acct]))).status, 302);
  const verified = await markEmailVerified(s.accounts, await s.accounts.get(`acct/${id}`));
  assert.equal(teamUserForAccount(verified), "damien");
});

test("other accounts are not team", async () => {
  const acct = await seed("c".repeat(24), "someone@else.com", "2026-11-01T10:00:00.000Z");
  const body = await (await account(req("/api/account", [acct]))).json();
  assert.equal(body.team, false);
  assert.equal((await admin(req("/admin/users", [acct]))).status, 302);
});
