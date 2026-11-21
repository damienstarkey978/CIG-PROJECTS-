// Team pages (need the team password; the edge gate checks it too):
//   GET /admin               feedback list + what scans cost
//   GET /admin/feedback.csv
//   GET /admin/costs.csv
import { listFeedback, feedbackCsv } from "../../lib/feedback.mjs";
import { stores, whoIs } from "../../lib/who.mjs";
import { isReviewUser } from "../../lib/auth.mjs";

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (n) => `$${(n || 0).toFixed(2)}`;
const when = (iso) => esc(String(iso || "").slice(0, 16).replace("T", " "));

export async function listCosts(store, days = 30, now = Date.now()) {
  const since = new Date(now - days * 864e5).toISOString().slice(0, 10);
  const { blobs } = await store.list();
  const keys = (blobs || []).map((b) => b.key).filter((k) => k.slice(0, 10) >= since);
  const rows = await Promise.all(keys.map((k) => store.get(k, { type: "json" })));
  return rows.filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function costSummary(rows) {
  const sum = (list) => list.reduce((t, r) => t + (r.dollars || 0), 0);
  const fresh = rows.filter((r) => !r.cached);
  const repeat = rows.filter((r) => r.cached);
  return {
    scans: rows.length,
    total: sum(rows),
    newCount: fresh.length,
    newAvg: fresh.length ? sum(fresh) / fresh.length : 0,
    repeatCount: repeat.length,
    repeatAvg: repeat.length ? sum(repeat) / repeat.length : 0,
    searches: rows.reduce((t, r) => t + (r.searches || 0), 0),
  };
}

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const COST_COLS = ["at", "wine", "cached", "dollars", "tokenDollars", "searchDollars", "searches", "fetches", "calls", "inputTokens", "outputTokens", "team", "accountId"];
const costsCsv = (rows) => [COST_COLS.join(","), ...rows.map((r) => COST_COLS.map((c) => csvCell(r[c])).join(","))].join("\n");

function page(feedback, costs) {
  const c = costSummary(costs);
  const fb = feedback.slice(0, 300).map((e) => `<tr><td>${when(e.at)}</td><td>${esc(e.type)}</td><td class="t">${esc(e.text)}</td><td>${esc(e.name)}<br>${esc(e.email)}</td><td>${esc(e.appVersion)}<br>${esc(e.platform)}</td><td>${e.emailed?.ok ? "sent" : esc(e.emailed?.reason || "")}</td></tr>`).join("");
  const cs = costs.slice(0, 100).map((r) => `<tr><td>${when(r.at)}</td><td>${esc(r.wine)}</td><td>${r.cached ? "repeat" : "new"}</td><td>${money(r.dollars)}</td><td>${r.searches || 0}</td><td>${r.calls || 0}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wine Babe admin</title><style>
body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#f7f1ec;color:#2b1d1f}
h1,h2{font-weight:600}h2{margin-top:28px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card{background:#fffaf6;border:1px solid #eadfd8;border-radius:12px;padding:12px}.card b{display:block;font-size:1.3rem}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;background:#fffaf6;font-size:14px}
td,th{border-bottom:1px solid #eadfd8;padding:8px;text-align:left;vertical-align:top}.t{white-space:pre-wrap;min-width:240px}
a{color:#7a2e3b}
</style></head><body>
<h1>Wine Babe admin</h1>
<h2>Scan costs, last 30 days</h2>
<div class="cards">
<div class="card"><b>${c.scans}</b>scans</div>
<div class="card"><b>${money(c.total)}</b>total</div>
<div class="card"><b>${money(c.newAvg)}</b>per new wine (${c.newCount})</div>
<div class="card"><b>${money(c.repeatAvg)}</b>per repeat wine (${c.repeatCount})</div>
<div class="card"><b>${c.searches}</b>web searches</div>
</div>
<p><a href="/admin/costs.csv">Download costs CSV</a></p>
<div class="wrap"><table><tr><th>When (UTC)</th><th>Wine</th><th>Kind</th><th>Cost</th><th>Searches</th><th>AI calls</th></tr>${cs || '<tr><td colspan="6">No scans logged yet.</td></tr>'}</table></div>
<h2>Feedback (${feedback.length})</h2>
<p><a href="/admin/feedback.csv">Download feedback CSV</a></p>
<div class="wrap"><table><tr><th>When (UTC)</th><th>Type</th><th>Feedback</th><th>From</th><th>App</th><th>Email</th></tr>${fb || '<tr><td colspan="6">No feedback yet.</td></tr>'}</table></div>
</body></html>`;
}

export default async (req) => {
  const s = stores();
  const who = await whoIs(req, s);
  if (!who.team) return new Response(null, { status: 302, headers: { Location: "/login?next=/admin" } });
  if (isReviewUser(who.team)) return new Response(null, { status: 302, headers: { Location: "/" } });
  const p = new URL(req.url).pathname;
  const csv = (body, name) => new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
  if (p === "/admin/feedback.csv") return csv(feedbackCsv(await listFeedback(s.feedback)), "wine-babe-feedback.csv");
  if (p === "/admin/costs.csv") return csv(costsCsv(await listCosts(s.costs, 365)), "wine-babe-scan-costs.csv");
  const [feedback, costs] = await Promise.all([listFeedback(s.feedback), listCosts(s.costs)]);
  return new Response(page(feedback, costs), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
};

export const config = { path: ["/admin", "/admin/*"] };
