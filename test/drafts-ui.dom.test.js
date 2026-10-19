'use strict';

/* =============================================================================
 * Drafts (compose drafts) frontend -- real jsdom + full index.html + full app.js
 *
 * Run:
 *   NODE_PATH=<NODE_PATH> \
 *     <node.exe> test/drafts-ui.dom.test.js
 *
 * Exit code: 0 = all passed; 1 = some failed.
 *
 * Covers:
 *   · Sidebar "drafts" entry and badge (its meaning is **not mixed up** with the inbox unread badge)
 *   · The draft list reuses the same list renderer (the server disguises drafts as rows with direction='draft')
 *   · Clicking a draft row -> opens the composer and prefills it (rather than opening the detail)
 *   · Inline × deletes the draft (and must not also open the composer)
 *   · Sending after restoring a draft -> the request body must carry draft_id (the server deletes the draft based on it)
 *
 * The "auto-save draft while writing / save draft on close" behavior is covered by test/compose-guard*.test.js and not repeated here.
 *
 * This file does not modify any source under public/.
 * ===========================================================================*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
// QA_APP_JS / QA_INDEX_HTML are only for "mutation verification": point to hand-crafted defective versions (kept outside the repo).
const APP_JS_PATH = process.env.QA_APP_JS || path.join(ROOT, 'public', 'app.js');
const INDEX_PATH = process.env.QA_INDEX_HTML || path.join(ROOT, 'public', 'index.html');
const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');

const FINGERPRINT = {
  'public/app.js': crypto.createHash('md5').update(APP_JS).digest('hex'),
  'public/index.html': crypto.createHash('md5').update(INDEX_HTML).digest('hex'),
};

/* ---------------------------------------------------------------------------
 * fetch stub
 * -------------------------------------------------------------------------*/

function makeStub(cfg) {
  const calls = [];
  const jsonRes = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });

  const fetchImpl = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const method = String((init && init.method) || 'GET').toUpperCase();
    calls.push({ url, method, body: init && init.body });

    if (url.startsWith('/api/account')) {
      return Promise.resolve(jsonRes({ can_send: true, from_name: 'Me', from_address: 'me@example.com' }));
    }
    if (url.startsWith('/api/mailboxes')) return Promise.resolve(jsonRes({ mailboxes: [{ mailbox: 'me@example.com' }] }));
    if (url.startsWith('/api/counts')) return Promise.resolve(jsonRes(Object.assign({}, cfg.counts)));
    if (url.startsWith('/api/contacts')) return Promise.resolve(jsonRes({ contacts: [] }));
    const dm = /^\/api\/drafts\/([^/?]+)/.exec(url);
    if (dm) {
      if (method === 'DELETE') return Promise.resolve(jsonRes({ ok: true }));
      const d = (cfg.drafts || []).find((x) => x.id === decodeURIComponent(dm[1]));
      if (!d) return Promise.resolve(jsonRes({ error: '草稿不存在' }, 404));
      return Promise.resolve(jsonRes({ draft: d }));
    }
    const fm = /^\/api\/folders\/([a-z]+)/.exec(url);
    if (fm) {
      if (fm[1] === 'drafts') return Promise.resolve(jsonRes({ folder: 'drafts', items: cfg.draftRows || [], total: (cfg.draftRows || []).length }));
      if (fm[1] === 'sent') return Promise.resolve(jsonRes({ folder: 'sent', items: cfg.sentRows || [], total: (cfg.sentRows || []).length }));
      return Promise.resolve(jsonRes({ folder: fm[1], items: [], total: 0 }));
    }
    if (url.startsWith('/api/messages') && method === 'POST') {
      return Promise.resolve(jsonRes({ ok: true, id: 'new-1', resend_id: 're_1' }));
    }
    if (url.startsWith('/api/messages')) return Promise.resolve(jsonRes({ message: null, items: [], total: 0 }));
    return Promise.resolve(jsonRes({}));
  };

  return { fetchImpl, calls };
}

/* ---------------------------------------------------------------------------
 * Boot instance
 * -------------------------------------------------------------------------*/

const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }

const liveCtxs = [];

async function boot(cfg = {}) {
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  Object.defineProperty(win, 'innerWidth', { value: cfg.width === undefined ? 1280 : cfg.width, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: 800, configurable: true });
  if (cfg.matchMedia) win.matchMedia = cfg.matchMedia;

  const stub = makeStub(cfg);
  win.fetch = stub.fetchImpl; // must be before injecting app.js

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  let ready = false;
  for (let i = 0; i < 400; i++) {
    const nav = win.document.querySelector('#folder-nav');
    if (nav && nav.children.length > 0 && typeof win.openDraftComposer === 'function') { ready = true; break; }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 5);

  const ctx = { dom, win, doc: win.document, stub, close() { try { dom.window.close(); } catch { /* ignore */ } } };
  liveCtxs.push(ctx);
  return ctx;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------*/

const clickEvt = (win) => new win.MouseEvent('click', { bubbles: true, cancelable: true });
function el(ctx, sel) { return ctx.doc.querySelector(sel); }
function clickEl(ctx, sel) { el(ctx, sel).dispatchEvent(clickEvt(ctx.win)); }
const evalIn = (ctx, expr) => ctx.win.eval(expr);
const navBtn = (ctx, folder) => el(ctx, `#folder-nav .folder-item[data-folder="${folder}"]`);
const rows = (ctx) => Array.from(ctx.doc.querySelectorAll('#list .list-item'));
const callsTo = (ctx, prefix) => ctx.stub.calls.filter((c) => c.url.startsWith(prefix));
const composerOpen = (ctx) => !el(ctx, '#modal-mask').classList.contains('hidden');
const val = (ctx, sel) => el(ctx, sel).value;

const results = [];
let pass = 0;
let fail = 0;
let currentTest = '(boot)';
function ok(cond, msg, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  results.push({ test: currentTest, ok: good, msg, detail });
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${detail === undefined ? '' : `  [${detail}]`}`);
}
function info(msg) { console.log(`  INFO  ${msg}`); }

async function test(name, fn, bootCfg) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  let ctx = null;
  try {
    ctx = await boot(bootCfg || {});
    await fn(ctx);
  } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  } finally {
    if (ctx) ctx.close();
  }
}

/* ---- shared fixture ---- */
// ⚠️ `to_emails` uses **JSON text** (not an array): this is the real shape returned by `/api/folders/*`
//    (the server's LIST_SELECT takes the DB column directly, without parsing). Writing the fixture as an array would mask
//    the real defect "recipients in the list are always empty -> shows 'To (unknown)'".
const DRAFT_ROWS = [
  {
    id: 'dr-1', direction: 'draft', mailbox: 'me@example.com', from_name: null, from_email: null,
    subject: '写了一半的主题', to_emails: '["a@x.com","b@y.com"]', preview: '正文预览……',
    received_at: 1700000000, read: 1, starred: 0, status: 'draft', attachments_count: 0,
  },
  {
    id: 'dr-2', direction: 'draft', mailbox: 'me@example.com', from_name: null, from_email: null,
    subject: null, to_emails: '[]', preview: '',
    received_at: 1699990000, read: 1, starred: 0, status: 'draft', attachments_count: 0,
  },
];
const SENT_ROWS = [
  {
    id: 'sn-1', direction: 'outbound', mailbox: 'me@example.com', from_name: 'Me', from_email: 'me@example.com',
    subject: '已发出的主题', to_emails: '["c@z.com","d@w.com"]', preview: '正文',
    received_at: 1700000000, read: 1, starred: 0, status: 'sent', attachments_count: 0,
  },
];
const DRAFT_FULL = {
  id: 'dr-1', mailbox: 'me@example.com', mode: 'new', source_id: null,
  to: ['a@x.com', 'b@y.com'], cc: [], bcc: [], subject: '写了一半的主题',
  body_text: '正文预览……', body_html: '<p>正文预览……</p>', rich: true, updated_at: 1700000000,
};
const COUNTS = { inbox_unread: 7, inbox_total: 20, sent_total: 5, starred_total: 1, trash_total: 0, drafts_total: 2 };

/* ===========================================================================
 * Test cases
 * ===========================================================================*/
(async function main() {
  console.log('草稿箱前端 —— 独立 jsdom 验证');
  console.log(`被测版本: ${Object.entries(FINGERPRINT).map(([k, v]) => `${k}=${v.slice(0, 8)}`).join('  ')}`);

  /* ---- D0 environment self-check ---- */
  await test('D0 环境自检：侧边栏出现「草稿」入口', async (ctx) => {
    ok(typeof ctx.win.openDraftComposer === 'function', 'openDraftComposer 为全局函数（草稿模块已加载）');
    const keys = evalIn(ctx, 'FOLDERS.map((f) => f.key).join(",")');
    ok(keys === 'inbox,drafts,starred,sent,trash', 'FOLDERS 顺序：收件箱/草稿/星标/已发送/已删除', keys);
    ok(el(ctx, '#folder-nav').children.length === 5, '导航渲染 5 项', String(el(ctx, '#folder-nav').children.length));
    const btn = navBtn(ctx, 'drafts');
    ok(!!btn, '「草稿」按钮存在');
    ok(btn && btn.querySelector('.folder-label').textContent === '草稿', '按钮文案是「草稿」', btn && btn.querySelector('.folder-label').textContent);
  }, { counts: COUNTS, draftRows: DRAFT_ROWS, drafts: [DRAFT_FULL] });

  /* ---- D1 badge semantics: unread vs draft count, must not be mixed up ---- */
  await test('D1 徽标：收件箱=未读数、草稿=条数，两个口径不混用', async (ctx) => {
    const inb = navBtn(ctx, 'inbox').querySelector('.folder-badge');
    const drf = navBtn(ctx, 'drafts').querySelector('.folder-badge');
    ok(!!inb && inb.textContent === '7', '收件箱徽标 = inbox_unread = 7', inb && inb.textContent);
    ok(!!drf && drf.textContent === '2', '⭐ 草稿徽标 = drafts_total = 2（不是未读数）', drf && drf.textContent);
    ok(drf && drf.textContent !== inb.textContent, '两个数字确实不同（否则这条断言可能空转）');
  }, { counts: COUNTS, draftRows: DRAFT_ROWS, drafts: [DRAFT_FULL] });

  await test('D1b 草稿数为 0 时不显示徽标（不出现「0」）', async (ctx) => {
    ok(!navBtn(ctx, 'drafts').querySelector('.folder-badge'), '草稿徽标不渲染');
    ok(!!navBtn(ctx, 'inbox').querySelector('.folder-badge'), '收件箱徽标照常（负控制：不是整体没渲染）');
  }, { counts: Object.assign({}, COUNTS, { drafts_total: 0 }), draftRows: [], drafts: [] });

  /* ---- D2 click "drafts" -> fetch the draft list ---- */
  await test('D2 点「草稿」：请求 /api/folders/drafts 并渲染列表', async (ctx) => {
    ctx.stub.calls.length = 0;
    clickEl(ctx, '#folder-nav .folder-item[data-folder="drafts"]');
    await ticks(ctx.win, 5);
    const hits = callsTo(ctx, '/api/folders/drafts');
    ok(hits.length >= 1, '⭐ 请求打到 /api/folders/drafts（复用同一套文件夹加载器）', hits.map((c) => c.url).join(' | ') || '（无）');
    ok(evalIn(ctx, 'state.folder') === 'drafts', 'state.folder = drafts', String(evalIn(ctx, 'state.folder')));
    ok(rows(ctx).length === 2, '列表渲染 2 行草稿', String(rows(ctx).length));
  }, { counts: COUNTS, draftRows: DRAFT_ROWS, drafts: [DRAFT_FULL] });

  /* ---- D3 structural differences of a draft row ---- */
  await test('D3 草稿行：无勾选框、头像「稿」、发件人位显示收件人、状态 chip', async (ctx) => {
    clickEl(ctx, '#folder-nav .folder-item[data-folder="drafts"]');
    await ticks(ctx.win, 5);
    const r1 = el(ctx, '#list .list-item[data-id="dr-1"]');
    const r2 = el(ctx, '#list .list-item[data-id="dr-2"]');
    ok(!!r1 && !!r2, '两行都在 DOM 里');
    ok(!r1.querySelector('.li-check'), '⭐ 草稿行没有勾选框（没有批量操作语义）');
    ok(r1.querySelector('.li-avatar').textContent === '稿', '头像位是「稿」', r1.querySelector('.li-avatar').textContent);
    ok(r1.querySelector('.li-sender').textContent === 'a@x.com, b@y.com',
      '⭐ 发件人位显示**收件人**（草稿是自己写的，看谁收才有意义）', r1.querySelector('.li-sender').textContent);
    ok(r2.querySelector('.li-sender').textContent === '(无收件人)', '无收件人时有兜底文案', r2.querySelector('.li-sender').textContent);
    const chip = r1.querySelector('.li-status');
    ok(!!chip && chip.classList.contains('draft') && chip.textContent === '草稿',
      '⭐ 有 li-status chip 且文案是「草稿」', chip && `${chip.className} / ${chip.textContent}`);
    ok(!!r1.querySelector('.li-star .draft-del'), '⭐ 星标位改成了删除按钮（不是星标）', r1.querySelector('.li-star').innerHTML);
    ok(r2.querySelector('.li-subject').textContent === '(无主题)', '无主题时有兜底文案', r2.querySelector('.li-subject').textContent);
    // Rows in a normal folder still have a checkbox (negative control)
    clickEl(ctx, '#folder-nav .folder-item[data-folder="inbox"]');
    await ticks(ctx.win, 5);
  }, { counts: COUNTS, draftRows: DRAFT_ROWS, drafts: [DRAFT_FULL] });

  /* ---- D3b the recipient field of list rows is JSON text (measured interface shape) ---- */
  await test('D3b ⭐ 列表接口的 to_emails 是 JSON 文本，收件人必须真的显示出来', async (ctx) => {
    // Drive rendering with the real interface shape (JSON text): if the frontend jsonArr only accepts arrays,
    // this renders as "To (unknown)" / "(no recipient)" -- this defect was confirmed by actual measurement.
    clickEl(ctx, '#folder-nav .folder-item[data-folder="sent"]');
    await ticks(ctx.win, 5);
    const r = el(ctx, '#list .list-item[data-id="sn-1"]');
    ok(!!r, '已发送文件夹渲染出 1 行（前置）');
    ok(r.querySelector('.li-sender').textContent === '致 c@z.com, d@w.com',
      '⭐ 出站行的收件人显示为「致 c@z.com, d@w.com」（不是「致 (未知)」）', r.querySelector('.li-sender').textContent);
    ok(evalIn(ctx, `jsonArr('["a@x.com"]').join(',')`) === 'a@x.com', 'jsonArr 能吃 JSON 文本');
    ok(evalIn(ctx, `jsonArr(['a@x.com']).join(',')`) === 'a@x.com', 'jsonArr 也能吃已解析数组（两种形态都兼容）');
    ok(evalIn(ctx, `Array.isArray(jsonArr('not json')) && jsonArr('not json').length === 0`),
      '解析不出来 -> 空数组（不抛异常、也不返回 null）');
    ok(evalIn(ctx, `Array.isArray(jsonArr(null)) && jsonArr(null).length === 0`), 'null -> 空数组');
    ok(evalIn(ctx, `Array.isArray(jsonArr('')) && jsonArr('').length === 0`), '空串 -> 空数组');
  }, { counts: COUNTS, draftRows: DRAFT_ROWS, drafts: [DRAFT_FULL], sentRows: SENT_ROWS });

  /* ---- D4 click a draft row -> open the composer ---- */
  await test('D4 点草稿行：打开写信弹窗并预填（不是打开详情）', async (ctx) => {
    clickEl(ctx, '#folder-nav .folder-item[data-folder="drafts"]');
    await ticks(ctx.win, 5);
    ctx.stub.calls.length = 0;
    el(ctx, '#list .list-item[data-id="dr-1"]').dispatchEvent(clickEvt(ctx.win));
    await ticks(ctx.win, 6);
    ok(callsTo(ctx, '/api/drafts/dr-1').length === 1, '⭐ 按 id 取回完整草稿', callsTo(ctx, '/api/drafts/dr-1').map((c) => c.method).join(','));
    ok(composerOpen(ctx), '写信弹窗已打开');
    ok(val(ctx, '#f-to') === 'a@x.com, b@y.com', '收件人已预填', val(ctx, '#f-to'));
    ok(val(ctx, '#f-subject') === '写了一半的主题', '主题已预填', val(ctx, '#f-subject'));
    // The rich text editor is a contenteditable div (no .value), so we can only inspect innerHTML
    const richHtml = evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML');
    ok(String(richHtml).indexOf('正文预览') >= 0, '正文已预填（富文本，保留 HTML）', String(richHtml).slice(0, 40));
    ok(evalIn(ctx, 'isRich()') === true, '草稿的 rich=true 被还原成富文本模式', String(evalIn(ctx, 'isRich()')));
    ok(evalIn(ctx, 'state.composing.draftId') === 'dr-1', '⭐ composing.draftId = 草稿 id（继续编辑而不是新建）', String(evalIn(ctx, 'state.composing.draftId')));
    ok(evalIn(ctx, 'state.openId') === null, '没有把草稿当成邮件打开详情（openId 仍为空）', String(evalIn(ctx, 'state.openId')));
  }, { counts: COUNTS, draftRows: DRAFT_ROWS, drafts: [DRAFT_FULL] });

  /* ---- D5 inline delete ---- */
  await test('D5 行内 × 删除草稿：只发 DELETE、不打开弹窗', async (ctx) => {
    clickEl(ctx, '#folder-nav .folder-item[data-folder="drafts"]');
    await ticks(ctx.win, 5);
    ctx.stub.calls.length = 0;
    const del = el(ctx, '#list .list-item[data-id="dr-1"] .draft-del');
    ok(!!del, '删除按钮存在');
    del.dispatchEvent(clickEvt(ctx.win));
    await ticks(ctx.win, 6);
    const hits = callsTo(ctx, '/api/drafts/dr-1');
    ok(hits.length === 1 && hits[0].method === 'DELETE', '⭐ 发出 DELETE /api/drafts/dr-1', hits.map((c) => c.method).join(','));
    ok(!composerOpen(ctx), '⭐ 没有顺带打开写信弹窗（stopPropagation 生效）');
    ok(callsTo(ctx, '/api/counts').length >= 1, '删除后刷新计数（徽标要跟着变）');
    ok(callsTo(ctx, '/api/folders/drafts').length >= 1, '删除后重新拉草稿列表（行要从界面上消失）');
  }, { counts: COUNTS, draftRows: DRAFT_ROWS, drafts: [DRAFT_FULL] });

  /* ---- D6 empty drafts folder ---- */
  await test('D6 草稿箱为空：显示空态文案，不残留旧行', async (ctx) => {
    clickEl(ctx, '#folder-nav .folder-item[data-folder="drafts"]');
    await ticks(ctx.win, 5);
    ok(rows(ctx).length === 0, '列表没有行', String(rows(ctx).length));
    const empty = el(ctx, '#list-empty');
    ok(!empty.classList.contains('hidden'), '空态元素可见');
    ok(/没有/.test(empty.textContent) || /空/.test(empty.textContent), '空态文案可读', JSON.stringify(empty.textContent));
  }, { counts: Object.assign({}, COUNTS, { drafts_total: 0 }), draftRows: [], drafts: [] });

  /* ---- D7 sending after restoring a draft must carry draft_id ---- */
  await test('D7 恢复草稿后发送：请求体必须带 draft_id（服务端据此删草稿）', async (ctx) => {
    clickEl(ctx, '#folder-nav .folder-item[data-folder="drafts"]');
    await ticks(ctx.win, 5);
    el(ctx, '#list .list-item[data-id="dr-1"]').dispatchEvent(clickEvt(ctx.win));
    await ticks(ctx.win, 6);
    ok(composerOpen(ctx), '前置：弹窗已打开');
    ctx.stub.calls.length = 0;
    clickEl(ctx, '#composer-send');
    await ticks(ctx.win, 6);
    const posts = ctx.stub.calls.filter((c) => c.method === 'POST' && c.url.startsWith('/api/messages'));
    ok(posts.length === 1, '恰好 1 个发送请求（按 c.url 过滤）', posts.map((c) => c.url).join(',') || '（无）');
    const body = posts.length ? JSON.parse(posts[0].body) : null;
    ok(body && body.draft_id === 'dr-1', '⭐ 请求体带上 draft_id=dr-1（不带的话草稿箱里会留一份已发出去的信）', body && JSON.stringify(body.draft_id));
    ok(!composerOpen(ctx), '发送成功后弹窗关闭');
  }, { counts: COUNTS, draftRows: DRAFT_ROWS, drafts: [DRAFT_FULL] });

  /* ---- D8 search inside the drafts folder: the q param must be included ---- */
  await test('D8 草稿箱内搜索：q 参数进入请求（复用同一套搜索）', async (ctx) => {
    clickEl(ctx, '#folder-nav .folder-item[data-folder="drafts"]');
    await ticks(ctx.win, 5);
    ctx.stub.calls.length = 0;
    const box = el(ctx, '#search-input');
    ok(!!box, '#search-input 输入框存在');
    box.value = '主题';
    box.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    await ticks(ctx.win, 40);
    const hits = callsTo(ctx, '/api/folders/drafts').filter((c) => c.url.includes('q='));
    ok(hits.length >= 1, '⭐ 搜索请求打到 /api/folders/drafts 且带 q', hits.map((c) => c.url).join(' | ') || '（无）');
    info(`最后一次草稿请求：${(callsTo(ctx, '/api/folders/drafts').slice(-1)[0] || {}).url}`);
  }, { counts: COUNTS, draftRows: DRAFT_ROWS, drafts: [DRAFT_FULL] });

  /* ---- summary ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail === undefined ? '' : `  [${f.detail}]`}`);
  console.log(`\n被测版本: ${Object.entries(FINGERPRINT).map(([k, v]) => `${k}=${v.slice(0, 8)}`).join('  ')}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);
  for (const c of liveCtxs) c.close();
  process.exit(fail ? 1 : 0);
})();
