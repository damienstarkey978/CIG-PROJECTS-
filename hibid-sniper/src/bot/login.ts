import path from "path";
import fs from "fs";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { loginSelectors } from "./selectors";
import { config } from "./config";

const AUTH_FILE = path.join(__dirname, "..", "..", "data", "auth.json");

let browserSingleton: Browser | null = null;
let contextSingleton: BrowserContext | null = null;
/** Shared page kept on hibid.com so GraphQL requests carry CF cookies. */
let warmPage: Page | null = null;

export function hasSavedSession(): boolean {
  return fs.existsSync(AUTH_FILE);
}

/**
 * If Fly (or local .env) provided HIBID_AUTH_STATE_B64, decode it into
 * data/auth.json before any browser launch. Safe to call multiple times.
 * Never logs the contents.
 */
export function restoreAuthStateFromEnv(): void {
  const b64 = process.env.HIBID_AUTH_STATE_B64;
  if (!b64 || !b64.trim()) return;
  if (hasSavedSession()) return; // prefer an already-present file (e.g. volume)
  try {
    const json = Buffer.from(b64.trim(), "base64").toString("utf8");
    JSON.parse(json); // validate before writing
    const dir = path.dirname(AUTH_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AUTH_FILE, json, { mode: 0o600 });
    console.log("Restored HiBid session from HIBID_AUTH_STATE_B64 into data/auth.json");
  } catch (err: any) {
    console.error("HIBID_AUTH_STATE_B64 was set but could not be decoded:", err?.message ?? err);
  }
}

async function getBrowser(headless = true): Promise<Browser> {
  if (!browserSingleton) {
    browserSingleton = await chromium.launch({
      headless,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }
  return browserSingleton;
}

export async function saveSession(context: BrowserContext): Promise<void> {
  const dir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await context.storageState({ path: AUTH_FILE });
}

async function dismissCookieBanner(page: Page): Promise<void> {
  try {
    const btn = page.locator(loginSelectors.cookieAgree).first();
    if ((await btn.count()) > 0) await btn.click({ timeout: 2000 }).catch(() => {});
  } catch {
    // banner absent — fine
  }
}

/**
 * Two-step HiBid login (email → Continue → password → Log In).
 * May fail if Cloudflare Turnstile challenges the session — callers should
 * prefer a captured auth.json in that case.
 */
export async function loginWithCredentials(page: Page, email: string, password: string): Promise<void> {
  await page.goto(loginSelectors.homeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dismissCookieBanner(page);

  const signIn = page.locator(loginSelectors.openSignIn).first();
  await signIn.click({ timeout: 15_000 });
  await page.waitForSelector(loginSelectors.emailInput, { timeout: 15_000 });
  await page.fill(loginSelectors.emailInput, email);
  await page.locator(loginSelectors.continueButton).first().click();
  await page.waitForSelector(loginSelectors.passwordInput, { timeout: 20_000 });
  await page.fill(loginSelectors.passwordInput, password);
  await page.locator(loginSelectors.submitButton).first().click();
  await page.waitForLoadState("networkidle").catch(() => {});
  // Give the SPA a moment to flip the header / set cookies
  await page.waitForTimeout(2000);
}

/**
 * Returns a browser context, reusing data/auth.json when present.
 * Falls back to scripted login via HIBID_EMAIL/HIBID_PASSWORD.
 * Throws if neither is available — callers must catch and degrade.
 */
export async function getLoggedInContext(): Promise<BrowserContext> {
  if (contextSingleton) return contextSingleton;

  restoreAuthStateFromEnv();
  const browser = await getBrowser(true);

  if (hasSavedSession()) {
    contextSingleton = await browser.newContext({
      storageState: AUTH_FILE,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
  } else if (config.hibidEmail && config.hibidPassword) {
    contextSingleton = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
    const page = await contextSingleton.newPage();
    await loginWithCredentials(page, config.hibidEmail, config.hibidPassword);
    await page.close();
    await saveSession(contextSingleton);
  } else {
    // Still useful for anonymous GraphQL reads (lotState / search) — bidding will fail later.
    contextSingleton = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
    console.warn(
      "No HiBid session or HIBID_EMAIL/HIBID_PASSWORD — starting anonymous context. " +
        "Watching/price reads may work; placing bids will fail until you save a session."
    );
  }

  return contextSingleton;
}

/**
 * Ensure the context has loaded hibid.com at least once so Cloudflare
 * clearance cookies exist for subsequent GraphQL APIRequestContext calls.
 */
export async function ensureWarmOrigin(origin = "https://hibid.com"): Promise<BrowserContext> {
  const context = await getLoggedInContext();
  if (warmPage && !warmPage.isClosed()) return context;
  warmPage = await context.newPage();
  await warmPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await warmPage.waitForTimeout(1500);
  return context;
}

export async function closeAll(): Promise<void> {
  if (warmPage) await warmPage.close().catch(() => {});
  if (contextSingleton) await contextSingleton.close().catch(() => {});
  if (browserSingleton) await browserSingleton.close().catch(() => {});
  warmPage = null;
  contextSingleton = null;
  browserSingleton = null;
}
