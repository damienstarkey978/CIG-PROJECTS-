// App Store Connect steps for Wine Babe 1.0, run by .github/workflows/wine-babe-asc.yml
// with the team's App Store Connect API key (repository secrets). The repo is
// public, so this never prints ids, the key or the review code.
//
//   node asc.mjs status       version, build, review details and submission state
//   node asc.mjs set-review   new review code + notes in App Review Information;
//                             prints the salt and hash for lib/review-code.mjs
//   node asc.mjs verify       signs in on the live site with the code stored in ASC
//   node asc.mjs submit       verify, then submit the version for App Review
//   node asc.mjs prep         set up an update version (ASC_VERSION, default 1.0.1):
//                             listing text and review details copied from 1.0, What's New,
//                             new screenshots from store-screenshots/, newest 1.0.1 build
//   node asc.mjs builds       newest builds and their state
import crypto from "node:crypto";
import fs from "node:fs";

const BUNDLE_ID = "com.winebabescanner.app";
const VERSION = process.env.ASC_VERSION || "1.0.1";
const FIRST = "1.0";
const WHATS_NEW = "A fresh look for every result: the Wine Babe Score up top, a clear Skinny Sip Approved badge, and a See All Skinny Sip Approved Wines list on the home screen.";
const SHOTS = ["1-home.png", "2-scanning.png", "3-result.png", "4-checks.png", "5-breakdown.png"];
const SHOT_TYPE = "APP_IPHONE_67"; // 1320 x 2868, the 6.9" iPhone set
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
  if (!ver) return { app, ver: null, detail: null, build: null, subs: [] };
  const detail = await asc(`/v1/appStoreVersions/${ver.id}/appStoreReviewDetail`).then((r) => r.data).catch(() => null);
  const build = (await asc(`/v1/appStoreVersions/${ver.id}/build`)).data;
  const subs = (await asc(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&include=items`)).data;
  return { app, ver, detail, build, subs };
}

function show({ app, ver, detail, build, subs }) {
  const a = detail?.attributes || {};
  console.log(`App: ${app.attributes.name}`);
  if (!ver) { console.log(`Version ${VERSION}: not created yet`); return; }
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

async function uploadShot(setId, file) {
  const buf = fs.readFileSync(file);
  const shot = (await asc("/v1/appScreenshots", "POST", {
    type: "appScreenshots", attributes: { fileName: file.split("/").pop(), fileSize: buf.length },
    relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } } },
  })).data;
  for (const op of shot.attributes.uploadOperations) {
    const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
    const r = await fetch(op.url, { method: op.method, headers, body: buf.subarray(op.offset, op.offset + op.length) });
    if (!r.ok) throw new Error(`Screenshot upload part failed: ${r.status}`);
  }
  await asc(`/v1/appScreenshots/${shot.id}`, "PATCH", {
    type: "appScreenshots", id: shot.id,
    attributes: { uploaded: true, sourceFileChecksum: crypto.createHash("md5").update(buf).digest("hex") },
  });
  return shot.id;
}

async function builds(app) {
  const list = (await asc(`/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=5&include=preReleaseVersion`)).data;
  for (const b of list) console.log(`Build ${b.attributes.version}: ${b.attributes.processingState}, uploaded ${b.attributes.uploadedDate}, expired ${b.attributes.expired}`);
  return list;
}

async function prep(app) {
  const versions = (await asc(`/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=20`)).data;
  const prev = versions.find((v) => v.attributes.versionString === FIRST);
  if (!prev) throw new Error(`No iOS version ${FIRST} to copy from`);
  let ver = versions.find((v) => v.attributes.versionString === VERSION);
  if (!ver) {
    ver = (await asc("/v1/appStoreVersions", "POST", {
      type: "appStoreVersions",
      attributes: { platform: "IOS", versionString: VERSION, copyright: prev.attributes.copyright, releaseType: "AFTER_APPROVAL" },
      relationships: { app: { data: { type: "apps", id: app.id } } },
    })).data;
    console.log(`Created version ${VERSION}`);
  } else console.log(`Version ${VERSION} already exists: ${ver.attributes.appVersionState || ver.attributes.appStoreState}`);

  // Listing text: same as 1.0, plus What's New.
  const keep = ["description", "keywords", "marketingUrl", "supportUrl", "promotionalText"];
  const prevLocs = (await asc(`/v1/appStoreVersions/${prev.id}/appStoreVersionLocalizations`)).data;
  let locs = (await asc(`/v1/appStoreVersions/${ver.id}/appStoreVersionLocalizations`)).data;
  for (const pl of prevLocs) {
    const attrs = Object.fromEntries(keep.filter((k) => pl.attributes[k]).map((k) => [k, pl.attributes[k]]));
    let l = locs.find((x) => x.attributes.locale === pl.attributes.locale);
    if (!l) {
      l = (await asc("/v1/appStoreVersionLocalizations", "POST", {
        type: "appStoreVersionLocalizations", attributes: { locale: pl.attributes.locale, ...attrs, whatsNew: WHATS_NEW },
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: ver.id } } },
      })).data;
    } else {
      const change = Object.fromEntries(Object.entries({ ...attrs, whatsNew: WHATS_NEW }).filter(([k, v]) => l.attributes[k] !== v));
      if (Object.keys(change).length) await asc(`/v1/appStoreVersionLocalizations/${l.id}`, "PATCH", { type: "appStoreVersionLocalizations", id: l.id, attributes: change });
    }
    console.log(`Listing text ${pl.attributes.locale}: copied from ${FIRST}, What's New set`);

    // Screenshots: old ones out of every set, the new five into the 6.9" set.
    const prevSets = (await asc(`/v1/appStoreVersionLocalizations/${pl.id}/appScreenshotSets`)).data;
    console.log(`${FIRST} screenshot sets: ${prevSets.map((x) => x.attributes.screenshotDisplayType).join(", ") || "none"}`);
    const sets = (await asc(`/v1/appStoreVersionLocalizations/${l.id}/appScreenshotSets`)).data;
    let set = sets.find((x) => x.attributes.screenshotDisplayType === SHOT_TYPE);
    for (const st of sets) {
      const shots = (await asc(`/v1/appScreenshotSets/${st.id}/appScreenshots`)).data;
      for (const sh of shots) await asc(`/v1/appScreenshots/${sh.id}`, "DELETE");
      if (shots.length) console.log(`Removed ${shots.length} old screenshots from ${st.attributes.screenshotDisplayType}`);
    }
    if (!set) set = (await asc("/v1/appScreenshotSets", "POST", {
      type: "appScreenshotSets", attributes: { screenshotDisplayType: SHOT_TYPE },
      relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: l.id } } },
    })).data;
    const ids = [];
    for (const f of SHOTS) ids.push(await uploadShot(set.id, new URL(`./store-screenshots/${f}`, import.meta.url).pathname));
    await asc(`/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`, "PATCH", ids.map((id) => ({ type: "appScreenshots", id })));
    for (let i = 0; i < 30; i++) {
      const states = await Promise.all(ids.map((id) => asc(`/v1/appScreenshots/${id}`).then((r) => r.data.attributes.assetDeliveryState?.state)));
      if (states.includes("FAILED")) throw new Error(`Apple rejected a screenshot: ${states.join(", ")}`);
      if (states.every((x) => x === "COMPLETE")) { console.log(`Screenshots: ${ids.length} uploaded, all accepted by Apple, in order ${SHOTS.join(", ")}`); break; }
      if (i === 29) console.log(`Screenshots still processing: ${states.join(", ")}`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  // App Review details: same contact, demo login and notes as 1.0.
  const prevDetail = (await asc(`/v1/appStoreVersions/${prev.id}/appStoreReviewDetail`)).data;
  const rk = ["contactFirstName", "contactLastName", "contactPhone", "contactEmail", "demoAccountName", "demoAccountPassword", "demoAccountRequired", "notes"];
  const rattrs = Object.fromEntries(rk.filter((k) => prevDetail.attributes[k] != null).map((k) => [k, prevDetail.attributes[k]]));
  const cur = await asc(`/v1/appStoreVersions/${ver.id}/appStoreReviewDetail`).then((r) => r.data).catch(() => null);
  if (cur) await asc(`/v1/appStoreReviewDetails/${cur.id}`, "PATCH", { type: "appStoreReviewDetails", id: cur.id, attributes: rattrs });
  else await asc("/v1/appStoreReviewDetails", "POST", {
    type: "appStoreReviewDetails", attributes: rattrs,
    relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: ver.id } } },
  });
  console.log(`App Review details copied from ${FIRST}`);

  // Build: newest valid build for this version number.
  const pre = (await asc(`/v1/preReleaseVersions?filter[app]=${app.id}&filter[version]=${VERSION}&filter[platform]=IOS`)).data[0];
  const b = pre && (await asc(`/v1/builds?filter[preReleaseVersion]=${pre.id}&filter[processingState]=VALID&filter[expired]=false&sort=-uploadedDate&limit=1`)).data[0];
  if (b) {
    await asc(`/v1/appStoreVersions/${ver.id}/relationships/build`, "PATCH", { type: "builds", id: b.id });
    console.log(`Build ${b.attributes.version} attached`);
  } else console.log(`No processed ${VERSION} build yet; run prep again once it finishes processing`);
}

const cmd = process.argv[2] || "status";
const s = await load();
if (cmd === "prep") { await prep(s.app); show(await load()); process.exit(0); }
if (cmd === "builds") { await builds(s.app); process.exit(0); }
if (!s.ver) { show(s); process.exit(cmd === "status" ? 0 : 1); }
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
  if (!s.build) throw new Error(`No build attached to ${VERSION}; run prep first`);
  let open = s.subs.find((x) => x.attributes.state === "READY_FOR_REVIEW");
  if (!open) {
    open = (await asc("/v1/reviewSubmissions", "POST", { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: s.app.id } } } })).data;
    await asc("/v1/reviewSubmissionItems", "POST", { type: "reviewSubmissionItems", relationships: {
      reviewSubmission: { data: { type: "reviewSubmissions", id: open.id } },
      appStoreVersion: { data: { type: "appStoreVersions", id: s.ver.id } } } });
  }
  await asc(`/v1/reviewSubmissions/${open.id}`, "PATCH", { type: "reviewSubmissions", id: open.id, attributes: { submitted: true } });
  console.log("Submitted for App Review.");
  show(await load());
} else throw new Error(`Unknown step ${cmd}`);
