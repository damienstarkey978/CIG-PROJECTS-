// GET /api/scan-status/:id  ->  job JSON
import { getStore } from "@netlify/blobs";
import jobs from "../../lib/jobs.js";

export default async (req, context) => {
  const id = context.params?.id || new URL(req.url).pathname.split("/").pop();
  if (!jobs.validId(id)) return Response.json({ error: "Bad id" }, { status: 400 });
  const job = await getStore("scans").get(`${id}/job`, { type: "json", consistency: "strong" });
  if (!job) return Response.json({ error: "Scan not found" }, { status: 404 });
  return Response.json(job, { headers: { "Cache-Control": "no-store" } });
};

export const config = { path: "/api/scan-status/:id" };
