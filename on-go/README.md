# ON GO

Real-time, location-based BOGO discovery for the Jacksonville Beaches.

**When it's ON, you GO.** · Every hour. Every appetite. Something's ON.

Canonical product lives in this folder (`on-go/`). The old hosted placeholder page is historical brand reference only — we are **not** building on that host or any site-builder CMS.

Project docs (audit, architecture, schema, roadmap, venue coords) live in the Project agent store `docs/`.

## Quick start (local)

```bash
cd on-go
npm install
npm start
```

Open http://localhost:3847

### Demo accounts

| Role | Email | Password |
|---|---|---|
| Customer | `customer@ongo.demo` | `demo1234` |
| Business | `business@ongo.demo` | `demo1234` (Pete's Bar) |

## Phase 1 walkthrough

1. Business login → activate a BOGO for 60 minutes.
2. Customer login → Explore → Claim & get QR.
3. Business → paste token under Verify QR.
4. Customer Rewards shows points **after** verification.
5. Try **Next Stop**, favorites, radius filter, analytics / plan scaffolds.

## Stack

- Express API + mobile-first static UI
- `sql.js` (WASM SQLite) — local file under `data/`; **Netlify Blobs** when `NETLIFY=true`
- Leaflet + OpenStreetMap (verified seed coords — see Project `docs/venue-coords.md`)
- HTTP-only sessions; bcrypt; QR via `qrcode`

## Netlify (test hosting)

```bash
cd on-go
npx netlify login          # if needed
npx netlify init           # link or create site (first time)
npx netlify env:set SESSION_SECRET "$(openssl rand -hex 24)"
npx netlify deploy --prod
```

Config: `netlify.toml` publishes `public/`, routes `/api/*` to `netlify/functions/api.js`.

### Stripe Pro billing (flagged off by default)

Claimed venues stay on Pro free-trial until `ONGO_BILLING_ENABLED=true`. Setup steps, env vars, and webhook URL: Project store `docs/subscription-billing.md`. Placeholder env names are in `.env.example` — never commit real Stripe keys.

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Local server |
| `npm run dev` | `--watch` |
| `npm run seed` | Reset DB file and re-seed |
