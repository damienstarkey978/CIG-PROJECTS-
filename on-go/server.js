'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');
const { openDb, expireOffers, nowIso, uuid } = require('./lib/db');
const {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  getUserFromSession,
  publicUser,
  requireAuth,
  requireRole,
  businessIdsForUser,
  userCanManageBusiness,
  randomToken,
} = require('./lib/auth');

const PORT = Number(process.env.PORT) || 3847;
const { db, seedResult, dbPath } = openDb();

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser(process.env.SESSION_SECRET || 'on-go-dev-secret'));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, _res, next) => {
  expireOffers(db);
  req.user = getUserFromSession(db, req.cookies[COOKIE_NAME]);
  next();
});

function setSessionCookie(res, session) {
  res.cookie(COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: new Date(session.expires),
    path: '/',
  });
}

function liveOfferClause() {
  return `o.status IN ('live', 'scheduled') AND o.starts_at <= ? AND o.ends_at > ?`;
}

function attachLiveOffer(businessRow, now) {
  const offer = db.prepare(`
    SELECT id, title, description, product_label, starts_at, ends_at,
           redemption_limit, redemption_count, points_reward, status
    FROM offers o
    WHERE o.business_id = ? AND ${liveOfferClause()}
    ORDER BY o.starts_at ASC
    LIMIT 1
  `).get(businessRow.id, now, now);
  return { ...businessRow, live_offer: offer || null };
}

function statusLabel(status) {
  if (status === 'participating') return 'Participating';
  if (status === 'claimed') return 'Claimed · not yet live';
  return 'Directory listing · Not participating';
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'on-go',
    db: path.basename(dbPath),
    seeded_on_boot: seedResult.seeded,
  });
});

app.get('/api/businesses', (req, res) => {
  const now = nowIso();
  const { area, category, live, q } = req.query;
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
  if (live === '1' || live === 'true') {
    rows = rows.filter((b) => b.live_offer);
  }
  res.json({
    count: rows.length,
    live_count: rows.filter((b) => b.live_offer).length,
    businesses: rows.map((b) => ({
      ...b,
      status_label: statusLabel(b.status),
      endorsement_note:
        b.status === 'unclaimed'
          ? 'Listed from public directory data. This venue has not endorsed ON GO.'
          : null,
    })),
  });
});

app.get('/api/businesses/:id', (req, res) => {
  const now = nowIso();
  const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Business not found' });
  const withOffer = attachLiveOffer(b, now);
  res.json({
    ...withOffer,
    status_label: statusLabel(b.status),
  });
});

app.post('/api/auth/register', (req, res) => {
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
  try {
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, email, password_hash, display_name, role, points_balance, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `).run(id, email, hashPassword(password), display_name, role, ts, ts);

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
      }
    });
    tx();
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Registration failed' });
  }

  const session = createSession(db, id);
  setSessionCookie(res, session);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  delete user.password_hash;
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const session = createSession(db, user.id);
  setSessionCookie(res, session);
  delete user.password_hash;
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(db, req.cookies[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null, businesses: [] });
  const businesses = businessIdsForUser(db, req.user.id).map((id) =>
    db.prepare('SELECT id, name, area, status FROM businesses WHERE id = ?').get(id)
  );
  res.json({ user: publicUser(req.user), businesses });
});

app.post('/api/offers', (req, res) => {
  if (!requireRole(req, res, ['business', 'admin'])) return;
  const {
    business_id,
    title,
    description,
    product_label,
    duration_minutes,
    starts_at,
    ends_at,
    redemption_limit,
    points_reward,
  } = req.body || {};

  if (!business_id || !title) {
    return res.status(400).json({ error: 'business_id and title required' });
  }
  if (!userCanManageBusiness(db, req.user.id, business_id) && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You do not manage this business' });
  }

  const start = starts_at ? new Date(starts_at) : new Date();
  let end;
  if (ends_at) end = new Date(ends_at);
  else {
    const mins = Math.min(Math.max(Number(duration_minutes) || 60, 5), 24 * 60);
    end = new Date(start.getTime() + mins * 60 * 1000);
  }
  if (!(start instanceof Date) || Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return res.status(400).json({ error: 'Invalid start/end times' });
  }

  const ts = nowIso();
  const id = uuid();
  const status = start <= new Date() ? 'live' : 'scheduled';

  // Deactivate other live offers for this business (one live promo at a time for MVP clarity)
  db.prepare(`
    UPDATE offers SET status = 'deactivated', updated_at = ?
    WHERE business_id = ? AND status IN ('live', 'scheduled')
  `).run(ts, business_id);

  db.prepare(`
    INSERT INTO offers (
      id, business_id, title, description, product_label, status,
      starts_at, ends_at, redemption_limit, redemption_count, points_reward,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(
    id,
    business_id,
    String(title).slice(0, 120),
    description ? String(description).slice(0, 500) : '',
    product_label ? String(product_label).slice(0, 120) : '',
    status,
    start.toISOString(),
    end.toISOString(),
    redemption_limit != null && redemption_limit !== '' ? Number(redemption_limit) : null,
    Number(points_reward) || 25,
    req.user.id,
    ts,
    ts
  );

  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(id);
  res.status(201).json({ offer });
});

app.post('/api/offers/:id/deactivate', (req, res) => {
  if (!requireRole(req, res, ['business', 'admin'])) return;
  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  if (!userCanManageBusiness(db, req.user.id, offer.business_id) && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You do not manage this business' });
  }
  db.prepare(`UPDATE offers SET status = 'deactivated', updated_at = ? WHERE id = ?`).run(
    nowIso(),
    offer.id
  );
  res.json({ offer: db.prepare('SELECT * FROM offers WHERE id = ?').get(offer.id) });
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

app.post('/api/offers/:id/claim', async (req, res) => {
  if (!requireRole(req, res, ['customer'])) return;
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

  const customer = db.prepare('SELECT display_name, points_balance FROM users WHERE id = ?').get(
    redemption.user_id
  );
  res.json({
    ok: true,
    points_awarded: points,
    customer,
    redemption: db.prepare('SELECT * FROM redemptions WHERE id = ?').get(redemption.id),
  });
});

app.get('/api/loyalty/history', (req, res) => {
  if (!requireAuth(req, res)) return;
  const rows = db.prepare(`
    SELECT l.*, r.offer_id, o.title AS offer_title, b.name AS business_name
    FROM loyalty_ledger l
    LEFT JOIN redemptions r ON r.id = l.redemption_id
    LEFT JOIN offers o ON o.id = r.offer_id
    LEFT JOIN businesses b ON b.id = r.business_id
    WHERE l.user_id = ?
    ORDER BY l.created_at DESC
    LIMIT 100
  `).all(req.user.id);
  res.json({
    points_balance: req.user.points_balance,
    history: rows,
  });
});

app.get('/api/customer/claims', (req, res) => {
  if (!requireRole(req, res, ['customer'])) return;
  const rows = db.prepare(`
    SELECT r.*, o.title AS offer_title, o.ends_at, b.name AS business_name
    FROM redemptions r
    JOIN offers o ON o.id = r.offer_id
    JOIN businesses b ON b.id = r.business_id
    WHERE r.user_id = ?
    ORDER BY r.claimed_at DESC
    LIMIT 50
  `).all(req.user.id);
  res.json({ claims: rows });
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

app.post('/api/ads/bids', (req, res) => {
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
  const id = uuid();
  db.prepare(`
    INSERT INTO bids (id, inventory_id, business_id, user_id, amount_cents, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'simulated', ?)
  `).run(id, inventory_id, business_id, req.user.id, amount_cents, nowIso());
  res.status(201).json({
    bid: db.prepare('SELECT * FROM bids WHERE id = ?').get(id),
    notice: 'Simulation only. No charge or placement guarantee.',
  });
});

app.get('/api/meta/areas', (_req, res) => {
  res.json({
    areas: ['Atlantic Beach', 'Neptune Beach', 'Jacksonville Beach', 'Ponte Vedra Beach'],
    categories: ['Coffee', 'Breakfast', 'Lunch', 'Bar', 'Dinner'],
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`ON GO listening on http://localhost:${PORT}`);
  console.log(`SQLite: ${dbPath}`);
  if (seedResult.seeded) {
    console.log(`Seeded ${seedResult.businesses} businesses + demo accounts`);
  }
});
