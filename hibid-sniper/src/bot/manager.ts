import { randomUUID } from "crypto";
import { loadLots, saveLots } from "./store";
import { watchLot, unwatchLot, startEngine } from "./engine";
import { config } from "./config";
import { Lot, NewLotInput } from "./types";

export class Manager {
  private lots: Map<string, Lot> = new Map();
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

  add(input: NewLotInput): Lot {
    const lot: Lot = {
      id: randomUUID(),
      url: input.url,
      label: input.label?.trim() || input.url,
      maxBid: input.maxBid,
      mode: input.mode ?? "proxy",
      snipeSeconds: input.snipeSeconds ?? config.defaultSnipeSeconds,
      status: "watching",
      currentPrice: null,
      minNextBid: null,
      endTime: null,
      lastChecked: null,
      paused: false,
      log: [],
    };
    this.lots.set(lot.id, lot);
    this.persist();
    watchLot(lot, this.handleUpdate);
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
    unwatchLot(id);
    const existed = this.lots.delete(id);
    this.persist();
    return existed;
  }

  /** Resumes watching every lot loaded from disk. Never throws. */
  async startAll(): Promise<void> {
    await startEngine(this.list(), this.handleUpdate);
  }
}
