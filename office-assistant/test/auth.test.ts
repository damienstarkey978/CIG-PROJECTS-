import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { hashPassword, verifyPassword } from "../src/auth";
import { offlineClassifier } from "../src/ai/offline";
import { closeDb, db } from "../src/lib/db";
import { handlers, type Deps } from "../src/pipeline/processCall";
import { runOne } from "../src/lib/queue";
import { buildApp } from "../src/server";
import { telephonyFor } from "../src/tenants";
import { hasDb, resetDb } from "./helpers";

process.env.ADMIN_TOKEN = "op-token";
const opts = { skip: hasDb ? false : "DATABASE_URL not set" };
const deps: Deps = { telephony: telephonyFor, classify: offlineClassifier() };
let server: ReturnType<ReturnType<typeof buildApp>["listen"]> | undefined;

async function call(path: string, token: string | null, init: { method?: string; body?: unknown } = {}) {
  if (!server) server = buildApp(deps).listen(0);
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

beforeEach(async () => { if (hasDb) await resetDb(); });
after(async () => { server?.close(); if (hasDb) await closeDb(); });

test("passwords hash with a random salt and verify", () => {
  const h = hashPassword("correct horse battery");
  assert.notEqual(h, hashPassword("correct horse battery"));
  assert.equal(verifyPassword("correct horse battery", h), true);
  assert.equal(verifyPassword("wrong", h), false);
  assert.equal(verifyPassword("anything", null), false);
});

async function twoCompanies() {
  const op = "op-token";
  await call("/tenants", op, { method: "POST", body: { slug: "acme", name: "Acme" } });
  await call("/tenants", op, { method: "POST", body: { slug: "beta", name: "Beta" } });
  await call("/t/acme/users", op, { method: "POST", body: { name: "Olive Owner", email: "olive@acme.example", role: "owner", password: "olive-password-1" } });
  await call("/t/acme/users", op, { method: "POST", body: { name: "Otis Office", email: "otis@acme.example", phone: "(904) 555-0200", role: "office", password: "otis-password-1" } });
  await call("/t/beta/users", op, { method: "POST", body: { name: "Bea Owner", email: "bea@beta.example", role: "owner", password: "bea-password-12" } });
  const signIn = async (email: string, password: string) => (await call("/login", null, { method: "POST", body: { email, password } }));
  return { signIn };
}

test("sign in, scoping to one company, and roles", opts, async () => {
  const { signIn } = await twoCompanies();
  assert.equal((await signIn("olive@acme.example", "wrong-password")).status, 401);
  assert.equal((await signIn("nobody@acme.example", "whatever-1234")).status, 401);
  const olive = (await signIn("OLIVE@acme.example", "olive-password-1")).body.token;
  const otis = (await signIn("otis@acme.example", "otis-password-1")).body.token;
  assert.ok(olive && otis);

  assert.deepEqual((await call("/me", olive)).body, { role: "owner", name: "Olive Owner", slug: "acme" });
  assert.deepEqual((await call("/tenants", olive)).body.map((t: any) => t.slug), ["acme"]);
  assert.equal((await call("/t/beta/summary", olive)).status, 403); // another company
  assert.equal((await call("/t/acme/summary", olive)).status, 200);
  assert.equal((await call("/tenants", olive, { method: "POST", body: { slug: "x1", name: "X One" } })).status, 403);

  // Office can work the inbox but not change settings, connectors, imports, or the team.
  assert.equal((await call("/t/acme/interactions", otis)).status, 200);
  assert.equal((await call("/t/acme/settings", otis, { method: "PUT", body: { mode: "live", confidenceThreshold: 0.7, templates: {} } })).status, 403);
  assert.equal((await call("/t/acme/connectors/telephony/mock", otis, { method: "PUT", body: {} })).status, 403);
  assert.equal((await call("/t/acme/users", otis)).status, 403);
  assert.equal((await call("/t/acme/connectors/telephony/mock", olive, { method: "PUT", body: {} })).status, 200);

  assert.equal((await call("/me", "garbage")).status, 401);
  assert.equal((await call("/logout", olive, { method: "POST" })).status, 200);
  assert.equal((await call("/me", olive)).status, 401);
});

test("team management: duplicate emails, short passwords, no self removal, reset signs out", opts, async () => {
  const { signIn } = await twoCompanies();
  const olive = (await signIn("olive@acme.example", "olive-password-1")).body.token;
  const mk = (over = {}) => call("/t/acme/users", olive, { method: "POST", body: { name: "N", email: "n@acme.example", role: "pm", password: "long-enough-pw", ...over } });
  assert.equal((await mk({ password: "short" })).status, 400);
  assert.equal((await mk({ email: "bea@beta.example" })).status, 409); // emails are unique across companies
  const made = await mk();
  assert.equal(made.status, 201);

  const users = (await call("/t/acme/users", olive)).body;
  assert.equal(JSON.stringify(users).includes("password"), false);
  const olivesId = users.find((u: any) => u.email === "olive@acme.example").id;
  assert.equal((await call(`/t/acme/users/${olivesId}`, olive, { method: "DELETE" })).status, 400);

  const nToken = (await signIn("n@acme.example", "long-enough-pw")).body.token;
  assert.equal((await call("/me", nToken)).status, 200);
  await call(`/t/acme/users/${made.body.id}`, olive, { method: "PATCH", body: { password: "brand-new-password" } });
  assert.equal((await call("/me", nToken)).status, 401);
  assert.equal((await signIn("n@acme.example", "brand-new-password")).status, 200);
  assert.equal((await call(`/t/acme/users/${made.body.id}`, olive, { method: "DELETE" })).status, 200);
});

test("repeated wrong passwords get locked out", opts, async () => {
  await twoCompanies();
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await call("/login", null, { method: "POST", body: { email: "lockout@acme.example", password: "nope-nope-nope" + i } })).status;
  assert.equal(last, 429);
});

test("staff with a mobile and alerts on receive live alerts", opts, async () => {
  const { signIn } = await twoCompanies();
  const olive = (await signIn("olive@acme.example", "olive-password-1")).body.token;
  await call("/t/acme/connectors/telephony/mock", olive, { method: "PUT", body: {} });
  await call("/t/acme/settings", olive, { method: "PUT", body: { mode: "live", confidenceThreshold: 0.7, templates: {} } });
  await call("/t/acme/simulate", olive, { method: "POST", body: { scenario: "lead_bathroom" } });
  await db().query("UPDATE work_queue SET run_at = now()");
  while (await runOne(handlers(deps))) {}
  const sent = (await call("/t/acme/outbound", olive)).body;
  assert.deepEqual(sent.map((m: any) => [m.purpose, m.to_phone]), [["office_alert", "+19045550200"]]);
});
