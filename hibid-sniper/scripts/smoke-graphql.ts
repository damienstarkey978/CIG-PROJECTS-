/**
 * Live GraphQL smoke test against a real open lot. Requires Playwright
 * Chromium (curl alone is Cloudflare-blocked).
 *
 * Run: npx ts-node scripts/smoke-graphql.ts
 */
import { ensureWarmOrigin, closeAll } from "../src/bot/login";
import { fetchLotState, fetchLotDetails, searchLots, endTimeFromLotState } from "../src/bot/graphql";
import { extractLotId } from "../src/bot/lotId";

const SAMPLE = "https://hibid.com/florida/lot/320694969";

async function main() {
  const lotId = extractLotId(SAMPLE);
  if (!lotId) throw new Error("bad sample url");

  const ctx = await ensureWarmOrigin();
  const state = await fetchLotState(ctx, lotId);
  const details = await fetchLotDetails(ctx, lotId);
  const hits = await searchLots(ctx, "coin", "https://hibid.com", 3);

  console.log("lotState", {
    highBid: state.highBid,
    minBid: state.minBid,
    softCloseSeconds: state.softCloseSeconds,
    status: state.status,
    buyerBidStatus: state.buyerBidStatus,
    endTime: endTimeFromLotState(state),
  });
  console.log("details", {
    lead: details.lead,
    bidAmountType: details.bidAmountType,
    auctionId: details.auctionId,
  });
  console.log(
    "search hits",
    hits.map((h) => ({ id: h.id, lead: h.lead, highBid: h.highBid }))
  );

  if (state.highBid == null || state.minBid == null) throw new Error("missing bids");
  if (!details.bidAmountType) throw new Error("missing bidAmountType");
  if (hits.length < 1) throw new Error("search returned nothing");

  console.log("\nPASS: live GraphQL smoke ok");
  await closeAll();
}

main().catch(async (err) => {
  console.error("FAIL", err);
  await closeAll().catch(() => {});
  process.exit(1);
});
