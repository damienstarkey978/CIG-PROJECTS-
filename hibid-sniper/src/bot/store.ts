import fs from "fs";
import path from "path";
import { Lot } from "./types";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const LOTS_FILE = path.join(DATA_DIR, "lots.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadLots(): Lot[] {
  ensureDataDir();
  if (!fs.existsSync(LOTS_FILE)) return [];
  try {
    const raw = fs.readFileSync(LOTS_FILE, "utf-8");
    return JSON.parse(raw) as Lot[];
  } catch {
    return [];
  }
}

export function saveLots(lots: Lot[]): void {
  ensureDataDir();
  fs.writeFileSync(LOTS_FILE, JSON.stringify(lots, null, 2));
}
