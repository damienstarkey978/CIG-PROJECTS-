'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');
const {
  openDb,
  loadDbFromStore,
  expireOffers,
  nowIso,
  uuid,
  haversineMiles,
  ensureAuthColumns,
  blobStatus,
} = require('./lib/db');
const {
  COOKIE_NAME,
  UID_COOKIE,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  getUserFromSession,
  resolveUser,
  publicUser,
  isEmailVerified,
  isTrustedDemoEmail,
  requireAuth,
  requireRole,
  businessIdsForUser,
  userCanManageBusiness,
  randomToken,
  makeEmailVerifyToken,
  parseEmailVerifyToken,
} = require('./lib/auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('./lib/email');
const {
  ensureLogoColumns,
  resolveLogoForBusiness,
  resolveLogosBatch,
  saveUploadedLogo,
  readUploadedLogo,
  buildCreative,
  AD_PLACEMENTS,
  domainFromWebsite,
  KNOWN_WEBSITES,
} = require('./lib/logos');
const {
  assignProTrial,
  formatSubscription,
  ensureProTrialsForClaimed,
  isProEntitled,
  PRO_TRIAL_DAYS,
} = require('./lib/subscriptions');
const {
  ensureEnrichColumns,
  enrichBusiness,
  enrichAllBusinesses,
  publicEnrichment,
} = require('./lib/enrich');
const beta = require('./lib/beta');

const PORT = Number(process.env.PORT) || 3847;

let db;
let schedulePersist = () => {};
let persistNow = async () => {};
let seedResult = { seeded: false };
let dbPath = '';
let ready;
let syncingDb = Promise.resolve();

/**
 * On Netlify, reload SQLite from Blobs before each request so concurrent
 * function instances don't overwrite each other with stale in-memory copies.
 */
async function syncDbFromStore() {
  if (!(process.env.NETLIFY || process.env.USE_NETLIFY_BLOBS === '1')) return;
  const loaded = await loadDbFromStore();
  db = loaded.db;
  seedResult = loaded.seedResult;
  dbPath = loaded.dbPath || dbPath;
  schedulePersist = (d) => {
    if (!d || !d.dirty) return;
    // Mark dirty — api.js persists after the response
  };
}

function liveOfferClause() {
  return `o.status IN ('live', 'scheduled') AND o.paused_at IS NULL AND o.starts_at <= ? AND o.ends_at > ?`;
}

function escapeHtmlLite(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusLabel(status) {
  if (status === 'participating') return 'Participating';
  if (status === 'claimed') return 'Claimed · not yet live';
  return 'Directory listing · Not participating';
}

function attachLiveOffer(businessRow, now) {
  const offer = db.prepare(`
    SELECT id, title, description, product_label, terms, photo_url, starts_at, ends_at,
           redemption_limit, redemption_count, points_reward, status, visits_count
    FROM offers o
    WHERE o.business_id = ? AND ${liveOfferClause()}
    ORDER BY o.starts_at ASC
    LIMIT 1
  `).get(businessRow.id, now, now);
  return { ...businessRow, live_offer: offer || null };
}

function touch() {
  if (!db) return;
  db.dirty = true;
  if (!(process.env.NETLIFY || process.env.USE_NETLIFY_BLOBS === '1')) {
    schedulePersist(db);
  }
}

async function flushDb() {
  if (!db || !db.dirty) return;
  const { persistDbBytes } = require('./lib/db');
  await persistDbBytes(db);
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser(process.env.SESSION_SECRET || 'on-go-dev-secret'));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use(async (req, res, next) => {
    try {
      await ready;
      // Serialize store reloads so overlapping Netlify invocations in the same
      // isolate don't race on the module-level `db` pointer.
      syncingDb = syncingDb.then(() => syncDbFromStore()).catch(() => {});
      await syncingDb;
      expireOffers(db);
      beta.expireCampaignsAndLimits(db);
      const resolved = resolveUser(db, {
        sessionId: req.cookies[COOKIE_NAME],
        signedUserId: req.signedCookies && req.signedCookies[UID_COOKIE],
      });
      req.user = resolved.user;
      if (resolved.repairedSession) {
        touch();
        setSessionCookie(res, resolved.repairedSession, req);
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  function cookieDomain(req) {
    if (process.env.COOKIE_DOMAIN) return process.env.COOKIE_DOMAIN;
    const host = String(req.get('x-forwarded-host') || req.get('host') || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (host === 'ongo-app.com' || host.endsWith('.ongo-app.com')) {
      return '.ongo-app.com';
    }
    return undefined;
  }

  function cookieOpts(req, expires) {
    const opts = {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' || Boolean(process.env.NETLIFY),
      path: '/',
    };
    if (expires) opts.expires = new Date(expires);
    const domain = cookieDomain(req);
    if (domain) opts.domain = domain;
    return opts;
  }

  function setSessionCookie(res, session, req) {
    const opts = cookieOpts(req, session.expires);
    res.cookie(COOKIE_NAME, session.id, opts);
    // Signed uid survives Blobs lag when the session row isn't visible yet
    const uidOpts = { ...opts, signed: true };
    res.cookie(UID_COOKIE, session.userId || (req.user && req.user.id) || '', uidOpts);
  }

  function clearSessionCookie(res, req) {
    const opts = cookieOpts(req);
    res.clearCookie(COOKIE_NAME, opts);
    res.clearCookie(UID_COOKIE, { ...opts, signed: true });
  }

  function requireVerified(req, res) {
    if (!requireAuth(req, res)) return false;
    if (isTrustedDemoEmail(req.user.email) || isEmailVerified(req.user)) return true;
    res.status(403).json({
      error: 'Verify your email to continue',
      code: 'email_unverified',
    });
    return false;
  }

  app.get('/api/health', (_req, res) => {
    const blob = blobStatus();
    res.json({
      ok: true,
      service: 'on-go',
      db: path.basename(dbPath),
      seeded_on_boot: seedResult.seeded,
      host: process.env.NETLIFY ? 'netlify' : 'node',
      blob,
      users: db ? db.prepare('SELECT COUNT(*) AS n FROM users').get().n : 0,
      businesses: db ? db.prepare('SELECT COUNT(*) AS n FROM businesses').get().n : 0,
    });
  });

  app.get('/api/businesses', async (req, res) => {
    const now = nowIso();
    const { area, category, live, q, lat, lng, radius_mi } = req.query;
    let sql = `SELECT * FROM businesses WHERE 1=1`;
    const params = [];
    if (area) {
      sql += ` AND area = ?`;
      params.push(area);
    }
    if (category) {
      sql += ` AND category = ?`;
      params.push(category);
    }
    if (q) {
      sql += ` AND (name LIKE ? OR address LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`);
    }
    sql += ` ORDER BY name ASC`;
    let rows = db.prepare(sql).all(...params).map((b) => attachLiveOffer(b, now));

    const originLat = lat != null && lat !== '' ? Number(lat) : null;
    const originLng = lng != null && lng !== '' ? Number(lng) : null;
    const radius = radius_mi != null && radius_mi !== '' ? Number(radius_mi) : null;
    if (originLat != null && originLng != null && !Number.isNaN(originLat) && !Number.isNaN(originLng)) {
      rows = rows.map((b) => ({
        ...b,
        distance_mi: Math.round(haversineMiles(originLat, originLng, b.lat, b.lng) * 100) / 100,
      }));
      if (radius != null && !Number.isNaN(radius)) {
        rows = rows.filter((b) => b.distance_mi <= radius);
      }
      rows.sort((a, b) => (a.distance_mi ?? 0) - (b.distance_mi ?? 0));
    }

    if (live === '1' || live === 'true') {
      rows = rows.filter((b) => b.live_offer);
    }

    let favoriteIds = new Set();
    if (req.user) {
      favoriteIds = new Set(
        db.prepare('SELECT business_id FROM favorites WHERE user_id = ?').all(req.user.id).map((r) => r.business_id)
      );
    }

    const businesses = rows.map((b) => ({
      ...b,
      is_favorite: favoriteIds.has(b.id),
      is_featured: b.featured_until && b.featured_until > now,
      status_label: statusLabel(b.status),
      logo_url: b.logo_url || null,
      logo_source: b.logo_source || null,
      endorsement_note:
        b.status === 'unclaimed'
          ? 'Listed from public OpenStreetMap directory data. This venue has not endorsed ON GO.'
          : null,
    }));

    // Pull logos for venues still missing one (up to full directory on first loads).
    if (req.query.skip_logo_resolve !== '1') {
      try {
        await resolveLogosBatch(db, rows, { limit: rows.length || 16, concurrency: 4 });
        touch();
        for (const biz of businesses) {
          const fresh = db.prepare('SELECT logo_url, logo_source FROM businesses WHERE id = ?').get(biz.id);
          if (fresh) {
            biz.logo_url = fresh.logo_url;
            biz.logo_source = fresh.logo_source;
          }
        }
      } catch (err) {
        console.warn('logo batch resolve skipped', err.message);
      }
    }

    res.json({
      count: businesses.length,
      live_count: businesses.filter((b) => b.live_offer).length,
      businesses,
    });
  });

  function serializeBusinessDetail(b, now) {
    const withOffer = attachLiveOffer(b, now);
    const liveOffers = db.prepare(`
      SELECT id, title, description, product_label, starts_at, ends_at,
             redemption_limit, redemption_count, points_reward, status
      FROM offers o
      WHERE o.business_id = ? AND ${liveOfferClause()}
      ORDER BY o.starts_at ASC
    `).all(b.id, now, now);
    const sub = db.prepare(`
      SELECT * FROM subscriptions WHERE business_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(b.id);
    return {
      ...withOffer,
      status_label: statusLabel(b.status),
      enrichment: publicEnrichment(b),
      live_offers: liveOffers,
      subscription: formatSubscription(sub || { plan: 'free', status: 'none' }),
      can_boost:
        b.status === 'participating' ||
        b.status === 'claimed' ||
        !b.is_directory_only,
    };
  }

  app.get('/api/businesses/:id', async (req, res) => {
    ensureEnrichColumns(db);
    const now = nowIso();
    const key = req.params.id;
    let b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(key);
    if (!b) b = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(key);
    if (!b) return res.status(404).json({ error: 'Business not found' });
    let logo = { logo_url: b.logo_url, logo_source: b.logo_source, status: b.logo_url ? 'found' : 'missing' };
    if (req.query.resolve_logo === '1' || req.query.resolve_logo === 'true') {
      logo = await resolveLogoForBusiness(db, b);
      touch();
      b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(b.id);
    }
    const detail = serializeBusinessDetail(b, now);
    detail.logo_url = logo.logo_url;
    detail.logo_source = logo.logo_source;
    detail.logo_status = logo.status;
    res.json(detail);
  });

  app.get('/api/b/:slug', async (req, res) => {
    ensureEnrichColumns(db);
    const now = nowIso();
    const b = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(req.params.slug);
    if (!b) return res.status(404).json({ error: 'Business not found' });
    res.json(serializeBusinessDetail(b, now));
  });

  /** Ops / migrate: enrich missing venue briefs from the web */
  app.post('/api/enrichment/run', async (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const force = Boolean(req.body && req.body.force);
    const summary = await enrichAllBusinesses(db, { force, concurrency: 2 });
    touch();
    res.json(summary);
  });

  /**
   * Instant boost switch — activate (or expire) a live BOGO/happy-hour offer.
   * Claimed / Pro-trial venues only.
   */
  app.post('/api/businesses/:id/boost', (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Business not found' });
    if (!userCanManageBusiness(db, req.user.id, b.id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not manage this business' });
    }
    const sub = db.prepare(`
      SELECT * FROM subscriptions WHERE business_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(b.id);
    if (!isProEntitled(sub) && req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Pro trial or Pro plan required to flip the boost switch',
        code: 'pro_required',
      });
    }

    const active = req.body && req.body.active !== false && req.body.active !== '0';
    const ts = nowIso();

    if (!active) {
      db.prepare(`
        UPDATE offers SET status = 'deactivated', updated_at = ?
        WHERE business_id = ? AND status IN ('live', 'scheduled')
      `).run(ts, b.id);
      touch();
      return res.json({
        ok: true,
        active: false,
        message: 'Boosts turned OFF',
        business: serializeBusinessDetail(
          db.prepare('SELECT * FROM businesses WHERE id = ?').get(b.id),
          ts
        ),
      });
    }

    const title = String(req.body.title || 'ON GO live campaign').slice(0, 120);
    const product_label = String(req.body.product_label || 'Ask your server').slice(0, 120);
    const mins = beta.normalizeCampaignDurationMinutes(req.body.duration_minutes) || 120;
    const start = new Date();
    const end = new Date(start.getTime() + mins * 60 * 1000);
    const id = uuid();
    const visitLimit = beta.clampVisitLimit(req.body.redemption_limit);

    db.prepare(`
      UPDATE offers SET status = 'deactivated', updated_at = ?
      WHERE business_id = ? AND status IN ('live', 'scheduled', 'paused')
    `).run(ts, b.id);

    db.prepare(`
      INSERT INTO offers (
        id, business_id, title, description, product_label, status,
        starts_at, ends_at, redemption_limit, redemption_count, points_reward,
        created_by_user_id, created_at, updated_at, visits_count, points_awarded_total, views_count
      ) VALUES (?, ?, ?, ?, ?, 'live', ?, ?, ?, 0, ?, ?, ?, ?, 0, 0, 0)
    `).run(
      id,
      b.id,
      title,
      String(req.body.description || 'Live campaign — members scan venue QR for qualifying visits.').slice(0, 500),
      product_label,
      start.toISOString(),
      end.toISOString(),
      visitLimit,
      beta.POINTS_PER_VISIT,
      req.user.id,
      ts,
      ts
    );
    touch();
    res.status(201).json({
      ok: true,
      active: true,
      offer: db.prepare('SELECT * FROM offers WHERE id = ?').get(id),
      message: 'Boost is ON',
      business: serializeBusinessDetail(
        db.prepare('SELECT * FROM businesses WHERE id = ?').get(b.id),
        ts
      ),
    });
  });

  app.post('/api/logos/resolve', async (req, res) => {
    ensureLogoColumns(db);
    const ids = Array.isArray(req.body.business_ids) ? req.body.business_ids.slice(0, 12) : [];
    const force = Boolean(req.body.force);
    let rows;
    if (ids.length) {
      rows = ids
        .map((id) => db.prepare('SELECT * FROM businesses WHERE id = ?').get(id))
        .filter(Boolean);
    } else {
      rows = db.prepare('SELECT * FROM businesses ORDER BY name ASC').all();
    }
    const resolved = await resolveLogosBatch(db, rows, { limit: ids.length || 8, force });
    touch();
    res.json({ resolved, count: resolved.length });
  });

  app.get('/api/businesses/:id/logo/file', async (req, res) => {
    const b = db.prepare('SELECT id, logo_source FROM businesses WHERE id = ?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Business not found' });
    const file = await readUploadedLogo(b.id);
    if (!file) return res.status(404).json({ error: 'No uploaded logo' });
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(file.buffer);
  });

  app.post('/api/businesses/:id/logo', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Business not found' });
    if (!userCanManageBusiness(db, req.user.id, b.id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not manage this business' });
    }
    const dataUrl = String(req.body.image_base64 || '');
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'image_base64 must be a data:image/...;base64 URL' });
    }
    const contentType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 1_500_000) {
      return res.status(400).json({ error: 'Logo must be under ~1.5MB' });
    }
    try {
      const logo = await saveUploadedLogo(db, b.id, { buffer, contentType });
      touch();
      res.json({ ok: true, ...logo, business_id: b.id });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Upload failed' });
    }
  });

  app.get('/api/ads/preview', async (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const business_id = req.query.business_id;
    const inventory_id = req.query.inventory_id;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business_id);
    if (!b) return res.status(404).json({ error: 'Business not found' });
    if (!userCanManageBusiness(db, req.user.id, business_id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not manage this business' });
    }
    const slot = inventory_id
      ? db.prepare('SELECT * FROM ad_inventory WHERE id = ?').get(inventory_id)
      : null;
    const logo = await resolveLogoForBusiness(db, b);
    touch();
    res.json({
      simulation: true,
      creative: buildCreative(b, slot, logo),
      placements: AD_PLACEMENTS,
    });
  });

  app.post('/api/auth/register', async (req, res) => {
    ensureAuthColumns(db);
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const display_name = String(req.body.display_name || '').trim();
    const role = req.body.role === 'business' ? 'business' : 'customer';
    const business_id = req.body.business_id || null;

    if (!email || !password || password.length < 6 || !display_name) {
      return res.status(400).json({ error: 'Name, email, and password (6+ chars) required' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const ts = nowIso();
    const id = uuid();
    const autoVerify = isTrustedDemoEmail(email);
    const verifyToken = autoVerify ? null : makeEmailVerifyToken(id);
    const verifyExpires = autoVerify
      ? null
      : new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    try {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO users (
            id, email, password_hash, display_name, role, points_balance,
            email_verified_at, verify_token, verify_expires, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
        `).run(
          id,
          email,
          hashPassword(password),
          display_name,
          role,
          autoVerify ? ts : null,
          verifyToken,
          verifyExpires,
          ts,
          ts
        );

        if (role === 'business') {
          if (!business_id) {
            throw Object.assign(new Error('Select a business listing to claim'), { status: 400 });
          }
          const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business_id);
          if (!biz) throw Object.assign(new Error('Business not found'), { status: 404 });
          if (biz.status !== 'unclaimed') {
            throw Object.assign(new Error('That listing is already claimed'), { status: 409 });
          }
          db.prepare(`
            UPDATE businesses
            SET status = 'participating', claimed_by_user_id = ?, is_directory_only = 0, updated_at = ?
            WHERE id = ?
          `).run(id, ts, business_id);
          db.prepare(`
            INSERT INTO business_members (id, business_id, user_id, member_role, created_at)
            VALUES (?, ?, ?, 'owner', ?)
          `).run(uuid(), business_id, id, ts);
          assignProTrial(db, business_id, { now: ts });
        }
      });
      tx();
      touch();
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Registration failed' });
    }

    let verification = null;
    if (verifyToken) {
      verification = await sendVerificationEmail({ to: email, token: verifyToken, req });
    }

    const session = createSession(db, id);
    touch();
    setSessionCookie(res, session, req);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    delete user.password_hash;
    const payload = {
      user: publicUser(user),
      message: autoVerify
        ? 'Account created'
        : verification && verification.sent
          ? 'Check your email to verify your account'
          : 'Account created — verify your email to unlock claims',
    };
    // When Resend isn't configured, return the link so ops can complete verify.
    if (verification && !verification.sent && verification.link) {
      payload.verify_link = verification.link;
      payload.email_delivery = verification.reason || 'not sent';
    }
    res.status(201).json(payload);
  });

  app.post('/api/auth/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const session = createSession(db, user.id);
    touch();
    setSessionCookie(res, session, req);
    delete user.password_hash;
    res.json({
      user: publicUser(user),
      needs_verification: !isTrustedDemoEmail(user.email) && !isEmailVerified(user),
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    destroySession(db, req.cookies[COOKIE_NAME]);
    touch();
    clearSessionCookie(res, req);
    res.json({ ok: true });
  });

  app.post('/api/auth/verify', (req, res) => {
    ensureAuthColumns(db);
    const token = String(req.body.token || req.query.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token required' });

    // Prefer HMAC token (no DB token row needed — Blobs-lag safe).
    let user = null;
    const parsed = parseEmailVerifyToken(token);
    if (parsed) {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(parsed.uid);
      // Fallback: signed cookie from the register response on this device
      if (!user && req.signedCookies && req.signedCookies[UID_COOKIE] === parsed.uid) {
        return res.status(409).json({
          error: 'Account is still syncing — tap verify again in a few seconds',
          code: 'sync_pending',
        });
      }
    }
    if (!user) {
      user = db.prepare('SELECT * FROM users WHERE verify_token = ?').get(token);
    }
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired verification link' });
    }
    if (!parsed && user.verify_expires && new Date(user.verify_expires) <= new Date()) {
      return res.status(400).json({ error: 'Verification link expired — request a new one' });
    }
    if (user.email_verified_at) {
      const session = createSession(db, user.id);
      setSessionCookie(res, session, req);
      delete user.password_hash;
      return res.json({ ok: true, user: publicUser(user), message: 'Email already verified' });
    }
    const ts = nowIso();
    db.prepare(`
      UPDATE users
      SET email_verified_at = ?, verify_token = NULL, verify_expires = NULL, updated_at = ?
      WHERE id = ?
    `).run(ts, ts, user.id);
    touch();
    const session = createSession(db, user.id);
    setSessionCookie(res, session, req);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    delete fresh.password_hash;
    res.json({ ok: true, user: publicUser(fresh), message: 'Email verified' });
  });

  app.post('/api/auth/resend-verification', async (req, res) => {
    ensureAuthColumns(db);
    const email = String(req.body.email || (req.user && req.user.email) || '')
      .trim()
      .toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Always return ok to avoid email enumeration
    if (!user) {
      return res.json({ ok: true, message: 'If that account exists, a verification email was sent' });
    }
    if (user.email_verified_at || isTrustedDemoEmail(email)) {
      return res.json({ ok: true, message: 'Email already verified' });
    }
    const token = makeEmailVerifyToken(user.id);
    const expires = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    db.prepare(`
      UPDATE users SET verify_token = ?, verify_expires = ?, updated_at = ? WHERE id = ?
    `).run(token, expires, nowIso(), user.id);
    touch();
    const verification = await sendVerificationEmail({ to: email, token, req });
    const payload = {
      ok: true,
      message: verification.sent
        ? 'Verification email sent'
        : 'Verification link ready (email delivery not configured)',
    };
    if (!verification.sent && verification.link) {
      payload.verify_link = verification.link;
      payload.email_delivery = verification.reason;
    }
    res.json(payload);
  });

  app.post('/api/auth/forgot-password', async (req, res) => {
    ensureAuthColumns(db);
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const generic = {
      ok: true,
      message: 'If that account exists, a reset link was sent',
    };
    if (!user) return res.json(generic);
    const token = randomToken();
    const expires = new Date(Date.now() + 3600 * 1000).toISOString();
    db.prepare(`
      UPDATE users SET reset_token = ?, reset_expires = ?, updated_at = ? WHERE id = ?
    `).run(token, expires, nowIso(), user.id);
    touch();
    const mailed = await sendPasswordResetEmail({ to: email, token, req });
    const payload = { ...generic };
    if (!mailed.sent && mailed.link) {
      payload.reset_link = mailed.link;
      payload.email_delivery = mailed.reason;
    } else if (mailed.sent) {
      payload.message = 'Password reset email sent';
    }
    res.json(payload);
  });

  app.post('/api/auth/reset-password', (req, res) => {
    ensureAuthColumns(db);
    const token = String(req.body.token || '').trim();
    const password = String(req.body.password || '');
    if (!token || password.length < 6) {
      return res.status(400).json({ error: 'token and password (6+ chars) required' });
    }
    const user = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });
    if (user.reset_expires && new Date(user.reset_expires) <= new Date()) {
      return res.status(400).json({ error: 'Reset link expired — request a new one' });
    }
    const ts = nowIso();
    db.prepare(`
      UPDATE users
      SET password_hash = ?,
          reset_token = NULL,
          reset_expires = NULL,
          email_verified_at = COALESCE(email_verified_at, ?),
          updated_at = ?
      WHERE id = ?
    `).run(hashPassword(password), ts, ts, user.id);
    touch();
    const session = createSession(db, user.id);
    setSessionCookie(res, session, req);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    delete fresh.password_hash;
    res.json({ ok: true, user: publicUser(fresh), message: 'Password updated' });
  });

  app.get('/api/me', (req, res) => {
    if (!req.user) return res.json({ user: null, businesses: [] });
    const businesses = businessIdsForUser(db, req.user.id).map((id) => {
      const b = db.prepare('SELECT id, name, area, status, logo_url, logo_source FROM businesses WHERE id = ?').get(id);
      const sub = db.prepare(`
        SELECT * FROM subscriptions WHERE business_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(id);
      return {
        ...b,
        subscription: formatSubscription(sub || { plan: 'free', status: 'none' }),
      };
    });
    res.json({ user: publicUser(req.user), businesses });
  });

  app.post('/api/offers', (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const {
      business_id,
      title,
      description,
      product_label,
      terms,
      photo_url,
      duration_minutes,
      starts_at,
      ends_at,
      redemption_limit,
      points_reward,
      preview_only,
    } = req.body || {};

    if (!business_id || !title) {
      return res.status(400).json({ error: 'business_id and title required' });
    }
    if (!userCanManageBusiness(db, req.user.id, business_id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not manage this business' });
    }

    const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business_id);
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    if (biz.suspended_at) return res.status(403).json({ error: 'Venue suspended' });
    if (!biz.verified_at && req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Venue must be verified before publishing campaigns. Ask an admin to approve.',
        code: 'unverified',
      });
    }

    const start = starts_at ? new Date(starts_at) : new Date();
    let end;
    if (ends_at) {
      end = new Date(ends_at);
      const spanMin = Math.round((end - start) / 60000);
      if (!beta.CAMPAIGN_DURATION_MINUTES.includes(spanMin)) {
        return res.status(400).json({
          error: 'Beta campaigns must run exactly 1 or 2 hours',
          allowed_duration_minutes: beta.CAMPAIGN_DURATION_MINUTES,
        });
      }
    } else {
      const mins = beta.normalizeCampaignDurationMinutes(duration_minutes);
      if (!mins) {
        return res.status(400).json({
          error: 'Beta campaigns must be 1 hour or 2 hours only',
          allowed_duration_minutes: beta.CAMPAIGN_DURATION_MINUTES,
        });
      }
      end = new Date(start.getTime() + mins * 60 * 1000);
    }
    if (!(start instanceof Date) || Number.isNaN(+start) || Number.isNaN(+end) || end <= start) {
      return res.status(400).json({ error: 'Invalid start/end times' });
    }

    // Locked: 50 pts/visit; max 100 qualifying visits; one active campaign per venue
    const pointsFinal = beta.POINTS_PER_VISIT;
    const limitFinal = beta.clampVisitLimit(redemption_limit);

    const preview = {
      business_id,
      business_name: biz.name,
      title: String(title).slice(0, 120),
      description: description ? String(description).slice(0, 500) : '',
      product_label: product_label ? String(product_label).slice(0, 120) : '',
      terms: terms ? String(terms).slice(0, 800) : '',
      photo_url: photo_url ? String(photo_url).slice(0, 500) : '',
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      redemption_limit: limitFinal,
      points_reward: pointsFinal,
      notice: 'Customer preview — 50 pts per qualifying visit. Points are not cash. Vendors fund rewards.',
    };
    if (preview_only) {
      return res.json({ preview });
    }

    const ts = nowIso();
    const id = uuid();
    const status = start <= new Date() ? 'live' : 'scheduled';

    db.prepare(`
      UPDATE offers SET status = 'deactivated', updated_at = ?
      WHERE business_id = ? AND status IN ('live', 'scheduled', 'paused')
    `).run(ts, business_id);

    db.prepare(`
      INSERT INTO offers (
        id, business_id, title, description, product_label, status,
        starts_at, ends_at, redemption_limit, redemption_count, points_reward,
        created_by_user_id, created_at, updated_at, terms, photo_url,
        visits_count, points_awarded_total, views_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0, 0, 0)
    `).run(
      id,
      business_id,
      preview.title,
      preview.description,
      preview.product_label,
      status,
      preview.starts_at,
      preview.ends_at,
      limitFinal,
      pointsFinal,
      req.user.id,
      ts,
      ts,
      preview.terms,
      preview.photo_url
    );
    beta.writeAudit(db, {
      actorUserId: req.user.id,
      action: 'campaign_created',
      entityType: 'offer',
      entityId: id,
      meta: { status, points: pointsFinal, limit: limitFinal },
    });
    touch();

    res.status(201).json({
      offer: db.prepare('SELECT * FROM offers WHERE id = ?').get(id),
      preview,
    });
  });

  app.post('/api/offers/:id/deactivate', (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Offer not found' });
    if (!userCanManageBusiness(db, req.user.id, offer.business_id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not manage this business' });
    }
    db.prepare(`UPDATE offers SET status = 'deactivated', paused_at = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), offer.id);
    beta.writeAudit(db, {
      actorUserId: req.user.id,
      action: 'campaign_ended',
      entityType: 'offer',
      entityId: offer.id,
    });
    touch();
    res.json({ offer: db.prepare('SELECT * FROM offers WHERE id = ?').get(offer.id) });
  });

  app.post('/api/offers/:id/pause', (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Offer not found' });
    if (!userCanManageBusiness(db, req.user.id, offer.business_id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not manage this business' });
    }
    const ts = nowIso();
    db.prepare(`
      UPDATE offers SET status = 'paused', paused_at = ?, updated_at = ? WHERE id = ?
    `).run(ts, ts, offer.id);
    beta.writeAudit(db, {
      actorUserId: req.user.id,
      action: 'campaign_paused',
      entityType: 'offer',
      entityId: offer.id,
    });
    touch();
    res.json({ offer: db.prepare('SELECT * FROM offers WHERE id = ?').get(offer.id) });
  });

  app.post('/api/offers/:id/resume', (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Offer not found' });
    if (!userCanManageBusiness(db, req.user.id, offer.business_id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not manage this business' });
    }
    const ts = nowIso();
    if (offer.ends_at <= ts) {
      return res.status(400).json({ error: 'Campaign already ended' });
    }
    const status = offer.starts_at <= ts ? 'live' : 'scheduled';
    db.prepare(`
      UPDATE offers SET status = ?, paused_at = NULL, updated_at = ? WHERE id = ?
    `).run(status, ts, offer.id);
    beta.writeAudit(db, {
      actorUserId: req.user.id,
      action: 'campaign_resumed',
      entityType: 'offer',
      entityId: offer.id,
    });
    touch();
    res.json({ offer: db.prepare('SELECT * FROM offers WHERE id = ?').get(offer.id) });
  });

  app.post('/api/offers/:id/view', (req, res) => {
    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Offer not found' });
    const ts = nowIso();
    db.prepare('UPDATE offers SET views_count = COALESCE(views_count, 0) + 1 WHERE id = ?').run(offer.id);
    db.prepare(`
      INSERT INTO campaign_views (id, offer_id, business_id, viewer_user_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), offer.id, offer.business_id, req.user?.id || null, ts);
    touch();
    res.json({ ok: true });
  });

  app.get('/api/offers/live', (_req, res) => {
    const now = nowIso();
    const rows = db.prepare(`
      SELECT o.*, b.name AS business_name, b.area, b.category, b.lat, b.lng
      FROM offers o
      JOIN businesses b ON b.id = o.business_id
      WHERE ${liveOfferClause()}
      ORDER BY o.ends_at ASC
    `).all(now, now);
    res.json({ offers: rows });
  });

  app.get('/api/business/offers', (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const ids = businessIdsForUser(db, req.user.id);
    if (!ids.length) return res.json({ offers: [] });
    const placeholders = ids.map(() => '?').join(',');
    const offers = db.prepare(`
      SELECT o.*, b.name AS business_name
      FROM offers o
      JOIN businesses b ON b.id = o.business_id
      WHERE o.business_id IN (${placeholders})
      ORDER BY o.created_at DESC
      LIMIT 50
    `).all(...ids);
    res.json({ offers });
  });

  app.get('/api/business/analytics', (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const ids = businessIdsForUser(db, req.user.id);
    if (!ids.length) return res.json({ analytics: [] });
    const analytics = ids.map((business_id) => {
      const b = db.prepare('SELECT id, name FROM businesses WHERE id = ?').get(business_id);
      const views = db.prepare(`
        SELECT COALESCE(SUM(views_count), 0) AS n FROM offers WHERE business_id = ?
      `).get(business_id).n;
      const visits = db.prepare(`
        SELECT COUNT(*) AS n FROM qualifying_visits WHERE business_id = ?
      `).get(business_id).n;
      const points = db.prepare(`
        SELECT COALESCE(SUM(points_awarded), 0) AS n FROM qualifying_visits WHERE business_id = ?
      `).get(business_id).n;
      const rewards_redeemed = db.prepare(`
        SELECT COUNT(*) AS n FROM reward_redemptions
        WHERE business_id = ? AND status = 'fulfilled'
      `).get(business_id).n;
      const live = db.prepare(`
        SELECT COUNT(*) AS n FROM offers o
        WHERE o.business_id = ? AND ${liveOfferClause()}
      `).get(business_id, nowIso(), nowIso()).n;
      // Legacy claim→staff path kept for reference only (simulated / outside live beta)
      const legacy_claims = db.prepare(`
        SELECT COUNT(*) AS n FROM redemptions WHERE business_id = ?
      `).get(business_id).n;
      return {
        business_id,
        name: b.name,
        views,
        qualifying_visits: visits,
        points_awarded: points,
        rewards_redeemed,
        live_offers: live,
        legacy_claims_simulated: legacy_claims,
      };
    });
    res.json({
      analytics,
      notice: 'Qualifying visits and rewards — not sales or revenue. Legacy claim counts are simulated / outside live beta.',
    });
  });

  app.post('/api/offers/:id/claim', async (req, res) => {
    if (!requireRole(req, res, ['customer'])) return;
    if (!requireVerified(req, res)) return;
    const now = nowIso();
    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Offer not found' });
    if (!(offer.status === 'live' || offer.status === 'scheduled') ||
        offer.starts_at > now || offer.ends_at <= now) {
      return res.status(400).json({ error: 'Offer is not live' });
    }
    if (offer.redemption_limit != null && offer.redemption_count >= offer.redemption_limit) {
      return res.status(400).json({ error: 'Offer redemption limit reached' });
    }

    const existing = db.prepare(`
      SELECT * FROM redemptions WHERE offer_id = ? AND user_id = ?
    `).get(offer.id, req.user.id);
    if (existing) {
      if (existing.status === 'redeemed') {
        return res.status(409).json({ error: 'Already redeemed' });
      }
      const qr_data_url = await QRCode.toDataURL(`ongo:${existing.token}`, {
        margin: 1,
        width: 280,
        color: { dark: '#087d32', light: '#ffffff' },
      });
      return res.json({
        redemption: existing,
        qr_data_url,
        token: existing.token,
        message: 'Show this QR at the venue. Points award after staff verification.',
      });
    }

    const token = randomToken();
    const id = uuid();
    db.prepare(`
      INSERT INTO redemptions (
        id, offer_id, business_id, user_id, token, status, claimed_at, points_awarded
      ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, 0)
    `).run(id, offer.id, offer.business_id, req.user.id, token, now);
    touch();

    const redemption = db.prepare('SELECT * FROM redemptions WHERE id = ?').get(id);
    const qr_data_url = await QRCode.toDataURL(`ongo:${token}`, {
      margin: 1,
      width: 280,
      color: { dark: '#087d32', light: '#ffffff' },
    });

    res.status(201).json({
      redemption,
      qr_data_url,
      token,
      message: 'Show this QR at the venue. Points award after staff verification.',
    });
  });

  app.post('/api/redemptions/verify', (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    let token = String(req.body.token || '').trim();
    if (token.startsWith('ongo:')) token = token.slice(5);
    if (!token) return res.status(400).json({ error: 'token required' });

    const redemption = db.prepare('SELECT * FROM redemptions WHERE token = ?').get(token);
    if (!redemption) return res.status(404).json({ error: 'Unknown QR token' });
    if (redemption.status === 'redeemed') {
      return res.status(409).json({ error: 'Already redeemed' });
    }
    if (redemption.status === 'void') {
      return res.status(400).json({ error: 'Redemption void' });
    }
    if (!userCanManageBusiness(db, req.user.id, redemption.business_id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'This QR belongs to another venue' });
    }

    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(redemption.offer_id);
    const now = nowIso();
    if (!offer || offer.ends_at <= now || offer.status === 'deactivated' || offer.status === 'expired') {
      return res.status(400).json({ error: 'Offer no longer redeemable' });
    }
    if (offer.redemption_limit != null && offer.redemption_count >= offer.redemption_limit) {
      return res.status(400).json({ error: 'Offer redemption limit reached' });
    }

    const points = offer.points_reward || 25;
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE redemptions
        SET status = 'redeemed', redeemed_at = ?, redeemed_by_user_id = ?, points_awarded = ?
        WHERE id = ?
      `).run(now, req.user.id, points, redemption.id);

      db.prepare(`
        UPDATE offers SET redemption_count = redemption_count + 1, updated_at = ? WHERE id = ?
      `).run(now, offer.id);

      db.prepare(`
        UPDATE users SET points_balance = points_balance + ?, updated_at = ? WHERE id = ?
      `).run(points, now, redemption.user_id);

      db.prepare(`
        INSERT INTO loyalty_ledger (id, user_id, delta, reason, redemption_id, created_at)
        VALUES (?, ?, ?, 'redemption', ?, ?)
      `).run(uuid(), redemption.user_id, points, redemption.id, now);
    });
    tx();
    touch();

    const customer = db.prepare('SELECT display_name, points_balance FROM users WHERE id = ?').get(
      redemption.user_id
    );
    const biz = db.prepare('SELECT lat, lng FROM businesses WHERE id = ?').get(redemption.business_id);
    const nextStops = nearbyLiveOffers(biz.lat, biz.lng, redemption.business_id, 3);

    res.json({
      ok: true,
      points_awarded: points,
      customer,
      redemption: db.prepare('SELECT * FROM redemptions WHERE id = ?').get(redemption.id),
      next_stops: nextStops,
    });
  });

  function nearbyLiveOffers(lat, lng, excludeBusinessId, limit = 5) {
    const now = nowIso();
    const rows = db.prepare(`
      SELECT o.id AS offer_id, o.title, o.ends_at, o.points_reward,
             b.id AS business_id, b.name, b.area, b.category, b.lat, b.lng, b.address
      FROM offers o
      JOIN businesses b ON b.id = o.business_id
      WHERE ${liveOfferClause()}
        AND b.id != ?
    `).all(now, now, excludeBusinessId);

    return rows
      .map((r) => ({
        ...r,
        distance_mi: Math.round(haversineMiles(lat, lng, r.lat, r.lng) * 100) / 100,
      }))
      .sort((a, b) => a.distance_mi - b.distance_mi)
      .slice(0, limit);
  }

  app.get('/api/next-stop', (req, res) => {
    const business_id = req.query.business_id;
    let lat = Number(req.query.lat);
    let lng = Number(req.query.lng);
    if (business_id) {
      const b = db.prepare('SELECT lat, lng FROM businesses WHERE id = ?').get(business_id);
      if (!b) return res.status(404).json({ error: 'Business not found' });
      lat = b.lat;
      lng = b.lng;
    }
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ error: 'lat/lng or business_id required' });
    }
    res.json({
      next_stops: nearbyLiveOffers(lat, lng, business_id || '', Number(req.query.limit) || 5),
      notice: 'Organic Next Stop for Phase 1. Sponsored placements come in Phase 3.',
    });
  });

  app.get('/api/loyalty/history', (req, res) => {
    if (!requireAuth(req, res)) return;
    const rows = db.prepare(`
      SELECT l.*,
        COALESCE(l.offer_id, r.offer_id, v.offer_id) AS offer_id,
        COALESCE(o.title, o2.title, o3.title) AS offer_title,
        COALESCE(b.name, b2.name, b3.name) AS business_name
      FROM loyalty_ledger l
      LEFT JOIN redemptions r ON r.id = l.redemption_id
      LEFT JOIN offers o ON o.id = r.offer_id
      LEFT JOIN businesses b ON b.id = r.business_id
      LEFT JOIN qualifying_visits v ON v.id = l.visit_id
      LEFT JOIN offers o2 ON o2.id = v.offer_id
      LEFT JOIN businesses b2 ON b2.id = v.business_id
      LEFT JOIN offers o3 ON o3.id = l.offer_id
      LEFT JOIN businesses b3 ON b3.id = o3.business_id
      WHERE l.user_id = ?
      ORDER BY l.created_at DESC
      LIMIT 100
    `).all(req.user.id);
    res.json({
      points_balance: req.user.points_balance,
      history: rows,
      notice: 'Points are promotional rewards, not cash payouts.',
    });
  });

  app.get('/api/customer/claims', (req, res) => {
    if (!requireRole(req, res, ['customer'])) return;
    const rows = db.prepare(`
      SELECT r.*, o.title AS offer_title, o.ends_at, b.name AS business_name, b.id AS business_id, b.lat, b.lng
      FROM redemptions r
      JOIN offers o ON o.id = r.offer_id
      JOIN businesses b ON b.id = r.business_id
      WHERE r.user_id = ?
      ORDER BY r.claimed_at DESC
      LIMIT 50
    `).all(req.user.id);
    res.json({ claims: rows });
  });

  app.get('/api/favorites', (req, res) => {
    if (!requireAuth(req, res)) return;
    const rows = db.prepare(`
      SELECT b.* FROM favorites f
      JOIN businesses b ON b.id = f.business_id
      WHERE f.user_id = ?
      ORDER BY f.created_at DESC
    `).all(req.user.id);
    res.json({ favorites: rows });
  });

  app.post('/api/favorites/:businessId', (req, res) => {
    if (!requireAuth(req, res)) return;
    const b = db.prepare('SELECT id FROM businesses WHERE id = ?').get(req.params.businessId);
    if (!b) return res.status(404).json({ error: 'Business not found' });
    db.prepare(`
      INSERT OR IGNORE INTO favorites (user_id, business_id, created_at) VALUES (?, ?, ?)
    `).run(req.user.id, b.id, nowIso());
    touch();
    res.status(201).json({ ok: true });
  });

  app.delete('/api/favorites/:businessId', (req, res) => {
    if (!requireAuth(req, res)) return;
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND business_id = ?').run(
      req.user.id,
      req.params.businessId
    );
    touch();
    res.json({ ok: true });
  });

  app.get('/api/ads/inventory', (_req, res) => {
    const rows = db.prepare(`
      SELECT * FROM ad_inventory WHERE status = 'open' ORDER BY starts_at ASC
    `).all();
    res.json({
      simulation: true,
      notice: 'Simulation only. No charge or placement guarantee.',
      inventory: rows,
    });
  });

  app.post('/api/ads/bids', async (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const inventory_id = req.body.inventory_id;
    const business_id = req.body.business_id;
    const amount_cents = Math.round(Number(req.body.amount_cents) || 0);
    if (!inventory_id || !business_id || amount_cents < 1) {
      return res.status(400).json({ error: 'inventory_id, business_id, and amount_cents required' });
    }
    if (!userCanManageBusiness(db, req.user.id, business_id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not manage this business' });
    }
    const slot = db.prepare('SELECT * FROM ad_inventory WHERE id = ?').get(inventory_id);
    if (!slot) return res.status(404).json({ error: 'Inventory not found' });
    if (amount_cents < slot.min_bid_cents) {
      return res.status(400).json({ error: `Minimum bid is ${slot.min_bid_cents} cents` });
    }
    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business_id);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    const id = uuid();
    db.prepare(`
      INSERT INTO bids (id, inventory_id, business_id, user_id, amount_cents, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'simulated', ?)
    `).run(id, inventory_id, business_id, req.user.id, amount_cents, nowIso());
    // Phase 2 scaffold: mark featured_until for demo visibility when "winning" sim bid
    const featuredUntil = slot.ends_at;
    db.prepare(`UPDATE businesses SET featured_until = ?, updated_at = ? WHERE id = ?`).run(
      featuredUntil,
      nowIso(),
      business_id
    );
    const logo = await resolveLogoForBusiness(db, business);
    touch();
    res.status(201).json({
      bid: db.prepare('SELECT * FROM bids WHERE id = ?').get(id),
      notice: 'Simulation only. No charge or placement guarantee. Featured badge may appear until slot end.',
      creative: buildCreative(business, slot, logo),
    });
  });

  app.get('/api/subscriptions', (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    ensureProTrialsForClaimed(db);
    touch();
    const ids = businessIdsForUser(db, req.user.id);
    if (!ids.length) {
      return res.json({
        subscriptions: [],
        plans: PLAN_CATALOG,
        trial_days: PRO_TRIAL_DAYS,
        notice: `Claimed venues get Pro free trial (${PRO_TRIAL_DAYS} days) with full Pro features.`,
      });
    }
    const placeholders = ids.map(() => '?').join(',');
    const subscriptions = db.prepare(`
      SELECT s.*, b.name AS business_name FROM subscriptions s
      JOIN businesses b ON b.id = s.business_id
      WHERE s.business_id IN (${placeholders})
      ORDER BY s.created_at DESC
    `).all(...ids)
      .map((s) => ({ ...formatSubscription(s), business_name: s.business_name }));
    res.json({
      subscriptions,
      plans: PLAN_CATALOG,
      trial_days: PRO_TRIAL_DAYS,
      notice: `Claimed venues unlock Pro · Free trial (${PRO_TRIAL_DAYS} days). Scheduling, ad bidding, and analytics are included — no paywall during trial.`,
    });
  });

  /** Preview logo from name/website before creating a venue */
  app.post('/api/logos/lookup', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const name = String(req.body.name || '').trim();
    let website = String(req.body.website || '').trim();
    if (!website && name && KNOWN_WEBSITES[name]) website = KNOWN_WEBSITES[name];
    const domain = domainFromWebsite(website);
    if (!domain) {
      return res.json({
        status: 'missing',
        logo_url: null,
        logo_source: null,
        website: website || null,
        hint: 'Add a website to search for a logo, or upload one.',
      });
    }
    const candidates = [
      { source: 'clearbit', url: `https://logo.clearbit.com/${domain}` },
      { source: 'google_favicon', url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128` },
      { source: 'duckduckgo', url: `https://icons.duckduckgo.com/ip3/${domain}.ico` },
    ];
    for (const cand of candidates) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(cand.url, { signal: ctrl.signal, headers: { 'User-Agent': 'ON-GO-LogoBot/1.0' } });
        clearTimeout(t);
        if (r.ok) {
          return res.json({
            status: 'found',
            logo_url: cand.url,
            logo_source: cand.source,
            website,
            domain,
          });
        }
      } catch {
        /* try next */
      }
    }
    res.json({
      status: 'missing',
      logo_url: null,
      logo_source: 'missing',
      website,
      domain,
      hint: 'No logo found — upload one after saving.',
    });
  });

  /** Business owner adds a new venue (auto Pro trial + logo fetch) */
  app.post('/api/businesses', async (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const name = String(req.body.name || '').trim();
    const area = String(req.body.area || '').trim();
    const category = String(req.body.category || 'Dinner').trim();
    const address = String(req.body.address || '').trim();
    let website = String(req.body.website || '').trim();
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (!name || !area) {
      return res.status(400).json({ error: 'name and area required' });
    }
    if (!website && KNOWN_WEBSITES[name]) website = KNOWN_WEBSITES[name];
    const id = uuid();
    const ts = nowIso();
    const slugBase = name
      .toLowerCase()
      .replace(/['']/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    let slug = slugBase || id.slice(0, 8);
    if (db.prepare('SELECT 1 AS ok FROM businesses WHERE slug = ?').get(slug)) {
      slug = `${slug}-${id.slice(0, 6)}`;
    }
    const useLat = Number.isFinite(lat) ? lat : 30.324;
    const useLng = Number.isFinite(lng) ? lng : -81.3965;
    db.prepare(`
      INSERT INTO businesses (
        id, name, slug, area, category, address, phone, website, hours_json,
        lat, lng, status, claimed_by_user_id, is_directory_only, featured_until, osm_ref, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '', ?, '{}', ?, ?, 'participating', ?, 0, NULL, NULL, ?, ?)
    `).run(id, name, slug, area, category, address, website, useLat, useLng, req.user.id, ts, ts);
    db.prepare(`
      INSERT INTO business_members (id, business_id, user_id, member_role, created_at)
      VALUES (?, ?, ?, 'owner', ?)
    `).run(uuid(), id, req.user.id, ts);
    assignProTrial(db, id, { now: ts });

    let logo = { logo_url: null, logo_source: 'missing', status: 'missing' };
    if (req.body.logo_url && req.body.logo_source) {
      db.prepare(
        `UPDATE businesses SET logo_url = ?, logo_source = ?, logo_updated_at = ?, updated_at = ? WHERE id = ?`
      ).run(req.body.logo_url, req.body.logo_source, ts, ts, id);
      logo = { logo_url: req.body.logo_url, logo_source: req.body.logo_source, status: 'found' };
    } else {
      const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
      logo = await resolveLogoForBusiness(db, biz, { force: true });
    }

    if (req.body.image_base64) {
      const dataUrl = String(req.body.image_base64);
      const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (match) {
        logo = await saveUploadedLogo(db, id, {
          buffer: Buffer.from(match[2], 'base64'),
          contentType: match[1],
        });
      }
    }

    touch();
    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
    const sub = db.prepare(
      'SELECT * FROM subscriptions WHERE business_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(id);
    res.status(201).json({
      business: {
        ...business,
        logo_status: logo.status,
        subscription: formatSubscription(sub),
      },
      notice: `Venue added with Pro · Free trial (${PRO_TRIAL_DAYS} days).`,
    });
  });

  app.get('/api/meta/areas', (_req, res) => {
    res.json({
      areas: ['Atlantic Beach', 'Neptune Beach', 'Jacksonville Beach', 'Ponte Vedra Beach'],
      categories: ['Coffee', 'Breakfast', 'Lunch', 'Bar', 'Dinner'],
      radius_options_mi: [1, 2, 5, 10],
      beta: beta.betaDefaults(),
    });
  });

  app.get('/api/beta/defaults', (_req, res) => {
    res.json(beta.betaDefaults());
  });

  /** Member in-app venue QR check-in — GPS required; QR alone never awards. */
  app.post('/api/visits/check-in', (req, res) => {
    if (!requireRole(req, res, ['customer'])) return;
    if (!requireVerified(req, res)) return;
    beta.expireCampaignsAndLimits(db);

    const { venue_token, qr, lat, lng, accuracy_m, offer_id } = req.body || {};
    const token = beta.parseVenueQr(venue_token || qr || '');
    if (!token) {
      return res.status(400).json({ error: 'Scan the venue QR inside ON GO' });
    }

    const business = db.prepare('SELECT * FROM businesses WHERE qr_token = ?').get(token);
    if (!business) return res.status(404).json({ error: 'Unknown venue QR' });

    let offer = null;
    if (offer_id) {
      offer = db.prepare('SELECT * FROM offers WHERE id = ? AND business_id = ?').get(offer_id, business.id);
    } else {
      offer = beta.activeCampaignForBusiness(db, business.id);
    }
    if (!offer) {
      return res.status(400).json({
        error: 'No live campaign at this venue right now',
        business: { id: business.id, name: business.name },
      });
    }

    const result = beta.awardQualifyingVisit(db, {
      user: req.user,
      business,
      offer,
      lat,
      lng,
      accuracyM: accuracy_m,
      actorUserId: req.user.id,
    });
    touch();
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.status(201).json(result);
  });

  app.get('/api/businesses/:id/venue-qr', async (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    if (!userCanManageBusiness(db, req.user.id, b.id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not manage this business' });
    }
    if (!b.qr_token) {
      const token = require('crypto').randomBytes(16).toString('hex');
      db.prepare('UPDATE businesses SET qr_token = ? WHERE id = ?').run(token, b.id);
      b.qr_token = token;
      touch();
    }
    const payload = beta.venueQrPayload(b.qr_token);
    const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const deepLink = `${base.replace(/\/$/, '')}/?scan=${encodeURIComponent(b.qr_token)}`;
    const qr_data_url = await QRCode.toDataURL(payload, {
      margin: 1,
      width: 512,
      color: { dark: '#0a0f0c', light: '#ffffff' },
    });
    res.json({
      business_id: b.id,
      name: b.name,
      qr_token: b.qr_token,
      payload,
      deep_link: deepLink,
      qr_data_url,
      print_hint: 'Redeem in app. Scan for points.',
    });
  });

  app.get('/api/businesses/:id/print', async (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    if (!userCanManageBusiness(db, req.user.id, b.id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not manage this business' });
    }
    if (!b.qr_token) {
      return res.status(400).json({ error: 'Venue QR not ready — open venue QR first' });
    }
    const payload = beta.venueQrPayload(b.qr_token);
    const qr_data_url = await QRCode.toDataURL(payload, {
      margin: 1,
      width: 640,
      color: { dark: '#0a0f0c', light: '#ffffff' },
    });
    const layout = String(req.query.layout || 'cling');
    const title = layout === 'counter' ? 'Counter sign' : 'Window cling';
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>ON GO · ${escapeHtmlLite(b.name)} · ${title}</title>
<style>
  @page { margin: 0.4in; }
  body { font-family: Outfit, Arial, sans-serif; background: #fff; color: #0a0f0c; margin: 0; }
  .sheet { border: 3px solid #1aff5a; border-radius: 18px; padding: 1.25rem; max-width: 5.5in; margin: 0.5in auto; text-align: center; }
  .counter { max-width: 3.5in; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-bottom: 0.5rem; }
  .brand img { width: 48px; height: 48px; }
  h1 { font-family: Syne, Arial Black, sans-serif; font-size: 1.35rem; margin: 0.2rem 0; letter-spacing: 0.04em; }
  .venue { font-size: 1.1rem; font-weight: 700; margin: 0.4rem 0 0.8rem; }
  img.qr { width: 2.6in; height: 2.6in; }
  .counter img.qr { width: 1.8in; height: 1.8in; }
  .hint { font-size: 1rem; font-weight: 700; margin-top: 0.75rem; color: #087d32; }
  .sub { font-size: 0.8rem; color: #445; margin-top: 0.35rem; }
  @media print { .noprint { display: none; } body { background: #fff; } }
</style></head><body>
  <p class="noprint" style="text-align:center"><button onclick="window.print()">Print</button></p>
  <div class="sheet ${layout === 'counter' ? 'counter' : ''}">
    <div class="brand">
      <img src="/assets/on-go-power-icon.png" alt="ON GO"/>
      <h1>ON GO</h1>
    </div>
    <p class="venue">${escapeHtmlLite(b.name)}</p>
    <img class="qr" src="${qr_data_url}" alt="Venue QR"/>
    <p class="hint">Redeem in app. Scan for points.</p>
    <p class="sub">Members open ON GO → Scan. Location required. Points are rewards, not cash.</p>
  </div>
</body></html>`;
    res.type('html').send(html);
  });

  app.get('/api/rewards', (req, res) => {
    const businessId = req.query.business_id;
    let rows;
    if (businessId) {
      rows = db.prepare(`
        SELECT r.*, b.name AS business_name
        FROM rewards r JOIN businesses b ON b.id = r.business_id
        WHERE r.business_id = ? AND r.status = 'active'
        ORDER BY r.points_cost ASC
      `).all(businessId);
    } else {
      rows = db.prepare(`
        SELECT r.*, b.name AS business_name, b.area
        FROM rewards r JOIN businesses b ON b.id = r.business_id
        WHERE r.status = 'active'
          AND (r.expires_at IS NULL OR r.expires_at > ?)
          AND r.quantity_remaining > 0
        ORDER BY r.created_at DESC
        LIMIT 100
      `).all(nowIso());
    }
    res.json({
      rewards: rows,
      redeem_window_days: beta.REWARD_REDEEM_DAYS,
      notice: 'Vendor-funded rewards (vendors fulfill). ON GO manages points ledger only. Points ≠ cash and do not expire in beta. Claimed codes: 30-day redemption window.',
    });
  });

  app.post('/api/rewards', (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const {
      business_id, title, description, terms, points_cost, quantity, expires_at,
    } = req.body || {};
    if (!business_id || !title || !points_cost || !quantity || !expires_at) {
      return res.status(400).json({
        error: 'business_id, title, points_cost, quantity, and listing end date (expires_at) required',
      });
    }
    if (!userCanManageBusiness(db, req.user.id, business_id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not manage this business' });
    }
    const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(business_id);
    if (!biz?.verified_at && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Venue must be verified before listing rewards' });
    }
    const listingEnd = new Date(expires_at);
    if (Number.isNaN(+listingEnd) || listingEnd <= new Date()) {
      return res.status(400).json({ error: 'Listing end date must be a future datetime' });
    }
    const ts = nowIso();
    const id = uuid();
    const qty = Math.max(1, Number(quantity) || 1);
    const cost = Math.max(1, Number(points_cost) || 1);
    db.prepare(`
      INSERT INTO rewards (
        id, business_id, title, description, terms, points_cost,
        quantity_total, quantity_remaining, expires_at, status,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      id,
      business_id,
      String(title).slice(0, 120),
      description ? String(description).slice(0, 500) : '',
      terms ? String(terms).slice(0, 800) : '',
      cost,
      qty,
      qty,
      listingEnd.toISOString(),
      req.user.id,
      ts,
      ts
    );
    beta.writeAudit(db, {
      actorUserId: req.user.id,
      action: 'reward_created',
      entityType: 'reward',
      entityId: id,
    });
    touch();
    res.status(201).json({ reward: db.prepare('SELECT * FROM rewards WHERE id = ?').get(id) });
  });

  app.post('/api/rewards/:id/claim', (req, res) => {
    if (!requireRole(req, res, ['customer'])) return;
    if (!requireVerified(req, res)) return;
    const reward = db.prepare('SELECT * FROM rewards WHERE id = ?').get(req.params.id);
    const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const result = beta.claimReward(db, { user: freshUser, reward });
    touch();
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.status(201).json(result);
  });

  app.post('/api/rewards/fulfill', (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const ids = businessIdsForUser(db, req.user.id);
    const result = beta.fulfillRewardCode(db, {
      user: req.user,
      code: req.body?.code,
      businessIds: ids,
    });
    touch();
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  });

  app.post('/api/rewards/redemptions/:id/cancel', (req, res) => {
    if (!requireAuth(req, res)) return;
    const ids = businessIdsForUser(db, req.user.id);
    const result = beta.cancelRewardRedemption(db, {
      user: req.user,
      redemptionId: req.params.id,
      businessIds: ids,
    });
    touch();
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  });

  app.get('/api/customer/reward-redemptions', (req, res) => {
    if (!requireRole(req, res, ['customer'])) return;
    const rows = db.prepare(`
      SELECT rr.*, rw.title AS reward_title, b.name AS business_name
      FROM reward_redemptions rr
      JOIN rewards rw ON rw.id = rr.reward_id
      JOIN businesses b ON b.id = rr.business_id
      WHERE rr.user_id = ?
      ORDER BY rr.claimed_at DESC
      LIMIT 50
    `).all(req.user.id);
    res.json({ redemptions: rows });
  });

  app.get('/api/business/results', (req, res) => {
    if (!requireRole(req, res, ['business', 'admin'])) return;
    const ids = businessIdsForUser(db, req.user.id);
    if (!ids.length && req.user.role !== 'admin') {
      return res.json({ results: [], notice: 'Qualifying visits — not sales or revenue.' });
    }
    const clause = req.user.role === 'admin' ? '1=1' : `o.business_id IN (${ids.map(() => '?').join(',')})`;
    const params = req.user.role === 'admin' ? [] : ids;
    const rows = db.prepare(`
      SELECT o.id, o.title, o.status, o.starts_at, o.ends_at,
        o.views_count, o.visits_count, o.points_awarded_total, o.redemption_limit,
        b.name AS business_name,
        (SELECT COUNT(*) FROM reward_redemptions rr
          WHERE rr.business_id = o.business_id AND rr.status = 'fulfilled'
            AND rr.fulfilled_at >= o.starts_at AND rr.fulfilled_at <= COALESCE(o.ends_at, rr.fulfilled_at)
        ) AS rewards_redeemed
      FROM offers o
      JOIN businesses b ON b.id = o.business_id
      WHERE ${clause}
      ORDER BY o.created_at DESC
      LIMIT 50
    `).all(...params);
    res.json({
      results: rows,
      notice: 'Views, qualifying visits, points awarded, rewards redeemed — never sales or revenue.',
    });
  });

  // —— Admin (minimal but real) ——
  app.get('/api/admin/overview', (req, res) => {
    if (!requireRole(req, res, ['admin'])) return;
    const pending = db.prepare(`
      SELECT id, name, area, status, claimed_by_user_id, verified_at, suspended_at, created_at
      FROM businesses
      WHERE status IN ('claimed', 'participating') AND verified_at IS NULL
      ORDER BY created_at DESC LIMIT 50
    `).all();
    const campaigns = db.prepare(`
      SELECT o.id, o.title, o.status, o.starts_at, o.ends_at, b.name AS business_name
      FROM offers o JOIN businesses b ON b.id = o.business_id
      ORDER BY o.created_at DESC LIMIT 40
    `).all();
    const rewards = db.prepare(`
      SELECT r.*, b.name AS business_name FROM rewards r
      JOIN businesses b ON b.id = r.business_id
      ORDER BY r.created_at DESC LIMIT 40
    `).all();
    const audit = db.prepare(`
      SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 60
    `).all();
    res.json({ pending_venues: pending, campaigns, rewards, audit, beta: beta.betaDefaults() });
  });

  app.post('/api/admin/venues/:id/approve', (req, res) => {
    if (!requireRole(req, res, ['admin'])) return;
    const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    const ts = nowIso();
    db.prepare(`
      UPDATE businesses SET verified_at = ?, status = CASE WHEN status = 'unclaimed' THEN status ELSE 'participating' END, updated_at = ?
      WHERE id = ?
    `).run(ts, ts, b.id);
    beta.writeAudit(db, {
      actorUserId: req.user.id,
      action: 'venue_approved',
      entityType: 'business',
      entityId: b.id,
    });
    touch();
    res.json({ business: db.prepare('SELECT * FROM businesses WHERE id = ?').get(b.id) });
  });

  app.post('/api/admin/venues/:id/suspend', (req, res) => {
    if (!requireRole(req, res, ['admin'])) return;
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Reason required' });
    const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    const ts = nowIso();
    db.prepare(`
      UPDATE businesses SET suspended_at = ?, suspend_reason = ?, updated_at = ? WHERE id = ?
    `).run(ts, reason, ts, b.id);
    db.prepare(`
      UPDATE offers SET status = 'deactivated', updated_at = ?
      WHERE business_id = ? AND status IN ('live', 'scheduled', 'paused')
    `).run(ts, b.id);
    beta.writeAudit(db, {
      actorUserId: req.user.id,
      action: 'venue_suspended',
      entityType: 'business',
      entityId: b.id,
      reason,
    });
    touch();
    res.json({ business: db.prepare('SELECT * FROM businesses WHERE id = ?').get(b.id) });
  });

  app.post('/api/admin/users/:id/suspend', (req, res) => {
    if (!requireRole(req, res, ['admin'])) return;
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Reason required' });
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    const ts = nowIso();
    db.prepare('UPDATE users SET suspended_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, u.id);
    beta.writeAudit(db, {
      actorUserId: req.user.id,
      action: 'user_suspended',
      entityType: 'user',
      entityId: u.id,
      reason,
    });
    touch();
    res.json({ ok: true });
  });

  app.post('/api/admin/points/adjust', (req, res) => {
    if (!requireRole(req, res, ['admin'])) return;
    const { user_id, delta, reason } = req.body || {};
    const result = beta.adjustPoints(db, {
      adminUser: req.user,
      targetUserId: user_id,
      delta,
      reason,
    });
    touch();
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  });

  app.patch('/api/me', (req, res) => {
    if (!requireAuth(req, res)) return;
    const { display_name, password, current_password } = req.body || {};
    const ts = nowIso();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!row) return res.status(401).json({ error: 'Not signed in' });
    if (display_name != null) {
      const name = String(display_name).trim().slice(0, 80);
      if (name.length < 1) return res.status(400).json({ error: 'display_name required' });
      db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').run(name, ts, row.id);
    }
    if (password) {
      if (!current_password || !verifyPassword(current_password, row.password_hash)) {
        return res.status(400).json({ error: 'Current password incorrect' });
      }
      if (String(password).length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters' });
      }
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(hashPassword(password), ts, row.id);
    }
    touch();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
    res.json({ user: publicUser(user) });
  });


  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });

  return app;
}

const PLAN_CATALOG = [
  { id: 'free', label: 'Directory', price_monthly_cents: 0, perks: ['Public listing'] },
  { id: 'starter', label: 'Starter', price_monthly_cents: 4900, perks: ['Live offers', 'QR verify', 'Basic analytics'] },
  { id: 'pro', label: 'Pro', price_monthly_cents: 9900, perks: ['Scheduling', 'Ad bidding', 'Priority support'] },
];

ready = (async () => {
  const opened = await openDb();
  db = opened.db;
  seedResult = opened.seedResult;
  dbPath = opened.dbPath;
  schedulePersist = opened.schedulePersist;
  persistNow = flushDb;
})();

const app = createApp();

async function start() {
  await ready;
  if (require.main === module) {
    app.listen(PORT, () => {
      console.log(`ON GO listening on http://localhost:${PORT}`);
      console.log(`SQLite: ${dbPath}`);
      if (seedResult.seeded) {
        console.log(`Seeded ${seedResult.businesses} businesses + demo accounts`);
      }
    });
  }
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

module.exports = {
  app,
  ready,
  syncDbFromStore,
  get persistNow() {
    return flushDb;
  },
  get db() {
    return db;
  },
};
