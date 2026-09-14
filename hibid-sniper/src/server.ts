import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Manager } from "./bot/manager";
import { Lot } from "./bot/types";

dotenv.config();

/**
 * On a hosted deploy (Railway, Render, etc.) there's no terminal to run
 * `npm run inspect` in. Instead, capture the logged-in session once on
 * your own computer, base64-encode data/auth.json, and set it as the
 * HIBID_AUTH_STATE_B64 environment variable in the hosting dashboard. On
 * boot we decode it straight back to data/auth.json so the bot starts
 * already logged in, no scripted login required.
 */
function bootstrapAuthFromEnv() {
  const b64 = process.env.HIBID_AUTH_STATE_B64;
  if (!b64) return;
  const dataDir = path.join(__dirname, "..", "data");
  const authFile = path.join(dataDir, "auth.json");
  if (fs.existsSync(authFile)) return; // don't clobber a session already on disk
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(authFile, Buffer.from(b64, "base64"));
  console.log("Restored HiBid session from HIBID_AUTH_STATE_B64.");
}
bootstrapAuthFromEnv();

const PORT = Number(process.env.PORT ?? 4310);
const app = express();
app.use(express.json());
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

app.post("/api/lots", async (req, res) => {
  const { url, label, maxBid, mode, snipeSeconds } = req.body ?? {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required" });
  }
  const parsedMax = Number(maxBid);
  if (!Number.isFinite(parsedMax) || parsedMax <= 0) {
    return res.status(400).json({ error: "maxBid must be a positive number" });
  }
  try {
    const lot = await manager.add({ url, label, maxBid: parsedMax, mode, snipeSeconds });
    res.status(201).json(lot);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? String(err) });
  }
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

const server = app.listen(PORT, () => {
  console.log(`HiBid sniper dashboard: http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "init", lots: manager.list() }));
  ws.on("close", () => clients.delete(ws));
});

manager.startAll().catch((err) => console.error("Failed to resume watchers:", err));

process.on("SIGINT", () => process.exit(0));
