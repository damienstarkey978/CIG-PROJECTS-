'use strict';

/**
 * Netlify Function wrapping the Express app.
 * Redirects: /api/* → /.netlify/functions/api/:splat
 */
process.env.NETLIFY = 'true';

const serverless = require('serverless-http');
const server = require('../../server');

const wrapped = serverless(server.app, { binary: ['image/*'] });

exports.handler = async (event, context) => {
  await server.ready;

  if (event.path && event.path.startsWith('/.netlify/functions/api')) {
    const rest = event.path.slice('/.netlify/functions/api'.length) || '';
    event.path = '/api' + rest;
  }
  if (event.rawPath && event.rawPath.startsWith('/.netlify/functions/api')) {
    const rest = event.rawPath.slice('/.netlify/functions/api'.length) || '';
    event.rawPath = '/api' + rest;
  }

  // Express mounted routes expect /api/... — also handle bare splat
  if (event.path === '/api' && event.rawQuery) {
    /* keep */
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
