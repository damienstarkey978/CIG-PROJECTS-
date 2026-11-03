import engine from "../../lib/scan.js";

export default async () => Response.json({ ok: true, live: engine.HAS_KEY });

export const config = { path: "/api/health" };
