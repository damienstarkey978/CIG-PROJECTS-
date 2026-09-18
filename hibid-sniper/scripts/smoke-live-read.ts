/**
 * LiveSource.read against a real lot — no bid placed.
 * Run: npx ts-node scripts/smoke-live-read.ts
 */
import { LiveSource } from "../src/bot/scraper";
import { closeAll } from "../src/bot/login";
import { Lot } from "../src/bot/types";

async function main() {
  const source = new LiveSource();
  await source.init();
  const lot: Lot = {
    id: "smoke",
    url: "https://hibid.com/florida/lot/320694969",
    label: "smoke",
    maxBid: 1,
    mode: "proxy",
    snipeSeconds: 8,
    status: "watching",
    currentPrice: null,
    minNextBid: null,
    endTime: null,
    lastChecked: null,
    paused: false,
    log: [],
  };
  const reading = await source.read(lot);
  console.log("LiveSource.read", reading);
  console.log("label after meta", lot.label);
  if (reading.currentPrice == null) throw new Error("no price");
  if (reading.minNextBid == null) throw new Error("no min bid");
  if (!reading.endTime) throw new Error("no end time");
  console.log("PASS: LiveSource read real lot via GraphQL");
  await source.dispose(lot);
  await closeAll();
}

main().catch(async (e) => {
  console.error("FAIL", e);
  await closeAll().catch(() => {});
  process.exit(1);
});
