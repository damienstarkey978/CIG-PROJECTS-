import { randomUUID } from "crypto";
import { loadLots, saveLots } from "./store";
import { LotWatcher } from "./lotWatcher";
import { Lot, NewLotInput } from "./types";

const TERMINAL_STATUSES = new Set(["won", "lost"]);

export class Manager {
  private lots: Map<string, Lot> = new Map();
  private watchers: Map<string, LotWatcher> = new Map();
  private onChange: (lot: Lot) => void;

  constructor(onChange: (lot: Lot) => void) {
    this.onChange = onChange;
    for (const lot of loadLots()) this.lots.set(lot.id, lot);
  }

  list(): Lot[] {
    return [...this.lots.values()];
  }

  private persist() {
    saveLots(this.list());
  }

  private handleUpdate = (lot: Lot) => {
    this.lots.set(lot.id, lot);
    this.persist();
    this.onChange(lot);
  };

  async add(input: NewLotInput): Promise<Lot> {
    const lot: Lot = {
      id: randomUUID(),
      url: input.url,
      label: input.label?.trim() || input.url,
      maxBid: input.maxBid,
      mode: input.mode ?? "proxy",
      snipeSeconds: input.snipeSeconds ?? Number(process.env.DEFAULT_SNIPE_SECONDS ?? 8),
      status: "watching",
      currentPrice: null,
      minNextBid: null,
      endTime: null,
      lastChecked: null,
      paused: false,
      log: [{ ts: Date.now(), message: "Added." }],
    };
    this.lots.set(lot.id, lot);
    this.persist();
    await this.startWatcher(lot);
    return lot;
  }

  update(id: string, patch: Partial<Pick<Lot, "maxBid" | "mode" | "snipeSeconds" | "label" | "paused">>): Lot | null {
    const lot = this.lots.get(id);
    if (!lot) return null;
    Object.assign(lot, patch);
    if (patch.paused === false && lot.status === "paused") lot.status = "watching";
    this.lots.set(id, lot);
    this.persist();
    this.onChange(lot);
    return lot;
  }

  remove(id: string): boolean {
    this.watchers.get(id)?.stop();
    this.watchers.delete(id);
    const existed = this.lots.delete(id);
    this.persist();
    return existed;
  }

  private async startWatcher(lot: Lot) {
    if (TERMINAL_STATUSES.has(lot.status)) return;
    const watcher = new LotWatcher(lot, this.handleUpdate);
    this.watchers.set(lot.id, watcher);
    await watcher.start();
  }

  /** Resume watching every non-finished lot loaded from disk on boot. */
  async startAll() {
    for (const lot of this.lots.values()) {
      if (!TERMINAL_STATUSES.has(lot.status)) {
        await this.startWatcher(lot);
      }
    }
  }
}
