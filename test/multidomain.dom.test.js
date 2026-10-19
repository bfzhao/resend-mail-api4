'use strict';

/* =============================================================================
 * Multi-domain top-bar filter -- real jsdom + full index.html + full app.js
 *
 * Run:
 *   NODE_PATH=<NODE_PATH> <node.exe> test/multidomain.dom.test.js
 *
 * Exit code: 0 = all passed; 1 = some failed.
 *
 * Covers the multi-select redesign:
 *   1) The strip is a divider + one **checkbox chip** per domain (the old "全部域名" button is gone: no checkbox ticked
 *      already means "all domains"), and it is hidden only when no domain is configured;
 *   2) Ticking a domain filters the whole view (folders / counts / mailboxes re-fetched with ?domain=…);
 *   3) Several domains can be ticked at once -> ?domain=a.com,b.com;
 *   4) Negative control: a single-domain deployment shows one chip and nothing ticked.
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
const I18N_JS_PATH = process.env.QA_I18N_JS || path.join(ROOT, 'public', 'i18n.js');

const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const I18N_JS = fs.readFileSync(I18N_JS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');
const FINGERPRINT = {
  'public/app.js': crypto.createHash('md5').update(APP_JS).digest('hex'),
  'public/i18n.js': crypto.createHash('md5').update(I18N_JS).digest('hex'),
  'public/index.html': crypto.createHash('md5').update(INDEX_HTML).digest('hex'),
};

/* ------------------------------ fixtures ------------------------------ */

function msg(id, mailbox) {
  return {
    id,
    direction: 'inbound',
    from_name: '发件人' + id,
    from_email: 'sender@x.com',
    subject: '主题 ' + id,
    to_emails: [mailbox],
    received_at: 1700000000 + id.charCodeAt(0),
    read: 0,
    starred: 0,
    status: 'received',
    attachments_count: 0,
    preview: '预览 ' + id,
    mailbox,
  };
}

function detail(m) {
  return {
    message: Object.assign({}, m, { body_text: '正文 ' + m.id, body_html: null, thread_id: 't-' + m.id, cc: [], bcc: [], reply_to: [] }),
    attachments: [],
    thread: [],
  };
}

/** Per-domain data: the stub answers based on the ?domain= parameter (one domain or a comma-separated list). */
function domainData() {
  const A = msg('A', 'a@example.com');
  const B = msg('B', 'b@other.com');
  const zero = { inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 };
  return {
    perDomain: {
      'example.com': {
        items: [A],
        mailboxes: [{ mailbox: 'a@example.com', inbox_unread: 1, inbox_total: 1, sent_total: 0 }],
        counts: { ...zero, inbox_unread: 1, inbox_total: 1 },
      },
      'other.com': {
        items: [B],
        mailboxes: [{ mailbox: 'b@other.com', inbox_unread: 1, inbox_total: 1, sent_total: 0 }],
        counts: { ...zero, inbox_unread: 1, inbox_total: 1 },
      },
    },
    details: { A: detail(A), B: detail(B) },
  };
}

function makeStub(account, opts = {}) {
  const data = domainData();
  const calls = [];
  const jsonRes = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });
  /**
   * The domain filter as the real API sees it:
   *   · no `domain` parameter at all -> null (every domain)
   *   · `domain=` (present, empty)    -> []  (nothing ticked -> **no rows**)
   *   · `domain=a.com,b.com`         -> ['a.com','b.com']
   */
  const domainsOf = (url) => {
    if (!/[?&]domain=/.test(url)) return null;
    const m = /[?&]domain=([^&]*)/.exec(url);
    return decodeURIComponent(m ? m[1] : '').split(',').map((d) => d.trim()).filter(Boolean);
  };
  const selected = (url) => {
    const ds = domainsOf(url);
    return ds === null ? Object.keys(data.perDomain) : ds;
  };

  const fetchImpl = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const method = String((init && init.method) || 'GET').toUpperCase();
    calls.push({ url, method, body: init && init.body });

    if (url.startsWith('/api/setup/check')) {
      // Automatic domain self-check (runs by itself; there is no UI button any more).
      if (opts.check) return Promise.resolve(jsonRes(opts.check));
      // Mirrors the real backend shape: every row is per domain (`<label> · <domain>`), no global rows.
      return Promise.resolve(jsonRes({
        ok: true,
        items: [
          ...['example.com', 'other.com'].flatMap((d) => [
            { name: `发信 Key · ${d}`, ok: true, detail: '域名绑定：re_xx…' },
            { name: `Resend · ${d}`, ok: true, detail: '已验证' },
            { name: `收信 MX · ${d}`, ok: true, detail: 'mx.cloudflare.net' },
            { name: `发信 MX · ${d}`, ok: true, detail: 'amazonses' },
            { name: `DKIM · ${d}`, ok: true, detail: 'ok' },
            { name: `SPF · ${d}`, ok: true, detail: 'ok' },
            { name: `DMARC · ${d}`, ok: false, detail: '缺失（建议配置）' },
          ]),
        ],
      }));
    }
    if (url.startsWith('/api/account')) return Promise.resolve(jsonRes(account));
    if (url.startsWith('/api/domains')) {
      // Per-domain unread counts for the chip corner badge (99+ above 99).
      return Promise.resolve(jsonRes({
        domains: [],
        unread: opts.domainUnread || { 'example.com': 5, 'other.com': 120 },
      }));
    }
    if (url.startsWith('/api/contacts')) return Promise.resolve(jsonRes({ contacts: [] }));
    if (url.startsWith('/api/mailboxes')) {
      // opts.noMailboxes simulates a freshly added domain: no message history yet, so no mailbox rows at all.
      const list = [];
      if (!opts.noMailboxes) for (const d of selected(url)) list.push(...((data.perDomain[d] || {}).mailboxes || []));
      return Promise.resolve(jsonRes({ mailboxes: list }));
    }
    if (url.startsWith('/api/counts')) {
      const total = { inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 };
      for (const d of selected(url)) {
        const c = (data.perDomain[d] || {}).counts || {};
        for (const k of Object.keys(total)) total[k] += Number(c[k]) || 0;
      }
      return Promise.resolve(jsonRes(total));
    }
    const f = /^\/api\/folders\/([^?]+)/.exec(url);
    if (f) {
      const items = [];
      for (const d of selected(url)) items.push(...((data.perDomain[d] || {}).items || []));
      return Promise.resolve(jsonRes({ items, total: items.length }));
    }
    const dm = /^\/api\/messages\/([^/?]+)$/.exec(url);
    if (dm && method === 'GET') return Promise.resolve(jsonRes(data.details[dm[1]] || { message: null, attachments: [], thread: [] }));
    if (url.startsWith('/api/messages')) return Promise.resolve(jsonRes({ ok: true, items: [], total: 0 }));
    return Promise.resolve(jsonRes({}));
  };

  return { fetchImpl, calls, data };
}

/* ------------------------------ boot ------------------------------ */

const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }
const liveCtxs = [];

async function boot(cfg = {}) {
  const account = cfg.account || {
    can_send: true,
    from_name: 'Me',
    from_address: 'a@example.com',
    domain: 'example.com',
    domains: ['example.com', 'other.com'],
    senders: ['a@example.com', 'b@other.com'],
  };
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(win.document, 'hidden', { value: false, configurable: true });
  Object.defineProperty(win, 'innerWidth', { value: 1024, configurable: true });

  const stub = makeStub(account, cfg.stubOpts || {});
  win.fetch = stub.fetchImpl;

  // Bilingual UI: jsdom does not fetch external scripts, so /i18n.js is injected by hand (same order as index.html:
  // i18n first, then app.js). `cfg.lang` seeds localStorage before i18n.js reads it.
  if (cfg.lang) {
    try { win.localStorage.setItem('ui-lang', cfg.lang); } catch { /* ignore */ }
  }
  if (cfg.i18n !== false) {
    const i18nScript = win.document.createElement('script');
    i18nScript.textContent = I18N_JS;
    win.document.body.appendChild(i18nScript);
  }

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  // Ready = the shell rendered and the first list round trip settled. A **non-empty** list is deliberately not
  // required any more: with no domain ticked the UI shows an empty list (ticking nothing means "show nothing").
  let ready = false;
  for (let i = 0; i < 600; i++) {
    const nav = win.document.querySelector('#folder-nav');
    let key = null;
    let loading = true;
    try {
      key = win.eval('typeof state === "object" ? state.itemsKey : null');
      loading = win.eval('typeof state === "object" ? !!state.loading : true');
    } catch { /* not ready */ }
    if (nav && nav.children.length > 0 && key !== null && !loading) { ready = true; break; }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 5);
  win.eval('prefetchGen++; prefetchActive = null;');

  // Pre-tick domains for the tests that need list rows (the default state is "nothing ticked" = empty list).
  if (Array.isArray(cfg.preselect) && cfg.preselect.length) {
    for (const d of cfg.preselect) win.eval(`toggleDomain(${JSON.stringify(d)}, true)`);
    await ticks(win, 8);
    win.eval('prefetchGen++; prefetchActive = null;');
  }

  const ctx = { dom, win, doc: win.document, stub, close() { try { dom.window.close(); } catch { /* ignore */ } } };
  liveCtxs.push(ctx);
  return ctx;
}

/* ------------------------------ helpers ------------------------------ */

const el = (ctx, sel) => ctx.doc.querySelector(sel);
const evalIn = (ctx, expr) => ctx.win.eval(expr);
/** The selected domains (state.domainSel) joined — the same form the API receives. */
const selectedDomains = (ctx) => evalIn(ctx, 'state.domainSel.join(",")');
const chips = (ctx) => Array.from(ctx.doc.querySelectorAll('#domain-bar .domain-chip'));
const chipOf = (ctx, domain) => chips(ctx).find((c) => c.dataset.domain === domain);
const badgeOf = (ctx, domain) => ctx.doc.querySelector(`#domain-bar .domain-status[data-domain="${domain}"]`);
const healthOf = (ctx, domain) => {
  const b = badgeOf(ctx, domain);
  if (!b) return 'missing';
  return b.classList.contains('ok') ? 'ok' : b.classList.contains('bad') ? 'bad' : 'unknown';
};
const boxOf = (ctx, domain) => (chipOf(ctx, domain) || ctx.doc.createElement('span')).querySelector('input[type="checkbox"]');
const isTicked = (ctx, domain) => {
  const chip = chipOf(ctx, domain);
  return !!chip && chip.classList.contains('on') && !!boxOf(ctx, domain) && boxOf(ctx, domain).checked;
};
function tickDomain(ctx, domain) {
  const box = boxOf(ctx, domain);
  if (!box) throw new Error(`找不到 ${domain} 的 checkbox`);
  box.click(); // a real click flips `checked` and fires `change`
}
function win_eval_hide(ctx) { try { ctx.win.eval('hideGate()'); } catch { /* ignore */ } }
function clickEl(ctx, node) {
  if (!node) throw new Error('clickEl: 元素不存在');
  node.dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
}
const callsMatching = (ctx, re) => ctx.stub.calls.filter((c) => re.test(c.url));

/* ------------------------------ runner ------------------------------ */

let pass = 0;
let fail = 0;

function ok(cond, msg, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${detail === undefined ? '' : `  [${detail}]`}`);
}

async function test(name, fn, bootCfg) {
  console.log(`\n=== ${name} ===`);
  let ctx = null;
  try {
    ctx = await boot(bootCfg || {});
    await fn(ctx);
  } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  } finally {
    for (const c of liveCtxs) { try { await ticks(c.win, 5); } catch { /* ignore */ } }
    for (const c of liveCtxs.splice(0)) c.close();
  }
}

/* ============================== tests ============================== */
(async () => {
  console.log(`被测版本: app.js md5=${FINGERPRINT['public/app.js']}  index.html md5=${FINGERPRINT['public/index.html']}`);

  await test('D1 域名条：分割线 + 每个域一个 checkbox，默认都不勾选 = 什么都不显示', async (ctx) => {
    const bar = el(ctx, '#domain-bar');
    ok(!!bar, '#domain-bar 存在于 DOM');
    ok(!bar.classList.contains('hidden'), '配置了多个域名 -> 域名条可见');
    const labels = chips(ctx).map((c) => (c.querySelector('.domain-name') || c).textContent);
    ok(chips(ctx).length === 2, '共 2 个域名块（每个域一个，无「全部域名」）', JSON.stringify(labels));
    ok(!labels.includes('全部域名'), '⭐「全部域名」按钮已被移除', JSON.stringify(labels));
    ok(labels.includes('example.com') && labels.includes('other.com'), '两个域名都在', JSON.stringify(labels));
    ok(ctx.doc.querySelectorAll('#domain-bar .domain-sep').length === 1, '⭐ 原来的位置换成了一个分割线', ctx.doc.querySelectorAll('#domain-bar .domain-sep').length);
    ok(ctx.doc.querySelectorAll('#domain-bar input[type="checkbox"]').length === 2, '每个域名前都有一个 checkbox');
    ok(!isTicked(ctx, 'example.com') && !isTicked(ctx, 'other.com'), '⭐ 默认都不勾选', JSON.stringify(labels));
    ok(selectedDomains(ctx) === '', '此时过滤条件为空', selectedDomains(ctx));
    // 现在「一个都不勾」= 什么都不显示（不是等价于全选）
    ok(ctx.doc.querySelectorAll('#list .list-item').length === 0, '⭐ 都不勾选 -> 列表为空', ctx.doc.querySelectorAll('#list .list-item').length);
    ok(!/example\.com|other\.com/.test(el(ctx, '#list-title').textContent), '⭐ 标题不出现域名（只要文件夹 + 总数）', el(ctx, '#list-title').textContent.trim());
    ok(/勾选上方的域名/.test(el(ctx, '#list-empty').textContent), '空状态提示怎么显示邮件', el(ctx, '#list-empty').textContent.trim());
    ok(callsMatching(ctx, /[?&]domain=(&|$)/).length >= 1, '⭐ 请求里带空的 domain=（= 不匹配任何域）',
      JSON.stringify(callsMatching(ctx, /folders/).map((c) => c.url).slice(0, 2)));
  });

  await test('D2 勾选一个域：过滤 folders/counts/mailboxes，只显示该域', async (ctx) => {
    ctx.stub.calls.length = 0;
    tickDomain(ctx, 'other.com');
    await ticks(ctx.win, 5);

    ok(selectedDomains(ctx) === 'other.com', '⭐ state.domainSel = other.com', selectedDomains(ctx));
    ok(isTicked(ctx, 'other.com'), 'other.com 的 checkbox 已勾选且 chip 带 .on');
    ok(!isTicked(ctx, 'example.com'), 'example.com 仍未勾选');

    ok(callsMatching(ctx, /^\/api\/folders\/inbox\?.*domain=other\.com/).length >= 1, '列表请求带 domain=other.com', JSON.stringify(callsMatching(ctx, /folders/).map((c) => c.url)));
    ok(callsMatching(ctx, /^\/api\/counts\?.*domain=other\.com/).length >= 1, '计数请求带 domain=other.com', JSON.stringify(callsMatching(ctx, /counts/).map((c) => c.url)));
    ok(callsMatching(ctx, /^\/api\/mailboxes\?.*domain=other\.com/).length >= 1, '邮箱列表请求带 domain=other.com', JSON.stringify(callsMatching(ctx, /mailboxes/).map((c) => c.url)));

    const rows = Array.from(ctx.doc.querySelectorAll('#list .list-item'));
    ok(rows.length === 1, 'other.com 视图只显示 1 封（B）', `rows=${rows.length}`);
  });

  await test('D2c 点域名按钮任意位置都能勾选，且只勾一次（不止 13px 的小方框）', async (ctx) => {
    ctx.stub.calls.length = 0;
    // 1) 点整块 chip（文字区域）
    clickEl(ctx, chipOf(ctx, 'other.com'));
    await ticks(ctx.win, 5);
    ok(selectedDomains(ctx) === 'other.com', '⭐ 点 chip 本体 = 勾选', selectedDomains(ctx));
    ok(isTicked(ctx, 'other.com'), 'checkbox 显示为勾选', ctx.doc.querySelector('#domain-bar .domain-chip.on') !== null);
    // 2) 点域名字样
    clickEl(ctx, chipOf(ctx, 'example.com').querySelector('span'));
    await ticks(ctx.win, 5);
    ok(selectedDomains(ctx) === 'example.com,other.com', '⭐ 点域名字样也能勾选', selectedDomains(ctx));
    // 3) 再点一次同一个 chip -> 取消（不能因为 label 双触发而"点了没反应"）
    clickEl(ctx, chipOf(ctx, 'other.com'));
    await ticks(ctx.win, 5);
    ok(selectedDomains(ctx) === 'example.com', '⭐ 再点一次即取消（每次点击只翻转一次）', selectedDomains(ctx));
    // 4) 直接点 checkbox 本身同样有效
    clickEl(ctx, boxOf(ctx, 'other.com'));
    await ticks(ctx.win, 5);
    ok(selectedDomains(ctx) === 'example.com,other.com', '点 checkbox 方框本身也有效', selectedDomains(ctx));
  });

  await test('D2d 英文模式下勾选域名同样有效', async (ctx) => {
    await ticks(ctx.win, 3);
    clickEl(ctx, chipOf(ctx, 'other.com'));
    await ticks(ctx.win, 5);
    ok(selectedDomains(ctx) === 'other.com', '⭐ 英文界面下点 chip 也勾选', selectedDomains(ctx));
    ok(callsMatching(ctx, /^\/api\/folders\/inbox\?.*domain=other\.com/).length >= 1, '请求带 domain=other.com',
      JSON.stringify(callsMatching(ctx, /folders/).map((c) => c.url)));
  }, { lang: 'en' });

  await test('D3 多选：同时勾选两个域 -> ?domain=a,b，两边的邮件都在', async (ctx) => {
    tickDomain(ctx, 'example.com');
    await ticks(ctx.win, 5);
    ok(selectedDomains(ctx) === 'example.com', '先勾 example.com -> 只筛该域', selectedDomains(ctx));

    ctx.stub.calls.length = 0;
    tickDomain(ctx, 'other.com');
    await ticks(ctx.win, 5);
    ok(selectedDomains(ctx) === 'example.com,other.com', '⭐ 两个域同时勾选（顺序按域名清单，不按点击顺序）', selectedDomains(ctx));
    ok(isTicked(ctx, 'example.com') && isTicked(ctx, 'other.com'), '两个 chip 都是勾选态');

    const folderUrls = callsMatching(ctx, /^\/api\/folders\//).map((c) => c.url);
    ok(folderUrls.some((u) => /domain=example\.com%2Cother\.com|domain=example\.com,other\.com/.test(u)),
      '⭐ 列表请求带多个域（逗号分隔）', JSON.stringify(folderUrls));

    // Both domains ticked again = no filter (same as "all"), and the list shows everything.
    tickDomain(ctx, 'example.com');
    await ticks(ctx.win, 5);
    tickDomain(ctx, 'other.com');
    await ticks(ctx.win, 5);
    ok(selectedDomains(ctx) === '', '⭐ 全部取消勾选 -> 过滤条件为空', selectedDomains(ctx));
    const rowsAll = Array.from(ctx.doc.querySelectorAll('#list .list-item'));
    ok(rowsAll.length === 0, '⭐ 全部取消勾选 -> 列表清空（都不选 = 什么都不显示）', `rows=${rowsAll.length}`);
  });

  await test('D4 仅一个域名：也显示分割线 + checkbox（未勾选）', async (ctx) => {
    for (const c of liveCtxs.splice(0)) c.close();
    const single = await boot({
      account: { can_send: true, from_name: 'Me', from_address: 'a@example.com', domain: 'example.com', domains: ['example.com'], senders: ['a@example.com'] },
    });
    const bar = el(single, '#domain-bar');
    ok(!!bar, '#domain-bar 存在于 DOM');
    ok(!bar.classList.contains('hidden'), '只配置一个域名 -> 域名条仍可见');
    const labels = chips(single).map((c) => (c.querySelector('.domain-name') || c).textContent);
    ok(labels.length === 1 && labels[0] === 'example.com', '只显示一个域名块', JSON.stringify(labels));
    ok(single.doc.querySelectorAll('#domain-bar .domain-sep').length === 1, '分割线仍在');
    ok(!isTicked(single, 'example.com'), '单域默认也不勾选（= 全部）');
  });

  await test('D5 没有任何邮箱（新域还没来信）：左侧地址选择仍然出现', async (ctx) => {
    const fresh = await boot({
      stubOpts: { noMailboxes: true },
      account: { can_send: true, from_name: 'Me', from_address: 'a@example.com', domain: 'example.com', domains: ['example.com'], senders: ['noreply@example.com'] },
    });
    const wrap = el(fresh, '#mailbox-wrap');
    ok(!!wrap, '#mailbox-wrap 存在于 DOM');
    ok(!wrap.classList.contains('hidden'), '⭐ 没有任何邮箱时，左侧的地址选择仍应出现', wrap.className);
    const sel = el(fresh, '#mailbox-select');
    const opts = Array.from(sel.options).map((o) => o.textContent);
    ok(opts.length === 1 && /全部邮箱/.test(opts[0]), '只有一个「全部邮箱」选项', JSON.stringify(opts));
    ok(/未发现账号/.test(opts[0]) && !/暂无邮件/.test(opts[0]), '⭐ 文案是「未发现账号」——这里选的是账号，不是邮件', opts[0]);
    ok(sel.value === '', '默认选中「全部邮箱」', sel.value);
  });

  await test('D5b 只有一个默认发件人时，旁边也有「＋ 自定义」（可设置任意发件地址）', async (ctx) => {
    const fresh = await boot({
      stubOpts: { noMailboxes: true },
      account: { can_send: true, from_name: 'Me', from_address: 'noreply@example.com', domain: 'example.com', domains: ['example.com'], senders: ['noreply@example.com'] },
    });
    clickEl(fresh, el(fresh, '#compose-btn'));
    await ticks(fresh.win, 3);

    const row = el(fresh, '#f-sender-row');
    ok(row && !row.classList.contains('hidden'), '写信时发件人摘要行可见', row && row.className);
    ok(row.classList.contains('sender-solo'), '只有一个发件人（solo：没有下拉箭头）');
    ok(/^noreply@example\.com$/.test(el(fresh, '#f-sender-current').textContent.trim()),
      '默认发件人是 noreply@<域>', el(fresh, '#f-sender-current').textContent);

    const customBtn = el(fresh, '#f-sender-custom');
    ok(!!customBtn && !customBtn.classList.contains('hidden'), '⭐ 旁边的「＋ 自定义」按钮存在且可见', customBtn && customBtn.className);
    ok(/自定义/.test(customBtn.textContent), '按钮文案', customBtn.textContent);

    // 点它 -> 弹输入 -> 发件人换成任意地址
    fresh.win.prompt = () => 'billing@example.com';
    clickEl(fresh, customBtn);
    await ticks(fresh.win, 3);
    ok(el(fresh, '#f-sender-current').textContent.trim() === 'billing@example.com',
      '⭐ 输入后发件人变成自定义地址', el(fresh, '#f-sender-current').textContent);
    ok(!el(fresh, '#f-sender-row').classList.contains('sender-solo'), '有 2 个地址后不再是 solo（出现下拉箭头）');
    ok(el(fresh, '#f-sender-custom').classList.contains('hidden'), '下拉里有入口时，摘要行的按钮收起（不重复）');
  });

  await test('D6 自检不再有按钮：改为自动检查 + 域名按钮右上角状态点', async (ctx) => {
    ok(ctx.doc.querySelectorAll('#domain-bar .domain-check-chip').length === 0, '⭐「⟳ 自检」按钮已移除');
    ok(ctx.doc.querySelectorAll('#domain-bar .domain-status').length === 2, '每个域名按钮右上角都有一个状态点');
    ok(callsMatching(ctx, /^\/api\/setup\/check/).length >= 1, '⭐ 页面加载后自动请求了一次自检', callsMatching(ctx, /setup\/check/).length);
    await ticks(ctx.win, 5);

    // All items ok except DMARC (advisory) -> the badge must still be the blue check.
    ok(healthOf(ctx, 'example.com') === 'ok' && healthOf(ctx, 'other.com') === 'ok',
      '⭐ 正常 -> 蓝色对勾', `${healthOf(ctx, 'example.com')}/${healthOf(ctx, 'other.com')}`);
    ok(badgeOf(ctx, 'example.com').textContent === '✓', '状态点是 ✓', badgeOf(ctx, 'example.com').textContent);
    ok(/自检正常/.test(badgeOf(ctx, 'example.com').title), 'hover 文案说明正常', badgeOf(ctx, 'example.com').title);
    ok(ctx.win.eval("localStorage.getItem('domain-health-v1')") !== null, '结果缓存在本地（刷新后先显示上次状态）');
  });

  await test('D7 检查出问题 -> 红色叹号（只影响出问题的那个域）', async (ctx) => {
    const bad = await boot({
      stubOpts: {
        check: {
          ok: false,
          items: [
            { name: '发信 Key · example.com', ok: true, detail: '域名绑定' },
            { name: '发信 Key · other.com', ok: true, detail: '域名绑定' },
            { name: 'Resend · example.com', ok: true, detail: '已验证' },
            { name: '收信 MX · example.com', ok: true, detail: 'mx.cloudflare.net' },
            { name: 'DKIM · example.com', ok: true, detail: 'ok' },
            // other.com: the sending key cannot see it -> hard failure
            { name: 'Resend · other.com', ok: false, detail: '这把发信 Key 在 Resend 里看不到 other.com' },
            { name: '收信 MX · other.com', ok: true, detail: 'mx.cloudflare.net' },
            { name: 'DKIM · other.com', ok: true, detail: 'ok' },
          ],
        },
      },
    });
    await ticks(bad.win, 5);
    ok(healthOf(bad, 'other.com') === 'bad', '⭐ 出问题的域 -> 红色叹号', healthOf(bad, 'other.com'));
    ok(badgeOf(bad, 'other.com').textContent === '!', '⭐ 状态点是红色叹号（不是容易误解为关闭的 ✕）', badgeOf(bad, 'other.com').textContent);
    ok(healthOf(bad, 'example.com') === 'ok', '另一个正常的域仍是蓝勾（逐域独立）', healthOf(bad, 'example.com'));
    ok(/自检发现问题/.test(badgeOf(bad, 'other.com').title), 'hover 文案指向详情', badgeOf(bad, 'other.com').title);
    ok(/Resend · other\.com/.test(badgeOf(bad, 'other.com').title), '⭐ hover 里直接列出没通过的检查项', badgeOf(bad, 'other.com').title);
  });

  await test('D8 还没有检查结果 -> 灰色问号', async (ctx) => {
    const empty = await boot({
      stubOpts: { check: { ok: true, items: [] } }, // no info yet (e.g. the first check has not finished / failed)
      account: { can_send: true, from_name: 'Me', from_address: 'a@example.com', domain: 'example.com', domains: ['example.com'], senders: ['a@example.com'] },
    });
    await ticks(empty.win, 5);
    ok(healthOf(empty, 'example.com') === 'unknown', '⭐ 没有信息 -> 灰色问号状态', healthOf(empty, 'example.com'));
    ok(badgeOf(empty, 'example.com').textContent === '?', '状态点是 ?', badgeOf(empty, 'example.com').textContent);
    ok(/还没有检查过/.test(badgeOf(empty, 'example.com').title), 'hover 文案说明还没检查', badgeOf(empty, 'example.com').title);
  });

  await test('D9 点状态点：只看当前域 + 表格展示 + 加载动画 + 没有多余说明', async (ctx) => {
    await ticks(ctx.win, 5);
    const before = selectedDomains(ctx);
    badgeOf(ctx, 'other.com').dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    // The panel is built synchronously; the check itself is async, so the spinner is visible right away.
    ok(!!el(ctx, '#gate'), '打开自检浮层', !!el(ctx, '#gate'));
    const loading = el(ctx, '#gate-loading');
    ok(!!loading && !loading.classList.contains('hidden'), '⭐ 检查中显示加载状态', loading && loading.className);
    ok(!!el(ctx, '#gate-loading .spinner'), '⭐ 加载图标是旋转的 spinner 元素');
    ok(/检查中/.test(loading.textContent), '加载文案', loading.textContent.trim());
    await ticks(ctx.win, 3);

    ok(loading.classList.contains('hidden'), '检查完成后加载状态隐藏');
    const tabs = el(ctx, '#gate-tables');
    ok(!!tabs && !tabs.classList.contains('hidden'), '结果区域出现');

    // 1) 表格展示，发信 / 收信分开
    const captions = Array.from(ctx.doc.querySelectorAll('#gate-tables .check-table caption')).map((c) => c.textContent);
    ok(captions.length === 2, '⭐ 两张表：发信 / 收信分开', JSON.stringify(captions));
    ok(/发信（Resend）/.test(captions[0]) && /收信（Cloudflare/.test(captions[1]), '表标题分别是发信 / 收信', JSON.stringify(captions));
    ok(ctx.doc.querySelectorAll('#gate-tables .check-table thead th').length >= 6, '每张表都有表头（项目 / 状态 / 详情）');

    // 2) 只显示当前域名的行（行名已去掉 " · other.com" 后缀）
    const rows = Array.from(ctx.doc.querySelectorAll('#gate-tables tbody tr'));
    const names = rows.map((tr) => tr.querySelector('.ct-name').textContent);
    ok(rows.length > 0, '有结果行', JSON.stringify(names));
    ok(names.every((n) => !n.includes(' · ')), '⭐ 行名不再带域名后缀（标题已说明是哪个域）', JSON.stringify(names));
    ok(names.includes('Resend') && names.includes('DKIM') && names.includes('收信 MX'), '发信与收信的项目都在', JSON.stringify(names));
    ok(!names.some((n) => n.includes('example.com')), '⭐ 不出现别的域名', JSON.stringify(names));

    // 3) 标题写明当前域名；没有底部说明（保持简洁）
    ok(/other\.com/.test(el(ctx, '#gate .gate-title').textContent), '标题写明当前域名', el(ctx, '#gate .gate-title').textContent);
    ok(ctx.doc.querySelectorAll('#gate .gate-note').length === 0, '⭐ 底部说明已移除', ctx.doc.querySelectorAll('#gate .gate-note').length);
    // 4) 设置区仍在（按域绑定 Key）
    ok(!!el(ctx, '#gate-edit'), '仍有「修改 Key / 默认发件人」折叠区');
    ok(/other\.com/.test(el(ctx, '#gate-edit summary').textContent), '设置区标题也指明域名', el(ctx, '#gate-edit summary').textContent);

    ok(selectedDomains(ctx) === before, '⭐ 点状态点不会切换域名勾选', selectedDomains(ctx));
  });

  await test('D10 每个域名一个颜色：域名按钮的圆点 + 列表/详情用该底色', async (ctx) => {
    await ticks(ctx.win, 5);
    // 1) 域名按钮上有颜色圆点，且两个域名的 hue 不同
    const chips = Array.from(ctx.doc.querySelectorAll('#domain-bar .domain-chip'));
    ok(chips.length === 2, '两个域名按钮', JSON.stringify(chips.map((c) => c.dataset.domain)));
    ok(chips.every((c) => !c.querySelector('.dom-dot')), '⭐ 没有单独的颜色圆点（颜色直接是按钮背景）');
    ok(chips.every((c) => c.classList.contains('has-dom-color')), '⭐ 每个域名按钮都带域名色（背景色由 --dom-h 决定）');
    const hueOf = (el) => el.style.getPropertyValue('--dom-h');
    ok(chips.every((c) => /^\d+$/.test(hueOf(c))), '⭐ 圆点用的是该域名的色相', JSON.stringify(chips.map(hueOf)));
    ok(hueOf(chips[0]) !== hueOf(chips[1]), '两个域名的颜色不同', `${hueOf(chips[0])} vs ${hueOf(chips[1])}`);

    // 2) 列表行按「邮件所属域名」上底色（收件：mailbox 的域）
    const rows = Array.from(ctx.doc.querySelectorAll('#list .list-item'));
    ok(rows.length === 2, '两行邮件', rows.length);
    ok(rows.every((r) => r.classList.contains('has-dom-color')), '⭐ 两行都带域名底色标记');
    const rowHues = rows.map(hueOf);
    ok(rowHues.every((h) => /^\d+$/.test(h)), '行上有该域名的色相', JSON.stringify(rowHues));
    ok(rowHues[0] !== rowHues[1], '不同域名的邮件底色不同', `${rowHues[0]} vs ${rowHues[1]}`);
    // 与域名按钮的颜色一致（同一个域 -> 同一个色相）
    const rowDomain = rows.map((r) => (r.textContent.includes('主题 A') ? 'example.com' : 'other.com'));
    const chipHueByDomain = {};
    for (const c of chips) chipHueByDomain[c.dataset.domain] = hueOf(c);
    ok(rowHues.every((h, i) => h === chipHueByDomain[rowDomain[i]]),
      '⭐ 邮件底色与它所属域名的按钮颜色完全一致', JSON.stringify({ rowHues, rowDomain, chipHueByDomain }));

    // 3) 打开邮件后，详情卡片也用同一颜色
    rows[0].dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true }));
    await ticks(ctx.win, 5);
    const envCard = ctx.doc.querySelector('#read-message .mail-envelope');
    ok(!!envCard, '详情卡片已渲染', !!envCard);
    ok(envCard.classList.contains('has-dom-color') && /^\d+$/.test(hueOf(envCard)),
      '⭐ 详情卡片也用该域名的颜色', hueOf(envCard));
    ok(hueOf(envCard) === hueOf(rows[0]), '详情与列表行的颜色一致', `${hueOf(envCard)} vs ${hueOf(rows[0])}`);
  }, { preselect: ['example.com', 'other.com'] });

  /* ------------------------- bilingual UI (i18n) ------------------------- */

  /** All non-empty text nodes under `root` (script/style excluded). */
  const textsOf = (root) => {
    const out = [];
    const walk = (n) => {
      if (!n) return;
      if (n.nodeType === 3) {
        const s = String(n.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (s) out.push(s);
        return;
      }
      if (n.nodeType !== 1) return;
      if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return out;
  };
  const CJK_RE = /[\u4e00-\u9fff]/;
  const cjkOf = (root) => textsOf(root).filter((s) => CJK_RE.test(s));

  await test('E1 英文模式：一键切换后导航 / 工具栏 / 列表外壳全部是英文', async (ctx) => {
    await ticks(ctx.win, 5);
    ok(ctx.doc.documentElement.getAttribute('lang') === 'zh-CN', '默认语言是中文（<html lang>）', ctx.doc.documentElement.getAttribute('lang'));
    ok(el(ctx, '#compose-btn').textContent.trim() === '写信', '默认中文：写信按钮', el(ctx, '#compose-btn').textContent.trim());
    ok(cjkOf(el(ctx, '#folder-nav')).length > 0, '默认中文：侧栏是中文');
    ok(el(ctx, '#lang-btn').textContent.trim() === 'EN', '⭐ 语言按钮显示 EN（点它切到英文）', el(ctx, '#lang-btn').textContent.trim());

    // 一键切换
    el(ctx, '#lang-btn').dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true }));
    await ticks(ctx.win, 3);

    ok(ctx.doc.documentElement.getAttribute('lang') === 'en', '⭐ 切换后 <html lang="en">', ctx.doc.documentElement.getAttribute('lang'));
    ok(el(ctx, '#compose-btn').textContent.trim() === 'Compose', '⭐ 写信 -> Compose', el(ctx, '#compose-btn').textContent.trim());
    ok(el(ctx, '#lang-btn').textContent.trim() === '中文', '⭐ 按钮变成「中文」（点它切回去）', el(ctx, '#lang-btn').textContent.trim());
    ok(cjkOf(el(ctx, '#folder-nav')).length === 0, '⭐ 侧栏没有中文了', JSON.stringify(cjkOf(el(ctx, '#folder-nav'))));
    const navTexts = textsOf(el(ctx, '#folder-nav'));
    ok(navTexts.some((s) => /Inbox/.test(s)) && navTexts.some((s) => /Sent/.test(s)),
      '侧栏是 Inbox / Sent 等英文', JSON.stringify(navTexts));
    ok(/Inbox/.test(el(ctx, '#list-title').textContent), '⭐ 列表标题也翻译了（收件箱 -> Inbox）', el(ctx, '#list-title').textContent.trim());
    ok(el(ctx, '#select-all-wrap span').textContent.trim() === 'Select page', '全选按钮英文', el(ctx, '#select-all-wrap span').textContent.trim());
    ok(el(ctx, '#search-input').getAttribute('placeholder') === 'Search mail…', '⭐ 搜索框 placeholder 英文',
      el(ctx, '#search-input').getAttribute('placeholder'));
    ok(cjkOf(el(ctx, '#list-empty')).length === 0, '空列表 / 加载提示是英文', el(ctx, '#list-empty').textContent.trim());
    const mbOpts = Array.from(ctx.doc.querySelectorAll('#mailbox-select option')).map((o) => o.textContent.trim());
    ok(mbOpts.some((s) => /All mailboxes/.test(s)) && cjkOf(el(ctx, '#mailbox-wrap')).length === 0,
      '⭐ 收件地址下拉英文', JSON.stringify(mbOpts));
    // 顶栏唯一的「中文」是语言按钮本身（data-no-i18n，故意不翻译）
    const topbarCjk = cjkOf(el(ctx, '#topbar')).filter((s) => !/^(中文|EN)$/.test(s));
    ok(topbarCjk.length === 0, '顶栏没有中文残留（语言按钮除外）', JSON.stringify(topbarCjk));
    ok(el(ctx, '#domain-bar').getAttribute('aria-label') === 'Domain filter (multi-select)',
      '域名筛选的 aria-label 也翻译了', el(ctx, '#domain-bar').getAttribute('aria-label'));
    ok(ctx.win.localStorage.getItem('ui-lang') === 'en', '⭐ 选择被记住（localStorage）', ctx.win.localStorage.getItem('ui-lang'));
  });

  await test('E2 英文模式（刷新后仍生效）：邮件内容不被翻译，界面元素是英文', async (ctx) => {
    await ticks(ctx.win, 5);
    ok(ctx.doc.documentElement.getAttribute('lang') === 'en', '⭐ 记住的选择在启动时就生效', ctx.doc.documentElement.getAttribute('lang'));
    ok(el(ctx, '#compose-btn').textContent.trim() === 'Compose', '启动即英文', el(ctx, '#compose-btn').textContent.trim());

    const cjkInRows = cjkOf(el(ctx, '#list'));
    ok(cjkInRows.length > 0, '⭐ 列表里的中文主题 / 发件人仍是中文（数据不翻译）', JSON.stringify(cjkInRows.slice(0, 4)));
    ok(cjkInRows.some((s) => s.includes('主题')), '主题原样保留', JSON.stringify(cjkInRows.slice(0, 3)));

    ctx.doc.querySelectorAll('#list .list-item')[0].dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true }));
    await ticks(ctx.win, 6);
    const bodyText = textsOf(el(ctx, '#read-message .mail-body')).join(' ');
    ok(/正文/.test(bodyText), '⭐ 正文保持中文原样', bodyText.slice(0, 40));
    const envTexts = textsOf(el(ctx, '#read-message .mail-envelope'));
    ok(envTexts.some((s) => s === 'Reply') && envTexts.some((s) => s === 'Forward'),
      '⭐ 详情页按钮英文（回复 / 转发）', JSON.stringify(envTexts.slice(0, 10)));
    ok(envTexts.some((s) => s === 'Mark as unread') && envTexts.some((s) => s === 'Delete'),
      '⭐ 其它动作按钮也翻译了', JSON.stringify(envTexts.slice(4, 10)));
    ok(envTexts.some((s) => s === '发件人A'), '⭐ 发件人名字（数据）保持原样', JSON.stringify(envTexts.slice(0, 3)));
    const cnButtons = envTexts.filter((s) => /^(回复|转发|删除|标为未读)$/.test(s));
    ok(cnButtons.length === 0, '信封上没有残留的中文按钮', JSON.stringify(cnButtons));
  }, { lang: 'en', preselect: ['example.com', 'other.com'] });

  await test('E3 切回中文：全部还原（不是二次翻译）', async (ctx) => {
    await ticks(ctx.win, 4);
    ok(el(ctx, '#compose-btn').textContent.trim() === 'Compose', '起点是英文');
    el(ctx, '#lang-btn').dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true }));
    await ticks(ctx.win, 3);
    ok(ctx.doc.documentElement.getAttribute('lang') === 'zh-CN', '切回中文');
    ok(el(ctx, '#compose-btn').textContent.trim() === '写信', '⭐ 按钮恢复中文', el(ctx, '#compose-btn').textContent.trim());
    ok(cjkOf(el(ctx, '#folder-nav')).length > 0, '侧栏恢复中文');
    ok(/收件箱/.test(el(ctx, '#list-title').textContent), '⭐ 列表标题恢复中文（收件箱）', el(ctx, '#list-title').textContent.trim());
    ok(el(ctx, '#search-input').getAttribute('placeholder') === '搜索邮件…', '⭐ placeholder 恢复中文',
      el(ctx, '#search-input').getAttribute('placeholder'));
    ok(ctx.win.localStorage.getItem('ui-lang') === 'zh', '选择被记住（zh）', ctx.win.localStorage.getItem('ui-lang'));
  }, { lang: 'en' });

  await test('D11 右上角是新邮件数字（99+），健康状态标记改到域名后面', async (ctx) => {
    await ticks(ctx.win, 6);
    const counts = chips(ctx).map((c) => {
      const wrap = c.parentElement;
      const n = wrap.querySelector('.domain-count');
      return n ? n.textContent : null;
    });
    ok(counts[0] === '5', '⭐ example.com 右上角显示未读数 5', JSON.stringify(counts));
    ok(counts[1] === '99+', '⭐ other.com 未读 120 -> 显示 99+', JSON.stringify(counts));
    const wrap0 = chips(ctx)[0].parentElement;
    ok(wrap0.querySelector('.domain-count').classList.contains('hidden') === false, '有未读时徽标可见');

    // 健康标记：在 chip 内部、域名文字之后（不再是右上角浮标）
    const chip = chips(ctx)[0];
    const name = chip.querySelector('.domain-name');
    const mark = chip.querySelector('.domain-status');
    ok(!!name && !!mark, '域名 + 健康标记都在 chip 内', !!name && !!mark);
    ok(mark.parentElement === chip && name.parentElement === chip, '两者是同一个 chip 的子元素');
    ok(mark.previousElementSibling === name, '⭐ 健康标记紧跟在域名后面', mark.previousElementSibling && mark.previousElementSibling.className);
    ok(ctx.win.getComputedStyle(mark).position === 'static', '⭐ 健康标记是内联的（不再绝对定位在角落）',
      ctx.win.getComputedStyle(mark).position);

    // 点健康标记：打开自检面板，但不切换勾选
    const before = selectedDomains(ctx);
    clickEl(ctx, mark);
    await ticks(ctx.win, 6);
    ok(!!el(ctx, '#gate-tables'), '⭐ 点健康标记打开自检面板', !!el(ctx, '#gate-tables'));
    ok(selectedDomains(ctx) === before, '⭐ 点健康标记不会切换域名勾选', selectedDomains(ctx));
    win_eval_hide(ctx);
  });

  await test('D12 未读为 0 的域名不显示数字徽标', async (ctx) => {
    await ticks(ctx.win, 6);
    const marks = chips(ctx).map((c) => c.parentElement.querySelector('.domain-count'));
    ok(marks.every((m) => !m || m.classList.contains('hidden')), '⭐ 没有未读时不显示数字', marks.map((m) => m && m.className));
  }, { stubOpts: { domainUnread: {} } });

  console.log(`\n===== 结果: ${pass} passed, ${fail} failed =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试运行异常：', e);
  for (const c of liveCtxs.splice(0)) c.close();
  process.exit(1);
});
