'use strict';

const { v4: uuid } = require('uuid');

/** Claimed venues get full Pro features during trial — no paywall. */
const PRO_TRIAL_DAYS = Number(process.env.ONGO_PRO_TRIAL_DAYS || 60);

function trialEndsAt(from = new Date()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + PRO_TRIAL_DAYS);
  return d.toISOString();
}

function isProEntitled(sub) {
  if (!sub) return false;
  if (sub.plan !== 'pro') return false;
  if (sub.status !== 'trial' && sub.status !== 'active') return false;
  if (sub.ends_at && Date.parse(sub.ends_at) < Date.now()) return false;
  return true;
}

function formatSubscription(sub) {
  if (!sub) {
    return {
      plan: 'free',
      status: 'none',
      trial: false,
      entitled_pro: false,
      label: 'Directory',
      ends_at: null,
    };
  }
  const trial = sub.status === 'trial' || Boolean(sub.trial);
  const entitled = isProEntitled(sub);
  let label = sub.plan === 'pro' ? 'Pro' : sub.plan === 'starter' ? 'Starter' : 'Directory';
  if (sub.plan === 'pro' && trial) label = 'Pro · Free trial';
  return {
    ...sub,
    trial,
    entitled_pro: entitled,
    label,
    trial_days: PRO_TRIAL_DAYS,
  };
}

function assignProTrial(db, businessId, { now = new Date().toISOString() } = {}) {
  const ends = trialEndsAt(now);
  // End any open non-pro rows so latest subscription wins
  db.prepare(`
    UPDATE subscriptions
    SET ends_at = COALESCE(ends_at, ?), status = CASE WHEN status = 'active' THEN 'superseded' ELSE status END
    WHERE business_id = ? AND plan != 'pro'
  `).run(now, businessId);

  const existing = db.prepare(`
    SELECT * FROM subscriptions
    WHERE business_id = ? AND plan = 'pro'
    ORDER BY created_at DESC LIMIT 1
  `).get(businessId);

  if (existing && isProEntitled(existing)) {
    return existing;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO subscriptions (id, business_id, plan, status, starts_at, ends_at, created_at)
    VALUES (?, ?, 'pro', 'trial', ?, ?, ?)
  `).run(id, businessId, now, ends, now);
  db.dirty = true;
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
}

/**
 * Ensure every participating/claimed venue has an active Pro trial.
 * Unclaimed directory listings are left alone.
 */
function ensureProTrialsForClaimed(db) {
  const now = new Date().toISOString();
  const claimed = db.prepare(`
    SELECT id, name, status FROM businesses
    WHERE status IN ('participating', 'claimed') OR is_directory_only = 0
  `).all();
  let updated = 0;
  for (const b of claimed) {
    // Skip pure unclaimed safety
    if (b.status === 'unclaimed') continue;
    const sub = db.prepare(`
      SELECT * FROM subscriptions WHERE business_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(b.id);
    if (!isProEntitled(sub)) {
      assignProTrial(db, b.id, { now });
      updated += 1;
    }
  }
  return { claimed: claimed.length, updated, trial_days: PRO_TRIAL_DAYS };
}

module.exports = {
  PRO_TRIAL_DAYS,
  trialEndsAt,
  isProEntitled,
  formatSubscription,
  assignProTrial,
  ensureProTrialsForClaimed,
};
