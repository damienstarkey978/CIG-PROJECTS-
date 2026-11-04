'use strict';

/**
 * Stripe Billing for ON GO Pro (business subscriptions).
 *
 * When ONGO_BILLING_ENABLED is unset/false, this module is inert for paywalls —
 * claimed venues stay on free-trial Pro via lib/subscriptions.js.
 * When true, Checkout + Customer Portal + webhooks drive paid Pro.
 */

const Stripe = require('stripe');
const { v4: uuid } = require('uuid');
const { nowIso, ensureBillingColumns } = require('./db');
const { isProEntitled, formatSubscription, PRO_TRIAL_DAYS } = require('./subscriptions');

const ACTIVE_STRIPE_STATUSES = new Set(['active', 'trialing']);

function isBillingEnabled() {
  const v = String(process.env.ONGO_BILLING_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function appBaseUrl(req) {
  if (process.env.APP_BASE_URL) return String(process.env.APP_BASE_URL).replace(/\/$/, '');
  if (req) {
    const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.get('x-forwarded-host') || req.get('host') || '')
      .split(',')[0]
      .trim();
    if (host) return `${proto}://${host}`;
  }
  return 'https://ongo-app.com';
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const err = new Error('STRIPE_SECRET_KEY is not configured');
    err.status = 503;
    err.code = 'stripe_not_configured';
    throw err;
  }
  return new Stripe(key);
}

function priceIdForInterval(interval) {
  if (interval === 'year' || interval === 'yearly') {
    const yearly = process.env.STRIPE_PRICE_PRO_YEARLY;
    if (yearly) return yearly;
  }
  const monthly = process.env.STRIPE_PRICE_PRO_MONTHLY;
  if (!monthly) {
    const err = new Error('STRIPE_PRICE_PRO_MONTHLY is not configured');
    err.status = 503;
    err.code = 'stripe_price_missing';
    throw err;
  }
  return monthly;
}

function billingPublicConfig() {
  return {
    billing_enabled: isBillingEnabled(),
    publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
    has_monthly_price: Boolean(process.env.STRIPE_PRICE_PRO_MONTHLY),
    has_yearly_price: Boolean(process.env.STRIPE_PRICE_PRO_YEARLY),
    trial_days: PRO_TRIAL_DAYS,
    free_tier: {
      keeps: [
        'Public directory listing',
        'Claim / own a venue',
        'Staff QR verify of customer claims',
        'View basic venue profile',
      ],
      loses: [
        'Activate / schedule live offers',
        'Boost switch',
        'Business analytics',
        'Ad bidding / featured placement',
      ],
    },
    pro_tier: {
      includes: [
        'Everything in free',
        'Live offers + scheduling',
        'Boost switch',
        'Analytics',
        'Ad bidding',
        'Priority support (roadmap)',
      ],
    },
  };
}

function latestSubscription(db, businessId) {
  return db
    .prepare(
      `SELECT * FROM subscriptions WHERE business_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(businessId);
}

function upsertPaidPro(db, businessId, fields) {
  ensureBillingColumns(db);
  const ts = nowIso();
  const existing = latestSubscription(db, businessId);
  const periodEnd = fields.current_period_end || null;
  const status = fields.status || 'active';
  const stripeStatus = fields.subscription_status || status;

  if (existing && (existing.plan === 'pro' || existing.stripe_subscription_id || existing.stripe_customer_id)) {
    db.prepare(`
      UPDATE subscriptions SET
        plan = 'pro',
        status = ?,
        subscription_status = ?,
        stripe_customer_id = COALESCE(?, stripe_customer_id),
        stripe_subscription_id = COALESCE(?, stripe_subscription_id),
        stripe_price_id = COALESCE(?, stripe_price_id),
        current_period_end = COALESCE(?, current_period_end),
        ends_at = COALESCE(?, ends_at),
        updated_at = ?
      WHERE id = ?
    `).run(
      status,
      stripeStatus,
      fields.stripe_customer_id || null,
      fields.stripe_subscription_id || null,
      fields.stripe_price_id || null,
      periodEnd,
      periodEnd,
      ts,
      existing.id
    );
    db.dirty = true;
    return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(existing.id);
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO subscriptions (
      id, business_id, plan, status, starts_at, ends_at, created_at,
      stripe_customer_id, stripe_subscription_id, stripe_price_id,
      subscription_status, current_period_end, updated_at
    ) VALUES (?, ?, 'pro', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    businessId,
    status,
    ts,
    periodEnd,
    ts,
    fields.stripe_customer_id || null,
    fields.stripe_subscription_id || null,
    fields.stripe_price_id || null,
    stripeStatus,
    periodEnd,
    ts
  );
  db.dirty = true;
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
}

function markSubscriptionCanceled(db, businessId, { endsAt } = {}) {
  ensureBillingColumns(db);
  const existing = latestSubscription(db, businessId);
  if (!existing) return null;
  const ts = nowIso();
  db.prepare(`
    UPDATE subscriptions SET
      status = 'canceled',
      subscription_status = 'canceled',
      plan = 'free',
      ends_at = COALESCE(?, ends_at, ?),
      updated_at = ?
    WHERE id = ?
  `).run(endsAt || ts, ts, ts, existing.id);
  db.dirty = true;
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(existing.id);
}

function findByStripeSubscriptionId(db, stripeSubId) {
  if (!stripeSubId) return null;
  ensureBillingColumns(db);
  return db
    .prepare(
      `SELECT * FROM subscriptions WHERE stripe_subscription_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(stripeSubId);
}

function findByStripeCustomerId(db, customerId) {
  if (!customerId) return null;
  ensureBillingColumns(db);
  return db
    .prepare(
      `SELECT * FROM subscriptions WHERE stripe_customer_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(customerId);
}

async function ensureStripeCustomer(db, { user, businessId, stripe }) {
  ensureBillingColumns(db);
  const sub = latestSubscription(db, businessId);
  if (sub && sub.stripe_customer_id) {
    return { customerId: sub.stripe_customer_id, sub };
  }
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.display_name || undefined,
    metadata: {
      ongo_user_id: user.id,
      ongo_business_id: businessId,
    },
  });
  if (sub) {
    db.prepare(`
      UPDATE subscriptions SET stripe_customer_id = ?, updated_at = ? WHERE id = ?
    `).run(customer.id, nowIso(), sub.id);
    db.dirty = true;
  } else {
    upsertPaidPro(db, businessId, {
      status: 'trial',
      subscription_status: 'trial',
      stripe_customer_id: customer.id,
    });
  }
  return { customerId: customer.id, sub: latestSubscription(db, businessId) };
}

async function createCheckoutSession(db, { user, businessId, interval, req }) {
  if (!isBillingEnabled()) {
    const err = new Error('Billing is not enabled yet (ONGO_BILLING_ENABLED=false)');
    err.status = 503;
    err.code = 'billing_disabled';
    throw err;
  }
  const stripe = getStripe();
  const priceId = priceIdForInterval(interval);
  const { customerId } = await ensureStripeCustomer(db, { user, businessId, stripe });
  const base = appBaseUrl(req);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: businessId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/?billing=success&business_id=${encodeURIComponent(businessId)}`,
    cancel_url: `${base}/?billing=cancel&business_id=${encodeURIComponent(businessId)}`,
    metadata: {
      ongo_business_id: businessId,
      ongo_user_id: user.id,
    },
    subscription_data: {
      metadata: {
        ongo_business_id: businessId,
        ongo_user_id: user.id,
      },
    },
    allow_promotion_codes: true,
  });
  return { url: session.url, id: session.id };
}

async function createPortalSession(db, { user, businessId, req }) {
  if (!isBillingEnabled()) {
    const err = new Error('Billing is not enabled yet (ONGO_BILLING_ENABLED=false)');
    err.status = 503;
    err.code = 'billing_disabled';
    throw err;
  }
  const stripe = getStripe();
  const { customerId } = await ensureStripeCustomer(db, { user, businessId, stripe });
  const base = appBaseUrl(req);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${base}/?billing=portal_return`,
  });
  return { url: session.url };
}

function periodEndIso(stripeSub) {
  const end = stripeSub && stripeSub.current_period_end;
  if (!end) return null;
  return new Date(end * 1000).toISOString();
}

function applyStripeSubscription(db, stripeSub, businessIdHint) {
  ensureBillingColumns(db);
  const businessId =
    businessIdHint ||
    (stripeSub.metadata && stripeSub.metadata.ongo_business_id) ||
    (findByStripeSubscriptionId(db, stripeSub.id) || {}).business_id ||
    (findByStripeCustomerId(db, stripeSub.customer) || {}).business_id;

  if (!businessId) {
    console.warn('Stripe subscription with no ON GO business mapping', stripeSub.id);
    return null;
  }

  const stripeStatus = stripeSub.status;
  const periodEnd = periodEndIso(stripeSub);
  const priceId =
    stripeSub.items &&
    stripeSub.items.data &&
    stripeSub.items.data[0] &&
    stripeSub.items.data[0].price &&
    stripeSub.items.data[0].price.id;

  if (ACTIVE_STRIPE_STATUSES.has(stripeStatus)) {
    return upsertPaidPro(db, businessId, {
      status: 'active',
      subscription_status: stripeStatus,
      stripe_customer_id: typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer?.id,
      stripe_subscription_id: stripeSub.id,
      stripe_price_id: priceId || null,
      current_period_end: periodEnd,
    });
  }

  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') {
    return upsertPaidPro(db, businessId, {
      status: stripeStatus,
      subscription_status: stripeStatus,
      stripe_customer_id: typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer?.id,
      stripe_subscription_id: stripeSub.id,
      stripe_price_id: priceId || null,
      current_period_end: periodEnd,
    });
  }

  // canceled, incomplete_expired, etc.
  return markSubscriptionCanceled(db, businessId, { endsAt: periodEnd || nowIso() });
}

async function handleCheckoutCompleted(db, session) {
  const businessId = (session.metadata && session.metadata.ongo_business_id) || session.client_reference_id;
  if (!businessId) return null;
  const stripe = getStripe();
  if (session.subscription) {
    const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
    const stripeSub = await stripe.subscriptions.retrieve(subId);
    return applyStripeSubscription(db, stripeSub, businessId);
  }
  return upsertPaidPro(db, businessId, {
    status: 'active',
    subscription_status: 'active',
    stripe_customer_id: typeof session.customer === 'string' ? session.customer : session.customer?.id,
  });
}

async function processWebhookEvent(db, event) {
  ensureBillingColumns(db);
  switch (event.type) {
    case 'checkout.session.completed': {
      await handleCheckoutCompleted(db, event.data.object);
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      applyStripeSubscription(db, event.data.object);
      break;
    }
    case 'invoice.paid': {
      const inv = event.data.object;
      if (inv.subscription) {
        const stripe = getStripe();
        const stripeSub = await stripe.subscriptions.retrieve(
          typeof inv.subscription === 'string' ? inv.subscription : inv.subscription.id
        );
        applyStripeSubscription(db, stripeSub);
      }
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object;
      const row =
        findByStripeSubscriptionId(
          db,
          typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id
        ) || findByStripeCustomerId(db, typeof inv.customer === 'string' ? inv.customer : inv.customer?.id);
      if (row) {
        upsertPaidPro(db, row.business_id, {
          status: 'past_due',
          subscription_status: 'past_due',
          stripe_customer_id: row.stripe_customer_id,
          stripe_subscription_id: row.stripe_subscription_id,
          stripe_price_id: row.stripe_price_id,
          current_period_end: row.current_period_end,
        });
      }
      break;
    }
    default:
      break;
  }
  return { received: true, type: event.type };
}

function constructWebhookEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    const err = new Error('STRIPE_WEBHOOK_SECRET is not configured');
    err.status = 503;
    err.code = 'stripe_webhook_secret_missing';
    throw err;
  }
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Entitlement used by gated routes.
 * Billing OFF → existing trial/active Pro rules (and ensureProTrials keeps everyone Pro).
 * Billing ON → Pro if valid trial OR Stripe active/trialing; past_due is not entitled.
 */
function hasProAccess(sub) {
  if (!sub) return false;
  if (!isBillingEnabled()) return isProEntitled(sub);

  // Paid Stripe subscription wins
  if (
    sub.plan === 'pro' &&
    (ACTIVE_STRIPE_STATUSES.has(sub.subscription_status) ||
      (sub.status === 'active' && sub.stripe_subscription_id))
  ) {
    if (sub.current_period_end && Date.parse(sub.current_period_end) < Date.now()) {
      // grace: still check status; if Stripe said active, period end may lag
      if (!ACTIVE_STRIPE_STATUSES.has(sub.subscription_status) && sub.status !== 'active') {
        return false;
      }
    }
    if (ACTIVE_STRIPE_STATUSES.has(sub.subscription_status) || sub.status === 'active') {
      return true;
    }
  }

  // Valid free trial still counts when billing is on
  return isProEntitled(sub) && sub.status === 'trial';
}

function formatBillingSubscription(sub) {
  const base = formatSubscription(sub);
  return {
    ...base,
    stripe_customer_id: sub?.stripe_customer_id || null,
    stripe_subscription_id: sub?.stripe_subscription_id || null,
    subscription_status: sub?.subscription_status || sub?.status || null,
    current_period_end: sub?.current_period_end || sub?.ends_at || null,
    entitled_pro: hasProAccess(sub),
    billing_enabled: isBillingEnabled(),
    can_upgrade: isBillingEnabled() && !hasProAccess(sub),
    can_manage:
      isBillingEnabled() &&
      Boolean(sub && (sub.stripe_customer_id || sub.stripe_subscription_id)),
  };
}

module.exports = {
  isBillingEnabled,
  billingPublicConfig,
  ensureBillingColumns,
  getStripe,
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  processWebhookEvent,
  hasProAccess,
  formatBillingSubscription,
  upsertPaidPro,
  appBaseUrl,
};
