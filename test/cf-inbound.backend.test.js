'use strict';

/* =============================================================================
 * CF inbound migration (Resend -> Cloudflare Email Routing) backend semantics regression
 *
 * Run (this sandbox needs the tsc shim, see the notes at the end of inbound-ingest.backend.test.js):
 *   NODE_OPTIONS="--require <temp dir>/mm-tsc-shim.js" node test/cf-inbound.backend.test.js
 * Normal environment:
 *   node test/cf-inbound.backend.test.js
 *
 * Exit codes: 0 = all pass; 1 = failures; 2 = missing environment (node:sqlite / tsc unavailable).
 *
 * Invariants being watched:
 *   ⭐ Data compatibility: the CF inbound parse result -> the **same** messages/attachments tables (columns byte-for-byte identical to Resend inbound).
 *   ⭐ Never lose: [email()] first puts raw into R2 + registers inbound_raw, then enqueues; queue parses and stores in two stages.
 *   ⭐ Idempotency: Queue at-least-once delivery -> the same message consumed twice must not be stored twice.
 *   ⭐ Envelope delivery address (mailbox/delivered_to) vs the real To: header -- same convention as the Resend path.
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
const WORK_DIR = path.join(os.tmpdir(), `cf-inbound-qa-build-${process.pid}`);
const SRC_COPY = path.join(WORK_DIR, 'src');
const BUILD_DIR = path.join(WORK_DIR, 'out');

/** Same as inbound-ingest: copy the whole src/ outside the repo to compile (the temp dir must link node_modules first to resolve bare modules). */
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
  if (!fs.existsSync(path.join(BUILD_DIR, 'inbound-email.js'))) {
    throw new Error(`编译产物缺失: ${path.join(BUILD_DIR, 'inbound-email.js')}`);
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

/* ---- real SQLite masquerading as D1 (schema.sql's real DDL) ---- */
function makeD1() {
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const prepare = (sql) => {
    const st = {
      sql, args: [],
      bind(...a) { st.args = a; return st; },
      async run() {
        const r = db.prepare(sql).run(...norm(st.args));
        return { success: true, results: [], meta: { changes: Number(r.changes) } };
      },
      async first() {
        const row = db.prepare(sql).get(...norm(st.args));
        return row === undefined ? null : row;
      },
      async all() { return { results: db.prepare(sql).all(...norm(st.args)), success: true, meta: {} }; },
    };
    return st;
  };
  return {
    prepare,
    batch: async (arr) => { for (const s of arr) await s.run(); return []; },
    exec: async () => ({ count: 0, duration: 0 }),
    query: (sql, ...a) => db.prepare(sql).all(...norm(a)),
    queryOne: (sql, ...a) => { const r = db.prepare(sql).get(...norm(a)); return r === undefined ? null : r; },
  };
}

/* ---- R2 stub: in-memory Map, supports ReadableStream / Uint8Array writes, get().arrayBuffer() ---- */
async function streamToBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  // Web ReadableStream (message.raw)
  const reader = value.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value: v } = await reader.read();
    if (done) break;
    const u = v instanceof Uint8Array ? v : new Uint8Array(v);
    chunks.push(u);
    total += u.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function makeR2() {
  const store = new Map();
  return {
    store,
    async put(key, value, opts) {
      const bytes = await streamToBytes(value);
      store.set(key, { bytes, httpMetadata: (opts && opts.httpMetadata) || null });
      return { key };
    },
    async get(key) {
      const obj = store.get(key);
      if (!obj) return null;
      return {
        key,
        size: obj.bytes.length,
        httpMetadata: obj.httpMetadata,
        async arrayBuffer() { return obj.bytes.buffer.slice(obj.bytes.byteOffset, obj.bytes.byteOffset + obj.bytes.byteLength); },
        body: obj.bytes,
      };
    },
    async delete(key) { store.delete(key); },
    async list(opts = {}) {
      const limit = opts.limit || 1000;
      const keys = [...store.keys()].sort();
      const start = opts.cursor ? keys.indexOf(opts.cursor) + 1 : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + page.length < keys.length;
      return {
        objects: page.map((k) => ({ key: k, size: store.get(k).bytes.length })),
        truncated,
        cursor: truncated ? page[page.length - 1] : undefined,
      };
    },
  };
}

function makeQueue() {
  const sent = [];
  return { sent, async send(body) { sent.push(body); return { id: `q-${sent.length}` }; } };
}

function streamOf(bytes) {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

/** Forge a CF `ForwardableEmailMessage`. raw is a one-shot stream; setReject records for assertions. */
function fakeMessage({ from, to, headers, rawBytes }) {
  const rejects = [];
  return {
    rejects,
    msg: {
      from, to,
      headers: new Headers(headers || {}),
      rawSize: rawBytes.length,
      raw: streamOf(rawBytes),
      setReject(reason) { rejects.push(reason); },
      async forward() { return { forwarded: true }; },
      async reply() { return { sent: true }; },
    },
  };
}

/** Forge a Queue batch: per-message ack/retry is assertable. */
function makeBatch(ids) {
  const acks = [];
  const retries = [];
  const messages = ids.map((id, i) => ({
    id: `qm-${i}`,
    body: { rawId: id },
    attempts: 1,
    ack() { acks.push(this.id); },
    retry() { retries.push(this.id); },
  }));
  return { batch: { queue: 'resend-mail-inbound', messages }, acks, retries };
}

/* ---- mini asserter ---- */
let pass = 0;
const results = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; results.push({ ok: true, msg }); console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { results.push({ ok: false, msg, detail }); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const ENVELOPE = { from: 'alice@ext.example', to: 'dana@example.com' };

/** The raw MIME of one multipart/mixed (alternative body + inline cid image + regular attachment). */
function rawMime() {
  return [
    'From: Alice Sender <alice@ext.example>',
    'To: Frank <frank@example.net>',
    'Cc: dana@example.com',
    'Subject: Hello 测试',
    'Message-ID: <abc123@ext.example>',
    'In-Reply-To: <root001@ext.example>',
    'References: <root001@ext.example>',
    'Date: Mon, 13 Oct 2025 10:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIX"',
    '',
    '--MIX',
    'Content-Type: multipart/alternative; boundary="ALT"',
    '',
    '--ALT',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'plain body line',
    '--ALT',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>html body <img src="cid:logo123"></p>',
    '--ALT--',
    '',
    '--MIX',
    'Content-Type: image/png; name="logo.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <logo123>',
    'Content-Disposition: inline; filename="logo.png"',
    '',
    'iVBORw0KGgo=',
    '--MIX',
    'Content-Type: application/pdf; name="doc.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="doc.pdf"',
    '',
    'JVBERi0=',
    '--MIX--',
    '',
  ].join('\r\n');
}

(async function main() {
  console.log('CF 入向迁移 —— 真实 SQLite + 真实编译产物验证');
  let entry;
  try {
    entry = build();
  } catch (e) {
    console.error(`\n编译失败，无法继续：${e.message}`);
    console.error('（受限沙箱下请加 tsc 垫片：NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js"）');
    process.exit(2);
  }

  const inbound = require(path.join(entry, 'inbound-email.js'));
  const db = makeD1();
  const bucket = makeR2();
  const queue = makeQueue();
  const env = { DB: db, BUCKET: bucket, INBOUND_QUEUE: queue };

  const FP = crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, 'src', 'inbound-email.ts'))).digest('hex');
  console.log(`被测版本: src/inbound-email.ts md5=${FP}`);

  section('T0 环境自检');
  await db.prepare('INSERT INTO messages (id, direction, to_emails, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .bind('self', 'inbound', '[]', 1, 1, 1).run();
  ok(Number(db.queryOne('SELECT COUNT(*) AS n FROM messages').n) === 1, 'D1 桩真的写进了 SQLite（否则后面空转）');
  await db.prepare('DELETE FROM messages WHERE id=?').bind('self').run();

  /* ---- T1 email() only does "preserve this message": raw to R2 + register + enqueue ---- */
  section('T1 ⭐ email() 落 R2 + 登记 inbound_raw + 入队（不解析）');
  const raw1 = new TextEncoder().encode(rawMime());
  const m1 = fakeMessage({ from: ENVELOPE.from, to: ENVELOPE.to, headers: { 'Message-ID': '<abc123@ext.example>' }, rawBytes: raw1 });
  await inbound.handleInboundEmail(env, m1.msg);
  ok(m1.rejects.length === 0, '未拒收（存储成功时不该 setReject）', m1.rejects.join(','));
  ok(bucket.store.size === 1, '原始件已落 R2（1 个对象）', bucket.store.size);
  const rawRow = db.queryOne('SELECT * FROM inbound_raw');
  ok(!!rawRow, 'inbound_raw 登记了一行', rawRow && rawRow.id);
  ok(rawRow && rawRow.parsed_at === null, '解析尚未完成（parsed_at 为 NULL）', rawRow && rawRow.parsed_at);
  ok(rawRow && rawRow.to_email === ENVELOPE.to, '记录信封收件人（投递地址）', rawRow && rawRow.to_email);
  ok(rawRow && rawRow.message_id === 'abc123@ext.example', '记录 Message-ID（去尖括号）', rawRow && rawRow.message_id);
  ok(queue.sent.length === 1, '入队 1 条指针消息', queue.sent.length);
  ok(queue.sent[0] && queue.sent[0].rawId === rawRow.id, '队列消息只带 rawId 指针', queue.sent[0] && queue.sent[0].rawId);

  /* ---- T2 queue() parses and stores: data shape byte-for-byte identical to Resend inbound ---- */
  section('T2 ⭐ queue() 解析 → 同一套 messages/attachments 表');
  const b1 = makeBatch([queue.sent[0].rawId]);
  await inbound.handleInboundQueue(b1.batch, env);
  ok(b1.acks.length === 1 && b1.retries.length === 0, '成功解析 → ack（且不 retry）', `${b1.acks.length}/${b1.retries.length}`);

  const row = db.queryOne("SELECT * FROM messages WHERE direction='inbound'");
  ok(!!row, '邮件已写入 messages', row && row.id);
  ok(row && row.mailbox === ENVELOPE.to, '⭐ mailbox = 投递地址', row && row.mailbox);
  ok(row && row.mailbox_domain === ENVELOPE.to.split('@')[1], '⭐ mailbox_domain 派生 = mailbox 的域（多域名过滤用）', row && row.mailbox_domain);
  ok(row && JSON.stringify(JSON.parse(row.to_emails)) === JSON.stringify(['frank@example.net']),
    '⭐ to_emails = 真实 To: 头（不是投递地址）', row && row.to_emails);
  ok(row && row.to_emails !== JSON.stringify([ENVELOPE.to]),
    '负控制：to_emails 确实不是信封投递地址（区分度成立）', row && row.to_emails);
  ok(row && JSON.stringify(JSON.parse(row.delivered_to)) === JSON.stringify([ENVELOPE.to]),
    'delivered_to = 信封投递地址', row && row.delivered_to);
  ok(row && JSON.stringify(JSON.parse(row.cc)) === JSON.stringify(['dana@example.com']),
    'cc = 真实 Cc 头', row && row.cc);
  ok(row && row.subject === 'Hello 测试', 'subject 正确（RFC2047/UTF-8 头）', row && row.subject);
  ok(row && row.message_id === 'abc123@ext.example', 'message_id 去尖括号', row && row.message_id);
  ok(row && row.in_reply_to === 'root001@ext.example', 'in_reply_to 正确', row && row.in_reply_to);
  ok(row && row.thread_id === 'root001@ext.example', '⭐ thread_id = References 根（会话归组）', row && row.thread_id);
  ok(row && row.from_email === 'alice@ext.example', 'from_email = 发件人', row && row.from_email);
  ok(row && row.from_name === 'Alice Sender', 'from_name = 显示名', row && row.from_name);
  ok(row && row.direction === 'inbound' && Number(row.read) === 0, '入站默认未读', row && `${row.direction}/${row.read}`);
  ok(row && /cid:logo123/.test(row.body_html || ''), 'body_html 保留 cid: 内联引用（供前端替换）', row && row.body_html);
  ok(row && (row.body_text || '').includes('plain body line'), 'body_text 来自 text/plain 部分', row && JSON.stringify(row.body_text));

  /* ---- T3 attachments: inline cid image vs regular attachment ---- */
  section('T3 ⭐ 附件落 R2 + attachments 行（inline/普通区分）');
  const atts = db.query("SELECT * FROM attachments WHERE message_id = ?", row.id);
  ok(atts.length === 2, '2 个附件都已入库', atts.length);
  const png = atts.find((a) => a.filename === 'logo.png');
  const pdf = atts.find((a) => a.filename === 'doc.pdf');
  ok(!!png && Number(png.inline) === 1, '⭐ 带 Content-ID 的内联图 inline=1', png && png.inline);
  ok(!!png && png.content_id === 'logo123', 'content_id 去尖括号', png && png.content_id);
  ok(!!pdf && Number(pdf.inline) === 0, '⭐ 普通附件 inline=0', pdf && pdf.inline);
  ok(atts.every((a) => bucket.store.has(a.r2_key)), '每个附件的 R2 对象都存在', atts.length);

  const rawAfter = db.queryOne('SELECT * FROM inbound_raw WHERE id = ?', queue.sent[0].rawId);
  ok(rawAfter && rawAfter.parsed_at !== null && rawAfter.message_row === row.id,
    '⭐ 解析后回填 parsed_at + message_row', rawAfter && `${rawAfter.parsed_at}/${rawAfter.message_row}`);

  /* ---- T4 idempotency: Queue at-least-once duplicate consumption must not store twice ---- */
  section('T4 ⭐ 幂等：重复消费同一指针 → 不新增行');
  const before = Number(db.queryOne("SELECT COUNT(*) AS n FROM messages WHERE direction='inbound'").n);
  const b2 = makeBatch([queue.sent[0].rawId]);
  await inbound.handleInboundQueue(b2.batch, env);
  const after = Number(db.queryOne("SELECT COUNT(*) AS n FROM messages WHERE direction='inbound'").n);
  ok(b2.acks.length === 1, '重复指针仍被 ack（已入库 → 跳过）', b2.acks.length);
  ok(after === before, '⭐ messages 行数不变（幂等）', `${before} → ${after}`);

  /* ---- T5 no queue binding: raw is preserved **and** parsed inline (the one-click deploy template has no queue) ---- */
  section('T5 ⭐ 未配队列时 email() 落 R2 + 登记 + 内联解析入库');
  const envNoQ = { DB: db, BUCKET: bucket, INBOUND_QUEUE: undefined };
  const m2 = fakeMessage({ from: 'bob@ext.example', to: 'support@example.com', headers: { 'Message-ID': '<noq@ext.example>' }, rawBytes: new TextEncoder().encode('From: bob@ext.example\r\n\r\nhi') });
  await inbound.handleInboundEmail(envNoQ, m2.msg);
  const noq = db.queryOne('SELECT * FROM inbound_raw WHERE message_id = ?', 'noq@ext.example');
  ok(!!noq, '登记成功', noq && noq.id);
  ok(bucket.store.has(noq.r2_key), '原始件确实在 R2', noq && noq.r2_key);
  ok(noq.parsed_at !== null && !!noq.message_row,
    '⭐ 没有队列时直接内联解析入库（parsed_at + message_row 都有）', noq && `${noq.parsed_at}/${noq.message_row}`);
  const inlineRow = noq.message_row ? db.queryOne('SELECT * FROM messages WHERE id = ?', noq.message_row) : null;
  ok(!!inlineRow && inlineRow.direction === 'inbound', '⭐ 收件箱里确实有这封信', inlineRow && inlineRow.id);

  /* ---- T6 negative control: R2 raw object missing -> record error and ack (do not poison the queue) ---- */
  section('T6 负控制：R2 原始件丢失 → error + ack');
  // 单独造一条「已登记、原始件却不在 R2」的待办行（T5 那行现在会被内联解析，不能再用）
  const id6 = 'raw-missing-object';
  db.prepare('INSERT INTO inbound_raw (id, r2_key, from_email, to_email, size, message_id, received_at, parsed_at, message_row, error, attempts) VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,0)')
    .bind(id6, 'inbound-raw/does-not-exist.eml', 'gone@ext.example', 'inbox@example.com', 3, 'gone@ext.example', 1700000002)
    .run();
  const b3 = makeBatch([id6]);
  await bucket.delete(noq.r2_key);
  await inbound.handleInboundQueue(b3.batch, env);
  const noqAfter = db.queryOne('SELECT * FROM inbound_raw WHERE id = ?', id6);
  ok(b3.acks.length === 1 && b3.retries.length === 0, '缺原始件 → ack（不无限重试）', `${b3.acks.length}/${b3.retries.length}`);
  ok(noqAfter && /missing/.test(noqAfter.error || ''), 'error 记录原因', noqAfter && noqAfter.error);

  /* ---- T7 negative control: bad/missing rawId must not crash, just ack ---- */
  section('T7 负控制：空/未知指针');
  const b4 = makeBatch([undefined, 'no-such-id']);
  b4.batch.messages[0].body = {};
  await inbound.handleInboundQueue(b4.batch, env);
  ok(b4.acks.length === 2 && b4.retries.length === 0, '空指针 / 未知 id 均安全 ack', `${b4.acks.length}/${b4.retries.length}`);

  /* ---- T8 ⭐ R2 write fails: the intent was registered first -> the DB holds the original error text (the key to troubleshooting "delivery failed but DB is empty" in production) ---- */
  section('T8 ⭐ R2 put 失败 → 保留登记行 + error 原文 + 拒收');
  const failBucket = {
    async put() { throw new Error('boom-r2'); },
    async get() { return null; },
    async delete() {},
  };
  const q8 = makeQueue();
  const envFailR2 = { DB: db, BUCKET: failBucket, INBOUND_QUEUE: q8 };
  const m8 = fakeMessage({ from: 'x@ext.example', to: 'y@example.com', headers: { 'Message-ID': '<r2fail@ext.example>' }, rawBytes: new TextEncoder().encode('From: x@ext.example\r\n\r\nhi') });
  await inbound.handleInboundEmail(envFailR2, m8.msg);
  const row8 = db.queryOne('SELECT * FROM inbound_raw WHERE message_id = ?', 'r2fail@ext.example');
  ok(m8.rejects.length === 1, '⭐ R2 失败 → 明确拒收（不假装成功）', m8.rejects.join(','));
  ok(!!row8, '⭐ 仍留下登记行（r2_key 是计划中的 key）', row8 && row8.id);
  ok(row8 && /r2 put failed/.test(row8.error || '') && /boom-r2/.test(row8.error || ''), '⭐ error 记录了真实原因（不再是空白）', row8 && row8.error);
  ok(q8.sent.length === 0, 'R2 失败 → 不入队（避免消费者拿到不存在的原件）', q8.sent.length);

  /* ---- T9 ⭐ D1 registration fails: must not pretend success (an empty DB here is the "correct signal", not a silent loss) ---- */
  section('T9 ⭐ D1 登记失败 → 拒收且不产生幻影成功');
  const failInsertDb = {
    prepare(sql) {
      if (/INSERT INTO inbound_raw/i.test(sql)) {
        return { bind() { return { async run() { throw new Error('boom-db'); } }; } };
      }
      return db.prepare(sql);
    },
    queryOne: (...a) => db.queryOne(...a),
    query: (...a) => db.query(...a),
  };
  const q9 = makeQueue();
  const envFailDb = { DB: failInsertDb, BUCKET: bucket, INBOUND_QUEUE: q9 };
  const before9 = Number(db.queryOne('SELECT COUNT(*) AS n FROM inbound_raw').n);
  const m9 = fakeMessage({ from: 'x@ext.example', to: 'y@example.com', headers: { 'Message-ID': '<dbfail@ext.example>' }, rawBytes: new TextEncoder().encode('From: x@ext.example\r\n\r\nhi') });
  await inbound.handleInboundEmail(envFailDb, m9.msg);
  const after9 = Number(db.queryOne('SELECT COUNT(*) AS n FROM inbound_raw').n);
  ok(m9.rejects.length === 1, 'D1 登记失败 → 拒收', m9.rejects.join(','));
  ok(after9 === before9, '无幻影登记行（inbound_raw 未增加）', `${before9} → ${after9}`);
  ok(q9.sent.length === 0, '登记未成功 → 不入队', q9.sent.length);

  /* ---- T10 ⭐ recovery cron: re-enqueue emails "already in R2 but not fully parsed" (never-lose self-healing loop) ---- */
  section('T10 ⭐ replayPendingInbound 重放待办');
  const q10 = makeQueue();
  // 造一条「原始件在 R2、但还没解析」的待办行（没有队列时 email() 会内联解析，所以这里直接落库模拟遗留待办）
  const id10 = 'raw-replay-pending';
  const pendingKey = `inbound-raw/${id10}.eml`;
  await bucket.put(pendingKey, new TextEncoder().encode('From: r@ext.example\r\nMessage-ID: <replay@ext.example>\r\n\r\nhi'));
  db.prepare('INSERT INTO inbound_raw (id, r2_key, from_email, to_email, size, message_id, received_at, parsed_at, message_row, error, attempts) VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,0)')
    .bind(id10, pendingKey, 'r@ext.example', 's@example.com', 3, 'replay@ext.example', 1700000000)
    .run();
  const pending = db.queryOne('SELECT * FROM inbound_raw WHERE id = ?', id10);
  ok(pending && pending.parsed_at === null, '前置：入队缺失时该行处于待办（parsed_at NULL）', pending && pending.id);
  const n10 = await inbound.replayPendingInbound({ DB: db, BUCKET: bucket, INBOUND_QUEUE: q10 });
  ok(n10 >= 1 && q10.sent.some((m) => m.rawId === pending.id), '⭐ cron 重新入队了待办行', `${n10}/${q10.sent.map((m) => m.rawId).join(',')}`);

  /* no queue: the cron parses the pending row itself instead of enqueuing (returns the number stored) */
  const id10b = 'raw-inline-replay';
  const key10b = `inbound-raw/${id10b}.eml`;
  await bucket.put(key10b, new TextEncoder().encode('From: inline@ext.example\r\nMessage-ID: <inline-replay@ext.example>\r\n\r\ninline body'));
  db.prepare('INSERT INTO inbound_raw (id, r2_key, from_email, to_email, size, message_id, received_at, parsed_at, message_row, error, attempts) VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,0)')
    .bind(id10b, key10b, 'inline@ext.example', 'inbox@example.com', 5, 'inline-replay@ext.example', 1700000001)
    .run();
  const n10b = await inbound.replayPendingInbound({ DB: db, BUCKET: bucket, INBOUND_QUEUE: undefined });
  const row10b = db.queryOne('SELECT * FROM inbound_raw WHERE id = ?', id10b);
  ok(n10b >= 1, '⭐ 未配队列时 replay 自己解析（返回入库条数）', n10b);
  ok(row10b && row10b.parsed_at !== null && !!row10b.message_row, '⭐ 该行被内联解析入库，不再滞留待办',
    row10b && `${row10b.parsed_at}/${row10b.message_row}`);

  /* ---- T11 ⭐ store transient failure exceeds threshold -> still kept as pending, awaiting cron replay (no permanent deadlock) ---- */
  section('T11 ⭐ save 瞬时失败超阈值仍保留待办');
  const id11 = 'raw-save-exhaust';
  db.prepare('INSERT INTO inbound_raw (id, r2_key, from_email, to_email, size, message_id, received_at, parsed_at, message_row, error, attempts) VALUES (?,?,?,?,?,?,?,NULL,NULL,?,0)')
    .bind(id11, `inbound-raw/${id11}.eml`, 'a@ext.example', 'b@example.com', 3, 'exh@ext.example', 1, 'save kept failing (×5): boom')
    .run();
  const q11 = makeQueue();
  const n11 = await inbound.replayPendingInbound({ DB: db, BUCKET: bucket, INBOUND_QUEUE: q11 });
  ok(q11.sent.some((m) => m.rawId === id11), '⭐ 瞬时失败行仍被 cron 重放（不会永久卡死）', n11);

  /* ---- T12 ⭐ inbound anomaly dashboard: only "not in the inbox" ones appear, in-progress ones within 10 minutes are not disturbed ---- */
  section('T12 ⭐ listInboundAlerts 暴露「收了但没进收件箱」的邮件');
  const repo = require(path.join(entry, 'repo.js'));
  const now = Math.floor(Date.now() / 1000);
  const insRaw = (id, { recv, parsed, msgRow, error }) =>
    db.prepare('INSERT INTO inbound_raw (id, r2_key, from_email, to_email, size, message_id, subject, received_at, parsed_at, message_row, error, attempts) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)')
      .bind(id, `inbound-raw/${id}.eml`, 'x@ext.example', 'y@example.com', 100, `${id}@ext`, '主题'+id, recv, parsed, msgRow, error)
      .run();
  insRaw('al-old-pending', { recv: now - 3600, parsed: null, msgRow: null, error: null });      // old pending -> appears
  insRaw('al-fresh-pending', { recv: now, parsed: null, msgRow: null, error: null });            // just received -> does not appear
  insRaw('al-failed', { recv: now - 60, parsed: null, msgRow: null, error: 'parse failed: boom' }); // already failed -> appears
  insRaw('al-resolved', { recv: now - 3600, parsed: now - 3500, msgRow: 'msg-1', error: 'x' });  // already stored -> does not appear
  const alerts = await repo.listInboundAlerts({ DB: db, BUCKET: bucket });
  const ids = alerts.map((a) => a.id);
  ok(ids.includes('al-old-pending'), '⭐ 老待办（>10min 未解析）出现在异常列表', ids.join(','));
  ok(ids.includes('al-failed'), '⭐ 已失败（有 error）出现在异常列表', ids.join(','));
  ok(!ids.includes('al-fresh-pending'), '刚收到、仍在处理的不打扰', ids.join(','));
  ok(!ids.includes('al-resolved'), '已入库的不算异常', ids.join(','));
  const failedAlert = alerts.find((a) => a.id === 'al-failed');
  ok(failedAlert && failedAlert.pending === false && failedAlert.error === 'parse failed: boom', 'error 行标记 pending=false 且带原因', failedAlert && failedAlert.error);
  ok(failedAlert && failedAlert.subject === '主题al-failed', 'subject 一并返回（界面可辨认）', failedAlert && failedAlert.subject);

  /* ---- T13 ⭐ manual retry + download raw object ---- */
  section('T13 ⭐ retryInbound 重新入队 / proxyInboundRaw 取回原始件');
  const q13 = makeQueue();
  const ok13 = await repo.retryInbound({ DB: db, BUCKET: bucket, INBOUND_QUEUE: q13 }, 'al-failed');
  const retried = db.queryOne('SELECT * FROM inbound_raw WHERE id = ?', 'al-failed');
  ok(ok13 === true && q13.sent.some((m) => m.rawId === 'al-failed'), '⭐ 重试把该行重新入队', JSON.stringify(q13.sent));
  ok(retried && retried.error === null && retried.parsed_at === null && retried.attempts === 0, '重试清空 error/attempts，回到待解析', retried && `${retried.error}/${retried.parsed_at}/${retried.attempts}`);
  ok((await repo.retryInbound({ DB: db, BUCKET: bucket, INBOUND_QUEUE: q13 }, 'no-such-id')) === false, '未知 id 返回 false（不崩）');

  bucket.store.set('inbound-raw/al-failed.eml', { bytes: new TextEncoder().encode('From: x@ext.example\r\n\r\nhi'), httpMetadata: null });
  const rawResp = await repo.proxyInboundRaw({ DB: db, BUCKET: bucket }, 'al-failed');
  ok(rawResp && rawResp.status === 200, '⭐ 能取回原始 .eml（收件箱没有时的兜底）', rawResp && rawResp.status);
  ok(rawResp && (rawResp.headers.get('content-disposition') || '').includes('attachment'), '原始件按附件下载（不内联）', rawResp && rawResp.headers.get('content-disposition'));
  ok((await repo.proxyInboundRaw({ DB: db, BUCKET: bucket }, 'no-such-id')) === null, '未知 id 的原始件返回 null');

  /* ---- T14 ⭐ body exceeds D1 single-row limit -> mark terminal, remove from queue, stop replaying (no pointless churn) ---- */
  section('T14 ⭐ 超 D1 行上限的邮件：标记 + 移出队列 + 停止重试');
  const bigHtml = 'a'.repeat(2 * 1024 * 1024); // 2 MB body, exceeds the 1.9MB budget
  const bigRaw = [
    'From: big@ext.example',
    'To: dana@example.com',
    'Subject: 超大正文',
    'Message-ID: <big@ext.example>',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<p>${bigHtml}</p>`,
  ].join('\r\n');
  const m14 = fakeMessage({ from: 'big@ext.example', to: 'dana@example.com', headers: { 'Message-ID': '<big@ext.example>' }, rawBytes: new TextEncoder().encode(bigRaw) });
  await inbound.handleInboundEmail(env, m14.msg);
  const row14 = db.queryOne('SELECT * FROM inbound_raw WHERE message_id = ?', 'big@ext.example');
  const b14 = makeBatch([row14.id]);
  await inbound.handleInboundQueue(b14.batch, env);
  const after14 = db.queryOne('SELECT * FROM inbound_raw WHERE id = ?', row14.id);
  ok(b14.acks.length === 1 && b14.retries.length === 0, '⭐ 超限 → ack（移出队列，不 retry）', `${b14.acks.length}/${b14.retries.length}`);
  ok(after14 && /too large/i.test(after14.error || ''), '⭐ 标了明确原因（too large）', after14 && after14.error);
  ok(after14 && after14.parsed_at !== null && after14.message_row === null, '标为终态（parsed_at 非空、未入库）', after14 && `${after14.parsed_at}/${after14.message_row}`);
  ok(Number(db.queryOne("SELECT COUNT(*) AS n FROM messages WHERE message_id = 'big@ext.example'").n) === 0, '未写入 messages（行太大）', '0');
  const q14 = makeQueue();
  await inbound.replayPendingInbound({ DB: db, BUCKET: bucket, INBOUND_QUEUE: q14 });
  ok(!q14.sent.some((m) => m.rawId === row14.id), '⭐ 终态后 cron 不再重放（停止重复尝试）', q14.sent.map((m) => m.rawId).join(','));
  const alerts14 = await repo.listInboundAlerts({ DB: db, BUCKET: bucket });
  ok(alerts14.some((a) => a.id === row14.id), '该邮件出现在「入站异常」提示条（可下载原件）', '');

  /* ---- T15 backend status API (CF storage/inbound + Resend quota, so the frontend sees it all on one screen) ---- */
  section('T15 后端状态 API（CF 存储/入站 + Resend 额度，估算）');
  const usage1 = await repo.getBackendStatus(env);
  ok(usage1.d1.usedBytes > 0, 'D1 估算到正字节数（各表文本列求和）', usage1.d1.usedBytes);
  ok(usage1.d1.limitBytes === 500 * 1024 * 1024, 'D1 限额默认 500MB', usage1.d1.limitBytes);
  ok(usage1.d1.percent >= 0 && usage1.d1.percent < 100, 'D1 百分比在合理区间', usage1.d1.percent);
  ok(usage1.r2.objects > 0 && usage1.r2.usedBytes > 0, 'R2 统计到对象数与字节（列举求和）', `${usage1.r2.objects} 个 / ${usage1.r2.usedBytes} B`);
  ok(usage1.r2.limitBytes === 10 * 1024 * 1024 * 1024, 'R2 限额默认 10GB', usage1.r2.limitBytes);
  ok(usage1.approximate === true, '标注为估算值', usage1.approximate);
  // CF inbound pipeline status
  ok(usage1.inbound && usage1.inbound.total > 0, '⚙ CF 入站：累计收信计数 > 0', JSON.stringify(usage1.inbound));
  ok(typeof usage1.inbound.pending === 'number' && typeof usage1.inbound.alerts === 'number',
    '⚙ CF 入站：待处理 / 异常 计数齐全', `pending=${usage1.inbound.pending} alerts=${usage1.inbound.alerts}`);
  // Resend quota (no key configured)
  ok(usage1.resend && usage1.resend.configured === false, '未配 RESEND_API_KEY → configured=false', usage1.resend && usage1.resend.configured);
  ok(usage1.resend.day.limit === 100 && usage1.resend.month.limit === 3000,
    'Resend 额度默认 100/天 · 3000/月（免费档）', `${usage1.resend.day.limit}/${usage1.resend.month.limit}`);
  // cache: a second call within a short time should not recompute (updatedAt unchanged)
  const usage2 = await repo.getBackendStatus(env);
  ok(usage2.updatedAt === usage1.updatedAt, '存储缓存命中（updatedAt 不变，不重复全表扫描）', `${usage2.updatedAt}/${usage1.updatedAt}`);
  // key configured + one email sent today -> day/month each 1, quota percentage rises
  const nowTs = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO messages (id, direction, mailbox, from_email, to_emails, received_at, status, resend_id, created_at, updated_at) VALUES (?, 'outbound', 'support@example.com', 'support@example.com', '[]', ?, 'sent', 're_test_1', ?, ?)"
  ).bind('out-usage-1', nowTs, nowTs, nowTs).run();
  const usageSend = await repo.getBackendStatus({ DB: db, BUCKET: bucket, RESEND_API_KEY: 're_x' });
  ok(usageSend.resend.configured === true, '配了 key → configured=true', usageSend.resend.configured);
  ok(usageSend.resend.day.used >= 1 && usageSend.resend.month.used >= 1, '今日 / 本月发信计数 ≥ 1', `${usageSend.resend.day.used}/${usageSend.resend.month.used}`);
  ok(usageSend.resend.day.percent > 0, '发信额度百分比随用量上升', usageSend.resend.day.percent);
  // custom limits (paid-tier override)
  const usagePaid = await repo.getBackendStatus({ DB: db, BUCKET: bucket, D1_LIMIT_BYTES: String(10 * 1024 * 1024 * 1024) }, { force: true });
  ok(usagePaid.d1.limitBytes === 10 * 1024 * 1024 * 1024 && usagePaid.d1.percent <= usage1.d1.percent, '可覆盖 D1 限额（付费档 → 分母变大，百分比不增）', usagePaid.d1.percent);

  /* ---- summary ---- */
  cleanup();
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);
  console.log(`\n===== 结果: ${pass} passed, ${failed.length} failed =====`);
  const exitCode = failed.length ? 1 : 0;
  try { fs.writeFileSync(path.join(os.tmpdir(), 'qa-cf-inbound.exit'), String(exitCode), 'utf8'); } catch { /* ignore */ }
  process.exit(exitCode);
})().catch((e) => {
  console.error('\n未捕获异常：', e);
  cleanup();
  process.exit(1);
});
