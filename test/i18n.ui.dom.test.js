'use strict';

/* =============================================================================
 * Bilingual UI coverage -- real jsdom + full index.html + i18n.js + app.js
 *
 * The point of this file is the user-visible promise "switch to English and nothing Chinese is left in the interface".
 * It boots the app **in English**, opens every surface (list, detail, composer, backend status, self-check panel,
 * add-domain wizard, inbound alert bar, drafts folder, "load more" footer) and asserts that no Chinese text remains
 * outside the data containers (mail bodies, subjects, sender names, the editor...).
 *
 * Run:
 *   NODE_PATH=<jsdom node_modules> node test/i18n.ui.dom.test.js
 * Exit code: 0 = all passed; 1 = failures (the untranslated strings are printed, so the dictionary can be completed).
 * =========================================================================== */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(process.env.QA_APP_JS || path.join(ROOT, 'public', 'app.js'), 'utf8');
const I18N_JS = fs.readFileSync(process.env.QA_I18N_JS || path.join(ROOT, 'public', 'i18n.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(process.env.QA_INDEX_HTML || path.join(ROOT, 'public', 'index.html'), 'utf8');

const CJK = /[\u4e00-\u9fff]/;
let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { failures.push(msg); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/* ---------------- stub backend (shapes copied from src/index.ts + src/repo.ts) ---------------- */

function makeStub() {
  const calls = [];
  const jsonRes = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });
  const msgRow = (id, subject) => ({
    id,
    direction: 'inbound',
    mailbox: 'a@example.com',
    from_name: 'Alice',
    from_email: 'alice@ext.com',
    subject,
    to_emails: ['a@example.com'],
    received_at: 1700000000,
    read: 0,
    starred: 0,
    status: 'received',
    attachments_count: 0,
    preview: 'preview text',
  });
  const items = [msgRow('m1', 'Hello one'), msgRow('m2', 'Hello two')];
  const usage = {
    d1: { usedBytes: 1024 * 1024, limitBytes: 5 * 1024 * 1024 * 1024, percent: 1 },
    r2: { usedBytes: 2048, limitBytes: 10 * 1024 * 1024 * 1024, percent: 1, objects: 3 },
    inbound: { pending: 2, alerts: 1 },
    resend: { configured: true, day: { used: 5, limit: 100, percent: 5 }, month: { used: 20, limit: 3000, percent: 1 } },
    approximate: true,
  };
  const fetchImpl = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const method = String((init && init.method) || 'GET').toUpperCase();
    calls.push({ url, method });
    // No `mode` field -> the gate keeps the legacy behaviour and the app starts directly (same trick as the other DOM tests).
    if (url.startsWith('/api/setup/status')) return Promise.resolve(jsonRes({}));
    if (url.startsWith('/api/setup/check')) {
      return Promise.resolve(jsonRes({
        ok: true,
        items: [
          { name: '发信 Key · example.com', ok: true, detail: '域名绑定：re_xx…' },
          { name: 'Resend · example.com', ok: true, detail: '已验证，这把 Key 可以使用该域发信' },
          { name: '发信 MX · example.com', ok: true, detail: 'amazonses' },
          { name: 'DKIM · example.com', ok: true, detail: '已生效' },
          { name: 'SPF · example.com', ok: true, detail: 'ok' },
          { name: 'DMARC · example.com', ok: false, warn: true, detail: '未发现 _dmarc（可选，建议补一条 TXT：v=DMARC1; p=none;）' },
          { name: '收信 MX · example.com', ok: true, detail: 'mx.cloudflare.net' },
        ],
        config: {
          domain: 'example.com',
          from_address: 'noreply@example.com',
          from_name: 'Me',
          domains: { 'example.com': { key_source: 'domain', key_masked: 're_***', from_address: 'noreply@example.com' } },
        },
      }));
    }
    if (url.startsWith('/api/account')) {
      return Promise.resolve(jsonRes({
        can_send: true,
        from_name: 'Me',
        from_address: 'noreply@example.com',
        domain: 'example.com',
        domains: ['example.com'],
        senders: ['noreply@example.com'],
      }));
    }
    if (url.startsWith('/api/contacts')) return Promise.resolve(jsonRes({ contacts: [] }));
    if (url.startsWith('/api/domains')) return Promise.resolve(jsonRes({ domains: [], unread: { 'example.com': 7 } }));
    if (url.startsWith('/api/usage')) return Promise.resolve(jsonRes(usage));
    if (url.startsWith('/api/inbound/alerts')) {
      return Promise.resolve(jsonRes({
        alerts: [{ id: 'al1', subject: 'Raw subject', from: 'x@y.com', to: 'a@example.com', received_at: 1700000000 }],
      }));
    }
    if (url.startsWith('/api/mailboxes')) {
      return Promise.resolve(jsonRes({ mailboxes: [{ mailbox: 'a@example.com', inbox_unread: 2, inbox_total: 2, sent_total: 0 }] }));
    }
    if (url.startsWith('/api/counts')) {
      return Promise.resolve(jsonRes({
        inbox_unread: 2, inbox_total: 2, sent_total: 0, starred_total: 0, trash_total: 0, drafts_total: 1,
      }));
    }
    if (/^\/api\/folders\/drafts/.test(url)) {
      return Promise.resolve(jsonRes({
        folder: 'drafts',
        items: [{
          id: 'd1', direction: 'draft', mailbox: 'noreply@example.com', from_name: null, from_email: null,
          subject: 'Draft subject', to_emails: ['bob@ext.com'], preview: 'draft body', received_at: 1700000000,
          read: 1, starred: 0, status: 'draft', attachments_count: 0, thread_count: 1, thread_unread: 0,
        }],
        total: 1,
      }));
    }
    if (/^\/api\/folders\//.test(url)) {
      // Mirrors the real API: `domain=` (present, empty) = nothing ticked = **no rows**.
      const m = /[?&]domain=([^&]*)/.exec(url);
      if (m && m[1] === '') return Promise.resolve(jsonRes({ items: [], total: 0 }));
      // total > items -> the "load more" footer renders too
      return Promise.resolve(jsonRes({ items, total: items.length + 3 }));
    }
    const dm = /^\/api\/messages\/([^/?]+)$/.exec(url);
    if (dm) {
      const row = items.find((x) => x.id === dm[1]) || items[0];
      return Promise.resolve(jsonRes({
        message: Object.assign({}, row, {
          body_text: 'Hello body', body_html: null, thread_id: 't1', cc: [], bcc: [], reply_to: [], delivered_to: 'a@example.com',
        }),
        attachments: [],
        thread: [],
      }));
    }
    return Promise.resolve(jsonRes({ ok: true }));
  };
  return { fetchImpl, calls };
}

/* ---------------- boot ---------------- */

const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }

async function boot() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.log('JSDOM_ERROR:', (e && (e.message || e)) || e, e && e.detail ? String(e.detail).split('\n')[0] : ''));
  vc.on('error', (...a) => console.log('CONSOLE_ERROR:', ...a));
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/', virtualConsole: vc });
  const win = dom.window;
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(win.document, 'hidden', { value: false, configurable: true });
  Object.defineProperty(win, 'innerWidth', { value: 1200, configurable: true });
  try { win.localStorage.setItem('ui-lang', 'en'); } catch { /* ignore */ }
  const stub = makeStub();
  win.fetch = stub.fetchImpl;

  const i18n = win.document.createElement('script');
  i18n.textContent = I18N_JS;
  win.document.body.appendChild(i18n);
  const app = win.document.createElement('script');
  app.textContent = APP_JS;
  win.document.body.appendChild(app);

  let ready = false;
  for (let i = 0; i < 600; i++) {
    let key = null;
    let loading = true;
    try {
      key = win.eval('typeof state === "object" ? state.itemsKey : null');
      loading = win.eval('typeof state === "object" ? !!state.loading : true');
    } catch { /* not ready */ }
    if (win.document.querySelector('#folder-nav').children.length && key !== null && !loading) { ready = true; break; }
    await tick(win);
  }
  if (!ready) throw new Error('init() did not settle');
  // tick the only domain so the list has rows
  win.eval('toggleDomain("example.com", true)');
  await ticks(win, 8);
  win.eval('prefetchGen++; prefetchActive = null;');
  return { dom, win, doc: win.document, stub };
}

/* ---------------- helpers ---------------- */

const DATA_SEL = '.mail-body,.li-sender,.li-subject,.li-preview,.li-time,.li-thread-badge,.li-attach,.who-name,.who-email,.ia-subject,.env-avatar,.li-avatar,#att-preview-body,.rich-editor';

/** Chinese text nodes inside `root` that are **not** user data (mail content) and not marked data-no-i18n. */
function cjkTexts(root) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.nodeType === 3) {
      const s = String(n.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!s || !CJK.test(s)) return;
      const el = n.parentElement;
      if (el && (el.closest('[data-no-i18n]') || el.closest(DATA_SEL))) return;
      out.push(s);
      return;
    }
    if (n.nodeType !== 1) return;
    if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE' || n.tagName === 'TEXTAREA') return;
    if (n.closest && (n.closest('[data-no-i18n]') || n.closest(DATA_SEL))) return;
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out;
}

function cjkAttrs(root) {
  const out = [];
  const attrs = ['placeholder', 'title', 'aria-label', 'alt'];
  for (const el of root.querySelectorAll('*')) {
    if (el.closest('[data-no-i18n]') || el.closest(DATA_SEL)) continue;
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v && CJK.test(v)) out.push(`${el.tagName.toLowerCase()}[${a}]=${v}`);
    }
  }
  return out;
}

function report(label, root, ctx) {
  const bad = cjkTexts(root).concat(cjkAttrs(root));
  ok(bad.length === 0, `⭐ ${label} 没有中文残留`, JSON.stringify(bad.slice(0, 12)));
  return bad;
}

/* ---------------- scenarios ---------------- */

(async () => {
  console.log('i18n 覆盖：英文模式下逐屏检查中文残留');

  const ctx = await boot();
  const { win, doc } = ctx;
  const el = (sel) => doc.querySelector(sel);
  const click = (node) => node && node.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

  section('U1 顶栏 / 侧栏 / 列表 / 后端状态 / 加载更多 / 收信告警条');
  ok(doc.documentElement.getAttribute('lang') === 'en', '启动即英文', doc.documentElement.getAttribute('lang'));
  report('顶栏', el('#topbar'), ctx);
  report('侧栏', el('#sidebar'), ctx);
  report('列表头部', el('#list-head'), ctx);
  report('后端状态', el('#backend-status'), ctx);
  report('收信告警条', el('#inbound-alerts'), ctx);
  report('加载更多', el('#list-more'), ctx);
  ok(el('#inbound-alerts').textContent.trim().length > 0, '告警条已渲染（否则等于没测）', el('#inbound-alerts').textContent.trim().slice(0, 40));
  ok(el('#backend-status').textContent.trim().length > 0, '后端状态已渲染', el('#backend-status').textContent.trim().slice(0, 40));
  ok(el('#list-more').textContent.trim().length > 0, '加载更多已渲染', el('#list-more').textContent.trim());

  section('U2 详情页（信封 / 动作按钮 / 附件区）');
  click(doc.querySelectorAll('#list .list-item')[0]);
  await ticks(win, 8);
  report('详情页', el('#read-message'), ctx);

  section('U3 写信弹窗（含富文本工具栏 / 合并发送 / 自定义发件人）');
  click(el('#compose-btn'));
  await ticks(win, 6);
  const modal = el('#modal-mask');
  ok(!!modal && !(modal.classList || {}).contains('hidden'), '弹窗已打开', modal && modal.className);
  report('写信弹窗', modal, ctx);

  section('U4 域名自检面板（表格 + 设置区）');
  const badge = doc.querySelector('#domain-bar .domain-status');
  click(badge);
  await ticks(win, 8);
  ok(!!el('#gate-tables'), '自检面板已打开', !!el('#gate-tables'));
  report('自检面板', el('#gate'), ctx);

  section('U5 添加域名向导');
  click(el('#add-domain-btn'));
  await ticks(win, 5);
  report('添加域名向导', el('#gate'), ctx);

  section('U6 草稿箱');
  win.eval('hideGate(); openFolder("drafts")');
  await ticks(win, 6);
  report('草稿箱列表', el('#list-pane'), ctx);

  section('U7 空选择状态（不勾选任何域名）');
  win.eval('openFolder("inbox")'); // back to a folder that honours the domain filter
  await ticks(win, 6);
  win.eval('toggleDomain("example.com", false)');
  for (let i = 0; i < 60 && !/No domain selected/i.test(el('#list-empty').textContent); i++) await ticks(win, 1);
  await ticks(win, 3);
  report('空状态', el('#list-pane'), ctx);
  ok(/No domain selected/i.test(el('#list-empty').textContent), '空状态提示已翻译', el('#list-empty').textContent.trim());

  /* summary of everything still Chinese, regardless of container */
  const all = cjkTexts(doc.body).concat(cjkAttrs(doc.body));
  console.log(`\n剩余中文（整个页面，排除邮件内容）：${all.length}`);
  for (const s of all.slice(0, 60)) console.log('   · ' + s);

  console.log(`\n===== 结果: ${pass} passed, ${failures.length} failed =====`);
  if (failures.length) console.log(`失败项：\n- ${failures.join('\n- ')}`);
  try { ctx.dom.window.close(); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('用例抛出异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
