import engine from "../../lib/scan.js";

export default async () => Response.json({ ok: true, live: engine.HAS_KEY, unlocker: engine.HAS_UNLOCKER });

export const config = { path: "/api/health" };
