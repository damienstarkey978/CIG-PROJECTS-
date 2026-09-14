# HiBid Sniper

Personal auto-bid bot for HiBid auctions, with a phone-app-style dashboard.
For each lot you set a max bid; the bot watches it and bids for you up to
that max — either continuously (proxy) or only in the final seconds
(snipe) — and rides out HiBid's "soft close" time extensions until the lot
actually closes. It never bids past the max you set.

## The easy path: deploy it as a hosted web app

This turns it into a real web app with a URL, no terminal needed after the
one-time login step below.

**1. One-time, on any computer with a real browser (does the HiBid login):**

```bash
git clone <this repo> && cd hibid-sniper
npm install
npm run inspect -- https://hibid.com/some/real/lot/url
```

A real browser window opens. Log in to HiBid by hand, then press Enter in
the terminal. This saves `data/auth.json` — your logged-in session.

Then turn that file into one line you can paste into a hosting dashboard:

```bash
base64 -w0 data/auth.json   # Mac: base64 -i data/auth.json
```

Copy the long string it prints.

**2. Deploy, all in the browser, no terminal:**

- Go to [railway.app](https://railway.app), sign in, **New Project → Deploy from GitHub repo**, pick this repo/branch. It finds the `Dockerfile` automatically and builds it.
- In the project's **Variables** tab, add one variable: `HIBID_AUTH_STATE_B64` = the string you copied above.
- Deploy. Railway gives you a public `https://...` URL.

**3. That URL is your app.** Open it on your phone, tap Share → Add to
Home Screen, and it behaves like an installed app. Tap **+**, paste a lot
URL, set your max bid and mode, done.

Sessions expire eventually (HiBid will just start requiring login again).
When the dashboard shows login/auth errors, repeat step 1 and update the
`HIBID_AUTH_STATE_B64` variable in Railway with the new value.

(Render.com, Fly.io, or any host that builds a `Dockerfile` and lets you
set env vars works the same way — Railway's just the fewest clicks.)

## The manual path: running it yourself instead

If you'd rather not use a hosting service, run it on a computer that's
on and connected whenever auctions you're watching are closing:

```bash
npm install
cp .env.example .env   # fill in PORT if you want something other than 4310
npm run build && npm start
```

Open `http://localhost:4310` on your phone (same network) or through a
tunnel (Tailscale/ngrok) if not. It reuses `data/auth.json` from the
inspect step above the same way.

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
