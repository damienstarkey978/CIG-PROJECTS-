# HiBid Sniper

Personal auto-bid bot for HiBid auctions, with a phone-app-style
dashboard. For each lot you set a max bid; the bot watches it and bids
for you up to that max — either continuously (proxy) or only in the
final seconds (snipe) — and rides out HiBid's "soft close" time
extensions until the lot actually closes. It never bids past the max you
set. Deployed on Fly.io, deploys itself via GitHub Actions on every push.

## Status

- App: `hibid-sniper` on Fly.io, region `iad`.
- Deploys automatically on push to this branch via `.github/workflows/hibid-sniper-deploy.yml` (Fly's remote builders — no local build or `fly deploy` needed once `FLY_API_TOKEN` is set as a repo secret).
- `DEMO_MODE=true` runs the whole app — dashboard, engine, proxy/snipe bidding logic — against a simulated auction, no browser or network required. Good for confirming the app itself is healthy independent of HiBid calibration.
- Real bidding (`DEMO_MODE=false` or unset) needs `src/bot/selectors.ts` and `src/bot/login.ts` calibrated against the live site — see below. Nothing in this repo has ever touched real hibid.com; every Claude sandbox that's worked on it has been network-blocked from that domain.

## One-time setup

In the repo's GitHub settings → Secrets and variables → Actions, add:

- `FLY_API_TOKEN` — from `fly tokens create deploy` (or Fly dashboard → Tokens) on a machine logged into your Fly account.

In the Fly app's secrets (`fly secrets set NAME=value`, or the Fly dashboard):

- `DASHBOARD_PASSWORD` — required, since Fly gives every app a public URL by default.
- Either `HIBID_EMAIL` + `HIBID_PASSWORD` (scripted login, depends on `login.ts` selectors being correct), or `HIBID_AUTH_STATE_B64` (a captured session, see below — more reliable, avoids scripted login entirely).
- `DEMO_MODE=true` if you want the app running now while HiBid calibration is still in progress.

After that, every push to this branch redeploys automatically.

## Calibrating against the real site

This has to happen on a machine with real internet access — any Claude
sandbox is blocked from hibid.com specifically.

```bash
npm install
npx playwright install chromium   # one-time, only needed for this local step
npm run inspect -- https://hibid.com/some/real/lot/url
npm run inspect -- --search "some query"
```

Each opens a real browser window. Log in by hand if prompted, press
Enter in the terminal — this saves `data/auth.json`. It also dumps the
rendered page to `inspect-output/` and prints the JSON API responses the
page makes while loading, which is often a more reliable source for
price/countdown than scraping the DOM.

Use what you find to fix:
- `src/bot/selectors.ts` — lot page price/timer/bid controls, and search-results card selectors
- `src/bot/login.ts` (`loginSelectors` in `selectors.ts`) — the login form

To deploy a captured session instead of storing a password on Fly:

```bash
base64 -w0 data/auth.json   # Mac: base64 -i data/auth.json
```

Set that as `HIBID_AUTH_STATE_B64` — the app decodes it back to
`data/auth.json` on boot. Whenever the session expires, repeat this and
update the secret.

## Architecture

- `src/bot/engine.ts` — the actual polling/bidding loop (`startEngine`/`stopEngine`/`watchLot`/`unwatchLot`). Any failure from the lot source (missing browser, bad selectors, network error) is caught per-lot and turned into an `error` status + retry, never an uncaught throw — that's what crashed the process on Fly before.
- `src/bot/scraper.ts` (`LiveSource`) — real Playwright driver against hibid.com.
- `src/bot/demoSource.ts` (`DemoSource`) — simulated auction, used when `DEMO_MODE=true`.
- `src/bot/manager.ts` — lot CRUD + persistence (`data/lots.json`).
- `src/bot/login.ts` — shared logged-in browser context, saved/restored session.
- `src/bot/browseFetch.ts` + `browseParse.ts` — HiBid search/browse, so lots can be found from inside the app instead of only pasted by URL.
- `src/auth/passwordGate.ts` — simple cookie-session password gate in front of the whole dashboard.

## Why "soft close" changes the strategy

If a bid lands in HiBid's final moments, it extends that lot's clock so
other bidders can respond — a single last-second bid usually just
triggers an extension rather than winning. **Proxy mode** (default) is
built for that: it holds your max and only bids the minimum needed to
stay in front, through as many extensions as it takes. **Snipe mode**
holds off bidding until `snipeSeconds` before the scheduled close, then
behaves like proxy mode from that point on, including through
extensions.

Automated bidding tools likely aren't something HiBid's terms of service
explicitly welcome — this runs on your own account, at your own risk.

## Running it locally instead

```bash
npm install
npx playwright install chromium   # only if DEMO_MODE=false
cp .env.example .env
npm run build && npm start
```
