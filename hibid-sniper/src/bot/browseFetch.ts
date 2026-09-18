import { ensureWarmOrigin } from "./login";
import { endTimeFromLotState, searchLots } from "./graphql";
import { lotUrlFromId } from "./lotId";
import { SearchResult } from "./types";

/**
 * Search open lots via HiBid GraphQL lotSearch (calibrated 2026-09-18).
 * Falls back is unnecessary here — if GraphQL is down, surface the error
 * to the API caller; browsing is optional relative to paste-a-URL watching.
 */
export async function searchHiBid(query: string): Promise<SearchResult[]> {
  const context = await ensureWarmOrigin();
  const hits = await searchLots(context, query);
  return hits.map((h) => ({
    title: h.lotNumber ? `Lot ${h.lotNumber} — ${h.lead ?? ""}`.trim() : h.lead ?? `Lot ${h.id}`,
    url: lotUrlFromId(h.id),
    currentPrice: h.highBid,
    endTime: endTimeFromLotState({
      timeLeftTitle: h.timeLeftTitle,
      timeLeftSeconds: h.timeLeftSeconds,
    }),
    thumbnailUrl: null,
  }));
}
