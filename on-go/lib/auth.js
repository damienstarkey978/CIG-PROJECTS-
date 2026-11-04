'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { nowIso, uuid } = require('./db');

const SESSION_DAYS = 14;
const COOKIE_NAME = 'ongo_sid';

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function createSession(db, userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, userId, expires, nowIso());
  return { id, expires };
}

function destroySession(db, sessionId) {
  if (!sessionId) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function getUserFromSession(db, sessionId) {
  if (!sessionId) return null;
  const row = db.prepare(`
    SELECT u.*, s.expires_at AS session_expires
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sessionId);
  if (!row) return null;
  if (new Date(row.session_expires) <= new Date()) {
    destroySession(db, sessionId);
    return null;
  }
  delete row.password_hash;
  delete row.session_expires;
  return row;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    points_balance: user.points_balance,
    email_verified: Boolean(user.email_verified_at),
  };
}

function isEmailVerified(user) {
  return Boolean(user && user.email_verified_at);
}

/** Demo / ops accounts that skip the verify gate */
function isTrustedDemoEmail(email) {
  const e = String(email || '').toLowerCase();
  return e.endsWith('@ongo.demo');
}

function requireAuth(req, res) {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in required' });
    return false;
  }
  return true;
}

function requireRole(req, res, roles) {
  if (!requireAuth(req, res)) return false;
  if (!roles.includes(req.user.role)) {
    res.status(403).json({ error: 'Not allowed for this account type' });
    return false;
  }
  return true;
}

function businessIdsForUser(db, userId) {
  return db.prepare(`
    SELECT business_id FROM business_members WHERE user_id = ?
  `).all(userId).map((r) => r.business_id);
}

function userCanManageBusiness(db, userId, businessId) {
  const row = db.prepare(`
    SELECT 1 FROM business_members WHERE user_id = ? AND business_id = ?
  `).get(userId, businessId);
  return Boolean(row);
}

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  getUserFromSession,
  publicUser,
  isEmailVerified,
  isTrustedDemoEmail,
  requireAuth,
  requireRole,
  businessIdsForUser,
  userCanManageBusiness,
  randomToken,
  uuid,
};
