# HiBid Sniper

Personal auto-bid bot for HiBid auctions, with a phone-app-style dashboard.
For each lot you set a max bid; the bot watches it and bids for you up to
that max — either continuously (proxy) or only in the final seconds
(snipe) — and rides out HiBid's "soft close" time extensions until the lot
actually closes. It never bids past the max you set.

## Deploy it as a hosted web app — no terminal at all

Two steps, both in a browser, neither is something an AI can do for you
(they need your identity/your password):

**1. Deploy from GitHub:**

- Go to [railway.app](https://railway.app), sign in, **New Project → Deploy from GitHub repo**, pick this repo, branch `claude/hibid-auction-sniper-bot-5j08km`. It finds the `Dockerfile` automatically and builds it — nothing to configure.

**2. Set two secrets:**

- In the project's **Variables** tab, add `HIBID_EMAIL` and `HIBID_PASSWORD` — your real HiBid login. These go straight into Railway's own secret storage, never through me, never in any chat.
- Deploy. Railway gives you a public `https://...` URL. The app logs into HiBid itself on startup using those two variables.

**That URL is your app.** Open it on your phone, tap Share → Add to Home
Screen, and it behaves like an installed app. Tap **+**, paste a lot URL,
set your max bid and mode, done.

**If login fails:** the CSS selectors the bot uses to find HiBid's login
form (`src/bot/selectors.ts`) are educated guesses, not verified against
the live site, because this was built somewhere with no network path to
hibid.com. If it fails, open Railway's **Deployments → logs** (a webpage,
no terminal), copy the error, send it to me. I'll push a fix to the same
branch and Railway redeploys automatically since it's watching that
branch — you won't need to touch anything else.

(Render.com, Fly.io, or any host that builds a `Dockerfile` and lets you
set env vars works the same way — Railway's just the fewest clicks.)

## Prefer a captured session instead of storing your password?

Skip `HIBID_EMAIL`/`HIBID_PASSWORD` and set `HIBID_AUTH_STATE_B64` instead.
On a computer with a real browser:

```bash
git clone <this repo> && cd hibid-sniper && npm install
npm run inspect -- https://hibid.com/some/real/lot/url   # log in by hand when it opens
base64 -w0 data/auth.json   # Mac: base64 -i data/auth.json
```

Paste that output as `HIBID_AUTH_STATE_B64` in Railway. This avoids
scripted login (and its unverified selectors) entirely, at the cost of
that one local step, and needs repeating whenever the session expires.

## Running it yourself instead of hosting it

If you'd rather not use a hosting service, run it on a computer that's
on and connected whenever auctions you're watching are closing:

```bash
npm install
cp .env.example .env   # fill in HIBID_EMAIL/HIBID_PASSWORD or PORT
npm run build && npm start
```

Open `http://localhost:4310` on your phone (same network) or through a
tunnel (Tailscale/ngrok) if not.

## Why "soft close" changes the strategy

If a bid lands in HiBid's final moments, it extends that lot's clock so
other bidders can respond — a single last-second bid usually just triggers
an extension rather than winning. **Proxy mode** (default) is built for
that: it holds your max and only bids the minimum needed to stay in front,
through as many extensions as it takes. **Snipe mode** holds off bidding
until `snipeSeconds` before the scheduled close, then behaves like proxy
mode from that point on, including through extensions.

Automated bidding tools likely aren't something HiBid's terms of service
explicitly welcome — this runs on your own account, at your own risk.

## If bidding stops working

`src/bot/selectors.ts` has best-guess CSS selectors for the price, timer,
and bid button, since this was built without live access to hibid.com to
verify them. If the dashboard log shows bid/parsing errors, that's almost
certainly why. Fastest fix: run `npm run inspect -- <the lot url>` again —
it dumps the real page to `data/inspect-dump.html` and prints the API
responses the page makes — and send me what you find; I'll update the
selectors (or wire up a direct API call, which is more reliable than DOM
scraping if you find a clean JSON endpoint).
