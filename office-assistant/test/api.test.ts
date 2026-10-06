import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { offlineClassifier } from "../src/ai/offline";
import { closeDb, db } from "../src/lib/db";
import { runOne } from "../src/lib/queue";
import { handlers, type Deps } from "../src/pipeline/processCall";
import { buildApp } from "../src/server";
import { telephonyFor } from "../src/tenants";
import { hasDb, resetDb } from "./helpers";

process.env.ADMIN_TOKEN = "test-token";
const opts = { skip: hasDb ? false : "DATABASE_URL not set" };
const deps: Deps = { telephony: telephonyFor, classify: offlineClassifier() };
let server: ReturnType<ReturnType<typeof buildApp>["listen"]> | undefined;

async function call(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) {
  if (!server) server = buildApp(deps).listen(0);
  const { port } = server.address() as AddressInfo;
  const token = init.token === undefined ? "test-token" : init.token;
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function drain() {
  await db().query("UPDATE work_queue SET run_at = now() WHERE status = 'pending'");
  while (await runOne(handlers(deps))) {}
}

beforeEach(async () => { if (hasDb) await resetDb(); });
after(async () => { server?.close(); if (hasDb) await closeDb(); });

test("api needs the admin token", opts, async () => {
  assert.equal((await call("/tenants", { token: null })).status, 401);
  assert.equal((await call("/tenants", { token: "wrong" })).status, 401);
  assert.equal((await call("/tenants")).status, 200);
});

test("a new company can be set up and demoed end to end with no real phone", opts, async () => {
  assert.equal((await call("/tenants", { method: "POST", body: { slug: "acme", name: "Acme Builders" } })).status, 201);
  assert.equal((await call("/tenants", { method: "POST", body: { slug: "acme", name: "Again" } })).status, 409);

  // No phone yet: simulate refuses.
  assert.equal((await call("/t/acme/simulate", { method: "POST", body: { scenario: "lead_bathroom" } })).status, 400);
  // Planned connectors cannot be connected.
  assert.equal((await call("/t/acme/connectors/accounting/quickbooks", { method: "PUT", body: {} })).status, 400);

  assert.equal((await call("/t/acme/connectors/telephony/mock", { method: "PUT", body: {} })).status, 200);
  await call("/t/acme/settings", { method: "PUT", body: { mode: "shadow", confidenceThreshold: 0.7, shadowRecipientPhone: "(904) 555-0100", templates: { lead_callback: "Thanks {first_name}!" } } });

  for (const scenario of ["lead_bathroom", "solicitor_seo", "lead_roof_voicemail", "missed_hangup"]) {
    assert.equal((await call("/t/acme/simulate", { method: "POST", body: { scenario } })).status, 200);
  }
  await drain();

  const calls = (await call("/t/acme/interactions")).body;
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c: any) => c.caller_type).sort(), ["lead", "lead", "solicitor", "unknown"]);
  assert.equal((await call("/t/acme/leads")).body.length, 2);
  const tasks = (await call("/t/acme/tasks")).body;
  assert.equal(tasks.length, 3); // two lead callbacks and one review; solicitor makes none

  const texts = (await call("/t/acme/outbound")).body;
  assert.equal(texts.length, 4);
  assert.ok(texts.every((t: any) => t.mode === "shadow" && t.to_phone === "+19045550100"));

  const done = await call(`/t/acme/tasks/${tasks[0].id}`, { method: "PATCH", body: { status: "done" } });
  assert.equal(done.status, 200);
  assert.equal((await call("/t/acme/tasks")).body.length, 2);
  const summary = (await call("/t/acme/summary")).body;
  assert.deepEqual([summary.calls, summary.open_tasks, summary.open_leads], [4, 2, 2]);
});

test("simulated calls are refused when a real phone is connected", opts, async () => {
  await call("/tenants", { method: "POST", body: { slug: "real", name: "Real Co" } });
  await call("/t/real/connectors/telephony/mock", { method: "PUT", body: {} });
  await call("/t/real/connectors/telephony/quo", { method: "PUT", body: { apiKey: "secret-key" } });
  assert.equal((await call("/t/real/simulate", { method: "POST", body: { scenario: "lead_bathroom" } })).status, 400);
});

test("secrets are never returned, and settings are validated", opts, async () => {
  await call("/tenants", { method: "POST", body: { slug: "sec", name: "Secret Co" } });
  assert.equal((await call("/t/sec/connectors/telephony/quo", { method: "PUT", body: {} })).status, 400); // key required
  await call("/t/sec/connectors/telephony/quo", { method: "PUT", body: { apiKey: "super-secret", inboxPhoneNumberIds: "PN1, PN2" } });
  const list = (await call("/t/sec/connectors")).body;
  assert.deepEqual(list[0].secretsSet.sort(), ["apiKey", "signingKeys"]);
  assert.deepEqual(list[0].config.inboxPhoneNumberIds, ["PN1", "PN2"]);
  assert.equal(JSON.stringify(list).includes("super-secret"), false);

  const bad = await call("/t/sec/settings", { method: "PUT", body: { mode: "yolo", confidenceThreshold: 0.7, templates: {} } });
  assert.equal(bad.status, 400);
  const badPhone = await call("/t/sec/settings", { method: "PUT", body: { mode: "shadow", confidenceThreshold: 0.7, shadowRecipientPhone: "12", templates: {} } });
  assert.equal(badPhone.status, 400);
  const empty = await call("/t/sec/settings", { method: "PUT", body: { mode: "shadow", confidenceThreshold: 0.7, templates: { generic: "   " } } });
  assert.deepEqual(empty.body.templates, {});
});
