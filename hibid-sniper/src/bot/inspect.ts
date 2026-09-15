/**
 * Calibration tool. Run on a machine with real internet access to
 * hibid.com (not any Claude sandbox — all of them are network-blocked
 * from that domain):
 *
 *   npm run inspect -- https://hibid.com/some/real/lot/url
 *   npm run inspect -- --search "some query"
 *
 * Opens a real, visible browser. Log in by hand if prompted, then press
 * Enter in the terminal — that session is saved to data/auth.json and
 * reused automatically after that (also picked up by the deployed app if
 * you base64 it into HIBID_AUTH_STATE_B64, see README).
 *
 * While the page is open it prints every XHR/fetch JSON response HiBid's
 * Angular app makes (often the real source of price/countdown data, more
 * reliable to poll directly than scraping the DOM) and dumps the
 * rendered HTML to inspect-output/ so you can find real CSS selectors
 * for src/bot/selectors.ts.
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import dotenv from "dotenv";
import { chromium } from "playwright";
import { hasSavedSession, saveSession } from "./login";

dotenv.config();

const OUT_DIR = path.join(__dirname, "..", "..", "inspect-output");
const AUTH_FILE = path.join(__dirname, "..", "..", "data", "auth.json");

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  const args = process.argv.slice(2);
  const searchIdx = args.indexOf("--search");
  const isSearch = searchIdx !== -1;
  const target = isSearch ? args[searchIdx + 1] : args[0];

  if (!target) {
    console.error('Usage: npm run inspect -- <lot-url>\n   or: npm run inspect -- --search "query"');
    process.exit(1);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = hasSavedSession()
    ? await browser.newContext({ storageState: AUTH_FILE })
    : await browser.newContext();
  const page = await context.newPage();

  page.on("response", async (response) => {
    const type = response.headers()["content-type"] || "";
    if (!type.includes("json")) return;
    try {
      const body = await response.text();
      console.log(`\n[XHR] ${response.status()} ${response.url()}\n${body.slice(0, 1500)}`);
    } catch {
      // unreadable body (redirected/streamed) — ignore
    }
  });

  const url = isSearch ? `https://hibid.com/search?q=${encodeURIComponent(target)}` : target;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  if (!hasSavedSession()) {
    await prompt(
      "\nIf you see a login prompt, log in by hand in the opened browser window.\n" +
        "Once you're logged in and the page has loaded, press Enter here to continue...\n"
    );
    await saveSession(context);
    console.log(`Saved session to ${AUTH_FILE} — future runs and deploys can reuse it.`);
  }

  await page.waitForTimeout(3000);
  const outFile = path.join(OUT_DIR, isSearch ? "search-dump.html" : "lot-dump.html");
  fs.writeFileSync(outFile, await page.content());
  console.log(`\nDumped rendered HTML to ${outFile}.`);
  console.log("Leaving the browser open so you can watch network traffic — close it or Ctrl+C when done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
