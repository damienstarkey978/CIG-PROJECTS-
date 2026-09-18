/**
 * HiBid GraphQL client — calibrated 2026-09-18 against live hibid.com via
 * Playwright (plain curl is Cloudflare-blocked from datacenter IPs).
 *
 * Endpoint: POST https://hibid.com/graphql (also on auctioneer subdomains).
 * After a browser context has loaded any hibid.com page once, Playwright's
 * APIRequestContext can call /graphql with the CF clearance cookies.
 *
 * Public lotState needs no auth. The `bid` mutation needs a logged-in session.
 * Always pass countAsView: false when polling so we don't inflate analytics.
 */
import { BrowserContext, APIResponse } from "playwright";

export interface LotState {
  highBid: number | null;
  minBid: number | null;
  bidCount: number | null;
  timeLeft: string | null;
  timeLeftSeconds: number | null;
  timeLeftWithLimboSeconds: number | null;
  timeLeftTitle: string | null;
  softCloseMinutes: number | null;
  softCloseSeconds: number | null;
  biddingExtended: boolean;
  linkedSoftClose: string | null;
  isClosed: boolean;
  status: string | null;
  buyerBidStatus: string | null;
  buyerHighBid: number | null;
  highBuyerId: string | null;
  showBidStatus: boolean;
}

export interface LotDetails {
  id: number;
  lead: string | null;
  lotNumber: string | null;
  rv: number | null;
  bidAmountType: string | null; // MAX_BIDDING | FLAT_BIDDING (from auction)
  auctionId: number | null;
  lotState: Partial<LotState> | null;
}

export interface BidResult {
  ok: boolean;
  typename: string | null;
  bidStatus: string | null;
  bidMessage: string | null;
  suggestedBid: number | null;
  messages: string[] | null;
  raw: unknown;
}

const LOT_STATE_QUERY = `
query GetLotStateQuery($lotId: ID!) {
  lotState(input: $lotId) {
    highBid
    minBid
    bidCount
    timeLeft
    timeLeftSeconds
    timeLeftWithLimboSeconds
    timeLeftTitle
    softCloseMinutes
    softCloseSeconds
    biddingExtended
    linkedSoftClose
    isClosed
    status
    buyerBidStatus
    buyerHighBid
    highBuyerId
    showBidStatus
  }
}`;

const LOT_DETAILS_QUERY = `
query GetLotDetails($lotId: ID!, $countAsView: Boolean) {
  lot(input: $lotId, countAsView: $countAsView) {
    lot {
      id
      lead
      lotNumber
      rv
      lotState { highBid minBid softCloseSeconds isClosed status buyerBidStatus }
      auction { id eventName bidAmountType }
    }
  }
}`;

const LOT_SEARCH_QUERY = `
query LotSearch($pageNumber: Int!, $pageLength: Int!, $input: LotSearchInput!) {
  lotSearch(pageNumber: $pageNumber, pageLength: $pageLength, input: $input) {
    pagedResults {
      totalCount
      results {
        id
        lead
        lotNumber
        lotState {
          highBid
          minBid
          timeLeftSeconds
          isClosed
          timeLeftTitle
        }
      }
    }
  }
}`;

const BID_MUTATION = `
mutation LotBid($lotId: Int!, $bidAmount: Decimal!, $reConfirmed: Boolean!) {
  bid(input: { lotId: $lotId, bidAmount: $bidAmount, reConfirmed: $reConfirmed }) {
    __typename
    ... on BidResultType {
      bidStatus
      suggestedBid
      bidMessage
    }
    ... on InvalidInputError {
      messages
    }
  }
}`;

const DEFAULT_ORIGIN = "https://hibid.com";

async function postGraphql(
  context: BrowserContext,
  origin: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: any }> {
  const res: APIResponse = await context.request.post(`${origin}/graphql`, {
    data: body,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: origin,
      Referer: `${origin}/`,
    },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HiBid GraphQL returned non-JSON (HTTP ${res.status()}): ${text.slice(0, 200)}`);
  }
  if (json?.errors?.length) {
    const msg = json.errors.map((e: any) => e.message).join("; ");
    // Some responses still include partial data — only throw when data is missing
    if (!json.data) throw new Error(`HiBid GraphQL error: ${msg}`);
  }
  return { status: res.status(), json };
}

/**
 * Parse HiBid's timeLeftTitle into an ISO timestamp.
 * Example: "Internet Bidding closes at: 10/1/2026 12:00:30 PM EST"
 */
export function parseTimeLeftTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const match = title.match(/closes at:\s*(.+)$/i);
  if (!match) return null;
  const raw = match[1].trim();
  // Drop trailing timezone abbreviation HiBid appends (EST/EDT/CST/…) —
  // Date.parse doesn't reliably handle those; treat wall time as local-ish UTC offset unknown.
  const withoutTz = raw.replace(/\s+[A-Z]{2,5}$/, "");
  const d = new Date(withoutTz);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function endTimeFromLotState(state: Partial<LotState>): string | null {
  const fromTitle = parseTimeLeftTitle(state.timeLeftTitle ?? null);
  if (fromTitle) return fromTitle;
  const secs = state.timeLeftWithLimboSeconds ?? state.timeLeftSeconds;
  if (secs != null && Number.isFinite(secs) && secs >= 0) {
    return new Date(Date.now() + secs * 1000).toISOString();
  }
  return null;
}

export async function fetchLotState(
  context: BrowserContext,
  lotId: string,
  origin = DEFAULT_ORIGIN
): Promise<LotState> {
  const { json } = await postGraphql(context, origin, {
    operationName: "GetLotStateQuery",
    query: LOT_STATE_QUERY,
    variables: { lotId },
  });
  const state = json?.data?.lotState;
  if (!state) throw new Error(`No lotState for lot ${lotId}`);
  return state as LotState;
}

export async function fetchLotDetails(
  context: BrowserContext,
  lotId: string,
  origin = DEFAULT_ORIGIN
): Promise<LotDetails> {
  const { json } = await postGraphql(context, origin, {
    operationName: "GetLotDetails",
    query: LOT_DETAILS_QUERY,
    variables: { lotId, countAsView: false },
  });
  const lot = json?.data?.lot?.lot;
  if (!lot) throw new Error(`No lot details for ${lotId}`);
  return {
    id: lot.id,
    lead: lot.lead ?? null,
    lotNumber: lot.lotNumber ?? null,
    rv: lot.rv ?? null,
    bidAmountType: lot.auction?.bidAmountType ?? null,
    auctionId: lot.auction?.id ?? null,
    lotState: lot.lotState ?? null,
  };
}

export interface GraphqlSearchHit {
  id: number;
  lead: string | null;
  lotNumber: string | null;
  highBid: number | null;
  minBid: number | null;
  timeLeftSeconds: number | null;
  isClosed: boolean;
  timeLeftTitle: string | null;
}

export async function searchLots(
  context: BrowserContext,
  query: string,
  origin = DEFAULT_ORIGIN,
  pageLength = 20
): Promise<GraphqlSearchHit[]> {
  const { json } = await postGraphql(context, origin, {
    operationName: "LotSearch",
    query: LOT_SEARCH_QUERY,
    variables: {
      pageNumber: 1,
      pageLength,
      input: { searchText: query, status: "OPEN", countAsView: false },
    },
  });
  const results = json?.data?.lotSearch?.pagedResults?.results ?? [];
  return results.map((r: any) => ({
    id: r.id,
    lead: r.lead ?? null,
    lotNumber: r.lotNumber ?? null,
    highBid: r.lotState?.highBid ?? null,
    minBid: r.lotState?.minBid ?? null,
    timeLeftSeconds: r.lotState?.timeLeftSeconds ?? null,
    isClosed: !!r.lotState?.isClosed,
    timeLeftTitle: r.lotState?.timeLeftTitle ?? null,
  }));
}

/**
 * Place a bid. On MAX_BIDDING auctions, bidAmount is the proxy ceiling.
 * Requires a logged-in browser context (cookies). Never log credentials.
 */
export async function placeBidMutation(
  context: BrowserContext,
  lotId: number,
  bidAmount: number,
  origin = DEFAULT_ORIGIN,
  reConfirmed = true
): Promise<BidResult> {
  const { json } = await postGraphql(context, origin, {
    operationName: "LotBid",
    query: BID_MUTATION,
    variables: { lotId, bidAmount, reConfirmed },
  });
  const result = json?.data?.bid;
  if (!result) {
    const errMsg = json?.errors?.map((e: any) => e.message).join("; ") || "empty bid response";
    return { ok: false, typename: null, bidStatus: null, bidMessage: errMsg, suggestedBid: null, messages: null, raw: json };
  }
  const typename = result.__typename ?? null;
  if (typename === "BidResultType") {
    return {
      ok: true,
      typename,
      bidStatus: result.bidStatus ?? null,
      bidMessage: result.bidMessage ?? null,
      suggestedBid: result.suggestedBid ?? null,
      messages: null,
      raw: result,
    };
  }
  return {
    ok: false,
    typename,
    bidStatus: null,
    bidMessage: null,
    suggestedBid: null,
    messages: result.messages ?? null,
    raw: result,
  };
}

/** Map GraphQL buyerBidStatus → engine isWinning / terminal closed. */
export function interpretBuyerStatus(
  buyerBidStatus: string | null | undefined,
  lotStatus: string | null | undefined,
  isClosedFlag: boolean
): { isWinning: boolean; isClosed: boolean } {
  const buyer = (buyerBidStatus || "").toUpperCase().replace(/-/g, "_");
  const status = (lotStatus || "").toUpperCase();
  const closed =
    isClosedFlag ||
    status === "CLOSED" ||
    buyer === "WON" ||
    buyer === "MAY_HAVE_WON" ||
    buyer === "MAY_HAVE_WON_STATUS" ||
    buyer === "PASSED" ||
    buyer === "DECLINED" ||
    buyer === "NOT_ACCEPTED";

  const winning =
    buyer === "WINNING" ||
    buyer === "WON" ||
    buyer === "MAY_HAVE_WON" ||
    buyer === "MAY_HAVE_WON_STATUS";

  return { isWinning: winning, isClosed: closed };
}
