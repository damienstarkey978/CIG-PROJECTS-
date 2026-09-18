/**
 * Calibration tool. Run on a machine that can reach hibid.com (Playwright
 * Chromium works from this cloud environment; plain curl does not — Cloudflare).
 *
 *   npm run inspect -- https://hibid.com/florida/lot/320694969
 *   npm run inspect -- --search "coin"
 *
 * Opens a visible browser when DISPLAY is available; otherwise headless.
 * Log in by hand if prompted, then press Enter — session saved to data/auth.json.
 * Also dumps GraphQL lotState + rendered HTML to inspect-output/.
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import dotenv from "dotenv";
import { chromium } from "playwright";
import { hasSavedSession, saveSession, restoreAuthStateFromEnv } from "./login";
import { searchUrl } from "./selectors";
import { extractLotId } from "./lotId";

dotenv.config();
restoreAuthStateFromEnv();

const OUT_DIR = path.join(__dirname, "..", "..", "inspect-output");
const AUTH_FILE = path.join(__dirname, "..", "..", "data", "auth.json");

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    })
  );
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

  const headless = !process.env.DISPLAY && process.env.INSPECT_HEADED !== "true";
  const browser = await chromium.launch({
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = hasSavedSession()
    ? await browser.newContext({
        storageState: AUTH_FILE,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      })
    : await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      });
  const page = await context.newPage();

  page.on("response", async (response) => {
    if (!response.url().includes("graphql")) return;
    try {
      const body = await response.text();
      console.log(`\n[GraphQL] ${response.status()} ${response.url()}\n${body.slice(0, 1500)}`);
    } catch {
      // ignore
    }
  });

  const url = isSearch ? searchUrl(target) : target;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

  if (!hasSavedSession() && !headless) {
    await prompt(
      "\nIf you see a login prompt, log in by hand in the opened browser window.\n" +
        "Once you're logged in and the page has loaded, press Enter here to continue...\n"
    );
    await saveSession(context);
    console.log(`Saved session to ${AUTH_FILE}`);
  } else if (!hasSavedSession() && headless) {
    console.log(
      "Headless run with no saved session — skipping interactive login. " +
        "Set INSPECT_HEADED=true with a display, or provide HIBID_AUTH_STATE_B64 / data/auth.json."
    );
  }

  await page.waitForTimeout(3000);
  const outFile = path.join(OUT_DIR, isSearch ? "search-dump.html" : "lot-dump.html");
  fs.writeFileSync(outFile, await page.content());
  console.log(`\nDumped rendered HTML to ${outFile}.`);

  if (!isSearch) {
    const lotId = extractLotId(url);
    if (lotId) {
      const state = await page.evaluate(async (id) => {
        const r = await fetch("/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operationName: "GetLotStateQuery",
            query: `query GetLotStateQuery($lotId: ID!) {
              lotState(input: $lotId) {
                highBid minBid bidCount timeLeftSeconds timeLeftTitle
                softCloseSeconds biddingExtended isClosed status buyerBidStatus buyerHighBid
              }
            }`,
            variables: { lotId: id },
          }),
        });
        return (await r.json()) as { data?: { lotState?: unknown } };
      }, lotId);
      const stateFile = path.join(OUT_DIR, "lot-state.json");
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      console.log(`Dumped lotState GraphQL to ${stateFile}`);
      console.log(JSON.stringify(state?.data?.lotState ?? state, null, 2));
    }
  }

  if (headless) {
    await browser.close();
  } else {
    console.log("Leaving the browser open — close it or Ctrl+C when done.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
