'use strict';

/* =============================================================================
 * Mobile layout (single column + drawer) -- real jsdom + full index.html + full app.js
 *
 * Run:
 *   NODE_PATH=<NODE_PATH> \
 *     <node.exe> test/mobile-layout.dom.test.js
 *
 * Exit code: 0 = all passed; 1 = some failed.
 *
 * Covers four things:
 *   1) Mobile detection: width breakpoints (375 / 768 / 769 / 1024), matchMedia takes priority,
 *      and falling back to width instead of crashing when matchMedia throws;
 *   2) Single-column view: entering a detail adds .mobile-detail, the back button exits, desktop **never** adds this class;
 *   3) Drawer: hamburger toggle, mask close, Esc layering, auto-collapse on folder switch / opening the composer,
 *      and clearing .is-mobile / .drawer-open when resizing from mobile back to desktop;
 *   4) Static rule layer: breakpoints consistent on both sides (app.js's MOBILE_MAX_W <-> app.css's max-width),
 *      desktop hides mobile controls, safe area, 100dvh, iOS focus-zoom prevention, touch targets >=44px.
 *
 * ⚠️ jsdom does no layout computation: **visual results** like `.mobile-detail` making `#list-pane { display:none }`
 * can't be verified in this suite (no browser automation locally). So:
 *   - the behavior layer only asserts "#app's state classes + the truth value state.openId";
 *   - the visual layer falls back to static checks on "does the CSS rule exist";
 *   - real-device feel is listed in the handoff notes' "needs manual confirmation" section, not pretended to be tested here.
 *
 * This file does not modify any source under public/ and src/.
 * ===========================================================================*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
// QA_APP_JS / QA_APP_CSS are only for "mutation verification": point to hand-crafted defective versions (kept outside the repo).
const APP_JS_PATH = process.env.QA_APP_JS || path.join(ROOT, 'public', 'app.js');
const APP_CSS_PATH = process.env.QA_APP_CSS || path.join(ROOT, 'public', 'app.css');
// QA_INDEX_HTML is only for "mutation verification": points to a hand-crafted defective index.html (the variant lives outside the repo).
// Without this hook, the HTML variant would "run the repo's original file while thinking it ran the variant" -> the variant is never caught (false negative).
const INDEX_PATH = process.env.QA_INDEX_HTML || path.join(ROOT, 'public', 'index.html');

const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const APP_CSS = fs.readFileSync(APP_CSS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');

const FINGERPRINT = {
  'public/app.js': crypto.createHash('md5').update(APP_JS).digest('hex'),
  'public/app.css': crypto.createHash('md5').update(APP_CSS).digest('hex'),
  'public/index.html': crypto.createHash('md5').update(INDEX_HTML).digest('hex'),
};

/* ---------------------------------------------------------------------------
 * Fixtures
 * -------------------------------------------------------------------------*/

function msg(id, read, extra = {}) {
  return Object.assign({
    id,
    direction: 'inbound',
    from_name: '发件人' + id,
    from_email: id.toLowerCase() + '@x.com',
    subject: '主题 ' + id,
    to_emails: ['me@x.com'],
    received_at: 1700000000 + id.charCodeAt(0),
    read,
    starred: 0,
    status: 'received',
    attachments_count: 0,
    preview: '预览 ' + id,
    mailbox: 'alpha@x.com',
  }, extra);
}

function detail(m, read) {
  return {
    message: Object.assign({}, m, {
      read,
      body_text: '正文 ' + m.id,
      body_html: null,
      thread_id: 't-' + m.id,
      cc: [],
      bcc: [],
      reply_to: [],
      mailbox: m.mailbox || 'alpha@x.com',
    }),
    attachments: [],
    thread: [],
  };
}

/** The first item C is read: init()'s maybeAutoOpen() auto-opens the first item, used to block A/B's unread state. */
function fixture() {
  const C = msg('C', 1);
  const A = msg('A', 0);
  const B = msg('B', 1);
  const S1 = msg('S1', 1, { direction: 'outbound', status: 'sent' });
  return {
    mailboxes: [{ mailbox: 'alpha@x.com', inbox_unread: 1, inbox_total: 3, sent_total: 1 }],
    folders: {
      inbox: { items: [C, A, B], total: 3 },
      sent: { items: [S1], total: 1 },
      starred: { items: [], total: 0 },
      trash: { items: [], total: 0 },
    },
    messages: { C: detail(C, 1), A: detail(A, 1), B: detail(B, 1), S1: detail(S1, 1) },
    counts: { inbox_unread: 1, inbox_total: 3, sent_total: 1, starred_total: 0, trash_total: 0 },
  };
}

/* ---------------------------------------------------------------------------
 * fetch stub
 * -------------------------------------------------------------------------*/
function makeStub(fx) {
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
    if (url.startsWith('/api/contacts')) return Promise.resolve(jsonRes({ contacts: [] }));
    if (url.startsWith('/api/mailboxes')) return Promise.resolve(jsonRes({ mailboxes: fx.mailboxes }));
    if (url.startsWith('/api/counts')) return Promise.resolve(jsonRes(fx.counts));
    const m = /^\/api\/folders\/([^?]+)/.exec(url);
    if (m) {
      const f = fx.folders[m[1]] || { items: [], total: 0 };
      return Promise.resolve(jsonRes({ items: f.items, total: f.total }));
    }
    const d = /^\/api\/messages\/([^/?]+)$/.exec(url);
    if (d && method === 'GET') {
      return Promise.resolve(jsonRes(fx.messages[d[1]] || { message: null, attachments: [], thread: [] }));
    }
    if (url.startsWith('/api/messages')) return Promise.resolve(jsonRes({ ok: true, items: [], total: 0 }));
    return Promise.resolve(jsonRes({}));
  };

  return { fetchImpl, calls };
}

/* ---------------------------------------------------------------------------
 * Boot an application instance that has finished running init()
 * -------------------------------------------------------------------------*/
const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }

/**
 * cfg.width      viewport width (default 1024 = jsdom's native desktop width)
 * cfg.matchMedia inject window.matchMedia (jsdom natively **lacks** this API)
 *
 * All instances are registered in liveCtxs and closed uniformly by test() **after in-flight async has settled** --
 * closing early would let in-flight detail callbacks keep running on a closed window (`document` becomes undefined),
 * and the thrown unhandledRejection would crash the whole suite so it can't even print the summary line.
 */
const liveCtxs = [];

async function boot(cfg = {}) {
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(win.document, 'hidden', { value: false, configurable: true });
  // ⚠️ The width must be set **before** injecting app.js: init() runs syncLayout() once,
  // and afterwards changing the width can only re-align via the resize event (M11 specifically verifies that path).
  Object.defineProperty(win, 'innerWidth', { value: cfg.width === undefined ? 1024 : cfg.width, configurable: true });
  if (cfg.matchMedia) win.matchMedia = cfg.matchMedia;

  const stub = makeStub(fixture());
  win.fetch = stub.fetchImpl; // must be before injecting app.js

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  // Readiness criteria: folder nav has 4 items + list has rows + the first mail was auto-opened + detail settled.
  // The last one can't be omitted: otherwise it stops at the intermediate state "envelope card drawn, body still downloading".
  let ready = false;
  for (let i = 0; i < 600; i++) {
    const nav = win.document.querySelector('#folder-nav');
    const list = win.document.querySelector('#list');
    let openId = null;
    let settled = false;
    try {
      openId = win.eval('typeof state === "object" ? state.openId : null');
      settled = !win.eval('detailPending');
    } catch { /* script not ready yet */ }
    if (nav && nav.children.length > 0 && list && list.children.length > 0 && openId && settled) {
      ready = true; break;
    }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 5);

  // Background body prefetch is time-dependent (starts sequentially sending detail requests 500ms after paintList), making request-count assertions flaky.
  // This suite doesn't verify prefetch, so invalidate it outright. Both gen and active must be cleared; only incrementing gen leaves prefetchActive behind.
  win.eval('prefetchGen++; prefetchActive = null;');

  const ctx = { dom, win, doc: win.document, stub, close() { try { dom.window.close(); } catch { /* ignore */ } } };
  liveCtxs.push(ctx);
  return ctx;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------*/
const evalIn = (ctx, expr) => ctx.win.eval(expr);
const el = (ctx, sel) => ctx.doc.querySelector(sel);
const appClasses = (ctx) => Array.from(el(ctx, '#app').classList);
const hasAppClass = (ctx, cls) => el(ctx, '#app').classList.contains(cls);
const hidden = (ctx, sel) => el(ctx, sel).classList.contains('hidden');
const isMobileNow = (ctx) => evalIn(ctx, 'isMobile()');
const openIdOf = (ctx) => evalIn(ctx, 'state.openId');
const folderOf = (ctx) => evalIn(ctx, 'state.folder');
const drawerFlag = (ctx) => evalIn(ctx, 'drawerOpen');

function clickEl(ctx, node) {
  node.dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function clickSel(ctx, sel) {
  const n = el(ctx, sel);
  if (!n) throw new Error(`找不到元素 ${sel}`);
  clickEl(ctx, n);
}
function rowFor(ctx, id) { return ctx.doc.querySelector(`.list-item[data-id="${id}"]`); }

/** Change the viewport width and dispatch resize -- simulates rotation / split-screen / dragging the desktop window. */
function setWidth(ctx, w) {
  Object.defineProperty(ctx.win, 'innerWidth', { value: w, configurable: true });
  ctx.win.dispatchEvent(new ctx.win.Event('resize'));
}
function pressEsc(ctx) {
  const ev = new ctx.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  ctx.doc.dispatchEvent(ev);
  return ev;
}
const composerOpen = (ctx) => !hidden(ctx, '#modal-mask');
const confirmShown = (ctx) => !hidden(ctx, '#confirm-mask');

/* ---------------------------------------------------------------------------
 * CSS rule-layer assertion helpers
 *
 * Testing the source directly with regex is too fragile (a missing semicolon turns it false-red, see the 6 FAILs on the first run 2026-10-03).
 * ruleHas structures "selector { ... declaration ... }": whitespace and commas are allowed within the selector group,
 * the declaration may appear anywhere in the block, and the trailing semicolon is optional. The declaration part is still passed as a regex fragment.
 * -------------------------------------------------------------------------*/
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function ruleHas(cssText, selectors, decl) {
  const sel = (Array.isArray(selectors) ? selectors : [selectors]).map(escRe).join('\\s*,\\s*');
  // [^{}]* wraps both ends: no nested braces may appear in the block (this project is pure CSS, no nesting)
  return new RegExp(sel + '\\s*\\{[^{}]*' + decl + '\\s*(?:;[^{}]*)?\\}', 's').test(cssText);
}

/* ---------------------------------------------------------------------------
 * Test case runner
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

async function test(name, fn) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  let ctx = null;
  try {
    ctx = await boot(); // default desktop instance (M1/M5/M7/M12 use it directly)
    await fn(ctx);
  } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  } finally {
    // Let in-flight async (detail requests / timers / optimistic render callbacks) settle, then tear down the window.
    // Doing it the other way lets callbacks run on a closed window (document becomes undefined) and throw unhandledRejection,
    // and the whole suite can't even print the summary line.
    for (const c of liveCtxs) {
      try { await ticks(c.win, 5); } catch { /* window already unusable, ignore */ }
    }
    for (const c of liveCtxs.splice(0)) c.close();
  }
}

/* =============================================================================
 * Test cases
 * ===========================================================================*/
(async () => {
  console.log(`被测版本: app.js md5=${FINGERPRINT['public/app.js']}  app.css md5=${FINGERPRINT['public/app.css']}  index.html md5=${FINGERPRINT['public/index.html']}`);
  console.log(`被测文件: ${APP_JS_PATH}${process.env.QA_APP_JS ? '  ← QA_APP_JS 变异体' : ''}`);
  console.log(`被测样式: ${APP_CSS_PATH}${process.env.QA_APP_CSS ? '  ← QA_APP_CSS 变异体' : ''}`);

  /* ---- M0 environment self-check + negative control group ---- */
  await test('M0 环境自检（harness 可信度）与桌面端负控制组', async (ctx) => {
    ok(typeof ctx.win.isMobile === 'function', 'app.js 已注入且 isMobile 为全局函数');
    ok(typeof ctx.win.syncLayout === 'function', 'syncLayout 为全局函数（唯一收敛点）');

    // These two are **preconditions** rather than product assertions: once jsdom implements matchMedia,
    // the "fall back to innerWidth" cases below no longer cover the real path and must be re-reviewed.
    ok(typeof ctx.win.matchMedia === 'undefined', 'jsdom 原生无 matchMedia（回退路径才有意义）', typeof ctx.win.matchMedia);
    ok('ontouchstart' in ctx.win === true, 'jsdom 里 ontouchstart 存在（所以绝不能用触摸能力判移动端）', true);

    ok(ctx.win.innerWidth === 1024, 'jsdom 默认视口 1024（桌面端基线）', ctx.win.innerWidth);
    ok(hasAppClass(ctx, 'is-mobile') === false, '负控制组：桌面宽度下不得有 .is-mobile', JSON.stringify(appClasses(ctx)));
    ok(hasAppClass(ctx, 'drawer-open') === false, '负控制组：桌面宽度下不得有 .drawer-open');
    ok(hasAppClass(ctx, 'mobile-detail') === false, '负控制组：桌面宽度下不得有 .mobile-detail');

    // The four mobile controls must actually be in the DOM, otherwise all later click assertions no-op
    for (const sel of ['#drawer-btn', '#drawer-mask', '#read-back-btn', '#topbar-compose']) {
      ok(!!el(ctx, sel), `${sel} 存在于 DOM（否则后续点击断言空转）`);
    }
    ok(el(ctx, '#drawer-btn').getAttribute('aria-controls') === 'sidebar', '汉堡按钮用 aria-controls 指向 sidebar', el(ctx, '#drawer-btn').getAttribute('aria-controls'));
    ok(!!el(ctx, '#drawer-btn').getAttribute('aria-label'), '汉堡按钮有 aria-label', el(ctx, '#drawer-btn').getAttribute('aria-label'));
  });

  /* ---- M1 width breakpoints ---- */
  await test('M1 移动端判定：768 含在内、769 排除（与 CSS max-width 语义对齐）', async (ctx) => {
    setWidth(ctx, 375);
    ok(isMobileNow(ctx) === true, '375（手机竖屏）→ 移动端', isMobileNow(ctx));
    ok(hasAppClass(ctx, 'is-mobile'), '375 → #app 带 .is-mobile');

    setWidth(ctx, 768);
    ok(isMobileNow(ctx) === true, '768（断点本身）→ 移动端（与 CSS max-width 含边界一致）', isMobileNow(ctx));

    setWidth(ctx, 769);
    ok(isMobileNow(ctx) === false, '⭐ 负控制：769（断点外一格）→ 桌面端', isMobileNow(ctx));
    ok(!hasAppClass(ctx, 'is-mobile'), '769 → #app 的 .is-mobile 被摘掉');

    setWidth(ctx, 1024);
    ok(isMobileNow(ctx) === false, '1024 → 桌面端', isMobileNow(ctx));

    setWidth(ctx, 320);
    ok(isMobileNow(ctx) === true, '320（最窄在售机型宽度）→ 移动端', isMobileNow(ctx));
  });

  /* ---- M2 matchMedia takes priority ---- */
  await test('M2 matchMedia 优先于 innerWidth（真机旋转 / 分屏靠它）', async (ctx) => {
    // Use an independent boot: matchMedia must be in place before injecting app.js (init reads it once)
    const queries = [];
    const c2 = await boot({
      width: 1024, // intentionally give a "wide" innerWidth
      matchMedia: (q) => { queries.push(q); return { matches: true }; },
    });
    ok(isMobileNow(c2) === true, '⭐ matchMedia 说窄、innerWidth 说宽 → 按 matchMedia 判为移动端', `innerWidth=${c2.win.innerWidth}`);
    ok(hasAppClass(c2, 'is-mobile'), 'matchMedia 命中时 init() 就已把 .is-mobile 加上（不是等 resize）');
    ok(queries.length > 0 && queries[0] === '(max-width: 768px)', '查询串与断点一致（否则 matchMedia 与 CSS 会各说各话）', JSON.stringify(queries[0]));

    const c3 = await boot({ width: 375, matchMedia: () => ({ matches: false }) });
    ok(isMobileNow(c3) === false, '⭐ 负控制：matchMedia 说宽、innerWidth 说窄 → 仍按 matchMedia 判为桌面端', `innerWidth=${c3.win.innerWidth}`);
    ok(!hasAppClass(c3, 'is-mobile'), 'matchMedia 未命中时不加 .is-mobile');
  });

  /* ---- M3 don't crash when matchMedia is unavailable ---- */
  await test('M3 matchMedia 存在但抛异常 → 回退到宽度判断（不把 init 打挂）', async (ctx) => {
    const c2 = await boot({ width: 375, matchMedia: () => { throw new Error('boom'); } });
    ok(typeof c2.win.matchMedia === 'function', '前置：matchMedia 确实被桩成会抛异常的函数');
    ok(isMobileNow(c2) === true, '⭐ 抛异常时回退到 innerWidth=375 → 移动端（不是崩溃 / 不是恒 false）', isMobileNow(c2));
    ok(c2.doc.querySelector('#folder-nav').children.length === 5, 'init() 未被异常打断（导航仍渲染完整：收件箱/草稿/星标/已发送/已删除）');
  });

  /* ---- M4 single column: enter detail / exit with back ---- */
  await test('M4 单栏视图：进详情加 .mobile-detail、返回按钮退出、可再次进入', async (ctx) => {
    const c = await boot({ width: 375 });
    ok(openIdOf(c) === 'C', '前置：init 自动打开了首封（否则本用例空转）', openIdOf(c));
    ok(hasAppClass(c, 'mobile-detail'), '⭐ 移动端打开详情 → #app 带 .mobile-detail（CSS 据此藏掉列表）');
    ok(!hidden(c, '#read-message'), '详情文章已显示');
    ok(hidden(c, '#read-placeholder'), '占位已隐藏');

    clickSel(c, '#read-back-btn');
    ok(openIdOf(c) === null, '⭐ 返回按钮把 state.openId 置空（真值来源，不只看 DOM 类）', openIdOf(c));
    ok(!hasAppClass(c, 'mobile-detail'), '⭐ 返回后 .mobile-detail 被摘掉（列表重新占满）');
    ok(hidden(c, '#read-message') && !hidden(c, '#read-placeholder'), '阅读区回到占位态');

    clickEl(c, rowFor(c, 'A'));
    await ticks(c.win, 5); // wait for the detail to settle, so callbacks don't run outside the case
    ok(openIdOf(c) === 'A', '再点列表行能重新打开（不是一次性的）', openIdOf(c));
    ok(hasAppClass(c, 'mobile-detail'), '⭐ 重新进入详情后 .mobile-detail 回来');

    info('jsdom 不做布局计算：#list-pane 的 display:none 效果验不到，由 M12 的 CSS 规则断言兜底');
  });

  /* ---- M5 desktop must not enter single column ---- */
  await test('M5 负控制：桌面端即使打开了详情也不得加 .mobile-detail', async (ctx) => {
    // ctx is the 1024 desktop instance
    ok(openIdOf(ctx) === 'C', '前置：桌面端也确实打开了详情（否则本用例空转）', openIdOf(ctx));
    ok(!hidden(ctx, '#read-message'), '前置：详情内容已渲染');
    ok(hasAppClass(ctx, 'mobile-detail') === false, '⭐ 桌面端不得加 .mobile-detail（否则列表会被藏掉、变成单栏）', JSON.stringify(appClasses(ctx)));
    ok(hasAppClass(ctx, 'is-mobile') === false, '桌面端不得加 .is-mobile');
  });

  /* ---- M6 drawer open/close ---- */
  await test('M6 抽屉：汉堡开合、遮罩关闭', async (ctx) => {
    const c = await boot({ width: 375 });
    ok(!hasAppClass(c, 'drawer-open'), '初始抽屉是收起的');
    ok(drawerFlag(c) === false, '初始真值 drawerOpen=false');

    clickSel(c, '#drawer-btn');
    ok(hasAppClass(c, 'drawer-open'), '⭐ 点汉堡 → .drawer-open');
    ok(drawerFlag(c) === true, '真值 drawerOpen=true');

    clickSel(c, '#drawer-btn');
    ok(!hasAppClass(c, 'drawer-open'), '再点汉堡 → 收起（toggle，不是只开不关）');
    ok(drawerFlag(c) === false, '真值回到 false');

    clickSel(c, '#drawer-btn');
    clickSel(c, '#drawer-mask');
    ok(!hasAppClass(c, 'drawer-open'), '⭐ 点遮罩 → 收起抽屉');
    ok(drawerFlag(c) === false, '点遮罩后真值也归零');

    clickSel(c, '#drawer-mask');
    ok(!hasAppClass(c, 'drawer-open'), '负控制：抽屉已收起时再点遮罩不得反把它打开');
  });

  /* ---- M7 clicking the hamburger on desktop must not change the layout ---- */
  await test('M7 负控制：桌面端点汉堡不得出现 .drawer-open', async (ctx) => {
    // On desktop the button is hidden by CSS, but if it's clicked programmatically it must still not change the layout
    clickSel(ctx, '#drawer-btn');
    ok(!hasAppClass(ctx, 'drawer-open'), '⭐ 桌面端点汉堡 → 不得出现 .drawer-open（CSS 规则全在 @media 内）', JSON.stringify(appClasses(ctx)));
    ok(!hasAppClass(ctx, 'is-mobile'), '桌面端仍不是移动端布局');
    ok(el(ctx, '#drawer-mask') !== null, '遮罩节点存在（由 CSS 决定不显示，而不是靠删节点）');
  });

  /* ---- M8 Esc layering ---- */
  await test('M8 Esc：抽屉开着时只收抽屉，不误关写信弹窗、不误弹放弃确认', async (ctx) => {
    const c = await boot({ width: 375 });
    clickSel(c, '#drawer-btn');
    ok(hasAppClass(c, 'drawer-open'), '前置：抽屉已打开');
    const ev = pressEsc(c);
    ok(!hasAppClass(c, 'drawer-open'), '⭐ Esc 收起抽屉');
    ok(ev.defaultPrevented === true, 'Esc 已 preventDefault（不再往下传给弹窗关闭逻辑）', ev.defaultPrevented);
    ok(composerOpen(c) === false, '负控制：没有写信弹窗被顺带打开 / 关闭');
    ok(confirmShown(c) === false, '⭐ 没有误弹「放弃编辑」确认框');
    ok(evalIn(c, 'state.composing') === null, 'state.composing 仍为 null');

    // The drawer and the composer exist at the same time (normal UI can't reach this; closeDrawer in openComposerShell prevents it;
    // constructed forcibly here to verify Esc's layering guard: close the outermost drawer first, keep the composer)
    // ⚠️ The drawer must be **re-opened** first before clicking compose: otherwise the drawer was already closed by the previous Esc,
    //    and the following "the drawer is auto-collapsed when opening the composer" becomes an always-true no-op assertion (exposed by V6 mutation verification).
    clickSel(c, '#drawer-btn');
    ok(hasAppClass(c, 'drawer-open'), '前置：抽屉重新打开（否则下一条断言是空转）');
    clickSel(c, '#compose-btn');
    await ticks(c.win, 5);
    ok(composerOpen(c), '前置：写信弹窗已打开');
    ok(!hasAppClass(c, 'drawer-open'), '开写信弹窗时抽屉被自动收起（openComposerShell 里的 closeDrawer）');
    evalIn(c, 'setDrawer(true)');
    ok(hasAppClass(c, 'drawer-open'), '前置：强行把抽屉打开');
    pressEsc(c);
    ok(!hasAppClass(c, 'drawer-open'), '⭐ 抽屉 + 弹窗同时存在时，Esc 先收抽屉');
    ok(composerOpen(c), '⭐ 写信弹窗**没有**被顺带关掉（层级守卫生效）');
    pressEsc(c);
    await ticks(c.win, 3);
    ok(composerOpen(c) === false, '再按一次 Esc 才关写信弹窗（空表单直接关、不弹确认）');
  });

  /* ---- M9 switching folders collapses the drawer ---- */
  await test('M9 切文件夹：收起抽屉，且确实换了文件夹（不是点了个无效目标）', async (ctx) => {
    const c = await boot({ width: 375 });
    ok(folderOf(c) === 'inbox', '前置：当前在收件箱', folderOf(c));
    clickSel(c, '#drawer-btn');
    ok(hasAppClass(c, 'drawer-open'), '前置：抽屉已打开');

    const target = c.doc.querySelector('.folder-item[data-folder="sent"]');
    ok(!!target, '前置：抽屉里有「已发送」这一项');
    clickEl(c, target);
    await ticks(c.win, 5);
    ok(folderOf(c) === 'sent', '⭐ 确实切到了已发送（否则下面的「收起抽屉」可能是巧合）', folderOf(c));
    ok(!hasAppClass(c, 'drawer-open'), '⭐ 切文件夹后抽屉自动收起（否则它一直挡着刚切出来的列表）');
    ok(!hasAppClass(c, 'mobile-detail'), '切文件夹同时退出了详情视图');
  });

  /* ---- M10 topbar compose entry ---- */
  await test('M10 顶栏写信按钮：能打开弹窗并收起抽屉（侧边栏进了抽屉后仍有一键写信）', async (ctx) => {
    const c = await boot({ width: 375 });
    ok(composerOpen(c) === false, '负控制前置：弹窗初始是关的（否则「能打开」无从谈起）');
    clickSel(c, '#drawer-btn');
    ok(hasAppClass(c, 'drawer-open'), '前置：抽屉已打开');

    clickSel(c, '#topbar-compose');
    await ticks(c.win, 5);
    ok(composerOpen(c), '⭐ 顶栏写信按钮真的打开了弹窗');
    ok(!hasAppClass(c, 'drawer-open'), '⭐ 开弹窗时抽屉被收起（弹窗是全屏的，抽屉必须让位）');
    ok(evalIn(c, 'state.composing') !== null, 'state.composing 已建立');
  });

  /* ---- M11 resize across breakpoints ---- */
  await test('M11 resize：移动端→桌面必须清理 .is-mobile/.drawer-open，再缩回不得自动开抽屉', async (ctx) => {
    const c = await boot({ width: 375 });
    clickSel(c, '#drawer-btn');
    ok(hasAppClass(c, 'is-mobile') && hasAppClass(c, 'drawer-open') && hasAppClass(c, 'mobile-detail'),
      '前置：375 下三个类都在（含详情态）', JSON.stringify(appClasses(c)));

    setWidth(c, 1024);
    await ticks(c.win, 3);
    ok(isMobileNow(c) === false, 'resize 到 1024 → 判为桌面端', isMobileNow(c));
    ok(!hasAppClass(c, 'is-mobile'), '⭐ .is-mobile 被摘掉（抓住「resize 不重新对齐」的缺陷）', JSON.stringify(appClasses(c)));
    ok(!hasAppClass(c, 'drawer-open'), '⭐ .drawer-open 被摘掉');
    ok(drawerFlag(c) === false, '⭐ 真值 drawerOpen 归零（否则缩回移动端时抽屉会莫名开着）');
    ok(!hasAppClass(c, 'mobile-detail'), '.mobile-detail 也被摘掉（openId 非空但已不是移动端）');

    setWidth(c, 375);
    await ticks(c.win, 3);
    ok(isMobileNow(c) === true, '缩回 375 → 又是移动端', isMobileNow(c));
    ok(hasAppClass(c, 'is-mobile'), '.is-mobile 回来');
    ok(!hasAppClass(c, 'drawer-open'), '⭐ 抽屉**不得**自动恢复（用户没重新点汉堡）');
    ok(hasAppClass(c, 'mobile-detail'), '详情态随 openId 一起恢复（仍是单栏看详情）');
  });

  /* ---- M12 static rule layer ---- */
  await test('M12 静态规则层：断点一致、桌面隐藏控件、安全区、100dvh、触摸目标', async (ctx) => {
    // 1) Both sides of the breakpoint must be consistent -- changing one side and forgetting the other is the most common drift in this project
    const mJs = /MOBILE_MAX_W\s*=\s*(\d+)/.exec(APP_JS);
    const mobileSectionAt = APP_CSS.indexOf('Mobile adaptation');
    ok(mobileSectionAt >= 0, 'app.css 里能找到「Mobile adaptation」段落标记（用它定位断点，避免撞上别的媒体查询）', mobileSectionAt);
    const cssMobile = mobileSectionAt >= 0 ? APP_CSS.slice(mobileSectionAt) : '';
    const mCss = /@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)/.exec(cssMobile);
    ok(!!mJs, 'app.js 里能提取到 MOBILE_MAX_W', mJs && mJs[1]);
    ok(!!mCss, 'app.css 移动端段落里能提取到 @media (max-width: Npx)', mCss && mCss[1]);
    ok(mJs && mCss && mJs[1] === mCss[1], '⭐ app.js 的 MOBILE_MAX_W 与 app.css 的断点一致', `js=${mJs && mJs[1]} css=${mCss && mCss[1]}`);
    info(`移动端段落起点=${mobileSectionAt}，段落长度=${cssMobile.length}`);

    // 2) Desktop never shows mobile-only controls (base rule, not inside @media)
    ok(ruleHas(APP_CSS, ['.icon-btn', '#topbar-compose', '#drawer-mask', '#read-back'], 'display:\\s*none'),
      '⭐ 基础规则里把 .icon-btn/#topbar-compose/#drawer-mask/#read-back 设为 display:none（桌面端不显示）');

    // 3) Drawer: off-screen by default + only returns when #app.drawer-open
    ok(ruleHas(cssMobile, '#sidebar', 'transform:\\s*translateX\\(-100%\\)'), '移动端 #sidebar 默认 transform: translateX(-100%)');
    ok(ruleHas(cssMobile, '#app.drawer-open #sidebar', 'transform:\\s*none'), '⭐ 仅 #app.drawer-open 时侧边栏归位');
    ok(ruleHas(cssMobile, '#app.drawer-open #drawer-mask', 'pointer-events:\\s*auto'), '遮罩只在 drawer-open 时接收点击（否则它会吞掉整页点击）');
    ok(ruleHas(cssMobile, '#drawer-mask', 'pointer-events:\\s*none'), '遮罩默认不接收点击（抽屉收起时不能挡住列表）');

    // 4) Single column
    ok(ruleHas(cssMobile, '#app.mobile-detail #list-pane', 'display:\\s*none'), '⭐ .mobile-detail 时藏掉列表');
    ok(ruleHas(cssMobile, '#app.mobile-detail #read-pane', 'display:\\s*block'), '.mobile-detail 时显示详情');
    ok(ruleHas(cssMobile, '#read-pane', 'display:\\s*none'), '移动端默认不显示详情栏（未选中邮件时列表占满）');

    // 5) Height: dvh follows the address bar, keep a vh fallback
    ok(ruleHas(APP_CSS, '#app', 'height:\\s*100vh') && ruleHas(APP_CSS, '#app', 'height:\\s*100dvh'),
      '⭐ #app 用 100dvh 且保留 100vh 回退（移动端地址栏收放不跳动）');

    // 6) Safe area
    ok(APP_CSS.includes('env(safe-area-inset-top)'), '用到 env(safe-area-inset-top)');
    ok(APP_CSS.includes('env(safe-area-inset-bottom)'), '用到 env(safe-area-inset-bottom)');
    ok(/<meta\s+name="viewport"[^>]*viewport-fit=cover/.test(INDEX_HTML), '⭐ index.html 的 viewport 带 viewport-fit=cover（否则 env() 恒为 0）');
    ok(/<meta\s+name="viewport"[^>]*width=device-width/.test(INDEX_HTML), 'viewport 带 width=device-width');

    // 7) iOS details: no font scaling in landscape + 16px inputs to prevent focus zoom
    ok(/text-size-adjust:\s*100%/.test(APP_CSS), 'html 设了 text-size-adjust:100%（iOS 横屏不自动放大正文）');
    ok(/-webkit-text-size-adjust:\s*100%/.test(APP_CSS), '带 -webkit- 前缀版本（老 iOS Safari 只认前缀）');
    ok(ruleHas(cssMobile, '#search-input', 'font-size:\\s*16px'), '⭐ 移动端搜索框 font-size:16px（<16px 在 iOS 上聚焦会放大整页）');
    ok(ruleHas(cssMobile, ['#composer input[type="text"]', '#composer select', '#composer textarea', '.rich-editor'], 'font-size:\\s*16px'),
      '⭐ 写信弹窗的输入框 / 下拉 / 正文 / 富文本编辑器也都是 16px');

    // 8) Touch targets >=44px
    ok(ruleHas(cssMobile, '.icon-btn', 'width:\\s*44px') && ruleHas(cssMobile, '.icon-btn', 'height:\\s*44px'),
      '汉堡按钮 44×44（触摸目标下限）');
    ok(ruleHas(cssMobile, '#read-back .btn', 'min-height:\\s*44px'), '「返回列表」按钮 min-height 44px');
    ok(ruleHas(cssMobile, '.composer-actions .btn', 'min-height:\\s*44px'), '写信弹窗的发送/取消 min-height 44px');
    ok(ruleHas(cssMobile, '.folder-item', 'padding:\\s*13px\\s+16px'), '文件夹项加大了内边距（窄屏可点区域）');
    ok(ruleHas(cssMobile, '#topbar-compose', 'min-height:\\s*44px'), '顶栏写信按钮 min-height 44px');

    // 9) Composer full-screen + internal scroll + bottom buttons pinned
    ok(ruleHas(cssMobile, '#modal-mask', 'align-items:\\s*stretch'), '移动端 #modal-mask 拉伸（弹窗铺满）');
    ok(ruleHas(cssMobile, '#composer', 'width:\\s*100%') && ruleHas(cssMobile, '#composer', 'height:\\s*100%'), '写信弹窗占满宽高');
    ok(ruleHas(cssMobile, '#composer', 'overflow-y:\\s*auto'), '写信弹窗内部滚动（不靠整页滚）');
    ok(ruleHas(cssMobile, '.composer-actions', 'position:\\s*sticky'), '⭐ 发送/取消按钮 sticky 在底部（长正文滚到底不用找按钮）');

    // 10) Soft keyboard: cap the autocomplete dropdown height so the keyboard doesn't push it off-screen
    ok(ruleHas(cssMobile, '.addr-suggest', 'max-height:\\s*42vh'), '联想下拉 max-height 42vh（软键盘弹出后仍可用）');

    // 10b) Autocomplete dropdown item font size: 14px is too small to read on phones (user report) -> bump to 16px
    ok(ruleHas(cssMobile, '.addr-suggest-item', 'font-size:\\s*16px'), '⭐ 联想下拉项 font-size:16px（原来 14px 在手机上太小）');
    ok(ruleHas(cssMobile, '.addr-suggest-item', 'padding:\\s*12px\\s+12px'), '联想下拉项加大内边距（行高够 44px 触摸目标）');
    ok(ruleHas(cssMobile, '.addr-suggest-empty', 'font-size:\\s*16px'), '「无匹配」提示同样 16px（与下拉项一致）');

    // 10c) Autocomplete dropdown item layout: vertical arrangement on narrow screens, email on its own line
    //     In horizontal layout the name squeezes the email down to a few characters, and "seeing the full email" is the only thing to confirm while typing.
    ok(ruleHas(cssMobile, '.addr-suggest-item', 'flex-direction:\\s*column'),
      '⭐ 移动端联想项纵向排列（姓名一行、邮箱一行 -> 完整邮箱看得全）');
    ok(ruleHas(cssMobile, '.addr-suggest-item .nm', 'max-width:\\s*100%'), '移动端姓名不再限半宽（让位给完整邮箱）');
    ok(!ruleHas(APP_CSS.slice(0, mobileSectionAt), '.addr-suggest-item', 'flex-direction:\\s*column'),
      '负控制：桌面端联想项不得纵向排列（一行放得下，别把桌面也改成两行）');

    // 10d) Sender summary row: once collapsed it's the only visible sender info, so its font size must not be smaller than the body
    ok(ruleHas(cssMobile, '.sender-toggle', 'font-size:\\s*15px'),
      '⭐ 移动端发件人摘要行 15px（原来继承 .link-btn 的 13px，折叠后看不清用哪个地址发）');

    // 10e) Native select popup list: with the closed state at 16px the list following 16px looks noticeably too big (user report)
    ok(ruleHas(cssMobile, ['#mailbox-select option', '#composer select option'], 'font-size:\\s*14px'),
      '⭐ 移动端原生下拉的列表项单独收回 14px（闭合态仍 16px，不受影响）');
    ok(ruleHas(cssMobile, '#mailbox-select', 'font-size:\\s*16px'),
      '负控制：闭合态的 #mailbox-select 仍保持 16px（别顺手把它也改小了）');
    ok(!ruleHas(APP_CSS.slice(0, mobileSectionAt), '#mailbox-select option', 'font-size:\\s*14px'),
      '负控制：桌面端不给列表项设字号（那边闭合态 13px，列表跟着走即可）');

    // 11) toast lifted off the bottom safe area
    ok(ruleHas(cssMobile, '#toast', 'bottom:\\s*calc\\(20px\\s*\\+\\s*env\\(safe-area-inset-bottom\\)\\)'), 'toast 抬离底部安全区');

    // 12) Negative control: these mobile rules must not appear on desktop (rules must live inside @media)
    ok(!ruleHas(APP_CSS.slice(0, mobileSectionAt), '#app.mobile-detail #list-pane', 'display:\\s*none'),
      '负控制：单栏规则不得出现在移动端段落之外（否则桌面端列表会被藏掉）');

    info('以上为 CSS 规则层校验；真实排版 / 抽屉动画 / 刘海屏观感未渲染验证（本机无浏览器自动化）');
  });

  /* ---- summary ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);

  console.log(`\n被测版本: app.js md5=${FINGERPRINT['public/app.js']}  app.css md5=${FINGERPRINT['public/app.css']}  index.html md5=${FINGERPRINT['public/index.html']}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
