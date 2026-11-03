// Background function (runs up to 15 minutes): does the actual scan and
// writes progress + result to the "scans" blob store.
import { getStore } from "@netlify/blobs";
import jobs from "../../lib/jobs.js";
import engine from "../../lib/scan.js";

export default async (req) => {
  const { id } = await req.json();
  if (!jobs.validId(id)) return;
  const store = getStore("scans");
  const input = await store.get(`${id}/input`, { type: "json" });
  if (!input) return;
  const results = getStore("wine-cache");
  const cache = {
    get: (key) => results.get(key, { type: "json" }),
    set: (key, value) => results.setJSON(key, value),
  };
  await jobs.runJob(input, (job) => store.setJSON(`${id}/job`, job), engine, cache);
  await store.delete(`${id}/input`);
};
