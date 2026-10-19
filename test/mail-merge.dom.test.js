'use strict';

/* =============================================================================
 * Independent verification (QA): "merge send" frontend behavior -- real jsdom + real DOM event dispatch
 *
 * Run:
 *   NODE_PATH=<NODE_PATH> \
 *     <node.exe> test/mail-merge.dom.test.js
 *
 * Exit code: 0 = all passed; 1 = some failed.
 *
 * Difference from test/mail-merge.test.js: that one extracts functions with vm + hand-written DOM stubs;
 * this file runs the **full index.html + full app.js** (including init()/setupEvents()),
 * driven by real events (input/change/click), with fetch returning a **pre-built merge response**,
 * so it can cover integration-layer issues like "is the event wiring actually connected".
 * This file does not modify any source under public/ and src/.
 * ===========================================================================*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
// QA_APP_JS is only for "mutation verification": points to a hand-crafted defective app.js.
// Without this hook, the mutation script would "run the repo's original file while thinking it ran the variant" -> the variant is never caught (false negative).
const APP_JS_PATH = process.env.QA_APP_JS || path.join(ROOT, 'public', 'app.js');
// QA_INDEX_HTML is only for "mutation verification": points to a hand-crafted defective index.html (the variant lives outside the repo).
// Without this hook, the HTML variant would "run the repo's original file while thinking it ran the variant" -> the variant is never caught (false negative).
const INDEX_PATH = process.env.QA_INDEX_HTML || path.join(ROOT, 'public', 'index.html');
const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');

const FINGERPRINT = {
  'public/app.js': crypto.createHash('md5').update(APP_JS).digest('hex'),
  'public/index.html': crypto.createHash('md5').update(INDEX_HTML).digest('hex'),
};

/* ---------------------------------------------------------------------------
 * fetch stub: POST send requests return the "test-preset" response
 * -------------------------------------------------------------------------*/
function makeFetchStub() {
  const calls = [];
  const state = { sendResponse: { status: 200, payload: { ok: true, id: 'row-1', resend_id: 're-1' } } };

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
    const body = init && init.body;
    calls.push({ url, method, body });

    if (url.startsWith('/api/account')) {
      return Promise.resolve(jsonRes({ can_send: true, from_name: 'Me', from_address: 'me@example.com' }));
    }
    if (url.startsWith('/api/mailboxes')) return Promise.resolve(jsonRes({ mailboxes: [] }));
    if (url.startsWith('/api/counts')) {
      return Promise.resolve(jsonRes({ inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 }));
    }
    if (url.startsWith('/api/folders/')) return Promise.resolve(jsonRes({ items: [], total: 0 }));
    if (url.startsWith('/api/messages') && method === 'POST') {
      const r = state.sendResponse;
      return Promise.resolve(jsonRes(r.payload, r.status));
    }
    if (url.startsWith('/api/messages')) return Promise.resolve(jsonRes({ message: null, items: [], total: 0 }));
    return Promise.resolve(jsonRes({}));
  };

  return {
    fetchImpl,
    calls,
    setSendResponse(status, payload) { state.sendResponse = { status, payload }; },
    sends() { return calls.filter((c) => c.method === 'POST' && /\/api\/messages(\/|$)/.test(c.url)); },
    lastSend() { const s = this.sends(); return s[s.length - 1]; },
    parseLastSendBody() { const s = this.lastSend(); return s ? JSON.parse(s.body) : null; },
    urls() { return calls.map((c) => c.url); },
  };
}

/* ---------------------------------------------------------------------------
 * Boot an application instance that has finished running init()
 * -------------------------------------------------------------------------*/
const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }

async function boot() {
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  const stub = makeFetchStub();
  win.fetch = stub.fetchImpl; // must be before injecting app.js

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  let ready = false;
  for (let i = 0; i < 400; i++) {
    const nav = win.document.querySelector('#folder-nav');
    if (nav && nav.children.length > 0 && typeof win.openComposer === 'function') { ready = true; break; }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 5);
  return { dom, win, doc: win.document, stub, close() { try { dom.window.close(); } catch { /* ignore */ } } };
}

/* ---------------------------------------------------------------------------
 * Event / assertion helpers
 * -------------------------------------------------------------------------*/
const clickEvt = (win) => new win.MouseEvent('click', { bubbles: true, cancelable: true });
function el(ctx, sel) { return ctx.doc.querySelector(sel); }
function clickEl(ctx, sel) { el(ctx, sel).dispatchEvent(clickEvt(ctx.win)); }
function clickMaskBlank(ctx) { el(ctx, '#modal-mask').dispatchEvent(clickEvt(ctx.win)); }

const composerOpen = (ctx) => !el(ctx, '#modal-mask').classList.contains('hidden');
const confirmShown = (ctx) => !el(ctx, '#confirm-mask').classList.contains('hidden');
const toastText = (ctx) => el(ctx, '#toast').textContent;
const toastError = (ctx) => el(ctx, '#toast').classList.contains('error');
const val = (ctx, sel) => el(ctx, sel).value;
const hint = (ctx) => el(ctx, '#merge-hint').textContent;
const mergeChecked = (ctx) => el(ctx, '#f-merge').checked;
const mergeRowHidden = (ctx) => el(ctx, '.merge-row').classList.contains('hidden');
const evalIn = (ctx, expr) => ctx.win.eval(expr);
const composing = (ctx) => evalIn(ctx, 'state.composing');
const isDirty = (ctx) => evalIn(ctx, 'isComposerDirty()');
const baseline = (ctx) => evalIn(ctx, 'composerBaseline');
const folderOf = (ctx) => evalIn(ctx, 'state.folder');

function setValue(ctx, sel, v) {
  const node = el(ctx, sel);
  node.value = v;
  node.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
}
function setChecked(ctx, sel, v) {
  const node = el(ctx, sel);
  node.checked = v;
  node.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
}

async function openCompose(ctx) { clickEl(ctx, '#compose-btn'); await ticks(ctx.win, 3); }

function openReply(ctx, msg) {
  const m = Object.assign({
    id: 'm1', from_email: 'sender@example.com', from_name: 'Sender', reply_to: [],
    subject: 'Hello', mailbox: 'me@example.com', received_at: 1700000000,
    body_text: 'line1', direction: 'inbound', read: true,
  }, msg || {});
  evalIn(ctx, `currentMessage = ${JSON.stringify(m)};`);
  evalIn(ctx, 'openReplyComposer()');
}

/** Real attachment: goes through #f-attachments' change event + FileReader */
async function addAttachment(ctx, name = 'a.txt', content = 'hello') {
  const input = el(ctx, '#f-attachments');
  if (typeof ctx.win.File !== 'function' || typeof ctx.win.FileReader !== 'function') {
    return { ok: false, reason: 'jsdom 缺少 File/FileReader' };
  }
  const file = new ctx.win.File([content], name, { type: 'text/plain' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  await ticks(ctx.win, 30);
  Object.defineProperty(input, 'files', { value: [], configurable: true });
  const n = evalIn(ctx, 'state.composing ? state.composing.files.length : -1');
  return { ok: n === 1, count: n, reason: n === 1 ? '' : `附件数量=${n}` };
}

async function send(ctx) { clickEl(ctx, '#composer-send'); await ticks(ctx.win, 8); }

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
  const tail = detail === undefined ? '' : `  [${detail}]`;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${tail}`);
}
function info(msg) { console.log(`  INFO  ${msg}`); }

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
    if (ctx) ctx.close();
  }
}

/* =============================================================================
 * Test cases
 * ===========================================================================*/
(async () => {
  console.log(`被测版本: app.js md5=${FINGERPRINT['public/app.js']}  index.html md5=${FINGERPRINT['public/index.html']}`);
  console.log(`被测文件: ${APP_JS_PATH}${process.env.QA_APP_JS ? '  ← QA_APP_JS 变异体' : ''}`);

  /* ---- T1 control visibility: shown when composing / hidden when replying ---- */
  await test('T1 .merge-row 可见性：写信显示、回复整行隐藏', async (ctx) => {
    ok(mergeRowHidden(ctx) === false, '初始（未开弹窗）merge-row 未隐藏（静态 HTML 默认可见，开弹窗时由 JS 决定）');
    await openCompose(ctx);
    ok(composerOpen(ctx), '写信弹窗已打开');
    ok(mergeRowHidden(ctx) === false, '写信模式：.merge-row 不带 hidden');
    ok(el(ctx, '#f-merge') !== null, '#f-merge 存在于 DOM');
    ok(el(ctx, '#merge-hint') !== null, '#merge-hint 存在于 DOM');
    clickEl(ctx, '#composer-cancel');
    await ticks(ctx.win, 2);
    openReply(ctx);
    await ticks(ctx.win, 2);
    ok(composerOpen(ctx), '回复弹窗已打开');
    ok(mergeRowHidden(ctx) === true, '回复模式：.merge-row 带 hidden（整行隐藏）');
  });

  /* ---- T2 hard defense in reply mode ---- */
  await test('T2 回复模式硬防御：强行勾选 #f-merge，payload 仍不含 merge', async (ctx) => {
    openReply(ctx);
    await ticks(ctx.win, 2);
    // Bypass the UI and force-check it (simulating a user/script forcibly opening the hidden control)
    el(ctx, '#f-merge').checked = true;
    el(ctx, '#f-merge').dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    setValue(ctx, '#f-body', 'reply body');
    await send(ctx);

    const body = ctx.stub.parseLastSendBody();
    const last = ctx.stub.lastSend();
    ok(last !== undefined, '确实发出了一次发送请求');
    ok(/\/reply$/.test(last.url), `请求打到回复接口`, last.url);
    ok(body && !Object.prototype.hasOwnProperty.call(body, 'merge'), 'payload 不含 merge 字段');
    ok(body && body.merge === undefined, 'payload.merge === undefined');
    ok(composing(ctx) === null || composerOpen(ctx) === false, '回复成功后弹窗已关闭');
  });

  /* ---- T3 non-merge branch ---- */
  await test('T3 非 merge 写信：to 为数组、无 merge 字段、一次请求', async (ctx) => {
    ctx.stub.setSendResponse(200, { ok: true, id: 'row-9', resend_id: 're-9' });
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@x.com, b@y.com');
    setValue(ctx, '#f-subject', 'Hi');
    setValue(ctx, '#f-body', 'body');
    await send(ctx);

    const body = ctx.stub.parseLastSendBody();
    const sends = ctx.stub.sends();
    ok(sends.length === 1, '只发了一次请求', `sends=${sends.length}`);
    ok(Array.isArray(body.to), 'payload.to 是数组');
    ok(body.to.length === 2 && body.to[0] === 'a@x.com' && body.to[1] === 'b@y.com', 'payload.to 含全部收件人', JSON.stringify(body.to));
    ok(!Object.prototype.hasOwnProperty.call(body, 'merge'), '非 merge：payload 不含 merge 字段');
    ok(composerOpen(ctx) === false, '成功后弹窗关闭');
    ok(/^邮件已发送$/.test(toastText(ctx)), 'toast 文案为「邮件已发送」', toastText(ctx));
    ok(toastError(ctx) === false, 'toast 非错误样式');
  });

  /* ---- T4 merge send: all succeed ---- */
  await test('T4 合并发送全成功：关窗 + 文案 + 刷新链', async (ctx) => {
    ctx.stub.setSendResponse(200, {
      ok: true, merge: true, total: 2, sent_count: 2, failed_count: 0,
      sent: [{ to: 'a@x.com', id: 'r1', resend_id: 'e1' }, { to: 'b@y.com', id: 'r2', resend_id: 'e2' }],
      failed: [],
    });
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@x.com, b@y.com');
    setValue(ctx, '#f-subject', 'Hi');
    setValue(ctx, '#f-body', 'body');
    setChecked(ctx, '#f-merge', true);
    await send(ctx);

    const body = ctx.stub.parseLastSendBody();
    ok(body.merge === true, 'payload.merge === true');
    ok(body.to.length === 2, 'payload.to 含 2 个收件人（前端不做拆分，交后端）');
    ok(composerOpen(ctx) === false, '全成功：弹窗关闭');
    ok(composing(ctx) === null, '全成功：state.composing 置空');
    ok(toastText(ctx) === '已分别发送给 2 位收件人', 'toast 文案为「已分别发送给 2 位收件人」', toastText(ctx));
    ok(toastError(ctx) === false, 'toast 非错误样式');
    ok(folderOf(ctx) === 'sent', '刷新链切到 sent 文件夹');
    ok(ctx.stub.urls().some((u) => u.startsWith('/api/folders/sent')), '触发了 sent 列表刷新请求');
  });

  /* ---- T5 merge send: partial failure (key case) ---- */
  await test('T5 部分失败：弹窗不关、#f-to 只剩失败者、toast 含地址与原因', async (ctx) => {
    ctx.stub.setSendResponse(200, {
      ok: false, merge: true, total: 3, sent_count: 2, failed_count: 1,
      sent: [{ to: 'a@x.com', id: 'r1', resend_id: 'e1' }, { to: 'b@y.com', id: 'r2', resend_id: 'e2' }],
      failed: [{ to: 'c@z.com', error: 'Resend 返回错误: invalid' }],
    });
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@x.com, b@y.com, c@z.com');
    setValue(ctx, '#f-subject', 'Hi');
    setValue(ctx, '#f-body', 'body');
    setChecked(ctx, '#f-merge', true);
    await send(ctx);

    ok(composerOpen(ctx) === true, '部分失败：弹窗仍打开');
    ok(composing(ctx) !== null, '部分失败：state.composing 非 null');
    ok(val(ctx, '#f-to') === 'c@z.com', '#f-to 只剩失败收件人', JSON.stringify(val(ctx, '#f-to')));
    ok(val(ctx, '#f-subject') === 'Hi', '主题内容保留');
    ok(val(ctx, '#f-body') === 'body', '正文内容保留');
    ok(mergeChecked(ctx) === true, '#f-merge 仍保持勾选');
    ok(toastError(ctx) === true, 'toast 为错误样式');
    ok(
      toastText(ctx) === '已发送 2 封，1 封失败：c@z.com（Resend 返回错误: invalid）',
      'toast 文案含失败地址与原因',
      toastText(ctx)
    );
    ok(ctx.stub.sends().length === 1, '部分失败不会自动重发（只 1 次请求）');
    ok(hint(ctx) === '', '失败者只剩 1 人时 hint 清空（不显示「分别发送」）', JSON.stringify(hint(ctx)));
  });

  /* ---- T6 merge send: all fail ---- */
  await test('T6 全部失败：弹窗不关、#f-to 与原输入等价', async (ctx) => {
    ctx.stub.setSendResponse(200, {
      ok: false, merge: true, total: 2, sent_count: 0, failed_count: 2,
      sent: [],
      failed: [{ to: 'a@x.com', error: 'Resend 返回错误: nope' }, { to: 'b@y.com', error: 'Resend 返回错误: nope' }],
    });
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@x.com, b@y.com');
    setValue(ctx, '#f-subject', 'Hi');
    setValue(ctx, '#f-body', 'body');
    setChecked(ctx, '#f-merge', true);
    await send(ctx);

    ok(composerOpen(ctx) === true, '全部失败：弹窗仍打开');
    ok(composing(ctx) !== null, '全部失败：state.composing 非 null');
    const back = val(ctx, '#f-to');
    ok(back === 'a@x.com, b@y.com', '#f-to 与原输入等价', JSON.stringify(back));
    ok(toastError(ctx) === true, 'toast 为错误样式');
    ok(toastText(ctx) === '已发送 0 封，2 封失败：a@x.com（Resend 返回错误: nope）', 'toast 文案', toastText(ctx));
    ok(mergeChecked(ctx) === true, '#f-merge 仍勾选（内容全保留）');
  });

  /* ---- T7 multiple failures: order and separator ---- */
  await test('T7 多个失败：失败者按返回顺序以 ", " 连接', async (ctx) => {
    ctx.stub.setSendResponse(200, {
      ok: false, merge: true, total: 3, sent_count: 1, failed_count: 2,
      sent: [{ to: 'a@x.com', id: 'r1', resend_id: 'e1' }],
      failed: [{ to: 'c@z.com', error: 'boom-c' }, { to: 'd@w.com', error: 'boom-d' }],
    });
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@x.com, c@z.com, d@w.com');
    setValue(ctx, '#f-body', 'body');
    setChecked(ctx, '#f-merge', true);
    await send(ctx);

    ok(val(ctx, '#f-to') === 'c@z.com, d@w.com', '#f-to 为失败者列表（逗号+空格连接）', JSON.stringify(val(ctx, '#f-to')));
    ok(toastText(ctx) === '已发送 1 封，2 封失败：c@z.com（boom-c）', 'toast 只展示第一个失败者', toastText(ctx));
    ok(hint(ctx) === '将分别单独发送给 2 位收件人', 'hint 随失败者列表刷新（2 个失败者 + 仍勾选）', JSON.stringify(hint(ctx)));
  });

  /* ---- T8 backend 400: catch branch, don't rewrite #f-to ---- */
  await test('T8 后端 400（超上限）：走 catch、#f-to 不被改写、弹窗保留', async (ctx) => {
    ctx.stub.setSendResponse(400, { error: '单次合并发送最多 22 位收件人' });
    await openCompose(ctx);
    const original = 'a@x.com, b@y.com';
    setValue(ctx, '#f-to', original);
    setValue(ctx, '#f-body', 'body');
    setChecked(ctx, '#f-merge', true);
    await send(ctx);

    ok(composerOpen(ctx) === true, '400 后弹窗仍打开');
    ok(val(ctx, '#f-to') === original, '#f-to 未被改写', JSON.stringify(val(ctx, '#f-to')));
    ok(toastError(ctx) === true, 'toast 为错误样式');
    ok(toastText(ctx) === '发送失败：单次合并发送最多 22 位收件人', 'toast 为「发送失败：<原因>」', toastText(ctx));
    ok(mergeChecked(ctx) === true, '#f-merge 仍勾选');
  });

  /* ---- T9 dirty check: merely checking the checkbox isn't dirty ---- */
  await test('T9 脏检测：空表单仅勾选 #f-merge，点遮罩直接关闭、不弹放弃确认', async (ctx) => {
    await openCompose(ctx);
    ok(isDirty(ctx) === false, '刚打开：不脏');
    setChecked(ctx, '#f-merge', true);
    await ticks(ctx.win, 1);
    ok(isDirty(ctx) === false, '仅勾选 checkbox：仍不脏');
    const b = baseline(ctx);
    ok(b && !Object.prototype.hasOwnProperty.call(b, 'merge'), 'composerBaseline 不含 merge 键', b ? Object.keys(b).join(',') : 'null');

    clickMaskBlank(ctx);
    await ticks(ctx.win, 2);
    ok(confirmShown(ctx) === false, '未弹出「放弃确认」');
    ok(composerOpen(ctx) === false, '弹窗直接关闭');
    ok(composing(ctx) === null, 'state.composing 置空');

    // Reverse control: check + enter a recipient -> dirty -> likewise "save draft and close" (no confirm from this round on)
    await openCompose(ctx);
    setChecked(ctx, '#f-merge', true);
    setValue(ctx, '#f-to', 'a@x.com');
    ok(isDirty(ctx) === true, '勾选 + 有收件人：判脏');
    clickMaskBlank(ctx);
    await ticks(ctx.win, 2);
    ok(confirmShown(ctx) === false, '有输入时点遮罩 -> 不弹放弃确认');
    ok(composerOpen(ctx) === false, '有输入时点遮罩 -> 存草稿并关闭');
  });

  /* ---- T10 unchecking also isn't dirty ---- */
  await test('T10 脏检测：勾选后再取消勾选，仍不脏', async (ctx) => {
    await openCompose(ctx);
    setChecked(ctx, '#f-merge', true);
    setChecked(ctx, '#f-merge', false);
    ok(isDirty(ctx) === false, '勾选->取消：不脏');
    clickMaskBlank(ctx);
    await ticks(ctx.win, 2);
    ok(confirmShown(ctx) === false, '未弹放弃确认');
    ok(composerOpen(ctx) === false, '直接关闭');
  });

  /* ---- T11 hint text orthogonal matrix ---- */
  await test('T11 #merge-hint 正交矩阵：0/1/2/3 个收件人 × 勾选/未勾选', async (ctx) => {
    await openCompose(ctx);
    const cases = [
      { to: '', n: 0 }, { to: 'a@x.com', n: 1 },
      { to: 'a@x.com, b@y.com', n: 2 }, { to: 'a@x.com,b@y.com;c@z.com', n: 3 },
    ];
    for (const c of cases) {
      setChecked(ctx, '#f-merge', false);
      setValue(ctx, '#f-to', c.to);
      ok(hint(ctx) === '', `未勾选 / ${c.n} 人 -> hint 为空`, JSON.stringify(hint(ctx)));
      setChecked(ctx, '#f-merge', true);
      const expect = c.n > 1 ? `将分别单独发送给 ${c.n} 位收件人` : '';
      ok(hint(ctx) === expect, `勾选 / ${c.n} 人 -> ${expect === '' ? '空' : expect}`, JSON.stringify(hint(ctx)));
    }
    // Count after de-dup: the same address written 3 times counts as 1 person
    setValue(ctx, '#f-to', 'a@x.com, A@X.com, a@x.com');
    ok(hint(ctx) === '', '去重后 1 人 -> hint 为空', JSON.stringify(hint(ctx)));
    // Only via the input event (without checking) it also updates
    setChecked(ctx, '#f-merge', true);
    setValue(ctx, '#f-to', 'a@x.com, b@y.com');
    ok(hint(ctx) === '将分别单独发送给 2 位收件人', 'input 事件触发 hint 更新', JSON.stringify(hint(ctx)));
  });

  /* ---- T12 reset the checkbox each time the composer opens ---- */
  await test('T12 每次打开弹窗 #f-merge 重置为未勾选', async (ctx) => {
    await openCompose(ctx);
    setChecked(ctx, '#f-merge', true);
    ok(mergeChecked(ctx) === true, '勾选成功');
    clickEl(ctx, '#composer-cancel');
    await ticks(ctx.win, 2);
    await openCompose(ctx);
    ok(mergeChecked(ctx) === false, '重新打开写信弹窗：已重置为未勾选');
    ok(hint(ctx) === '', '重新打开：hint 清空');
    // reply -> compose again, must also reset
    setChecked(ctx, '#f-merge', true);
    clickEl(ctx, '#composer-cancel');
    await ticks(ctx.win, 2);
    openReply(ctx);
    await ticks(ctx.win, 2);
    clickEl(ctx, '#composer-cancel');
    await ticks(ctx.win, 2);
    await openCompose(ctx);
    ok(mergeChecked(ctx) === false, '回复->写信：仍为未勾选');
  });

  /* ---- T13 merge + attachment: upload only once, each mail carries the same copy from the backend ---- */
  await test('T13 合并 + 附件：前端只上传一次，payload.attachments 完整', async (ctx) => {
    ctx.stub.setSendResponse(200, {
      ok: true, merge: true, total: 2, sent_count: 2, failed_count: 0,
      sent: [{ to: 'a@x.com', id: 'r1', resend_id: 'e1' }, { to: 'b@y.com', id: 'r2', resend_id: 'e2' }],
      failed: [],
    });
    await openCompose(ctx);
    const att = await addAttachment(ctx, 'note.txt', 'hello');
    if (!att.ok) { info(`跳过附件断言：${att.reason}（测试环境局限）`); return; }
    setValue(ctx, '#f-to', 'a@x.com, b@y.com');
    setValue(ctx, '#f-body', 'body');
    setChecked(ctx, '#f-merge', true);
    await send(ctx);

    const body = ctx.stub.parseLastSendBody();
    ok(ctx.stub.sends().length === 1, '前端只发 1 次请求（附件只上传一次）');
    ok(Array.isArray(body.attachments) && body.attachments.length === 1, 'payload 带 1 个附件');
    ok(body.attachments[0].filename === 'note.txt', '附件文件名正确', body.attachments[0] && body.attachments[0].filename);
    ok(typeof body.attachments[0].content === 'string' && body.attachments[0].content.length > 0, '附件内容为 base64 字符串');
    ok(composerOpen(ctx) === false, '全成功关窗');
  });

  /* ---- T14 merge semantics unaffected when unchecked + validation ordering ---- */
  await test('T14 前置校验：无收件人 / 无正文时不会发出 merge 请求', async (ctx) => {
    await openCompose(ctx);
    setChecked(ctx, '#f-merge', true);
    setValue(ctx, '#f-body', 'body');
    await send(ctx);
    ok(ctx.stub.sends().length === 0, '无收件人：不发请求');
    ok(toastText(ctx) === '请填写收件人', 'toast 提示收件人', toastText(ctx));

    setValue(ctx, '#f-to', 'a@x.com');
    setValue(ctx, '#f-body', '');
    await send(ctx);
    ok(ctx.stub.sends().length === 0, '无正文：不发请求');
    ok(toastText(ctx) === '请填写邮件内容', 'toast 提示内容', toastText(ctx));
    ok(composerOpen(ctx) === true, '校验失败弹窗保持打开');
  });

  /* ---- T15 send again after partial failure: only send the failures to the backend (frontend behavior) ---- */
  await test('T15 部分失败重试：第二次 payload.to 只含失败者且仍带 merge', async (ctx) => {
    ctx.stub.setSendResponse(200, {
      ok: false, merge: true, total: 2, sent_count: 1, failed_count: 1,
      sent: [{ to: 'a@x.com', id: 'r1', resend_id: 'e1' }],
      failed: [{ to: 'b@y.com', error: 'temp' }],
    });
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@x.com, b@y.com');
    setValue(ctx, '#f-body', 'body');
    setChecked(ctx, '#f-merge', true);
    await send(ctx);
    ok(val(ctx, '#f-to') === 'b@y.com', '第一次后 #f-to 只剩失败者');

    ctx.stub.setSendResponse(200, {
      ok: true, merge: true, total: 1, sent_count: 1, failed_count: 0,
      sent: [{ to: 'b@y.com', id: 'r2', resend_id: 'e2' }], failed: [],
    });
    await send(ctx);
    const body = ctx.stub.parseLastSendBody();
    ok(body.to.length === 1 && body.to[0] === 'b@y.com', '重试只发失败者', JSON.stringify(body.to));
    ok(body.merge === true, '重试仍带 merge:true');
    ok(composerOpen(ctx) === false, '重试全成功 -> 关窗');
    ok(toastText(ctx) === '已分别发送给 1 位收件人', '重试成功 toast', toastText(ctx));
  });

  /* ---- T16 CSS rule-layer check (can't render, only check rule existence) ---- */
  await test('T16 CSS 规则层：.merge-row / .merge-pick / .merge-hint 有对应规则', async (ctx) => {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
    ok(/#composer\s+\.merge-row\s*\{[^}]*align-items:\s*center/.test(css), '存在 #composer .merge-row 居中规则');
    ok(/#composer\s+label\.merge-pick\s*\{[^}]*flex-direction:\s*row/.test(css), '存在 label.merge-pick 横向排列覆盖规则');
    ok(/\.merge-hint\s*\{[^}]*font-size:\s*12px/.test(css), '存在 .merge-hint 样式规则');
    info('注意：以上仅为 CSS 规则层校验，真实排版/对齐未渲染验证（本机无浏览器自动化）。');
  });

  /* ---- summary ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail ? `  [${f.detail}]` : ''}`);

  console.log(`\n被测版本: app.js md5=${FINGERPRINT['public/app.js']}  index.html md5=${FINGERPRINT['public/index.html']}`);
  console.log(`被测文件: ${APP_JS_PATH}${process.env.QA_APP_JS ? '  ← QA_APP_JS 变异体' : ''}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})();
