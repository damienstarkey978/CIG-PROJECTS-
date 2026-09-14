# HiBid Sniper

Personal auto-bid bot for HiBid auctions, with a phone-app-style dashboard.
For each lot you set a max bid; the bot watches the lot and bids for you up
to that max, either continuously (proxy) or only in the final seconds
(snipe). Runs on a machine you control — not on Claude's servers, not in a
sandbox — because it needs real network access to hibid.com and it needs
to keep running through the auction's close.

## Important: HiBid uses "soft close"

If a bid lands in the last moments, HiBid extends that lot's clock so
other bidders get a chance to respond. A single last-second snipe usually
just triggers an extension rather than winning outright. This bot's
default ("proxy") mode is built for that: it holds your max bid and only
bids the minimum needed to stay in front, and keeps doing that through any
extensions until the lot actually closes. "Snipe" mode is there if you
specifically want to hold off revealing your interest until near the end —
it still keeps re-bidding through extensions after that point.

Automated bidding tools likely aren't something HiBid's terms of service
explicitly welcome. This runs on your own account, at your own risk — read
HiBid's terms before relying on it for anything you can't afford to have
go wrong (e.g. account restrictions).

## One-time setup

```bash
cd hibid-sniper
npm install            # also installs a Chromium build for Playwright
cp .env.example .env
```

Do **not** put your HiBid password anywhere except your local `.env` file.
It's git-ignored. Never paste it into a chat, ticket, or screenshot.

### Calibrate against the real site

This was built without network access to hibid.com, so `src/bot/selectors.ts`
has best-guess CSS selectors, not verified ones. Before trusting it with a
real bid:

```bash
npm run inspect -- https://hibid.com/some/real/lot/url
```

This opens a real, visible browser window.

- If you're not already logged in, log in by hand in that window, then
  press Enter in the terminal. Your session is saved to `data/auth.json`
  and reused automatically after that — you won't need to script the login
  or store your password at all if you'd rather not.
- It prints every API response the page makes while it loads. That's
  almost certainly where the live price and countdown actually come from —
  look for one with the lot's current bid and end time in it.
- It also dumps the rendered page to `data/inspect-dump.html`.

Then update `src/bot/selectors.ts`:

- If you found a clean API response, it's more reliable to have the bot
  poll that endpoint directly than to scrape the DOM. That requires adding
  a small HTTP client using the cookies from `data/auth.json` — ask for
  that once you have the endpoint shape, it's a quick addition.
- Otherwise, open `data/inspect-dump.html`, find the real elements for
  price / countdown / "you're winning" / bid input / bid button, and
  update the selector strings.

## Running it

```bash
npm run build && npm start
```

Open `http://localhost:4310` (or whatever `PORT` you set) — on your phone,
if it's on the same network, or through a tunnel (Tailscale, ngrok) if not.
Tap **+**, paste a lot URL, set your max bid and mode, and the bot starts
watching immediately. Add it to your phone's home screen for an app-like
icon (it's a installable PWA).

The dashboard shows live status per lot (watching / winning / outbid / won
/ lost), current price, your max, and a running log. Pause or remove a lot
any time.

## How proxy vs. snipe mode work

- **Proxy** (default): as soon as you're outbid, the bot immediately bids
  the next minimum increment, up to your max. This is the safer default —
  it can't miss a last-second extension because it isn't waiting for one.
- **Snipe**: the bot holds off bidding until `snipeSeconds` before the
  lot's scheduled close, then bids your max (or the next increment, up to
  your max) right away. If that triggers a soft-close extension, it
  immediately switches to proxy behavior for the rest of that lot — it
  doesn't wait another `snipeSeconds` each time.

Either way, the bot never bids past the max you set.

## Notes

- One shared logged-in browser session is reused across all watched lots.
- Lots and their state persist to `data/lots.json` so a restart resumes
  watching anything not already won/lost.
- If HiBid changes its page layout, bidding will start failing loudly (the
  dashboard log will show bid errors) rather than silently doing nothing —
  re-run `npm run inspect` against a current lot page to recalibrate.
