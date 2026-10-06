import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mapColumns, parseCsv, splitName } from "../src/import/csv";
import { importContacts } from "../src/import/contacts";
import { importJobs, mapJobStatus } from "../src/import/jobs";
import { closeDb, db } from "../src/lib/db";
import { hasDb, makeTenant, resetDb } from "./helpers";

const opts = { skip: hasDb ? false : "DATABASE_URL not set" };
let tenantId: string;
beforeEach(async () => { if (hasDb) { await resetDb(); tenantId = await makeTenant(); } });
after(async () => { if (hasDb) await closeDb(); });

const subsCsv = `Name,Company,Email,Phone,Trade,Internal Code
"Alvarez, Mike",Coastal Tile,mike@coastaltile.example,(904) 555-0133,Tile; Flooring,X1
Sam Roy,Roy Electric,sam@royelectric.example,904.555.0144,Electrical,X2
,,,,,
Pat Lee,,,not a phone,Plumbing,X3
`;

test("csv parsing handles BOM, semicolons, and header variants", () => {
  const p = parseCsv("﻿Job Name;Start Date\nKitchen;1/2/2026\n");
  assert.deepEqual(p.headers, ["job name", "start date"]);
  assert.equal(p.rows[0]["job name"], "Kitchen");
  assert.deepEqual(splitName("Alvarez, Mike"), { first: "Mike", last: "Alvarez", label: null });
  assert.deepEqual(splitName("Mary Ann Smith"), { first: "Mary", last: "Ann Smith", label: null });
  assert.deepEqual(splitName("2935 Lakeshore Blvd"), { first: null, last: null, label: "2935 Lakeshore Blvd" });
  assert.deepEqual(splitName("Adonis -"), { first: "Adonis", last: null, label: null });
  assert.throws(() => parseCsv("only header\n"), /header row/);
  const { map, ignored } = mapColumns(["trade partner", "mobile", "zzz"], { company: ["company", "trade partner"], phone: ["phone", "mobile"] });
  assert.deepEqual([map.company, map.phone, ignored], ["trade partner", "mobile", ["zzz"]]);
});

test("contacts: preview saves nothing, import creates subs with trades, rerun is a no op", opts, async () => {
  const preview = await importContacts(tenantId, subsCsv, { defaultType: "sub", dryRun: true });
  assert.deepEqual([preview.dryRun, preview.created, preview.skipped], [true, 3, 0]);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM contacts")).rows[0].n, 0);
  assert.ok(preview.columns.ignored.includes("internal code"));
  assert.ok(preview.warnings.some((w) => /1 phone number/.test(w)));

  const real = await importContacts(tenantId, subsCsv, { defaultType: "sub", dryRun: false });
  assert.deepEqual([real.created, real.updated], [3, 0]);
  const mike = (await db().query(
    "SELECT c.*, s.trades, (SELECT phone FROM contact_phones WHERE contact_id = c.id) AS phone FROM contacts c JOIN sub_profiles s ON s.contact_id = c.id WHERE c.first_name = 'Mike'",
  )).rows[0];
  assert.deepEqual([mike.last_name, mike.company, mike.type, mike.phone, mike.trades.sort()], ["Alvarez", "Coastal Tile", "sub", "+19045550133", ["Flooring", "Tile"]]);

  const again = await importContacts(tenantId, subsCsv, { defaultType: "sub", dryRun: false });
  assert.deepEqual([again.created, again.updated, again.unchanged], [0, 0, 3]);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM contacts")).rows[0].n, 3);
});

test("contacts: matches an existing person by phone in any format and fills only blanks", opts, async () => {
  const c = await db().query<{ id: string }>("INSERT INTO contacts (tenant_id, type, first_name, last_name) VALUES ($1,'other','Mike','A') RETURNING id", [tenantId]);
  await db().query("INSERT INTO contact_phones (tenant_id, phone, contact_id) VALUES ($1,'+19045550133',$2)", [tenantId, c.rows[0].id]);
  const r = await importContacts(tenantId, "Name,Company,Phone\nMichael Alvarez,Coastal Tile,904-555-0133\n", { defaultType: "sub", dryRun: false });
  assert.deepEqual([r.created, r.updated], [0, 1]);
  const row = (await db().query("SELECT * FROM contacts")).rows[0];
  assert.deepEqual([row.first_name, row.last_name, row.company, row.type], ["Mike", "A", "Coastal Tile", "sub"]); // name kept, blank company filled, type upgraded
});

test("contacts: an unusable file explains itself", opts, async () => {
  await assert.rejects(importContacts(tenantId, "Foo,Bar\n1,2\n", { defaultType: "sub", dryRun: true }), /name or company column/);
});

const jobsCsv = `Job Name,Address,Client,Job Status,Start Date,End Date
Hendricks Kitchen,12 Oak St,"Hendricks, Dana",In Progress,03/01/2026,05/15/2026
Brooks Bath,4410 Riverside Ave,Dana Brooks,Completed,not a date,
,,,,,
`;

test("jobs: creates jobs and clients, maps status, rerun adds nothing", opts, async () => {
  const preview = await importJobs(tenantId, jobsCsv, { dryRun: true });
  assert.deepEqual([preview.created, preview.skipped], [2, 0]);
  assert.ok(preview.warnings.some((w) => /1 job\(s\) had a date/.test(w)));
  assert.equal((await db().query("SELECT count(*)::int AS n FROM jobs")).rows[0].n, 0);

  await importJobs(tenantId, jobsCsv, { dryRun: false });
  const jobs = (await db().query("SELECT j.name, j.status, j.start_date::text, c.last_name FROM jobs j JOIN contacts c ON c.id = j.client_contact_id ORDER BY j.name")).rows;
  assert.deepEqual(jobs, [
    { name: "Brooks Bath", status: "complete", start_date: null, last_name: "Brooks" },
    { name: "Hendricks Kitchen", status: "active", start_date: "2026-03-01", last_name: "Hendricks" },
  ]);
  const again = await importJobs(tenantId, jobsCsv, { dryRun: false });
  assert.deepEqual([again.created, again.updated, again.unchanged], [0, 0, 2]);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM contacts WHERE type = 'client'")).rows[0].n, 2);
  assert.equal(mapJobStatus("Proposal Sent"), "lead");
  assert.equal(mapJobStatus("On Hold"), "on_hold");
});

// Shaped like real Buildertrend exports: a title row above the headers, Cell and Phone
// columns, street addresses as client names, repeated names, stacked client names.
const btClients = `Client Contacts (exported on Tue),,,,,
Name,Activation Status,Phone,Cell,Jobs,Lead Opportunities
2935 Lakeshore Blvd,Inactive,,19045740585,0,1
Pat Smith,Active,(904) 555-0001,,2,0
Pat Smith,Inactive,,904-555-0002,0,1
Casey Lee,Active,,904-555-0003,0,0
`;

test("buildertrend style clients: title row, address names, same name different phone stays separate", opts, async () => {
  const r = await importContacts(tenantId, btClients, { defaultType: "client", dryRun: false });
  assert.deepEqual([r.created, r.updated, r.skipped], [4, 0, 0]);
  assert.equal(r.columns.recognized.phone, "cell");
  assert.equal(r.columns.recognized.phone2, "phone");
  const rows = (await db().query("SELECT first_name, last_name, company, type FROM contacts ORDER BY company NULLS LAST, first_name, type")).rows;
  assert.ok(rows.some((c) => c.company === "2935 Lakeshore Blvd" && c.first_name === null && c.type === "prospect"));
  assert.equal(rows.filter((c) => c.first_name === "Pat").length, 2); // two different people
  assert.deepEqual(rows.filter((c) => c.first_name === "Pat").map((c) => c.type).sort(), ["client", "prospect"]);
  assert.equal(rows.find((c) => c.first_name === "Casey")!.type, "client"); // no jobs or leads: file default
  assert.equal((await db().query("SELECT phone FROM contact_phones p JOIN contacts c ON c.id = p.contact_id WHERE c.company = '2935 Lakeshore Blvd'")).rows[0].phone, "+19045740585");
});

const btSubs = `Subs (exported on Tue),,,,
Company,Division,Activation,Primary contact,Cell,Phone,Liability exp.
 PRIME WIRING LLC,Electrical,Active,Matt,19042385385,,12/31/2026
3SM Remodeling ,Special Construction,No Email,Miguel Angulo,,+1 (407) 205-4903,
`;

test("buildertrend style subs: company plus primary contact, mixed phone formats, insurance date", opts, async () => {
  const r = await importContacts(tenantId, btSubs, { defaultType: "sub", dryRun: false });
  assert.deepEqual([r.created, r.skipped], [2, 0]);
  const rows = (await db().query("SELECT c.first_name, c.last_name, c.company, s.trades, s.coi_expires_on::text AS coi, (SELECT phone FROM contact_phones WHERE contact_id = c.id) AS phone FROM contacts c JOIN sub_profiles s ON s.contact_id = c.id ORDER BY c.company")).rows;
  assert.deepEqual(rows[0], { first_name: "Miguel", last_name: "Angulo", company: "3SM Remodeling", trades: ["Special Construction"], coi: null, phone: "+14072054903" });
  assert.deepEqual([rows[1].company, rows[1].first_name, rows[1].phone, rows[1].coi], ["PRIME WIRING LLC", "Matt", "+19042385385", "2026-12-31"]);
});

const btJobs = `Jobsites (exported on Tue),,,,,,,,
Job Color,Job Name,Street Address,City,State,Zip,Project Manager,Clients,Client Phone,Client Email,Schedule Status
,*12157 Diamond Springs - Snow,12157 Diamond Springs Dr,Jacksonville,FL,32246,,JJ Snow,9045250512,jj@example.com,Offline
,Datz Remodel,5 Elm St,Jacksonville,FL,32223,"Brandon Williams
Brian Wilkins","Kala Datz
Matt Datz",,,Online
`;

test("buildertrend style jobs: leading star, composed address, stacked clients, client phone and email, schedule status ignored", opts, async () => {
  const r = await importJobs(tenantId, btJobs, { dryRun: false });
  assert.deepEqual([r.created, r.skipped], [2, 0]);
  assert.ok(r.warnings.some((w) => /more than one client/.test(w)));
  assert.ok(r.columns.ignored.includes("schedule status"));
  const jobs = (await db().query("SELECT j.name, j.address, j.status, c.first_name, c.last_name, c.email, (SELECT phone FROM contact_phones WHERE contact_id = c.id) AS phone FROM jobs j JOIN contacts c ON c.id = j.client_contact_id ORDER BY j.name")).rows;
  assert.deepEqual(jobs.find((j) => j.name.startsWith("12157")), { name: "12157 Diamond Springs - Snow", address: "12157 Diamond Springs Dr, Jacksonville, FL 32246", status: "active", first_name: "JJ", last_name: "Snow", email: "jj@example.com", phone: "+19045250512" });
  const datz = jobs.find((j) => j.name === "Datz Remodel")!;
  assert.deepEqual([datz.first_name, datz.last_name], ["Kala", "Datz"]);
});

test("xlsx files import directly", opts, async () => {
  const fs = await import("node:fs");
  const buf = fs.readFileSync(new URL("./fixtures/subs-sample.xlsx", import.meta.url));
  const r = await importContacts(tenantId, buf, { defaultType: "sub", dryRun: false });
  assert.deepEqual([r.created, r.skipped], [2, 0]);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM sub_profiles")).rows[0].n, 2);
});
