'use strict';

/**
 * Deletes the SQLite file and recreates schema + seed on next openDb().
 * Usage: npm run seed
 */
const fs = require('fs');
const path = require('path');
const { openDb, DB_PATH } = require('../lib/db');

for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

const { seedResult, dbPath } = openDb();
console.log('Database ready at', dbPath);
console.log('Seeded:', seedResult);
process.exit(0);
