import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { offlineClassifier } from "../src/ai/offline";
import { parseQuoWebhook } from "../src/connectors/quo";
import { DEFAULT_TEMPLATES, TEMPLATE_INFO, TEMPLATE_KEYS } from "../src/copy";
import { closeDb, db } from "../src/lib/db";
import { runOne } from "../src/lib/queue";
import { ingestEvent } from "../src/pipeline/ingest";
import { renderTemplate } from "../src/pipeline/alerts";
import { handlers, type Deps } from "../src/pipeline/processCall";
import { permitAttention, runPermitNudges } from "../src/permits/nudges";
import { localDate } from "../src/subs/paperwork";
import { buildApp } from "../src/server";
import { telephonyFor } from "../src/tenants";
import { hasDb, makeTenant, quoEvent, resetDb } from "./helpers";

const opts = { skip: hasDb ? false : "DATABASE_URL not set" };

test("message wording follows the house rules", () => {
  assert.deepEqual(Object.keys(DEFAULT_TEMPLATES).sort(), [...TEMPLATE_KEYS].sort());
  for (const k of TEMPLATE_KEYS) {
    const info = TEMPLATE_INFO[k];
    const text = info.suggested;
    assert.ok(text.length <= 320, `${k} fits the 320 character limit`);
    assert.equal(/[-–—]/.test(text), false, `${k} has no hyphens or dashes`);
    assert.equal(/https?:|www\./i.test(text), false, `${k} has no links`);
    const used = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const v of used) assert.ok((info.vars as readonly string[]).includes(v), `${k} uses undeclared {${v}}`);
    assert.ok(used.includes("business"), `${k} says who it is from`);
    const full = renderTemplate(text, { first_name: "Tom", business: "World Construction", job: "Hendricks Kitchen", date: "Wednesday", missing: "W9 and certificate of insurance" });
    assert.ok(full.length <= 306, `${k} renders within two text segments (${full.length})`);
    assert.equal(/\{|\}/.test(full), false);
    const noName = renderTemplate(text, { business: "World Construction", job: "Hendricks Kitchen", date: "Wednesday", missing: "W9" });
    assert.equal(/Hi ,|\s,|\s\./.test(noName), false, `${k} reads cleanly with no name: ${noName}`);
    assert.match(noName, /^Hi,/);
  }
});

test("a company name ending in a full stop does not double it", () => {
  assert.equal(renderTemplate("Hi {first_name}, thanks for calling {business}. We got your message.", { first_name: "Tom", business: "World Construction Inc." }), "Hi Tom, thanks for calling World Construction Inc. We got your message.");
  assert.equal(renderTemplate("Calling {business}...", { business: "Acme" }), "Calling Acme..."); // a real ellipsis is left alone
});

test("permit attention rules", () => {
  const T = "2026-10-06";
  const a = (kind: any, status: any, due: string | null) => permitAttention({ kind, status, dueDate: due }, T);
  assert.equal(a("permit", "needed", "2026-10-20"), null);
  assert.deepEqual([a("permit", "applied", "2026-10-09")?.state, a("permit", "applied", "2026-10-09")?.why], ["soon", "due Friday"]);
  assert.equal(a("inspection", "scheduled", "2026-10-06")?.why, "due today");
  assert.equal(a("inspection", "scheduled", "2026-10-07")?.why, "due tomorrow");
  assert.equal(a("permit", "needed", "2026-10-03")?.why, "3 days overdue");
  assert.equal(a("permit", "needed", "2026-10-05")?.why, "1 day overdue");
  assert.equal(a("permit", "issued", "2026-10-01"), null); // done
  assert.equal(a("inspection", "passed", "2026-10-01"), null);
  assert.equal(a("permit", "needed", null), null); // no date, nothing to nudge on
  assert.equal(a("permit", "expired", null)?.state, "attention");
  assert.equal(a("inspection", "failed", null)?.state, "attention");
});

test("quo text media is carried through", () => {
  const e = parseQuoWebhook(Buffer.from(quoEvent("message.received", { id: "AC9", from: "+19045550133", to: ["+19047171729"], text: "", direction: "incoming", media: [{ url: "https://x.example/a.jpg", type: "image/jpeg" }, { nourl: true }] })));
  assert.deepEqual(e.kind === "message_received" && e.message.media, [{ url: "https://x.example/a.jpg", type: "image/jpeg" }]);
});

let tenantId: string;
process.env.ADMIN_TOKEN = "op-token";
const deps: Deps = { telephony: telephonyFor, classify: offlineClassifier() };
let server: ReturnType<ReturnType<typeof buildApp>["listen"]> | undefined;
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

test("a new company starts in shadow mode with the suggested wording", opts, async () => {
  assert.equal((await call("/tenants", "op-token", { method: "POST", body: { slug: "fresh", name: "Fresh Co" } })).status, 201);
  const s = (await call("/t/fresh/settings", "op-token")).body;
  assert.equal(s.mode, "shadow");
  assert.deepEqual(s.templates, DEFAULT_TEMPLATES);
  const meta = (await call("/meta", "op-token")).body;
  assert.equal(meta.product, "Heather");
  assert.equal(meta.templateInfo.schedule_confirm.suggested, TEMPLATE_INFO.schedule_confirm.suggested);
});

test("permits: nudges go to the job's PM once, renew when the date moves, and the API enforces the rules", opts, async () => {
  const op = "op-token";
  const pm = (await db().query<{ id: string }>("INSERT INTO users (tenant_id, name, role) VALUES ($1,'Pam PM','pm') RETURNING id", [tenantId])).rows[0].id;
  const job = (await db().query<{ id: string }>("INSERT INTO jobs (tenant_id, name, pm_user_id) VALUES ($1,'Hendricks Kitchen',$2) RETURNING id", [tenantId, pm])).rows[0].id;
  const day = (n: number) => localDate("America/New_York", new Date(), n);
  const count = async (like: string) => (await db().query("SELECT count(*)::int AS n FROM tasks WHERE title LIKE $1", [like])).rows[0].n;

  // The API runs the nudges as soon as something is saved, so a due tomorrow inspection gets its task at once.
  const insp = await call("/t/wci/permits", op, { method: "POST", body: { jobId: job, kind: "inspection", title: "Rough electrical", status: "scheduled", dueDate: day(1) } });
  assert.equal(insp.status, 201);
  const far = await call("/t/wci/permits", op, { method: "POST", body: { jobId: job, kind: "permit", title: "Building permit", dueDate: day(400) } });
  assert.equal((await call("/t/wci/permits", op, { method: "POST", body: { jobId: job, kind: "permit", title: "x", dueDate: "01/02/2026" } })).status, 400);

  const t = (await db().query("SELECT title, assignee_user_id FROM tasks WHERE type = 'inspection_due'")).rows;
  assert.deepEqual(t.map((x) => [x.title, x.assignee_user_id]), [["Inspection: Rough electrical at Hendricks Kitchen (due tomorrow)", pm]]);
  assert.equal(await runPermitNudges(tenantId, "America/New_York"), 0); // never twice
  assert.equal(await count("%Building permit%"), 0); // far off: quiet

  // The inspection moves: a new date earns a new task. It fails: attention right away. It passes: quiet.
  await call(`/t/wci/permits/${insp.body.id}`, op, { method: "PATCH", body: { dueDate: day(2) } });
  assert.equal(await count("%Rough electrical%"), 2);
  await call(`/t/wci/permits/${insp.body.id}`, op, { method: "PATCH", body: { status: "failed" } });
  assert.equal(await count("%Rough electrical%"), 3);
  assert.match((await db().query("SELECT body FROM tasks WHERE title LIKE '%Rough electrical%' ORDER BY created_at DESC LIMIT 1")).rows[0].body, /Fix the issues/);
  await call(`/t/wci/permits/${insp.body.id}`, op, { method: "PATCH", body: { status: "passed" } });
  assert.equal(await runPermitNudges(tenantId, "America/New_York"), 0);
  assert.equal(await count("%Rough electrical%"), 3);

  const list = (await call("/t/wci/permits", op)).body;
  assert.deepEqual(list.map((p: any) => p.title), ["Building permit", "Rough electrical"]); // open ones first
  assert.equal((await call(`/t/wci/permits/${far.body.id}`, op, { method: "DELETE" })).status, 200);

  await call("/t/wci/users", op, { method: "POST", body: { name: "Pat PM", email: "pat@wci.example", role: "pm", password: "pm-password-123" } });
  const pmToken = (await call("/login", null, { method: "POST", body: { email: "pat@wci.example", password: "pm-password-123" } })).body.token;
  assert.equal((await call("/t/wci/permits", pmToken)).status, 200);
  assert.equal((await call("/t/wci/permits", pmToken, { method: "POST", body: { jobId: job, kind: "permit", title: "Roof permit" } })).status, 201);
});

test("a photo from a sub we are chasing becomes a paperwork task with the attachment", opts, async () => {
  const sub = (await db().query<{ id: string }>("INSERT INTO contacts (tenant_id, type, first_name, company) VALUES ($1,'sub','Tom','Coastal Tile') RETURNING id", [tenantId])).rows[0].id;
  await db().query("INSERT INTO contact_phones (tenant_id, phone, contact_id) VALUES ($1,'+19045550133',$2)", [tenantId, sub]);
  await db().query("INSERT INTO sub_profiles (contact_id, w9_on_file, coi_expires_on) VALUES ($1, true, NULL)", [sub]); // needs the certificate
  const send = async (id: string, text: string, media: { url: string; type: string }[]) => {
    await ingestEvent(tenantId, "mock", { kind: "message_received", eventId: id, type: "message.received", message: { providerId: id, conversationId: null, phoneNumberId: "L", direction: "incoming", from: "+19045550133", to: "+19047171729", body: text, media, createdAt: null } }, {});
    await drain();
  };
  await send("M1", "", [{ url: "https://share.example/coi.jpg", type: "image/jpeg" }]);
  const tasks = (await call("/t/wci/tasks", "op-token")).body;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].type, "paperwork_received");
  assert.match(tasks[0].title, /Tom Coastal Tile sent a file \(we need: certificate of insurance\)|sent a file \(we need: certificate of insurance\)/);
  assert.equal(tasks[0].body, "(photo or file attached)");
  assert.deepEqual(tasks[0].media, [{ url: "https://share.example/coi.jpg", type: "image/jpeg" }]);
  // A photo from a sub with nothing outstanding is just a text.
  await db().query("UPDATE sub_profiles SET coi_expires_on = '2027-01-01'");
  await send("M2", "here's the pic", [{ url: "https://share.example/b.jpg", type: "image/jpeg" }]);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM tasks WHERE type = 'sub_text'")).rows[0].n, 1);
});
