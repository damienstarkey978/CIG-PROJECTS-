'use strict';

/**
 * One-shot: resolve logos for every business in the local/Netlify DB.
 *   cd on-go && node scripts/fetch-logos.js
 */
const { openDb } = require('../lib/db');
const { resolveLogosBatch, ensureLogoColumns, backfillWebsites } = require('../lib/logos');

(async () => {
  const { db, persistNow } = await openDb();
  ensureLogoColumns(db);
  backfillWebsites(db);
  const rows = db.prepare('SELECT * FROM businesses ORDER BY name ASC').all();
  console.log(`Resolving logos for ${rows.length} venues…`);
  const resolved = await resolveLogosBatch(db, rows, { limit: rows.length, force: false, concurrency: 4 });
  await persistNow();
  const found = resolved.filter((r) => r.status === 'found').length;
  const missing = resolved.filter((r) => r.status === 'missing').length;
  console.log(`Done. attempted=${resolved.length} found=${found} missing=${missing}`);
  const summary = db
    .prepare(`SELECT logo_source AS source, COUNT(*) AS n FROM businesses GROUP BY logo_source`)
    .all();
  console.table(summary);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
