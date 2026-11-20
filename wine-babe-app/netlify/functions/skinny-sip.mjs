// GET /api/skinny-sip            -> { list }  (all Skinny Sip Approved wines)
// GET /api/skinny-sip?key=<key>  -> { result } (the full saved scan)
import { getStore } from "@netlify/blobs";
import { backfill } from "../../lib/skinny.mjs";

export default async (req) => {
  const store = getStore("skinny");
  const key = new URL(req.url).searchParams.get("key");
  const h = { "Cache-Control": "no-store" };
  if (key) {
    if (!/^[a-z0-9_-]{1,150}$/.test(key)) return Response.json({ error: "Bad key" }, { status: 400 });
    const result = await store.get(`wine/${key}`, { type: "json" });
    return result ? Response.json({ result }, { headers: h }) : Response.json({ error: "Not found" }, { status: 404 });
  }
  let list = await store.get("index", { type: "json", consistency: "strong" }).catch(() => null);
  if (!list) { await backfill().catch(() => {}); list = (await store.get("index", { type: "json", consistency: "strong" }).catch(() => null)) || []; }
  list = [...list].sort((a, b) => `${a.producer} ${a.name}`.localeCompare(`${b.producer} ${b.name}`));
  return Response.json({ list }, { headers: h });
};

export const config = { path: "/api/skinny-sip" };
