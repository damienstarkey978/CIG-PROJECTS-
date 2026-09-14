import { Page } from "playwright";
import { getLoggedInContext } from "./browser";
import { selectors } from "./selectors";
import { Lot } from "./types";

export type OnUpdate = (lot: Lot) => void;

const PRICE_RE = /[\d,]+(\.\d+)?/;

function parseMoney(text: string | null): number | null {
  if (!text) return null;
  const match = text.replace(/,/g, "").match(PRICE_RE);
  return match ? parseFloat(match[0]) : null;
}

async function readText(page: Page, selector: string): Promise<string | null> {
  try {
    const el = page.locator(selector).first();
    if ((await el.count()) === 0) return null;
    return (await el.textContent())?.trim() ?? null;
  } catch {
    return null;
  }
}

async function readEndTime(page: Page): Promise<string | null> {
  try {
    const el = page.locator(selectors.countdown).first();
    if ((await el.count()) === 0) return null;
    const attr = await el.getAttribute(selectors.countdownEndTimeAttr);
    if (attr) {
      const asDate = new Date(isNaN(Number(attr)) ? attr : Number(attr));
      if (!isNaN(asDate.getTime())) return asDate.toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

/** Adaptive poll interval: hammer the page as the close time nears. */
function pollIntervalMs(lot: Lot): number {
  if (!lot.endTime) return 20_000;
  const msLeft = new Date(lot.endTime).getTime() - Date.now();
  if (msLeft <= 0) return 2_000; // waiting to confirm close
  if (msLeft < 30_000) return 500;
  if (msLeft < 5 * 60_000) return 2_000;
  if (msLeft < 30 * 60_000) return 10_000;
  return 30_000;
}

/** Next bid to submit for proxy bidding, capped at the lot's max. */
function nextBidAmount(lot: Lot): number | null {
  const floor = lot.minNextBid ?? (lot.currentPrice != null ? lot.currentPrice + 1 : null);
  if (floor == null) return null;
  if (floor > lot.maxBid) return null; // can't afford the next increment
  return floor;
}

export class LotWatcher {
  private lot: Lot;
  private onUpdate: OnUpdate;
  private timer: NodeJS.Timeout | null = null;
  private page: Page | null = null;
  private stopped = false;

  constructor(lot: Lot, onUpdate: OnUpdate) {
    this.lot = lot;
    this.onUpdate = onUpdate;
  }

  private log(message: string) {
    this.lot.log.unshift({ ts: Date.now(), message });
    this.lot.log = this.lot.log.slice(0, 100);
    this.onUpdate(this.lot);
  }

  async start() {
    this.stopped = false;
    try {
      const context = await getLoggedInContext();
      this.page = await context.newPage();
      await this.page.goto(this.lot.url, { waitUntil: "domcontentloaded" });
      this.log("Watching lot.");
      this.scheduleNext(0);
    } catch (err: any) {
      this.lot.status = "error";
      this.log(`Failed to start: ${err.message ?? err}`);
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.page?.close().catch(() => {});
  }

  private scheduleNext(delayMs: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick(), delayMs);
  }

  private async tick() {
    if (this.stopped || !this.page || this.lot.paused) {
      this.scheduleNext(3000);
      return;
    }

    try {
      await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});

      const closedEl = this.page.locator(selectors.lotClosed).first();
      const isClosed = (await closedEl.count()) > 0;

      const priceText = await readText(this.page, selectors.currentPrice);
      const minNextText = await readText(this.page, selectors.minNextBid);
      const endTime = await readEndTime(this.page);
      const winningEl = this.page.locator(selectors.youAreWinning).first();
      const isWinning = (await winningEl.count()) > 0;

      this.lot.currentPrice = parseMoney(priceText) ?? this.lot.currentPrice;
      this.lot.minNextBid = parseMoney(minNextText) ?? this.lot.minNextBid;
      this.lot.endTime = endTime ?? this.lot.endTime;
      this.lot.lastChecked = Date.now();

      if (isClosed) {
        this.lot.status = isWinning ? "won" : "lost";
        this.log(isWinning ? "Lot closed — you won." : "Lot closed — you did not win.");
        this.onUpdate(this.lot);
        this.stop();
        return;
      }

      if (isWinning) {
        this.lot.status = "winning";
      } else {
        this.lot.status = "outbid";
        await this.maybeBid();
      }

      this.onUpdate(this.lot);
    } catch (err: any) {
      this.log(`Poll error: ${err.message ?? err}`);
    }

    this.scheduleNext(pollIntervalMs(this.lot));
  }

  private async maybeBid() {
    if (!this.page) return;

    if (this.lot.mode === "snipe" && this.lot.endTime) {
      const msLeft = new Date(this.lot.endTime).getTime() - Date.now();
      if (msLeft > this.lot.snipeSeconds * 1000) {
        // Holding off — not time to reveal a bid yet.
        return;
      }
    }

    const amount = nextBidAmount(this.lot);
    if (amount == null) {
      this.log(`Outbid, but next bid would exceed your max of $${this.lot.maxBid}. Not bidding.`);
      return;
    }

    try {
      await this.page.fill(selectors.bidAmountInput, String(amount));
      await this.page.click(selectors.placeBidButton);
      const confirm = this.page.locator(selectors.confirmBidButton).first();
      if ((await confirm.count()) > 0) await confirm.click();
      await this.page.waitForTimeout(800);
      this.log(`Placed bid: $${amount}.`);
    } catch (err: any) {
      this.lot.status = "error";
      this.log(`Bid attempt failed: ${err.message ?? err}`);
    }
  }
}
