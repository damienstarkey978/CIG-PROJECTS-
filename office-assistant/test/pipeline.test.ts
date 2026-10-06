import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Classification } from "../src/ai/classify";
import { closeDb, db } from "../src/lib/db";
import { runOne } from "../src/lib/queue";
import { handlers, type Deps } from "../src/pipeline/processCall";
import { buildApp } from "../src/server";
import { callObject, classification, FakeTelephony, hasDb, makeTenant, quoEvent, resetDb, sign } from "./helpers";

const opts = { skip: hasDb ? false : "DATABASE_URL not set" };

let tel: FakeTelephony;
let next: Classification;
let classifyCalls = 0;
const deps: Deps = {
  telephony: async () => tel,
  classify: async () => {
    classifyCalls++;
    return next;
  },
};

let server: ReturnType<ReturnType<typeof buildApp>["listen"]> | undefined;
async function post(body: string, header = sign(body)) {
  if (!server) server = buildApp(deps).listen(0);
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}/webhooks/quo/wci`, { method: "POST", headers: { "openphone-signature": header, "content-type": "application/json" }, body });
}

/** Runs all queue work that is due now (pulling scheduled items forward). */
async function drain() {
  await db().query("UPDATE work_queue SET run_at = now() WHERE status = 'pending'");
  while (await runOne(handlers(deps))) {}
}

beforeEach(async () => {
  if (!hasDb) return;
  await resetDb();
  tel = new FakeTelephony();
  next = classification();
  classifyCalls = 0;
});

after(async () => {
  server?.close();
  if (hasDb) await closeDb();
});

test("rejects bad signatures and unknown tenants", opts, async () => {
  await makeTenant();
  const body = quoEvent("call.completed", callObject());
  assert.equal((await post(body, "hmac;1;1;bad")).status, 401);
  const { port } = server!.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/webhooks/quo/nobody`, { method: "POST", body });
  assert.equal(res.status, 404);
});

test("lead call in shadow mode: records written, only the shadow report is texted", opts, async () => {
  await makeTenant({ templates: { lead_callback: "Thanks {first_name}, {company} will call you back today." } });
  assert.equal((await post(quoEvent("call.completed", callObject()))).status, 200);
  assert.equal(
    (await post(quoEvent("call.transcript.completed", { callId: "AC1", dialogue: [{ content: "I need a kitchen remodel quote", identifier: "+19045551234" }] })))
      .status,
    200,
  );
  await drain();

  const i = (await db().query("SELECT * FROM interactions")).rows[0];
  assert.equal(i.caller_type, "lead");
  assert.ok(i.processed_at);
  assert.equal((await db().query("SELECT * FROM leads")).rows[0].job_type, "kitchen remodel");
  assert.equal((await db().query("SELECT * FROM tasks")).rows[0].type, "lead_callback");
  const contact = (await db().query("SELECT c.* FROM contacts c JOIN contact_phones p ON p.contact_id = c.id WHERE p.phone = '+19045551234'")).rows[0];
  assert.deepEqual([contact.type, contact.first_name, contact.last_name], ["prospect", "Jane", "Smith"]);

  assert.equal(tel.sent.length, 1);
  assert.equal(tel.sent[0].to, "+19045550100");
  assert.equal(tel.sent[0].from, "+19047171729");
  assert.match(tel.sent[0].body, /^\[SHADOW\] NEW LEAD/);
  assert.match(tel.sent[0].body, /Thanks Jane, World Construction Inc\. will call you back today\./);
  assert.equal(classifyCalls, 1);
});

test("duplicate webhook deliveries are processed once", opts, async () => {
  await makeTenant();
  const evt = quoEvent("call.completed", callObject({ status: "missed", answeredAt: null }));
  await post(evt);
  await post(evt);
  await drain();
  assert.equal((await db().query("SELECT count(*)::int AS n FROM webhook_events")).rows[0].n, 1);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM interactions")).rows[0].n, 1);
  assert.equal(tel.sent.length, 1);
});

test("missed call with no voicemail skips the model and asks for review", opts, async () => {
  await makeTenant();
  await post(quoEvent("call.completed", callObject({ status: "missed", answeredAt: null })));
  await drain();
  const i = (await db().query("SELECT * FROM interactions")).rows[0];
  assert.equal(i.caller_type, "unknown");
  assert.equal(classifyCalls, 0);
  assert.equal((await db().query("SELECT type FROM tasks")).rows[0].type, "review_call");
});

test("answered call waits for its transcript instead of guessing", opts, async () => {
  await makeTenant();
  await post(quoEvent("call.completed", callObject()));
  await drain();
  const q = (await db().query("SELECT status, attempts, run_at > now() AS later FROM work_queue")).rows[0];
  assert.deepEqual([q.status, q.attempts, q.later], ["pending", 0, true]);
  assert.equal(classifyCalls, 0);
  assert.equal(tel.sent.length, 0);
});

test("transcript before call.completed: fetches the call, then processes", opts, async () => {
  await makeTenant();
  tel.calls.set("AC7", { providerId: "AC7", conversationId: null, phoneNumberId: "PN", direction: "incoming", from: "+19045559999", to: "+19047171729", status: "completed", startedAt: new Date().toISOString(), durationSec: 30, answeredBy: "ai_agent", voicemail: null });
  tel.transcripts.set("AC7", [{ identifier: "+19045559999", userId: null, text: "We do SEO for contractors", start: 0 }]);
  next = classification({ caller_type: "solicitor", confidence: 0.97, caller_name: null });
  await post(quoEvent("call.transcript.completed", { callId: "AC7", dialogue: [{ content: "We do SEO for contractors", identifier: "+19045559999" }] }));
  await drain();
  const i = (await db().query("SELECT * FROM interactions WHERE provider_id = 'AC7'")).rows[0];
  assert.equal(i.caller_type, "solicitor");
  assert.equal((await db().query("SELECT type FROM contacts")).rows[0].type, "solicitor");
  assert.equal((await db().query("SELECT count(*)::int AS n FROM tasks")).rows[0].n, 0);
});

test("live mode: follow up only with approved copy, alerts go to staff", opts, async () => {
  const tenantId = await makeTenant({ mode: "live" });
  await db().query("INSERT INTO users (tenant_id, name, phone, role) VALUES ($1, 'Office', '+19045550200', 'office')", [tenantId]);
  await post(quoEvent("call.completed", callObject({ voicemail: null })));
  await post(quoEvent("call.transcript.completed", { callId: "AC1", dialogue: [{ content: "quote please", identifier: "+19045551234" }] }));
  await drain();
  assert.deepEqual(tel.sent.map((s) => s.to), ["+19045550200"]); // no template, so the caller gets nothing
  assert.match(tel.sent[0].body, /^NEW LEAD: \(904\) 555-1234 Jane Smith/);
  const out = (await db().query("SELECT purpose, mode FROM outbound_messages")).rows;
  assert.deepEqual(out, [{ purpose: "office_alert", mode: "live" }]);
});

test("known sub calling is routed as sub/vendor and linked to the contact", opts, async () => {
  const tenantId = await makeTenant();
  const c = await db().query<{ id: string }>("INSERT INTO contacts (tenant_id, type, first_name, company) VALUES ($1,'sub','Mike','Tile Pros') RETURNING id", [tenantId]);
  await db().query("INSERT INTO contact_phones (tenant_id, phone, contact_id) VALUES ($1,'+19045551234',$2)", [tenantId, c.rows[0].id]);
  next = classification({ caller_type: "lead", confidence: 0.4 });
  await post(quoEvent("call.completed", callObject()));
  await post(quoEvent("call.transcript.completed", { callId: "AC1", dialogue: [{ content: "need more tile at the Oak job", identifier: "+19045551234" }] }));
  await drain();
  const i = (await db().query("SELECT caller_type, contact_id FROM interactions")).rows[0];
  assert.deepEqual([i.caller_type, i.contact_id], ["sub_vendor", c.rows[0].id]);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM leads")).rows[0].n, 0);
});

test("inbound texts are logged", opts, async () => {
  await makeTenant();
  await post(quoEvent("message.received", { id: "AC50", from: "+19045551234", to: ["+19047171729"], text: "running late", direction: "incoming" }));
  const i = (await db().query("SELECT channel, body FROM interactions")).rows[0];
  assert.deepEqual(i, { channel: "sms", body: "running late" });
});
