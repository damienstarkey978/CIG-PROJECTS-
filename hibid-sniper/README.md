# HiBid Sniper

Personal auto-bid bot for HiBid auctions, with a phone-app-style
dashboard. For each lot you set a max bid; the bot watches it and bids
for you up to that max — either continuously (proxy) or only in the
final seconds (snipe) — and rides out HiBid's "soft close" time
extensions until the lot actually closes. It never bids past the max you
set. Deployed on Fly.io when `FLY_API_TOKEN` is configured.

## Reality check (ToS)

HiBid's terms of service likely do **not** explicitly bless automated
bidding tools. This runs on your own account, at your own risk. Soft
close exists specifically to defeat eBay-style one-shot sniping — this
bot is built around that, but using it may still violate HiBid's rules.

## Status (calibrated 2026-09-18)

This environment **can** reach hibid.com via Playwright Chromium.
Plain `curl` is Cloudflare-blocked. Live calibration was done against
`https://hibid.com/florida/lot/320694969` and GraphQL `POST /graphql`.

What actually works on the real site:

| Concern | Reality |
|---|---|
| Price / timer / status | GraphQL `lotState` (`highBid`, `minBid`, `timeLeftSeconds`, `buyerBidStatus`, `softCloseSeconds`, `biddingExtended`) |
| Bidding | GraphQL `bid` mutation; on `MAX_BIDDING` auctions the amount **is** your proxy ceiling |
| Login | Two-step modal from **Sign In** (`#username-input` → Continue → password → Log In). `/login` is not a usable route. Turnstile may block scripted login — prefer a captured session |
| Search | GraphQL `lotSearch`, or `/lots?query=…&status=OPEN` |
| Soft close | Per-lot; observed 300s on the calibration lot |

`DEMO_MODE=true` still runs the whole app against a simulated auction with
no browser — useful to confirm the dashboard itself is healthy.

## Where your credentials actually go

Nothing sensitive is committed to the repo.

| Secret | Where it lives | Used for |
|---|---|---|
| `DASHBOARD_PASSWORD` | Fly secret / `.env` | Password gate in front of the public dashboard |
| `HIBID_AUTH_STATE_B64` | Fly secret / `.env` | Preferred HiBid login — base64 of Playwright `data/auth.json`. Decoded to `data/auth.json` on boot (gitignored) |
| `HIBID_EMAIL` + `HIBID_PASSWORD` | Fly secret / `.env` | Fallback scripted login only. **Never pasted into chat.** May fail on Turnstile |
| `FLY_API_TOKEN` | GitHub Actions repo secret | Lets CI run `flyctl deploy` |

## One-time setup

### 1. Fly app + GitHub deploy token

```bash
# on a machine logged into Fly
fly apps create hibid-sniper   # if it doesn't exist yet
fly tokens create deploy
```

Add the token as repo secret `FLY_API_TOKEN`. Without it, the GitHub
Actions workflow cannot deploy (previous runs failed with an empty token).

### 2. Fly secrets

```bash
fly secrets set DASHBOARD_PASSWORD='pick-a-strong-password' -a hibid-sniper
fly secrets set DEMO_MODE=true -a hibid-sniper   # until HiBid session is ready
# after capturing a session (below):
# fly secrets set HIBID_AUTH_STATE_B64="$(base64 -w0 data/auth.json)" DEMO_MODE=false -a hibid-sniper
```

### 3. Capture a HiBid session (recommended over password)

```bash
cd hibid-sniper
npm install && npx playwright install chromium
npm run inspect -- https://hibid.com/florida/lot/320694969
# log in by hand in the browser, press Enter — writes data/auth.json
base64 -w0 data/auth.json   # macOS: base64 -i data/auth.json | tr -d '\n'
```

Set that string as `HIBID_AUTH_STATE_B64`. Refresh the secret when the
session expires.

Every push to `claude/hibid-auction-sniper-bot-5j08km` under `hibid-sniper/`
redeploys via `.github/workflows/hibid-sniper-deploy.yml`.

## Architecture

- `src/bot/graphql.ts` — calibrated GraphQL client (`lotState`, `lotSearch`, `bid`)
- `src/bot/scraper.ts` (`LiveSource`) — GraphQL-first, DOM fallback, Playwright for CF cookies
- `src/bot/demoSource.ts` — simulated auction when `DEMO_MODE=true`
- `src/bot/engine.ts` — proxy/snipe loop; per-lot errors never crash the process
- `src/bot/login.ts` — session restore + two-step scripted login
- `src/bot/selectors.ts` — DOM fallbacks calibrated against live HTML
- `src/auth/passwordGate.ts` — cookie-session gate for the public URL

## Soft close

A bid in HiBid's final moments extends that lot's clock. **Proxy mode**
holds your max and re-bids (on `MAX_BIDDING` auctions: submits your max
once as HiBid's native proxy ceiling). **Snipe mode** waits until
`snipeSeconds` before close, then behaves like proxy — including through
extensions. A single one-shot last-second bid is not enough on this site.

## Running locally

```bash
npm install
npx playwright install chromium   # only if DEMO_MODE=false
cp .env.example .env
# set DASHBOARD_PASSWORD and either DEMO_MODE=true or a HiBid session
npm run build && npm start
```

## Failure isolation

If the browser binary is missing, a selector/GraphQL call fails, or the
network blips, that lot is marked `error` and retried — the HTTP server,
WebSocket dashboard, and every other lot keep running. `/api/health`
always answers without touching the browser.
