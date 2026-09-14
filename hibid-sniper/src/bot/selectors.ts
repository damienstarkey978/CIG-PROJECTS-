/**
 * CALIBRATION FILE — read this before running the bot for real.
 *
 * This sandbox has no network access to hibid.com, so these selectors are
 * best-guess placeholders based on how HiBid's lot pages are commonly
 * structured, not verified against the live DOM. Before trusting the bot
 * with real money:
 *
 *   1. Run `npm run inspect -- <a real lot URL>` on YOUR machine.
 *   2. It opens a real (headed) browser, logs the JSON/XHR traffic the page
 *      makes, and dumps the live HTML for the price/timer/bid area to
 *      data/inspect-dump.html.
 *   3. Open that dump, find the real selectors, and update the values below.
 *
 * Every selector here is a CSS selector string. If HiBid renders the price
 * or timer via an API call instead of static DOM (likely, since it's an
 * Angular app), prefer wiring up `src/bot/apiClient.ts` using the endpoint
 * you captured in step 2 — that's far more reliable than DOM scraping.
 */
export const selectors = {
  // Text containing the current high bid, e.g. "$45.00"
  currentPrice: "[data-testid='current-bid'], .current-bid, .lot-current-price",

  // Text containing the minimum amount required for the next bid
  minNextBid: "[data-testid='next-bid'], .next-bid, .lot-min-bid",

  // Countdown / close time element. We try to read a data attribute with an
  // ISO/epoch end time first (common pattern), falling back to parsing text.
  countdown: "[data-testid='lot-countdown'], .lot-countdown, .countdown-timer",
  countdownEndTimeAttr: "data-end-time",

  // Indicator shown when the logged-in user currently holds the high bid
  youAreWinning: ".you-are-winning, .high-bidder-you, [data-testid='you-are-winning']",

  // Indicator shown when the lot has closed
  lotClosed: ".lot-closed, .auction-ended, [data-testid='lot-closed']",

  // Bidding controls
  bidAmountInput: "input[name='bidAmount'], input#bidAmount, [data-testid='bid-input']",
  placeBidButton: "button[data-testid='place-bid'], button.place-bid, button#placeBidButton",
  confirmBidButton: "button[data-testid='confirm-bid'], button.confirm-bid",

  // Login form (only used if HIBID_EMAIL/HIBID_PASSWORD auto-login is attempted;
  // manual login via `npm run inspect` avoids needing these at all)
  loginUrl: "https://hibid.com/login",
  loginEmailInput: "input[name='email'], input#email, input[type='email']",
  loginPasswordInput: "input[name='password'], input#password, input[type='password']",
  loginSubmitButton: "button[type='submit']",
};
