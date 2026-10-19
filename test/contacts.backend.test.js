'use strict';

/* =============================================================================
 * Local contacts (GET /api/contacts) backend verification -- real SQLite + real repo.contacts()
 *
 * Run:
 *   NODE_OPTIONS="--require <shim outside repo>.js" <node.exe> test/contacts.backend.test.js
 *   (The suite spawns tsc internally, which needs the shim in this sandbox; shim notes are in
 *     the documentation at the project root)
 *
 * Why this deserves its own suite:
 *   Contact aggregation relies on three SQL semantics that are **easy to get wrong without erroring**:
 *     1) `json_each('')` / any invalid JSON **directly throws `malformed JSON`**, and the checks in `WHERE`
 *        **cannot stop it** (table-valued functions are evaluated during JOIN, before WHERE) -- a mistake means a 500 from the endpoint;
 *     2) "take the latest name for that address" relies on SQLite's rule of "bare column taken from the same row as min()/max()". In testing (3.51.2)
 *        this rule is looser than the docs (adding a COUNT(*)/SUM still holds), so **adding more aggregates does not create a defect**;
 *        what actually breaks it is **direction**: `MIN(received_at)` or `MAX(from_name)` both silently return the wrong name
 *        -- mutation-test cases M2a / M2b lock down those two forms respectively;
 *     3) one's own receiving mailboxes (the `mailbox` column) must **also** go into contacts (user decision 2026-10-03). That column holds both
 *        "my own identity" and possibly **colleague/team addresses** (the account configured erin@ to receive mail);
 *        an early version excluded them all via `DISTINCT mailbox` -> colleague addresses **silently disappeared** from suggestions (user report).
 *        C4 now locks down "one's own mailbox **must appear**", and uses "no name correspondence -> name is null" as a negative control.
 *   All three can only be verified by running the **real SQL engine**; they cannot be stubbed.
 *
 * Exit codes: 0 = all pass; 1 = failures.
 * ===========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('node:sqlite 不可用（需要 Node >= 22.5）。', String(e && e.message));
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
// QA_REPO_TS is only for "mutation verification": point it at a hand-crafted repo.ts variant (outside the repo),
// to confirm this test really catches the defect. Without the hook, the mutation script would "run the repo's original file while thinking it is the variant".
const REPO_TS = process.env.QA_REPO_TS || path.join(ROOT, 'src', 'repo.ts');
const WORK_DIR = path.join(os.tmpdir(), `contacts-qa-build-${process.pid}`);
const SRC_COPY = path.join(WORK_DIR, 'src');
const BUILD_DIR = path.join(WORK_DIR, 'out');
const REPO_MD5 = crypto.createHash('md5').update(fs.readFileSync(REPO_TS)).digest('hex');

/* ---------------------------------------------------------------------------
 * Clean up the temp dir
 *
 * WORK_DIR/node_modules is a junction pointing at the **repo node_modules**. In testing
 * fs.rmSync(WORK_DIR, {recursive:true}) does not follow the junction to delete the target (probe-verified 2026-10-03),
 * but if the deletion order ever goes wrong it is an irreversible "delete the repo dependencies" accident, so here we explicitly
 * unmount the link first and then delete the dir -- costs only a few lines, and the benefit is that no repo breakage occurs even if Node's behavior changes in the future.
 * -------------------------------------------------------------------------*/
function cleanup() {
  const link = path.join(WORK_DIR, 'node_modules');
  try {
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch { /* ignore */ }
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ---------------------------------------------------------------------------
 * 1) Copy the whole src/ outside the repo (variant overrides repo.ts) then compile, to get the real repo.contacts()
 *
 * Why copy instead of compiling the repo's src/ directly:
 *   The QA_REPO_TS variant lives outside the repo, and tsc needs a complete src/ to compile;
 *   copy once then overwrite, and any variant can be compiled **without modifying the repo at all**.
 *   The temp tsconfig is derived from the repo tsconfig (only swapping noEmit/module/outDir/rootDir + files),
 *   avoiding config drift from hand-copying compilerOptions.
 *
 * ⚠️ Two required companions (missing either one makes compilation fail, and the failure message looks unrelated to the variant):
 *   a) The temp dir is under os.tmpdir(), so type resolution (types: ['@cloudflare/workers-types'])
 *      and bare-module resolution of the build output both depend on node_modules -- WORK_DIR/node_modules must be
 *      linked to the repo's node_modules **before compiling**, otherwise it reports
 *      TS2688 Cannot find type definition file for '@cloudflare/workers-types';
 *   b) After switching module to commonjs, do **not** casually touch moduleResolution:
 *      tsc here is TypeScript 7, `node10` has been removed (TS5108), and the repo's combination of 'bundler'
 *      with commonjs is accepted (mail-merge.backend.test.js runs exactly this way).
 * -------------------------------------------------------------------------*/
function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc: ${tsc}`);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(SRC_COPY, { recursive: true });

  // (b) establish the node_modules link before compiling (both types resolution + bare-module resolution of the output rely on it)
  try {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WORK_DIR, 'node_modules'), 'junction');
  } catch (e) {
    throw new Error(`无法为临时编译目录链接 node_modules: ${e.message}`);
  }

  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (f.endsWith('.ts')) fs.copyFileSync(path.join(ROOT, 'src', f), path.join(SRC_COPY, f));
  }
  // variant override (same dir, same name -> directly replace the copied one)
  fs.copyFileSync(REPO_TS, path.join(SRC_COPY, 'repo.ts'));

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
  delete cfg.include;
  delete cfg.exclude;
  cfg.files = fs.readdirSync(SRC_COPY).filter((f) => f.endsWith('.ts')).map((f) => path.join(SRC_COPY, f));
  cfg.compilerOptions = Object.assign({}, cfg.compilerOptions, {
    noEmit: false,
    module: 'commonjs', // moduleResolution keeps the repo's 'bundler' (see note b above)
    outDir: BUILD_DIR,
    rootDir: SRC_COPY,
  });
  const cfgPath = path.join(WORK_DIR, 'tsconfig.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const r = spawnSync(process.execPath, [tsc, '-p', cfgPath], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tsc 编译失败(exit=${r.status}): ${(r.stdout || '') + (r.stderr || '')}`);
  const entry = path.join(BUILD_DIR, 'repo.js');
  if (!fs.existsSync(entry)) throw new Error(`编译产物缺失: ${entry}`);
  return entry;
}

/* ---------------------------------------------------------------------------
 * 2) Create the DB with schema.sql's real DDL, and minimally adapt the D1 interface to node:sqlite
 * -------------------------------------------------------------------------*/
function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

  const prepare = (sql) => {
    const stmt = db.prepare(sql);
    const st = {
      sql,
      args: [],
      bind(...a) { st.args = a; return st; },
      async run() {
        const r = stmt.run(...st.args);
        return { success: true, results: [], meta: { changes: Number(r.changes || 0) } };
      },
      async first() { return stmt.get(...st.args) ?? null; },
      async all() { return { results: stmt.all(...st.args), success: true, meta: {} }; },
    };
    return st;
  };

  return {
    db,
    env: {
      DB: {
        prepare,
        async batch(stmts) { for (const s of stmts) await s.run(); return []; },
        async exec() { return { count: 0, duration: 0 }; },
        async dump() { return new ArrayBuffer(0); },
      },
      BUCKET: { async put() { return {}; }, async get() { return null; }, async delete() { return {}; }, async list() { return { objects: [] }; } },
      SEND_FROM_ADDRESS: 'support@example.com',
      SEND_FROM_NAME: 'support',
    },
  };
}

/* ---------------------------------------------------------------------------
 * 3) Test runner
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
function section(name) { currentTest = name; console.log(`\n=== ${name} ===`); }

(async () => {
  const entry = build();
  const repo = require(entry);
  if (typeof repo.contacts !== 'function') throw new Error('编译产物未导出 contacts()');
  console.log(`编译: ${BUILD_DIR}（仓库外临时目录）`);
  console.log(`被测版本: src/repo.ts md5=${REPO_MD5}`);

  const { db, env } = makeEnv();

  // seed data with the **real** saveInbound / saveOutbound, not hand-written INSERTs
  const inbound = (o) =>
    repo.saveInbound(env, Object.assign({
      rowId: o.rowId, resendId: o.resendId, messageId: null, inReplyTo: null, references: null,
      threadId: o.threadId || 't', mailbox: o.mailbox, fromName: o.fromName ?? null, fromEmail: o.fromEmail ?? null,
      to: o.to || [], cc: o.cc || [], bcc: [], replyTo: [], subject: 's', html: null, text: 't',
      receivedAt: o.receivedAt, attachments: [],
    }, {}), `evt-${o.rowId}`);

  const outbound = (o) =>
    repo.saveOutbound(env, {
      messageId: null, inReplyTo: null, references: null, threadId: o.threadId || 't2',
      mailbox: o.mailbox, fromName: null, fromEmail: o.mailbox,
      to: o.to || [], cc: o.cc || [], bcc: [], subject: 's', html: null, text: 't',
      resendId: o.resendId, receivedAt: o.receivedAt,
    });

  /* ---- C1 aggregation sources: inbound from_email + outbound to/cc ---- */
  section('C1 地址来源：入站 from_email + 出站 to_emails / cc');
  await inbound({ rowId: 'm1', resendId: 'r1', mailbox: 'inbox@me.com', fromName: 'Lili Wang', fromEmail: 'lili@partner.com', to: ['inbox@me.com'], receivedAt: 100 });
  await outbound({ mailbox: 'inbox@me.com', to: ['lili@partner.com'], receivedAt: 200, resendId: 'r2' });
  await inbound({ rowId: 'm3', resendId: 'r3', mailbox: 'inbox@me.com', fromName: 'Lili W. (new)', fromEmail: 'LILI@partner.com', to: ['inbox@me.com'], cc: ['boss@x.com'], receivedAt: 300 });
  await inbound({ rowId: 'm4', resendId: 'r4', mailbox: 'inbox@me.com', fromName: null, fromEmail: 'anon@x.com', to: ['inbox@me.com'], receivedAt: 400 });
  await outbound({ mailbox: 'billing@me.com', to: ['boss@x.com'], cc: ['anon@x.com'], receivedAt: 500, resendId: 'r5' });

  const list = await repo.contacts(env);
  ok(Array.isArray(list), '返回数组', typeof list);
  const emails = list.map((c) => c.email);
  ok(emails.length === 5, '恰好 5 个联系人（去重；自己的信箱不再被排除）', JSON.stringify(emails));
  ok(emails.includes('lili@partner.com') && emails.includes('boss@x.com') && emails.includes('anon@x.com'),
    '入站发件人 / 出站 to / 出站 cc 三种来源都进来了', JSON.stringify(emails));

  /* ---- C2 ⭐ name taken from the "latest email **with a name**"; a nameless outbound email must not clobber the name ---- */
  section('C2 ⭐ 姓名取最新一封「带姓名」的邮件（出站邮件的 NULL 姓名不得覆盖）');
  const lili = list.find((c) => c.email === 'lili@partner.com');
  ok(!!lili, 'lili@partner.com 在列表里（否则下面的断言空转）', JSON.stringify(lili));
  ok(lili && lili.name === 'Lili W. (new)',
    '⭐ 姓名取最新一封带姓名的（m3, received_at=300），而不是被 m2 出站邮件的 NULL 冲掉',
    lili && JSON.stringify(lili.name));
  const anon = list.find((c) => c.email === 'anon@x.com');
  ok(anon && anon.name === null, '从来没有姓名往来的地址 name 为 null（不编造）', anon && JSON.stringify(anon.name));

  /* ---- C3 counts and ordering ---- */
  section('C3 往来次数与排序');
  ok(lili && lili.count === 3, 'lili 往来 3 次（m1 from + m2 to + m3 from）', lili && lili.count);
  ok(anon && anon.count === 2, 'anon 往来 2 次（m4 from + m5 cc）', anon && anon.count);
  ok(JSON.stringify(emails) === JSON.stringify(['inbox@me.com', 'lili@partner.com', 'anon@x.com', 'boss@x.com', 'billing@me.com']),
    '按次数降序，同次数按邮箱升序', JSON.stringify(emails));

  /* ---- C4 ⭐ one's own receiving mailboxes should also be suggestible (behavior change 2026-10-03)---- */
  section('C4 ⭐ 自己的收件信箱也进联想（用户明确要求「也可以给自己发」）');
  ok(emails.includes('inbox@me.com'), 'inbox@me.com 是自己的收件信箱 -> 仍然出现在联系人里', JSON.stringify(emails));
  ok(emails.includes('billing@me.com'), 'billing@me.com 同理不再被排除', JSON.stringify(emails));
  // negative control: one's own mailbox only comes in because "there was correspondence", it must not be given an invented name (it never had from_name)
  const inbox = list.find((c) => c.email === 'inbox@me.com');
  ok(inbox && inbox.name === null, '自己的信箱没有姓名往来 -> name 为 null（不编造）', inbox && JSON.stringify(inbox.name));

  /* ---- C5 ⭐ negative control: json_each(NULL) must not produce ghost empty addresses ---- */
  section('C5 ⭐ 负控制：不得出现空地址（json_each(NULL) 返回 1 行 value=NULL）');
  ok(emails.every((e) => typeof e === 'string' && e.trim() !== ''), '没有空串 / 纯空白地址', JSON.stringify(emails));
  ok(emails.length === 5, '总数没被幽灵行撑大', emails.length);

  /* ---- C6 case-insensitive merge + limit ---- */
  section('C6 大小写合并为一个联系人；limit 生效');
  ok(emails.filter((e) => e === 'lili@partner.com').length === 1,
    'LILI@partner.com 与 lili@partner.com 合并成一个小写地址（不重复出现）', JSON.stringify(emails));
  const two = await repo.contacts(env, 2);
  ok(two.length === 2, 'limit=2 -> 只返回 2 条', two.length);
  ok(JSON.stringify(two.map((c) => c.email)) === JSON.stringify(['inbox@me.com', 'lili@partner.com']),
    'limit 截取的是排序后的前 2 条', JSON.stringify(two.map((c) => c.email)));

  /* ---- C7 ⭐ dirty-data tolerance: invalid JSON columns must not make the endpoint 500 ---- */
  section('C7 ⭐ 脏数据容错：to_emails/cc 是空串或 NULL 时不得抛 malformed JSON');
  // real cause: the cc column is nullable with no default, so historical rows / partial writes leave '' or NULL.
  // json_each('') **directly throws malformed JSON**, and WHERE cannot stop it (table-valued functions are evaluated during JOIN),
  // the consequence being that the whole /api/contacts returns 500 -- the entire frontend suggestion feature is unusable.
  const ins = (id, to, cc, receivedAt) =>
    db.prepare(
      `INSERT INTO messages (id, direction, mailbox, from_name, from_email, to_emails, cc,
         subject, body_text, received_at, status, read, starred, deleted, created_at, updated_at)
       VALUES (?, 'inbound', 'inbox@me.com', NULL, 'dirty@x.com', ?, ?, 's', 't', ?, 'received', 0, 0, 0, ?, ?)`
    ).run(id, to, cc, receivedAt, receivedAt, receivedAt);
  ins('dirty1', '', '', 600);        // both columns are empty strings (invalid JSON)
  ins('dirty2', '[]', null, 610);    // to_emails valid but cc is NULL

  let dirty = null;
  let threw = null;
  try {
    dirty = await repo.contacts(env);
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  ok(threw === null, '⭐ 存在脏行时 contacts() 不抛异常（抛了就是线上 500）', threw);
  ok(Array.isArray(dirty), '脏行下仍返回数组', typeof dirty);
  const dirtyEmails = (dirty || []).map((c) => c.email);
  ok(dirtyEmails.includes('dirty@x.com'),
    '脏行的 from_email 仍被正常收进联系人（容错而非整表丢弃）', JSON.stringify(dirtyEmails));
  ok(dirtyEmails.every((e) => typeof e === 'string' && e.trim() !== ''),
    '脏行的空串 to_emails/cc 没有变成空地址联系人', JSON.stringify(dirtyEmails));
  ok(!dirtyEmails.includes('null'), 'NULL 列没有被拼成字符串 "null"', JSON.stringify(dirtyEmails));

  /* ---- summary ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail ? `  [${f.detail}]` : ''}`);

  console.log(`\n被测版本: src/repo.ts md5=${REPO_MD5}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试脚本异常：', e && e.stack ? e.stack : e);
  cleanup();
  process.exit(2);
});
