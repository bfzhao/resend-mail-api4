'use strict';

// Generates src/schema-sql.ts from schema.sql (pure DDL with comments stripped).
// Run: npm run schema:sync
// Inlined rather than importing schema.sql at runtime: both the Worker and the backend tests are compiled with tsc, which cannot handle .sql text imports.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');

const ddl = sql
  .replace(/--[^\r\n]*/g, '')
  .split(/\r?\n/)
  .map((l) => l.replace(/\s+$/, ''))
  .filter((l) => l.trim().length > 0)
  .join('\n');

if (ddl.includes('`')) throw new Error('DDL 含反引号，无法内联为模板字符串');
if (ddl.includes('${')) throw new Error('DDL 含 ${，会破坏模板字符串插值');

const header =
  '// This file is generated from schema.sql (pure DDL with comments stripped); do not edit by hand.\n' +
  '// To change the schema, edit schema.sql then run: npm run schema:sync\n' +
  '// Inlined rather than importing schema.sql directly: both the Worker and the tests are compiled with tsc, which cannot handle .sql text imports.\n';

fs.writeFileSync(path.join(root, 'src', 'schema-sql.ts'), `${header}export const SCHEMA_SQL = \`${ddl}\`;\n`, 'utf8');
console.log(`schema-sql.ts 已同步（${ddl.split('\n').length} 行 DDL）`);
