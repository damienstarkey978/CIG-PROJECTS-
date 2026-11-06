'use strict';

/**
 * Optional outbound email via Resend (https://resend.com).
 * Set RESEND_API_KEY (+ optional EMAIL_FROM) on Netlify to send real mail.
 * Without it, verification/reset links are returned in API JSON for ops/testing.
 */

async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'ON GO <onboarding@resend.dev>';
  if (!key) {
    return { sent: false, reason: 'RESEND_API_KEY not configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { sent: false, reason: data.message || res.statusText || 'send failed' };
    }
    return { sent: true, id: data.id };
  } catch (err) {
    return { sent: false, reason: err.message || 'send failed' };
  }
}

function appBaseUrl(req) {
  const env = process.env.APP_BASE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (env) return env.replace(/\/$/, '');
  if (req) {
    const host = req.get('x-forwarded-host') || req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    if (host) return `${proto}://${host}`;
  }
  return 'https://ongo-app.com';
}

async function sendVerificationEmail({ to, token, req }) {
  const base = appBaseUrl(req);
  const link = `${base}/?verify=${encodeURIComponent(token)}`;
  const subject = 'Verify your ON GO account';
  const text = `Verify your ON GO email:\n\n${link}\n\nIf you did not create an account, ignore this message.`;
  const html = `<p>Welcome to <strong>ON GO</strong>.</p><p><a href="${link}">Verify your email</a> to start using the app.</p><p style="color:#666;font-size:12px">${link}</p>`;
  const result = await sendEmail({ to, subject, html, text });
  return { ...result, link };
}

async function sendPasswordResetEmail({ to, token, req }) {
  const base = appBaseUrl(req);
  const link = `${base}/?reset=${encodeURIComponent(token)}`;
  const subject = 'Reset your ON GO password';
  const text = `Reset your ON GO password:\n\n${link}\n\nThis link expires in 1 hour.`;
  const html = `<p>Reset your <strong>ON GO</strong> password:</p><p><a href="${link}">Choose a new password</a></p><p style="color:#666;font-size:12px">${link}</p>`;
  const result = await sendEmail({ to, subject, html, text });
  return { ...result, link };
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  appBaseUrl,
};
