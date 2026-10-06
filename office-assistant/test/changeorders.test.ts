import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { offlineClassifier } from "../src/ai/offline";
import { changeOrderTotal, enforceNoInvention, offlineDrafter, type Draft, type Drafter } from "../src/changeorders/draft";
import { closeDb, db } from "../src/lib/db";
import { runOne } from "../src/lib/queue";
import { ingestEvent } from "../src/pipeline/ingest";
import { handlers, type Deps } from "../src/pipeline/processCall";
import { buildApp } from "../src/server";
import { telephonyFor } from "../src/tenants";
import { hasDb, makeTenant, resetDb } from "./helpers";

const opts = { skip: hasDb ? false : "DATABASE_URL not set" };
const draft = (over: Partial<Draft> = {}): Draft => ({ title: "t", description: "d", items: [], amount: null, schedule_days: null, questions: [], ...over });

test("totals: stated amount wins, else fully priced items, else nothing", () => {
  assert.equal(changeOrderTotal([], 1800), 1800);
  assert.equal(changeOrderTotal([{ description: "a", quantity: 6, unit: null, unitPrice: 300 }, { description: "b", quantity: null, unit: null, unitPrice: 50 }], null), 1850);
  assert.equal(changeOrderTotal([{ description: "a", quantity: 6, unit: null, unitPrice: null }], null), null);
  assert.equal(changeOrderTotal([], null), null);
});

test("the guard drops any number that was not in the source text", () => {
  const src = "Add 6 recessed lights in the kitchen for $1,800, adds 2 days";
  const bad = enforceNoInvention(draft({ items: [{ description: "Lights", quantity: 8, unit: "each", unit_price: 300 }], amount: 2400, schedule_days: 5 }), src);
  assert.deepEqual([bad.items[0].quantity, bad.items[0].unit_price, bad.amount, bad.schedule_days], [null, null, null, null]);
  assert.ok(bad.questions.some((q) => /price/i.test(q)));
  const good = enforceNoInvention(draft({ items: [{ description: "Lights", quantity: 6, unit: "each", unit_price: null }], amount: 1800, schedule_days: 2 }), src);
  assert.deepEqual([good.items[0].quantity, good.amount, good.schedule_days, good.questions], [6, 1800, 2, []]);
  // A total that is the sum of stated unit prices is allowed even though the sum itself was never written.
  const sum = enforceNoInvention(draft({ items: [{ description: "a", quantity: 2, unit: null, unit_price: 100 }, { description: "b", quantity: 1, unit: null, unit_price: 50 }], amount: 250 }), "2 at 100 each and 1 for 50");
  assert.equal(sum.amount, 250);
});

test("offline drafter: prices, days, and missing price questions", async () => {
  const d = await offlineDrafter()({ text: "Add 6 recessed lights in the kitchen, $1,800, adds 2 days", companyName: "Co", jobName: "Hendricks Kitchen", address: null });
  assert.deepEqual([d.title, d.amount, d.schedule_days, d.items.length, d.questions], ["Add 6 recessed lights in the kitchen", 1800, 2, 1, []]);
  const noPrice = await offlineDrafter()({ text: "Move the outlet and add a second sink", companyName: "Co", jobName: "x", address: null });
  assert.deepEqual([noPrice.amount, noPrice.questions, noPrice.items.map((i) => i.description)], [null, ["What is the price?"], ["Move the outlet", "Add a second sink"]]);
});

const fake: Drafter = async (i) => draft({ title: "Add recessed lights", description: `Extra work: ${i.text}`, items: [{ description: "Recessed lights", quantity: 6, unit: "each", unit_price: null }], questions: ["What is the price?"] });
const deps: Deps = { telephony: telephonyFor, classify: offlineClassifier(), draft: fake };
process.env.ADMIN_TOKEN = "op-token";
let server: ReturnType<ReturnType<typeof buildApp>["listen"]> | undefined;
let tenantId: string;
async function call(path: string, token: string | null, init: { method?: string; body?: unknown } = {}) {
  if (!server) server = buildApp(deps).listen(0);
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function drain() {
  await db().query("UPDATE work_queue SET run_at = now() WHERE status = 'pending'");
  while (await runOne(handlers(deps))) {}
}
beforeEach(async () => { if (hasDb) { await resetDb(); tenantId = await makeTenant(); } });
after(async () => { server?.close(); if (hasDb) await closeDb(); });

const op = "op-token";
const mkJob = async (name: string, address: string | null = null) => (await db().query<{ id: string }>("INSERT INTO jobs (tenant_id, name, address) VALUES ($1,$2,$3) RETURNING id", [tenantId, name, address])).rows[0].id;

test("change orders: drafts number per job, edits, price gate, status flow, and who can do what", opts, async () => {
  const j1 = await mkJob("Hendricks Kitchen"), j2 = await mkJob("Brooks Bath");
  assert.equal((await call("/t/wci/change-orders", op, { method: "POST", body: { jobId: j1, text: "hi" } })).status, 400); // too short
  const [a, b] = await Promise.all([1, 2].map(() => call("/t/wci/change-orders", op, { method: "POST", body: { jobId: j1, text: "Add 6 recessed lights in the kitchen" } })));
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.deepEqual([a.body.label, b.body.label].sort(), ["CO-1", "CO-2"]); // simultaneous drafts never share a number
  const other = await call("/t/wci/change-orders", op, { method: "POST", body: { jobId: j2, text: "Swap the vanity for a double vanity" } });
  assert.equal(other.body.label, "CO-1"); // numbering is per job
  assert.deepEqual([a.body.status, a.body.total, a.body.questions], ["draft", null, ["What is the price?"]]);

  const id = a.body.id;
  assert.equal((await call(`/t/wci/change-orders/${id}`, op, { method: "PATCH", body: { status: "sent" } })).status, 400); // no price yet
  const priced = await call(`/t/wci/change-orders/${id}`, op, { method: "PATCH", body: { title: "Kitchen recessed lights", items: [{ description: "Recessed lights", quantity: 6, unit: "each", unitPrice: 300 }], questions: [] } });
  assert.deepEqual([priced.body.title, priced.body.total, priced.body.questions], ["Kitchen recessed lights", 1800, []]); // 6 x 300, no total typed
  const sent = await call(`/t/wci/change-orders/${id}`, op, { method: "PATCH", body: { status: "sent" } });
  assert.equal(sent.body.status, "sent");
  assert.equal((await call(`/t/wci/change-orders/${id}`, op, { method: "PATCH", body: { title: "changed" } })).status, 400); // locked once sent
  assert.equal((await call(`/t/wci/change-orders/${id}`, op, { method: "DELETE" })).status, 400);
  assert.equal((await call(`/t/wci/change-orders/${id}`, op, { method: "PATCH", body: { status: "draft" } })).status, 400);
  assert.equal((await call(`/t/wci/change-orders/${id}`, op, { method: "PATCH", body: { status: "approved" } })).body.status, "approved");
  assert.equal((await call(`/t/wci/change-orders/${id}`, op, { method: "PATCH", body: { status: "void" } })).status, 400); // approved is final

  assert.equal((await call(`/t/wci/change-orders/${other.body.id}`, op, { method: "DELETE" })).status, 200); // a draft can go
  assert.equal((await call("/t/wci/change-orders?status=approved", op)).body.length, 1);

  await call("/t/wci/users", op, { method: "POST", body: { name: "Pam PM", email: "pam@wci.example", role: "pm", password: "pm-password-123" } });
  const pm = (await call("/login", null, { method: "POST", body: { email: "pam@wci.example", password: "pm-password-123" } })).body.token;
  assert.equal((await call("/t/wci/change-orders", pm)).status, 200);
  assert.equal((await call("/t/wci/change-orders", pm, { method: "POST", body: { jobId: j2, text: "Add a niche in the shower" } })).status, 201);
});

async function textIn(from: string, text: string) {
  const id = `CO${Math.random().toString(36).slice(2)}`;
  await ingestEvent(tenantId, "mock", { kind: "message_received", eventId: id, type: "message.received", message: { providerId: id, conversationId: null, phoneNumberId: "L", direction: "incoming", from, to: "+19047171729", body: text, createdAt: null } }, {});
  await drain();
}

test("a project manager can text a change order; unplaced ones become tasks; ordinary words are not mistaken for it", opts, async () => {
  const job = await mkJob("Hendricks Kitchen", "12 Oak St, Jacksonville");
  await mkJob("Brooks Bath");
  await db().query("INSERT INTO connector_accounts (tenant_id, kind, provider) VALUES ($1,'telephony','mock')", [tenantId]);
  const pm = (await db().query<{ id: string }>("INSERT INTO users (tenant_id, name, phone, role) VALUES ($1,'Pam PM','+19045550777','pm') RETURNING id", [tenantId])).rows[0].id;

  await textIn("+19045550777", "Change order: add 6 recessed lights in the Hendricks kitchen");
  const cos = (await call("/t/wci/change-orders", op)).body;
  assert.deepEqual([cos.length, cos[0].jobId, cos[0].source, cos[0].status], [1, job, "text", "draft"]);
  const t = (await db().query("SELECT type, title, assignee_user_id FROM tasks")).rows;
  assert.deepEqual(t.map((x) => [x.type, x.title.startsWith("Review change order CO-1 for Hendricks Kitchen"), x.assignee_user_id]), [["change_order_review", true, pm]]);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM outbound_messages")).rows[0].n, 0); // shadow mode: no ack text

  await textIn("+19045550777", "co add a heated floor, $900"); // no job named
  assert.equal((await db().query("SELECT count(*)::int AS n FROM tasks WHERE type = 'change_order_unplaced'")).rows[0].n, 1);
  assert.equal((await call("/t/wci/change-orders", op)).body.length, 1); // nothing was guessed

  await textIn("+19045550777", "Contact the tile guy about Hendricks"); // starts with "Co" but is not the command
  assert.equal((await call("/t/wci/change-orders", op)).body.length, 1);

  await textIn("+19045550999", "change order add a deck at Hendricks"); // not staff: just a text from a stranger
  assert.equal((await call("/t/wci/change-orders", op)).body.length, 1);
  const count = async (type: string) => (await db().query("SELECT count(*)::int AS n FROM tasks WHERE type = $1", [type])).rows[0].n;
  assert.deepEqual([await count("sms_unknown"), await count("staff_text")], [1, 1]); // the stranger, and Pam's ordinary text
});

test("live mode: the staff member gets a short confirmation text", opts, async () => {
  await db().query("UPDATE tenants SET settings = settings || '{\"mode\":\"live\",\"outboundNumber\":\"+19047171729\"}'::jsonb WHERE id = $1", [tenantId]);
  await mkJob("Hendricks Kitchen");
  await db().query("INSERT INTO connector_accounts (tenant_id, kind, provider) VALUES ($1,'telephony','mock')", [tenantId]);
  await db().query("INSERT INTO users (tenant_id, name, phone, role) VALUES ($1,'Pam PM','+19045550777','pm')", [tenantId]);
  await textIn("+19045550777", "change order Hendricks add a pantry shelf $250");
  const sent = (await db().query("SELECT to_phone, body FROM outbound_messages")).rows;
  assert.deepEqual(sent, [{ to_phone: "+19045550777", body: "Draft CO-1 for Hendricks Kitchen is saved. Review it in the app before it goes to the client." }]);
});
