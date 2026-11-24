// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  memoryStore, createAccount, findByEmail, deleteAccount, scanAllowance, recordScan,
  issueCode, checkCode, reviewSignIn, isReviewEmail, LIMITS,
} from "../lib/accounts.mjs";
import { submitFeedback, listFeedback, scrubAccountFeedback, FEEDBACK_SUBJECT } from "../lib/feedback.mjs";
import { gate } from "../lib/auth.mjs";
import cost from "../lib/cost.js";

test("five free scans, then an account is needed", async () => {
  const usage = memoryStore();
  const who = { team: false, accountId: null, deviceId: "dev1", ipHash: "ip1" };
  for (let i = 0; i < LIMITS.freeScans; i++) {
    const a = await scanAllowance(usage, who);
    assert.equal(a.ok, true);
    assert.equal(a.freeRemaining, LIMITS.freeScans - i);
    await recordScan(usage, who);
  }
  const blocked = await scanAllowance(usage, who);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.needAccount, true);
  // Signing up opens the daily allowance.
  const signed = await scanAllowance(usage, { ...who, accountId: "a1" });
  assert.equal(signed.ok, true);
  assert.equal(signed.dailyLimit, LIMITS.dailyScans);
});

test("team logins are never limited", async () => {
  assert.equal((await scanAllowance(memoryStore(), { team: "mindy" })).unlimited, true);
});

test("accounts: name and email required, phone optional, no duplicates, delete", async () => {
  const store = memoryStore(), usage = memoryStore();
  await assert.rejects(createAccount(store, { email: "a@b.com" }), /name/);
  await assert.rejects(createAccount(store, { name: "Al", email: "nope" }), /email/);
  const a = await createAccount(store, { name: " Al  Smith ", email: "AL@Example.com" });
  assert.equal(a.name, "Al Smith");
  assert.equal(a.email, "al@example.com");
  assert.equal(a.phone, "");
  await assert.rejects(createAccount(store, { name: "Al", email: "al@example.com" }), /already/);
  await deleteAccount(store, usage, a.id);
  assert.equal(await findByEmail(store, "al@example.com"), null);
});

test("email codes: right code works once, wrong codes run out", async () => {
  const store = memoryStore();
  const code = await issueCode(store, "x@y.com");
  await assert.rejects(checkCode(store, "x@y.com", "000000" === code ? "111111" : "000000"), /isn't right/);
  await checkCode(store, "x@y.com", code);
  await assert.rejects(checkCode(store, "x@y.com", code), /expired/);
});

test("App Review demo login uses the fixed code and makes the account", async () => {
  process.env.WB_REVIEW_EMAIL = "review@winebabescanner.com";
  process.env.WB_REVIEW_CODE = "TestCode2026";
  const store = memoryStore();
  assert.equal(isReviewEmail("Review@WineBabeScanner.com"), true);
  assert.equal(isReviewEmail("someone@else.com"), false);
  await assert.rejects(reviewSignIn(store, "review@winebabescanner.com", "wrong"), /isn't right/);
  const a = await reviewSignIn(store, "review@winebabescanner.com", "TestCode2026");
  assert.equal(a.name, "App Review");
  const again = await reviewSignIn(store, "review@winebabescanner.com", " TestCode2026 ");
  assert.equal(again.id, a.id);
  process.env.WB_REVIEW_CODE = "short";
  assert.equal(isReviewEmail("review@winebabescanner.com"), false);
  delete process.env.WB_REVIEW_EMAIL;
  delete process.env.WB_REVIEW_CODE;
});

test("App Review demo login also takes the code whose salted hash is committed", async () => {
  process.env.WB_REVIEW_EMAIL = "review@winebabescanner.com";
  delete process.env.WB_REVIEW_CODE;
  const { sha } = await import("../lib/accounts.mjs");
  const hashed = { salt: "abc123", hash: await sha("abc123" + "K7PQ2MXWRT9CVH") };
  const store = memoryStore();
  assert.equal(isReviewEmail("review@winebabescanner.com"), false); // nothing committed yet
  assert.equal(isReviewEmail("review@winebabescanner.com", hashed), true);
  await assert.rejects(reviewSignIn(store, "review@winebabescanner.com", "K7PQ2MXWRT9CVX", Date.now(), hashed), /isn't right/);
  const a = await reviewSignIn(store, "review@winebabescanner.com", " K7PQ2MXWRT9CVH ", Date.now(), hashed);
  assert.equal(a.name, "App Review");
  process.env.WB_REVIEW_CODE = "TestCode2026"; // the env code still works beside it
  assert.equal((await reviewSignIn(store, "review@winebabescanner.com", "TestCode2026", Date.now(), hashed)).id, a.id);
  delete process.env.WB_REVIEW_EMAIL;
  delete process.env.WB_REVIEW_CODE;
});

test("feedback is stored, emailed with the right subject, and scrubbed on delete", async () => {
  const store = memoryStore(), limits = memoryStore();
  const sent = [];
  const send = async (m) => { sent.push(m); return { sent: true, id: "em_1" }; };
  const who = { account: { id: "acc1", name: "Mindy", email: "m@x.com" }, ipHash: "ip", userAgent: "UA" };
  await submitFeedback({ store, limits, who, send, body: { type: "bug", text: "Button is stuck", appVersion: "abc", platform: "iOS app" } });
  assert.equal(sent[0].subject, FEEDBACK_SUBJECT);
  assert.match(sent[0].text, /Button is stuck/);
  assert.equal(sent[0].replyTo, "m@x.com");
  const rows = await listFeedback(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].emailed.ok, true);
  await scrubAccountFeedback(store, "acc1");
  const after = await listFeedback(store);
  assert.equal(after[0].text, "Button is stuck");
  assert.equal(after[0].email, "");
  assert.equal(after[0].name, "Deleted account");
  // Honeypot: stored nowhere, no email.
  await submitFeedback({ store, limits, who: {}, send, body: { text: "spam", website: "x" } });
  assert.equal(sent.length, 1);
  await assert.rejects(submitFeedback({ store, limits, who: {}, send, body: { text: "  " } }), /little/);
});

test("password gate: open by default; WB_PUBLIC=false closes it; admin always closed; privacy open", async () => {
  const req = (p) => new Request(`https://w.test${p}`);
  assert.equal(await gate(req("/"), "s", {}), null);
  assert.equal(await gate(req("/api/account"), "s", {}), null);
  assert.equal(await gate(req("/"), "s", { WB_PUBLIC: "true" }), null);
  assert.equal((await gate(req("/admin"), "s", {})).status, 302);
  assert.equal((await gate(req("/api/admin/x"), "s", {})).status, 401);
  assert.equal((await gate(req("/"), "s", { WB_PUBLIC: "false" })).status, 302);
  assert.equal((await gate(req("/api/scan-start"), "s", { WB_PUBLIC: "false" })).status, 401);
  assert.equal(await gate(req("/privacy"), "s", { WB_PUBLIC: "false" }), null);
  assert.equal(await gate(req("/api/feedback"), "s", { WB_PUBLIC: "false" }), null);
});

test("cost: tokens and web searches priced", () => {
  const acc = cost.createUsage();
  cost.addUsage(acc, { model: "claude-sonnet-5-5", usage: { input_tokens: 30000, output_tokens: 2000, server_tool_use: { web_search_requests: 2 } } });
  const s = cost.summarizeUsage(acc);
  assert.equal(s.searches, 2);
  assert.ok(Math.abs(s.dollars - 0.1) < 1e-9, String(s.dollars));
});
