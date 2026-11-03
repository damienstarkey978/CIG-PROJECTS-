// Wine Babe scanner server (Fly / local).
// Serves ./public plus POST /api/scan-start and GET /api/scan-status/:id,
// the same API the Netlify functions expose.

const http = require("http");
const fs = require("fs");
const path = require("path");
const engine = require("./lib/scan.js");
const jobs = require("./lib/jobs.js");

const PORT = Number(process.env.PORT || 8080);
const PUBLIC = path.join(__dirname, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

// ---------- http ----------

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("Photo is too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Jobs live in memory here; on Netlify they live in Blobs (see netlify/functions).
const JOBS = new Map();
const RESULTS = new Map(); // scan cache, in memory
const cache = { get: async (k) => RESULTS.get(k) || null, set: async (k, v) => { RESULTS.set(k, v); } };
const json = (res, code, obj) => res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(obj));

async function handleStart(req, res) {
  let input;
  try {
    input = jobs.parseInput(JSON.parse((await readBody(req)) || "{}"));
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
  const id = jobs.newId();
  JOBS.set(id, { events: [], done: false });
  jobs.runJob(input, (job) => { JOBS.set(id, job); }, engine, cache);
  setTimeout(() => JOBS.delete(id), 30 * 60 * 1000).unref();
  json(res, 200, { id });
}

function handleStatus(res, id) {
  const job = jobs.validId(id) && JOBS.get(id);
  return job ? json(res, 200, job) : json(res, 404, { error: "Scan not found" });
}

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, "index.html"), (e2, html) => {
        res.writeHead(e2 ? 404 : 200, { "Content-Type": TYPES[".html"] }).end(e2 ? "Not found" : html);
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": p === "/index.html" || p === "/sw.js" ? "no-cache" : "public, max-age=3600",
    }).end(buf);
  });
}

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/scan-start") return void handleStart(req, res);
    const m = req.url.match(/^\/api\/scan-status\/([^/?]+)/);
    if (m) return handleStatus(res, m[1]);
    if (req.url === "/api/health") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, live: engine.HAS_KEY }));
    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(405).end();
  })
  .listen(PORT, () => console.log(`Wine Babe on http://localhost:${PORT} (${engine.HAS_KEY ? "live" : "demo mode"})`));
