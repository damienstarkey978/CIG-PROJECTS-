// POST /api/scan-start  { image?, mediaType?, query? }  ->  { id, allowance }
// Anonymous devices get a few free scans; then a free account is needed.
import { getStore } from "@netlify/blobs";
import jobs from "../../lib/jobs.js";
import { scanAllowance, recordScan } from "../../lib/accounts.mjs";
import { stores, whoIs, json } from "../../lib/who.mjs";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const s = stores();
  const who = await whoIs(req, s);
  const cookies = who.setCookies;
  let input;
  try {
    input = jobs.parseInput(await req.json());
  } catch (err) {
    return json({ error: err.message }, { status: 400, cookies });
  }
  const limitWho = { team: who.team, accountId: who.accountId, deviceId: who.deviceId, ipHash: who.ipHash };
  const allowance = await scanAllowance(s.usage, limitWho);
  if (!allowance.ok) return json({ error: allowance.error, code: allowance.code, needAccount: Boolean(allowance.needAccount) }, { status: allowance.status, cookies });

  // Daily spend cap (WB_DAILY_CAP dollars, default 10). Team logins skip it.
  if (!who.team) {
    const cap = Number(process.env.WB_DAILY_CAP || 10);
    const t = await getStore("spend").get(`day/${new Date().toISOString().slice(0, 10)}`, { type: "json" }).catch(() => null);
    if (t && t.dollars >= cap) return json({ error: "Wine Babe has hit its scan limit for today. Please try again tomorrow." }, { status: 429, cookies });
  }
  const id = jobs.newId();
  const store = getStore("scans");
  await store.setJSON(`${id}/input`, input);
  await store.setJSON(`${id}/meta`, { team: who.team || null, accountId: who.accountId, deviceId: who.deviceId, at: Date.now() });
  await store.setJSON(`${id}/job`, { events: [], done: false, at: Date.now() });

  const origin = new URL(req.url).origin;
  const kick = await fetch(`${origin}/.netlify/functions/scan-background`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!kick.ok && kick.status !== 202) return json({ error: "Could not start the scan." }, { status: 502, cookies });
  await recordScan(s.usage, limitWho);
  const after = await scanAllowance(s.usage, limitWho);
  return json({ id, allowance: after }, { cookies });
};

export const config = { path: "/api/scan-start" };
