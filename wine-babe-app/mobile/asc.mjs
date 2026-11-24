// App Store Connect steps for Wine Babe 1.0, run by .github/workflows/wine-babe-asc.yml
// with the team's App Store Connect API key (repository secrets). The repo is
// public, so this never prints ids, the key or the review code.
//
//   node asc.mjs status       version, build, review details and submission state
//   node asc.mjs set-review   new review code + notes in App Review Information;
//                             prints the salt and hash for lib/review-code.mjs
//   node asc.mjs verify       signs in on the live site with the code stored in ASC
//   node asc.mjs submit       verify, then submit 1.0 for App Review
import crypto from "node:crypto";

const BUNDLE_ID = "com.winebabescanner.app";
const VERSION = "1.0";
const SITE = "https://winebabescanner.com";
const REVIEW_EMAIL = "review@winebabescanner.com";
const API = "https://api.appstoreconnect.apple.com";

const NOTES = `No sign in is needed. Open the app and tap Scan Label, upload a label photo, or type a wine name (for example Josh Cellars Cabernet Sauvignon). Each phone gets 5 free scans; after that the app asks for a free account (name and email, created instantly, no email check).

To test signed in features, use the demo account: tap Sign In at the top, enter ${REVIEW_EMAIL}, tap Email Me a Code, then type the code from the Password field above (no email is sent for this account) and tap Sign In. It has 20 scans a day.

Delete an account: tap Account at the top, then Delete My Account.

The app shows nutrition and transparency facts (calories, carbs, sugar, sulfites, farming) researched from public sources. It does not sell alcohol. Age rating 18+ for alcohol references.`;

function token() {
  const { ASC_KEY_ID: kid, ASC_ISSUER_ID: iss, ASC_KEY_P8: p8 } = process.env;
  if (!kid || !iss || !p8) throw new Error("ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 must be set");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "ES256", kid, typ: "JWT" })}.${b64({ iss, iat: now, exp: now + 900, aud: "appstoreconnect-v1" })}`;
  const sig = crypto.sign("sha256", Buffer.from(body), { key: p8, dsaEncoding: "ieee-p1363" });
  return `${body}.${sig.toString("base64url")}`;
}
const auth = token();

async function asc(path, method = "GET", data) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    body: data ? JSON.stringify({ data }) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const errs = (json?.errors || []).map((e) => `${e.code}: ${e.detail || e.title}`).join("; ");
    throw new Error(`${method} ${path.split("?")[0].replace(/[0-9a-f-]{20,}|\d{6,}/g, ":id")} ${r.status} ${errs}`);
  }
  return json;
}

async function load() {
  const app = (await asc(`/v1/apps?filter[bundleId]=${BUNDLE_ID}`)).data[0];
  if (!app) throw new Error("No app with that bundle id on this key's team");
  const ver = (await asc(`/v1/apps/${app.id}/appStoreVersions?filter[versionString]=${VERSION}&filter[platform]=IOS`)).data[0];
  if (!ver) throw new Error(`No iOS version ${VERSION}`);
  const detail = (await asc(`/v1/appStoreVersions/${ver.id}/appStoreReviewDetail`)).data;
  const build = (await asc(`/v1/appStoreVersions/${ver.id}/build`)).data;
  const subs = (await asc(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&include=items`)).data;
  return { app, ver, detail, build, subs };
}

function show({ app, ver, detail, build, subs }) {
  const a = detail?.attributes || {};
  console.log(`App: ${app.attributes.name}`);
  console.log(`Version ${VERSION}: ${ver.attributes.appVersionState || ver.attributes.appStoreState}, release ${ver.attributes.releaseType}${ver.attributes.earliestReleaseDate ? ` not before ${ver.attributes.earliestReleaseDate}` : ""}`);
  console.log(`Build: ${build ? `${build.attributes.version} ${build.attributes.processingState}` : "none attached"}`);
  console.log(`Review contact: ${a.contactFirstName || ""} ${a.contactLastName || ""}, phone ${a.contactPhone ? "set" : "missing"}, email ${a.contactEmail ? "set" : "missing"}`);
  console.log(`Demo account required: ${a.demoAccountRequired}, name: ${a.demoAccountName || "(none)"}, password ${a.demoAccountPassword ? "set" : "missing"}`);
  console.log(`Notes match this script: ${(a.notes || "") === NOTES}`);
  for (const s of subs) console.log(`Review submission: ${s.attributes.state}, items ${s.relationships?.items?.data?.length ?? "?"}, submitted ${s.attributes.submittedDate || "no"}`);
  if (!subs.length) console.log("Review submission: none");
}

async function verify(detail) {
  const a = detail.attributes;
  if (a.demoAccountName !== REVIEW_EMAIL || !a.demoAccountPassword) throw new Error("Demo account in ASC is not the review email with a code");
  const post = (p, body, cookie) => fetch(`${SITE}/api/account/${p}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  });
  const c = await post("code", { email: REVIEW_EMAIL });
  if (!c.ok) throw new Error(`Live site code step: ${c.status}`);
  const v = await post("verify", { email: REVIEW_EMAIL, code: a.demoAccountPassword });
  const j = await v.json().catch(() => ({}));
  if (!v.ok || j.account?.email !== REVIEW_EMAIL) throw new Error(`Live site sign in with the ASC code failed: ${v.status} ${j.error || ""}`);
  console.log(`Live sign in with the ASC demo account: OK (${j.account.name}, ${j.allowance?.dailyLimit} scans a day)`);
}

const cmd = process.argv[2] || "status";
const s = await load();
if (cmd === "status") show(s);
else if (cmd === "set-review") {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
  const code = [...crypto.randomBytes(14)].map((b) => alphabet[b % alphabet.length]).join("");
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${code}`);
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + code).digest("hex");
  await asc(`/v1/appStoreReviewDetails/${s.detail.id}`, "PATCH", {
    type: "appStoreReviewDetails", id: s.detail.id,
    attributes: { demoAccountRequired: true, demoAccountName: REVIEW_EMAIL, demoAccountPassword: code, notes: NOTES },
  });
  console.log("App Review Information updated. Put this in lib/review-code.mjs:");
  console.log(`REVIEW_CODE_HASH = ${JSON.stringify({ salt, hash })}`);
  show(await load());
} else if (cmd === "verify") await verify(s.detail);
else if (cmd === "submit") {
  await verify(s.detail);
  if (s.detail.attributes.notes !== NOTES) throw new Error("Notes not set yet; run set-review first");
  const open = s.subs.find((x) => x.attributes.state === "READY_FOR_REVIEW");
  if (!open) { show(s); throw new Error("No review submission ready to submit"); }
  await asc(`/v1/reviewSubmissions/${open.id}`, "PATCH", { type: "reviewSubmissions", id: open.id, attributes: { submitted: true } });
  console.log("Submitted for App Review.");
  show(await load());
} else throw new Error(`Unknown step ${cmd}`);
