'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const DB_PATH = path.join(DATA_DIR, 'on-go.db');

/** Seed venues — Beaches food & drink with approximate public coordinates. */
const SEED_BUSINESSES = [
  {
    name: "Pete's Bar",
    area: 'Neptune Beach',
    category: 'Bar',
    address: '117 First St, Neptune Beach, FL 32266',
    phone: '',
    lat: 30.3239,
    lng: -81.3984,
    hours_json: JSON.stringify({ mon: '11-2', fri: '11-2', sat: '11-2', sun: '12-2' }),
  },
  {
    name: "Poe's Tavern",
    area: 'Atlantic Beach',
    category: 'Lunch',
    address: '363 Atlantic Blvd, Atlantic Beach, FL 32233',
    lat: 30.3342,
    lng: -81.4091,
    hours_json: JSON.stringify({ daily: '11-10' }),
  },
  {
    name: 'Southern Grounds',
    area: 'Neptune Beach',
    category: 'Coffee',
    address: '200 First St, Neptune Beach, FL 32266',
    lat: 30.3248,
    lng: -81.3972,
    hours_json: JSON.stringify({ daily: '7-6' }),
  },
  {
    name: "Lynch's Irish Pub",
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '514 N First St, Jacksonville Beach, FL 32250',
    lat: 30.2925,
    lng: -81.3918,
    hours_json: JSON.stringify({ daily: '11-2' }),
  },
  {
    name: 'TacoLu',
    area: 'Jacksonville Beach',
    category: 'Dinner',
    address: '1712 Beach Blvd, Jacksonville Beach, FL 32250',
    lat: 30.2868,
    lng: -81.4055,
    hours_json: JSON.stringify({ daily: '11-10' }),
  },
  {
    name: "Cinotti's Bakery",
    area: 'Jacksonville Beach',
    category: 'Breakfast',
    address: '1505 Third St S, Jacksonville Beach, FL 32250',
    lat: 30.2745,
    lng: -81.3902,
    hours_json: JSON.stringify({ daily: '6-6' }),
  },
  {
    name: 'North Beach Fish Camp',
    area: 'Neptune Beach',
    category: 'Dinner',
    address: '200 First St, Neptune Beach, FL 32266',
    lat: 30.3255,
    lng: -81.3965,
    hours_json: JSON.stringify({ daily: '11-10' }),
  },
  {
    name: 'Flying Iguana',
    area: 'Neptune Beach',
    category: 'Dinner',
    address: '200 Third St, Neptune Beach, FL 32266',
    lat: 30.3221,
    lng: -81.3958,
    hours_json: JSON.stringify({ daily: '11-10' }),
  },
  {
    name: 'Marker 32',
    area: 'Jacksonville Beach',
    category: 'Dinner',
    address: '1 Beach Blvd, Jacksonville Beach, FL 32250',
    lat: 30.2912,
    lng: -81.3895,
    hours_json: JSON.stringify({ tue_sun: '5-10' }),
  },
  {
    name: 'Valley Smoke',
    area: 'Ponte Vedra Beach',
    category: 'Dinner',
    address: '100 Corridor Pkwy, Ponte Vedra Beach, FL 32082',
    lat: 30.2085,
    lng: -81.3872,
    hours_json: JSON.stringify({ daily: '11-9' }),
  },
  {
    name: "Pusser's Bar and Grille",
    area: 'Ponte Vedra Beach',
    category: 'Bar',
    address: '200 Ponte Vedra Blvd, Ponte Vedra Beach, FL 32082',
    lat: 30.2358,
    lng: -81.3805,
    hours_json: JSON.stringify({ daily: '11-11' }),
  },
  {
    name: 'Ragtime Tavern',
    area: 'Atlantic Beach',
    category: 'Bar',
    address: '207 Atlantic Blvd, Atlantic Beach, FL 32233',
    lat: 30.3348,
    lng: -81.4078,
    hours_json: JSON.stringify({ daily: '11-1' }),
  },
  {
    name: 'Java Beach Cafe',
    area: 'Jacksonville Beach',
    category: 'Coffee',
    address: '1437 Beach Blvd, Jacksonville Beach, FL 32250',
    lat: 30.2881,
    lng: -81.4022,
    hours_json: JSON.stringify({ daily: '7-3' }),
  },
  {
    name: 'Beachside Seafood Market',
    area: 'Atlantic Beach',
    category: 'Lunch',
    address: '15 Ocean Blvd, Atlantic Beach, FL 32233',
    lat: 30.3321,
    lng: -81.3955,
    hours_json: JSON.stringify({ daily: '11-8' }),
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
      claimed_by_user_id TEXT REFERENCES users(id),
      is_directory_only INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_businesses_area ON businesses(area);
    CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(category);
    CREATE INDEX IF NOT EXISTS idx_businesses_status ON businesses(status);

    CREATE TABLE IF NOT EXISTS business_members (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      member_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(business_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      product_label TEXT,
      status TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      redemption_limit INTEGER,
      redemption_count INTEGER NOT NULL DEFAULT 0,
      points_reward INTEGER NOT NULL DEFAULT 25,
      created_by_user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_offers_live ON offers(status, starts_at, ends_at);

    CREATE TABLE IF NOT EXISTS redemptions (
      id TEXT PRIMARY KEY,
      offer_id TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      redeemed_at TEXT,
      redeemed_by_user_id TEXT REFERENCES users(id),
      points_awarded INTEGER NOT NULL DEFAULT 0,
      UNIQUE(offer_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS loyalty_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      redemption_id TEXT REFERENCES redemptions(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
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
      inventory_id TEXT NOT NULL REFERENCES ad_inventory(id) ON DELETE CASCADE,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'simulated',
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
      lat, lng, status, claimed_by_user_id, is_directory_only, created_at, updated_at
    ) VALUES (
      @id, @name, @slug, @area, @category, @address, @phone, @website, @hours_json,
      @lat, @lng, @status, @claimed_by_user_id, @is_directory_only, @created_at, @updated_at
    )
  `);

  const businessIds = [];
  const insertMany = db.transaction(() => {
    for (const b of SEED_BUSINESSES) {
      const id = uuid();
      businessIds.push({ id, name: b.name });
      insertBiz.run({
        id,
        name: b.name,
        slug: slugify(b.name),
        area: b.area,
        category: b.category,
        address: b.address || '',
        phone: b.phone || '',
        website: '',
        hours_json: b.hours_json || '{}',
        lat: b.lat,
        lng: b.lng,
        status: 'unclaimed',
        claimed_by_user_id: null,
        is_directory_only: 1,
        created_at: ts,
        updated_at: ts,
      });
    }

    const customerId = uuid();
    const businessUserId = uuid();
    const hash = bcrypt.hashSync('demo1234', 10);

    db.prepare(`
      INSERT INTO users (id, email, password_hash, display_name, role, points_balance, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(customerId, 'customer@ongo.demo', hash, 'Beach Explorer', 'customer', ts, ts);

    db.prepare(`
      INSERT INTO users (id, email, password_hash, display_name, role, points_balance, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(businessUserId, 'business@ongo.demo', hash, "Pete's Bar Manager", 'business', ts, ts);

    // Claim Pete's Bar for the demo business account
    const petes = businessIds.find((b) => b.name === "Pete's Bar");
    if (petes) {
      db.prepare(`
        UPDATE businesses
        SET status = 'participating', claimed_by_user_id = ?, is_directory_only = 0, updated_at = ?
        WHERE id = ?
      `).run(businessUserId, ts, petes.id);

      db.prepare(`
        INSERT INTO business_members (id, business_id, user_id, member_role, created_at)
        VALUES (?, ?, ?, 'owner', ?)
      `).run(uuid(), petes.id, businessUserId, ts);
    }

    const insertAd = db.prepare(`
      INSERT INTO ad_inventory (id, zone, category, slot_label, starts_at, ends_at, min_bid_cents, status, created_at)
      VALUES (@id, @zone, @category, @slot_label, @starts_at, @ends_at, @min_bid_cents, 'open', @created_at)
    `);

    for (const slot of AD_SLOTS) {
      const start = new Date(Date.now() + slot.hoursAheadStart * 3600 * 1000);
      const end = new Date(start.getTime() + slot.durationHours * 3600 * 1000);
      insertAd.run({
        id: uuid(),
        zone: slot.zone,
        category: slot.category,
        slot_label: slot.slot_label,
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        min_bid_cents: slot.min_bid_cents,
        created_at: ts,
      });
    }
  });

  insertMany();
  return { seeded: true, businesses: businessIds.length };
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

function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  ensureSchema(db);
  const seedResult = seedIfEmpty(db);
  expireOffers(db);
  return { db, seedResult, dbPath: DB_PATH };
}

module.exports = {
  openDb,
  expireOffers,
  nowIso,
  uuid,
  DATA_DIR,
  DB_PATH,
  SEED_BUSINESSES,
};
