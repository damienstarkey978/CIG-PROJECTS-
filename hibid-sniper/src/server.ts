import path from "path";
import dotenv from "dotenv";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Manager } from "./bot/manager";
import { Lot } from "./bot/types";
import { fetchSearchResultsHtml } from "./bot/browseFetch";
import { parseSearchResults } from "./bot/browseParse";
import { config } from "./bot/config";
import { passwordGate, handleLogin, isAuthorizedRequest } from "./auth/passwordGate";

dotenv.config();

const app = express();
app.use(express.json());
app.post("/login", handleLogin);
app.use(passwordGate);
app.use(express.static(path.join(__dirname, "..", "public")));

const clients = new Set<WebSocket>();
function broadcast(lot: Lot) {
  const payload = JSON.stringify({ type: "lot", lot });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

const manager = new Manager(broadcast);

app.get("/api/lots", (_req, res) => {
  res.json(manager.list());
});

app.post("/api/lots", (req, res) => {
  const { url, label, maxBid, mode, snipeSeconds } = req.body ?? {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required" });
  }
  const parsedMax = Number(maxBid);
  if (!Number.isFinite(parsedMax) || parsedMax <= 0) {
    return res.status(400).json({ error: "maxBid must be a positive number" });
  }
  const lot = manager.add({ url, label, maxBid: parsedMax, mode, snipeSeconds });
  res.status(201).json(lot);
});

app.patch("/api/lots/:id", (req, res) => {
  const lot = manager.update(req.params.id, req.body ?? {});
  if (!lot) return res.status(404).json({ error: "not found" });
  res.json(lot);
});

app.delete("/api/lots/:id", (req, res) => {
  const ok = manager.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.status(204).end();
});

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.status(400).json({ error: "q is required" });
  try {
    const html = await fetchSearchResultsHtml(q);
    const results = await parseSearchResults(html);
    res.json(results);
  } catch (err: any) {
    res.status(502).json({ error: err.message ?? String(err) });
  }
});

const server = app.listen(config.port, () => {
  console.log(`HiBid sniper dashboard listening on port ${config.port}${config.demoMode ? " (DEMO MODE)" : ""}`);
});

const wss = new WebSocketServer({
  server,
  verifyClient: (info, done) => done(isAuthorizedRequest(info.req)),
});
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "init", lots: manager.list() }));
  ws.on("close", () => clients.delete(ws));
});

// Never let a browser-launch failure here take the process down — that
// was the original crash-loop bug. startEngine/manager never throw.
manager.startAll().catch((err) => console.error("Failed to resume watchers:", err));

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
