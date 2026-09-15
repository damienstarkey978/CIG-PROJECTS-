import path from "path";
import fs from "fs";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { loginSelectors } from "./selectors";
import { config } from "./config";

const AUTH_FILE = path.join(__dirname, "..", "..", "data", "auth.json");

let browserSingleton: Browser | null = null;
let contextSingleton: BrowserContext | null = null;

export function hasSavedSession(): boolean {
  return fs.existsSync(AUTH_FILE);
}

async function getBrowser(headless = true): Promise<Browser> {
  if (!browserSingleton) {
    browserSingleton = await chromium.launch({ headless });
  }
  return browserSingleton;
}

export async function saveSession(context: BrowserContext): Promise<void> {
  const dir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await context.storageState({ path: AUTH_FILE });
}

/** Fills and submits HiBid's login form with the given credentials. */
export async function loginWithCredentials(page: Page, email: string, password: string): Promise<void> {
  await page.goto(loginSelectors.loginUrl, { waitUntil: "domcontentloaded" });
  await page.fill(loginSelectors.emailInput, email);
  await page.fill(loginSelectors.passwordInput, password);
  await page.click(loginSelectors.submitButton);
  await page.waitForLoadState("networkidle").catch(() => {});
}

/**
 * Returns a logged-in browser context, reusing a saved session
 * (data/auth.json) when one exists. Falls back to a scripted login using
 * HIBID_EMAIL/HIBID_PASSWORD if no session is saved yet — this depends on
 * loginSelectors matching the real HiBid login form, which is unverified
 * (see selectors.ts). Throws if neither a saved session nor credentials
 * are available; callers must catch this and degrade gracefully rather
 * than letting it crash the process.
 */
export async function getLoggedInContext(): Promise<BrowserContext> {
  if (contextSingleton) return contextSingleton;

  const browser = await getBrowser(true);

  if (hasSavedSession()) {
    contextSingleton = await browser.newContext({ storageState: AUTH_FILE });
    return contextSingleton;
  }

  if (!config.hibidEmail || !config.hibidPassword) {
    throw new Error(
      "No saved HiBid session and no HIBID_EMAIL/HIBID_PASSWORD configured. " +
        "Run `npm run inspect -- <lot-url>` on a machine with real internet access and log in by hand once."
    );
  }

  contextSingleton = await browser.newContext();
  const page = await contextSingleton.newPage();
  await loginWithCredentials(page, config.hibidEmail, config.hibidPassword);
  await page.close();
  await saveSession(contextSingleton);
  return contextSingleton;
}

export async function closeAll(): Promise<void> {
  if (contextSingleton) await contextSingleton.close().catch(() => {});
  if (browserSingleton) await browserSingleton.close().catch(() => {});
  contextSingleton = null;
  browserSingleton = null;
}
