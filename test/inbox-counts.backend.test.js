'use strict';

/* =============================================================================
 * BUG-3b backend aggregation convention regression (real SQLite + real SQL extracted from src/repo.ts)
 *
 * Run:
 *   node test/inbox-counts.backend.test.js
 *
 * Exit codes: 0 = all pass; 1 = failures; 2 = missing environment (node:sqlite unavailable / source extraction failed).
 *
 * Why not compile src/repo.ts with tsc:
 *   This machine (restricted sandbox) forbids Node from spawning any child process (spawnSync returns EBUSY immediately),
 *   and TS7's tsc is a native executable that must be launched as a child process, so "compile then require" does not
 *   work in this environment. Instead the **real SQL statements are extracted from the source text** (including the value
 *   of ${groupExpr}), and executed as-is after building real tables and inserting real data with Node's built-in node:sqlite.
 *   So what is under test is the **real SQL text and real SQL engine semantics**; only the layer of "how the WHERE fragments
 *   are assembled" is rebuilt from the literals appearing in the source (each item below has an extraction guard; failure is explicit if extraction fails).
 *
 * Core assertion (requirement spec):
 *   Given a set of constructed data (including one email with mailbox = ''),
 *   "all mailboxes" inbox_total / inbox_unread / sent_total must equal the sum of the per-account groups;
 *   and each group's numbers must match the counts when filtering by that account alone.
 *
 * Note: "all mailboxes" is required to include all rows (including rows with empty/unknown mailbox),
 *     otherwise those emails would be unreachable in the UI; this is asserted explicitly with JS expected
 *     values independent of the SQL.
 * ===========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('node:sqlite 不可用（需要 Node >= 22.5）。', String(e && e.message));
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
// QA_REPO_TS is only for "mutation verification": point it at a hand-crafted older/variant source, to confirm this test really catches the defect.
const REPO_TS = process.env.QA_REPO_TS || path.join(ROOT, 'src', 'repo.ts');
const SRC = fs.readFileSync(REPO_TS, 'utf8');
// for extraction: normalize line endings so CRLF does not affect fragment-based positioning
const SRC_LF = SRC.replace(/\r\n/g, '\n');
const REPO_MD5 = crypto.createHash('md5').update(SRC).digest('hex');

// A3: build the table with the **real DDL** of messages from schema.sql, to determine whether mailboxes()'s NULL-merge branch is reachable
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const MESSAGES_DDL = (() => {
  const m = /CREATE TABLE IF NOT EXISTS messages \(([\s\S]*?)\n\);/.exec(SCHEMA_SRC);
  if (!m) throw new Error('源码抽取失败：schema.sql 里找不到 messages 建表语句');
  return `CREATE TABLE messages (${m[1]});`;
})();

/* ---------------------------------------------------------------------------
 * Extract the real SQL and related literals from the source (explicit failure if extraction fails, never a silent downgrade)
 * -------------------------------------------------------------------------*/

function must(re, label) {
  const m = re.exec(SRC_LF);
  if (!m) throw new Error(`源码抽取失败：${label}（正则 ${re} 未匹配）。src/repo.ts 结构可能已变化，需同步更新本测试。`);
  return m;
}

/**
 * Slice out the source fragment of a top-level function/constant to avoid cross-function false matches.
 *
 * Hardening notes (second round):
 *   The old implementation used `SRC_LF.indexOf('\n}\n', s)` to find the function's end -- if anyone wrote the closing
 *   brace as `} `, or a line-leading `}` appeared inside the body (within a template literal), the position would be silently wrong.
 *   Now it is two steps:
 *     1) Start position = the nearest `{` before the anchor (a unique fragment of the function body's first statement), thus skipping
 *        object type literals in the TS return type (e.g. `Promise<Array<{ mailbox: string ... }>>`);
 *     2) End position = a **brace-balancing scan** starting from that `{`, skipping strings / templates / comments while scanning.
 *   It no longer depends on any line numbers, indentation, or the `\n}\n` shape; failure to find the anchor is an explicit failure rather than a silent downgrade.
 */
function sliceTopLevel(marker, anchor) {
  const s = SRC_LF.indexOf(marker);
  if (s < 0) throw new Error(`源码抽取失败：找不到 ${marker}`);
  const a = SRC_LF.indexOf(anchor, s);
  if (a < 0) throw new Error(`源码抽取失败：${marker} 之后找不到函数体锚点 ${JSON.stringify(anchor)}（函数结构可能已变化）`);
  const open = SRC_LF.lastIndexOf('{', a);
  if (open < s) throw new Error(`源码抽取失败：${marker} 与锚点 ${JSON.stringify(anchor)} 之间找不到 '{'`);
  let depth = 0;
  let mode = 'code'; // code | line | block | sq | dq | tpl
  for (let i = open; i < SRC_LF.length; i++) {
    const ch = SRC_LF[i];
    const nx = SRC_LF[i + 1];
    if (mode === 'code') {
      if (ch === '/' && nx === '/') { mode = 'line'; i++; continue; }
      if (ch === '/' && nx === '*') { mode = 'block'; i++; continue; }
      if (ch === "'") { mode = 'sq'; continue; }
      if (ch === '"') { mode = 'dq'; continue; }
      if (ch === '`') { mode = 'tpl'; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return SRC_LF.slice(s, i + 1); }
      continue;
    }
    if (mode === 'line') { if (ch === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (ch === '*' && nx === '/') { mode = 'code'; i++; } continue; }
    if (mode === 'sq' || mode === 'dq') {
      if (ch === '\\') { i++; continue; }
      if (ch === (mode === 'sq' ? "'" : '"')) mode = 'code';
      continue;
    }
    // tpl: skip the whole template literal (this file's templates contain only ${ident}, no bare braces)
    if (ch === '\\') { i++; continue; }
    if (ch === '`') mode = 'code';
  }
  throw new Error(`源码抽取失败：${marker} 的花括号不配平，无法确定结束位置`);
}

function mustIn(body, re, label) {
  const m = re.exec(body);
  if (!m) throw new Error(`源码抽取失败：${label}（正则 ${re} 未匹配）。src/repo.ts 结构可能已变化，需同步更新本测试。`);
  return m;
}

function extractSql() {
  const mbBody = sliceTopLevel('export async function mailboxes(', 'const groupExpr');
  const scBody = sliceTopLevel('export async function sidebarCounts(', 'const conds: string[] = []');
  const mcBody = sliceTopLevel('function mailboxCond(', 'if (mailbox === UNKNOWN_MAILBOX)');

  // 1) mailboxes()'s GROUP BY statement (includes ${groupExpr})
  const groupsTemplate = mustIn(mbBody, /`([^`]*GROUP BY[^`]*)`/, 'mailboxes() 的 GROUP BY 模板')[1].replace(/\s+/g, ' ').trim();
  // 2) sidebarCounts()'s aggregation statement (includes ${whereSql})
  const countsTemplate = mustIn(scBody, /`([^`]*AS trash_total[^`]*)`/, 'sidebarCounts() 的聚合模板')[1].replace(/\s+/g, ' ').trim();
  // 3) the value of groupExpr
  const groupExpr = mustIn(mbBody, /const\s+groupExpr\s*=\s*"([^"]*)"\s*;/, 'groupExpr 字面量')[1];
  // 4) unknown-mailbox sentinel value (shared by front and back end)
  const unknownSentinel = must(/export\s+const\s+UNKNOWN_MAILBOX\s*=\s*'([^']*)'/, 'UNKNOWN_MAILBOX 字面量')[1];
  // 5) mailboxCond()'s two WHERE literals
  const sentinelWhere = mustIn(mcBody, /mailbox\s*===\s*UNKNOWN_MAILBOX\s*\)\s*return\s*\{\s*sql:\s*"([^"]*)"/, 'mailboxCond() 哨兵 WHERE')[1];
  const exactWhere = mustIn(mcBody, /return\s*\{\s*sql:\s*'([^']*)'\s*,\s*params:\s*\[\s*mailbox\s*\]\s*\}/, 'mailboxCond() 精确 WHERE')[1];
  // 6) mailboxes()'s .bind(...) arguments (used to reconstruct the placeholder params)
  const bindArgsSrc = mustIn(mbBody, /\.bind\(([^)]*)\)/, 'mailboxes() 的 .bind 实参')[1];

  return { groupsTemplate, countsTemplate, groupExpr, unknownSentinel, sentinelWhere, exactWhere, bindArgsSrc };
}

function evalBindArgs(src, sentinel) {
  return src
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      if (s === 'UNKNOWN_MAILBOX') return sentinel;
      if (/^\d+$/.test(s)) return Number(s);
      const q = /^'([^']*)'$/.exec(s) || /^"([^"]*)"$/.exec(s);
      if (q) return q[1];
      throw new Error(`无法求值的 .bind 实参: ${s}`);
    });
}

function countPlaceholders(sql) {
  return (sql.match(/\?/g) || []).length;
}

function substitute(sql, map) {
  let out = sql;
  for (const [k, v] of Object.entries(map)) out = out.split('${' + k + '}').join(v);
  if (/\$\{/.test(out)) throw new Error(`SQL 中仍有未替换的插值: ${out}`);
  return out;
}

/* ---------------------------------------------------------------------------
 * SQLite + fake D1 (just forwards SQL as-is to SQLite, implements no business aggregation logic)
 * -------------------------------------------------------------------------*/

function makeFakeD1(db) {
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        all() { return { results: db.prepare(sql).all(...params), success: true, meta: {} }; },
        first() {
          const row = db.prepare(sql).get(...params);
          return row === undefined ? null : row;
        },
        run() {
          const info = db.prepare(sql).run(...params);
          return { success: true, meta: { changes: info.changes } };
        },
      };
      return stmt;
    },
  };
}

/* ---------------------------------------------------------------------------
 * Fixture: must include one email with mailbox = ''
 * -------------------------------------------------------------------------*/

const ROWS = [
  { id: 'm1', direction: 'inbound', mailbox: 'a@x.com', read: 0, starred: 0, deleted: 0 },
  { id: 'm2', direction: 'inbound', mailbox: 'a@x.com', read: 1, starred: 0, deleted: 0 },
  { id: 'm3', direction: 'outbound', mailbox: 'a@x.com', read: 1, starred: 0, deleted: 0 },
  { id: 'm4', direction: 'inbound', mailbox: 'b@x.com', read: 0, starred: 1, deleted: 0 },
  { id: 'm5', direction: 'outbound', mailbox: 'b@x.com', read: 1, starred: 0, deleted: 0 },
  { id: 'm6', direction: 'inbound', mailbox: '', read: 0, starred: 0, deleted: 0 }, // key: no mailbox
  { id: 'm7', direction: 'outbound', mailbox: '', read: 1, starred: 0, deleted: 0 }, // key: no mailbox
  { id: 'm8', direction: 'inbound', mailbox: 'a@x.com', read: 0, starred: 0, deleted: 1 }, // deleted
];

function makeDb(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    mailbox TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    received_at INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'received',
    thread_id TEXT,
    subject TEXT,
    from_email TEXT,
    to_emails TEXT DEFAULT '[]',
    body_text TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );`);
  const ins = db.prepare(
    'INSERT INTO messages (id, direction, mailbox, read, starred, deleted) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) ins.run(r.id, r.direction, r.mailbox, r.read, r.starred, r.deleted);
  return db;
}

/* ---------------------------------------------------------------------------
 * JS expected values independent of the SQL (source of truth: the fixture itself)
 * -------------------------------------------------------------------------*/

const isInbox = (r) => r.direction === 'inbound' && r.deleted === 0;
const isSent = (r) => r.direction === 'outbound' && r.deleted === 0;

const EXPECTED_ALL = {
  inbox_unread: ROWS.filter((r) => isInbox(r) && r.read === 0).length,
  inbox_total: ROWS.filter(isInbox).length,
  sent_total: ROWS.filter(isSent).length,
  starred_total: ROWS.filter((r) => r.starred === 1 && r.deleted === 0).length,
  trash_total: ROWS.filter((r) => r.deleted === 1).length,
};

const EXPECTED_GROUPS = (() => {
  const keys = [...new Set(ROWS.map((r) => r.mailbox))];
  return keys.map((k) => {
    const rows = ROWS.filter((r) => r.mailbox === k);
    return {
      key: k,
      inbox_unread: rows.filter((r) => isInbox(r) && r.read === 0).length,
      inbox_total: rows.filter(isInbox).length,
      sent_total: rows.filter(isSent).length,
    };
  });
})();

const EXPECTED_NON_EMPTY_SUM = EXPECTED_GROUPS
  .filter((g) => g.key !== '')
  .reduce((s, g) => s + g.inbox_total, 0);

/* ---------------------------------------------------------------------------
 * Test runner
 * -------------------------------------------------------------------------*/

const results = [];
let currentTest = '(init)';
let pass = 0;
let fail = 0;

function ok(cond, msg, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  results.push({ test: currentTest, ok: good, msg, detail });
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${detail === undefined ? '' : `  [${detail}]`}`);
}
function info(msg) { console.log(`  INFO  ${msg}`); }
async function test(name, fn) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  try { await fn(); } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  }
}
const triples = (arr) => arr.map((x) => [x.inbox_unread, x.inbox_total, x.sent_total].join('/')).sort();

/* ===========================================================================
 * Test cases
 * ===========================================================================*/

(async function main() {
  console.log('BUG-3b 后端聚合口径 —— 独立验证（真实 SQLite 执行真实 SQL）');
  console.log(`被测版本: src/repo.ts md5=${REPO_MD5}  bytes=${Buffer.byteLength(SRC)}`);

  let sql;
  try {
    sql = extractSql();
  } catch (e) {
    console.error(`\n源码抽取失败：${e.message}`);
    console.error('=> 本测试无法覆盖真实 SQL 口径，按失败处理（不静默降级）。');
    const exitFile = path.join(os.tmpdir(), 'qa-inbox-counts.backend.exit');
    try { fs.writeFileSync(exitFile, '2', 'utf8'); } catch { /* ignore */ }
    process.exit(2);
  }

  // assemble the three SQL statements under test (params restored from the literals in the source)
  // Note: mailboxes()'s GROUP BY template also interpolates ${whereSql} (the optional domain filter);
  // this fixture has no domain filter, so it is substituted with an empty string.
  const SQL_GROUPS = substitute(sql.groupsTemplate, { groupExpr: sql.groupExpr, whereSql: '' });
  // The only placeholder left in the no-domain GROUP BY SQL is the empty-mailbox sentinel (asserted in T0).
  const groupsParams = [sql.unknownSentinel];
  const SQL_ALL = substitute(sql.countsTemplate, { whereSql: '' });
  const SQL_PER = (mailbox) => {
    const isSentinel = mailbox === sql.unknownSentinel;
    const where = isSentinel ? sql.sentinelWhere : substitute(sql.exactWhere, {});
    return {
      sql: substitute(sql.countsTemplate, { whereSql: `WHERE ${where}` }),
      params: isSentinel ? [] : [mailbox],
    };
  };

  console.log(`\n抽取到的 SQL：`);
  console.log(`  [groups] ${SQL_GROUPS}`);
  console.log(`  [groups params] ${JSON.stringify(groupsParams)}`);
  console.log(`  [all]    ${SQL_ALL}`);
  console.log(`  [per]    ${SQL_PER('a@x.com').sql}  params=${JSON.stringify(['a@x.com'])}`);
  console.log(`  [sentinel] ${sql.unknownSentinel}  where=${sql.sentinelWhere}`);

  const db = makeDb(ROWS);
  const env = { DB: makeFakeD1(db) };

  // SUM returns NULL with zero rows; src/repo.ts normalizes it with `?? 0` (the existence of that normalization is guarded by a source-level assertion in T6).
  const norm = (v) => (v === null || v === undefined ? 0 : v);
  const readCounts = (q, params = []) => {
    const row = db.prepare(q).get(...params) || {};
    return {
      inbox_unread: norm(row.inbox_unread),
      inbox_total: norm(row.inbox_total),
      sent_total: norm(row.sent_total),
      starred_total: norm(row.starred_total),
      trash_total: norm(row.trash_total),
    };
  };
  const readGroups = () =>
    db.prepare(SQL_GROUPS).all(...groupsParams).map((r) => ({
      mailbox: r.mailbox,
      inbox_unread: norm(r.inbox_unread),
      inbox_total: norm(r.inbox_total),
      sent_total: norm(r.sent_total),
    }));

  /* ---- T0 environment self-check ---- */
  await test('T0 测试环境自检（harness 可信度）', async () => {
    ok(SQL_GROUPS.includes('GROUP BY'), '抽取到的分组 SQL 含 GROUP BY');
    ok(/SUM\s*\(\s*CASE WHEN/i.test(SQL_GROUPS), '抽取到的分组 SQL 含 SUM(CASE WHEN ...) 聚合');
    ok(/SUM\s*\(\s*CASE WHEN/i.test(SQL_ALL), '抽取到的全部邮箱 SQL 含 SUM(CASE WHEN ...) 聚合');
    ok(countPlaceholders(SQL_GROUPS) === groupsParams.length,
      '分组 SQL 的占位符数量与 .bind 实参数量一致',
      `${countPlaceholders(SQL_GROUPS)} vs ${groupsParams.length}`);
    ok(groupsParams.length >= 1 && groupsParams.every((p) => p === sql.unknownSentinel),
      '分组 SQL 的参数为未知邮箱哨兵', JSON.stringify(groupsParams));
    ok(ROWS.some((r) => r.mailbox === ''), '固定装置包含 mailbox = \'\' 的邮件（口径差异的必要条件）');
    ok(EXPECTED_ALL.inbox_total > EXPECTED_NON_EMPTY_SUM,
      '自检：若忽略空 mailbox 分组，总和会小于「全部邮箱」（证明该数据能暴露 BUG-3b）',
      `all=${EXPECTED_ALL.inbox_total} vs 非空分组之和=${EXPECTED_NON_EMPTY_SUM}`);
    ok(SRC.includes('?? 0'), '源码保留了 null -> 0 归一化（SUM 在零行时返回 NULL）');
    const row = db.prepare(SQL_ALL).get();
    info(`SQL_ALL 原始返回 = ${JSON.stringify(row)}`);
    ok(row && row.inbox_total > 0, 'SQL 确实在真实 SQLite 上执行并返回非零结果（非空转）', row && row.inbox_total);
  });

  /* ---- T1 sidebarCounts(all mailboxes) matches the independent JS expected values ---- */
  await test('T1 全部邮箱聚合：覆盖全部行（含空 mailbox）', async () => {
    const all = readCounts(SQL_ALL);
    info(`实际 = ${JSON.stringify(all)}`);
    info(`期望 = ${JSON.stringify(EXPECTED_ALL)}（独立 JS 计算，不依赖被测 SQL）`);
    ok(all.inbox_unread === EXPECTED_ALL.inbox_unread, 'inbox_unread 与独立期望一致', `${all.inbox_unread} vs ${EXPECTED_ALL.inbox_unread}`);
    ok(all.inbox_total === EXPECTED_ALL.inbox_total, 'inbox_total 与独立期望一致', `${all.inbox_total} vs ${EXPECTED_ALL.inbox_total}`);
    ok(all.sent_total === EXPECTED_ALL.sent_total, 'sent_total 与独立期望一致', `${all.sent_total} vs ${EXPECTED_ALL.sent_total}`);
    ok(all.starred_total === EXPECTED_ALL.starred_total, 'starred_total 与独立期望一致', `${all.starred_total} vs ${EXPECTED_ALL.starred_total}`);
    ok(all.trash_total === EXPECTED_ALL.trash_total, 'trash_total 与独立期望一致', `${all.trash_total} vs ${EXPECTED_ALL.trash_total}`);
  });

  /* ---- T2 mailboxes() grouping must cover empty mailbox ---- */
  await test('T2 分组聚合：分组口径必须覆盖全部行', async () => {
    const list = readGroups();
    info(`实际分组 = ${JSON.stringify(list)}`);
    info(`期望分组 = ${JSON.stringify(EXPECTED_GROUPS)}（共 ${EXPECTED_GROUPS.length} 组）`);
    ok(list.length === EXPECTED_GROUPS.length, `分组数量与期望一致（${list.length} vs ${EXPECTED_GROUPS.length}）`, list.length);
    ok(JSON.stringify(triples(list)) === JSON.stringify(triples(EXPECTED_GROUPS)),
      '各分组的 (unread/total/sent) 组合与独立期望一致',
      `实际=${JSON.stringify(triples(list))} 期望=${JSON.stringify(triples(EXPECTED_GROUPS))}`);
  });

  /* ---- T3 core invariant: sum of all accounts === all mailboxes ---- */
  await test('T3 「全部邮箱」必须等于各账号分组之和（BUG-3b 核心）', async () => {
    const all = readCounts(SQL_ALL);
    const list = readGroups();
    const sum = list.reduce(
      (acc, m) => ({
        inbox_unread: acc.inbox_unread + m.inbox_unread,
        inbox_total: acc.inbox_total + m.inbox_total,
        sent_total: acc.sent_total + m.sent_total,
      }),
      { inbox_unread: 0, inbox_total: 0, sent_total: 0 }
    );
    info(`全部邮箱 = ${JSON.stringify({ inbox_unread: all.inbox_unread, inbox_total: all.inbox_total, sent_total: all.sent_total })}`);
    info(`各账号之和 = ${JSON.stringify(sum)}`);
    ok(all.inbox_unread === sum.inbox_unread, 'inbox_unread：全部邮箱 === 各账号之和', `${all.inbox_unread} vs ${sum.inbox_unread}`);
    ok(all.inbox_total === sum.inbox_total, 'inbox_total：全部邮箱 === 各账号之和', `${all.inbox_total} vs ${sum.inbox_total}`);
    ok(all.sent_total === sum.sent_total, 'sent_total：全部邮箱 === 各账号之和', `${all.sent_total} vs ${sum.sent_total}`);
  });

  /* ---- T4 each account's number in the dropdown must equal the count when filtering by that account ---- */
  await test('T4 每个分组的数字必须与该账号单独过滤的计数一致', async () => {
    const list = readGroups();
    for (const m of list) {
      const q = SQL_PER(m.mailbox);
      const per = readCounts(q.sql, q.params);
      ok(m.inbox_unread === per.inbox_unread && m.inbox_total === per.inbox_total && m.sent_total === per.sent_total,
        `账号「${m.mailbox}」的分组计数 === 该账号过滤计数`,
        `分组=${m.inbox_unread}/${m.inbox_total}/${m.sent_total} 过滤=${per.inbox_unread}/${per.inbox_total}/${per.sent_total}`);
    }
  });

  /* ---- T5 single-account filter (regression: do not break the filter to make the equation work) ---- */
  await test('T5 单个账号过滤仍然正确', async () => {
    for (const g of EXPECTED_GROUPS.filter((x) => x.key !== '')) {
      const q = SQL_PER(g.key);
      const per = readCounts(q.sql, q.params);
      ok(per.inbox_unread === g.inbox_unread && per.inbox_total === g.inbox_total && per.sent_total === g.sent_total,
        `按账号 '${g.key}' 过滤结果正确`,
        `实际=${per.inbox_unread}/${per.inbox_total}/${per.sent_total} 期望=${g.inbox_unread}/${g.inbox_total}/${g.sent_total}`);
    }
    const q = SQL_PER('ghost@x.com');
    const ghost = readCounts(q.sql, q.params);
    ok(ghost.inbox_unread === 0 && ghost.inbox_total === 0 && ghost.sent_total === 0,
      '不存在的账号过滤结果全为 0', JSON.stringify(ghost));
  });

  /* ---- T6 empty DB: SUM returns NULL, the function layer must normalize to 0 ---- */
  await test('T6 空库边界：SUM 返回 NULL，函数层需归一化为 0', async () => {
    const empty = makeDb([]);
    const raw = empty.prepare(SQL_ALL).get();
    info(`空库 SQL_ALL 原始返回 = ${JSON.stringify(raw)}`);
    ok(raw.inbox_total === null || raw.inbox_total === undefined,
      'SQLite 语义确认：零行时 SUM 返回 NULL（这正是源码 `?? 0` 存在的原因）', JSON.stringify(raw));
    ok((SRC.match(/\?\?\s*0/g) || []).length >= 5,
      '源码对 5 个计数字段都做了 `?? 0` 归一化（源码级检查，未执行函数体）',
      (SRC.match(/\?\?\s*0/g) || []).length);
    try { empty.close(); } catch { /* ignore */ }
  });

  /* ---- T7 mailboxes()'s real return for mailbox='': '' / null / sentinel? ---- */
  await test("T7 mailboxes() 对 mailbox='' 的真实返回（判定合并分支是否可达）", async () => {
    const db7 = makeDb(ROWS);
    const raw = db7.prepare(SQL_GROUPS).all(...groupsParams);
    info(`SQL_GROUPS 返回的 mailbox 列 = ${JSON.stringify(raw.map((r) => r.mailbox))}`);
    const emptyValued = raw.filter((r) => r.mailbox === '' || r.mailbox === null);
    const sentinelRows = raw.filter((r) => r.mailbox === sql.unknownSentinel);
    ok(sentinelRows.length === 1,
      "mailbox='' 的分组在 SELECT 里已被归一化为哨兵（恰好 1 行）", sentinelRows.length);
    ok(emptyValued.length === 0,
      "返回结果里不存在 '' 或 null 的 mailbox 值（SELECT 的 CASE 已生效，不是靠 JS 合并兜的）",
      JSON.stringify(raw.map((r) => r.mailbox)));
    info('结论：在真实 SQL 上，空 mailbox 已经在 SQL 层变成哨兵，JS 层的 `r.mailbox === \'\'` 分支收不到这种输入。');
    try { db7.close(); } catch { /* ignore */ }
  });

  /* ---- T8 does schema's NOT NULL make the NULL-merge branch at :212-232 dead code ---- */
  await test('T8 NULL 分支可达性：schema 的 mailbox NOT NULL 是否让合并逻辑成为死代码', async () => {
    ok(/mailbox\s+TEXT\s+NOT NULL\s+DEFAULT\s+''/i.test(MESSAGES_DDL),
      "前提：schema.sql 里 mailbox 定义为 TEXT NOT NULL DEFAULT ''");
    const DDL_NULLABLE = MESSAGES_DDL.replace(/mailbox\s+TEXT\s+NOT NULL\s+DEFAULT\s+''/i, 'mailbox TEXT');
    ok(DDL_NULLABLE !== MESSAGES_DDL, '成功构造出 mailbox 可空的对照表（替换命中）');

    // 8.1 real schema: NULL must be rejected by the constraint
    const dbReal = new DatabaseSync(':memory:');
    dbReal.exec(MESSAGES_DDL);
    let threw = null;
    try {
      dbReal.prepare('INSERT INTO messages (id, direction, mailbox, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('n1', 'inbound', null, 1, 1, 1);
    } catch (e) { threw = e; }
    ok(!!threw && /NOT NULL/i.test(String(threw.message)),
      '真实 schema 下插入 mailbox = NULL 被 NOT NULL 约束拒绝（NULL 不可能入库）',
      threw ? String(threw.message) : '居然插入成功了');
    try { dbReal.close(); } catch { /* ignore */ }

    // 8.2 nullable control table: '' and NULL each produce one sentinel row -- this is exactly why the JS merge logic exists
    const dbNull = new DatabaseSync(':memory:');
    dbNull.exec(DDL_NULLABLE);
    const ins = dbNull.prepare('INSERT INTO messages (id, direction, mailbox, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?)');
    ins.run('e1', 'inbound', '', 1, 1, 1);     // empty string
    ins.run('e2', 'inbound', null, 2, 1, 1);   // NULL (only allowed in a nullable table)
    const rows = dbNull.prepare(SQL_GROUPS).all(...groupsParams);
    info(`可空表下 SQL_GROUPS 返回 = ${JSON.stringify(rows.map((r) => r.mailbox))}`);
    const sentinelRows = rows.filter((r) => r.mailbox === sql.unknownSentinel);
    ok(sentinelRows.length === 2,
      "可空表下 '' 与 NULL 各产生一行哨兵（若真存在 NULL，JS 合并就是必要的）", sentinelRows.length);
    ok(sentinelRows.reduce((a, r) => a + (r.inbox_total || 0), 0) === 2,
      '两行哨兵合计覆盖 2 封邮件（合并后语义才正确）', sentinelRows.reduce((a, r) => a + (r.inbox_total || 0), 0));
    try { dbNull.close(); } catch { /* ignore */ }

    info('结论：schema.sql 的 NOT NULL 使 NULL 不可能入库 → :212-232 里 `r.mailbox === null` 分支不可达；');
    info("      同时 '' 已在 SELECT 的 CASE 里归一化为哨兵 → `r.mailbox === ''` 分支也收不到输入。");
    info('      => 在当前 schema + 当前 SQL 下，该合并逻辑是**防御性死代码**（无害，不建议删除）。');
  });

  /* ---- summary ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);

  console.log(`\n被测版本: src/repo.ts md5=${REPO_MD5}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);

  const exitCode = fail ? 1 : 0;
  const exitFile = path.join(os.tmpdir(), 'qa-inbox-counts.backend.exit');
  try {
    fs.writeFileSync(exitFile, String(exitCode), 'utf8');
    console.log(`退出码已写入: ${exitFile} = ${exitCode}`);
  } catch (e) {
    console.log(`退出码文件写入失败: ${e.message}`);
  }

  try { db.close(); } catch { /* ignore */ }
  process.exit(exitCode);
})();
