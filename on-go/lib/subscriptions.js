'use strict';

const { v4: uuid } = require('uuid');

/** Claimed venues get full Pro features during trial — no paywall. */
const PRO_TRIAL_DAYS = Number(process.env.ONGO_PRO_TRIAL_DAYS || 60);

/** Mirror of billing.isBillingEnabled — kept local to avoid circular require. */
function isBillingEnabled() {
  const v = String(process.env.ONGO_BILLING_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function trialEndsAt(from = new Date()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + PRO_TRIAL_DAYS);
  return d.toISOString();
}

function isProEntitled(sub) {
  if (!sub) return false;
  if (sub.plan !== 'pro') return false;
  // Paid Stripe row (subscription_status) — active / trialing
  const stripeStatus = sub.subscription_status;
  if (stripeStatus === 'active' || stripeStatus === 'trialing') {
    if (sub.current_period_end && Date.parse(sub.current_period_end) < Date.now()) {
      // Period ended and Stripe has not refreshed — fall through to local status
    } else {
      return true;
    }
  }
  if (sub.status !== 'trial' && sub.status !== 'active') return false;
  if (sub.ends_at && Date.parse(sub.ends_at) < Date.now()) return false;
  // past_due / canceled from Stripe should not count as active even if plan=pro
  if (stripeStatus === 'past_due' || stripeStatus === 'canceled' || stripeStatus === 'unpaid') {
    return false;
  }
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
      billing_enabled: isBillingEnabled(),
    };
  }
  const trial = sub.status === 'trial' || Boolean(sub.trial);
  const entitled = isProEntitled(sub);
  let label = sub.plan === 'pro' ? 'Pro' : sub.plan === 'starter' ? 'Starter' : 'Directory';
  if (sub.plan === 'pro' && trial) label = 'Pro · Free trial';
  if (sub.plan === 'pro' && sub.status === 'active' && sub.stripe_subscription_id) {
    label = 'Pro · Paid';
  }
  if (!isBillingEnabled() && sub.plan === 'pro' && entitled) {
    label = trial ? 'Pro · Free trial' : 'Pro (beta — billing coming soon)';
  }
  return {
    ...sub,
    trial,
    entitled_pro: entitled,
    label,
    trial_days: PRO_TRIAL_DAYS,
    billing_enabled: isBillingEnabled(),
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
 *
 * When ONGO_BILLING_ENABLED is false (default): re-grant Pro trial so every
 * claimed venue stays fully unlocked (beta).
 * When true: only grant a first trial if the venue has no subscription row;
 * never refresh an expired trial — they must subscribe via Stripe.
 */
function ensureProTrialsForClaimed(db) {
  const now = new Date().toISOString();
  const billingOn = isBillingEnabled();
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
    if (isProEntitled(sub)) continue;

    if (!billingOn) {
      assignProTrial(db, b.id, { now });
      updated += 1;
      continue;
    }

    // Billing on: first-time claimed venues without any row still get a trial.
    // Expired / canceled / past_due rows are NOT refreshed.
    if (!sub) {
      assignProTrial(db, b.id, { now });
      updated += 1;
    }
  }
  return {
    claimed: claimed.length,
    updated,
    trial_days: PRO_TRIAL_DAYS,
    billing_enabled: billingOn,
  };
}

module.exports = {
  PRO_TRIAL_DAYS,
  trialEndsAt,
  isProEntitled,
  formatSubscription,
  assignProTrial,
  ensureProTrialsForClaimed,
  isBillingEnabled,
};
