// GET  /api/top-pours        -> { list }
// POST /api/top-pours {id, score, tier} -> { list, added }
import { getStore } from "@netlify/blobs";
import jobs from "../../lib/jobs.js";
import tp from "../../lib/toppours.js";

export default async (req) => {
  const store = getStore("top-pours");
  const list = (await store.get("list", { type: "json", consistency: "strong" })) || [];
  if (req.method === "GET") return Response.json({ list }, { headers: { "Cache-Control": "no-store" } });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "Bad request" }, { status: 400 }); }
  if (!jobs.validId(body.id)) return Response.json({ error: "Bad id" }, { status: 400 });
  const job = await getStore("scans").get(`${body.id}/job`, { type: "json", consistency: "strong" });
  const next = tp.addEntry(list, job, body.id, body.score, body.tier);
  if (next) await store.setJSON("list", next);
  const final = next || list;
  return Response.json({ list: final, added: final.some((e) => e.id === body.id) }, { headers: { "Cache-Control": "no-store" } });
};

export const config = { path: "/api/top-pours" };
