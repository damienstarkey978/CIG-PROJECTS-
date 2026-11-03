# ON GO

Real-time, location-based BOGO discovery for the Jacksonville Beaches.

**Tagline:** When it's ON, you GO.  
**Supporting:** Every hour. Every appetite. Something's ON.

This folder is the Phase 1 working app for the CIG monorepo. It evolves the [Wix Headless demo](https://headless-ayyjspbhfuj-joshdespain-140b.wix-site-host.com) into a persistent Node + SQLite product: Beaches directory, Leaflet/OSM map, customer & business accounts, timed offers, and QR redemption.

Project docs (audit, architecture, schema, roadmap) live in the Project agent store under `docs/`.

## Quick start

```bash
cd on-go
npm install
npm start
```

Open http://localhost:3847

### Demo accounts (seeded on first boot)

| Role | Email | Password | Notes |
|---|---|---|---|
| Customer | `customer@ongo.demo` | `demo1234` | Claim offers, show QR |
| Business | `business@ongo.demo` | `demo1234` | Manages Pete's Bar |

## Phase 1 walkthrough

1. Sign in as **business@ongo.demo** → **For businesses** → activate a BOGO for 60 minutes.
2. Sign out → sign in as **customer@ongo.demo** → **Explore** → claim the live offer → show QR.
3. Sign back in as the business account → paste the token under **Verify QR redemption**.
4. Customer **Rewards** shows points only after verification.

## Stack

- Express API + static mobile-first UI
- SQLite (`better-sqlite3`) in `data/on-go.db`
- Leaflet + OpenStreetMap
- HTTP-only session cookies; bcrypt passwords
- QR via `qrcode` (token format `ongo:<token>`)

No API secrets are shipped to the browser. Configure `SESSION_SECRET` via env in production (see `.env.example`).

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Run server (seeds DB if empty) |
| `npm run dev` | `node --watch server.js` |
| `npm run seed` | Force re-seed helper (see `scripts/seed.js`) |

## Notes

- Unclaimed directory listings are labeled so they do not imply endorsement.
- Ad slot bidding is **simulation only** (schema ready for Phase 2 payments).
- Coordinates are approximate public locations for MVP mapping — verify before launch marketing.
