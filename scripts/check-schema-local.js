'use strict';
/* Does SCHEMA_SQL apply cleanly to a real SQLite engine? If this fails, the DDL itself is the problem. */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');

const db = new DatabaseSync(':memory:');
try {
  db.exec(sql);
  console.log('OK: schema applied');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all();
  console.log('tables :', tables.map((t) => t.name).join(', '));
  console.log('indexes:', indexes.length);
  // idempotency: run again
  db.exec(sql);
  console.log('OK: second run is a no-op (idempotent)');
} catch (e) {
  console.log('FAILED:', e.message);
  process.exit(1);
}
