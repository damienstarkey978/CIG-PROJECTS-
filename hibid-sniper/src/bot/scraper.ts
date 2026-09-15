import { Page } from "playwright";
import { getLoggedInContext } from "./login";
import { selectors } from "./selectors";
import { Lot, LotReading, LotSource } from "./types";

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

/**
 * Real HiBid lot source: drives a headless Playwright page against the
 * live site. Every launch/navigation/bid call here can fail in ways
 * outside our control (missing browser binary, changed page markup, a
 * network hiccup against hibid.com) — none of that should ever escape
 * this class and crash the whole server. Callers (engine.ts) already
 * expect init()/read()/placeBid() to throw on failure and handle it per
 * lot; this class's job is just to make sure those are the *only* things
 * that throw, not something during construction that takes the process
 * down before it even starts listening.
 */
export class LiveSource implements LotSource {
  private pages = new Map<string, Page>();
  private ready = false;
  private initError: Error | null = null;

  async init(): Promise<void> {
    if (this.ready || this.initError) return;
    try {
      // Cheapest possible proof the browser binary + context actually
      // work, done once up front rather than deferred entirely to the
      // first lot's first poll, so failures surface in logs immediately.
      await getLoggedInContext();
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
    await page.goto(lot.url, { waitUntil: "domcontentloaded" });
    this.pages.set(lot.id, page);
    return page;
  }

  async read(lot: Lot): Promise<LotReading> {
    const page = await this.getPage(lot);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});

    const closedCount = await page.locator(selectors.lotClosed).count().catch(() => 0);
    const winningCount = await page.locator(selectors.youAreWinning).count().catch(() => 0);
    const priceText = await readText(page, selectors.currentPrice);
    const minNextText = await readText(page, selectors.minNextBid);
    const endTime = await readEndTime(page);

    return {
      currentPrice: parseMoney(priceText),
      minNextBid: parseMoney(minNextText),
      endTime,
      isWinning: winningCount > 0,
      isClosed: closedCount > 0,
    };
  }

  async placeBid(lot: Lot, amount: number): Promise<void> {
    const page = await this.getPage(lot);
    await page.fill(selectors.bidAmountInput, String(amount));
    await page.click(selectors.placeBidButton);
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
  }
}
