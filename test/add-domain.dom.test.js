'use strict';

/* =============================================================================
 * In-app "add domain" entry -- real jsdom + full index.html + full app.js
 *
 * Run:
 *   NODE_PATH=<NODE_PATH> <node.exe> test/add-domain.dom.test.js
 *
 * Exit code: 0 = all passed; 1 = some failed.
 *
 * Covers:
 *   1) The top bar (top-right) exposes an "add domain" button; clicking it opens the domain wizard in "adding" mode
 *      (title/subject switch, the setup-only "skip" control is gone, the domain field starts empty);
 *   2) Client-side guard: submitting with missing fields shows an error and sends no request;
 *   3) Happy path: the form POSTs /api/setup/domain (with worker_name) and, on success, closes the overlay and
 *      refreshes the account so the domain strip appears with the newly added domain.
 *
 * This file does not modify any source under public/ and src/.
 * ===========================================================================*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const APP_JS_PATH = process.env.QA_APP_JS || path.join(ROOT, 'public', 'app.js');
const INDEX_PATH = process.env.QA_INDEX_HTML || path.join(ROOT, 'public', 'index.html');

const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');
const FINGERPRINT = {
  'public/app.js': crypto.createHash('md5').update(APP_JS).digest('hex'),
  'public/index.html': crypto.createHash('md5').update(INDEX_HTML).digest('hex'),
};

/* ------------------------------ fixtures ------------------------------ */

function msg(id) {
  return {
    id,
    direction: 'inbound',
    from_name: '发件人' + id,
    from_email: 'sender@x.com',
    subject: '主题 ' + id,
    to_emails: ['a@example.com'],
    received_at: 1700000000,
    read: 0,
    starred: 0,
    status: 'received',
    attachments_count: 0,
    preview: '预览',
    mailbox: 'a@example.com',
  };
}

function makeStub() {
  const calls = [];
  const state = { domains: ['example.com'] };
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

    if (url === '/api/setup/domain' && method === 'POST') {
      state.domains = ['example.com', 'new.com'];
      return Promise.resolve(jsonRes({ ok: true, steps: [{ name: '写 DNS', ok: true, detail: 'ok' }] }));
    }
    if (url.startsWith('/api/domains')) {
      return Promise.resolve(jsonRes({
        domains: [{ domain: 'example.com', from_address: 'noreply@example.com', from_name: 'Me', zone_id: 'zone-example' }],
        unread: {},
      }));
    }
    if (url.startsWith('/api/account')) {
      return Promise.resolve(jsonRes({ can_send: true, from_name: 'Me', from_address: 'a@example.com', domain: 'example.com', domains: state.domains }));
    }
    if (url.startsWith('/api/mailboxes')) return Promise.resolve(jsonRes({ mailboxes: [] }));
    if (url.startsWith('/api/counts')) return Promise.resolve(jsonRes({ inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 }));
    if (url.startsWith('/api/inbound')) return Promise.resolve(jsonRes({ alerts: [] }));
    if (url.startsWith('/api/backend') || url.startsWith('/api/status')) return Promise.resolve(jsonRes({}));
    const f = /^\/api\/folders\//.test(url);
    if (f) return Promise.resolve(jsonRes({ items: [msg('A')], total: 1 }));
    const dm = /^\/api\/messages\/([^/?]+)$/.exec(url);
    if (dm && method === 'GET') return Promise.resolve(jsonRes({ message: null, attachments: [], thread: [] }));
    if (url.startsWith('/api/messages')) return Promise.resolve(jsonRes({ ok: true, items: [], total: 0 }));
    return Promise.resolve(jsonRes({}));
  };

  return { fetchImpl, calls, state };
}

/* ------------------------------ boot ------------------------------ */

const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }
const liveCtxs = [];

async function boot() {
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(win.document, 'hidden', { value: false, configurable: true });
  Object.defineProperty(win, 'innerWidth', { value: 1024, configurable: true });

  const stub = makeStub();
  win.fetch = stub.fetchImpl;

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  let ready = false;
  for (let i = 0; i < 600; i++) {
    const nav = win.document.querySelector('#folder-nav');
    let doms = null;
    try {
      doms = win.eval('typeof state === "object" ? state.domains : null');
    } catch { /* not ready */ }
    if (nav && nav.children.length > 0 && Array.isArray(doms) && doms.length > 0) { ready = true; break; }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 5);
  try { win.eval('prefetchGen++; prefetchActive = null;'); } catch { /* ignore */ }

  const ctx = { dom, win, doc: win.document, stub, close() { try { dom.window.close(); } catch { /* ignore */ } } };
  liveCtxs.push(ctx);
  return ctx;
}

/* ------------------------------ helpers ------------------------------ */

const el = (ctx, sel) => ctx.doc.querySelector(sel);
function clickEl(ctx, node) {
  node.dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
}
const callsMatching = (ctx, re) => ctx.stub.calls.filter((c) => re.test(c.url));
const gate = (ctx) => el(ctx, '#gate');
const gateTitle = (ctx) => { const t = el(ctx, '#gate .gate-title'); return t ? t.textContent.trim() : null; };

/* ------------------------------ runner ------------------------------ */

let currentTest = '(boot)';
let pass = 0;
let fail = 0;

function ok(cond, msg, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${detail === undefined ? '' : `  [${detail}]`}`);
}

async function test(name, fn) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  let ctx = null;
  try {
    ctx = await boot();
    await fn(ctx);
  } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  } finally {
    for (const c of liveCtxs.splice(0)) c.close();
  }
}

/* ============================== tests ============================== */
(async () => {
  console.log(`被测版本: app.js md5=${FINGERPRINT['public/app.js']}  index.html md5=${FINGERPRINT['public/index.html']}`);

  await test('A1 顶栏「添加域名」入口：点击打开向导（adding 模式）', async (ctx) => {
    const btn = el(ctx, '#add-domain-btn');
    ok(!!btn, '#add-domain-btn 存在于 DOM');
    ok(!gate(ctx), '前置：未打开向导时不注入 #gate（懒创建）');

    clickEl(ctx, btn);
    await ticks(ctx.win, 3);

    ok(!!gate(ctx), '点击后注入 #gate 浮层');
    ok(!gate(ctx).classList.contains('hidden'), '点击后浮层可见');
    ok(gateTitle(ctx) === '添加域名', '标题切换为「添加域名」', gateTitle(ctx));
    ok(!!el(ctx, '#gate-domain'), '存在域名输入框');
    ok(el(ctx, '#gate-domain').value === '', 'adding 模式下域名预填为空（不复用主域）');
    ok(!!el(ctx, '#gate-cancel'), '存在「取消」按钮');
    ok(!el(ctx, '#gate-skip'), '负控制：setup 向导专有的「暂不设置」不应出现在添加模式');
    ok(!el(ctx, '#gate-from') && !el(ctx, '#gate-fromname'), '添加模式不再显示发件地址/显示名（发件人由 composer 派发）');
  });

  await test('A2 客户端守卫：缺字段不发请求', async (ctx) => {
    ctx.stub.calls.length = 0;
    clickEl(ctx, el(ctx, '#add-domain-btn'));
    await ticks(ctx.win, 3);

    clickEl(ctx, el(ctx, '#gate-submit'));
    await ticks(ctx.win, 3);

    ok(/\S/.test(el(ctx, '#gate-error').textContent), '缺字段时给出错误提示', el(ctx, '#gate-error').textContent.trim());
    ok(callsMatching(ctx, /^\/api\/setup\/domain$/).length === 0, '负控制：未发出任何 /api/setup/domain 请求');
    ok(!gate(ctx).classList.contains('hidden'), '校验失败时浮层保持打开');
  });

  await test('A3 提交成功：POST /api/setup/domain（带 worker_name），关闭浮层并刷新域名条', async (ctx) => {
    ctx.stub.calls.length = 0;
    // Before: a single domain -> the list is visible and shows exactly that one domain (no "全部域名" chip yet).
    ok(!el(ctx, '#domain-bar').classList.contains('hidden'), '前置：仅一个域名时域名条也可见');
    const beforeChips = Array.from(ctx.doc.querySelectorAll('#domain-bar .domain-chip')).map((c) => (c.querySelector('.domain-name') || c).textContent);
    ok(beforeChips.length === 1 && beforeChips[0] === 'example.com', '前置：只显示 example.com 一个域名块', JSON.stringify(beforeChips));

    clickEl(ctx, el(ctx, '#add-domain-btn'));
    await ticks(ctx.win, 3);
    el(ctx, '#gate-domain').value = 'new.com';
    el(ctx, '#gate-cf').value = 'cf-token-xyz';
    el(ctx, '#gate-resend').value = 're-key-xyz';
    clickEl(ctx, el(ctx, '#gate-submit'));
    await ticks(ctx.win, 12);

    const posts = callsMatching(ctx, /^\/api\/setup\/domain$/).filter((c) => c.method === 'POST');
    ok(posts.length === 1, '发出一条 POST /api/setup/domain', posts.length);
    const body = posts[0] ? JSON.parse(posts[0].body) : {};
    ok(body.domain === 'new.com', 'body.domain 正确', body.domain);
    ok(body.cf_token === 'cf-token-xyz', 'body.cf_token 正确', body.cf_token);
    ok(body.resend_key === 're-key-xyz', 'body.resend_key 正确', body.resend_key);
    ok('worker_name' in body, 'body 带 worker_name（本机 localhost -> 空串，后端回退 env）', JSON.stringify(body.worker_name));

    ok(gate(ctx).classList.contains('hidden'), '成功后关闭浮层');
    ok(callsMatching(ctx, /^\/api\/account/).length >= 1, '成功后重新拉取 /api/account 刷新域名列表');

    const chips = Array.from(ctx.doc.querySelectorAll('#domain-bar .domain-chip')).map((c) => (c.querySelector('.domain-name') || c).textContent);
    ok(!el(ctx, '#domain-bar').classList.contains('hidden'), '域名条出现（现在有两个域名）', JSON.stringify(chips));
    ok(chips.includes('new.com') && chips.includes('example.com'), '域名条包含新增域名', JSON.stringify(chips));
  });

  await test('A4 一键 Cloudflare 授权：填域名后才激活，并锁定到该域名所在 zone', async (ctx) => {
    ctx.doc.querySelector('#add-domain-btn').dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true }));
    await ticks(ctx.win, 5);

    const link = ctx.doc.querySelector('#cf-auth-open');
    const hint = ctx.doc.querySelector('#cf-zone-hint');
    const domainInput = ctx.doc.querySelector('#gate-domain');
    ok(!!link && !!hint && !!domainInput, '向导里有授权按钮 / 提示 / 域名输入框', !!link && !!hint && !!domainInput);

    // 1) 没填域名：按钮禁用、链接不生效
    ok(link.classList.contains('disabled') && link.getAttribute('aria-disabled') === 'true',
      '⭐ 未填域名时按钮是禁用状态', link.className);
    ok(link.getAttribute('href') === '#', '⭐ 禁用时没有可用链接', link.getAttribute('href'));
    ok(/先在上面填写域名/.test(hint.textContent), '提示说明要先填域名', hint.textContent.trim());
    link.dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    ok(/请先填写域名/.test(ctx.doc.querySelector('#gate-error').textContent), '点了也只会提示先填域名',
      ctx.doc.querySelector('#gate-error').textContent.trim());

    // 2) 填一个还没配置过的新域名：按钮激活，链接 zoneId=all + 提示改成 Include → 该域名
    domainInput.value = 'new-domain.com';
    domainInput.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    await ticks(ctx.win, 2);
    ok(!link.classList.contains('disabled'), '⭐ 填了域名后按钮激活', link.className);
    let qs = new URLSearchParams(link.getAttribute('href').split('?')[1]);
    ok(qs.get('zoneId') === 'all', '未知 zone 时 zoneId=all', qs.get('zoneId'));
    ok(qs.get('accountId') === '*', '带 accountId 参数', qs.get('accountId'));
    ok(new RegExp('Include → new-domain\\.com').test(hint.textContent), '⭐ 提示里写明把 Zone Resources 改成该域名',
      hint.textContent.trim());

    // 3) 填一个已知 zone id 的域名（应用里已配置）：链接直接锁定 zoneId
    domainInput.value = 'example.com';
    domainInput.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    await ticks(ctx.win, 2);
    qs = new URLSearchParams(link.getAttribute('href').split('?')[1]);
    ok(qs.get('zoneId') === 'zone-example', '⭐ 已知域名 -> 链接直接带上该 zone id', qs.get('zoneId'));
    ok(hint.textContent.includes('已按 example.com 所在的 zone 打开'), '提示说明已锁定到该 zone', hint.textContent.trim());

    // 4) 权限清单与手动补一项的说明仍在
    let perms = [];
    try { perms = JSON.parse(qs.get('permissionGroupKeys') || '[]'); } catch { perms = []; }
    const pairs = perms.map((x) => x.key + ':' + x.type).sort();
    ok(pairs.join(',') === 'dns:edit,email_routing_rules:edit,zone:read,zone_settings:edit',
      '⭐ 预选四项权限（Email Routing 那一项 Cloudflare 会忽略，需手动补）', JSON.stringify(pairs));
    const hints = Array.from(ctx.doc.querySelectorAll('.cf-perms-list li')).map((x) => x.textContent).join(' ');
    ok(/Email Routing Rules/.test(hints) && /Add more/.test(hints), '页面说明要手动补 Email Routing Rules',
      hints.replace(/\s+/g, ' ').slice(0, 100));
    ok(!!ctx.doc.querySelector('#gate-cf'), '仍然保留 Token 粘贴框', !!ctx.doc.querySelector('#gate-cf'));
    ok(ctx.win.eval('cfTokenTemplateUrl("example.com")') === link.getAttribute('href'),
      '按钮链接与 cfTokenTemplateUrl(domain) 一致');
  });

  console.log(`\n===== 结果: ${pass} passed, ${fail} failed =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试运行异常：', e);
  for (const c of liveCtxs.splice(0)) c.close();
  process.exit(1);
});
