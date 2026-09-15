/**
 * CALIBRATION FILE — nothing in this file has been checked against the
 * real hibid.com. Every Claude session that's worked on this project has
 * been network-blocked from hibid.com, so these are educated guesses
 * based on how auction-lot pages are commonly structured, not verified
 * selectors. Run `npm run inspect -- <a real lot URL>` on a machine with
 * real internet access and use what it captures in `inspect-output/` to
 * correct these.
 */
export const selectors = {
  currentPrice: "[data-testid='current-bid'], .current-bid, .lot-current-price",
  minNextBid: "[data-testid='next-bid'], .next-bid, .lot-min-bid",
  countdown: "[data-testid='lot-countdown'], .lot-countdown, .countdown-timer",
  countdownEndTimeAttr: "data-end-time",
  youAreWinning: ".you-are-winning, .high-bidder-you, [data-testid='you-are-winning']",
  lotClosed: ".lot-closed, .auction-ended, [data-testid='lot-closed']",
  bidAmountInput: "input[name='bidAmount'], input#bidAmount, [data-testid='bid-input']",
  placeBidButton: "button[data-testid='place-bid'], button.place-bid, button#placeBidButton",
  confirmBidButton: "button[data-testid='confirm-bid'], button.confirm-bid",

  // Search / browse results page — used by browseParse.ts
  searchResultCard: "[data-testid='lot-card'], .lot-card, .auction-lot-tile",
  searchResultTitle: ".lot-title, .item-title",
  searchResultLink: "a",
  searchResultPrice: ".current-bid, .lot-current-price",
  searchResultThumb: "img",
};

export const loginSelectors = {
  loginUrl: "https://hibid.com/login",
  emailInput: "input[name='email'], input#email, input[type='email']",
  passwordInput: "input[name='password'], input#password, input[type='password']",
  submitButton: "button[type='submit']",
  loggedInIndicator: "[data-testid='account-menu'], .account-menu, .user-menu",
};

export function searchUrl(query: string): string {
  return `https://hibid.com/search?q=${encodeURIComponent(query)}`;
}
