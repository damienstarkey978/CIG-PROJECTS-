/**
 * Calibration tool. Run on YOUR machine (not in a sandbox without network
 * access) with:
 *
 *   npm run inspect -- https://hibid.com/some/real/lot/url
 *
 * It opens a real, visible browser window. Log in by hand if prompted —
 * that session is then saved to data/auth.json and reused by the bot from
 * then on, so you don't need to script the login at all.
 *
 * While the lot page is open it prints every XHR/fetch response HiBid's
 * Angular app makes, which is almost certainly where the live price and
 * countdown actually come from. It also dumps the rendered HTML to
 * data/inspect-dump.html so you can find the right CSS selectors for
 * src/bot/selectors.ts if you'd rather scrape the DOM than call an API
 * directly.
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import dotenv from "dotenv";
import { chromium } from "playwright";
import { hasSavedSession, saveSession } from "./browser";

dotenv.config();

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DUMP_FILE = path.join(DATA_DIR, "inspect-dump.html");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

async function main() {
  const lotUrl = process.argv[2];
  if (!lotUrl) {
    console.error("Usage: npm run inspect -- <lot-url>");
    process.exit(1);
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = hasSavedSession()
    ? await browser.newContext({ storageState: AUTH_FILE })
    : await browser.newContext();
  const page = await context.newPage();

  page.on("response", async (response) => {
    const url = response.url();
    const type = response.headers()["content-type"] || "";
    if (!type.includes("json")) return;
    try {
      const body = await response.text();
      console.log(`\n[XHR] ${response.status()} ${url}\n${body.slice(0, 1500)}`);
    } catch {
      // response body not readable (e.g. redirected/streamed) — ignore
    }
  });

  page.on("websocket", (ws) => {
    console.log(`[WS] opened: ${ws.url()}`);
    ws.on("framereceived", (f) => console.log(`[WS <=] ${String(f.payload).slice(0, 500)}`));
    ws.on("framesent", (f) => console.log(`[WS =>] ${String(f.payload).slice(0, 500)}`));
  });

  await page.goto(lotUrl, { waitUntil: "domcontentloaded" });

  if (!hasSavedSession()) {
    await prompt(
      "\nIf you see a login prompt, log in by hand in the opened browser window.\n" +
        "Once you're logged in and the lot page is loaded, press Enter here to continue...\n"
    );
    await saveSession(context);
    console.log(`Saved session to ${AUTH_FILE} — future runs won't need to log in again.`);
  }

  await page.waitForTimeout(3000);
  const html = await page.content();
  fs.writeFileSync(DUMP_FILE, html);
  console.log(`\nDumped rendered HTML to ${DUMP_FILE}.`);
  console.log("Leaving the browser open so you can watch network traffic — close it or Ctrl+C when done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
