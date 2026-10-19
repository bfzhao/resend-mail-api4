'use strict';

/* =============================================================================
 * Independent regression verification of two defect classes: "recipient role" and "attachment preview"
 * (real jsdom + real DOM events + real index.html / app.css / app.js)
 *
 * Run (jsdom is installed in a shared workspace locally, so NODE_PATH is required):
 *   NODE_PATH='<NODE_PATH>' \
 *     node test/read-role-attachment.dom.test.js
 *
 * Exit code: 0 = all passed; 1 = some failed; 2 = environment missing (jsdom not found).
 *
 * Covers user-reported issues (2026-10-08, second round):
 *   P1  I am a cc recipient, yet the "recipient" in the detail shows me
 *       -- root cause: the `to` from Resend's inbound API is the **delivery address (envelope recipient)**, not the `To:` header.
 *          The backend was changed to "prefer headers.to, store the delivery address separately as delivered_to";
 *          the frontend determines where the mailbox falls among cc/bcc/to and shows a "you are cc/bcc" tag on the always-visible summary row.
 *   P2  The rich text editor auto-grows and pushes the "send" button off-screen
 *       -- cap the composer height + scroll, make the bottom action row sticky.
 *   P4  Attachments cannot be previewed
 *       -- inline preview for previewable types + an in-app overlay, each attachment gets its own download button (?dl=1).
 *
 * Mutation verification hooks (point to hand-crafted defective versions outside the repo):
 *   QA_APP_JS / QA_INDEX_HTML / QA_APP_CSS / QA_REPO_TS
 * ===========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.error('无法加载 jsdom。请用 NODE_PATH 指向 jsdom 所在 node_modules（Windows 反斜杠写法）：');
  console.error("  NODE_PATH='<NODE_PATH>' node test/read-role-attachment.dom.test.js");
  console.error(String(e && e.message));
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const APP_JS_PATH = process.env.QA_APP_JS || path.join(ROOT, 'public', 'app.js');
const INDEX_PATH = process.env.QA_INDEX_HTML || path.join(ROOT, 'public', 'index.html');
const CSS_PATH = process.env.QA_APP_CSS || path.join(ROOT, 'public', 'app.css');
const REPO_TS_PATH = process.env.QA_REPO_TS || path.join(ROOT, 'src', 'repo.ts');

const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');
const APP_CSS = fs.readFileSync(CSS_PATH, 'utf8');
const REPO_TS = fs.readFileSync(REPO_TS_PATH, 'utf8');
/** Strip comments before running "must not appear" assertions: otherwise your own example text in a comment trips it (been there). */
const CSS_NO_COMMENTS = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const FINGERPRINT = {
  appjs: crypto.createHash('md5').update(APP_JS).digest('hex'),
  appcss: crypto.createHash('md5').update(APP_CSS).digest('hex'),
  index: crypto.createHash('md5').update(INDEX_HTML).digest('hex'),
};

/* ---------------------------------------------------------------------------
 * Fixtures
 * -------------------------------------------------------------------------*/

const ME = 'dana@example.com';

function listItem(id, extra = {}) {
  return Object.assign({
    id,
    direction: 'inbound',
    from_name: 'Frank Valencia',
    from_email: 'frank@example.net',
    subject: '主题 ' + id,
    to_emails: [ME],
    received_at: 1700000000,
    read: 1,
    starred: 0,
    status: 'received',
    attachments_count: 0,
    preview: '预览 ' + id,
    mailbox: ME,
  }, extra);
}

/**
 * Detail response.
 *
 * ⚠️ Fields must match the real interface:
 *  - `delivered_to` is **an explicit null or an array** (legacy rows are null, new rows are an array of delivery addresses);
 *    the frontend uses `!== null` to distinguish "new data" from "old data before the fix".
 *  - the recipient field name is `to_emails` (used by both list items and details).
 */
function detailOf(m, extra = {}, attachments = []) {
  return {
    message: Object.assign({}, m, {
      read: 1,
      body_text: '正文 ' + m.id,
      body_html: null,
      thread_id: 't-' + m.id,
      cc: [],
      bcc: [],
      reply_to: [],
      delivered_to: null,
    }, extra),
    attachments,
    thread: [],
  };
}

function fixture(m, detail) {
  return {
    mailboxes: [{ mailbox: ME, inbox_unread: 0, inbox_total: 1, sent_total: 0 }],
    folders: {
      inbox: { items: [m], total: 1 },
      sent: { items: [], total: 0 },
      starred: { items: [], total: 0 },
      trash: { items: [], total: 0 },
    },
    messages: { [m.id]: detail },
    counts: { inbox_unread: 0, inbox_total: 1, sent_total: 0, starred_total: 0, trash_total: 0 },
    text: {},
  };
}

/* ---------------------------------------------------------------------------
 * fetch stub
 * -------------------------------------------------------------------------*/

function makeStub(cfg = {}) {
  const calls = [];
  // Here we consume the fixture object directly (fixture()'s return value is the data source for each interface)
  const store = cfg || {};
  const jsonRes = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });

  const fetchImpl = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url, method });
    const pathOnly = url.split('?')[0];

    if (pathOnly === '/api/account') {
      return Promise.resolve(jsonRes({ can_send: true, from_name: 'support', from_address: 'support@example.com' }));
    }
    if (pathOnly === '/api/mailboxes') return Promise.resolve(jsonRes({ mailboxes: store.mailboxes || [] }));
    if (pathOnly === '/api/counts') return Promise.resolve(jsonRes(store.counts || {}));
    const fm = /^\/api\/folders\/([a-z]+)$/.exec(pathOnly);
    if (fm) {
      const d = (store.folders || {})[fm[1]] || { items: [], total: 0 };
      return Promise.resolve(jsonRes({ folder: fm[1], items: d.items, total: d.total }));
    }
    // Attachment body (text preview is rendered by fetch itself)
    const am = /^\/api\/attachments\/([^/]+)$/.exec(pathOnly);
    if (am) {
      const key = decodeURIComponent(am[1]);
      const text = (store.text || {})[key];
      if (text === undefined) return Promise.resolve({ ok: false, status: 404, text: async () => '', json: async () => ({}) });
      return Promise.resolve({ ok: true, status: 200, text: async () => text, json: async () => ({}) });
    }
    const mm = /^\/api\/messages\/([^/]+)$/.exec(pathOnly);
    if (mm) {
      const d = (store.messages || {})[decodeURIComponent(mm[1])];
      if (!d) return Promise.resolve(jsonRes({ error: '邮件不存在' }, 404));
      return Promise.resolve(jsonRes(d));
    }
    return Promise.resolve(jsonRes({}));
  };

  return { fetchImpl, calls, store };
}

/* ---------------------------------------------------------------------------
 * Boot
 * -------------------------------------------------------------------------*/

const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }

async function boot(cfg) {
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  // jsdom defaults document.hidden === true -> code gated by `if (document.hidden) return;` never runs
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(win.document, 'hidden', { value: false, configurable: true });
  const stub = makeStub(cfg);
  win.fetch = stub.fetchImpl; // must be before injecting app.js

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  let ready = false;
  for (let i = 0; i < 600; i++) {
    const nav = win.document.querySelector('#folder-nav');
    const list = win.document.querySelector('#list');
    let openId = null;
    let pending = true;
    try {
      openId = win.eval('typeof state === "object" ? state.openId : null');
      pending = !!win.eval('detailPending');
    } catch { /* not ready yet */ }
    if (nav && nav.children.length > 0 && list && list.children.length > 0 && openId && !pending) { ready = true; break; }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 10);
  win.eval('prefetchGen++; prefetchActive = null;'); // invalidate background prefetch to avoid request-count jitter
  return { dom, win, doc: win.document, stub, close() { try { dom.window.close(); } catch { /* ignore */ } } };
}

/* ---------------------------------------------------------------------------
 * Assertion helpers
 * -------------------------------------------------------------------------*/

const results = [];
let currentTest = '(boot)';
let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  results.push({ test: currentTest, ok: good, msg, detail });
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${detail === undefined ? '' : `  [${detail}]`}`);
}
function info(msg) { console.log(`  INFO  ${msg}`); }

async function test(name, fn, cfg) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  let ctx = null;
  let extra = null;
  // Allow a case to boot itself (fixtures need to be built per-case): bootTracked's product is closed uniformly in finally,
  // to avoid leaving unclosed jsdom windows (an unclosed window keeps running timers and makes the suite flaky).
  const bootTracked = async (c) => { extra = await boot(c); return extra; };
  try {
    if (cfg) ctx = await boot(cfg);
    await fn(ctx, bootTracked);
  } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  } finally {
    if (ctx) ctx.close();
    if (extra && extra !== ctx) extra.close();
  }
}

const el = (ctx, sel) => ctx.doc.querySelector(sel);
const evalIn = (ctx, expr) => ctx.win.eval(expr);
const textOf = (ctx, sel) => { const n = el(ctx, sel); return n ? n.textContent : null; };
const isHidden = (ctx, sel) => { const n = el(ctx, sel); return !n || n.classList.contains('hidden'); };
function clickEl(ctx, node) {
  if (!node) throw new Error('clickEl: 节点不存在');
  node.dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function pressEsc(ctx) {
  ctx.doc.dispatchEvent(new ctx.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}
/** The value of a key in a detail row (the key-value pairs after "view details" is expanded). */
function detailLine(ctx, key) {
  const lines = el(ctx, '#read-message .env-detail-lines');
  if (!lines) return null;
  for (const row of lines.children) {
    const k = row.querySelector('.k');
    if (k && k.textContent === key) return row.querySelector('span:not(.k)').textContent;
  }
  return null;
}

const ATT = (id, filename, contentType, size = 1024, extra = {}) =>
  Object.assign({ id, message_id: 'm', filename, content_type: contentType, size, inline: false, content_id: null, url: `/api/attachments/${id}` }, extra);

/* =============================================================================
 * Main flow
 * ===========================================================================*/
(async () => {
  console.log('收件人角色 + 附件预览 —— 真实 jsdom 回归');
  console.log(`被测版本: app.js md5=${FINGERPRINT.appjs}  app.css md5=${FINGERPRINT.appcss}  index.html md5=${FINGERPRINT.index}`);

  /* ======================= P1 recipient role ======================= */

  await test('P1a 修复前的旧数据（delivered_to=null，我只是抄送）：不得把自己显示成「收件人」', async (ctx, bootTracked) => {
    // Legacy row: to_emails stores the **delivery address** (= me), cc is the real cc header (= me)
    const m = listItem('OLD', { to_emails: [ME] });
    const d = detailOf(m, { to_emails: [ME], cc: [ME], delivered_to: null });
    ctx = await bootTracked(fixture(m, d));
    const toText = textOf(ctx, '#read-message .env-details');
    ok(!!toText, '负控制：信封卡摘要行已渲染（否则下面的断言可能是空转）', toText);
    ok(toText.indexOf(ME) < 0,
      '⭐ 摘要行的「收件人」不再显示我自己（旧数据里 to_emails 是投递地址）', toText);
    ok(!!el(ctx, '#read-message .env-role-chip'),
      '⭐ 出现了「你是抄送」角标（默认可见的摘要行上就给结论，不用展开详情）', textOf(ctx, '#read-message .env-role-chip'));
    ok(textOf(ctx, '#read-message .env-role-chip') === '你是抄送',
      '角标文案 = 你是抄送', textOf(ctx, '#read-message .env-role-chip'));
    ok(detailLine(ctx, '抄送') === ME, '详情行「抄送」仍如实列出我', detailLine(ctx, '抄送'));
    // ⛔ 2026-10-08 third round: three purely redundant detail rows were removed at the user's request.
    //    Here we use "must not exist" to lock the removal -- otherwise if someone casually adds them back there's no signal.
    ok(detailLine(ctx, '你的身份') === null,
      '⭐ 详情行「你的身份」已删除（身份结论由默认可见的摘要行角标承担，不再重复）', detailLine(ctx, '你的身份'));
    ok(detailLine(ctx, '收件地址') === null,
      '⭐ 详情行「收件地址」已删除（信封卡副标题「收至 …」已承担）', detailLine(ctx, '收件地址'));
    ok(detailLine(ctx, '时间') === null,
      '⭐ 详情行「时间」已删除（信封卡右上角是同一格式的同一串字符）', detailLine(ctx, '时间'));
    ok(textOf(ctx, '#read-message .env-top').indexOf('收至') >= 0,
      '⭐ 删掉「收件地址」行后投递信箱仍可见（信息没丢，只是不再重复一遍）', textOf(ctx, '#read-message .env-top'));
  });

  await test('P1b 修复后的新数据（headers.to 已落库）：收件人显示真实 To，并标注我是抄送', async (ctx, bootTracked) => {
    const m = listItem('NEW', { to_emails: ['frank@example.net'] });
    const d = detailOf(m, {
      to_emails: ['frank@example.net'],
      cc: [ME],
      delivered_to: [ME], // new row: delivery address stored separately
    });
    ctx = await bootTracked(fixture(m, d));
    const toText = textOf(ctx, '#read-message .env-details');
    ok(toText.indexOf('frank@example.net') >= 0, '⭐ 摘要行显示真实 To 头', toText);
    ok(toText.indexOf(ME) < 0, '摘要行的「收件人」不包含我（我是抄送）', toText);
    ok(textOf(ctx, '#read-message .env-role-chip') === '你是抄送', '角标「你是抄送」', textOf(ctx, '#read-message .env-role-chip'));
    ok(detailLine(ctx, '收件人') === 'frank@example.net', '详情行收件人 = 真实 To', detailLine(ctx, '收件人'));
    ok(detailLine(ctx, '收件地址') === null,
      '⭐ 详情行「收件地址」已删除（投递信箱改由信封卡副标题承载）', detailLine(ctx, '收件地址'));
    ok(textOf(ctx, '#read-message .env-top').indexOf(ME) >= 0,
      '投递地址仍可见（信封卡副标题「收至 <我的信箱>」）', textOf(ctx, '#read-message .env-top'));
  });

  await test('P1c 负控制：正常收件（我就在 To 里）不得出现角色角标', async (ctx, bootTracked) => {
    const m = listItem('TO', { to_emails: [ME] });
    const d = detailOf(m, { to_emails: [ME], cc: ['other@x.com'], delivered_to: [ME] });
    ctx = await bootTracked(fixture(m, d));
    ok(textOf(ctx, '#read-message .env-details').indexOf(ME) >= 0, '收件人显示我', textOf(ctx, '#read-message .env-details'));
    ok(!el(ctx, '#read-message .env-role-chip'),
      '⭐ 没有角色角标（否则就是「无条件显示角标」的假修复）');
    ok(detailLine(ctx, '你的身份') === null,
      '⭐ 详情行「你的身份」已删除（是收件人时，「收件人」那一行里就有自己）', detailLine(ctx, '你的身份'));
  });

  await test('P1d 密送：cc 为空、我在 bcc 里 → 角标「你是密送」', async (ctx, bootTracked) => {
    const m = listItem('BCC', { to_emails: ['frank@example.net'] });
    const d = detailOf(m, { to_emails: ['frank@example.net'], cc: [], bcc: [ME], delivered_to: [ME] });
    ctx = await bootTracked(fixture(m, d));
    ok(textOf(ctx, '#read-message .env-role-chip') === '你是密送', '角标「你是密送」', textOf(ctx, '#read-message .env-role-chip'));
    ok(detailLine(ctx, '密送') === ME, '详情行「密送」= 我', detailLine(ctx, '密送'));
    ok(detailLine(ctx, '抄送') === null,
      '⭐ cc 为空时不再白列一行「抄送 —」（入站分支补齐了与出站相同的守卫）', detailLine(ctx, '抄送'));
  });

  await test('P1e 优先级锁死：我同时在 To 与 Cc 里 → 判为「抄送」（cc 先于 to）', async (ctx, bootTracked) => {
    // This rule is key to whether legacy data can be identified correctly: legacy rows' to_emails is the delivery address, so my address is necessarily in it,
    // and if `to` is checked first, "cc" can never be detected. Pin the order down with a case where I'm in both.
    const m = listItem('BOTH', { to_emails: [ME] });
    const d = detailOf(m, { to_emails: [ME], cc: [ME], delivered_to: [ME] });
    ctx = await bootTracked(fixture(m, d));
    ok(evalIn(ctx, `myRecipientRole(${JSON.stringify({ mailbox: ME, to_emails: [ME], cc: [ME], bcc: [] })})`) === 'cc',
      '⭐ myRecipientRole：cc 优先于 to（顺序反了旧数据就会误判成收件人）');
    ok(evalIn(ctx, `myRecipientRole(${JSON.stringify({ mailbox: ME, to_emails: [ME], cc: [], bcc: [] })})`) === 'to',
      '负控制：不在 cc/bcc 时仍判为收件人（不是恒返回 cc）');
  });

  await test('P1f 出站邮件不受影响（收件人行仍是 to_emails 全量）', async (ctx, bootTracked) => {
    const m = listItem('OUT', {
      direction: 'outbound', status: 'sent', mailbox: 'support@example.com',
      from_name: 'support', from_email: 'support@example.com',
      to_emails: ['alice@partner.com', 'bob@partner.com'],
    });
    const d = detailOf(m, { to_emails: ['alice@partner.com', 'bob@partner.com'], delivered_to: null });
    ctx = await bootTracked(fixture(m, d));
    const toText = textOf(ctx, '#read-message .env-details');
    ok(toText.indexOf('alice@partner.com') >= 0 && toText.indexOf('bob@partner.com') >= 0,
      '出站收件人清单照常显示（口径未被入站改动带偏）', toText);
    ok(!el(ctx, '#read-message .env-role-chip'), '出站不显示「你是抄送」角标');
    // The outbound branch must also drop the "time" row -- otherwise this regression isn't caught during mutation verification (a coverage gap found by actual measurement this round)
    ok(detailLine(ctx, '时间') === null,
      '⭐ 出站也不再有「时间」行（信封卡右上角 fmtDateTime 已是同一串字符）', detailLine(ctx, '时间'));
  });

  await test('P1g 「收件人：—」的老邮件带解释性 title（超期取不回，不是 bug）', async (ctx, bootTracked) => {
    // Ingested before the fix + delivery address minus cc is empty -> can only show "—". Such rows still have delivered_to as an explicit null.
    const m = listItem('LEGACY', { to_emails: [ME] });
    const d = detailOf(m, { to_emails: [ME], cc: [ME], bcc: [], delivered_to: null });
    ctx = await bootTracked(fixture(m, d));
    const line = el(ctx, '#read-message .env-details');
    ok(!!line, '负控制：摘要行已渲染（否则下面的 title 断言可能是空转）');
    ok(textOf(ctx, '#read-message .env-details').indexOf('—') >= 0,
      '收件人显示「—」', textOf(ctx, '#read-message .env-details'));
    ok(!!line.title && line.title.indexOf('无法恢复') >= 0,
      '⭐ 摘要行带 title 说明成因（2026-10-08 回填后仍有 10 行超期取不回，不给说明会被反复当 bug 排查）',
      line.title);
  });

  await test('P1h 负控制：收件人正常显示时不得挂那个 title', async (ctx, bootTracked) => {
    const m = listItem('OK');
    const d = detailOf(m, { to_emails: ['frank@example.net'], cc: [ME], delivered_to: [ME] });
    ctx = await bootTracked(fixture(m, d));
    const line = el(ctx, '#read-message .env-details');
    ok(textOf(ctx, '#read-message .env-details').indexOf('frank@example.net') >= 0,
      '收件人正常显示真实 To', textOf(ctx, '#read-message .env-details'));
    ok(!line.title,
      '⭐ 正常情况不挂解释性 title（否则就是「无条件挂 title」的假修复）', line.title);
  });

  /* ======================= P4 attachment preview ======================= */

  await test('P4a 附件 chip：文件名可点（预览）+ 独立下载按钮（带 ?dl=1）', async (ctx, bootTracked) => {
    const m = listItem('ATT1', { attachments_count: 1 });
    const atts = [ATT('a1', '报价单.pdf', 'application/pdf', 2048)];
    ctx = await bootTracked(fixture(m, detailOf(m, {}, atts)));
    const chip = el(ctx, '#read-message .att-chip');
    ok(!!chip, '负控制：附件 chip 已渲染（否则下面的断言全是空转）');
    const open = chip.querySelector('.att-open');
    ok(!!open, '⭐ 文件名是一个可点按钮（.att-open）');
    ok(open.textContent.indexOf('报价单.pdf') >= 0, '按钮文案 = 文件名', open.textContent);
    const dl = chip.querySelector('a.att-dl');
    ok(!!dl, '⭐ 有独立下载按钮（a.att-dl）');
    ok(dl.getAttribute('href') === '/api/attachments/a1?dl=1',
      '⭐ 下载链接带 ?dl=1（强制 attachment，否则 PDF 会被浏览器就地打开）', dl.getAttribute('href'));
    ok(dl.getAttribute('download') === '报价单.pdf', '下载链接带 download 属性', dl.getAttribute('download'));
    ok(!el(ctx, '#read-message .att-chip > a[target="_blank"]'),
      '旧的「整块 chip 就是新窗口链接」写法已不存在（否则点文件名会跳走）');
  });

  await test('P4b 点图片附件 → 浮层内嵌 <img>（不跳转）', async (ctx, bootTracked) => {
    const m = listItem('ATT2', { attachments_count: 1 });
    const atts = [ATT('img1', 'shot.png', 'image/png', 4096)];
    ctx = await bootTracked(fixture(m, detailOf(m, {}, atts)));
    ok(isHidden(ctx, '#att-preview'), '初始时浮层是隐藏的（负控制）');
    clickEl(ctx, el(ctx, '#read-message .att-chip .att-open'));
    await ticks(ctx.win, 3);
    ok(!isHidden(ctx, '#att-preview'), '⭐ 点文件名后浮层打开');
    const img = el(ctx, '#att-preview-body img');
    ok(!!img, '浮层里是 <img>（图片内嵌预览）');
    ok(img && img.getAttribute('src') === '/api/attachments/img1', '图片 src 指向附件接口（不带 dl=1，走后端 inline）', img && img.getAttribute('src'));
    ok(textOf(ctx, '#att-preview-name') === 'shot.png', '浮层标题显示文件名', textOf(ctx, '#att-preview-name'));
    ok(el(ctx, '#att-preview-dl').getAttribute('href') === '/api/attachments/img1?dl=1', '浮层里也有下载按钮', el(ctx, '#att-preview-dl').getAttribute('href'));
  });

  await test('P4c 点 PDF → <iframe>；点视频 → <video controls>', async (ctx, bootTracked) => {
    const m = listItem('ATT3', { attachments_count: 2 });
    const atts = [ATT('p1', 'doc.pdf', 'application/pdf'), ATT('v1', 'clip.mp4', 'video/mp4')];
    ctx = await bootTracked(fixture(m, detailOf(m, {}, atts)));
    const opens = ctx.doc.querySelectorAll('#read-message .att-chip .att-open');
    ok(opens.length === 2, '负控制：两个附件的按钮都在', opens.length);
    clickEl(ctx, opens[0]);
    await ticks(ctx.win, 3);
    ok(!!el(ctx, '#att-preview-body iframe'), 'PDF → iframe 内嵌');
    clickEl(ctx, opens[1]);
    await ticks(ctx.win, 3);
    const v = el(ctx, '#att-preview-body video');
    ok(!!v, '视频 → <video>');
    ok(v && v.controls === true, '视频带 controls（否则没法播）');
    ok(!el(ctx, '#att-preview-body iframe'), '切换附件时旧内容被清掉（不会两层叠着）');
  });

  await test('P4d 点纯文本附件 → 拉回内容渲染 <pre>（不是 iframe）', async (ctx, bootTracked) => {
    const m = listItem('ATT4', { attachments_count: 1 });
    const atts = [ATT('t1', 'notes.txt', 'text/plain', 12)];
    const cfg = fixture(m, detailOf(m, {}, atts));
    cfg.text = { t1: '第一行\n第二行' };
    ctx = await bootTracked(cfg);
    clickEl(ctx, el(ctx, '#read-message .att-chip .att-open'));
    await ticks(ctx.win, 6);
    const pre = el(ctx, '#att-preview-body pre.att-preview-text');
    ok(!!pre, '文本附件渲染成 <pre>');
    ok(pre && pre.textContent === '第一行\n第二行', '内容来自附件接口（真实拉取，不是占位）', pre && JSON.stringify(pre.textContent));
    ok(!el(ctx, '#att-preview-body iframe'), '没有用 iframe（否则浏览器会把它当独立页面加载）');
  });

  await test('P4e 不可预览格式（zip）→ 不开浮层 + 明确提示，不假装能预览', async (ctx, bootTracked) => {
    const m = listItem('ATT5', { attachments_count: 1 });
    const atts = [ATT('z1', 'a.zip', 'application/zip')];
    ctx = await bootTracked(fixture(m, detailOf(m, {}, atts)));
    clickEl(ctx, el(ctx, '#read-message .att-chip .att-open'));
    await ticks(ctx.win, 3);
    ok(isHidden(ctx, '#att-preview'), '⭐ 浮层**没有**打开（zip 浏览器不会预览）');
    ok(!isHidden(ctx, '#toast'), '⭐ 给了提示 toast（不是点了没反应）');
    ok(/不支持在线预览/.test(textOf(ctx, '#toast')), '提示文案说明不支持在线预览', textOf(ctx, '#toast'));
    ok(el(ctx, '#read-message .att-chip a.att-dl').getAttribute('href') === '/api/attachments/z1?dl=1',
      '下载按钮照常可用（这是 zip 的唯一出路）');
  });

  await test('P4f Esc / 关闭按钮 / 换邮件 都能收起浮层', async (ctx, bootTracked) => {
    const m = listItem('ATT6', { attachments_count: 1 });
    const atts = [ATT('i6', 'a.png', 'image/png')];
    ctx = await bootTracked(fixture(m, detailOf(m, {}, atts)));
    const open = el(ctx, '#read-message .att-chip .att-open');
    clickEl(ctx, open);
    await ticks(ctx.win, 3);
    ok(!isHidden(ctx, '#att-preview'), '前置：浮层已打开');
    pressEsc(ctx);
    await ticks(ctx.win, 2);
    ok(isHidden(ctx, '#att-preview'), '⭐ Esc 关闭浮层');
    ok(el(ctx, '#att-preview-body').children.length === 0, '关闭时清空内容（否则 <video> 还在后台加载）');

    clickEl(ctx, open);
    await ticks(ctx.win, 3);
    clickEl(ctx, el(ctx, '#att-preview-close'));
    await ticks(ctx.win, 2);
    ok(isHidden(ctx, '#att-preview'), '「关闭」按钮关闭浮层');

    clickEl(ctx, open);
    await ticks(ctx.win, 3);
    ok(!isHidden(ctx, '#att-preview'), '前置：再次打开');
    evalIn(ctx, 'renderRead()'); // renderRead is the sole outlet for detail content
    await ticks(ctx.win, 3);
    ok(isHidden(ctx, '#att-preview'), '⭐ 重新渲染详情（换邮件 / 刷新）时浮层自动收起');
  });

  await test('P4g Esc 只关浮层，不顺手关掉写信弹窗（层级优先）', async (ctx, bootTracked) => {
    const m = listItem('ATT7', { attachments_count: 1 });
    const atts = [ATT('i7', 'a.png', 'image/png')];
    ctx = await bootTracked(fixture(m, detailOf(m, {}, atts)));
    evalIn(ctx, 'openComposer()');
    await ticks(ctx.win, 3);
    ok(!isHidden(ctx, '#modal-mask'), '前置：写信弹窗已打开');
    clickEl(ctx, el(ctx, '#read-message .att-chip .att-open'));
    await ticks(ctx.win, 3);
    ok(!isHidden(ctx, '#att-preview'), '前置：附件浮层也打开了');
    pressEsc(ctx);
    await ticks(ctx.win, 3);
    ok(isHidden(ctx, '#att-preview'), 'Esc 关掉了附件浮层');
    ok(!isHidden(ctx, '#modal-mask'), '⭐ 写信弹窗仍然开着（Esc 没有穿透下去）');
  });

  /* ======================= Static layer: CSS / HTML / cross-layer contract ======================= */

  await test('S1 问题 2：弹窗封顶 + 底部操作行吸底', async (ctx, bootTracked) => {
    ctx = await boot(fixture(listItem('S1'), detailOf(listItem('S1'))));
    const ruleHas = (sel, re) => {
      const i = CSS_NO_COMMENTS.indexOf(sel + ' {');
      if (i < 0) return false;
      const block = CSS_NO_COMMENTS.slice(i, CSS_NO_COMMENTS.indexOf('}', i));
      return re.test(block);
    };
    ok(ruleHas('#composer', /max-height:\s*calc\(100d?vh\s*-\s*\d+px\)/),
      '⭐ #composer 有 max-height 封顶（否则编辑器长高就把整窗顶出视口）');
    ok(ruleHas('#composer', /overflow-y:\s*auto/), '#composer overflow-y: auto（超出可滚）');
    ok(ruleHas('.composer-actions', /position:\s*sticky/), '⭐ .composer-actions position: sticky');
    ok(ruleHas('.composer-actions', /bottom:\s*0/), '⭐ .composer-actions bottom: 0（发送按钮永远可见）');
    ok(ruleHas('.composer-actions', /background:/), '吸底行有不透明背景（否则正文从按钮下透出来）');
    ok(ruleHas('.rich-editor', /max-height:\s*min\(45vh,\s*360px\)/),
      '.rich-editor 的 max-height 收紧到 min(45vh, 360px)（默认弹窗大多数屏幕不用滚）');
    // Negative control: the combination "max-height: none in floating mode with no fallback" must not reappear
    ok(ruleHas('#composer.floating .composer-body-wrap', /flex:\s*1\s+1\s+auto/),
      '浮动模式正文区仍 flex: 1 1 auto（放大时正文吸收多余高度，未被本次改动破坏）');
  });

  await test('S2 问题 4：index.html 具备浮层骨架与角色角标样式', async (ctx, bootTracked) => {
    ctx = await boot(fixture(listItem('S2'), detailOf(listItem('S2'))));
    for (const id of ['#att-preview', '#att-preview-name', '#att-preview-body', '#att-preview-dl', '#att-preview-close']) {
      ok(!!el(ctx, id), `index.html 里有 ${id}`);
    }
    const i = CSS_NO_COMMENTS.indexOf('.env-role-chip');
    ok(i >= 0, '⭐ app.css 定义了 .env-role-chip（否则角标没有样式，等于没做）');
    const j = CSS_NO_COMMENTS.indexOf('.att-chip .att-dl');
    ok(j >= 0, 'app.css 定义了 .att-chip .att-dl（下载按钮）');
  });

  await test('S3 跨层口径：前端 attachmentKind 与后端 isInlinePreviewType 必须一致', async (ctx, bootTracked) => {
    ctx = await boot(fixture(listItem('S3'), detailOf(listItem('S3'))));
    const m = /const INLINE_PREVIEW_TYPES = \[([^\]]*)\]/.exec(APP_JS);
    ok(!!m, '能从前端读出 INLINE_PREVIEW_TYPES 清单');
    const feTypes = m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
    ok(feTypes.length > 0, '前端清单非空（否则下面的比对是空转）', feTypes.join(','));

    const fn = /export function isInlinePreviewType\(contentType: string\): boolean \{[\s\S]*?\n\}/.exec(REPO_TS);
    ok(!!fn, '能从 src/repo.ts 读出 isInlinePreviewType 函数体');
    const beBody = fn ? fn[0] : '';

    const missing = feTypes.filter((t) => beBody.indexOf(`'${t}'`) < 0);
    ok(missing.length === 0,
      '⭐ 前端清单里每个类型后端都放行（不一致会出现「浮层开了、后端却让浏览器下载」）', missing.join(','));
    ok(/'image\/'/.test(beBody) && /'video\/'/.test(beBody) && /'audio\/'/.test(beBody),
      '后端放行 image/ video/ audio/ 前缀（与前端 startsWith 规则对齐）');
    ok(/'image\/svg\+xml'/.test(beBody) && APP_JS.indexOf("t === 'image/svg+xml'") >= 0,
      '⭐ 两端都显式排除 SVG（可执行脚本，内联进同源上下文 = XSS）');
    ok(beBody.indexOf("'text/html'") < 0,
      '后端不把 text/html 列为可内联（HTML 会被当页面打开）');

    // Real function behavior sampling (not just string comparison)
    const kind = (t) => evalIn(ctx, `attachmentKind(${JSON.stringify({ content_type: t })})`);
    ok(kind('image/png') === 'image', 'attachmentKind(image/png) = image', kind('image/png'));
    ok(kind('image/svg+xml') === 'none', 'attachmentKind(image/svg+xml) = none', kind('image/svg+xml'));
    ok(kind('application/pdf') === 'pdf', 'attachmentKind(pdf) = pdf');
    ok(kind('text/plain') === 'text', 'attachmentKind(text/plain) = text');
    ok(kind('application/zip') === 'none', 'attachmentKind(zip) = none');
    ok(kind('') === 'none', 'attachmentKind(空类型) = none');
  });

  /* ---- summary ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);

  console.log(`\n被测版本: app.js md5=${FINGERPRINT.appjs}  app.css md5=${FINGERPRINT.appcss}  index.html md5=${FINGERPRINT.index}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);

  const exitCode = fail ? 1 : 0;
  const exitFile = path.join(os.tmpdir(), 'qa-read-role-attachment.exit');
  try { fs.writeFileSync(exitFile, String(exitCode), 'utf8'); console.log(`退出码已写入: ${exitFile} = ${exitCode}`); } catch { /* ignore */ }
  process.exit(exitCode);
})().catch((e) => {
  console.error('\n未捕获异常：', e);
  process.exit(2);
});
