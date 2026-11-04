'use strict';

/**
 * Netlify Function wrapping the Express app.
 * Redirects: /api/* → /.netlify/functions/api/:splat
 *
 * Blobs require connectLambda(event) under the Lambda/serverless-http
 * runtime — without it every request reseeds an empty DB and sessions die.
 */
process.env.NETLIFY = 'true';

const { connectLambda } = require('@netlify/blobs');
const serverless = require('serverless-http');
const server = require('../../server');

const wrapped = serverless(server.app, { binary: ['image/*'] });

exports.handler = async (event, context) => {
  // Must run before any getStore() / openDb reload from Blobs
  try {
    connectLambda(event);
  } catch (err) {
    console.warn('connectLambda failed:', err.message);
  }

  await server.ready;

  if (event.path && event.path.startsWith('/.netlify/functions/api')) {
    const rest = event.path.slice('/.netlify/functions/api'.length) || '';
    event.path = '/api' + rest;
  }
  if (event.rawPath && event.rawPath.startsWith('/.netlify/functions/api')) {
    const rest = event.rawPath.slice('/.netlify/functions/api'.length) || '';
    event.rawPath = '/api' + rest;
  }

  try {
    const result = await wrapped(event, context);
    if (typeof server.persistNow === 'function') {
      await server.persistNow();
    }
    return result;
  } catch (err) {
    console.error(err);
    try {
      if (typeof server.persistNow === 'function') await server.persistNow();
    } catch {
      /* ignore */
    }
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Function error', detail: String(err.message || err) }),
    };
  }
};
