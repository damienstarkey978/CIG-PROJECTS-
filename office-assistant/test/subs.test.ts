import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { offlineClassifier } from "../src/ai/offline";
import { MockTelephony } from "../src/connectors/mock";
import { closeDb, db } from "../src/lib/db";
import { runOne } from "../src/lib/queue";
import { ingestEvent } from "../src/pipeline/ingest";
import { handlers, type Deps } from "../src/pipeline/processCall";
import { buildApp } from "../src/server";
import { dayName, inSendWindow, localDate, looksLikeMaterialRequest, paperworkNeeds, parseConfirmReply } from "../src/subs/paperwork";
import { runAutomation } from "../src/subs/automation";
import { getTenantById, telephonyFor } from "../src/tenants";
import { hasDb, makeTenant, resetDb } from "./helpers";

const opts = { skip: hasDb ? false : "DATABASE_URL not set" };
const NOW = new Date("2026-10-06T14:00:00Z"); // Tuesday 10:00 in New York

test("paperwork needs: missing, expired, expiring soon, lien waiver", () => {
  const t = new Date("2026-10-06T12:00:00Z");
  assert.deepEqual(paperworkNeeds({ w9OnFile: true, coiExpiresOn: "2027-06-01", lienWaiverStatus: "received" }, t), []);
  assert.deepEqual(paperworkNeeds({ w9OnFile: false, coiExpiresOn: null, lienWaiverStatus: "needed" }, t), ["W9", "certificate of insurance", "lien waiver"]);
  assert.deepEqual(paperworkNeeds({ w9OnFile: true, coiExpiresOn: "2026-09-30", lienWaiverStatus: null }, t), ["updated certificate of insurance (expired)"]);
  assert.deepEqual(paperworkNeeds({ w9OnFile: true, coiExpiresOn: "2026-10-20", lienWaiverStatus: null }, t), ["updated certificate of insurance (expires soon)"]);
});

test("reading replies: only clear yes or no counts", () => {
  for (const y of ["Yes", "yes!", "Yep", "ok", "Confirmed.", "we'll be there", "👍", "Y"]) assert.equal(parseConfirmReply(y), "confirmed", y);
  for (const n of ["No", "nope", "Can't make it", "cannot", "we won't be there tomorrow", "N"]) assert.equal(parseConfirmReply(n), "declined", n);
  for (const u of ["what time?", "yes but not till noon", "Who is this", "maybe", "ok but I can't"]) assert.equal(parseConfirmReply(u), "unclear", u);
  assert.equal(looksLikeMaterialRequest("need more tile at the Oak job"), true);
  assert.equal(looksLikeMaterialRequest("thanks see you then"), false);
});

test("send window and local dates follow the company's time zone", () => {
  assert.equal(inSendWindow("America/New_York", NOW), true); // Tue 10:00
  assert.equal(inSendWindow("America/New_York", new Date("2026-10-06T12:00:00Z")), false); // 08:00
  assert.equal(inSendWindow("America/New_York", new Date("2026-10-06T21:00:00Z")), false); // 17:00
  assert.equal(inSendWindow("America/New_York", new Date("2026-10-11T15:00:00Z")), false); // Sunday
  assert.equal(localDate("America/New_York", new Date("2026-10-07T02:00:00Z")), "2026-10-06"); // still Tuesday evening
  assert.equal(dayName("2026-10-07"), "Wednesday");
});

let tenantId: string;
const mock = new MockTelephony();
const CONFIRM = "Hi {first_name}, are you on site at {job} {date}? Reply YES or NO.";
const PAPER = "Hi {first_name}, please send your {missing} when you can.";

async function setup(settings: Record<string, unknown> = {}) {
  tenantId = await makeTenant({ outboundNumber: "+19047171729", templates: { schedule_confirm: CONFIRM, paperwork_request: PAPER }, ...settings });
  await db().query("INSERT INTO connector_accounts (tenant_id, kind, provider) VALUES ($1,'telephony','mock')", [tenantId]);
  const sub = (await db().query<{ id: string }>("INSERT INTO contacts (tenant_id, type, first_name, company) VALUES ($1,'sub','Tom','Coastal Tile') RETURNING id", [tenantId])).rows[0].id;
  await db().query("INSERT INTO contact_phones (tenant_id, phone, contact_id) VALUES ($1,'+19045550133',$2)", [tenantId, sub]);
  await db().query("INSERT INTO sub_profiles (contact_id, w9_on_file, coi_expires_on) VALUES ($1, false, NULL)", [sub]);
  const job = (await db().query<{ id: string }>("INSERT INTO jobs (tenant_id, name, address) VALUES ($1,'Hendricks Kitchen','12 Oak St, Jacksonville') RETURNING id", [tenantId])).rows[0].id;
  const assign = (await db().query<{ id: string }>("INSERT INTO job_assignments (tenant_id, job_id, sub_contact_id, scope, start_date) VALUES ($1,$2,$3,'Backsplash','2026-10-07') RETURNING id", [tenantId, job, sub])).rows[0].id;
  return { sub, job, assign };
}
const sent = async () => (await db().query("SELECT purpose, to_phone, body, mode FROM outbound_messages ORDER BY id")).rows;
const run = async (o: { now?: Date } = {}) => runAutomation(await getTenantById(tenantId), mock, { now: o.now ?? NOW });

const deps: Deps = { telephony: telephonyFor, classify: offlineClassifier() };
async function drain() {
  await db().query("UPDATE work_queue SET run_at = now() WHERE status = 'pending'");
  while (await runOne(handlers(deps))) {}
}
let n = 0;
async function textIn(from: string, text: string) {
  const id = `T${++n}`;
  await ingestEvent(tenantId, "mock", { kind: "message_received", eventId: id, type: "message.received", message: { providerId: id, conversationId: null, phoneNumberId: "L", direction: "incoming", from, to: "+19047171729", body: text, createdAt: null } }, {});
  await drain();
}

beforeEach(async () => { if (hasDb) await resetDb(); });
after(async () => { server?.close(); if (hasDb) await closeDb(); });

test("shadow mode texts no sub: one digest to the owner, nothing changes, no repeats", opts, async () => {
  const { assign } = await setup();
  const r = await run();
  assert.deepEqual([r.confirmRequests, r.paperworkRequests], [1, 1]);
  const out = await sent();
  assert.equal(out.length, 1);
  assert.equal(out[0].to_phone, "+19045550100"); // the shadow number, never the sub
  assert.match(out[0].body, /^\[SHADOW\]/);
  assert.match(out[0].body, /Would text Coastal Tile \(\(904\) 555-0133\): "Hi Tom, are you on site at Hendricks Kitchen Wednesday\? Reply YES or NO\."/);
  assert.match(out[0].body, /please send your W9 and certificate of insurance/);
  const a = (await db().query("SELECT confirmation_status, confirm_requested_at FROM job_assignments WHERE id = $1", [assign])).rows[0];
  assert.deepEqual([a.confirmation_status, a.confirm_requested_at], ["pending", null]);
  await run();
  assert.equal((await sent()).length, 1); // second pass: nothing new
});

test("without approved copy nothing is texted; live mode opens a task for the office instead", opts, async () => {
  await setup({ mode: "live", templates: {} });
  await run();
  assert.equal((await sent()).length, 0);
  const t = (await db().query("SELECT type, title FROM tasks")).rows;
  assert.deepEqual(t.map((x) => x.type), ["sub_confirm_manual"]);
  assert.match(t[0].title, /Confirm Coastal Tile for Hendricks Kitchen on 2026-10-07/);
});

test("live mode: texts the sub once, then handles a yes, and a no, and silence", opts, async () => {
  const { assign, sub, job } = await setup({ mode: "live" });
  const r = await run();
  assert.deepEqual([r.confirmRequests, r.paperworkRequests], [1, 1]);
  const out = await sent();
  assert.deepEqual(out.map((o) => [o.purpose, o.to_phone, o.mode]), [["sub_confirm", "+19045550133", "live"], ["sub_paperwork", "+19045550133", "live"]]);
  assert.equal(out[0].body, "Hi Tom, are you on site at Hendricks Kitchen Wednesday? Reply YES or NO.");
  await run();
  assert.equal((await sent()).length, 2); // never asked twice

  await textIn("+19045550133", "Yes!");
  assert.deepEqual((await db().query("SELECT confirmation_status, confirm_reply FROM job_assignments WHERE id = $1", [assign])).rows[0], { confirmation_status: "confirmed", confirm_reply: "Yes!" });
  assert.equal((await db().query("SELECT count(*)::int AS n FROM tasks")).rows[0].n, 0);

  // A second assignment that gets a no
  const job2 = (await db().query<{ id: string }>("INSERT INTO jobs (tenant_id, name) VALUES ($1,'Brooks Bath') RETURNING id", [tenantId])).rows[0].id;
  const a2 = (await db().query<{ id: string }>("INSERT INTO job_assignments (tenant_id, job_id, sub_contact_id, start_date) VALUES ($1,$2,$3,'2026-10-08') RETURNING id", [tenantId, job2, sub])).rows[0].id;
  await run();
  await textIn("+19045550133", "can't make it");
  assert.equal((await db().query("SELECT confirmation_status FROM job_assignments WHERE id = $1", [a2])).rows[0].confirmation_status, "declined");
  assert.match((await db().query("SELECT title FROM tasks WHERE type = 'sub_declined'")).rows[0].title, /can't make Brooks Bath/);

  // Silence: a third assignment, asked, never answered
  const job3 = (await db().query<{ id: string }>("INSERT INTO jobs (tenant_id, name) VALUES ($1,'Smith Deck') RETURNING id", [tenantId])).rows[0].id;
  const a3 = (await db().query<{ id: string }>("INSERT INTO job_assignments (tenant_id, job_id, sub_contact_id, start_date) VALUES ($1,$2,$3,'2026-10-08') RETURNING id", [tenantId, job3, sub])).rows[0].id;
  await run();
  await run({ now: new Date(NOW.getTime() + 60_000) }); // too soon to escalate
  assert.equal((await db().query("SELECT confirmation_status FROM job_assignments WHERE id = $1", [a3])).rows[0].confirmation_status, "pending");
  await db().query("UPDATE job_assignments SET confirm_requested_at = now() - interval '21 hours' WHERE id = $1", [a3]);
  const esc = await run();
  assert.equal(esc.escalations, 1);
  assert.equal((await db().query("SELECT confirmation_status FROM job_assignments WHERE id = $1", [a3])).rows[0].confirmation_status, "no_response");
  assert.match((await db().query("SELECT title FROM tasks WHERE type = 'sub_unconfirmed'")).rows[0].title, /Coastal Tile hasn't confirmed Smith Deck/);
  assert.equal((await run()).escalations, 0); // only once
  void job;
});

test("same day, two jobs: a bare yes is not guessed", opts, async () => {
  const { sub } = await setup({ mode: "live" });
  const job2 = (await db().query<{ id: string }>("INSERT INTO jobs (tenant_id, name) VALUES ($1,'Brooks Bath') RETURNING id", [tenantId])).rows[0].id;
  await db().query("INSERT INTO job_assignments (tenant_id, job_id, sub_contact_id, start_date) VALUES ($1,$2,$3,'2026-10-07')", [tenantId, job2, sub]);
  await run();
  await textIn("+19045550133", "yes");
  assert.equal((await db().query("SELECT count(*)::int AS n FROM job_assignments WHERE confirmation_status = 'confirmed'")).rows[0].n, 0);
  assert.equal((await db().query("SELECT type FROM tasks")).rows[0].type, "sub_reply_ambiguous");
});

test("paperwork: asked weekly, escalated to a person after three tries, never when complete", opts, async () => {
  const { sub } = await setup({ mode: "live", templates: { paperwork_request: PAPER } });
  await db().query("DELETE FROM job_assignments"); // paperwork alone, since the sub still has to be working or about to be paid
  await db().query("INSERT INTO job_assignments (tenant_id, job_id, sub_contact_id, start_date) SELECT $1, id, $2, '2026-10-20' FROM jobs", [tenantId, sub]);
  assert.equal((await run()).paperworkRequests, 1);
  assert.equal((await run()).paperworkRequests, 0); // asked this week already
  for (let i = 0; i < 2; i++) { await db().query("UPDATE nudges SET created_at = created_at - interval '8 days' WHERE kind = 'paperwork_request'"); await run(); }
  assert.equal((await db().query("SELECT count(*)::int AS n FROM nudges WHERE kind = 'paperwork_request'")).rows[0].n, 3);
  await db().query("UPDATE nudges SET created_at = created_at - interval '8 days' WHERE kind = 'paperwork_request'");
  assert.equal((await run()).escalations, 1);
  assert.match((await db().query("SELECT title FROM tasks WHERE type = 'sub_paperwork_stuck'")).rows[0].title, /still hasn't sent: W9, certificate of insurance/);
  await db().query("UPDATE sub_profiles SET w9_on_file = true, coi_expires_on = '2027-01-01'");
  await db().query("DELETE FROM nudges");
  assert.equal((await run()).paperworkRequests, 0); // complete: nothing to ask
});

test("outside the send window, or on Sunday, nothing runs", opts, async () => {
  await setup({ mode: "live" });
  assert.match((await run({ now: new Date("2026-10-06T23:00:00Z") })).skipped ?? "", /send window/);
  assert.match((await run({ now: new Date("2026-10-11T15:00:00Z") })).skipped ?? "", /send window/);
  assert.equal((await sent()).length, 0);
});

test("inbound texts: material requests find the job, strangers and clients get a task, nothing is auto answered", opts, async () => {
  const { job } = await setup({ mode: "live" });
  await textIn("+19045550133", "need more tile at Hendricks, ran out");
  const mat = (await db().query("SELECT type, job_id, title FROM tasks WHERE type = 'material_request'")).rows[0];
  assert.deepEqual([mat.job_id, mat.title], [job, "Tom Coastal Tile needs materials or help".replace("Tom Coastal Tile", "Tom") ]);
  await textIn("+19045550999", "hello who is this");
  assert.equal((await db().query("SELECT count(*)::int AS n FROM tasks WHERE type = 'sms_unknown'")).rows[0].n, 1);
  const c = (await db().query<{ id: string }>("INSERT INTO contacts (tenant_id, type, first_name) VALUES ($1,'client','Dana') RETURNING id", [tenantId])).rows[0].id;
  await db().query("INSERT INTO contact_phones (tenant_id, phone, contact_id) VALUES ($1,'+19045550888',$2)", [tenantId, c]);
  await textIn("+19045550888", "when are you starting?");
  assert.equal((await db().query("SELECT type FROM tasks WHERE type = 'client_text'")).rowCount, 1);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM interactions WHERE channel = 'sms' AND processed_at IS NULL")).rows[0].n, 0);
  assert.equal((await sent()).filter((s) => s.to_phone !== "+19045550133").length, 0); // no replies to strangers or clients
});

// ---- API ----
process.env.ADMIN_TOKEN = "op-token";
let server: ReturnType<ReturnType<typeof buildApp>["listen"]> | undefined;
async function call(path: string, token: string | null, init: { method?: string; body?: unknown } = {}) {
  if (!server) server = buildApp(deps).listen(0);
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

test("api: sub paperwork, schedule, roles, run now, demo texts only on the demo phone", opts, async () => {
  const { sub, job } = await setup({ mode: "shadow" });
  const op = "op-token";
  const subs = (await call("/t/wci/subs", op)).body;
  assert.deepEqual([subs.length, subs[0].company, subs[0].needs], [1, "Coastal Tile", ["W9", "certificate of insurance"]]);
  assert.equal((await call(`/t/wci/subs/${sub}`, op, { method: "PATCH", body: { w9OnFile: true, coiExpiresOn: "2027-03-01", lienWaiverStatus: "received", trades: ["Tile"] } })).status, 200);
  assert.deepEqual((await call("/t/wci/subs", op)).body[0].needs, []);
  assert.equal((await call(`/t/wci/subs/${sub}`, op, { method: "PATCH", body: { coiExpiresOn: "03/01/2027" } })).status, 400);

  const lookups = (await call("/t/wci/lookups", op)).body;
  assert.deepEqual([lookups.jobs.length, lookups.subs[0].name], [1, "Coastal Tile"]);
  const made = await call("/t/wci/schedule", op, { method: "POST", body: { jobId: job, subId: sub, scope: "Grout", startDate: "2099-01-05" } });
  assert.equal(made.status, 201);
  assert.equal((await call("/t/wci/schedule", op, { method: "POST", body: { jobId: job, subId: "00000000-0000-4000-8000-000000000000", startDate: "2099-01-05" } })).status, 400);
  const list = (await call("/t/wci/schedule", op)).body;
  assert.ok(list.some((a: any) => a.id === made.body.id && a.job_name === "Hendricks Kitchen" && a.sub_name === "Coastal Tile" && a.confirmation_status === "pending"));
  assert.equal((await call(`/t/wci/schedule/${made.body.id}`, op, { method: "PATCH", body: { confirmationStatus: "confirmed" } })).status, 200);
  assert.equal((await call(`/t/wci/schedule/${made.body.id}`, op, { method: "DELETE" })).status, 200);

  assert.deepEqual((await call("/t/wci/automation/run", op, { method: "POST" })).body.skipped, undefined); // shadow ignores the window
  assert.equal((await call("/t/wci/simulate-text", op, { method: "POST", body: { from: "(904) 555-0133", text: "need more tile" } })).status, 200);
  await drain();
  assert.equal((await db().query("SELECT count(*)::int AS n FROM tasks WHERE type = 'material_request'")).rows[0].n, 1);

  await db().query("INSERT INTO connector_accounts (tenant_id, kind, provider, secrets_enc) VALUES ($1,'telephony','quo', NULL)", [tenantId]);
  assert.equal((await call("/t/wci/simulate-text", op, { method: "POST", body: { from: "(904) 555-0133", text: "x" } })).status, 400);

  await call("/t/wci/users", op, { method: "POST", body: { name: "Pam PM", email: "pam@wci.example", role: "pm", password: "pm-password-123" } });
  const pm = (await call("/login", null, { method: "POST", body: { email: "pam@wci.example", password: "pm-password-123" } })).body.token;
  assert.equal((await call("/t/wci/subs", pm)).status, 403); // paperwork is owner and office
  assert.equal((await call("/t/wci/schedule", pm)).status, 200); // but a PM runs the schedule
  assert.equal((await call("/t/wci/automation/run", pm, { method: "POST" })).status, 403);
});
