/**
 * One-shot probe: can Playwright Chromium reach a real HiBid lot page
 * from this environment, and what does the GraphQL lotState look like?
 */
import { chromium } from "playwright";
import fs from "fs";

const LOT_URL = "https://hibid.com/florida/lot/320694969";
const LOT_ID = "320694969";
const OUT = new URL("../inspect-output", import.meta.url).pathname;

const LOT_STATE_QUERY = `
query GetLotStateQuery($lotId: ID!) {
  lotState(input: $lotId) {
    highBid minBid bidCount timeLeft timeLeftSeconds
    timeLeftWithLimboSeconds timeLeftTitle softCloseMinutes softCloseSeconds
    biddingExtended linkedSoftClose isClosed status buyerBidStatus
    buyerHighBid highBuyerId showBidStatus
  }
}`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  const xhrJson = [];
  page.on("response", async (response) => {
    const type = response.headers()["content-type"] || "";
    if (!type.includes("json") && !response.url().includes("graphql")) return;
    try {
      const body = await response.text();
      xhrJson.push({ url: response.url(), status: response.status(), body: body.slice(0, 4000) });
    } catch {}
  });

  console.log("Navigating to", LOT_URL);
  const resp = await page.goto(LOT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  console.log("page status", resp?.status(), "final url", page.url());
  await page.waitForTimeout(5000);

  const title = await page.title();
  console.log("title:", title);

  const html = await page.content();
  fs.writeFileSync(`${OUT}/probe-lot.html`, html);
  console.log("html length", html.length);
  console.log("has lot-high-bid?", html.includes("lot-high-bid"));
  console.log("has cloudflare?", /cloudflare|Attention Required|cf-error/i.test(html));
  console.log("has Soft Close?", html.includes("Soft Close") || html.includes("lot-linked-soft-close"));

  // Try in-page GraphQL via page.evaluate fetch (same origin cookies)
  const gql = await page.evaluate(
    async ({ query, lotId }) => {
      try {
        const r = await fetch("/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            operationName: "GetLotStateQuery",
            query,
            variables: { lotId },
          }),
        });
        return { status: r.status, text: (await r.text()).slice(0, 4000) };
      } catch (e) {
        return { error: String(e) };
      }
    },
    { query: LOT_STATE_QUERY, lotId: LOT_ID }
  );
  console.log("in-page GraphQL:", JSON.stringify(gql).slice(0, 2000));
  fs.writeFileSync(`${OUT}/probe-gql.json`, JSON.stringify(gql, null, 2));
  fs.writeFileSync(`${OUT}/probe-xhr.json`, JSON.stringify(xhrJson, null, 2));

  // Extract key DOM bits if present
  const dom = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      return el ? { text: el.textContent?.trim(), html: el.outerHTML.slice(0, 500) } : null;
    };
    return {
      highBid: pick("span.lot-high-bid"),
      minBid: pick("span.TileDisplayMinBid"),
      timeLeft: pick("span.lot-time-left"),
      bidStatus: pick("[data-status]"),
      softClose: pick(".lot-linked-soft-close, .lot-linked-soft-close-container"),
      signIn: !!document.body.innerText.match(/Sign In/i),
    };
  });
  console.log("DOM extract:", JSON.stringify(dom, null, 2));
  fs.writeFileSync(`${OUT}/probe-dom.json`, JSON.stringify(dom, null, 2));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
