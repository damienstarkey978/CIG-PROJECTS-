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
  assert.deepEqual(splitName("Alvarez, Mike"), { first: "Mike", last: "Alvarez" });
  assert.deepEqual(splitName("Mary Ann Smith"), { first: "Mary", last: "Ann Smith" });
  assert.throws(() => parseCsv("only header\n"), /header row/);
  const { map, ignored } = mapColumns(["trade partner", "mobile", "zzz"], { company: ["company", "trade partner"], phone: ["phone", "mobile"] });
  assert.deepEqual([map.company, map.phone, ignored], ["trade partner", "mobile", ["zzz"]]);
});

test("contacts: preview saves nothing, import creates subs with trades, rerun is a no op", opts, async () => {
  const preview = await importContacts(tenantId, subsCsv, { defaultType: "sub", dryRun: true });
  assert.deepEqual([preview.dryRun, preview.created, preview.skipped], [true, 3, 1]);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM contacts")).rows[0].n, 0);
  assert.ok(preview.columns.ignored.includes("internal code"));
  assert.ok(preview.warnings.some((w) => /Row 5.*phone/.test(w)));

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
  assert.deepEqual([preview.created, preview.skipped], [2, 1]);
  assert.ok(preview.warnings.some((w) => /Row 3.*start date/.test(w)));
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
