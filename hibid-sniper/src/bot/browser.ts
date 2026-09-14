import path from "path";
import fs from "fs";
import { chromium, Browser, BrowserContext } from "playwright";
import { selectors } from "./selectors";

const AUTH_FILE = path.join(__dirname, "..", "..", "data", "auth.json");

let browserSingleton: Browser | null = null;
let contextSingleton: BrowserContext | null = null;

export function hasSavedSession(): boolean {
  return fs.existsSync(AUTH_FILE);
}

export async function getBrowser(headless = true): Promise<Browser> {
  if (!browserSingleton) {
    browserSingleton = await chromium.launch({ headless });
  }
  return browserSingleton;
}

/**
 * Returns a logged-in browser context. Reuses the saved session (cookies +
 * local storage) from `npm run inspect` if present. If no saved session
 * exists and HIBID_EMAIL/HIBID_PASSWORD are set, attempts a scripted login
 * — but this depends on selectors.ts matching HiBid's real login form,
 * which hasn't been verified against the live site (see selectors.ts).
 * The reliable path is: run `npm run inspect` once and log in by hand.
 */
export async function getLoggedInContext(headless = true): Promise<BrowserContext> {
  if (contextSingleton) return contextSingleton;

  const browser = await getBrowser(headless);

  if (hasSavedSession()) {
    contextSingleton = await browser.newContext({ storageState: AUTH_FILE });
    return contextSingleton;
  }

  const email = process.env.HIBID_EMAIL;
  const password = process.env.HIBID_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "No saved session (data/auth.json) and no HIBID_EMAIL/HIBID_PASSWORD in .env. " +
        "Run `npm run inspect -- <lot-url>` and log in manually once."
    );
  }

  contextSingleton = await browser.newContext();
  const page = await contextSingleton.newPage();
  await page.goto(selectors.loginUrl, { waitUntil: "domcontentloaded" });
  await page.fill(selectors.loginEmailInput, email);
  await page.fill(selectors.loginPasswordInput, password);
  await page.click(selectors.loginSubmitButton);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.close();

  await saveSession(contextSingleton);
  return contextSingleton;
}

export async function saveSession(context: BrowserContext): Promise<void> {
  const dir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await context.storageState({ path: AUTH_FILE });
}

export async function closeAll(): Promise<void> {
  if (contextSingleton) await contextSingleton.close();
  if (browserSingleton) await browserSingleton.close();
  contextSingleton = null;
  browserSingleton = null;
}
