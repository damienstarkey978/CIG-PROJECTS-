'use strict';

/**
 * One-shot enrichment for seeded Beaches venues.
 * Usage: node scripts/enrich-venues.js [--force]
 */
const { openDb } = require('../lib/db');
const { enrichAllBusinesses } = require('../lib/enrich');

(async () => {
  const force = process.argv.includes('--force');
  const { db, persistNow } = await openDb();
  console.log('Enriching venues (force=%s)…', force);
  const summary = await enrichAllBusinesses(db, { force, concurrency: 3 });
  await persistNow();
  console.log(JSON.stringify(summary, null, 2));
  const withAbout = db
    .prepare(`SELECT COUNT(*) AS n FROM businesses WHERE about_text IS NOT NULL AND about_text != ''`)
    .get().n;
  const withHours = db
    .prepare(`SELECT COUNT(*) AS n FROM businesses WHERE hours_display IS NOT NULL AND hours_display != ''`)
    .get().n;
  const withMenu = db
    .prepare(`SELECT COUNT(*) AS n FROM businesses WHERE menu_url IS NOT NULL AND menu_url != ''`)
    .get().n;
  console.log(`summary: about=${withAbout} hours=${withHours} menu=${withMenu} / ${summary.total}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
