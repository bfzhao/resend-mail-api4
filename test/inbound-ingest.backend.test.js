'use strict';

/* =============================================================================
 * Inbound/outbound storage semantics regression verification (real SQLite as D1 + real src/ build output)
 *
 * Run (this sandbox needs the tsc shim, see the notes at the end of the file):
 *   NODE_OPTIONS="--require <temp dir>/mm-tsc-shim.js" node test/inbound-ingest.backend.test.js
 * Normal environment:
 *   node test/inbound-ingest.backend.test.js
 *
 * Exit codes: 0 = all pass; 1 = failures; 2 = missing environment (node:sqlite unavailable / tsc unavailable).
 *
 * Covers two defects observed in production (2026-09-29):
 *   ① The sidebar showed an "(unrecognized)" group, but clicking in it was actually all mail for support@example.com.
 *      Root cause: the hand-written `Array.isArray(data.to)` in pickMailbox() only accepts arrays, while the webhook payload's
 *      `data.to` / the Received Emails API's `email.to` **can both be strings**.
 *   ② The outbox showed everything as unread, and opening it did not change that. Root cause: insertMessageStmt hard-coded read to 0.
 *
 * Why real SQLite: both defects are "the value stored in the DB is wrong", and asserting only at the parameter level
 * (say, asserting the 20th bound parameter is 1) would lock the test to column order. Here the real D1 statements
 * run against real SQLite, then are SELECTed back and compared, so what is asserted is the **final data**.
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
// to confirm this test really catches the defect. Without the hook, the mutation script would "run the repo's original file while thinking it is the variant" -> false green.
const REPO_TS = process.env.QA_REPO_TS || path.join(ROOT, 'src', 'repo.ts');
const WORK_DIR = path.join(os.tmpdir(), `ingest-qa-build-${process.pid}`);
const SRC_COPY = path.join(WORK_DIR, 'src');
const BUILD_DIR = path.join(WORK_DIR, 'out');
const REPO_MD5 = crypto.createHash('md5').update(fs.readFileSync(REPO_TS)).digest('hex');
const SECRET = 'whsec_' + Buffer.from('a-test-signing-key-for-inbound-webhook').toString('base64');
const MAILBOX = 'support@example.com';

/* ---------------------------------------------------------------------------
 * 1) Copy the whole src/ outside the repo (variant overrides repo.ts) then compile, to get the real repo.*
 *
 * Why copy src/ instead of compiling the repo's src/ directly: the QA_REPO_TS variant is outside the repo,
 * and tsc needs a complete src/ to compile. Copy once then overwrite the same-named file, and any variant can be compiled
 * **without modifying the repo at all**.
 * The temp tsconfig is derived from the repo tsconfig (only swapping noEmit/module/outDir/rootDir + files),
 * avoiding config drift from hand-copying compilerOptions.
 *
 * ⚠️ Two required companions (missing either one makes compilation fail, and the error looks unrelated to the variant):
 *   a) The temp dir is under os.tmpdir(), so type resolution (types: ['@cloudflare/workers-types']) and
 *      bare-module resolution of the output both depend on node_modules -- WORK_DIR/node_modules must be
 *      linked to the repo's node_modules **before compiling**, otherwise it reports
 *      TS2688 Cannot find type definition file for '@cloudflare/workers-types';
 *   b) After switching module to commonjs do **not** casually change moduleResolution: tsc here is
 *      TypeScript 7, `node10` has been removed (TS5108), and the repo's combination of 'bundler'
 *      with commonjs is accepted.
 * -------------------------------------------------------------------------*/
function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc: ${tsc}`);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(SRC_COPY, { recursive: true });

  // (a) establish the node_modules link before compiling
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
    module: 'commonjs', // moduleResolution keeps the repo's 'bundler' (see b above)
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

/**
 * Clean up the temp build dir.
 *
 * WORK_DIR/node_modules is a junction pointing at the **repo node_modules**. In testing
 * fs.rmSync(WORK_DIR, {recursive:true}) does not follow the junction to delete the target, but if the deletion order ever goes wrong
 * it is an irreversible "delete the repo dependencies" accident -- explicitly unmount the link first and then delete the dir, costing only a few lines.
 */
function cleanup() {
  const link = path.join(WORK_DIR, 'node_modules');
  try {
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch { /* ignore */ }
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ---------------------------------------------------------------------------
 * 2) Use real SQLite as D1 (create tables with schema.sql's real DDL)
 * -------------------------------------------------------------------------*/
function makeD1() {
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(schema);

  // node:sqlite does not accept undefined (D1 accepts it and treats it as NULL) -- normalize uniformly, otherwise it throws a TypeError
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
    /** test-only: query the DB directly */
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
 * 4) mini asserter
 * -------------------------------------------------------------------------*/
let pass = 0;
const results = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; results.push({ ok: true, msg }); console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { results.push({ ok: false, msg, detail }); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/* ---------------------------------------------------------------------------
 * 5) test cases
 * -------------------------------------------------------------------------*/
(async function main() {
  console.log('入站/出站入库语义 —— 真实 SQLite + 真实编译产物验证');
  let entry;
  try {
    entry = build();
  } catch (e) {
    console.error(`\n编译失败，无法继续：${e.message}`);
    console.error('（受限沙箱下请加 tsc 垫片：NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js"）');
    process.exit(2);
  }

  const repo = require(path.join(entry, 'repo.js'));
  const webhook = require(path.join(entry, 'webhook.js'));
  const db = makeD1();

  const FINGERPRINT = {
    // ⚠️ the repo.ts fingerprint must be taken from **the file actually compiled** (the QA_REPO_TS variant or the repo original),
    //    otherwise a mutation run would print the md5 of the repo original -> making people wrongly think the variant took effect.
    'src/repo.ts': REPO_MD5,
    'src/webhook.ts': crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, 'src', 'webhook.ts'))).digest('hex'),
  };
  console.log(`被测版本: src/repo.ts md5=${FINGERPRINT['src/repo.ts']}${process.env.QA_REPO_TS ? '  ← QA_REPO_TS 变异体' : ''}  src/webhook.ts md5=${FINGERPRINT['src/webhook.ts']}`);

  /* ---- environment self-check: prove the D1 stub really runs SQL, not idle ---- */
  section('T0 环境自检');
  await db.prepare('INSERT INTO messages (id, direction, to_emails, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .bind('self-check', 'inbound', '["x@y.com"]', 1, 1, 1).run();
  const selfRow = await db.prepare('SELECT COUNT(*) AS n FROM messages').first();
  ok(Number(selfRow.n) === 1, 'D1 桩确实把数据写进了真实 SQLite（否则后面全是空转）', selfRow.n);
  await db.prepare('DELETE FROM messages WHERE id = ?').bind('self-check').run();

  /* ---- inbound: full webhook chain (including signature verification)---- */
  const inboundEnv = { DB: db, RESEND_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: 're_test' };
  let lastEmailResponse = null;

  // stub out Resend's Received Emails API (the webhook only carries metadata; the body is pulled via this endpoint)
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/emails/receiving/')) {
      return new Response(JSON.stringify(lastEmailResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
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
    return webhook.handleInbound(req, inboundEnv);
  }

  /** Build a received email: the to shape can be specified as string / array / missing; extra overrides any field (headers / cc / ...). */
  function receivedEmail(emailId, to, extra) {
    const base = {
      id: emailId,
      from: 'Sender <hello@upvote.network>',
      subject: '测试主题',
      html: '<p>hi</p>',
      text: 'hi',
      created_at: new Date().toISOString(),
      message_id: `<${emailId}@upvote.network>`,
      headers: {},
      attachments: [],
    };
    if (to !== undefined) base.to = to;
    return Object.assign(base, extra || {});
  }

  section('T1 签名负控制组');
  {
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'x' } });
    const bad = new Request('https://example.com/webhook/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': 'm1', 'svix-timestamp': '1', 'svix-signature': 'v1,AAAA' },
      body,
    });
    const res = await webhook.handleInbound(bad, inboundEnv);
    ok(res.status === 401, '错误签名 → 401（否则下面的 200 不能说明签名真的被校验了）', res.status);
  }

  section('T2 ⭐ 入站 to 是【字符串】→ mailbox 必须归到该地址（用户报的「(未识别)」）');
  {
    const emailId = 'em_str_1';
    lastEmailResponse = receivedEmail(emailId, MAILBOX); // <- string, not an array
    const res = await postInbound({ type: 'email.received', data: { email_id: emailId } });
    ok(res.status === 200, 'webhook 处理成功', res.status);
    const row = db.queryOne('SELECT mailbox, direction, read, to_emails FROM messages WHERE resend_id = ?', emailId);
    ok(!!row, '邮件已入库', row && row.id);
    ok(row && row.mailbox === MAILBOX,
      '⭐ mailbox 归到 support@example.com（不再是空串 → 侧边栏不会再出现「(未识别)」）',
      row && JSON.stringify(row.mailbox));
    ok(row && JSON.parse(row.to_emails)[0] === MAILBOX, 'to_emails 正确', row && row.to_emails);
  }

  section('T3 入站 to 是【数组】→ 行为不能回退');
  {
    const emailId = 'em_arr_1';
    lastEmailResponse = receivedEmail(emailId, [MAILBOX]);
    const res = await postInbound({ type: 'email.received', data: { email_id: emailId } });
    ok(res.status === 200, 'webhook 处理成功', res.status);
    const row = db.queryOne('SELECT mailbox FROM messages WHERE resend_id = ?', emailId);
    ok(row && row.mailbox === MAILBOX, '数组形态同样正确归类', row && JSON.stringify(row.mailbox));
  }

  section('T4 received_for 优先于 to');
  {
    const emailId = 'em_rf_1';
    lastEmailResponse = receivedEmail(emailId, 'other@example.com');
    const res = await postInbound({
      type: 'email.received',
      data: { email_id: emailId, received_for: ['dana@example.com'] },
    });
    ok(res.status === 200, 'webhook 处理成功', res.status);
    const row = db.queryOne('SELECT mailbox FROM messages WHERE resend_id = ?', emailId);
    ok(row && row.mailbox === 'dana@example.com',
      'received_for 优先（官方推荐口径，不得被 to 覆盖）', row && JSON.stringify(row.mailbox));
  }

  section('T5 to 完全缺失 → 仍可入库（兜底不崩）');
  {
    const emailId = 'em_none_1';
    lastEmailResponse = receivedEmail(emailId, undefined); // do not set to
    const res = await postInbound({ type: 'email.received', data: { email_id: emailId } });
    ok(res.status === 200, 'webhook 处理成功（不因缺 to 而 500）', res.status);
    const row = db.queryOne('SELECT mailbox FROM messages WHERE resend_id = ?', emailId);
    ok(!!row, '邮件已入库', row && row.mailbox);
    ok(row && row.mailbox === '', '确实无从推断时才落到空串（由前端 UNKNOWN_MAILBOX 兜底展示）',
      row && JSON.stringify(row.mailbox));
  }

  section('T6 入站邮件 read 必须为 0（未读是入站的正确初态）');
  {
    const rows = db.query('SELECT read FROM messages WHERE direction = ?', 'inbound');
    const allZero = rows.length > 0 && rows.every((r) => Number(r.read) === 0);
    ok(allZero, '全部入站邮件 read = 0', rows.map((r) => r.read).join(','));
  }

  section('T7 ⭐ 出站邮件 read 必须为 1（用户报的「发件箱全是未读」）');
  {
    await repo.saveOutbound(inboundEnv, {
      messageId: null, inReplyTo: null, references: null, threadId: 't-out-1',
      mailbox: MAILBOX, fromName: 'support', fromEmail: MAILBOX,
      to: ['dana@outlook.com'], cc: [], subject: '出站测试',
      html: '<p>x</p>', text: 'x', resendId: 're_out_1', receivedAt: 1788800000,
    });
    const row = db.queryOne('SELECT direction, read, mailbox FROM messages WHERE resend_id = ?', 're_out_1');
    ok(!!row, '出站邮件已入库', row && row.direction);
    ok(row && Number(row.read) === 1,
      '⭐ 出站邮件 read = 1（发件箱不再显示未读，且不依赖前端补偿）', row && row.read);
    ok(row && row.mailbox === MAILBOX, '出站 mailbox 正确', row && row.mailbox);
  }

  section('T8 出站 read 可被显式覆盖（保留调用方指定能力）');
  {
    await repo.saveInbound(inboundEnv, {
      rowId: 'row-explicit', resendId: 're_in_explicit', messageId: null, inReplyTo: null, references: null,
      threadId: 't-in-2', mailbox: MAILBOX, fromName: null, fromEmail: 'a@b.com',
      to: [MAILBOX], cc: [], bcc: [], replyTo: [], subject: 's', html: null, text: 't',
      receivedAt: 1788800001, attachments: [],
    }, 'evt-explicit');
    const row = db.queryOne('SELECT read FROM messages WHERE id = ?', 'row-explicit');
    ok(row && Number(row.read) === 0, '入站仍为 0（默认值只对出站生效）', row && row.read);
  }

  section('T9 ⭐ 列表查询必须带回 mailbox（信封卡乐观渲染靠它显示「收至 …」）');
  {
    const res = await repo.listFolder(inboundEnv, { folder: 'inbox', limit: 50, offset: 0 });
    ok(res.items.length > 0, '列表有数据（否则下面的断言空转）', res.items.length);
    ok(res.items.every((it) => Object.prototype.hasOwnProperty.call(it, 'mailbox')),
      'LIST_SELECT 每一行都带 mailbox 字段', JSON.stringify(Object.keys(res.items[0] || {})));
    const mine = res.items.find((it) => it.mailbox === MAILBOX);
    ok(!!mine, 'mailbox 的值正确（不是恒 null / 恒空串）', mine && mine.mailbox);

    // negative control: rows for different mailboxes each carry their own value, ruling out "all rows happen to be the same" also passing
    await repo.saveInbound(inboundEnv, {
      rowId: 'row-other-mb', resendId: 're_in_other', messageId: null, inReplyTo: null, references: null,
      threadId: 't-in-3', mailbox: 'other@example.com', fromName: null, fromEmail: 'a@b.com',
      to: ['other@example.com'], cc: [], bcc: [], replyTo: [], subject: 's', html: null, text: 't',
      receivedAt: 1788800002, attachments: [],
    }, 'evt-other');
    const res2 = await repo.listFolder(inboundEnv, { folder: 'inbox', limit: 50, offset: 0 });
    const other = res2.items.find((it) => it.id === 'row-other-mb');
    ok(other && other.mailbox === 'other@example.com',
      '负控制：不同信箱的行各自带回自己的 mailbox（区分度成立）', other && other.mailbox);
  }

  section('T10 ⭐ 入站收件人 = 真实 To: 头，投递地址另存 delivered_to');
  {
    // measured on production data (user report): sender erin@example.com sends to
    //   To: frank@example.net, Cc: dana@example.com
    // The `to` returned by Resend's receiving API is the **delivery address** (dana@example.com),
    // the real To header is only kept in `headers.to`. Previously `email.to` was stored directly as the recipient ->
    // the detail page's "recipient" showed the user themselves.
    const emailId = 'em_cc_1';
    lastEmailResponse = receivedEmail(emailId, ['dana@example.com'], {
      headers: { to: 'Frank Valencia <frank@example.net>' },
      cc: ['dana@example.com'],
    });
    const res = await postInbound({
      type: 'email.received',
      data: { email_id: emailId, received_for: ['dana@example.com'], cc: ['dana@example.com'] },
    });
    ok(res.status === 200, 'webhook 处理成功', res.status);
    const row = db.queryOne('SELECT mailbox, to_emails, delivered_to, cc FROM messages WHERE resend_id = ?', emailId);
    ok(!!row, '邮件已入库', row && row.id);
    ok(row && row.mailbox === 'dana@example.com', 'mailbox = 实际投递信箱', row && row.mailbox);
    ok(row && JSON.stringify(JSON.parse(row.to_emails)) === JSON.stringify(['frank@example.net']),
      '⭐ to_emails = 真实 To: 头（不再是投递地址 → 不会再显示成自己）', row && row.to_emails);
    ok(row && JSON.stringify(JSON.parse(row.delivered_to)) === JSON.stringify(['dana@example.com']),
      '⭐ delivered_to = 投递地址（信封收件人），单独一列存', row && row.delivered_to);
    ok(row && JSON.stringify(JSON.parse(row.cc)) === JSON.stringify(['dana@example.com']),
      'cc 仍存真实抄送头（前端据此判定「你是抄送」）', row && row.cc);
  }

  section('T10b 负控制：拿不到 headers.to 时回退投递地址（行为不倒退）');
  {
    const emailId = 'em_noheaderto_1';
    lastEmailResponse = receivedEmail(emailId, ['dana@example.com'], { headers: {} });
    const res = await postInbound({ type: 'email.received', data: { email_id: emailId } });
    ok(res.status === 200, 'webhook 处理成功', res.status);
    const row = db.queryOne('SELECT to_emails, delivered_to FROM messages WHERE resend_id = ?', emailId);
    ok(row && JSON.stringify(JSON.parse(row.to_emails)) === JSON.stringify(['dana@example.com']),
      'to_emails 回退到投递地址（取不到头时不至于丢收件人）', row && row.to_emails);
    ok(row && JSON.stringify(JSON.parse(row.delivered_to)) === JSON.stringify(['dana@example.com']),
      'delivered_to 照常写入', row && row.delivered_to);
  }

  section('T11 ⭐ 附件代理：可预览类型内联，其余下载；forceDownload 强制下载');
  {
    const bytes = new TextEncoder().encode('x');
    const mkBucket = (key, data) => ({
      async get(k) { return k === key ? { size: data.length, body: data } : null; },
      async put() { return {}; },
    });
    const putAtt = (id, key, filename, type, env) =>
      db.prepare(
        'INSERT INTO attachments (id, message_id, r2_key, filename, content_type, size, inline, content_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(id, 'row-att', key, filename, type, bytes.length, 0, null, 1).run();

    // attachments.message_id has a foreign key constraint, so first create a host message
    await db.prepare('INSERT INTO messages (id, direction, to_emails, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .bind('row-att', 'inbound', '[]', 1, 1, 1).run();

    // ① type-classification pure function: same convention as the frontend attachmentKind()
    const cases = [
      ['image/png', true], ['image/jpeg', true], ['image/webp', true],
      ['image/svg+xml', false], // ⭐ SVG can carry <script>; inlining it into the same origin = XSS
      ['application/pdf', true], ['video/mp4', true], ['audio/mpeg', true],
      ['text/plain', true], ['text/csv', true], ['application/json', true],
      ['text/html', false], ['application/zip', false], ['application/octet-stream', false],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', false], ['', false],
    ];
    for (const [t, want] of cases) {
      const got = repo.isInlinePreviewType(t);
      ok(got === want, `isInlinePreviewType(${JSON.stringify(t)}) === ${want}`, got);
    }

    // ② actually run the proxy once: Content-Disposition decides whether the browser "opens in place" or "saves to disk"
    const pngEnv = { DB: db, BUCKET: mkBucket('k-png', bytes) };
    await putAtt('att-png', 'k-png', 'pic.png', 'image/png');
    const r1 = await repo.proxyAttachment(pngEnv, 'att-png');
    ok(r1 && /^inline/i.test(r1.headers.get('Content-Disposition') || ''),
      'image/png → inline（点开即预览）', r1 && r1.headers.get('Content-Disposition'));
    const r2 = await repo.proxyAttachment(pngEnv, 'att-png', { forceDownload: true });
    ok(r2 && /^attachment/i.test(r2.headers.get('Content-Disposition') || ''),
      '⭐ forceDownload（路由的 ?dl=1）→ attachment，下载按钮拿到的确实是文件', r2 && r2.headers.get('Content-Disposition'));

    const svgEnv = { DB: db, BUCKET: mkBucket('k-svg', bytes) };
    await putAtt('att-svg', 'k-svg', 'x.svg', 'image/svg+xml');
    const r3 = await repo.proxyAttachment(svgEnv, 'att-svg');
    ok(r3 && /^attachment/i.test(r3.headers.get('Content-Disposition') || ''),
      '⭐ image/svg+xml → attachment（可执行脚本，绝不内联）', r3 && r3.headers.get('Content-Disposition'));

    const pdfEnv = { DB: db, BUCKET: mkBucket('k-pdf', bytes) };
    await putAtt('att-pdf', 'k-pdf', 'doc.pdf', 'application/pdf');
    const r4 = await repo.proxyAttachment(pdfEnv, 'att-pdf');
    ok(r4 && /^inline/i.test(r4.headers.get('Content-Disposition') || ''),
      'application/pdf → inline（浏览器内置查看器）', r4 && r4.headers.get('Content-Disposition'));

    const zipEnv = { DB: db, BUCKET: mkBucket('k-zip', bytes) };
    await putAtt('att-zip', 'k-zip', 'a.zip', 'application/zip');
    const r5 = await repo.proxyAttachment(zipEnv, 'att-zip');
    ok(r5 && /^attachment/i.test(r5.headers.get('Content-Disposition') || ''),
      'application/zip → attachment（浏览器不会预览，别指望它）', r5 && r5.headers.get('Content-Disposition'));

    // ③ negative control: nonexistent / R2 missing object both return null (otherwise the "404" path would never be verified)
    ok((await repo.proxyAttachment(pngEnv, 'no-such-id')) === null, '未知附件 id → null（路由转 404）');
    const emptyEnv = { DB: db, BUCKET: mkBucket('nope', bytes) };
    ok((await repo.proxyAttachment(emptyEnv, 'att-png')) === null, 'R2 里没有对象 → null（不返回空 200）');
  }

  /* -------------------------------------------------------------------------
   * T12 thread context (listThread): descending + collapse "loopback copies of the same physical email"
   *
   * Measured on production data (2026-10-08): the account had multiple receiving mailboxes configured; when sending from dana@ and cc'ing
   * erin@, Resend delivered the same email back to erin@, so the DB had both an outbound copy and an
   * inbound copy; both had identical from/to/cc/subject/in_reply_to, with insertion times 1~2 seconds apart,
   * and appeared byte-for-byte identical in the thread panel -> the user reported "the same email shows twice".
   * -----------------------------------------------------------------------*/
  section('T12 会话上下文：降序 + 折叠回环副本');

  let t12seq = 0;
  /** Create an outbound record. Default sender is dana@example.com (this account's identity). */
  async function addOut(threadId, opts) {
    const rid = `t12-out-${++t12seq}`;
    await repo.saveOutbound(inboundEnv, {
      messageId: null, inReplyTo: null, references: null, threadId,
      mailbox: opts.mailbox || 'dana@example.com',
      fromName: null, fromEmail: opts.from || 'dana@example.com',
      to: opts.to || [], cc: opts.cc || [], bcc: opts.bcc || [],
      subject: opts.subject || 'Re: T12', html: null, text: 'x',
      resendId: `re-${rid}`, receivedAt: opts.at,
    });
    return rid;
  }
  /** Create an inbound record (read defaults to 0, matching real inbound). */
  async function addIn(threadId, opts) {
    const rid = `t12-in-${++t12seq}`;
    await repo.saveInbound(inboundEnv, {
      rowId: rid, resendId: `re-${rid}`, messageId: `${rid}@ses`, inReplyTo: null, references: null,
      threadId,
      mailbox: opts.mailbox || 'erin@example.com',
      fromName: null, fromEmail: opts.from || 'dana@example.com',
      to: opts.to || [], deliveredTo: opts.deliveredTo || null,
      cc: opts.cc || [], bcc: opts.bcc || [], replyTo: [],
      subject: opts.subject || 'Re: T12', html: null, text: 'x',
      receivedAt: opts.at, attachments: [],
    }, `evt-${rid}`);
    return rid;
  }

  /* ---- T12a ordering: most recent first ---- */
  {
    const TID = 't12-order';
    await addOut(TID, { at: 1000, to: ['a@x.com'] });
    await addOut(TID, { at: 3000, to: ['a@x.com'] });
    await addOut(TID, { at: 2000, to: ['a@x.com'] });
    const th = await repo.listThread(inboundEnv, TID);
    ok(th.length === 3, '前置：会话里有 3 条（否则下面的顺序断言空转）', th.length);
    ok(th.map((r) => r.received_at).join(',') === '3000,2000,1000',
      '⭐ 会话按 received_at 降序（最近 → 最早）', th.map((r) => r.received_at).join(','));
    ok(th.map((r) => r.received_at).join(',') !== '1000,2000,3000',
      '负控制：不是升序（旧实现会返回 1000,2000,3000）', th.map((r) => r.received_at).join(','));
    ok(th[0].received_at > th[th.length - 1].received_at,
      '首条确实比末条新', `${th[0].received_at} > ${th[th.length - 1].received_at}`);
  }

  /* ---- T12b collapse: the real production shape (cc another mailbox on this account -> delivery loopback)---- */
  {
    const TID = 't12-loop';
    const outId = await addOut(TID, {
      at: 1791343361, mailbox: 'dana@example.com',
      to: ['frank@example.net'], cc: ['erin@example.com'],
    });
    const inId = await addIn(TID, {
      at: 1791343363, mailbox: 'erin@example.com',
      to: ['frank@example.net'], cc: ['erin@example.com'],
      deliveredTo: ['erin@example.com'],
    });

    // negative control: the DB really has two rows -- collapse happens on the read side, not by losing one at insert time
    const n = db.queryOne('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', TID);
    ok(Number(n.n) === 2, '负控制：库里确实有 2 条记录（不是入库时就少了一条）', n.n);

    const th = await repo.listThread(inboundEnv, TID);
    ok(th.length === 1, '⭐ 回环副本被折叠：会话里只剩 1 条（用户看到「同一封信两次」的直接原因）', th.length);
    ok(th.length === 1 && th[0].direction === 'outbound', '留存的是**出站**副本（我发出的那封）',
      th.length ? th[0].direction : 'n/a');
    ok(th.length === 1 && Array.isArray(th[0].copy_ids) && th[0].copy_ids.length === 1,
      '被折叠副本的 id 挂在留存行的 copy_ids 上（前端据此把「打开的是副本」也认作当前行）',
      th.length ? JSON.stringify(th[0].copy_ids) : 'n/a');
    ok(th.length === 1 && Number(th[0].read) === 0,
      '⭐ 副本未读 → 留存行也标为未读（折叠不得静默吞掉未读信号）',
      th.length ? th[0].read : 'n/a');
    // the outbound row itself is still there (not deleted along with it)
    ok(db.queryOne('SELECT id FROM messages WHERE resend_id = ?', `re-${outId}`) !== null,
      '出站记录本身仍在库里（折叠只影响读取结果）');
    ok(db.queryOne('SELECT id FROM messages WHERE resend_id = ?', `re-${inId}`) !== null,
      '入站副本本身仍在库里（在 erin@ 自己的收件箱里照常显示）');
  }

  /* ---- T12c collapse negative control: the following shapes **must be kept**, none may be swallowed ---- */
  {
    // ① a message from the other party delivered to two mailboxes on this account -> both are real incoming mail, not loopback
    //    (deliberately give the thread **also** one of my outbound rows, otherwise it would hit the "no outbound -> early return" branch and the decision logic would not be exercised)
    const TID1 = 't12-neg-multi-in';
    await addOut(TID1, { at: 5002, to: ['frank@example.net'], cc: ['erin@example.com'] });
    await addIn(TID1, { at: 5000, mailbox: 'dana@example.com', from: 'frank@example.net', to: ['dana@example.com'] });
    await addIn(TID1, { at: 5001, mailbox: 'erin@example.com', from: 'frank@example.net', to: ['erin@example.com'] });
    const th1 = await repo.listThread(inboundEnv, TID1);
    ok(th1.length === 3,
      '① 对方来信投递到两个本账号信箱 + 我的一封回信 → 3 条全保留（发件人是对方，不是回环）', th1.length);

    // ② sender is the other party (even if the time and delivery mailbox match) -> keep
    const TID2 = 't12-neg-from';
    await addOut(TID2, { at: 6000, to: ['frank@example.net'], cc: ['erin@example.com'] });
    await addIn(TID2, { at: 6001, mailbox: 'erin@example.com', from: 'frank@example.net', to: ['frank@example.net'], cc: ['erin@example.com'] });
    const th2 = await repo.listThread(inboundEnv, TID2);
    ok(th2.length === 2, '② 发件人不是我 → 保留（对方来信不得被当成回环吞掉）', th2.length);

    // ③ time difference exceeds the window -> keep
    const TID3 = 't12-neg-time';
    await addOut(TID3, { at: 7000, to: ['frank@example.net'], cc: ['erin@example.com'] });
    await addIn(TID3, { at: 7000 + 3600, mailbox: 'erin@example.com', to: ['frank@example.net'], cc: ['erin@example.com'] });
    const th3 = await repo.listThread(inboundEnv, TID3);
    ok(th3.length === 2, '③ 入库时间差 1 小时 → 保留（不是同一封）', th3.length);

    // ④ delivery mailbox not among the outbound recipients -> keep (I sent to frank, should not swallow the mail "delivered to support@")
    const TID4 = 't12-neg-box';
    await addOut(TID4, { at: 8000, to: ['frank@example.net'], cc: [] });
    await addIn(TID4, { at: 8001, mailbox: 'support@example.com', to: ['frank@example.net'], cc: [] });
    const th4 = await repo.listThread(inboundEnv, TID4);
    ok(th4.length === 2, '④ 投递信箱不在出站收件人里 → 保留', th4.length);

    // ⑤ no outbound row in the thread -> no collapsing at all (early-return branch)
    const TID5 = 't12-neg-noout';
    await addIn(TID5, { at: 9000 });
    await addIn(TID5, { at: 9001 });
    const th5 = await repo.listThread(inboundEnv, TID5);
    ok(th5.length === 2, '⑤ 无出站行的会话不做任何折叠', th5.length);
  }

  /* ---- T12d positive-control supplement: a bcc loopback must also collapse; when the copy is read, the kept row must not be pulled to unread ---- */
  {
    const TID1 = 't12-bcc-loop';
    await addOut(TID1, { at: 11000, to: ['frank@example.net'], cc: [], bcc: ['erin@example.com'] });
    await addIn(TID1, { at: 11002, mailbox: 'erin@example.com', to: ['frank@example.net'], cc: [] });
    const th1 = await repo.listThread(inboundEnv, TID1);
    ok(th1.length === 1, '⑥ 密送回环同样折叠（收件人集合含 bcc）', th1.length);

    const TID2 = 't12-read-merge';
    const outId2 = await addOut(TID2, { at: 12000, to: ['frank@example.net'], cc: ['erin@example.com'] });
    const inId2 = await addIn(TID2, { at: 12002, mailbox: 'erin@example.com', to: ['frank@example.net'], cc: ['erin@example.com'] });
    // mark the copy as read -> the kept row must still be read (negative control: cannot unconditionally set to 0)
    await repo.patchMessage(inboundEnv, inId2, { read: true });
    const th2 = await repo.listThread(inboundEnv, TID2);
    ok(th2.length === 1, '前置：仍被折叠', th2.length);
    ok(th2.length === 1 && Number(th2[0].read) === 1,
      '⭐ 副本已读 → 留存行保持已读（「无条件置 0」会被这条抓住）',
      th2.length ? th2[0].read : 'n/a');
    // precondition self-check: the outbound row itself is already read in the DB (otherwise "kept row is read" might come from another cause)
    const outRow2 = db.queryOne('SELECT read FROM messages WHERE resend_id = ?', `re-${outId2}`);
    ok(outRow2 && Number(outRow2.read) === 1, '前置：出站行入库时即 read=1（出站默认已读）',
      outRow2 && outRow2.read);
  }

  /* ---- summary ---- */
  globalThis.fetch = realFetch;
  cleanup();
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);

  console.log(`\n===== 结果: ${pass} passed, ${failed.length} failed =====`);
  const exitCode = failed.length ? 1 : 0;
  const exitFile = path.join(os.tmpdir(), 'qa-inbound-ingest.exit');
  try { fs.writeFileSync(exitFile, String(exitCode), 'utf8'); console.log(`退出码已写入: ${exitFile} = ${exitCode}`); } catch { /* ignore */ }
  process.exit(exitCode);
})().catch((e) => {
  console.error('\n未捕获异常：', e);
  cleanup();
  process.exit(1);
});
