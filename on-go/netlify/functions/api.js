'use strict';

/**
 * Netlify Function wrapping the Express app.
 * Redirects: /api/* → /.netlify/functions/api/:splat
 *
 * Stripe webhooks are handled here with the raw `event.body` so signature
 * verification works under serverless-http (which would otherwise parse JSON).
 */
process.env.NETLIFY = 'true';

const serverless = require('serverless-http');
const server = require('../../server');

const wrapped = serverless(server.app, { binary: ['image/*'] });

function normalizeApiPath(event) {
  let p = event.path || event.rawPath || '';
  if (p.startsWith('/.netlify/functions/api')) {
    const rest = p.slice('/.netlify/functions/api'.length) || '';
    p = '/api' + rest;
  }
  return p;
}

function rawBodyFromEvent(event) {
  if (event.isBase64Encoded && event.body) {
    return Buffer.from(event.body, 'base64');
  }
  if (Buffer.isBuffer(event.body)) return event.body;
  if (typeof event.body === 'string') return Buffer.from(event.body);
  if (event.body != null) return Buffer.from(JSON.stringify(event.body));
  return Buffer.alloc(0);
}

function isBillingWebhook(path) {
  return path === '/api/billing/webhook' || path.endsWith('/billing/webhook');
}

exports.handler = async (event, context) => {
  await server.ready;

  const apiPath = normalizeApiPath(event);
  event.path = apiPath;
  if (event.rawPath) event.rawPath = apiPath;

  // Stripe webhook — verify with exact raw body before Express parses JSON
  if (event.httpMethod === 'POST' && isBillingWebhook(apiPath)) {
    try {
      const signature =
        (event.headers && (event.headers['stripe-signature'] || event.headers['Stripe-Signature'])) ||
        '';
      if (!signature) {
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'Missing stripe-signature header' }),
        };
      }
      const result = await server.handleStripeWebhook(rawBodyFromEvent(event), signature);
      if (typeof server.persistNow === 'function') {
        await server.persistNow();
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(result),
      };
    } catch (err) {
      console.error('Stripe webhook (netlify):', err.message);
      return {
        statusCode: err.status || 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: err.message || 'Webhook error' }),
      };
    }
  }

  try {
    const result = await wrapped(event, context);
    if (typeof server.persistNow === 'function') {
      await server.persistNow();
    }
    return result;
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Function error', detail: String(err.message || err) }),
    };
  }
};
