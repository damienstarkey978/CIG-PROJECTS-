// Top Pours: every wine anyone has scanned that scores 90 or more.
// Shared by the Netlify function and the local server.

const MAX = 1000; // safety cap
const MIN_SCORE = 90;

const keyOf = (w) => [w.producer, w.name, w.vintage].map((x) => String(x || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim()).join("|");

// Adds a scan to the list when it qualifies. Returns the new list, or null
// when nothing changed. `job` is the stored scan (read on the server, so the
// wine details come from the scan itself, not from the browser).
function addEntry(list, job, id, score, tier) {
  const r = job && job.done && job.result;
  if (!r || !r.identified || !r.wine) return null;
  const s = Number(score);
  if (!Number.isFinite(s) || s < MIN_SCORE || s > 100) return null;
  if (/additional verification/i.test(String(tier || ""))) return null;
  const w = r.wine;
  const entry = {
    key: keyOf(w), id, score: Math.round(s), tier: String(tier || "").slice(0, 60), at: Date.now(),
    wine: { name: String(w.name || "").slice(0, 120), producer: String(w.producer || "").slice(0, 120), vintage: String(w.vintage || "").slice(0, 10), style: String(w.style || "").slice(0, 60) },
  };
  if (!entry.key.replace(/\|/g, "")) return null;
  const rest = (Array.isArray(list) ? list : []).filter((e) => e.key !== entry.key);
  const prev = (Array.isArray(list) ? list : []).find((e) => e.key === entry.key);
  // Keep the newest scan of a wine (scores can change as data improves).
  const next = [...rest, entry].sort((a, b) => b.score - a.score || b.at - a.at).slice(0, MAX);
  if (prev && prev.score === entry.score && prev.id === entry.id) return null;
  return next;
}

module.exports = { addEntry, keyOf, MAX, MIN_SCORE };
