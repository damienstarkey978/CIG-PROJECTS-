import { Lot, LotSource } from "./types";
import { LiveSource } from "./scraper";
import { DemoSource } from "./demoSource";
import { config } from "./config";

function makeSource(): LotSource {
  return config.demoMode ? new DemoSource() : new LiveSource();
}

const source: LotSource = makeSource();
let sourceReady = false;
let sourceInitPromise: Promise<void> | null = null;

/**
 * The bug that took the whole process down before: source.init() (which
 * launches a real Chromium under LiveSource) used to be awaited directly
 * from startup with nothing catching a failure, so a missing/mismatched
 * browser binary threw out of main() and crashed the server — no
 * dashboard, no API, nothing. Now a failure here just marks this lot's
 * tick as errored and retries later; the server itself never sees it.
 */
async function ensureSourceReady(): Promise<void> {
  if (sourceReady) return;
  if (!sourceInitPromise) {
    sourceInitPromise = source.init().then(() => {
      sourceReady = true;
    });
  }
  try {
    await sourceInitPromise;
  } catch (err) {
    sourceInitPromise = null; // let the next tick retry instead of staying wedged
    throw err;
  }
}

type OnUpdate = (lot: Lot) => void;

const timers = new Map<string, NodeJS.Timeout>();

function log(lot: Lot, onUpdate: OnUpdate, message: string) {
  lot.log.unshift({ ts: Date.now(), message });
  lot.log = lot.log.slice(0, 100);
  onUpdate(lot);
}

/** Adaptive poll interval: hammer the page as the close time nears. */
function pollIntervalMs(lot: Lot): number {
  if (!lot.endTime) return 20_000;
  const msLeft = new Date(lot.endTime).getTime() - Date.now();
  if (msLeft <= 0) return 2_000;
  if (msLeft < 30_000) return 500;
  if (msLeft < 5 * 60_000) return 2_000;
  if (msLeft < 30 * 60_000) return 10_000;
  return 30_000;
}

/** Next bid to submit for proxy bidding, capped at the lot's max. */
function nextBidAmount(lot: Lot): number | null {
  const floor = lot.minNextBid ?? (lot.currentPrice != null ? lot.currentPrice + 1 : null);
  if (floor == null) return null;
  if (floor > lot.maxBid) return null;
  return floor;
}

function scheduleNext(lot: Lot, onUpdate: OnUpdate, delayMs: number) {
  const existing = timers.get(lot.id);
  if (existing) clearTimeout(existing);
  timers.set(
    lot.id,
    setTimeout(() => {
      tick(lot, onUpdate).catch((err) => log(lot, onUpdate, `Unexpected engine error: ${err.message ?? err}`));
    }, delayMs)
  );
}

async function maybeBid(lot: Lot, onUpdate: OnUpdate) {
  if (lot.mode === "snipe" && lot.endTime) {
    const msLeft = new Date(lot.endTime).getTime() - Date.now();
    if (msLeft > lot.snipeSeconds * 1000) return; // holding off, not time yet
  }

  const amount = nextBidAmount(lot);
  if (amount == null) {
    log(lot, onUpdate, `Outbid, but next bid would exceed your max of $${lot.maxBid}. Not bidding.`);
    return;
  }

  try {
    // LiveSource may submit lot.maxBid as a HiBid native proxy ceiling on
    // MAX_BIDDING auctions (amount is still the min-next floor check above).
    await source.placeBid(lot, amount);
    log(
      lot,
      onUpdate,
      `Placed bid (engine floor $${amount}, max $${lot.maxBid}). Soft-close extensions stay covered while under max.`
    );
  } catch (err: any) {
    lot.status = "error";
    log(lot, onUpdate, `Bid attempt failed: ${err.message ?? err}`);
  }
}

async function tick(lot: Lot, onUpdate: OnUpdate): Promise<void> {
  if (lot.paused || lot.status === "won" || lot.status === "lost") return;

  try {
    await ensureSourceReady();
  } catch (err: any) {
    lot.status = "error";
    log(lot, onUpdate, `Bidding engine unavailable (${err.message ?? err}). Retrying in 30s.`);
    scheduleNext(lot, onUpdate, 30_000);
    return;
  }

  try {
    const reading = await source.read(lot);
    lot.currentPrice = reading.currentPrice ?? lot.currentPrice;
    lot.minNextBid = reading.minNextBid ?? lot.minNextBid;
    lot.endTime = reading.endTime ?? lot.endTime;
    lot.lastChecked = Date.now();

    if (reading.isClosed) {
      lot.status = reading.isWinning ? "won" : "lost";
      log(lot, onUpdate, reading.isWinning ? "Lot closed — you won." : "Lot closed — you did not win.");
      await source.dispose(lot);
      return; // terminal — no reschedule
    }

    if (reading.isWinning) {
      lot.status = "winning";
    } else {
      lot.status = "outbid";
      await maybeBid(lot, onUpdate);
    }
    onUpdate(lot);
  } catch (err: any) {
    lot.status = "error";
    log(lot, onUpdate, `Poll error: ${err.message ?? err}`);
  }

  scheduleNext(lot, onUpdate, pollIntervalMs(lot));
}

export function watchLot(lot: Lot, onUpdate: OnUpdate): void {
  log(lot, onUpdate, "Watching lot.");
  scheduleNext(lot, onUpdate, 0);
}

export function unwatchLot(lotId: string): void {
  const timer = timers.get(lotId);
  if (timer) clearTimeout(timer);
  timers.delete(lotId);
}

/** Resumes watching every non-terminal lot. Never throws — startup must not depend on the browser working. */
export async function startEngine(lots: Lot[], onUpdate: OnUpdate): Promise<void> {
  for (const lot of lots) {
    if (lot.status === "won" || lot.status === "lost") continue;
    watchLot(lot, onUpdate);
  }
}

export async function stopEngine(): Promise<void> {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
