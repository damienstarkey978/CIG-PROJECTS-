import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { ageTotals, bucketOf, daysOverdue, normCompany, paymentBlockers, suggestJob } from "../src/books/analyze";
import { syncBooks } from "../src/books/sync";
import { offlineClassifier } from "../src/ai/offline";
import { authorizeUrl, exchangeCode, mapBill, mapInvoice, QuickBooksOnline, signState, verifyState, type QboApp, type QboSecrets } from "../src/connectors/quickbooks";
import { MockAccounting } from "../src/connectors/mockAccounting";
import { closeDb, db } from "../src/lib/db";
import { handlers, type Deps } from "../src/pipeline/processCall";
import { buildApp } from "../src/server";
import { telephonyFor } from "../src/tenants";
import { hasDb, makeTenant, resetDb } from "./helpers";

const opts = { skip: hasDb ? false : "DATABASE_URL not set" };
const TODAY = new Date("2026-10-06T15:00:00Z");

test("aging: days overdue and buckets", () => {
  assert.equal(daysOverdue("2026-10-06", TODAY), 0);
  assert.equal(daysOverdue("2026-09-26", TODAY), 10);
  assert.equal(daysOverdue("2026-10-20", TODAY), -14);
  assert.deepEqual([0, 1, 30, 31, 60, 61, 90, 91].map((d) => bucketOf(d)), ["current", "d1_30", "d1_30", "d31_60", "d31_60", "d61_90", "d61_90", "d90_plus"]);
  const t = ageTotals([{ dueDate: "2026-10-20", balance: 100.1 }, { dueDate: "2026-09-26", balance: 200.2 }, { dueDate: "2026-06-01", balance: 50 }], TODAY);
  assert.deepEqual(t, { total: 350.3, current: 100.1, d1_30: 200.2, d31_60: 0, d61_90: 0, d90_plus: 50 });
});

const jobs = [
  { id: "j1", name: "Hendricks Kitchen", address: "12 Oak St, Jacksonville, FL" },
  { id: "j2", name: "*Brooks Bath", address: "4410 Riverside Ave, Jacksonville, FL 32207" },
  { id: "j3", name: "Hendricks Deck", address: "99 Pine Rd" },
];

test("job suggestions: customer:job refs, addresses, and refusing to guess between equal fits", () => {
  assert.equal(suggestJob(["Hendricks:Kitchen"], jobs)?.jobId, "j1");
  assert.equal(suggestJob(["Rough in, 4410 Riverside Ave"], jobs)?.jobId, "j2");
  assert.equal(suggestJob(["Rough in, 4410 Riverside Ave"], jobs)?.confidence, "high");
  assert.equal(suggestJob(["Hendricks"], jobs), null); // matches two jobs equally
  assert.equal(suggestJob(["Lumber for framing"], jobs), null);
  assert.equal(suggestJob([null, undefined], jobs), null);
});

test("vendor matching ignores legal suffixes", () => {
  assert.equal(normCompany("Coastal Tile, LLC."), normCompany("coastal tile"));
});

test("payment blockers: only subs are checked, expired or missing paperwork is listed", () => {
  assert.deepEqual(paymentBlockers({ known: false, sub: null }, TODAY), ["Vendor isn't in your contact list"]);
  assert.deepEqual(paymentBlockers({ known: true, sub: null }, TODAY), []); // a supplier
  assert.deepEqual(paymentBlockers({ known: true, sub: { w9OnFile: true, coiExpiresOn: "2027-01-01", lienWaiverStatus: "received" } }, TODAY), []);
  assert.deepEqual(paymentBlockers({ known: true, sub: { w9OnFile: false, coiExpiresOn: null, lienWaiverStatus: "needed" } }, TODAY), ["No W9 on file", "No insurance certificate date on file", "Lien waiver outstanding"]);
  assert.deepEqual(paymentBlockers({ known: true, sub: { w9OnFile: true, coiExpiresOn: "2026-09-01", lienWaiverStatus: null } }, TODAY), ["Insurance certificate expired 2026-09-01"]);
});

// ---- QuickBooks adapter against canned Intuit responses ----

const APP: QboApp = { clientId: "cid", clientSecret: "secret", env: "sandbox" };
const qboBill = { Id: "145", VendorRef: { value: "56", name: "Coastal Tile LLC" }, TxnDate: "2026-09-01", DueDate: "2026-10-01", TotalAmt: 4200, Balance: 1200.5, DocNumber: "CT-9", PrivateNote: "memo",
  Line: [{ Amount: 4200, Description: "Tile labor", DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "7", name: "Subcontractors" }, CustomerRef: { value: "9", name: "Hendricks:Kitchen" } } }, { DetailType: "SubTotalLineDetail", Amount: 4200 }] };
const qboInvoice = { Id: "301", CustomerRef: { value: "9", name: "Hendricks:Kitchen" }, TxnDate: "2026-08-20", DueDate: "2026-09-20", TotalAmt: "12500.00", Balance: 12500, DocNumber: "1007" };

test("quickbooks mapping", () => {
  assert.deepEqual(mapBill(qboBill), {
    externalId: "145", vendorExternalId: "56", vendorName: "Coastal Tile LLC", txnDate: "2026-09-01", dueDate: "2026-10-01", amount: 4200, balance: 1200.5, docNumber: "CT-9", memo: "memo",
    lines: [{ description: "Tile labor", amount: 4200, account: "Subcontractors", customerRef: "Hendricks:Kitchen" }],
  });
  assert.deepEqual([mapInvoice(qboInvoice).customerName, mapInvoice(qboInvoice).amount], ["Hendricks:Kitchen", 12500]);
});

test("quickbooks client: queries open items read only, pages, refreshes expired tokens and reports the new ones", async () => {
  const calls: { url: string; method: string; auth: string }[] = [];
  const saved: QboSecrets[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, method: init?.method ?? "GET", auth: init?.headers?.Authorization });
    if (url.includes("oauth.platform.intuit.com")) {
      assert.match(String(init.body), /grant_type=refresh_token&refresh_token=old-refresh/);
      assert.match(init.headers.Authorization, /^Basic /);
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }), { status: 200 });
    }
    const page = Number(/startposition (\d+)/.exec(decodeURIComponent(url))![1]);
    const rows = page === 1 ? Array.from({ length: 500 }, (_, i) => ({ ...qboBill, Id: String(i) })) : [{ ...qboBill, Id: "last" }];
    return new Response(JSON.stringify({ QueryResponse: { Bill: rows } }), { status: 200 });
  }) as unknown as typeof fetch;

  const qb = new QuickBooksOnline({ realmId: "123", accessToken: "stale", refreshToken: "old-refresh", expiresAt: 1000 }, APP, async (s) => void saved.push(s), fakeFetch, () => 5000);
  const bills = await qb.listOpenBills();
  assert.equal(bills.length, 501); // two pages
  assert.equal(saved.length, 1); // refreshed once, not per page
  assert.deepEqual([saved[0].accessToken, saved[0].refreshToken], ["new-access", "new-refresh"]);
  const queries = calls.filter((c) => c.url.includes("/v3/company/123/query"));
  assert.ok(queries.every((c) => c.method === "GET" && c.auth === "Bearer new-access" && c.url.startsWith("https://sandbox-quickbooks.api.intuit.com")));
  assert.match(decodeURIComponent(queries[0].url), /select \* from Bill where Balance > '0' startposition 1 maxresults 500/);
  assert.ok(calls.every((c) => c.method === "GET" || c.url.includes("oauth.platform.intuit.com"))); // never writes
});

test("quickbooks connect flow: signed state, authorize url, code exchange", async () => {
  const key = Buffer.alloc(32, 7);
  const state = signState("acme", key, 1_000);
  assert.equal(verifyState(state, key, 2_000), "acme");
  assert.equal(verifyState(state, key, 1_000 + 16 * 60_000), null); // expired
  assert.equal(verifyState(state, Buffer.alloc(32, 8), 2_000), null); // wrong key
  assert.equal(verifyState(state.replace(/.$/, "x"), key, 2_000), null); // tampered
  assert.equal(verifyState("junk", key), null);
  const url = new URL(authorizeUrl(APP, "https://app.example/cb", state));
  assert.deepEqual([url.origin + url.pathname, url.searchParams.get("client_id"), url.searchParams.get("redirect_uri"), url.searchParams.get("state")], ["https://appcenter.intuit.com/connect/oauth2", "cid", "https://app.example/cb", state]);

  const fakeFetch = (async (_u: string, init: any) => {
    assert.match(String(init.body), /grant_type=authorization_code&code=abc&redirect_uri=/);
    return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch;
  const secrets = await exchangeCode(APP, "abc", "https://app.example/cb", "realm9", fakeFetch);
  assert.deepEqual([secrets.realmId, secrets.accessToken, secrets.refreshToken], ["realm9", "a", "r"]);
  await assert.rejects(exchangeCode(APP, "bad", "x", "r", (async () => new Response("no", { status: 400 })) as unknown as typeof fetch), /token request failed/);
});

// ---- sync and API ----

let tenantId: string;
beforeEach(async () => { if (hasDb) { await resetDb(); tenantId = await makeTenant(); } });
after(async () => { server?.close(); if (hasDb) await closeDb(); });

async function seed() {
  const add = async (type: string, first: string | null, last: string | null, company: string | null) =>
    (await db().query<{ id: string }>("INSERT INTO contacts (tenant_id, type, first_name, last_name, company) VALUES ($1,$2,$3,$4,$5) RETURNING id", [tenantId, type, first, last, company])).rows[0].id;
  const tile = await add("sub", "Tom", "Tile", "Coastal Tile");
  await db().query("INSERT INTO sub_profiles (contact_id, w9_on_file, coi_expires_on) VALUES ($1, true, '2027-06-30')", [tile]); // paperwork complete
  const roy = await add("sub", "Roy", "Electric", "Roy Electric");
  await db().query("INSERT INTO sub_profiles (contact_id) VALUES ($1)", [roy]); // nothing on file
  await add("vendor", null, null, "Lumber Depot"); // supplier, no paperwork needed
  const brooks = await add("client", "Dana", "Brooks", null);
  await db().query("INSERT INTO jobs (tenant_id, name, address, client_contact_id) VALUES ($1,'Hendricks Kitchen','12 Oak St, Jacksonville',NULL), ($1,'Brooks Bath','4410 Riverside Ave, Jacksonville',$2)", [tenantId, brooks]);
}

test("sync: links vendors and jobs, flags paperwork, chases late invoices, and is safe to repeat", opts, async () => {
  await seed();
  const r1 = await syncBooks(tenantId, new MockAccounting(TODAY), { today: TODAY });
  assert.deepEqual([r1.bills, r1.invoices], [4, 3]);

  const bills = (await db().query("SELECT b.vendor_name, c.company, j.name AS job FROM acct_bills b LEFT JOIN contacts c ON c.id = b.contact_id LEFT JOIN jobs j ON j.id = b.suggested_job_id ORDER BY b.external_id")).rows;
  assert.deepEqual(bills.map((b) => [b.vendor_name, b.company, b.job]), [
    ["Coastal Tile LLC", "Coastal Tile", "Hendricks Kitchen"], // LLC ignored, customer:job reference
    ["Roy Electric", "Roy Electric", "Brooks Bath"], // job from the address in the line text
    ["Lumber Depot", "Lumber Depot", null],
    ["Sunrise Paving", null, null], // not in the contact list
  ]);

  const tasks = (await db().query("SELECT type, title FROM tasks ORDER BY title")).rows;
  const byType = (t: string) => tasks.filter((x) => x.type === t).map((x) => x.title);
  assert.deepEqual(byType("bill_blocked"), ["Hold payment: Roy Electric $1,850.50 (#RE-208)", "Hold payment: Sunrise Paving $3,650.00 (#SP-77)"]);
  assert.deepEqual(byType("chase_invoice"), ["Chase payment: Alvarez, Tom $1,000.00 (#0991)", "Chase payment: Hendricks:Kitchen $12,500.00 (#1007)"]); // Dana Brooks is not yet due

  const inv = (await db().query("SELECT i.customer_name, j.name AS job, c.last_name FROM acct_invoices i LEFT JOIN jobs j ON j.id = i.job_id LEFT JOIN contacts c ON c.id = i.contact_id WHERE i.external_id = 'I2'")).rows[0];
  assert.deepEqual([inv.customer_name, inv.last_name], ["Dana Brooks", "Brooks"]);

  const r2 = await syncBooks(tenantId, new MockAccounting(TODAY), { today: TODAY });
  assert.equal(r2.tasksCreated, 0); // no duplicate tasks
  assert.equal((await db().query("SELECT count(*)::int AS n FROM acct_bills")).rows[0].n, 4);
  assert.equal((await db().query("SELECT count(*)::int AS n FROM outbound_messages")).rows[0].n, 0); // books never text anyone
});

test("sync: items paid in the books drop out, and a failing provider is recorded", opts, async () => {
  await syncBooks(tenantId, new MockAccounting(TODAY), { today: TODAY });
  const fewer = { name: "demo_books", listOpenBills: async () => (await new MockAccounting(TODAY).listOpenBills()).slice(0, 1), listOpenInvoices: async () => [] };
  await syncBooks(tenantId, fewer, { today: TODAY });
  assert.deepEqual([(await db().query("SELECT count(*)::int AS n FROM acct_bills")).rows[0].n, (await db().query("SELECT count(*)::int AS n FROM acct_invoices")).rows[0].n], [1, 0]);
  const broken = { name: "demo_books", listOpenBills: async () => { throw new Error("401 from books"); }, listOpenInvoices: async () => [] };
  await assert.rejects(syncBooks(tenantId, broken, { today: TODAY }), /401 from books/);
  assert.match((await db().query("SELECT error FROM acct_sync_runs ORDER BY id DESC LIMIT 1")).rows[0].error, /401 from books/);
});

process.env.ADMIN_TOKEN = "op-token";
const deps: Deps = { telephony: telephonyFor, classify: offlineClassifier() };
let server: ReturnType<ReturnType<typeof buildApp>["listen"]> | undefined;
async function call(path: string, token: string | null, init: { method?: string; body?: unknown } = {}) {
  if (!server) server = buildApp(deps).listen(0);
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

test("books api: needs a connection, role limited, quickbooks connect explains itself", opts, async () => {
  const op = "op-token";
  assert.equal((await call("/t/wci/books/sync", op, { method: "POST" })).status, 400); // nothing connected
  assert.equal((await call("/t/wci/connectors/accounting/quickbooks", op, { method: "PUT", body: {} })).status, 400); // oauth only
  assert.match((await call("/t/wci/connectors/accounting/quickbooks/authorize", op)).body.error, /isn't set up/);
  assert.equal((await call("/t/wci/connectors/accounting/demo_books", op, { method: "PUT", body: {} })).status, 200);

  await seed();
  const synced = (await call("/t/wci/books/sync", op, { method: "POST" })).body;
  assert.deepEqual([synced.bills, synced.invoices], [4, 3]);
  const books = (await call("/t/wci/books", op)).body;
  assert.equal(books.connected, "demo_books");
  assert.equal(books.payable.total, 4200 + 1850.5 + 960 + 3650);
  assert.equal(books.receivable.total, 12500 + 8400 + 1000);
  assert.equal(books.held, 1850.5 + 3650); // Roy Electric and Sunrise Paving
  const roy = books.bills.find((b: any) => b.vendor === "Roy Electric");
  assert.deepEqual(roy.blockers, ["No W9 on file", "No insurance certificate date on file"]);
  assert.equal(roy.job, "Brooks Bath");

  // A project manager can't see the money.
  await call("/t/wci/users", op, { method: "POST", body: { name: "Pam PM", email: "pam@wci.example", role: "pm", password: "pm-password-123" } });
  const pm = (await call("/login", null, { method: "POST", body: { email: "pam@wci.example", password: "pm-password-123" } })).body.token;
  assert.equal((await call("/t/wci/books", pm)).status, 403);
  assert.equal((await call("/t/wci/books/sync", pm, { method: "POST" })).status, 403);
});
