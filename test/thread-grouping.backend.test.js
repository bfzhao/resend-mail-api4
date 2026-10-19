'use strict';

/* =============================================================================
 * Conversation (thread) grouping regression -- real SQLite as D1 + real compiled src/ artifacts + real Worker routing
 *
 * Run (this sandbox needs the tsc shim, see notes at end of file):
 *   NODE_OPTIONS="--require <temp dir>/mm-tsc-shim.js" node test/thread-grouping.backend.test.js
 * Normal environment:
 *   node test/thread-grouping.backend.test.js
 *
 * Exit codes: 0 = all pass; 1 = failures; 2 = missing environment (node:sqlite unavailable / tsc unavailable).
 *
 * ---------------------------------------------------------------------------
 * Production defects covered (user report: "after several back-and-forths, the conversation panel shows only two emails")
 *
 * Root cause (verified 2026-10-15 with 132 rows of real production D1 data):
 *   The `headers.references` returned by Resend's receiving API is **not** the RFC 5322 space-separated list,
 *   but **JSON array text** -- `["<a@b>","<c@d>"]`.
 *   The old `rootThreadId()` used `refs.split(/\s+/)[0]` to take the "first item", which grabbed the whole JSON text;
 *   `stripAngle()` only recognized leading/trailing angle brackets and could not strip square brackets -> `thread_id` ended up
 *   as a malformed value like `["<a@b>","<c@d>"]`.
 *   Worse, `reply()` pasted this JSON text verbatim into the new References and sent it back to Resend,
 *   so when the other side replied again the escaping grew one level deeper (production has already shown `["<\",\"<\\\",\\\"<\\\\\\\"...` four levels of nesting),
 *   so **the same physical thread got a new thread_id on every round trip**.
 *
 * Why "real Worker routing + real SQLite" instead of unit assertions:
 *   This defect takes the form of "the value written to the DB is wrong"; asserting only at the parameter level
 *   (what the Nth bound parameter is) locks the test to column order. Here the real handleInbound / reply run to completion,
 *   then `thread_id` is SELECTed back and compared, so what is asserted is the **final data**.
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
// QA_UTIL_TS / QA_INDEX_TS are only for "mutation verification": point them at a hand-crafted defective version of the source (outside the repo),
// to confirm this test really catches the defect. Without the hook, the mutation script would "run the repo's original file while thinking it is the variant" -> false green.
const UTIL_TS = process.env.QA_UTIL_TS || path.join(ROOT, 'src', 'util.ts');
const INDEX_TS = process.env.QA_INDEX_TS || path.join(ROOT, 'src', 'index.ts');
const WORK_DIR = path.join(os.tmpdir(), `thread-qa-build-${process.pid}`);
const SRC_COPY = path.join(WORK_DIR, 'src');
const BUILD_DIR = path.join(WORK_DIR, 'out');
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const SECRET = 'whsec_' + Buffer.from('a-test-signing-key-for-thread-grouping').toString('base64');
const MAILBOX = 'support@example.com';
const PEER = 'peer@upvote.network';

/* ---------------------------------------------------------------------------
 * 1) Copy the whole src/ outside the repo (variants override util.ts / index.ts) then compile
 *
 * Why copy src/: the QA_UTIL_TS / QA_INDEX_TS variants live outside the repo, and tsc needs a complete
 * src/ to compile. Copying once and then overwriting same-named files lets any variant be compiled
 * **without modifying the repo at all**.
 *
 * ⚠️ Two required companions (missing either one makes compilation fail, and the error looks unrelated to the variant):
 *   a) The temp dir is under os.tmpdir(), so both type resolution and bare-module resolution of the build
 *      output depend on node_modules -- WORK_DIR/node_modules must be linked to the repo's node_modules
 *      **before compiling**, otherwise it reports TS2688 Cannot find type definition file for '@cloudflare/workers-types';
 *   b) After switching module to commonjs, do **not** casually change moduleResolution: tsc here is
 *      TypeScript 7, `node10` has been removed (TS5108), and the repo's combination of 'bundler' with commonjs is accepted.
 * -------------------------------------------------------------------------*/
function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc: ${tsc}`);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(SRC_COPY, { recursive: true });

  try {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WORK_DIR, 'node_modules'), 'junction');
  } catch (e) {
    throw new Error(`无法为临时编译目录链接 node_modules: ${e.message}`);
  }

  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (f.endsWith('.ts')) fs.copyFileSync(path.join(ROOT, 'src', f), path.join(SRC_COPY, f));
  }
  // variant override (same dir, same name -> directly replaces the copied one)
  fs.copyFileSync(UTIL_TS, path.join(SRC_COPY, 'util.ts'));
  fs.copyFileSync(INDEX_TS, path.join(SRC_COPY, 'index.ts'));

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
  if (!fs.existsSync(path.join(BUILD_DIR, 'index.js'))) {
    throw new Error(`编译产物缺失: ${path.join(BUILD_DIR, 'index.js')}`);
  }
  return BUILD_DIR;
}

/** Clean up the temp compile dir (unmount the junction first, then delete, to avoid deleting repo deps). */
function cleanup() {
  const link = path.join(WORK_DIR, 'node_modules');
  try {
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch { /* ignore */ }
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ---------------------------------------------------------------------------
 * 2) Real SQLite impersonating D1 (tables created with schema.sql's real DDL)
 * -------------------------------------------------------------------------*/
function makeD1() {
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(schema);

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

  return {
    prepare,
    batch: async (arr) => { for (const s of arr) await s.run(); return []; },
    exec: async () => ({ count: 0, duration: 0 }),
    query: (sql, ...args) => db.prepare(sql).all(...norm(args)),
    queryOne: (sql, ...args) => {
      const r = db.prepare(sql).get(...norm(args));
      return r === undefined ? null : r;
    },
  };
}

/* ---------------------------------------------------------------------------
 * 3) Svix signature (same convention as production: v1,base64(HMAC-SHA256(secret, id.ts.payload)))
 * -------------------------------------------------------------------------*/
function svixHeaders(id, ts, body) {
  const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
}

/* ---------------------------------------------------------------------------
 * 4) Mini asserter
 * -------------------------------------------------------------------------*/
let pass = 0;
const results = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; results.push({ ok: true, msg }); console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { results.push({ ok: false, msg, detail }); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }
function info(t) { console.log(`  INFO  ${t}`); }

/** Old implementation's (defective) root derivation, used only for the "negative control group" -- proving the new implementation is not a no-op. */
function legacyRoot(references, inReplyTo, messageId) {
  const strip = (s) => {
    if (!s) return null;
    const t = String(s).trim();
    if (t.startsWith('<') && t.endsWith('>')) return t.slice(1, -1);
    return t || null;
  };
  const refs = (references || '').trim();
  if (refs) {
    const first = refs.split(/\s+/)[0];
    const root = strip(first);
    if (root) return root;
  }
  const inReply = strip(inReplyTo);
  if (inReply) return inReply;
  return strip(messageId) || '';
}

/** Clean References: only `<id>` separated by spaces allowed; must not contain square brackets / quotes / backslashes (signs of escaping pollution). */
const REFS_OK = /^(?:<[^<>\s]+>\s*)+$/;

/* ===========================================================================
 * Test cases
 * ===========================================================================*/
(async function main() {
  console.log('会话（thread）归组 —— 真实 SQLite + 真实编译产物 + 真实 Worker 路由');
  let entry;
  try {
    entry = build();
  } catch (e) {
    console.error(`\n编译失败，无法继续：${e.message}`);
    console.error('（受限沙箱下请加 tsc 垫片：NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js"）');
    process.exit(2);
  }

  const util = require(path.join(entry, 'util.js'));
  const repo = require(path.join(entry, 'repo.js'));
  const worker = require(path.join(entry, 'index.js'));
  const db = makeD1();

  console.log(`被测版本: src/util.ts md5=${md5(UTIL_TS)}${process.env.QA_UTIL_TS ? '  ← QA_UTIL_TS 变异体' : ''}`);
  console.log(`          src/index.ts md5=${md5(INDEX_TS)}${process.env.QA_INDEX_TS ? '  ← QA_INDEX_TS 变异体' : ''}`);

  /* ---- T0 environment self-check: prove the D1 stub and Worker entry really run, not a no-op ---- */
  section('T0 环境自检');
  await db.prepare('INSERT INTO messages (id, direction, to_emails, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .bind('self-check', 'inbound', '["x@y.com"]', 1, 1, 1).run();
  const selfRow = await db.prepare('SELECT COUNT(*) AS n FROM messages').first();
  ok(Number(selfRow.n) === 1, 'D1 桩确实把数据写进了真实 SQLite（否则后面全是空转）', selfRow.n);
  await db.prepare('DELETE FROM messages WHERE id = ?').bind('self-check').run();
  ok(typeof worker.default.fetch === 'function', 'Worker 入口已加载（走真实路由 + 真实 reply()）');
  ok(typeof util.rootThreadId === 'function' && typeof util.isSaneThreadId === 'function',
    '被测函数 rootThreadId / isSaneThreadId 存在（否则下面的断言会静默跳过）');

  /* ---- T1 unit: every References shape observed in production must resolve to the same correct root ---- */
  section('T1 rootThreadId 对生产实测形态的解析');
  const ROOT_ID = 'DM6PR02MB1234.abc@outlook.com';
  const shapes = [
    ['JSON 数组文本（Resend 真实形态）', `["<${ROOT_ID}>","<m2@x>"]`],
    ['JSON 数组单元素', `["<${ROOT_ID}>"]`],
    ['RFC 5322 空格分隔', `<${ROOT_ID}> <m2@x> <m3@x>`],
    ['单个 Message-ID', `<${ROOT_ID}>`],
    ['裸 Message-ID（无尖括号）', ROOT_ID],
    ['已被嵌套转义污染的历史值', `["<\\",\\"<\\\\\\"<${ROOT_ID}>\\\\\\">\\">"]`],
  ];
  for (const [label, refs] of shapes) {
    const got = util.rootThreadId({ references: refs, inReplyTo: null, messageId: null, fallback: 'fb' });
    ok(got === ROOT_ID, `${label} -> 根 = ${ROOT_ID}`, got);
  }
  ok(util.rootThreadId({ references: null, inReplyTo: `["<${ROOT_ID}>"]`, messageId: null, fallback: 'fb' }) === ROOT_ID,
    'References 缺失时回退 In-Reply-To（同样是 JSON 数组文本形态）');
  ok(util.rootThreadId({ references: null, inReplyTo: null, messageId: ROOT_ID, fallback: 'fb' }) === ROOT_ID,
    '两者都缺失时用自身 message_id');
  ok(util.rootThreadId({ references: '   ', inReplyTo: null, messageId: null, fallback: 'fb' }) === 'fb',
    '全空 -> 落到 fallback');

  /* ---- T1b negative control group: the old algorithm must produce malformed values on the same input ---- */
  section('T1b 负控制组：旧算法（split(/\s+/)[0] + stripAngle）确实会产出畸形值');
  const jsonRefs = `["<${ROOT_ID}>","<m2@x>"]`;
  const legacy = legacyRoot(jsonRefs, null, null);
  ok(legacy !== ROOT_ID, '⭐ 旧算法对 JSON 数组文本取不到根（否则「修复」无从谈起）', JSON.stringify(legacy));
  ok(/[[\]"]/.test(legacy), '旧算法结果里残留方括号/引号（畸形 thread_id 的特征）', JSON.stringify(legacy));
  ok(util.rootThreadId({ references: jsonRefs, inReplyTo: null, messageId: null, fallback: 'fb' }) === ROOT_ID,
    '⭐ 同一输入下新实现取到正确根（对照成立 -> 下面 T2 的断言不是空转）');

  /* ---- T1c isSaneThreadId: malformed detection ---- */
  section('T1c isSaneThreadId 判定');
  const saneCases = [
    ['正常 message-id 形态', 'DM6PR02MB1234.abc@outlook.com', true],
    ['内部 uuid（出站 message_id 就是它）', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', true],
    ['JSON 数组文本', `["<${ROOT_ID}>"]`, false],
    ['含空格', 'a b', false],
    ['含尖括号', '<a@b>', false],
    ['含反斜杠', 'a\\b', false],
    ['空串', '', false],
    ['null', null, false],
  ];
  for (const [label, v, expect] of saneCases) {
    ok(util.isSaneThreadId(v) === expect, `isSaneThreadId(${label}) === ${expect}`, String(util.isSaneThreadId(v)));
  }

  /* ---------------------------------------------------------------------------
   * T2 full chain: after 3 round trips, all emails must share the same thread_id
   * -------------------------------------------------------------------------*/
  const env = {
    DB: db,
    RESEND_WEBHOOK_SECRET: SECRET,
    RESEND_API_KEY: 're_test',
    SEND_FROM_ADDRESS: MAILBOX,
    SEND_FROM_NAME: 'Support',
  };

  // stub Resend's outbound sending and received-content fetch (both go through global fetch)
  let lastReceived = null;
  const sentBodies = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/emails/receiving/')) return jsonRes(lastReceived);
    if (u.includes('/emails')) {
      sentBodies.push(init && init.body ? JSON.parse(init.body) : null);
      return jsonRes({ id: `resend_${sentBodies.length}` });
    }
    return jsonRes({});
  };

  let seq = 0;
  async function postInbound(payload) {
    const body = JSON.stringify(payload);
    const id = `msg_${++seq}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const req = new Request('https://example.com/webhook/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...svixHeaders(id, ts, body) },
      body,
    });
    return worker.default.fetch(req, env);
  }

  /** Build a received email; extra overrides any field (headers / message_id / ...). */
  function receivedEmail(emailId, extra) {
    return Object.assign({
      id: emailId,
      from: `Peer <${PEER}>`,
      subject: '往返测试',
      html: '<p>hi</p>',
      text: 'hi',
      created_at: new Date(1700000000000 + seq * 60000).toISOString(),
      message_id: `<${emailId}@upvote.network>`,
      to: MAILBOX,
      headers: {},
      attachments: [],
    }, extra || {});
  }

  async function replyViaApi(rowId, text) {
    const req = new Request(`https://example.com/api/messages/${rowId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: text, mailbox: MAILBOX }),
    });
    const res = await worker.default.fetch(req, env);
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  section('T2 ⭐ 3 轮往返：thread_id 必须自始至终只有一个');
  const threadIds = [];
  const rowIds = [];

  // ---- 1st incoming email: no References / In-Reply-To at all ----
  lastReceived = receivedEmail('m1');
  let res = await postInbound({ type: 'email.received', data: { email_id: 'm1' } });
  ok(res.status === 200, '入站 #1 处理成功', res.status);
  const in1 = db.queryOne('SELECT id, thread_id, message_id FROM messages WHERE resend_id = ?', 'm1');
  ok(!!in1, '入站 #1 已入库', in1 && in1.id);
  ok(in1 && in1.thread_id === 'm1@upvote.network', '入站 #1 的 thread_id = 自身 message_id', in1 && in1.thread_id);
  threadIds.push(in1.thread_id);
  rowIds.push(in1.id);

  // ---- we reply to the 1st email ----
  let r = await replyViaApi(in1.id, '第一封回复');
  ok(r.status === 200 && r.json && r.json.ok === true, '回复 #1 发送成功', JSON.stringify(r.json));
  // always take the outbound row id from the API response: the three outbound received_at values fall in the same second,
  // and using `ORDER BY received_at DESC LIMIT 1` to get the "latest row" is nondeterministic on ties.
  const out1 = db.queryOne('SELECT id, thread_id, "references" AS refs, in_reply_to FROM messages WHERE id = ?', r.json.id);
  ok(!!out1, '出站 #1 已入库', r.json.id);
  ok(out1 && out1.thread_id === 'm1@upvote.network',
    '⭐ 出站 #1 继承原邮件 thread_id（不是按 References 重新推导出一个新会话）', out1 && out1.thread_id);
  threadIds.push(out1.thread_id);
  rowIds.push(out1.id);

  // ---- 2nd incoming email: Resend's real References shape (JSON array text) ----
  // the peer's client references "our email" using the RFC Message-ID Resend generated (which we did not retain),
  // so an equivalent placeholder is used here, shaped the same as production.
  const RESEND_MID_1 = 'a1b2c3d4-1111-2222-3333-444455556666@smtp.resend.com';
  lastReceived = receivedEmail('m2', {
    headers: { References: `["<m1@upvote.network>"]`, 'In-Reply-To': `["<${RESEND_MID_1}>"]` },
  });
  res = await postInbound({ type: 'email.received', data: { email_id: 'm2' } });
  ok(res.status === 200, '入站 #2 处理成功', res.status);
  const in2 = db.queryOne('SELECT id, thread_id, "references" AS refs, in_reply_to FROM messages WHERE resend_id = ?', 'm2');
  ok(in2 && in2.thread_id === 'm1@upvote.network',
    '⭐⭐ 入站 #2 与第 1 封同会话（旧实现在这里会落成畸形 thread_id）', in2 && in2.thread_id);
  threadIds.push(in2.thread_id);
  rowIds.push(in2.id);

  // negative control: the thread_id computed by the old algorithm differs from the real conversation -- this is the evidence of "fragmentation"
  const legacyIn2 = legacyRoot(`["<m1@upvote.network>"]`, `["<${RESEND_MID_1}>"]`, '<m2@upvote.network>');
  ok(legacyIn2 !== 'm1@upvote.network',
    '⭐ 负控制：旧算法把入站 #2 归到了另一个会话（用户看到的「会话里只有两封」）', JSON.stringify(legacyIn2));

  ok(in2 && in2.in_reply_to === RESEND_MID_1,
    '入站 #2 的 in_reply_to 是干净的 Message-ID（旧实现会残留 `["` 前缀）', in2 && JSON.stringify(in2.in_reply_to));

  // ---- we reply to the 2nd email ----
  r = await replyViaApi(in2.id, '第二封回复');
  ok(r.status === 200 && r.json && r.json.ok === true, '回复 #2 发送成功', JSON.stringify(r.json));
  const out2 = db.queryOne('SELECT id, thread_id, "references" AS refs FROM messages WHERE id = ?', r.json.id);
  ok(out2 && out2.thread_id === 'm1@upvote.network', '出站 #2 仍是同一个 thread_id', out2 && out2.thread_id);
  threadIds.push(out2.thread_id);
  rowIds.push(out2.id);

  // ---- 3rd incoming email: the References chain has grown longer ----
  const RESEND_MID_2 = 'b2c3d4e5-2222-3333-4444-555566667777@smtp.resend.com';
  lastReceived = receivedEmail('m3', {
    headers: {
      References: `["<m1@upvote.network>","<m2@upvote.network>","<${RESEND_MID_2}>"]`,
      'In-Reply-To': `["<${RESEND_MID_2}>"]`,
    },
  });
  res = await postInbound({ type: 'email.received', data: { email_id: 'm3' } });
  ok(res.status === 200, '入站 #3 处理成功', res.status);
  const in3 = db.queryOne('SELECT id, thread_id FROM messages WHERE resend_id = ?', 'm3');
  ok(in3 && in3.thread_id === 'm1@upvote.network', '入站 #3 仍在同一会话', in3 && in3.thread_id);
  threadIds.push(in3.thread_id);
  rowIds.push(in3.id);

  r = await replyViaApi(in3.id, '第三封回复');
  ok(r.status === 200, '回复 #3 发送成功', r.status);
  const out3 = db.queryOne('SELECT id, thread_id FROM messages WHERE id = ?', r.json.id);
  threadIds.push(out3.thread_id);
  rowIds.push(out3.id);

  const uniq = Array.from(new Set(threadIds));
  ok(uniq.length === 1, `⭐⭐⭐ 6 封邮件（3 来 3 回）只落 1 个 thread_id（实际 ${uniq.length} 个）`, uniq.join(' | '));
  ok(uniq[0] === 'm1@upvote.network', '会话 id 就是整条链的根 Message-ID', uniq[0]);

  // ---- conversation panel: not a single round trip may be missing ----
  const threadRows = await repo.listThread(env, uniq[0]);
  ok(threadRows.length === 6, `⭐ 会话面板能看到全部 6 封（修复前只有 2 封）`, String(threadRows.length));
  const threadRowIds = threadRows.map((x) => x.id).sort();
  ok(threadRowIds.join(',') === rowIds.slice().sort().join(','), '会话里的每一行都对应到上面那 6 封邮件');

  /* ---- T3 the References written on replies must no longer contain square brackets / quotes / backslashes (prevent nested-escaping recurrence) ---- */
  section('T3 出站 References 必须是规范的空格分隔列表');
  const outRows = db.query('SELECT "references" AS refs, thread_id FROM messages WHERE direction = ?', 'outbound');
  ok(outRows.length === 3, '出站共 3 行（前置条件）', String(outRows.length));
  for (const row of outRows) {
    const refs = row.refs || '';
    ok(REFS_OK.test(refs), `References 形态规范：${JSON.stringify(refs)}`, JSON.stringify(refs));
    ok(!/[[\]"\\]/.test(refs), '不含方括号 / 引号 / 反斜杠（转义污染的特征）', JSON.stringify(refs));
  }
  const refsOfOut3 = outRows[outRows.length - 1].refs;
  info(`出站 #3 的 References = ${JSON.stringify(refsOfOut3)}`);

  // precisely lock down the chain semantics: outbound References = original email's References chain + original email's Message-ID (deduped).
  // This is also the regression gate for "nested escaping": the old implementation pasted the whole JSON text again,
  // so the length exploded each round (production measured 178 -> 334 -> 500 -> 686), and the equality assertions below fail immediately.
  const sortedOut = outRows.slice().sort((a, b) => (a.refs || '').length - (b.refs || '').length);
  ok(sortedOut[0].refs === '<m1@upvote.network>',
    '出站 #1 的 References = `<m1@upvote.network>`（只有根）', JSON.stringify(sortedOut[0].refs));
  ok(sortedOut[1].refs === '<m1@upvote.network> <m2@upvote.network>',
    '出站 #2 的 References = 根 + 上一封（不重复、不带方括号）', JSON.stringify(sortedOut[1].refs));
  ok(sortedOut[2].refs === `<m1@upvote.network> <m2@upvote.network> <${RESEND_MID_2}> <m3@upvote.network>`,
    '出站 #3 的 References = 完整链（长度线性增长，不是逐轮翻倍转义）', JSON.stringify(sortedOut[2].refs));

  /* ---- T4 historical malformed data: when the original thread_id is unclean it must fall back to derivation, not propagate the malformed value ---- */
  section('T4 历史畸形 thread_id 的兜底（回退按 References 重新推导）');
  const malformed = `["<m1@upvote.network>","<m2@upvote.network>"]`;
  await db.prepare('UPDATE messages SET thread_id = ? WHERE resend_id = ?').bind(malformed, 'm3').run();
  lastReceived = receivedEmail('m4', {
    headers: { References: `["<m1@upvote.network>","<m2@upvote.network>"]` },
  });
  res = await postInbound({ type: 'email.received', data: { email_id: 'm4' } });
  ok(res.status === 200, '入站 #4 处理成功', res.status);
  const in4 = db.queryOne('SELECT id, thread_id FROM messages WHERE resend_id = ?', 'm4');
  ok(in4 && in4.thread_id === 'm1@upvote.network', '入站 #4 按 References 归到根会话', in4 && in4.thread_id);
  const r4 = await replyViaApi(in4.id, '回复畸形会话');
  ok(r4.status === 200, '回复 #4 发送成功', r4.status);
  const out4 = db.queryOne('SELECT id, thread_id FROM messages WHERE id = ?', r4.json.id);
  ok(out4 && out4.thread_id === 'm1@upvote.network',
    '⭐ 回复时不会把畸形 thread_id 传下去（回退推导出干净值）', out4 && out4.thread_id);
  ok(out4 && util.isSaneThreadId(out4.thread_id) === true, '新出站行的 thread_id 通过 isSaneThreadId 检查', out4 && out4.thread_id);

  /* ---- summary ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r2) => !r2.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);
  console.log(`\n===== 结果: ${pass} passed, ${failed.length} failed =====`);
  cleanup();
  process.exit(failed.length ? 1 : 0);
})();
