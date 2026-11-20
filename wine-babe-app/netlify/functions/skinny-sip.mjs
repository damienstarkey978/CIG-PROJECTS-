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
  // Variants of one wine (brand spelled two ways, short and long names) show once: keep the longest name.
  const toks = (e) => new Set(`${e.name}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const brand = (e) => (e.producer.toLowerCase().split(/[^a-z0-9]+/)[0] || "");
  list = list.filter((e, i) => !list.some((o, j) => j !== i && brand(o) === brand(e) && o.vintage === e.vintage && ((t) => [...toks(e)].every((w) => t.has(w)) && (toks(o).size > toks(e).size || (toks(o).size === toks(e).size && j < i)))(toks(o))));
  list = [...list].sort((a, b) => `${a.producer} ${a.name}`.localeCompare(`${b.producer} ${b.name}`));
  return Response.json({ list }, { headers: h });
};

export const config = { path: "/api/skinny-sip" };
