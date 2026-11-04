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
    name: "Fly's Tie Irish Pub",
    area: 'Atlantic Beach',
    category: 'Bar',
    address: '177 Sailfish Drive East, Atlantic Beach, FL 32233',
    lat: 30.3257705,
    lng: -81.4068543,
    hours_json: JSON.stringify({ daily: '11-2' }),
    osm_ref: 'overpass:flys-tie',
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
];

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
      raw.exec(sql);
      api.dirty = true;
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
          api.dirty = true;
          return { changes: raw.getRowsModified() };
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
    WHERE status IN ('live', 'scheduled')
      AND ends_at <= ?
  `).run(ts, ts);

  db.prepare(`
    UPDATE offers
    SET status = 'live', updated_at = ?
    WHERE status = 'scheduled'
      AND starts_at <= ?
      AND ends_at > ?
  `).run(ts, ts, ts);
}

async function loadBytesFromBlobs() {
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('on-go-data');
    const buf = await store.get(BLOB_KEY, { type: 'arrayBuffer' });
    if (!buf) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function saveBytesToBlobs(bytes) {
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('on-go-data');
    await store.set(BLOB_KEY, bytes);
    return true;
  } catch (err) {
    console.warn('Blob persist skipped:', err.message);
    return false;
  }
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

function applyMigrations(db) {
  ensureSchema(db);
  ensureAuthColumns(db);
  const {
    ensureLogoColumns,
    backfillWebsites,
  } = require('./logos');
  const { ensureProTrialsForClaimed } = require('./subscriptions');
  const { ensureEnrichColumns, applyEnrichmentCache } = require('./enrich');
  ensureLogoColumns(db);
  ensureEnrichColumns(db);
  backfillWebsites(db);
  const seedResult = seedIfEmpty(db);
  migrateDemoClaims(db);
  ensureProTrialsForClaimed(db);
  recoverOwnerAccounts(db);
  applyEnrichmentCache(db);
  expireOffers(db);
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
};
