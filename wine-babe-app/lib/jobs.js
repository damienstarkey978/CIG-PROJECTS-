// Scan job helpers shared by server.js and the Netlify functions.
// A job is { events: [{type,text}], done, result, error, at }.

const crypto = require("crypto");

const MAX_IMAGE = 8 * 1024 * 1024;

function parseInput(body) {
  const image = typeof body.image === "string" ? body.image.replace(/^data:[^,]+,/, "") : null;
  const query = typeof body.query === "string" ? body.query.trim().slice(0, 300) : "";
  if (!image && !query) throw new Error("Send a photo or a wine name.");
  if (image && image.length > MAX_IMAGE) throw new Error("Photo is too large.");
  return { image, query, fresh: body.fresh === true, mediaType: body.mediaType === "image/png" ? "image/png" : "image/jpeg" };
}

const newId = () => crypto.randomBytes(12).toString("hex");
const validId = (id) => typeof id === "string" && /^[a-f0-9]{24}$/.test(id);

// Runs one scan, calling save(job) whenever it changes.
// cache (optional): { get(key) -> value|null, set(key, value) } for finished scans.
async function runJob(input, save, engine, cache) {
  const job = { events: [], done: false, result: null, error: null, at: Date.now() };
  const push = async (ev) => { job.events.push(ev); await save(job); };
  try {
    await push({ type: "status", text: input.image ? "Reading the label" : "Looking up the wine" });
    const send = (ev) => { push(ev).catch(() => {}); };
    job.result = engine.HAS_KEY ? await engine.runScan(input, send, cache) : await engine.runDemo(send);
  } catch (err) {
    console.error(err);
    job.error = err.message || "Something went wrong.";
  }
  job.done = true;
  await save(job);
}

module.exports = { parseInput, newId, validId, runJob };
