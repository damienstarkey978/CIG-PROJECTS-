import { getLoggedInContext } from "./login";
import { searchUrl } from "./selectors";

/**
 * Loads a HiBid search-results page through the shared logged-in
 * context and returns its rendered HTML. HiBid's Angular app won't
 * return useful content to a plain fetch(), so this goes through a real
 * page like scraper.ts does. The URL pattern here is a guess (see
 * selectors.ts) — unverified against the real site.
 */
export async function fetchSearchResultsHtml(query: string): Promise<string> {
  const context = await getLoggedInContext();
  const page = await context.newPage();
  try {
    await page.goto(searchUrl(query), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000); // let the SPA finish rendering results
    return await page.content();
  } finally {
    await page.close().catch(() => {});
  }
}
