import { chromium } from "playwright";
import { selectors } from "./selectors";
import { SearchResult } from "./types";

const PRICE_RE = /[\d,]+(\.\d+)?/;

function parseMoney(text: string | null): number | null {
  if (!text) return null;
  const match = text.replace(/,/g, "").match(PRICE_RE);
  return match ? parseFloat(match[0]) : null;
}

/**
 * DOM fallback parser for search-results HTML. Primary path is GraphQL
 * (browseFetch.searchHiBid). Kept for inspect tooling / offline dumps.
 */
export async function parseSearchResults(html: string, baseUrl = "https://hibid.com"): Promise<SearchResult[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html);

    const cards = page.locator(selectors.searchResultCard);
    const count = await cards.count();
    const results: SearchResult[] = [];

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const titleEl = card.locator(selectors.searchResultTitle).first();
      const linkEl = card.locator(selectors.searchResultLink).first();
      const priceEl = card.locator(selectors.searchResultPrice).first();
      const thumbEl = card.locator(selectors.searchResultThumb).first();

      const title = (await titleEl.textContent().catch(() => null))?.trim() || "Untitled lot";
      const href = await linkEl.getAttribute("href").catch(() => null);
      const priceText = await priceEl.textContent().catch(() => null);
      const thumbSrc = await thumbEl.getAttribute("src").catch(() => null);

      if (!href) continue;

      results.push({
        title,
        url: new URL(href, baseUrl).toString(),
        currentPrice: parseMoney(priceText),
        endTime: null,
        thumbnailUrl: thumbSrc ? new URL(thumbSrc, baseUrl).toString() : null,
      });
    }

    return results;
  } finally {
    await browser.close().catch(() => {});
  }
}
