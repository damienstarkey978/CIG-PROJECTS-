// Everyone who has signed up, for the team Users page (/admin/users).
// Accounts live in the "accounts" store as acct/<id>; scans per account per
// day are counted in the "usage" store as acct/<id>/<YYYY-MM-DD>.

export async function listUsers(accounts, usage) {
  const { blobs } = await accounts.list({ prefix: "acct/" });
  const ids = (blobs || []).map((b) => b.key.slice(5)).filter((id) => /^[a-f0-9]{24}$/.test(id));
  const rows = (await Promise.all(ids.map((id) => accounts.get(`acct/${id}`, { type: "json" })))).filter(Boolean);

  // Scan counts and last scan day per account.
  const scans = new Map();
  const { blobs: used } = await usage.list({ prefix: "acct/" });
  await Promise.all((used || []).map(async ({ key }) => {
    const [, id, d] = key.split("/");
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(d || "")) return;
    const n = ((await usage.get(key, { type: "json" })) || {}).count || 0;
    const cur = scans.get(id) || { total: 0, last: "" };
    scans.set(id, { total: cur.total + n, last: n && d > cur.last ? d : cur.last });
  }));

  return rows
    .map((a) => ({
      id: a.id,
      name: a.name || "",
      email: a.email || "",
      phone: a.phone || "",
      createdAt: a.createdAt || "",
      scans: scans.get(a.id)?.total || 0,
      lastScan: scans.get(a.id)?.last || "",
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const COLS = ["name", "email", "phone", "createdAt", "scans", "lastScan"];
export const usersCsv = (rows) => [COLS.join(","), ...rows.map((r) => COLS.map((c) => csvCell(r[c])).join(","))].join("\n");
