// Background function (runs up to 15 minutes): does the actual scan and
// writes progress + result to the "scans" blob store. Logs what each scan
// cost to the "costs" store.
import { getStore } from "@netlify/blobs";
import jobs from "../../lib/jobs.js";
import engine from "../../lib/scan.js";

export default async (req) => {
  const { id } = await req.json();
  if (!jobs.validId(id)) return;
  const store = getStore("scans");
  const input = await store.get(`${id}/input`, { type: "json" });
  if (!input) return;
  const meta = (await store.get(`${id}/meta`, { type: "json" })) || {};
  const results = getStore("wine-cache");
  const cache = {
    get: (key) => results.get(key, { type: "json" }),
    set: (key, value) => results.setJSON(key, value),
  };
  let last = null;
  // The cost stays server side; the phone gets the job without it.
  const save = (job) => {
    last = job;
    const pub = job.result && job.result.cost ? { ...job, result: { ...job.result, cost: undefined } } : job;
    return store.setJSON(`${id}/job`, pub);
  };
  try {
    await jobs.runJob(input, save, engine, cache);
  } finally {
    // The label photo is never kept after its scan, even when the scan fails.
    await store.delete(`${id}/input`).catch(() => {});
    await store.delete(`${id}/meta`).catch(() => {});
  }
  const r = last && last.result;
  if (r && r.cost) {
    const at = new Date().toISOString();
    const w = r.wine || {};
    await getStore("costs").setJSON(`${at.slice(0, 10)}/${id}`, {
      at,
      cached: Boolean(r.cached),
      wine: [w.producer, w.name, w.vintage].filter(Boolean).join(" ").slice(0, 160),
      team: meta.team || null,
      accountId: meta.accountId || null,
      ...r.cost,
    }).catch(() => {});
  }
};
