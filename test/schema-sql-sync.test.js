'use strict';

/* =============================================================================
 * Verify src/schema-sql.ts (inlined DDL) stays in sync with schema.sql.
 * To change the schema, edit only schema.sql, then run `npm run schema:sync` to regenerate.
 *
 * Run: node test/schema-sql-sync.test.js
 * Exit code: 0 = pass; 1 = out of sync / parse failure.
 * ===========================================================================*/

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error('FAIL: ' + msg); }
}

const root = path.join(__dirname, '..');

const sql = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
const expected = sql
  .replace(/--[^\r\n]*/g, '')
  .split(/\r?\n/)
  .map((l) => l.replace(/\s+$/, ''))
  .filter((l) => l.trim().length > 0)
  .join('\n');

const ts = fs.readFileSync(path.join(root, 'src', 'schema-sql.ts'), 'utf8');
const m = ts.match(/`([\s\S]*)`/);
ok(Boolean(m), 'src/schema-sql.ts 含模板字符串');
const actual = (m ? m[1] : '').replace(/\r\n/g, '\n');

ok(
  actual === expected,
  'src/schema-sql.ts 与 schema.sql 不同步（改 schema.sql 后请运行 npm run schema:sync）',
);

console.log(`schema-sql-sync: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
