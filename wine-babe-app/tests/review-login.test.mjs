import test from "node:test";
import assert from "node:assert/strict";
import { gate, makeCookie, isReviewUser } from "../lib/auth.mjs";

test("review login is a review user, mindy is not", () => {
  assert.equal(isReviewUser("appreview"), true);
  assert.equal(isReviewUser("mindy"), false);
});

test("review session uses the app but not /admin", async () => {
  const cookie = (await makeCookie("appreview", "s")).split(";")[0];
  const req = (p) => new Request(`https://x${p}`, { headers: { cookie } });
  assert.equal(await gate(req("/"), "s"), null);
  assert.equal(await gate(req("/api/scan-start"), "s"), null);
  const admin = await gate(req("/admin"), "s");
  assert.equal(admin.status, 302);
  assert.equal(admin.headers.get("Location"), "/");
  assert.equal((await gate(req("/api/admin/x"), "s")).status, 403);
});

test("team session still reaches /admin", async () => {
  const cookie = (await makeCookie("mindy", "s")).split(";")[0];
  assert.equal(await gate(new Request("https://x/admin", { headers: { cookie } }), "s"), null);
});
