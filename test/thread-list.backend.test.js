'use strict';

/* =============================================================================
 * List groups by thread regression -- real SQLite as D1 + real compiled src/ artifacts
 *
 * Run:
 *   node test/thread-list.backend.test.js
 * Exit codes: 0 = all pass; 1 = failures; 2 = missing environment.
 * ===========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

// tsc shim (Win32 bcrypt.dll workaround + sandbox spawn workaround)
// must be loaded before destructuring spawnSync, because the shim monkey-patches cp.spawnSync
const TSC_SHIM = process.env.TSC_SHIM || path.join(os.tmpdir(), 'mm-tsc-shim.js');
if (fs.existsSync(TSC_SHIM)) require(TSC_SHIM);

const { spawnSync } = cp;

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('node:sqlite 不可用（需要 Node >= 22.5）。', String(e && e.message));
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');

/* ---- compile repo.ts (reusing thread-grouping's build pattern) ---- */
const WORK_DIR = path.join(os.tmpdir(), `thread-list-qa-${process.pid}`);
const SRC_COPY = path.join(WORK_DIR, 'src');
const BUILD_DIR = path.join(WORK_DIR, 'out');

function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc: ${tsc}`);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(SRC_COPY, { recursive: true });

  try {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WORK_DIR, 'node_modules'), 'junction');
  } catch (e) {
    throw new Error(`无法链接 node_modules: ${e.message}`);
  }

  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (f.endsWith('.ts')) fs.copyFileSync(path.join(ROOT, 'src', f), path.join(SRC_COPY, f));
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
  delete cfg.include;
  delete cfg.exclude;
  cfg.files = fs.readdirSync(SRC_COPY).filter((f) => f.endsWith('.ts')).map((f) => path.join(SRC_COPY, f));
  cfg.compilerOptions = Object.assign({}, cfg.compilerOptions, {
    noEmit: false,
    module: 'commonjs',
    outDir: BUILD_DIR,
    rootDir: SRC_COPY,
  });
  const cfgPath = path.join(WORK_DIR, 'tsconfig.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const r = spawnSync(process.execPath, [tsc, '-p', cfgPath], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) throw new Error(`tsc 编译失败(exit=${r.status}): ${out}`);
  if (!fs.existsSync(path.join(BUILD_DIR, 'repo.js'))) {
    throw new Error(`编译产物缺失: ${path.join(BUILD_DIR, 'repo.js')}`);
  }
  return BUILD_DIR;
}

function cleanup() {
  const link = path.join(WORK_DIR, 'node_modules');
  try {
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch { /* ignore */ }
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

const BUILD = build();
const repo = require(path.join(BUILD, 'repo.js'));

/* ---- helpers ---- */
function ok(cond, msg, extra) {
  if (!cond) {
    const info = extra !== undefined ? ` (得到: ${JSON.stringify(extra)})` : '';
    throw new Error(`FAIL: ${msg}${info}`);
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function makeEnv(db) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const prepare = (sql) => {
    const st = {
      sql,
      args: [],
      bind(...a) { st.args = a; return st; },
      async run() {
        const r = db.prepare(sql).run(...norm(st.args));
        return { success: true, results: [], meta: { changes: Number(r.changes) } };
      },
      async first() {
        const row = db.prepare(sql).get(...norm(st.args));
        return row === undefined ? null : row;
      },
      async all() {
        return { results: db.prepare(sql).all(...norm(st.args)), success: true, meta: {} };
      },
    };
    return st;
  };
  return { DB: { prepare, exec: async () => ({ count: 0, duration: 0 }) } };
}

function seedMessages(db, rows) {
  for (const r of rows) {
    db.exec(
      `INSERT INTO messages (id, direction, mailbox, from_email, to_emails, cc, bcc, subject, body_text, received_at, read, starred, deleted, thread_id, status)
       VALUES ('${r.id}', '${r.direction}', '${r.mailbox || ''}', '${r.from_email || ''}', '${JSON.stringify(r.to || [])}', ${r.cc ? `'${JSON.stringify(r.cc)}'` : 'NULL'}, ${r.bcc ? `'${JSON.stringify(r.bcc)}'` : 'NULL'}, '${r.subject || ''}', '${r.body_text || ''}', ${r.received_at}, ${r.read ? 1 : 0}, ${r.starred ? 1 : 0}, ${r.deleted ? 1 : 0}, '${r.thread_id || ''}', '${r.status || 'sent'}')`
    );
  }
}

/* ---- run tests ---- */
const db = new DatabaseSync(':memory:');

// create tables (simplified, only the columns listFolder needs)
db.exec(`CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  direction TEXT,
  mailbox TEXT,
  from_name TEXT,
  from_email TEXT,
  to_emails TEXT,
  cc TEXT,
  bcc TEXT,
  subject TEXT,
  body_text TEXT,
  received_at INTEGER,
  read INTEGER,
  starred INTEGER,
  deleted INTEGER,
  thread_id TEXT,
  status TEXT
)`);
db.exec(`CREATE TABLE attachments (id TEXT PRIMARY KEY, message_id TEXT)`);

const env = makeEnv(db);
let passed = 0;
let failed = 0;

const tests = [];
function run(name, fn) {
  tests.push({ name, fn });
}

const t0 = nowSec();

/* T1 three emails in the same thread show up as only 1 row */
run('T1 同 thread 聚合为 1 行', async () => {
  db.exec('DELETE FROM messages');
  seedMessages(db, [
    { id: 'a1', direction: 'inbound', mailbox: 'inbox', from_email: 'alice@x.com', to: ['me@x.com'], subject: 'Hello', body_text: 'body1', received_at: t0 - 300, read: 0, thread_id: 't1' },
    { id: 'a2', direction: 'outbound', mailbox: 'inbox', from_email: 'me@x.com', to: ['alice@x.com'], subject: 'Re: Hello', body_text: 'body2', received_at: t0 - 200, read: 1, thread_id: 't1' },
    { id: 'a3', direction: 'inbound', mailbox: 'inbox', from_email: 'alice@x.com', to: ['me@x.com'], subject: 'Re: Re: Hello', body_text: 'body3', received_at: t0 - 100, read: 0, thread_id: 't1' },
  ]);
  const res = await repo.listFolder(env, { folder: 'inbox', limit: 20, offset: 0 });
  ok(res.items.length === 1, '只返回 1 行', res.items.length);
  ok(res.total === 1, 'total = 1', res.total);
  ok(res.items[0].id === 'a3', '取最新一封 a3', res.items[0].id);
  ok(res.items[0].thread_count === 3, 'thread_count = 3', res.items[0].thread_count);
  ok(res.items[0].thread_unread === 2, 'thread_unread = 2（a1 和 a3 未读）', res.items[0].thread_unread);
  ok(res.items[0].read === 0, '最新一封 a3 是未读的', res.items[0].read);
});

/* T2 two independent threads each with 2 emails */
run('T2 两个 thread 返回 2 行', async () => {
  db.exec('DELETE FROM messages');
  seedMessages(db, [
    { id: 'b1', direction: 'inbound', mailbox: 'inbox', from_email: 'bob@x.com', to: ['me@x.com'], subject: 'B1', body_text: 'b1', received_at: t0 - 400, read: 1, thread_id: 't2' },
    { id: 'b2', direction: 'inbound', mailbox: 'inbox', from_email: 'bob@x.com', to: ['me@x.com'], subject: 'B2', body_text: 'b2', received_at: t0 - 300, read: 1, thread_id: 't2' },
    { id: 'c1', direction: 'inbound', mailbox: 'inbox', from_email: 'carol@x.com', to: ['me@x.com'], subject: 'C1', body_text: 'c1', received_at: t0 - 200, read: 0, thread_id: 't3' },
    { id: 'c2', direction: 'outbound', mailbox: 'inbox', from_email: 'me@x.com', to: ['carol@x.com'], subject: 'C2', body_text: 'c2', received_at: t0 - 100, read: 1, thread_id: 't3' },
  ]);
  const res = await repo.listFolder(env, { folder: 'inbox', limit: 20, offset: 0 });
  ok(res.items.length === 2, '返回 2 行', res.items.length);
  ok(res.total === 2, 'total = 2', res.total);
  // ordered by received_at DESC, t3's newest email c2 is later, so it should come first
  ok(res.items[0].id === 'c2', '第一行是 c2（t3 最新）', res.items[0].id);
  ok(res.items[0].thread_count === 2, 't3 有 2 封', res.items[0].thread_count);
  ok(res.items[1].thread_count === 2, 't2 有 2 封', res.items[1].thread_count);
});

/* T2b Sent folder is NOT collapsed by thread (each sent message is its own row) */
run('T2b 发件箱不按会话合并', async () => {
  db.exec('DELETE FROM messages');
  seedMessages(db, [
    { id: 's1', direction: 'outbound', mailbox: 'me@x.com', from_email: 'me@x.com', to: ['alice@x.com'], subject: 'A', body_text: '1', received_at: t0 - 300, thread_id: 'ts' },
    { id: 's2', direction: 'outbound', mailbox: 'me@x.com', from_email: 'me@x.com', to: ['alice@x.com'], subject: 'B', body_text: '2', received_at: t0 - 200, thread_id: 'ts' },
    { id: 's3', direction: 'outbound', mailbox: 'me@x.com', from_email: 'me@x.com', to: ['bob@x.com'], subject: 'C', body_text: '3', received_at: t0 - 100, thread_id: 'ts' },
  ]);
  const sent = await repo.listFolder(env, { folder: 'sent', limit: 20, offset: 0 });
  ok(sent.items.length === 3, '⭐ 发件箱：同一 thread 的 3 封各自一行（不合并）', sent.items.length);
  ok(sent.total === 3, 'total = 3', sent.total);
  ok(sent.items.every((it) => it.thread_count === 1), 'thread_count 都是 1（无会话徽标）', JSON.stringify(sent.items.map((it) => it.thread_count)));
  ok(sent.items[0].id === 's3', '仍按时间倒序（最新在前）', sent.items[0].id);

  // Negative control: the inbox-style grouping is untouched for other folders.
  db.exec("UPDATE messages SET direction = 'inbound'");
  const inbox = await repo.listFolder(env, { folder: 'inbox', limit: 20, offset: 0 });
  ok(inbox.items.length === 1 && inbox.items[0].thread_count === 3, '对照：收件箱仍按会话合并为 1 行（3 封）', `${inbox.items.length}/${inbox.items[0] && inbox.items[0].thread_count}`);
});

/* T3 rows without thread_id are each independent */run('T3 无 thread_id 每行独立', async () => {
  db.exec('DELETE FROM messages');
  seedMessages(db, [
    { id: 'd1', direction: 'inbound', mailbox: 'inbox', from_email: 'd@x.com', to: ['me@x.com'], subject: 'D1', body_text: 'd1', received_at: t0 - 200, read: 1, thread_id: '' },
    { id: 'd2', direction: 'inbound', mailbox: 'inbox', from_email: 'e@x.com', to: ['me@x.com'], subject: 'D2', body_text: 'd2', received_at: t0 - 100, read: 0, thread_id: '' },
  ]);
  const res = await repo.listFolder(env, { folder: 'inbox', limit: 20, offset: 0 });
  ok(res.items.length === 2, '返回 2 行（各自独立）', res.items.length);
  ok(res.total === 2, 'total = 2', res.total);
  ok(res.items[0].thread_count === 1, 'd2 thread_count = 1', res.items[0].thread_count);
  ok(res.items[1].thread_count === 1, 'd1 thread_count = 1', res.items[1].thread_count);
});

/* T4 mixed: aggregation for rows with thread_id + independence for rows without */
run('T4 混合场景', async () => {
  db.exec('DELETE FROM messages');
  seedMessages(db, [
    { id: 'e1', direction: 'inbound', mailbox: 'inbox', from_email: 'alice@x.com', to: ['me@x.com'], subject: 'Thread', body_text: 't', received_at: t0 - 300, read: 1, thread_id: 'tx' },
    { id: 'e2', direction: 'outbound', mailbox: 'inbox', from_email: 'me@x.com', to: ['alice@x.com'], subject: 'Re', body_text: 'r', received_at: t0 - 200, read: 1, thread_id: 'tx' },
    { id: 'f1', direction: 'inbound', mailbox: 'inbox', from_email: 'bob@x.com', to: ['me@x.com'], subject: 'Standalone', body_text: 's', received_at: t0 - 100, read: 0, thread_id: '' },
  ]);
  const res = await repo.listFolder(env, { folder: 'inbox', limit: 20, offset: 0 });
  ok(res.items.length === 2, '2 行（tx 聚合 + f1 独立）', res.items.length);
  ok(res.total === 2, 'total = 2', res.total);
  const tx = res.items.find((i) => i.id === 'e2');
  const st = res.items.find((i) => i.id === 'f1');
  ok(!!tx, 'tx 存在', tx);
  ok(!!st, 'f1 存在', st);
  ok(tx.thread_count === 2, 'tx thread_count = 2', tx.thread_count);
  ok(st.thread_count === 1, 'f1 thread_count = 1', st.thread_count);
});

/* T5 unread-only: show if the thread has any unread, take the newest (even if the newest is read) */
run('T5 只看未读筛选', async () => {
  db.exec('DELETE FROM messages');
  seedMessages(db, [
    { id: 'g1', direction: 'inbound', mailbox: 'inbox', from_email: 'a@x.com', to: ['me@x.com'], subject: 'Old', body_text: 'o', received_at: t0 - 300, read: 0, thread_id: 't5' },
    { id: 'g2', direction: 'outbound', mailbox: 'inbox', from_email: 'me@x.com', to: ['a@x.com'], subject: 'Reply', body_text: 'r', received_at: t0 - 100, read: 1, thread_id: 't5' },
    { id: 'h1', direction: 'inbound', mailbox: 'inbox', from_email: 'b@x.com', to: ['me@x.com'], subject: 'AllRead', body_text: 'a', received_at: t0 - 200, read: 1, thread_id: 't6' },
  ]);
  const res = await repo.listFolder(env, { folder: 'inbox', unread: true, limit: 20, offset: 0 });
  ok(res.items.length === 1, '只看未读返回 1 行（t5 有未读，t6 全已读被过滤）', res.items.length);
  ok(res.total === 1, 'total = 1', res.total);
  ok(res.items[0].id === 'g2', '取 t5 最新一封 g2（虽然是已读的）', res.items[0].id);
  ok(res.items[0].thread_unread === 1, 'thread_unread = 1', res.items[0].thread_unread);
});

/* T6 when everything is read, unread=true returns empty */
run('T6 全部已读时未读筛选为空', async () => {
  db.exec('DELETE FROM messages');
  seedMessages(db, [
    { id: 'i1', direction: 'inbound', mailbox: 'inbox', from_email: 'a@x.com', to: ['me@x.com'], subject: 'R1', body_text: 'r1', received_at: t0 - 200, read: 1, thread_id: 't7' },
    { id: 'i2', direction: 'outbound', mailbox: 'inbox', from_email: 'me@x.com', to: ['a@x.com'], subject: 'R2', body_text: 'r2', received_at: t0 - 100, read: 1, thread_id: 't7' },
  ]);
  const res = await repo.listFolder(env, { folder: 'inbox', unread: true, limit: 20, offset: 0 });
  ok(res.items.length === 0, '返回空', res.items.length);
  ok(res.total === 0, 'total = 0', res.total);
});

/* T7 pagination */
run('T7 分页', async () => {
  db.exec('DELETE FROM messages');
  seedMessages(db, [
    { id: 'j1', direction: 'inbound', mailbox: 'inbox', from_email: 'a@x.com', to: ['me@x.com'], subject: 'T1', body_text: 'b', received_at: t0 - 400, read: 1, thread_id: 'p1' },
    { id: 'j2', direction: 'inbound', mailbox: 'inbox', from_email: 'b@x.com', to: ['me@x.com'], subject: 'T2', body_text: 'b', received_at: t0 - 300, read: 1, thread_id: 'p2' },
    { id: 'j3', direction: 'inbound', mailbox: 'inbox', from_email: 'c@x.com', to: ['me@x.com'], subject: 'T3', body_text: 'b', received_at: t0 - 200, read: 1, thread_id: 'p3' },
  ]);
  const r1 = await repo.listFolder(env, { folder: 'inbox', limit: 2, offset: 0 });
  ok(r1.items.length === 2, '第 1 页 2 行', r1.items.length);
  ok(r1.total === 3, 'total = 3', r1.total);
  const r2 = await repo.listFolder(env, { folder: 'inbox', limit: 2, offset: 2 });
  ok(r2.items.length === 1, '第 2 页 1 行', r2.items.length);
});

/* T8 search does not break aggregation */
run('T8 搜索不破坏聚合', async () => {
  db.exec('DELETE FROM messages');
  seedMessages(db, [
    { id: 'k1', direction: 'inbound', mailbox: 'inbox', from_email: 'alice@x.com', to: ['me@x.com'], subject: 'Project Alpha', body_text: 'hello', received_at: t0 - 300, read: 1, thread_id: 't8' },
    { id: 'k2', direction: 'outbound', mailbox: 'inbox', from_email: 'me@x.com', to: ['alice@x.com'], subject: 'Re: Project Alpha', body_text: 'reply', received_at: t0 - 100, read: 1, thread_id: 't8' },
  ]);
  const res = await repo.listFolder(env, { folder: 'inbox', q: 'Alpha', limit: 20, offset: 0 });
  ok(res.items.length === 1, '搜索返回 1 行（聚合后）', res.items.length);
  ok(res.items[0].thread_count === 2, 'thread_count = 2', res.items[0].thread_count);
});

/* T9 sent folder aggregates too */
run('T9 已发送文件夹**不**聚合（每封一行）', async () => {
  db.exec('DELETE FROM messages');
  seedMessages(db, [
    { id: 'm1', direction: 'outbound', mailbox: 'inbox', from_email: 'me@x.com', to: ['a@x.com'], subject: 'S1', body_text: 's1', received_at: t0 - 200, read: 1, thread_id: 't9' },
    { id: 'm2', direction: 'outbound', mailbox: 'inbox', from_email: 'me@x.com', to: ['a@x.com'], subject: 'S2', body_text: 's2', received_at: t0 - 100, read: 1, thread_id: 't9' },
  ]);
  const res = await repo.listFolder(env, { folder: 'sent', limit: 20, offset: 0 });
  ok(res.items.length === 2, '⭐ 发件箱每封一行（不再按会话合并）', res.items.length);
  ok(res.total === 2, 'total = 2', res.total);
  ok(res.items.every((it) => it.thread_count === 1), 'thread_count 都是 1', JSON.stringify(res.items.map((it) => it.thread_count)));
});

/* T10 thread_count matches the conversation panel's convention (folding loopback copies) */
run('T10 徽标封数折叠回环副本后与面板一致', async () => {
  db.exec('DELETE FROM messages');
  // real production shape: I (dana@) replied to frank@ and cc'd another mailbox of this account erin@,
  // Resend delivers the same email back to erin@ -> two rows left in the DB: "outbound + inbound loopback copy".
  seedMessages(db, [
    { id: 'p1', direction: 'inbound', mailbox: 'dana@x.com', from_email: 'frank@x.com', to: ['dana@x.com'], subject: 'Q', body_text: 'q', received_at: t0 - 300, read: 1, thread_id: 'tlp' },
    { id: 'p2', direction: 'outbound', mailbox: 'dana@x.com', from_email: 'dana@x.com', to: ['frank@x.com'], cc: ['erin@x.com'], subject: 'Re: Q', body_text: 'a', received_at: t0 - 200, read: 1, thread_id: 'tlp' },
    { id: 'p3', direction: 'inbound', mailbox: 'erin@x.com', from_email: 'dana@x.com', to: ['frank@x.com'], cc: ['erin@x.com'], subject: 'Re: Q', body_text: 'a', received_at: t0 - 199, read: 0, thread_id: 'tlp' },
  ]);
  const res = await repo.listFolder(env, { folder: 'inbox', limit: 20, offset: 0 });
  ok(res.items.length === 1, 'tlp 聚合为 1 行', res.items.length);
  ok(res.total === 1, 'total = 1（会话数，不受折叠影响）', res.total);
  ok(res.items[0].thread_count === 2,
    '⭐ thread_count = 2（3 条原始行折叠掉 1 条回环副本后，与会话面板一致）', res.items[0].thread_count);
  ok(res.items[0].thread_count !== 3,
    '负控制：不能是原始行数 3（旧实现会返回 3，正是用户报的「左 3 右 2」）', res.items[0].thread_count);

  // negative control: an ordinary multi-email thread with no loopback copy must not be altered
  seedMessages(db, [
    { id: 'q1', direction: 'inbound', mailbox: 'dana@x.com', from_email: 'bob@x.com', to: ['dana@x.com'], subject: 'N', body_text: 'n', received_at: t0 - 500, read: 1, thread_id: 'tln' },
    { id: 'q2', direction: 'outbound', mailbox: 'dana@x.com', from_email: 'dana@x.com', to: ['bob@x.com'], subject: 'Re: N', body_text: 'r', received_at: t0 - 400, read: 1, thread_id: 'tln' },
    { id: 'q3', direction: 'inbound', mailbox: 'dana@x.com', from_email: 'bob@x.com', to: ['dana@x.com'], subject: 'Re: Re: N', body_text: 'r', received_at: t0 - 100, read: 0, thread_id: 'tln' },
  ]);
  const res2 = await repo.listFolder(env, { folder: 'inbox', limit: 20, offset: 0 });
  const tln = res2.items.find((i) => i.id === 'q3');
  ok(tln && tln.thread_count === 3, '普通 3 封会话原样保留 thread_count = 3', tln && tln.thread_count);
});

/* summary */
(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  PASS  ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${t.name}  ${e.message}`);
    }
  }
  console.log(`\n===== 结果: ${passed} passed, ${failed} failed =====`);
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
})();
