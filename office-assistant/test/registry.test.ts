import assert from "node:assert/strict";
import { test } from "node:test";
import { findManifest, MANIFESTS, publicCatalog, splitFields } from "../src/connectors/registry";

test("catalog never exposes factory functions", () => {
  for (const m of publicCatalog()) assert.equal("createTelephony" in m, false);
});

test("every ready telephony connector can build an adapter; planned ones cannot be connected", () => {
  for (const m of MANIFESTS.filter((x) => x.kind === "telephony" && x.status === "ready")) {
    const tel = m.createTelephony!({}, { apiKey: "k", signingKeys: [] });
    assert.equal(tel.name, m.provider);
  }
  assert.equal(findManifest("accounting", "quickbooks")?.status, "planned");
});

test("splitFields separates secrets, enforces required, and keeps existing secrets on update", () => {
  const quo = findManifest("telephony", "quo")!;
  assert.throws(() => splitFields(quo, {}), /Quo API key is required/);
  const first = splitFields(quo, { apiKey: "abc", inboxPhoneNumberIds: "PN1, PN2" });
  assert.deepEqual(first.secrets, { apiKey: "abc" });
  assert.deepEqual(first.config, { inboxPhoneNumberIds: "PN1, PN2" });
  const update = splitFields(quo, { inboxPhoneNumberIds: "PN3" }, { apiKey: "abc", signingKeys: ["k"] });
  assert.deepEqual(update.secrets, { apiKey: "abc", signingKeys: ["k"] });
});
