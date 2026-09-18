import { Page } from "playwright";
import { ensureWarmOrigin, getLoggedInContext } from "./login";
import { selectors } from "./selectors";
import { extractLotId } from "./lotId";
import {
  endTimeFromLotState,
  fetchLotDetails,
  fetchLotState,
  interpretBuyerStatus,
  placeBidMutation,
} from "./graphql";
import { Lot, LotReading, LotSource } from "./types";

const PRICE_RE = /[\d,]+(\.\d+)?/;

function parseMoney(text: string | null): number | null {
  if (!text) return null;
  const match = text.replace(/,/g, "").match(PRICE_RE);
  return match ? parseFloat(match[0]) : null;
}

function originFromLotUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "https://hibid.com";
  }
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

async function readEndTimeFromDom(page: Page): Promise<string | null> {
  try {
    const inner = page.locator(selectors.countdownInner).first();
    if ((await inner.count()) > 0) {
      const title = await inner.getAttribute("title");
      if (title) {
        const match = title.match(/closes at:\s*(.+)$/i);
        if (match) {
          const withoutTz = match[1].trim().replace(/\s+[A-Z]{2,5}$/, "");
          const d = new Date(withoutTz);
          if (!isNaN(d.getTime())) return d.toISOString();
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Real HiBid lot source. Prefers GraphQL lotState (calibrated 2026-09-18);
 * falls back to DOM selectors if GraphQL fails. Bidding prefers the `bid`
 * mutation (on MAX_BIDDING auctions the amount is the proxy ceiling); DOM
 * Bid-button click is the fallback.
 *
 * Construction never throws. init()/read()/placeBid() may throw — engine.ts
 * catches per-lot and keeps the rest of the server alive.
 */
export class LiveSource implements LotSource {
  private pages = new Map<string, Page>();
  private bidAmountType = new Map<string, string>();
  private lastBuyerHighBid = new Map<string, number>();
  private ready = false;
  private initError: Error | null = null;

  async init(): Promise<void> {
    if (this.ready || this.initError) return;
    try {
      await ensureWarmOrigin();
      this.ready = true;
    } catch (err: any) {
      this.initError = err instanceof Error ? err : new Error(String(err));
      throw this.initError;
    }
  }

  private async getPage(lot: Lot): Promise<Page> {
    let page = this.pages.get(lot.id);
    if (page && !page.isClosed()) return page;
    const context = await getLoggedInContext();
    page = await context.newPage();
    await page.goto(lot.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    this.pages.set(lot.id, page);
    return page;
  }

  private async ensureLotMeta(lot: Lot, lotId: string, origin: string): Promise<void> {
    if (this.bidAmountType.has(lot.id)) return;
    try {
      const context = await ensureWarmOrigin(origin);
      const details = await fetchLotDetails(context, lotId, origin);
      if (details.bidAmountType) this.bidAmountType.set(lot.id, details.bidAmountType);
      if (details.lead && (!lot.label || lot.label === lot.url)) {
        lot.label = details.lotNumber ? `Lot ${details.lotNumber} — ${details.lead}` : details.lead;
      }
    } catch {
      this.bidAmountType.set(lot.id, "UNKNOWN");
    }
  }

  async read(lot: Lot): Promise<LotReading> {
    const lotId = extractLotId(lot.url);
    const origin = originFromLotUrl(lot.url);

    if (!lotId) {
      throw new Error(
        `URL does not look like a HiBid lot page (expected /lot/<digits>): ${lot.url}`
      );
    }

    try {
      const context = await ensureWarmOrigin(origin);
      await this.ensureLotMeta(lot, lotId, origin);
      const state = await fetchLotState(context, lotId, origin);
      const { isWinning, isClosed } = interpretBuyerStatus(
        state.buyerBidStatus,
        state.status,
        !!state.isClosed
      );
      if (state.buyerHighBid != null) this.lastBuyerHighBid.set(lot.id, state.buyerHighBid);
      return {
        currentPrice: state.highBid ?? null,
        minNextBid: state.minBid ?? null,
        endTime: endTimeFromLotState(state),
        isWinning,
        isClosed,
      };
    } catch (gqlErr: any) {
      // Fall through to DOM
      console.warn(`GraphQL read failed for ${lotId}, falling back to DOM:`, gqlErr?.message ?? gqlErr);
    }

    const page = await this.getPage(lot);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});

    const statusEl = page.locator(selectors.bidStatus).first();
    const dataStatus = ((await statusEl.getAttribute("data-status").catch(() => null)) || "").toLowerCase();
    // data-status is BuyerBidStatus lowercased with underscores removed (nobid, winning, …)
    const domWinning = dataStatus === "winning" || dataStatus === "won" || dataStatus === "mayhavewon";
    const domClosed =
      dataStatus === "won" ||
      dataStatus === "passed" ||
      dataStatus === "declined" ||
      dataStatus === "notaccepted" ||
      dataStatus === "mayhavewon";
    const closedCount = await page.locator(selectors.lotClosed).count().catch(() => 0);
    const priceText = await readText(page, selectors.currentPrice);
    const minNextText = await readText(page, selectors.minNextBid);
    const endTime = await readEndTimeFromDom(page);

    return {
      currentPrice: parseMoney(priceText),
      minNextBid: parseMoney(minNextText),
      endTime,
      isWinning: domWinning,
      isClosed: closedCount > 0 || domClosed,
    };
  }

  async placeBid(lot: Lot, amount: number): Promise<void> {
    const lotId = extractLotId(lot.url);
    const origin = originFromLotUrl(lot.url);
    if (!lotId) throw new Error(`Cannot extract lot id from URL: ${lot.url}`);

    const context = await ensureWarmOrigin(origin);
    await this.ensureLotMeta(lot, lotId, origin);

    // On MAX_BIDDING auctions the mutation amount IS the proxy ceiling —
    // submit the user's max once so HiBid auto-rebids through soft closes.
    // On FLAT_BIDDING (or unknown), submit the min-increment amount the engine asked for.
    const type = this.bidAmountType.get(lot.id) || "UNKNOWN";
    const bidAmount = type === "MAX_BIDDING" ? lot.maxBid : amount;

    if (bidAmount > lot.maxBid) {
      throw new Error(`Refusing to bid $${bidAmount} above max $${lot.maxBid}`);
    }

    const already = this.lastBuyerHighBid.get(lot.id);
    if (type === "MAX_BIDDING" && already != null && already >= lot.maxBid) {
      // Ceiling already registered with HiBid — nothing more to submit
      return;
    }

    try {
      const result = await placeBidMutation(context, Number(lotId), bidAmount, origin, true);
      if (!result.ok) {
        const detail =
          result.messages?.join("; ") || result.bidMessage || result.typename || "bid rejected";
        throw new Error(`GraphQL bid failed: ${detail}`);
      }
      this.lastBuyerHighBid.set(lot.id, bidAmount);
      return;
    } catch (gqlErr: any) {
      console.warn(`GraphQL bid failed, trying DOM:`, gqlErr?.message ?? gqlErr);
    }

    // DOM fallback: click Bid (places min next). If a max/confirm input appears, fill maxBid.
    const page = await this.getPage(lot);
    await page.locator(selectors.placeBidButton).first().click({ timeout: 10_000 });
    await page.waitForTimeout(800);
    const amountInput = page.locator(selectors.bidAmountInput).first();
    if ((await amountInput.count().catch(() => 0)) > 0) {
      await amountInput.fill(String(type === "MAX_BIDDING" ? lot.maxBid : amount));
    }
    const confirm = page.locator(selectors.confirmBidButton).first();
    if ((await confirm.count().catch(() => 0)) > 0) await confirm.click();
    await page.waitForTimeout(800);
  }

  async dispose(lot: Lot): Promise<void> {
    const page = this.pages.get(lot.id);
    if (page) {
      await page.close().catch(() => {});
      this.pages.delete(lot.id);
    }
    this.bidAmountType.delete(lot.id);
    this.lastBuyerHighBid.delete(lot.id);
  }
}
