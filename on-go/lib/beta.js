'use strict';

/**
 * Beta checklist foundation: venue QR visits, rewards catalog, audit trail.
 * Provisional defaults — see docs/beta-gap-analysis.md
 */

const crypto = require('crypto');
const { v4: uuid } = require('uuid');

const VISIT_RADIUS_METERS = Number(process.env.ONGO_VISIT_RADIUS_METERS || 150);
const VISIT_ACCURACY_MAX_M = Number(process.env.ONGO_VISIT_ACCURACY_MAX_M || 100);
const DEFAULT_POINTS_PER_VISIT = Number(process.env.ONGO_POINTS_PER_VISIT || 50);
const DEFAULT_VISIT_LIMIT = Number(process.env.ONGO_CAMPAIGN_VISIT_LIMIT || 100);
/** Stripe billing stays off for beta — all venues Pro. */
const BILLING_ENABLED = String(process.env.ONGO_BILLING_ENABLED || '').toLowerCase() === 'true';

function nowIso() {
  return new Date().toISOString();
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function randomCode(len = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function venueQrPayload(qrToken) {
  return `ongo:venue:${qrToken}`;
}

function parseVenueQr(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    const v = u.searchParams.get('v') || u.searchParams.get('venue');
    if (v) return v;
    const m = u.pathname.match(/\/scan\/([^/]+)/i);
    if (m) return m[1];
  } catch {
    /* not a URL */
  }
  if (s.startsWith('ongo:venue:')) return s.slice('ongo:venue:'.length);
  if (s.startsWith('venue:')) return s.slice('venue:'.length);
  // bare token (uuid-ish)
  if (/^[a-zA-Z0-9_-]{8,64}$/.test(s)) return s;
  return null;
}

function tableHasColumn(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  return cols.includes(column);
}

function addColumnIfMissing(db, table, column, ddl) {
  if (!tableHasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function ensureBetaSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qualifying_visits (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      offer_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy_m REAL,
      distance_m REAL NOT NULL,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(offer_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS rewards (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      terms TEXT,
      points_cost INTEGER NOT NULL,
      quantity_total INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL,
      expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reward_redemptions (
      id TEXT PRIMARY KEY,
      reward_id TEXT NOT NULL,
      business_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      points_spent INTEGER NOT NULL,
      status TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      fulfilled_at TEXT,
      fulfilled_by_user_id TEXT,
      cancelled_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      reason TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_views (
      id TEXT PRIMARY KEY,
      offer_id TEXT NOT NULL,
      business_id TEXT NOT NULL,
      viewer_user_id TEXT,
      created_at TEXT NOT NULL
    );
  `);

  addColumnIfMissing(db, 'businesses', 'qr_token', 'qr_token TEXT');
  addColumnIfMissing(db, 'businesses', 'verified_at', 'verified_at TEXT');
  addColumnIfMissing(db, 'businesses', 'suspended_at', 'suspended_at TEXT');
  addColumnIfMissing(db, 'businesses', 'suspend_reason', 'suspend_reason TEXT');

  addColumnIfMissing(db, 'offers', 'terms', 'terms TEXT');
  addColumnIfMissing(db, 'offers', 'photo_url', 'photo_url TEXT');
  addColumnIfMissing(db, 'offers', 'paused_at', 'paused_at TEXT');
  addColumnIfMissing(db, 'offers', 'views_count', 'views_count INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'offers', 'visits_count', 'visits_count INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'offers', 'points_awarded_total', 'points_awarded_total INTEGER NOT NULL DEFAULT 0');

  addColumnIfMissing(db, 'users', 'suspended_at', 'suspended_at TEXT');
  addColumnIfMissing(db, 'users', 'display_name', 'display_name TEXT');

  addColumnIfMissing(db, 'loyalty_ledger', 'offer_id', 'offer_id TEXT');
  addColumnIfMissing(db, 'loyalty_ledger', 'visit_id', 'visit_id TEXT');
  addColumnIfMissing(db, 'loyalty_ledger', 'reward_redemption_id', 'reward_redemption_id TEXT');
  addColumnIfMissing(db, 'loyalty_ledger', 'kind', 'kind TEXT');

  // Ensure every venue has a stable QR token; auto-verify participating seed venues for beta.
  const businesses = db.prepare('SELECT id, qr_token, status, verified_at FROM businesses').all();
  const ts = nowIso();
  for (const b of businesses) {
    if (!b.qr_token) {
      const token = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE businesses SET qr_token = ? WHERE id = ?').run(token, b.id);
    }
    if (!b.verified_at && (b.status === 'participating' || b.status === 'claimed')) {
      db.prepare('UPDATE businesses SET verified_at = COALESCE(verified_at, ?) WHERE id = ?').run(ts, b.id);
    }
  }

  // Demo admin for beta proof (local / Netlify demo)
  const adminEmail = 'admin@ongo.demo';
  const admin = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!admin) {
    const bcrypt = require('bcryptjs');
    db.prepare(`
      INSERT INTO users (id, email, password_hash, display_name, role, points_balance, email_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'admin', 0, ?, ?, ?)
    `).run(uuid(), adminEmail, bcrypt.hashSync('demo1234', 10), 'ON GO Admin', ts, ts, ts);
  }

  // Unique index on qr_token when present
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_qr_token ON businesses(qr_token)');
  } catch {
    /* ignore if duplicates somehow exist */
  }
}

function writeAudit(db, { actorUserId, action, entityType, entityId, reason, meta }) {
  db.prepare(`
    INSERT INTO audit_log (id, actor_user_id, action, entity_type, entity_id, reason, meta_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(),
    actorUserId || null,
    action,
    entityType,
    entityId || null,
    reason || null,
    meta ? JSON.stringify(meta) : null,
    nowIso()
  );
  db.dirty = true;
}

function activeCampaignForBusiness(db, businessId, now = nowIso()) {
  return db.prepare(`
    SELECT * FROM offers
    WHERE business_id = ?
      AND status = 'live'
      AND paused_at IS NULL
      AND starts_at <= ?
      AND ends_at > ?
    ORDER BY starts_at DESC
    LIMIT 1
  `).get(businessId, now, now);
}

function expireCampaignsAndLimits(db) {
  const now = nowIso();
  db.prepare(`
    UPDATE offers
    SET status = 'expired', updated_at = ?
    WHERE status IN ('live', 'scheduled', 'paused')
      AND ends_at <= ?
  `).run(now, now);

  // Visit / reward limit reached → end
  const live = db.prepare(`
    SELECT * FROM offers WHERE status = 'live' AND redemption_limit IS NOT NULL
  `).all();
  for (const o of live) {
    const visits = o.visits_count != null
      ? o.visits_count
      : db.prepare('SELECT COUNT(*) AS n FROM qualifying_visits WHERE offer_id = ?').get(o.id).n;
    if (visits >= o.redemption_limit) {
      db.prepare(`UPDATE offers SET status = 'expired', updated_at = ? WHERE id = ?`).run(now, o.id);
      writeAudit(db, {
        action: 'campaign_auto_end_limit',
        entityType: 'offer',
        entityId: o.id,
        reason: 'Visit limit reached',
        meta: { visits, limit: o.redemption_limit },
      });
    }
  }
}

/**
 * Award a qualifying visit. Never awards from QR payload alone —
 * caller must supply GPS; this validates radius + accuracy + once-per-campaign.
 */
function awardQualifyingVisit(db, {
  user,
  business,
  offer,
  lat,
  lng,
  accuracyM,
  actorUserId,
}) {
  const now = nowIso();
  if (!user || user.role !== 'customer') {
    return { ok: false, status: 403, error: 'Sign in as a member to earn visit points' };
  }
  if (user.suspended_at) {
    return { ok: false, status: 403, error: 'Account suspended' };
  }
  if (business.suspended_at) {
    return { ok: false, status: 403, error: 'Venue suspended' };
  }
  if (!offer || offer.status !== 'live' || offer.paused_at) {
    return { ok: false, status: 400, error: 'No live campaign at this venue' };
  }
  if (offer.starts_at > now || offer.ends_at <= now) {
    return { ok: false, status: 400, error: 'Campaign is not active' };
  }

  const accuracy = accuracyM == null ? null : Number(accuracyM);
  if (accuracy == null || Number.isNaN(accuracy)) {
    return { ok: false, status: 400, error: 'Location accuracy required — enable precise GPS and retry' };
  }
  if (accuracy > VISIT_ACCURACY_MAX_M) {
    return {
      ok: false,
      status: 400,
      error: `Location too inaccurate (${Math.round(accuracy)}m). Need ≤ ${VISIT_ACCURACY_MAX_M}m — move outdoors and retry.`,
      code: 'accuracy',
    };
  }

  const latN = Number(lat);
  const lngN = Number(lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
    return { ok: false, status: 400, error: 'Fresh GPS location required' };
  }

  const distanceM = haversineMeters(latN, lngN, business.lat, business.lng);
  if (distanceM > VISIT_RADIUS_METERS) {
    return {
      ok: false,
      status: 400,
      error: `You're ${Math.round(distanceM)}m from the venue — need to be within ${VISIT_RADIUS_METERS}m.`,
      code: 'distance',
      distance_m: Math.round(distanceM),
      radius_m: VISIT_RADIUS_METERS,
    };
  }

  const existing = db.prepare(
    'SELECT * FROM qualifying_visits WHERE offer_id = ? AND user_id = ?'
  ).get(offer.id, user.id);
  if (existing) {
    return {
      ok: false,
      status: 409,
      error: 'Visit points already awarded for this campaign',
      code: 'already_visited',
      visit: existing,
    };
  }

  const limit = offer.redemption_limit;
  const visitsCount = offer.visits_count || 0;
  if (limit != null && visitsCount >= limit) {
    return { ok: false, status: 400, error: 'Campaign visit limit reached' };
  }

  const points = offer.points_reward != null ? offer.points_reward : DEFAULT_POINTS_PER_VISIT;
  const visitId = uuid();
  const ledgerId = uuid();

  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO qualifying_visits (
          id, business_id, offer_id, user_id, lat, lng, accuracy_m, distance_m, points_awarded, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(visitId, business.id, offer.id, user.id, latN, lngN, accuracy, distanceM, points, now);

      db.prepare(`
        UPDATE users SET points_balance = points_balance + ?, updated_at = ? WHERE id = ?
      `).run(points, now, user.id);

      db.prepare(`
        INSERT INTO loyalty_ledger (id, user_id, delta, reason, redemption_id, created_at, offer_id, visit_id, kind)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'qualifying_visit')
      `).run(
        ledgerId,
        user.id,
        points,
        `Qualifying visit · ${business.name}`,
        now,
        offer.id,
        visitId
      );

      db.prepare(`
        UPDATE offers
        SET visits_count = COALESCE(visits_count, 0) + 1,
            points_awarded_total = COALESCE(points_awarded_total, 0) + ?,
            redemption_count = COALESCE(redemption_count, 0) + 1,
            updated_at = ?,
            status = CASE
              WHEN redemption_limit IS NOT NULL AND COALESCE(visits_count, 0) + 1 >= redemption_limit
              THEN 'expired' ELSE status END
        WHERE id = ?
      `).run(points, now, offer.id);
    })();
  } catch (err) {
    if (String(err.message || err).includes('UNIQUE')) {
      return {
        ok: false,
        status: 409,
        error: 'Visit points already awarded for this campaign',
        code: 'already_visited',
      };
    }
    throw err;
  }

  writeAudit(db, {
    actorUserId: actorUserId || user.id,
    action: 'qualifying_visit_awarded',
    entityType: 'qualifying_visit',
    entityId: visitId,
    reason: 'In-app venue QR + GPS verified',
    meta: {
      offer_id: offer.id,
      business_id: business.id,
      points,
      distance_m: Math.round(distanceM),
      accuracy_m: accuracy,
    },
  });

  const updatedUser = db.prepare('SELECT points_balance FROM users WHERE id = ?').get(user.id);
  const visit = db.prepare('SELECT * FROM qualifying_visits WHERE id = ?').get(visitId);

  return {
    ok: true,
    visit,
    points_awarded: points,
    points_balance: updatedUser.points_balance,
    distance_m: Math.round(distanceM),
    radius_m: VISIT_RADIUS_METERS,
    message: 'Qualifying visit recorded. Points are promotional rewards, not cash.',
  };
}

function claimReward(db, { user, reward }) {
  const now = nowIso();
  if (!user || user.role !== 'customer') {
    return { ok: false, status: 403, error: 'Sign in as a member to redeem rewards' };
  }
  if (user.suspended_at) {
    return { ok: false, status: 403, error: 'Account suspended' };
  }
  if (!reward || reward.status !== 'active') {
    return { ok: false, status: 400, error: 'Reward not available' };
  }
  if (reward.expires_at && reward.expires_at <= now) {
    return { ok: false, status: 400, error: 'Reward expired' };
  }
  if (reward.quantity_remaining <= 0) {
    return { ok: false, status: 400, error: 'Reward sold out' };
  }
  if (user.points_balance < reward.points_cost) {
    return { ok: false, status: 400, error: 'Not enough points' };
  }

  const id = uuid();
  const code = randomCode(8);
  const ledgerId = uuid();

  try {
    db.transaction(() => {
      const locked = db.prepare('SELECT * FROM rewards WHERE id = ?').get(reward.id);
      if (!locked || locked.quantity_remaining <= 0) {
        throw Object.assign(new Error('Reward sold out'), { status: 400 });
      }
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (u.points_balance < locked.points_cost) {
        throw Object.assign(new Error('Not enough points'), { status: 400 });
      }

      db.prepare(`
        UPDATE rewards
        SET quantity_remaining = quantity_remaining - 1, updated_at = ?
        WHERE id = ? AND quantity_remaining > 0
      `).run(now, locked.id);

      db.prepare(`
        UPDATE users SET points_balance = points_balance - ?, updated_at = ? WHERE id = ?
      `).run(locked.points_cost, now, user.id);

      db.prepare(`
        INSERT INTO reward_redemptions (
          id, reward_id, business_id, user_id, code, points_spent, status, claimed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?)
      `).run(id, locked.id, locked.business_id, user.id, code, locked.points_cost, now, now);

      db.prepare(`
        INSERT INTO loyalty_ledger (id, user_id, delta, reason, redemption_id, created_at, reward_redemption_id, kind)
        VALUES (?, ?, ?, ?, NULL, ?, ?, 'reward_claim')
      `).run(
        ledgerId,
        user.id,
        -locked.points_cost,
        `Claimed reward · ${locked.title}`,
        now,
        id
      );
    })();
  } catch (err) {
    return { ok: false, status: err.status || 500, error: err.message || 'Claim failed' };
  }

  writeAudit(db, {
    actorUserId: user.id,
    action: 'reward_claimed',
    entityType: 'reward_redemption',
    entityId: id,
    meta: { reward_id: reward.id, points: reward.points_cost },
  });

  const redemption = db.prepare('SELECT * FROM reward_redemptions WHERE id = ?').get(id);
  const balance = db.prepare('SELECT points_balance FROM users WHERE id = ?').get(user.id).points_balance;
  return {
    ok: true,
    redemption,
    code,
    points_balance: balance,
    message: 'Show this code at the venue. Single-use. Points are not cash.',
  };
}

function fulfillRewardCode(db, { user, code, businessIds }) {
  const now = nowIso();
  let c = String(code || '').trim().toUpperCase();
  if (c.startsWith('ONGO:')) c = c.slice(5);
  if (!c) return { ok: false, status: 400, error: 'Code required' };

  const redemption = db.prepare('SELECT * FROM reward_redemptions WHERE code = ?').get(c);
  if (!redemption) return { ok: false, status: 404, error: 'Unknown code' };
  if (redemption.status === 'fulfilled') {
    return { ok: false, status: 409, error: 'Already fulfilled — no double redeem' };
  }
  if (redemption.status === 'cancelled') {
    return { ok: false, status: 400, error: 'Redemption cancelled' };
  }
  if (user.role !== 'admin' && !(businessIds || []).includes(redemption.business_id)) {
    return { ok: false, status: 403, error: 'This code belongs to another venue' };
  }

  db.prepare(`
    UPDATE reward_redemptions
    SET status = 'fulfilled', fulfilled_at = ?, fulfilled_by_user_id = ?
    WHERE id = ? AND status = 'claimed'
  `).run(now, user.id, redemption.id);

  writeAudit(db, {
    actorUserId: user.id,
    action: 'reward_fulfilled',
    entityType: 'reward_redemption',
    entityId: redemption.id,
  });

  return {
    ok: true,
    redemption: db.prepare('SELECT * FROM reward_redemptions WHERE id = ?').get(redemption.id),
    message: 'Reward fulfilled once. Thank the member — points are promotional, not cash.',
  };
}

function cancelRewardRedemption(db, { user, redemptionId, businessIds }) {
  const now = nowIso();
  const redemption = db.prepare('SELECT * FROM reward_redemptions WHERE id = ?').get(redemptionId);
  if (!redemption) return { ok: false, status: 404, error: 'Not found' };
  if (redemption.status !== 'claimed') {
    return { ok: false, status: 400, error: 'Only unclaimed (reserved) codes can be cancelled' };
  }
  if (user.role !== 'admin' && user.id !== redemption.user_id &&
      !(businessIds || []).includes(redemption.business_id)) {
    return { ok: false, status: 403, error: 'Not allowed' };
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE reward_redemptions SET status = 'cancelled', cancelled_at = ? WHERE id = ?
    `).run(now, redemption.id);
    db.prepare(`
      UPDATE rewards SET quantity_remaining = quantity_remaining + 1, updated_at = ? WHERE id = ?
    `).run(now, redemption.reward_id);
    db.prepare(`
      UPDATE users SET points_balance = points_balance + ?, updated_at = ? WHERE id = ?
    `).run(redemption.points_spent, now, redemption.user_id);
    db.prepare(`
      INSERT INTO loyalty_ledger (id, user_id, delta, reason, created_at, reward_redemption_id, kind)
      VALUES (?, ?, ?, ?, ?, ?, 'reward_cancel')
    `).run(
      uuid(),
      redemption.user_id,
      redemption.points_spent,
      'Reward cancelled — points restored',
      now,
      redemption.id
    );
  })();

  writeAudit(db, {
    actorUserId: user.id,
    action: 'reward_cancelled',
    entityType: 'reward_redemption',
    entityId: redemption.id,
    reason: 'Restore points + inventory',
  });

  return { ok: true, message: 'Cancelled — points and inventory restored' };
}

function adjustPoints(db, { adminUser, targetUserId, delta, reason }) {
  const now = nowIso();
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) {
    return { ok: false, status: 400, error: 'Non-zero delta required' };
  }
  if (!reason || String(reason).trim().length < 3) {
    return { ok: false, status: 400, error: 'Reason required' };
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
  if (!target) return { ok: false, status: 404, error: 'User not found' };

  db.transaction(() => {
    db.prepare('UPDATE users SET points_balance = points_balance + ?, updated_at = ? WHERE id = ?')
      .run(d, now, target.id);
    db.prepare(`
      INSERT INTO loyalty_ledger (id, user_id, delta, reason, created_at, kind)
      VALUES (?, ?, ?, ?, ?, 'admin_adjust')
    `).run(uuid(), target.id, d, String(reason).trim(), now);
  })();

  writeAudit(db, {
    actorUserId: adminUser.id,
    action: 'points_adjust',
    entityType: 'user',
    entityId: target.id,
    reason: String(reason).trim(),
    meta: { delta: d },
  });

  const balance = db.prepare('SELECT points_balance FROM users WHERE id = ?').get(target.id).points_balance;
  return { ok: true, points_balance: balance };
}

function betaDefaults() {
  return {
    points_per_visit: DEFAULT_POINTS_PER_VISIT,
    visit_radius_meters: VISIT_RADIUS_METERS,
    visit_accuracy_max_m: VISIT_ACCURACY_MAX_M,
    campaign_visit_limit: DEFAULT_VISIT_LIMIT,
    billing_enabled: BILLING_ENABLED,
    rewards_funding: 'vendor',
    points_are_cash: false,
    note: 'Provisional beta defaults — Damien can lock finals before launch.',
  };
}

module.exports = {
  VISIT_RADIUS_METERS,
  VISIT_ACCURACY_MAX_M,
  DEFAULT_POINTS_PER_VISIT,
  DEFAULT_VISIT_LIMIT,
  BILLING_ENABLED,
  ensureBetaSchema,
  writeAudit,
  activeCampaignForBusiness,
  expireCampaignsAndLimits,
  awardQualifyingVisit,
  claimReward,
  fulfillRewardCode,
  cancelRewardRedemption,
  adjustPoints,
  venueQrPayload,
  parseVenueQr,
  haversineMeters,
  randomCode,
  betaDefaults,
  nowIso,
};
