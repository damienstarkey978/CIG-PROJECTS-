// POST /api/scan-start  { image?, mediaType?, query? }  ->  { id }
import { getStore } from "@netlify/blobs";
import jobs from "../../lib/jobs.js";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let input;
  try {
    input = jobs.parseInput(await req.json());
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const id = jobs.newId();
  const store = getStore("scans");
  await store.setJSON(`${id}/input`, input);
  await store.setJSON(`${id}/job`, { events: [], done: false, at: Date.now() });

  const origin = new URL(req.url).origin;
  const kick = await fetch(`${origin}/.netlify/functions/scan-background`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!kick.ok && kick.status !== 202) return Response.json({ error: "Could not start the scan." }, { status: 502 });
  return Response.json({ id });
};

export const config = { path: "/api/scan-start" };
