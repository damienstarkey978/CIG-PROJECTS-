/**
 * CSS selectors calibrated against live hibid.com on 2026-09-18
 * (Playwright Chromium from this environment; verified on
 * https://hibid.com/florida/lot/320694969).
 *
 * Prefer GraphQL lotState (see graphql.ts) for price/timer/status — the
 * DOM is a fallback when GraphQL fails. HiBid is Angular 16 SSR; there is
 * no data-testid on these controls and no transfer-state JSON in the HTML.
 */
export const selectors = {
  // Lot page — observed
  lotTitle: "h1 .text-transform-none, h1",
  currentPrice: "span.lot-high-bid",
  minNextBid: "span.TileDisplayMinBid",
  countdown: "div.lot-time-left-container span.lot-time-left",
  // Absolute close time lives on the INNER span's title= attribute, not data-end-time
  countdownEndTimeAttr: "title",
  countdownInner: "div.lot-time-left-container span.lot-time-left > span[title]",
  softClose: "span.lot-linked-soft-close, .lot-linked-soft-close-container",

  // data-status is BuyerBidStatus lowercased with underscores removed (nobid, winning, outbid, …)
  bidStatus: "[data-status]",
  youAreWinning: '[data-status="winning"], .bid-status-winning',
  youAreOutbid: '[data-status="outbid"], .bid-status-outbid',
  lotClosed: "span.lot-time-left:has-text('Bidding Closed'), [data-status='won'], [data-status='passed']",

  // Public lot page has NO free-form bid amount <input> — the Bid button shows min next bid.
  // Custom / max amount is entered in a confirm panel after clicking Bid (logged-in).
  bidAmountInput:
    "input[name='bidAmount'], input#bidAmount, input[formcontrolname='bidAmount'], input[placeholder*='Max' i], input[placeholder*='Bid' i]",
  placeBidButton: "app-lot-buttons button.app-button, .lot-bid-text-container",
  confirmBidButton:
    "button:has-text('Confirm'), button:has-text('Place Bid'), button[data-testid='confirm-bid'], button.confirm-bid",

  // Search / browse results — observed on /lots SSR
  searchResultCard: "app-lot-tile.lot-tile, app-top-pick, .lot-tile",
  searchResultTitle: ".lot-number-lead, .lot-info, .lot-title",
  searchResultLink: "a.lot-preview-link, a.lot-link, a.top-pick-focused, a",
  searchResultPrice: "span.lot-high-bid, .TileDisplayMinBid, .lot-bid-text, strong",
  searchResultThumb: ".lot-thumbnail img, img.lot-thumbnail, img",
};

/**
 * Login is a two-step modal opened from "Sign In" on any page — there is no
 * reliable /login route (Cloudflare 403 on /login from many networks; app
 * 404 on /account/login). Step 1: email/username + Continue. Step 2: password
 * + Log In. Cloudflare Turnstile may appear — scripted login can fail; prefer
 * a captured session (HIBID_AUTH_STATE_B64 / data/auth.json).
 */
export const loginSelectors = {
  homeUrl: "https://hibid.com/",
  openSignIn: 'a:has-text("Sign In"), button:has-text("Sign In")',
  emailInput: "#username-input, input[name='username'], input[placeholder*='Email' i]",
  continueButton: 'button:has-text("Continue")',
  passwordInput: 'input[type="password"], input[name="password"], input[placeholder="Password" i]',
  submitButton: 'button:has-text("Log In"), button[type="submit"]',
  // After login the header usually swaps Sign In for an account / Sign Out control
  loggedInIndicator: 'a:has-text("Sign Out"), button:has-text("Sign Out"), [data-testid="account-menu"]',
  cookieAgree: 'button:has-text("Agree and Close")',
};

/** Browse/search URL — observed: /lots?query=…&status=OPEN (not /search?q=). */
export function searchUrl(query: string): string {
  return `https://hibid.com/lots?query=${encodeURIComponent(query)}&status=OPEN`;
}
