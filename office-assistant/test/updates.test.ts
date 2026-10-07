import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { offlineClassifier } from "../src/ai/offline";
import type { EmailProvider } from "../src/connectors/types";
import { closeDb, db } from "../src/lib/db";
import { buildApp } from "../src/server";
import { getTenantById, telephonyFor } from "../src/tenants";
import { buildClientUpdates, renderBody, subjectFor } from "../src/updates/build";
import { matchJobByAddress, offlineEmailParser, type EmailParser } from "../src/updates/parse";
import { buildPermitReport, createPermitReportDraft, runPermitReportTick } from "../src/updates/permitReport";
import { sendDraft } from "../src/updates/send";
import { hasDb, makeTenant, resetDb } from "./helpers";

const opts = { skip: hasDb ? false : "DATABASE_URL not set" };

const MARK = `Hi Damien,

Weekly update:

157 Sea Marsh Rd - Lanctot
- Framing inspection passed Tuesday
- Roofing crew started, dried in by Thursday
- Next week: windows delivered and installed

1224 Wonderwood Dr
Demo finished. Electrical rough in done.
Next: insulation inspection on 10/14

3640 Newcomb Rd
Skip Newcomb this week, already sent to Austin.

88 Nowhere Ln
Slab poured.

Thanks,
Mark`;

test("job matching by address: house number plus first street word, never a guess between two", () => {
  const jobs = [
    { id: "1", name: "*157 Sea Marsh Rd- Lanctot", address: "157 Sea Marsh Rd, Jacksonville" },
    { id: "2", name: "1224 Wonderwood - McCormick - Retail roof", address: null },
    { id: "3", name: "12 Oak St", address: "12 Oak St" },
    { id: "4", name: "112 Oak St", address: "112 Oak St" },
    { id: "5", name: "9 Pine Rd Kitchen", address: "9 Pine Rd" },
    { id: "6", name: "9 Pine Rd Deck", address: "9 Pine Rd" },
  ];
  assert.deepEqual(matchJobByAddress("157 Sea Marsh Road", jobs), { job: jobs[0] });
  assert.deepEqual(matchJobByAddress("1224 Wonderwood Dr", jobs), { job: jobs[1] }); // address only in the job name
  assert.deepEqual(matchJobByAddress("12 Oak St", jobs), { job: jobs[2] }); // 112 Oak is a different house
  assert.deepEqual(matchJobByAddress("9 Pine Rd", jobs), { ambiguous: ["9 Pine Rd Kitchen", "9 Pine Rd Deck"] });
  assert.equal(matchJobByAddress("88 Nowhere Ln", jobs), null);
  assert.equal(matchJobByAddress("the Smith job", jobs), null);
});

test("the email body has the exact format", () => {
  const base = { firstName: "Anthony", intro: "A solid week on site.", progress: ["Framing passed inspection", "Roofing started"], upcoming: ["Windows installed next week"], signature: "Warm Regards,\nHeather", business: "World Construction Inc", closing: "Please let us know if you have any questions. Thank you again for choosing {business}." };
  assert.equal(renderBody(base), [
    "Hi Anthony,", "A solid week on site.",
    "This Week's Progress:\n• Framing passed inspection\n• Roofing started",
    "Upcoming Work:\n• Windows installed next week",
    "Please let us know if you have any questions. Thank you again for choosing World Construction Inc.",
    "Warm Regards,\nHeather",
  ].join("\n\n"));
  const bare = renderBody({ ...base, firstName: null, upcoming: [], signature: "" });
  assert.match(bare, /^Hello,/);
  assert.equal(bare.includes("Upcoming Work"), false);
  assert.equal(subjectFor("157 Sea Marsh Rd"), "Weekly Progress Update - 157 Sea Marsh Rd");
});

test("offline parser reads a realistic email: jobs, client hint, upcoming, skips, sign off", async () => {
  const p = await offlineEmailParser()({ text: MARK, business: "WCI" });
  assert.deepEqual(p.jobs.map((j) => [j.address, j.skip]), [["157 Sea Marsh Rd", false], ["1224 Wonderwood Dr", false], ["3640 Newcomb Rd", true], ["88 Nowhere Ln", false]]);
  assert.equal(p.jobs[0].client_name, "Lanctot");
  assert.deepEqual(p.jobs[0].progress, ["Framing inspection passed Tuesday", "Roofing crew started, dried in by Thursday"]);
  assert.deepEqual(p.jobs[0].upcoming, ["Windows delivered and installed"]);
  assert.deepEqual([p.jobs[1].progress, p.jobs[1].upcoming], [["Demo finished.", "Electrical rough in done."], ["Insulation inspection on 10/14"]]);
  assert.match(p.jobs[2].skip_reason ?? "", /Newcomb/i);
  assert.deepEqual(p.jobs[3].progress, ["Slab poured."]); // "Thanks, Mark" is not a note
});

let tenantId: string;
const mkTenant = (extra: Record<string, unknown> = {}) => makeTenant({
  weeklyUpdates: { cc: ["mark@wci.example", "damien@wci.example", "garry@wci.example"], closing: "Please let us know if you have any questions. Thank you again for choosing {business}.", signature: "Warm Regards,\nHeather\nOffice Manager", senders: ["mark@wci.example"] },
  ...extra,
});
async function seedJobs() {
  const anthony = (await db().query<{ id: string }>("INSERT INTO contacts (tenant_id, type, first_name, last_name, email) VALUES ($1,'client','Anthony','Lanctot','anthony@client.example') RETURNING id", [tenantId])).rows[0].id;
  const noEmail = (await db().query<{ id: string }>("INSERT INTO contacts (tenant_id, type, first_name, last_name) VALUES ($1,'client','Pat','McCormick') RETURNING id", [tenantId])).rows[0].id;
  await db().query("INSERT INTO jobs (tenant_id, name, address, client_contact_id) VALUES ($1,'*157 Sea Marsh Rd- Lanctot','157 Sea Marsh Rd, Jacksonville',$2), ($1,'1224 Wonderwood - McCormick - Retail roof',NULL,$3), ($1,'3640 Newcomb Rd - York',NULL,NULL)", [tenantId, anthony, noEmail]);
}
beforeEach(async () => { if (hasDb) { await resetDb(); tenantId = await mkTenant(); } });
after(async () => { server?.close(); if (hasDb) await closeDb(); });

test("drafts: one per client in the exact format, always cc'd, skips respected, problems flagged, no repeats", opts, async () => {
  await seedJobs();
  const tenant = await getTenantById(tenantId);
  const r = await buildClientUpdates(offlineEmailParser(), tenant, { text: MARK, source: "paste" });
  assert.deepEqual(r.drafted.map((d) => d.address), ["157 Sea Marsh Rd", "1224 Wonderwood Dr", "88 Nowhere Ln"]);
  assert.deepEqual(r.skipped.map((s) => s.address), ["3640 Newcomb Rd"]);

  const rows = (await db().query("SELECT address, to_emails, cc, subject, body, flags, status, job_id FROM update_drafts ORDER BY created_at, address")).rows;
  const sea = rows.find((x) => x.address === "157 Sea Marsh Rd");
  assert.equal(sea.subject, "Weekly Progress Update - 157 Sea Marsh Rd");
  assert.deepEqual(sea.to_emails, ["anthony@client.example"]);
  assert.deepEqual(sea.cc, ["mark@wci.example", "damien@wci.example", "garry@wci.example"]);
  assert.equal((sea.body as string).includes(".."), false); // the company name ends in "Inc." and the closing adds a full stop
  assert.match(sea.body, /^Hi Anthony,\n\nHere is where things stand on your project this week\.\n\nThis Week's Progress:\n• Framing inspection passed Tuesday\n• Roofing crew started, dried in by Thursday\n\nUpcoming Work:\n• Windows delivered and installed\n\nPlease let us know if you have any questions\. Thank you again for choosing World Construction Inc\.\n\nWarm Regards,\nHeather\nOffice Manager$/);
  assert.deepEqual(sea.flags, []);

  const wonder = rows.find((x) => x.address === "1224 Wonderwood Dr");
  assert.ok(wonder.flags.some((f: string) => /No client email/.test(f))); // matched the job, but no email on file
  assert.deepEqual(wonder.to_emails, []);
  assert.match(wonder.body, /^Hi Pat,/);

  const none = rows.find((x) => x.address === "88 Nowhere Ln");
  assert.ok(none.flags.some((f: string) => /Job not found/.test(f)));
  assert.equal(none.job_id, null);
  assert.equal(rows.find((x) => x.address === "3640 Newcomb Rd").status, "skipped");

  const again = await buildClientUpdates(offlineEmailParser(), tenant, { text: MARK, source: "paste" });
  assert.deepEqual([again.drafted.length, again.alreadyDone.length], [0, 3]); // this week is already handled
  const forced = await buildClientUpdates(offlineEmailParser(), tenant, { text: MARK, source: "paste" }, { force: true });
  assert.equal(forced.drafted.length, 3);
});

test("anything not in the notes is flagged: invented numbers, and internal remarks that were held back", opts, async () => {
  await seedJobs();
  const liar: EmailParser = async () => ({ jobs: [{ address: "157 Sea Marsh Rd", client_name: null, skip: false, skip_reason: null, intro: "Great week, 3 crews were on site.", progress: ["Framing passed inspection on 10/14"], upcoming: [], held_back: ["Client is slow to pay"] }] });
  await buildClientUpdates(liar, await getTenantById(tenantId), { text: "157 Sea Marsh Rd framing passed Tuesday", source: "paste" });
  const flags = (await db().query("SELECT flags FROM update_drafts")).rows[0].flags as string[];
  assert.ok(flags.some((f) => /Check these numbers or dates.*3.*10.*14/.test(f)));
  assert.ok(flags.some((f) => f === "Left out as internal: Client is slow to pay"));
});

const fakeEmail = (log: any[], fail = false): EmailProvider => ({ name: "fake", send: async (m) => { if (fail) throw new Error("smtp down"); log.push(m); return { id: `<id${log.length}@x>` }; } });

test("sending: only on approval, always cc's the office, never twice, failures can be retried", opts, async () => {
  await seedJobs();
  const tenant = await getTenantById(tenantId);
  await buildClientUpdates(offlineEmailParser(), tenant, { text: MARK, source: "paste" });
  const id = (await db().query("SELECT id FROM update_drafts WHERE address = '157 Sea Marsh Rd'")).rows[0].id;
  const none = await sendDraft(tenant, id, null, null);
  assert.deepEqual([none.ok, !none.ok && none.status], [false, 400]);
  const noTo = (await db().query("SELECT id FROM update_drafts WHERE address = '1224 Wonderwood Dr'")).rows[0].id;
  assert.equal((await sendDraft(tenant, noTo, null, fakeEmail([]))).ok, false); // no recipient

  // Someone removes the cc list from the draft. The office is copied anyway.
  await db().query("UPDATE update_drafts SET cc = '{}' WHERE id = $1", [id]);
  const log: any[] = [];
  assert.equal((await sendDraft(tenant, id, null, fakeEmail(log))).ok, true);
  assert.deepEqual([log[0].to, log[0].cc, log[0].subject], ["anthony@client.example", ["mark@wci.example", "damien@wci.example", "garry@wci.example"], "Weekly Progress Update - 157 Sea Marsh Rd"]);
  assert.equal((await db().query("SELECT status FROM update_drafts WHERE id = $1", [id])).rows[0].status, "sent");
  assert.equal((await sendDraft(tenant, id, null, fakeEmail(log))).ok, false); // double click
  assert.equal(log.length, 1);

  const retry = (await db().query("SELECT id FROM update_drafts WHERE address = '88 Nowhere Ln'")).rows[0].id;
  await db().query("UPDATE update_drafts SET to_emails = ARRAY['x@client.example'] WHERE id = $1", [retry]);
  const bad = await sendDraft(tenant, retry, null, fakeEmail([], true));
  assert.deepEqual([bad.ok, !bad.ok && bad.status], [false, 502]);
  assert.deepEqual((await db().query("SELECT status, error FROM update_drafts WHERE id = $1", [retry])).rows[0], { status: "failed", error: "smtp down" });
  assert.equal((await sendDraft(tenant, retry, null, fakeEmail(log))).ok, true); // retry works
  await db().query("UPDATE update_drafts SET status = 'draft', to_emails = ARRAY['not an email'] WHERE id = $1", [retry]);
  assert.equal((await sendDraft(tenant, retry, null, fakeEmail(log))).ok, false); // bad address caught
  assert.equal(log.length, 2);
});

// ---- permitting report ----

const P = (over: any) => ({ id: "p", jobName: "157 Sea Marsh Rd", kind: "permit", title: "Building permit", status: "applied", dueDate: null, reference: null, ...over });
test("permitting report: sections come from the records and the week's changes", () => {
  const today = "2026-10-09"; // Friday
  const at = (d: string) => new Date(d + "T15:00:00Z");
  const r = buildPermitReport({
    business: "World Construction Inc", fridayDate: today, today, signature: "Heather",
    permits: [
      P({ id: "a", title: "Roof permit", status: "expired" }),
      P({ id: "b", kind: "inspection", title: "Framing", status: "passed", jobName: "1224 Wonderwood Dr" }),
      P({ id: "c", kind: "inspection", title: "Rough electrical", status: "scheduled", dueDate: "2026-10-14", jobName: "1224 Wonderwood Dr" }),
      P({ id: "d", title: "Building permit", status: "applied", reference: "B-5521" }),
      P({ id: "e", kind: "inspection", title: "Final", status: "needed", dueDate: "2026-10-05" }),
    ],
    events: [
      { permitId: "b", fromStatus: "scheduled", toStatus: "passed", fromDue: null, toDue: null, createdAt: at("2026-10-06") },
      { permitId: "c", fromStatus: null, toStatus: "scheduled", fromDue: null, toDue: "2026-10-14", createdAt: at("2026-10-07") },
      { permitId: "d", fromStatus: "needed", toStatus: "applied", fromDue: null, toDue: null, createdAt: at("2026-09-20") }, // too old
    ],
  });
  assert.equal(r.subject, "Plans and Permitting Progress Report - October 9, 2026");
  assert.match(r.body, /^Hello,\n\nHere is this week's plans and permitting progress report for World Construction Inc\. Week ending Friday, October 9, 2026\./);
  assert.match(r.body, /NEEDS ATTENTION\n\n157 Sea Marsh Rd\n• Roof permit: Permit expired\. Renew it before work continues\.\n• Final inspection: needed, 4 days overdue/);
  assert.match(r.body, /WHAT CHANGED THIS WEEK\n\n1224 Wonderwood Dr\n• Framing inspection: scheduled to passed\n• Rough electrical inspection: added, scheduled, Oct 14/);
  assert.equal(r.body.includes("Building permit (#B-5521): applied for\n"), true); // old change is not "this week", so it sits under in progress
  assert.match(r.body, /STILL IN PROGRESS\n\n157 Sea Marsh Rd\n• Building permit \(#B-5521\): applied for/);
  assert.match(r.body, /COMING UP IN THE NEXT 14 DAYS\n\n1224 Wonderwood Dr\n• Rough electrical inspection: scheduled, Oct 14/);
  assert.ok(r.body.endsWith("\n\nHeather"));
  assert.equal(buildPermitReport({ business: "X", fridayDate: today, today, permits: [], events: [] }).empty, true);
});

async function seedPermit(title: string, status = "scheduled", due: string | null = null) {
  const job = (await db().query<{ id: string }>("INSERT INTO jobs (tenant_id, name) VALUES ($1,'1224 Wonderwood Dr') ON CONFLICT DO NOTHING RETURNING id", [tenantId])).rows[0]?.id
    ?? (await db().query<{ id: string }>("SELECT id FROM jobs WHERE tenant_id = $1 LIMIT 1", [tenantId])).rows[0].id;
  return (await db().query<{ id: string }>("INSERT INTO permits (tenant_id, job_id, kind, title, status, due_date) VALUES ($1,$2,'inspection',$3,$4,$5) RETURNING id", [tenantId, job, title, status, due])).rows[0].id;
}
const FRI = new Date("2026-10-09T14:00:00Z"); // Friday 10:00 New York
const TUE = new Date("2026-10-06T14:00:00Z");

test("permit schedule: reminder twice a week, report on Friday once, only when turned on", opts, async () => {
  await seedPermit("Rough electrical", "scheduled", "2026-10-14");
  assert.deepEqual(await runPermitReportTick(await getTenantById(tenantId), FRI), { checkTask: false, report: false }); // off by default
  await db().query("UPDATE tenants SET settings = settings || '{\"permitReport\":{\"enabled\":true,\"to\":[\"team@wci.example\"]}}'::jsonb WHERE id = $1", [tenantId]);
  const t = () => getTenantById(tenantId);

  assert.deepEqual(await runPermitReportTick(await t(), TUE), { checkTask: true, report: false });
  assert.deepEqual(await runPermitReportTick(await t(), TUE), { checkTask: false, report: false }); // once per day
  assert.deepEqual(await runPermitReportTick(await t(), new Date("2026-10-07T14:00:00Z")), { checkTask: false, report: false }); // Wednesday: nothing
  assert.equal((await runPermitReportTick(await t(), new Date("2026-10-08T14:00:00Z"))).checkTask, true); // Thursday
  assert.equal((await runPermitReportTick(await t(), new Date("2026-10-09T10:00:00Z"))).report, false); // Friday 6am: too early

  assert.deepEqual(await runPermitReportTick(await t(), FRI), { checkTask: false, report: true });
  assert.deepEqual(await runPermitReportTick(await t(), FRI), { checkTask: false, report: false }); // one per week
  const d = (await db().query("SELECT d.subject, d.to_emails, d.status, d.flags, b.week_of::text AS week_of, b.kind FROM update_drafts d JOIN update_batches b ON b.id = d.batch_id")).rows;
  assert.deepEqual(d.map((x) => [x.subject, x.to_emails, x.status, x.flags, x.week_of, x.kind]), [["Plans and Permitting Progress Report - October 9, 2026", ["team@wci.example"], "draft", [], "2026-10-09", "permits"]]);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM tasks WHERE type = 'permit_report_review'")).rows[0].n, 1);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM tasks WHERE type = 'permit_check'")).rows[0].n, 2);

  // Run on a Wednesday by hand: it drafts for the coming Friday, and flags missing recipients.
  await db().query("UPDATE tenants SET settings = jsonb_set(settings, '{permitReport,to}', '[]') WHERE id = $1", [tenantId]);
  const manual = await createPermitReportDraft(await t(), new Date("2026-10-14T14:00:00Z"), "paste");
  assert.deepEqual([manual.weekOf, manual.alreadyExists], ["2026-10-16", false]);
  assert.match((await db().query("SELECT flags FROM update_drafts WHERE id = $1", [manual.draftId])).rows[0].flags[0], /No recipients/);
});

// ---- API ----
process.env.ADMIN_TOKEN = "op-token";
let server: ReturnType<ReturnType<typeof buildApp>["listen"]> | undefined;
async function call(path: string, token: string | null, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  if (!server) server = buildApp({ telephony: telephonyFor, draft: undefined, parseEmail: offlineEmailParser() }).listen(0);
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
void offlineClassifier;

test("api: paste, edit, send through a connected email account, roles, permit history, inbound email", opts, async () => {
  await seedJobs();
  const op = "op-token";
  const made = await call("/t/wci/updates", op, { method: "POST", body: { text: MARK } });
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.drafted.length, made.body.skipped.length], [3, 1]);
  const list = (await call("/t/wci/updates", op)).body;
  const sea = list.find((d: any) => d.address === "157 Sea Marsh Rd");
  assert.deepEqual([sea.status, sea.job_name], ["draft", "*157 Sea Marsh Rd- Lanctot"]);

  assert.equal((await call(`/t/wci/updates/${sea.id}/send`, op, { method: "POST" })).status, 400); // no email account yet
  assert.equal((await call("/t/wci/connectors/email/demo_email", op, { method: "PUT", body: {} })).status, 200);
  assert.equal((await call(`/t/wci/updates/${sea.id}`, op, { method: "PATCH", body: { toEmails: ["nope"] } })).status, 400);
  assert.equal((await call(`/t/wci/updates/${sea.id}`, op, { method: "PATCH", body: { body: "Hi Anthony,\n\nEdited by a person." } })).status, 200);
  assert.equal((await call(`/t/wci/updates/${sea.id}/send`, op, { method: "POST" })).status, 200);
  assert.equal((await call(`/t/wci/updates/${sea.id}/send`, op, { method: "POST" })).status, 400);
  assert.equal((await call(`/t/wci/updates/${sea.id}`, op, { method: "PATCH", body: { body: "x" } })).status, 400); // sent: locked
  assert.equal((await call(`/t/wci/updates/${sea.id}`, op, { method: "DELETE" })).status, 400);
  const skipId = list.find((d: any) => d.address === "88 Nowhere Ln").id;
  assert.equal((await call(`/t/wci/updates/${skipId}`, op, { method: "PATCH", body: { status: "skipped" } })).status, 200);
  assert.equal((await call(`/t/wci/updates/${skipId}`, op, { method: "DELETE" })).status, 200);

  await call("/t/wci/users", op, { method: "POST", body: { name: "Pam PM", email: "pam@wci.example", role: "pm", password: "pm-password-123" } });
  const pm = (await call("/login", null, { method: "POST", body: { email: "pam@wci.example", password: "pm-password-123" } })).body.token;
  assert.equal((await call("/t/wci/updates", pm)).status, 403);

  // Permit changes are written to the history the Friday report reads.
  const job = (await db().query<{ id: string }>("SELECT id FROM jobs LIMIT 1")).rows[0].id;
  const permit = (await call("/t/wci/permits", op, { method: "POST", body: { jobId: job, kind: "inspection", title: "Framing", status: "scheduled", dueDate: "2099-01-01" } })).body.id;
  await call(`/t/wci/permits/${permit}`, op, { method: "PATCH", body: { status: "passed" } });
  await call(`/t/wci/permits/${permit}`, op, { method: "PATCH", body: { reference: "R1" } }); // not a status or date change
  const ev = (await db().query("SELECT from_status, to_status FROM permit_events ORDER BY id")).rows;
  assert.deepEqual(ev, [{ from_status: null, to_status: "scheduled" }, { from_status: "scheduled", to_status: "passed" }]);

  // Inbound email: needs the company's secret and an allowed sender.
  const tok = (await call("/t/wci/updates/inbound-token", op, { method: "POST" })).body;
  assert.ok(tok.token && /\/api\/inbound\/email\/wci$/.test(tok.url));
  const post = (h: Record<string, string>, body: any) => call("/inbound/email/wci", null, { method: "POST", body, headers: h });
  assert.equal((await post({}, { from: "mark@wci.example", text: MARK })).status, 401);
  assert.equal((await post({ "x-inbound-token": "wrong" }, { from: "mark@wci.example", text: MARK })).status, 401);
  assert.equal((await post({ "x-inbound-token": tok.token }, { from: "Random <stranger@spam.example>", text: MARK })).body.ignored !== undefined, true);
  const before = (await db().query("SELECT count(*)::int AS n FROM update_drafts")).rows[0].n;
  const ok = await post({ "x-inbound-token": tok.token }, { from: "Mark Smith <MARK@wci.example>", subject: "Progress Report 10/09", text: MARK.replace(/Sea Marsh/g, "Sea Marsh") });
  assert.equal(ok.status, 202);
  assert.deepEqual([ok.body.drafted, ok.body.skipped, ok.body.alreadyDone], [1, 1, 2]); // two are already handled; the one deleted earlier is drafted again
  assert.equal((await db().query("SELECT count(*)::int AS n FROM update_drafts")).rows[0].n, before + 2);
  // The token survives a settings save.
  const settings = (await call("/t/wci/settings", op)).body;
  await call("/t/wci/settings", op, { method: "PUT", body: { mode: "shadow", confidenceThreshold: 0.7, templates: {}, weeklyUpdates: { cc: ["a@wci.example"], closing: "Thanks.", signature: "", senders: ["mark@wci.example"] } } });
  assert.ok((await getTenantById(tenantId)).settings.weeklyUpdates?.inboundTokenHash);
  void settings;
});
