// Skinny Sip Approved list: every wine whose verified sugar is 1 g or less
// per 5 oz is saved here with its full scan, so people can browse and open it.
import { getStore } from "@netlify/blobs";

const PER_5OZ = 0.14787;
const VERIFIED = ["lab", "winery", "certified", "third_party"];

// Same rule the app uses for the Skinny Sip Approved badge.
export function approved(result) {
  if (!result || !result.identified || !result.wine) return null;
  const sc = (result.checks || []).find((c) => c.id === "sugar_under_1g");
  const n = result.nutrition || {};
  if (!sc || !["pass", "fail"].includes(sc.status) || !VERIFIED.includes(sc.evidence)) return null;
  let g = null;
  if (n.residual_sugar_g_l != null) g = Math.round(n.residual_sugar_g_l * PER_5OZ * 100) / 100;
  else if (n.sugar_below_g_l != null) g = n.sugar_below_g_l * PER_5OZ;
  if (g == null || g > 1.0001) return null;
  return g;
}

const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const wineKey = (w) => [slug(w.producer), slug(w.name), /^(19|20)\d{2}$/.test(String(w.vintage || "")) ? w.vintage : "nv"].filter(Boolean).join("__").slice(0, 150);

const summary = (result, g) => {
  const w = result.wine;
  return { key: wineKey(w), name: w.name || "", producer: w.producer || "", vintage: w.vintage || "", sugar5: Math.round(g * 100) / 100, at: Date.now() };
};

export async function saveIfApproved(result) {
  const g = approved(result);
  if (g == null) return false;
  const s = summary(result, g);
  if (!s.key) return false;
  const store = getStore("skinny");
  const clean = { ...result, cost: undefined, debug: undefined, brain: undefined };
  await store.setJSON(`wine/${s.key}`, clean);
  const list = (await store.get("index", { type: "json", consistency: "strong" }).catch(() => null)) || [];
  const next = [s, ...list.filter((e) => e.key !== s.key)];
  await store.setJSON("index", next);
  return true;
}

// One time fill from wines scanned before this list existed.
export async function backfill() {
  const cache = getStore("wine-cache");
  const { blobs } = await cache.list({ prefix: "brain__" });
  for (const b of blobs || []) {
    const e = await cache.get(b.key, { type: "json" }).catch(() => null);
    if (e && e.result) await saveIfApproved(e.result).catch(() => {});
  }
}
