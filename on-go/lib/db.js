'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const DB_PATH = path.join(DATA_DIR, 'on-go.db');
const BLOB_KEY = 'on-go.db';

/** OSM-verified Beaches seed — see docs/venue-coords.md */
const SEED_BUSINESSES = [
  {
    name: "Pete's Bar",
    area: 'Neptune Beach',
    category: 'Bar',
    address: '1st Street, Beaches Town Center, Neptune Beach, FL 32266',
    phone: '',
    lat: 30.3239091,
    lng: -81.3958732,
    hours_json: JSON.stringify({ daily: '11-2' }),
    osm_ref: 'way/660050787',
  },
  {
    name: "Poe's Tavern",
    area: 'Atlantic Beach',
    category: 'Lunch',
    address: 'Atlantic Boulevard, Atlantic Beach, FL 32233',
    lat: 30.3249079,
    lng: -81.3976548,
    hours_json: JSON.stringify({ daily: '11-10' }),
    osm_ref: 'way/363613890',
  },
  {
    name: 'Southern Grounds & Co.',
    area: 'Neptune Beach',
    category: 'Coffee',
    address: '1st Street, Beaches Town Center, Neptune Beach, FL 32266',
    lat: 30.3233845,
    lng: -81.3961643,
    hours_json: JSON.stringify({ daily: '7-6' }),
    osm_ref: 'node/6179774287',
  },
  {
    name: "Lynch's Irish Pub",
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '1st Street North, Jacksonville Beach, FL 32250',
    lat: 30.2935016,
    lng: -81.3906216,
    hours_json: JSON.stringify({ daily: '11-2' }),
    osm_ref: 'node/6744299634',
  },
  {
    name: 'TacoLu',
    area: 'Jacksonville Beach',
    category: 'Dinner',
    address: '1712 Beach Boulevard, Jacksonville Beach, FL 32250',
    lat: 30.2875034,
    lng: -81.4102419,
    hours_json: JSON.stringify({ daily: '11-10' }),
    osm_ref: 'way/435316841',
  },
  {
    name: "Cinotti's Bakery",
    area: 'Jacksonville Beach',
    category: 'Breakfast',
    address: '1505 3rd Street South, Jacksonville Beach, FL 32250',
    lat: 30.2740766,
    lng: -81.3888092,
    hours_json: JSON.stringify({ daily: '6-6' }),
    osm_ref: 'address:1505-3rd-st-s',
  },
  {
    name: 'North Beach Fish Camp',
    area: 'Neptune Beach',
    category: 'Dinner',
    address: '100 1st Street, Neptune Beach, FL 32266',
    lat: 30.3244437,
    lng: -81.3962908,
    hours_json: JSON.stringify({ daily: '11-10' }),
    osm_ref: 'node/4532625708',
  },
  {
    name: 'Flying Iguana Taqueria & Tequila Bar',
    area: 'Neptune Beach',
    category: 'Dinner',
    address: '207 Atlantic Boulevard, Neptune Beach, FL 32266',
    lat: 30.324432,
    lng: -81.396446,
    hours_json: JSON.stringify({ daily: '11-10' }),
    osm_ref: 'node/4532620825',
  },
  {
    name: 'Marker 32',
    area: 'Jacksonville Beach',
    category: 'Dinner',
    address: 'Beach Boulevard, Isle of Palms, Jacksonville, FL 32224',
    lat: 30.2892187,
    lng: -81.4321309,
    hours_json: JSON.stringify({ tue_sun: '5-10' }),
    osm_ref: 'way/450822564',
  },
  {
    name: 'Valley Smoke',
    area: 'Ponte Vedra Beach',
    category: 'Dinner',
    address: '11 S Roscoe Blvd, Palm Valley / Ponte Vedra Beach, FL 32082',
    lat: 30.1752966,
    lng: -81.4011813,
    hours_json: JSON.stringify({ daily: '11-9' }),
    osm_ref: 'node/7176682476',
  },
  {
    name: 'Aqua Grill',
    area: 'Ponte Vedra Beach',
    category: 'Dinner',
    address: 'Front Street, Sawgrass Village, Ponte Vedra Beach, FL 32082',
    lat: 30.2037277,
    lng: -81.3813434,
    hours_json: JSON.stringify({ daily: '11-10' }),
    osm_ref: 'overpass:aqua-grill',
  },
  {
    name: 'The Lemon Bar',
    area: 'Neptune Beach',
    category: 'Bar',
    address: 'Lemon Street, Neptune Beach, FL 32266',
    lat: 30.3239297,
    lng: -81.3950339,
    hours_json: JSON.stringify({ daily: '12-2' }),
    osm_ref: 'overpass:lemon-bar',
  },
  {
    name: 'European Street Cafe',
    area: 'Jacksonville Beach',
    category: 'Coffee',
    address: 'Beach Boulevard, Jacksonville Beach, FL 32250',
    lat: 30.2878177,
    lng: -81.3989652,
    hours_json: JSON.stringify({ daily: '8-8' }),
    osm_ref: 'overpass:european-street',
  },
  {
    name: 'Palm Valley Fish Camp',
    area: 'Ponte Vedra Beach',
    category: 'Lunch',
    address: '299 Roscoe Blvd N, Ponte Vedra Beach, FL 32082',
    lat: 30.2102397,
    lng: -81.4096577,
    hours_json: JSON.stringify({ daily: '11-9' }),
    osm_ref: 'overpass:palm-valley-fish-camp',
  },
  {
    name: 'Azurea',
    area: 'Atlantic Beach',
    category: 'Dinner',
    address: '1 Ocean Blvd, Atlantic Beach, FL 32233',
    lat: 30.3248746,
    lng: -81.3949788,
    hours_json: JSON.stringify({ daily: '5-10' }),
    osm_ref: 'overpass:azurea',
  },
  {
    name: 'The Local',
    area: 'Neptune Beach',
    category: 'Dinner',
    address: '301 Atlantic Blvd, Neptune Beach, FL 32266',
    phone: '(904) 372-9791',
    lat: 30.3243442,
    lng: -81.3975144,
    hours_json: JSON.stringify({ mon_wed: '9-10', thu_sat: '9-12', sun: '9-9' }),
    osm_ref: 'address:301-atlantic-blvd-neptune',
  },
  {
    name: 'Island Girl Cigar Bar (Neptune Beach)',
    area: 'Neptune Beach',
    category: 'Bar',
    address: '108 1st Street, Neptune Beach, FL 32266',
    phone: '(904) 372-4194',
    lat: 30.3241963,
    lng: -81.3962405,
    hours_json: JSON.stringify({ sun_wed: '11-1', thu_sat: '11-2' }),
    osm_ref: 'address:108-1st-st-neptune',
  },
  {
    name: 'Island Girl Cigar Bar (Mayport)',
    area: 'Atlantic Beach',
    category: 'Bar',
    address: '2294 Mayport Road #25, Atlantic Beach, FL 32233',
    phone: '(904) 595-5042',
    lat: 30.3509839,
    lng: -81.414418,
    hours_json: JSON.stringify({ daily: '11-2' }),
    osm_ref: 'address:2294-mayport-rd-25',
  },
  {
    name: "Mr. Chubby's Wings",
    area: 'Ponte Vedra Beach',
    category: 'Dinner',
    address: '150 Valley Circle, Ponte Vedra Beach, FL 32082',
    phone: '(904) 500-9464',
    lat: 30.1905473,
    lng: -81.3807582,
    hours_json: JSON.stringify({ sun_thu: '11-11', fri_sat: '11-12' }),
    osm_ref: 'address:150-valley-circle-pvb',
  },
  {
    name: "Surfer the Bar",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "200 1st St N, Jacksonville Beach, FL 32250",
    phone: "(904) 372-9756",
    lat: 30.2905266,
    lng: -81.3900981,
    hours_json: "{\"tue_fri\":\"16-2\",\"sat_sun\":\"11-2\",\"mon\":\"closed\"}",
    osm_ref: "overpass:surfer-the-bar",
  },
  {
    name: "Mango's Beach Bar & Grille",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "602 1st St N, Jacksonville Beach, FL 32250",
    phone: "(904) 246-4200",
    lat: 30.2942306,
    lng: -81.3909948,
    hours_json: "{\"daily\":\"11-2\"}",
    osm_ref: "address:602-1st-st-n",
  },
  {
    name: "Ginger's Place",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "304 3rd St S, Jacksonville Beach, FL 32250",
    phone: "(904) 249-8711",
    lat: 30.2851579,
    lng: -81.3914062,
    hours_json: "{\"daily\":\"13-2\"}",
    osm_ref: "address:304-3rd-st-s",
  },
  {
    name: "Wreck Tiki Lounge",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "401 1st St N, Jacksonville Beach, FL 32250",
    phone: "(904) 247-0507",
    lat: 30.2936114,
    lng: -81.3904478,
    hours_json: "{\"mon\":\"16-22\"}",
    osm_ref: "address:401-1st-st-n-wreck",
  },
  {
    name: "Sandbar Jax Beach",
    area: "Jacksonville Beach",
    category: "Dinner",
    address: "465 1st St N, Jacksonville Beach, FL 32250",
    phone: "(904) 246-6160",
    lat: 30.2937257,
    lng: -81.3904705,
    hours_json: "{\"sun_thu\":\"11-22\",\"fri_sat\":\"11-23\"}",
    osm_ref: "overpass:pier-cantina-sandbar",
  },
  {
    name: "The Ritz Lounge",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "185 3rd Ave N, Jacksonville Beach, FL 32250",
    phone: "(904) 246-2255",
    lat: 30.2923349,
    lng: -81.391035,
    hours_json: "{\"daily\":\"13-2\"}",
    osm_ref: "address:185-3rd-ave-n",
  },
  {
    name: "Lucky's Bar",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "333 1st St N #150, Jacksonville Beach, FL 32250",
    phone: "(904) 222-0796",
    lat: 30.2916409,
    lng: -81.3902345,
    hours_json: "{\"wed_thu\":\"17-2\",\"fri_sun\":\"15-2\",\"mon_tue\":\"closed\"}",
    osm_ref: "address:333-1st-st-n-150",
  },
  {
    name: "Tavern on 1st",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "401 1st St N, Jacksonville Beach, FL 32250",
    phone: "(904) 247-0507",
    lat: 30.2924628,
    lng: -81.3899486,
    hours_json: "{\"mon_fri\":\"16-2\",\"sat_sun\":\"13-2\"}",
    osm_ref: "overpass:tavern-on-1st",
  },
  {
    name: "Salt Beachside Bar",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "1515 1st St N, Jacksonville Beach, FL 32250",
    phone: "(904) 241-2311",
    lat: 30.302903,
    lng: -81.391849,
    hours_json: "{\"daily\":\"until-22\"}",
    osm_ref: "address:1515-1st-st-n-hampton",
  },
  {
    name: "Flask & Cannon",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "528 1st St N, Jacksonville Beach, FL 32250",
    phone: "(904) 853-6633",
    lat: 30.2938201,
    lng: -81.3907128,
    hours_json: "{\"mon_thu\":\"11-22\",\"fri_sat\":\"11-23\",\"sun\":\"10-21\"}",
    osm_ref: "address:528-1st-st-n-vpizza",
  },
  {
    name: "Brix Taphouse & Bar",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "300 2nd St N, Jacksonville Beach, FL 32250",
    phone: "(904) 241-4668",
    lat: 30.2913014,
    lng: -81.3913324,
    hours_json: "{\"sun_thu\":\"11-23\",\"fri_sat\":\"11-24\"}",
    osm_ref: "overpass:brix-taphouse",
  },
  {
    name: "Pusser's Bar and Grille",
    area: "Ponte Vedra Beach",
    category: "Bar",
    address: "816 A1A N Suite 100, Ponte Vedra Beach, FL 32082",
    phone: "(904) 280-7766",
    lat: 30.201062,
    lng: -81.381256,
    hours_json: "{\"sun_thu\":\"11-21\",\"fri_sat\":\"11-22\"}",
    osm_ref: "exa:pussers-pvb",
  },
  {
    name: "Jax Beach Bar & Grill",
    area: "Jacksonville Beach",
    category: "Dinner",
    address: "265 5th Ave N, Jacksonville Beach, FL 32250",
    phone: "(904) 746-7774",
    lat: 30.2941017,
    lng: -81.3924804,
    hours_json: "{}",
    osm_ref: "address:265-5th-ave-n",
  },
  {
    name: "Kava & Co",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "223 9th Ave S, Jacksonville Beach, FL 32250",
    phone: "(904) 595-5150",
    lat: 30.2801026,
    lng: -81.3897947,
    hours_json: "{}",
    osm_ref: "address:223-9th-ave-s",
  },
  {
    name: "Factory After Dark",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "1396 Beach Blvd, Jacksonville Beach, FL 32250",
    phone: "(904) 372-0366",
    lat: 30.2875192,
    lng: -81.4040388,
    hours_json: "{}",
    osm_ref: "address:1396-beach-blvd",
  },
  {
    name: "LandShark Bar & Grill",
    area: "Jacksonville Beach",
    category: "Dinner",
    address: "715 1st St N, Jacksonville Beach, FL 32250",
    phone: "(904) 222-0222",
    lat: 30.2954067,
    lng: -81.390692,
    hours_json: "{}",
    osm_ref: "address:715-1st-st-n-margaritaville",
  },
  {
    name: "Monkey's Uncle Tavern",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "1728 3rd St N, Jacksonville Beach, FL 32250",
    phone: "(904) 246-1070",
    lat: 30.3045241,
    lng: -81.3958344,
    hours_json: "{}",
    osm_ref: "address:1728-3rd-st-n",
  },
  {
    name: "1912 Ocean Bar & Rooftop",
    area: "Ponte Vedra Beach",
    category: "Bar",
    address: "619 Ponte Vedra Blvd, Ponte Vedra Beach, FL 32082",
    phone: "(904) 373-2063",
    lat: 30.2172861,
    lng: -81.3716646,
    hours_json: "{\"mon_sat\":\"16-22\",\"sun_brunch\":\"11-14\"}",
    osm_ref: "address:619-ponte-vedra-blvd",
  },
  {
    name: "Sneakers Sports Grille",
    area: "Jacksonville Beach",
    category: "Dinner",
    address: "111 Beach Blvd, Jacksonville Beach, FL 32250",
    phone: "(904) 482-1000",
    lat: 30.2888403,
    lng: -81.3900168,
    hours_json: "{\"sun_thu\":\"11-22\",\"fri_sat\":\"11-24\"}",
    osm_ref: "overpass:sneakers-sports-grille",
  },
  {
    name: "Green Room Brewing",
    area: "Jacksonville Beach",
    category: "Bar",
    address: "228 3rd St N, Jacksonville Beach, FL 32250",
    phone: "(904) 201-9283",
    lat: 30.2907112,
    lng: -81.3926017,
    hours_json: "{\"mon\":\"closed\",\"tue_thu\":\"15-24\",\"fri\":\"15-1\",\"sat\":\"12-1\",\"sun\":\"12-22\"}",
    osm_ref: "address:228-3rd-st-n",
  },
  {
    name: "Harbor Tavern",
    area: "Atlantic Beach",
    category: "Bar",
    address: "160 Mayport Rd, Atlantic Beach, FL 32233",
    phone: "(904) 246-2555",
    lat: 30.3258562,
    lng: -81.4193621,
    hours_json: "{\"daily\":\"11-2\"}",
    osm_ref: "address:160-mayport-rd",
  },
  {
    name: "Dragonfly Lounge",
    area: "Neptune Beach",
    category: "Bar",
    address: "1505 Atlantic Blvd #1537, Neptune Beach, FL 32266",
    phone: "(904) 903-7162",
    lat: 30.3235608,
    lng: -81.4145501,
    hours_json: "{\"mon\":\"11-22\",\"tue\":\"closed\",\"wed_thu\":\"11-22\",\"fri_sat\":\"11-24\",\"sun\":\"11-22\"}",
    osm_ref: "address:1505-atlantic-blvd-1537",
  },
  {
    name: "Culhane's Irish Pub",
    area: "Atlantic Beach",
    category: "Bar",
    address: "967 Atlantic Blvd, Atlantic Beach, FL 32233",
    phone: "(904) 249-9595",
    lat: 30.3257567,
    lng: -81.410551,
    hours_json: "{\"mon\":\"11:30-24\",\"tue_wed\":\"11:30-22\",\"thu\":\"11:30-24\",\"fri\":\"11:30-1:30\",\"sat\":\"9-1:30\",\"sun\":\"8:30-24\"}",
    osm_ref: "address:967-atlantic-blvd-ab",
  },
  {
    name: "Mojo's Blues Bar and BBQ",
    area: "Jacksonville Beach",
    category: "Dinner",
    address: "1500 Beach Blvd, Jacksonville Beach, FL 32250",
    phone: "(904) 247-6636",
    lat: 30.28755,
    lng: -81.4065,
    hours_json: "{\"sun_tue\":\"11-21\",\"wed_sat\":\"11-22\"}",
    osm_ref: "address:1500-beach-blvd-mojo-kitchen",
  },
];

/** Permanently closed — remove from live directory/map on every boot */
const CLOSED_VENUE_NAMES = ["Fly's Tie Irish Pub"];

const AD_SLOTS = [
  { zone: 'All Beaches', category: 'Coffee', slot_label: '6–10 AM Coffee', hoursAheadStart: 1, durationHours: 4, min_bid_cents: 500 },
  { zone: 'All Beaches', category: 'Lunch', slot_label: '10 AM–3 PM Lunch', hoursAheadStart: 2, durationHours: 5, min_bid_cents: 800 },
  { zone: 'All Beaches', category: 'Bar', slot_label: '3–7 PM Happy Hour', hoursAheadStart: 4, durationHours: 4, min_bid_cents: 1000 },
  { zone: 'All Beaches', category: 'Dinner', slot_label: '7 PM–midnight Dinner', hoursAheadStart: 6, durationHours: 5, min_bid_cents: 1200 },
];

function nowIso() {
  return new Date().toISOString();
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** better-sqlite3-like wrapper over sql.js */
function wrapDb(raw) {
  const api = {
    raw,
    dirty: false,
    exec(sql) {
      // DDL / PRAGMA — do not mark dirty. Marking dirty here caused every
      // Netlify request to rewrite Blobs and clobber fresher writes under
      // eventual consistency.
      raw.exec(sql);
    },
    prepare(sql) {
      return {
        all(...params) {
          const stmt = raw.prepare(sql);
          if (params.length) stmt.bind(params);
          const rows = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          stmt.free();
          return rows;
        },
        get(...params) {
          const rows = this.all(...params);
          return rows[0];
        },
        run(...params) {
          raw.run(sql, params.length ? params : undefined);
          const changes = raw.getRowsModified();
          // Avoid marking dirty on no-op UPDATEs (e.g. expireOffers) so Netlify
          // doesn't rewrite Blobs on every read-only request.
          if (changes > 0) api.dirty = true;
          return { changes };
        },
      };
    },
    transaction(fn) {
      return (...args) => {
        raw.run('BEGIN');
        try {
          const result = fn(...args);
          raw.run('COMMIT');
          api.dirty = true;
          return result;
        } catch (err) {
          raw.run('ROLLBACK');
          throw err;
        }
      };
    },
    export() {
      return raw.export();
    },
  };
  return api;
}

function ensureAuthColumns(db) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  };
  add('email_verified_at', 'email_verified_at TEXT');
  add('verify_token', 'verify_token TEXT');
  add('verify_expires', 'verify_expires TEXT');
  add('reset_token', 'reset_token TEXT');
  add('reset_expires', 'reset_expires TEXT');
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      points_balance INTEGER NOT NULL DEFAULT 0,
      email_verified_at TEXT,
      verify_token TEXT,
      verify_expires TEXT,
      reset_token TEXT,
      reset_expires TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      area TEXT NOT NULL,
      category TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      website TEXT,
      hours_json TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'unclaimed',
      claimed_by_user_id TEXT,
      is_directory_only INTEGER NOT NULL DEFAULT 1,
      featured_until TEXT,
      osm_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS business_members (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      member_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(business_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      product_label TEXT,
      status TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      redemption_limit INTEGER,
      redemption_count INTEGER NOT NULL DEFAULT 0,
      points_reward INTEGER NOT NULL DEFAULT 25,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS redemptions (
      id TEXT PRIMARY KEY,
      offer_id TEXT NOT NULL,
      business_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      redeemed_at TEXT,
      redeemed_by_user_id TEXT,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      UNIQUE(offer_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS loyalty_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      redemption_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL,
      business_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, business_id)
    );

    CREATE TABLE IF NOT EXISTS ad_inventory (
      id TEXT PRIMARY KEY,
      zone TEXT NOT NULL,
      category TEXT,
      slot_label TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      min_bid_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bids (
      id TEXT PRIMARY KEY,
      inventory_id TEXT NOT NULL,
      business_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'simulated',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'active',
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function seedIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM businesses').get().n;
  if (count > 0) return { seeded: false };

  const ts = nowIso();
  const insertBiz = db.prepare(`
    INSERT INTO businesses (
      id, name, slug, area, category, address, phone, website, hours_json,
      lat, lng, status, claimed_by_user_id, is_directory_only, featured_until, osm_ref, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  const businessIds = [];
  const insertMany = db.transaction(() => {
    for (const b of SEED_BUSINESSES) {
      const id = uuid();
      businessIds.push({ id, name: b.name });
      insertBiz.run(
        id,
        b.name,
        slugify(b.name),
        b.area,
        b.category,
        b.address || '',
        b.phone || '',
        '',
        b.hours_json || '{}',
        b.lat,
        b.lng,
        'unclaimed',
        null,
        1,
        null,
        b.osm_ref || null,
        ts,
        ts
      );
    }

    const customerId = uuid();
    const businessUserId = uuid();
    const hash = bcrypt.hashSync('demo1234', 10);

    db.prepare(`
      INSERT INTO users (id, email, password_hash, display_name, role, points_balance, email_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(customerId, 'customer@ongo.demo', hash, 'Beach Explorer', 'customer', ts, ts, ts);

    db.prepare(`
      INSERT INTO users (id, email, password_hash, display_name, role, points_balance, email_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(businessUserId, 'business@ongo.demo', hash, "Pete's Bar Manager", 'business', ts, ts, ts);

    const escUserId = uuid();
    db.prepare(`
      INSERT INTO users (id, email, password_hash, display_name, role, points_balance, email_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(escUserId, 'european@ongo.demo', hash, 'European Street Cafe', 'business', ts, ts, ts);

    const { assignProTrial } = require('./subscriptions');
    const { KNOWN_WEBSITES } = require('./logos');

    const claimVenue = (name, userId) => {
      const venue = businessIds.find((b) => b.name === name);
      if (!venue) return;
      const site = KNOWN_WEBSITES[name] || '';
      db.prepare(`
        UPDATE businesses
        SET status = 'participating', claimed_by_user_id = ?, is_directory_only = 0,
            website = CASE WHEN website IS NULL OR website = '' THEN ? ELSE website END,
            updated_at = ?
        WHERE id = ?
      `).run(userId, site, ts, venue.id);
      db.prepare(`
        INSERT INTO business_members (id, business_id, user_id, member_role, created_at)
        VALUES (?, ?, ?, 'owner', ?)
      `).run(uuid(), venue.id, userId, ts);
      assignProTrial(db, venue.id, { now: ts });
    };

    claimVenue("Pete's Bar", businessUserId);
    claimVenue('European Street Cafe', escUserId);

    for (const slot of AD_SLOTS) {
      const start = new Date(Date.now() + slot.hoursAheadStart * 3600 * 1000);
      const end = new Date(start.getTime() + slot.durationHours * 3600 * 1000);
      db.prepare(`
        INSERT INTO ad_inventory (id, zone, category, slot_label, starts_at, ends_at, min_bid_cents, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
      `).run(
        uuid(),
        slot.zone,
        slot.category,
        slot.slot_label,
        start.toISOString(),
        end.toISOString(),
        slot.min_bid_cents,
        ts
      );
    }
  });

  insertMany();
  return { seeded: true, businesses: businessIds.length };
}

/**
 * Idempotent migrate for DBs that seeded before ESC demo + Pro trials existed.
 */
function migrateDemoClaims(db) {
  const bcrypt = require('bcryptjs');
  const { assignProTrial, ensureProTrialsForClaimed } = require('./subscriptions');
  const { KNOWN_WEBSITES } = require('./logos');
  const ts = nowIso();
  const hash = bcrypt.hashSync('demo1234', 10);

  const ensureBizUser = (email, displayName) => {
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      const id = uuid();
      db.prepare(`
        INSERT INTO users (id, email, password_hash, display_name, role, points_balance, email_verified_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'business', 0, ?, ?, ?)
      `).run(id, email, hash, displayName, ts, ts, ts);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      db.dirty = true;
    } else if (!user.email_verified_at) {
      db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?').run(
        ts,
        ts,
        user.id
      );
      db.dirty = true;
    }
    return user;
  };

  const claimIfNeeded = (venueName, email, displayName) => {
    const biz = db.prepare('SELECT * FROM businesses WHERE name = ?').get(venueName);
    if (!biz) return;
    const user = ensureBizUser(email, displayName);
    const site = KNOWN_WEBSITES[venueName] || biz.website || '';
    if (biz.status === 'unclaimed' || biz.is_directory_only) {
      db.prepare(`
        UPDATE businesses
        SET status = 'participating', claimed_by_user_id = ?, is_directory_only = 0,
            website = CASE WHEN website IS NULL OR website = '' THEN ? ELSE website END,
            updated_at = ?
        WHERE id = ?
      `).run(user.id, site, ts, biz.id);
      db.dirty = true;
    } else if (!biz.website && site) {
      db.prepare('UPDATE businesses SET website = ?, updated_at = ? WHERE id = ?').run(site, ts, biz.id);
      db.dirty = true;
    }
    const member = db.prepare(
      'SELECT 1 AS ok FROM business_members WHERE business_id = ? AND user_id = ?'
    ).get(biz.id, user.id);
    if (!member) {
      db.prepare(`
        INSERT INTO business_members (id, business_id, user_id, member_role, created_at)
        VALUES (?, ?, ?, 'owner', ?)
      `).run(uuid(), biz.id, user.id, ts);
      db.dirty = true;
    }
    assignProTrial(db, biz.id, { now: ts });
  };

  claimIfNeeded("Pete's Bar", 'business@ongo.demo', "Pete's Bar Manager");
  claimIfNeeded('European Street Cafe', 'european@ongo.demo', 'European Street Cafe');
  ensureProTrialsForClaimed(db);
}

function expireOffers(db) {
  const ts = nowIso();
  db.prepare(`
    UPDATE offers
    SET status = 'expired', updated_at = ?
    WHERE status IN ('live', 'scheduled', 'paused')
      AND ends_at <= ?
  `).run(ts, ts);

  db.prepare(`
    UPDATE offers
    SET status = 'live', updated_at = ?
    WHERE status = 'scheduled'
      AND paused_at IS NULL
      AND starts_at <= ?
      AND ends_at > ?
  `).run(ts, ts, ts);
}

let lastBlobError = null;
let lastBlobOk = null;

function blobStore() {
  const { getStore } = require('@netlify/blobs');
  // Default eventual consistency — 'strong' needs uncachedEdgeURL which
  // Lambda-compat connectLambda context does not provide.
  return getStore('on-go-data');
}

async function loadBytesFromBlobs() {
  try {
    const store = blobStore();
    const buf = await store.get(BLOB_KEY, { type: 'arrayBuffer' });
    lastBlobError = null;
    lastBlobOk = Boolean(buf);
    if (!buf) return null;
    return new Uint8Array(buf);
  } catch (err) {
    lastBlobError = err.message || String(err);
    lastBlobOk = false;
    console.warn('Blob load failed:', lastBlobError);
    return null;
  }
}

async function saveBytesToBlobs(bytes) {
  try {
    const store = blobStore();
    await store.set(BLOB_KEY, bytes);
    lastBlobError = null;
    lastBlobOk = true;
    return true;
  } catch (err) {
    lastBlobError = err.message || String(err);
    lastBlobOk = false;
    console.warn('Blob persist skipped:', lastBlobError);
    return false;
  }
}

function blobStatus() {
  return {
    ok: lastBlobOk,
    error: lastBlobError,
    key: BLOB_KEY,
    store: 'on-go-data',
  };
}

function loadBytesFromFile() {
  if (!fs.existsSync(DB_PATH)) return null;
  return fs.readFileSync(DB_PATH);
}

function saveBytesToFile(bytes) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(bytes));
}

let persistTimer = null;

function schedulePersist(db) {
  if (!db.dirty) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistNow(db).catch((err) => console.warn('persist failed', err.message));
  }, 50);
}

async function persistNow(db) {
  if (!db || !db.dirty) return;
  const bytes = db.export();
  db.dirty = false;
  if (process.env.NETLIFY || process.env.USE_NETLIFY_BLOBS === '1') {
    const ok = await saveBytesToBlobs(bytes);
    if (!ok) {
      db.dirty = true;
      return;
    }
  }
  try {
    saveBytesToFile(bytes);
  } catch {
    /* read-only FS on some serverless — blobs already saved */
  }
}

/** Persist whatever the current in-memory db holds (used after Netlify request reload). */
async function persistDbBytes(db) {
  return persistNow(db);
}

let sqlJsPromise = null;
async function getSQL() {
  if (!sqlJsPromise) {
    const initSql = require('sql.js/dist/sql-wasm-inline.js');
    sqlJsPromise = initSql();
  }
  return sqlJsPromise;
}

function purgeClosedVenues(db) {
  let removed = 0;
  for (const name of CLOSED_VENUE_NAMES) {
    const rows = db
      .prepare('SELECT id FROM businesses WHERE name = ? OR slug = ?')
      .all(name, slugify(name));
    for (const row of rows) {
      const id = row.id;
      db.prepare('DELETE FROM favorites WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM bids WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM business_members WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM subscriptions WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM redemptions WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM offers WHERE business_id = ?').run(id);
      db.prepare('DELETE FROM businesses WHERE id = ?').run(id);
      db.dirty = true;
      removed += 1;
    }
  }
  return removed;
}

/** Insert any SEED_BUSINESSES missing from an already-seeded DB (idempotent). */
function ensureSeedVenues(db) {
  const ts = nowIso();
  const insertBiz = db.prepare(`
    INSERT INTO businesses (
      id, name, slug, area, category, address, phone, website, hours_json,
      lat, lng, status, claimed_by_user_id, is_directory_only, featured_until, osm_ref, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);
  let added = 0;
  for (const b of SEED_BUSINESSES) {
    const slug = slugify(b.name);
    const existing = db
      .prepare('SELECT id FROM businesses WHERE name = ? OR slug = ?')
      .get(b.name, slug);
    if (existing) continue;
    insertBiz.run(
      uuid(),
      b.name,
      slug,
      b.area,
      b.category,
      b.address || '',
      b.phone || '',
      '',
      b.hours_json || '{}',
      b.lat,
      b.lng,
      'unclaimed',
      null,
      1,
      null,
      b.osm_ref || null,
      ts,
      ts
    );
    db.dirty = true;
    added += 1;
  }
  return added;
}

function applyMigrations(db) {
  ensureSchema(db);
  ensureAuthColumns(db);
  const {
    ensureLogoColumns,
    backfillWebsites,
    applyOfficialLogos,
  } = require('./logos');
  const { ensureProTrialsForClaimed } = require('./subscriptions');
  const { ensureEnrichColumns, applyEnrichmentCache } = require('./enrich');
  const { ensureBetaSchema, expireCampaignsAndLimits } = require('./beta');
  ensureLogoColumns(db);
  ensureEnrichColumns(db);
  ensureBetaSchema(db);
  backfillWebsites(db);
  const seedResult = seedIfEmpty(db);
  ensureSeedVenues(db);
  purgeClosedVenues(db);
  migrateDemoClaims(db);
  ensureProTrialsForClaimed(db);
  recoverOwnerAccounts(db);
  applyEnrichmentCache(db);
  applyOfficialLogos(db);
  // Re-run beta after seed so new venues get qr_token + verified_at
  ensureBetaSchema(db);
  expireOffers(db);
  expireCampaignsAndLimits(db);
  return seedResult;
}

/**
 * Owner accounts Damien reported as broken — ensure they exist, verified,
 * with a known temporary password he can change after login.
 * Bump OWNER_RECOVERY_GEN to re-apply the temp password once (then leave alone).
 */
const OWNER_RECOVERY_GEN = 1;
const OWNER_RECOVERY = [
  {
    email: 'damienstarkey978@gmail.com',
    display_name: 'Damien Starkey',
    role: 'customer',
    tempPassword: 'OngoRecover978!',
  },
  {
    email: 'damien@worldconstructioninc.com',
    display_name: 'Damien WCI',
    role: 'customer',
    tempPassword: 'OngoRecover978!',
  },
];

function ensureAppMeta(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function recoverOwnerAccounts(db) {
  ensureAuthColumns(db);
  ensureAppMeta(db);
  const bcrypt = require('bcryptjs');
  const ts = nowIso();
  const genRow = db.prepare(`SELECT value FROM app_meta WHERE key = 'owner_recovery_gen'`).get();
  const appliedGen = genRow ? Number(genRow.value) || 0 : 0;
  const forcePassword = appliedGen < OWNER_RECOVERY_GEN;

  for (const acct of OWNER_RECOVERY) {
    const email = acct.email.toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const hash = bcrypt.hashSync(acct.tempPassword, 10);
    if (!user) {
      const id = uuid();
      db.prepare(`
        INSERT INTO users (
          id, email, password_hash, display_name, role, points_balance,
          email_verified_at, verify_token, verify_expires, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?)
      `).run(id, email, hash, acct.display_name, acct.role, ts, ts, ts);
      db.dirty = true;
      continue;
    }
    if (!user.email_verified_at || forcePassword) {
      db.prepare(`
        UPDATE users
        SET password_hash = ?,
            display_name = COALESCE(NULLIF(display_name, ''), ?),
            email_verified_at = COALESCE(email_verified_at, ?),
            verify_token = NULL,
            verify_expires = NULL,
            reset_token = NULL,
            reset_expires = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(hash, acct.display_name, ts, ts, user.id);
      db.dirty = true;
    }
  }

  if (forcePassword) {
    db.prepare(`
      INSERT INTO app_meta (key, value, updated_at) VALUES ('owner_recovery_gen', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(OWNER_RECOVERY_GEN), ts);
    db.dirty = true;
  }
}

async function openDb() {
  // Inline WASM build — single JS file, no separate .wasm fetch (Netlify-friendly).
  const SQL = await getSQL();

  let bytes = null;
  let loadedFromBlob = false;
  if (process.env.NETLIFY || process.env.USE_NETLIFY_BLOBS === '1') {
    bytes = await loadBytesFromBlobs();
    loadedFromBlob = Boolean(bytes);
  }
  if (!bytes) bytes = loadBytesFromFile();

  const raw = bytes ? new SQL.Database(bytes) : new SQL.Database();
  const db = wrapDb(raw);
  const seedResult = applyMigrations(db);
  if (db.dirty) await persistNow(db);

  // Fill logos in background (local/dev). On Netlify, directory API resolves logos.
  if (!process.env.NETLIFY) {
    setTimeout(() => {
      const { resolveLogosBatch } = require('./logos');
      const allBiz = db.prepare('SELECT * FROM businesses ORDER BY name ASC').all();
      resolveLogosBatch(db, allBiz, { limit: allBiz.length || 24, concurrency: 4 })
        .then(() => persistNow(db))
        .catch((err) => console.warn('boot logo resolve skipped', err.message));
    }, 0);
  }

  const persist = async () => persistNow(db);
  return {
    db,
    seedResult,
    dbPath: DB_PATH,
    loadedFromBlob,
    schedulePersist,
    persistNow: persist,
  };
}

/**
 * Reload SQLite from Netlify Blobs so concurrent function instances don't
 * overwrite each other with stale in-memory copies.
 */
async function loadDbFromStore() {
  const SQL = await getSQL();
  let bytes = null;
  if (process.env.NETLIFY || process.env.USE_NETLIFY_BLOBS === '1') {
    bytes = await loadBytesFromBlobs();
  }
  if (!bytes) bytes = loadBytesFromFile();
  const raw = bytes ? new SQL.Database(bytes) : new SQL.Database();
  const db = wrapDb(raw);
  const seedResult = applyMigrations(db);
  return { db, seedResult, dbPath: DB_PATH };
}

module.exports = {
  openDb,
  loadDbFromStore,
  persistNow,
  persistDbBytes,
  recoverOwnerAccounts,
  OWNER_RECOVERY,
  OWNER_RECOVERY_GEN,
  expireOffers,
  nowIso,
  uuid,
  haversineMiles,
  DATA_DIR,
  DB_PATH,
  SEED_BUSINESSES,
  ensureAuthColumns,
  blobStatus,
};
