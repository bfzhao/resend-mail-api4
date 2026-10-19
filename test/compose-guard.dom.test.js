'use strict';

/* =============================================================================
 * Standalone verification: compose window "close guard" (real jsdom + real DOM event dispatch)
 *
 * The semantics were changed this round from "show a 'discard?' confirm dialog" to
 * "auto-save draft then close directly": the mask blank area / cancel button / Esc
 * all go through "save draft -> close window"; the only case still blocked is
 * "sending in progress" (closing then would make the user think it wasn't sent).
 * So the core assertion of this suite is: **no close path may pop a confirm dialog**
 * (confirmShown is always false).
 *
 * Run:
 *   NODE_PATH=<NODE_PATH> \
 *     <node.exe> test/compose-guard.dom.test.js
 *
 * Exit code: 0 = all passed; 1 = some failed.
 * This file does not modify any source under public/; it only reads index.html + app.js
 * and executes them in jsdom.
 * ===========================================================================*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
// QA_APP_JS is only for "mutation verification": points to a hand-crafted defective app.js, confirming this test really catches the defect.
// Without this hook, the mutation script would "run the repo's original file while thinking it ran the variant" -> the variant is never caught (false negative).
const APP_JS_PATH = process.env.QA_APP_JS || path.join(ROOT, 'public', 'app.js');
// QA_INDEX_HTML is only for "mutation verification": points to a hand-crafted defective index.html (the variant lives outside the repo).
// Without this hook, the HTML variant would "run the repo's original file while thinking it ran the variant" -> the variant is never caught (false negative).
const INDEX_PATH = process.env.QA_INDEX_HTML || path.join(ROOT, 'public', 'index.html');
const APP_CSS_PATH = path.join(ROOT, 'public', 'app.css');
const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');
const APP_CSS = fs.readFileSync(APP_CSS_PATH, 'utf8');

const FINGERPRINT = {
  md5: crypto.createHash('md5').update(APP_JS).digest('hex'),
  mtime: fs.statSync(APP_JS_PATH).mtime.toISOString(),
  bytes: Buffer.byteLength(APP_JS),
  path: APP_JS_PATH,
};

/* ---------------------------------------------------------------------------
 * fetch stub: installed on window only before injecting app.js, so init() doesn't throw
 * -------------------------------------------------------------------------*/

function makeFetchStub(opts = {}) {
  const calls = [];
  const mailboxes = opts.mailboxes || [];
  let pendingSend = null;

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
    if (url.startsWith('/api/mailboxes')) return Promise.resolve(jsonRes({ mailboxes }));
    if (url.startsWith('/api/counts')) {
      return Promise.resolve(jsonRes({ inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 }));
    }
    if (url.startsWith('/api/folders/')) return Promise.resolve(jsonRes({ items: [], total: 0 }));
    if (url.startsWith('/api/messages') && method === 'POST') {
      // Send request: held pending; the test decides when it succeeds / fails
      return new Promise((resolve) => { pendingSend = { resolve, url }; });
    }
    if (url.startsWith('/api/messages')) return Promise.resolve(jsonRes({ message: null, items: [], total: 0 }));
    return Promise.resolve(jsonRes({}));
  };

  return {
    fetchImpl,
    calls,
    get pendingSend() { return pendingSend; },
    hasPendingSend() { return !!pendingSend; },
    settleSend(status = 200, payload = { ok: true }) {
      if (!pendingSend) throw new Error('没有处于挂起状态的发送请求');
      const p = pendingSend;
      pendingSend = null;
      p.resolve(jsonRes(payload, status));
    },
  };
}

/* ---------------------------------------------------------------------------
 * Boot an application instance that has finished running init()
 * -------------------------------------------------------------------------*/

const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }

async function boot(bootOpts = {}) {
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  const stub = makeFetchStub(bootOpts);
  win.fetch = stub.fetchImpl; // must be before injecting app.js

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  // renderNav() runs synchronously one line before setupEvents() -> having child nodes means setupEvents has finished
  let ready = false;
  for (let i = 0; i < 400; i++) {
    const nav = win.document.querySelector('#folder-nav');
    if (nav && nav.children.length > 0 && typeof win.openComposer === 'function') { ready = true; break; }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 5);

  return {
    dom, win, doc: win.document, stub,
    close() { try { dom.window.close(); } catch { /* ignore */ } },
  };
}

/* ---------------------------------------------------------------------------
 * Event / assertion helpers
 * -------------------------------------------------------------------------*/

const clickEvt = (win) => new win.MouseEvent('click', { bubbles: true, cancelable: true });

function el(ctx, sel) { return ctx.doc.querySelector(sel); }
function clickEl(ctx, sel) { el(ctx, sel).dispatchEvent(clickEvt(ctx.win)); }
/** Click the mask blank area: target === currentTarget */
function clickMaskBlank(ctx) { el(ctx, '#modal-mask').dispatchEvent(clickEvt(ctx.win)); }
/** Click inside the composer: bubbles from a child to the mask (target !== currentTarget) */
function clickComposerInside(ctx) { el(ctx, '#composer').dispatchEvent(clickEvt(ctx.win)); }

function pressEsc(ctx, targetSel) {
  const target = targetSel ? el(ctx, targetSel) : ctx.doc;
  const ev = new ctx.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

const composerOpen = (ctx) => !el(ctx, '#modal-mask').classList.contains('hidden');
const confirmShown = (ctx) => !el(ctx, '#confirm-mask').classList.contains('hidden');
const toastShown = (ctx) => !el(ctx, '#toast').classList.contains('hidden');
const toastText = (ctx) => el(ctx, '#toast').textContent;
const val = (ctx, sel) => el(ctx, sel).value;
const innerHtml = (ctx, sel) => el(ctx, sel).innerHTML;

const evalIn = (ctx, expr) => ctx.win.eval(expr);
const pendingFlag = (ctx) => evalIn(ctx, 'discardConfirmPending');
const baselineOf = (ctx) => evalIn(ctx, 'composerBaseline');
const composing = (ctx) => evalIn(ctx, 'state.composing');
const sendFlag = (ctx) => evalIn(ctx, 'sendInFlight');
const confirmBoxCount = (ctx) => ctx.doc.querySelectorAll('#confirm-box').length;
const confirmMaskCount = (ctx) => ctx.doc.querySelectorAll('#confirm-mask').length;

/** Most recent draft write request (PUT / DELETE /api/drafts/...); null if none. */
function lastDraftCall(ctx) {
  const hits = ctx.stub.calls.filter((c) => c.url.startsWith('/api/drafts/'));
  return hits.length ? hits[hits.length - 1] : null;
}

function setValue(ctx, sel, v) {
  const node = el(ctx, sel);
  node.value = v;
  node.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
}

async function openCompose(ctx) {
  clickEl(ctx, '#compose-btn');
  await ticks(ctx.win, 2);
}

function openReply(ctx, msg) {
  const m = Object.assign({
    id: 'm1', from_email: 'sender@example.com', from_name: 'Sender', reply_to: [],
    subject: 'Hello', mailbox: 'me@example.com', received_at: 1700000000,
    body_text: 'line1\nline2', direction: 'inbound', read: true,
  }, msg || {});
  evalIn(ctx, `currentMessage = ${JSON.stringify(m)};`);
  evalIn(ctx, 'openReplyComposer()');
}

async function addAttachment(ctx, name = 'a.txt', content = 'hello') {
  const input = el(ctx, '#f-attachments');
  if (typeof ctx.win.File !== 'function' || typeof ctx.win.FileReader !== 'function') {
    return { ok: false, reason: 'jsdom 缺少 File/FileReader' };
  }
  const file = new ctx.win.File([content], name, { type: 'text/plain' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  await ticks(ctx.win, 25);
  Object.defineProperty(input, 'files', { value: [], configurable: true });
  const n = evalIn(ctx, 'state.composing ? state.composing.files.length : -1');
  return { ok: n === 1, count: n, reason: n === 1 ? '' : `附件数量=${n}` };
}

/** Switch the compose window to HTML rich text mode */
async function toRich(ctx) {
  clickEl(ctx, '#f-mode');
  await ticks(ctx.win, 2);
  if (!evalIn(ctx, 'state.composing && state.composing.rich === true')) {
    throw new Error('切换富文本失败（rich !== true）');
  }
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
  const tail = detail === undefined ? '' : `  [${detail}]`;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${tail}`);
}
function info(msg) { console.log(`  INFO  ${msg}`); }

async function test(name, fn, bootOpts) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  let ctx = null;
  try {
    ctx = await boot(bootOpts || {});
    await fn(ctx);
  } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  } finally {
    if (ctx) ctx.close();
  }
}

/* ===========================================================================
 * Test cases
 * ===========================================================================*/

(async function main() {
  console.log('写信弹窗「放弃确认」守卫 —— 独立 jsdom 验证');
  console.log(`被测版本: md5=${FINGERPRINT.md5}  mtime=${FINGERPRINT.mtime}  bytes=${FINGERPRINT.bytes}`);
  console.log(`被测文件: ${FINGERPRINT.path}${process.env.QA_APP_JS ? '  ← QA_APP_JS 变异体' : ''}`);

  /* ---- T0 environment self-check ---- */
  await test('T0 测试环境自检（harness 可信度）', async (ctx) => {
    ok(typeof ctx.win.openComposer === 'function', 'app.js 已注入且 openComposer 为全局函数');
    ok(el(ctx, '#folder-nav').children.length === 5, 'renderNav 已执行（folder-nav 有 5 项：收件箱/草稿/星标/已发送/已删除）', el(ctx, '#folder-nav').children.length);
    ok(evalIn(ctx, 'typeof state') === 'object', 'eval 可访问全局词法绑定 state');
    ok(evalIn(ctx, 'typeof composerBaseline') !== 'undefined', 'eval 可访问 composerBaseline（改动 A 已落地）');
    ok(evalIn(ctx, 'typeof sendInFlight') !== 'undefined', 'eval 可访问 sendInFlight（改动 B 已落地）');
    ok(!composerOpen(ctx), '初始状态：写信弹窗隐藏');
    ok(!confirmShown(ctx), '初始状态：确认框隐藏');
    ok(confirmMaskCount(ctx) === 1, '页面中只有 1 个 #confirm-mask', confirmMaskCount(ctx));
    info(`jsdom #f-body-rich.innerText = ${String(evalIn(ctx, 'typeof document.querySelector("#f-body-rich").innerText'))}`);
  });

  /* ---- T1 no user input -> close directly, no confirm ---- */
  await test('T1 无输入：点遮罩空白区直接关闭', async (ctx) => {
    await openCompose(ctx);
    ok(composerOpen(ctx), '写信弹窗已打开');
    ok(pendingFlag(ctx) === false, '基线已建立且 pending=false', String(pendingFlag(ctx)));
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '无输入点遮罩 -> 不弹确认框');
    ok(!composerOpen(ctx), '无输入点遮罩 -> 弹窗直接关闭');
    ok(composing(ctx) === null, '无输入点遮罩 -> composing 已清理');
  });

  await test('T1b 无输入：点「取消」直接关闭', async (ctx) => {
    await openCompose(ctx);
    clickEl(ctx, '#composer-cancel');
    ok(!confirmShown(ctx), '无输入点取消 -> 不弹确认框');
    ok(!composerOpen(ctx), '无输入点取消 -> 弹窗直接关闭');
  });

  await test('T1c 无输入：按 Esc 直接关闭', async (ctx) => {
    await openCompose(ctx);
    pressEsc(ctx);
    ok(!confirmShown(ctx), '无输入按 Esc -> 不弹确认框');
    ok(!composerOpen(ctx), '无输入按 Esc -> 弹窗直接关闭');
  });

  await test('T1d 无输入：焦点在输入框内按 Esc 同样生效', async (ctx) => {
    await openCompose(ctx);
    const ev = pressEsc(ctx, '#f-to');
    ok(!composerOpen(ctx), '在 #f-to 内按 Esc -> 弹窗关闭（未被 isTypingTarget 吞掉）');
    ok(ev.defaultPrevented === true, 'Esc 已 preventDefault', String(ev.defaultPrevented));
  });

  await test('T1e 点弹窗内部不算「点外部」', async (ctx) => {
    await openCompose(ctx);
    clickComposerInside(ctx);
    ok(composerOpen(ctx), '点 #composer 内部 -> 弹窗不关闭');
    ok(!confirmShown(ctx), '点 #composer 内部 -> 不弹确认框');
  });

  /* ---- T2 has input -> all three entries "save draft and close" (no more confirm) ---- */
  const dirtyCases = [
    ['收件人', async (ctx) => setValue(ctx, '#f-to', 'a@b.com'), 'mask'],
    ['主题', async (ctx) => setValue(ctx, '#f-subject', 'hi'), 'cancel'],
    ['正文(textarea)', async (ctx) => setValue(ctx, '#f-body', 'hello'), 'esc'],
    ['富文本内容', async (ctx) => { await toRich(ctx); evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "rich text"'); }, 'mask'],
    ['附件', async (ctx) => { const r = await addAttachment(ctx); if (!r.ok) throw new Error(`附件桩失败: ${r.reason}`); }, 'mask'],
  ];

  for (const [label, makeDirty, entry] of dirtyCases) {
    await test(`T2 有输入(${label})：入口=${entry} -> 存草稿并关闭`, async (ctx) => {
      await openCompose(ctx);
      await makeDirty(ctx);
      ok(evalIn(ctx, 'isComposerDirty()') === true, `脏检测：${label} 改动后 isComposerDirty()=true`);
      const draftId = evalIn(ctx, 'state.composing.draftId');
      ctx.stub.calls.length = 0; // only look at the requests generated by this close

      if (entry === 'mask') clickMaskBlank(ctx);
      else if (entry === 'cancel') clickEl(ctx, '#composer-cancel');
      else pressEsc(ctx);

      ok(!confirmShown(ctx), `${label} + ${entry} -> 不再弹放弃确认框`);
      ok(!composerOpen(ctx), `${label} + ${entry} -> 弹窗关闭`);
      ok(composing(ctx) === null, `${label} + ${entry} -> composing 已清空`);
      await ticks(ctx.win, 3);
      const put = lastDraftCall(ctx);
      ok(put !== null && put.method === 'PUT' && put.url === `/api/drafts/${draftId}`, `${label} + ${entry} -> PUT 到打开时生成的那个草稿 id`, put && `${put.method} ${put.url}`);
    });
  }

  await test('T2b 关窗提交的草稿内容与表单一致（可在草稿箱恢复）', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    setValue(ctx, '#f-subject', '主题A');
    setValue(ctx, '#f-body', '正文B');
    ctx.stub.calls.length = 0;

    clickMaskBlank(ctx);

    ok(!confirmShown(ctx), '不再弹确认框');
    ok(!composerOpen(ctx), '弹窗已关闭');
    ok(composing(ctx) === null, 'composing 已清理');
    ok(baselineOf(ctx) === null, 'composerBaseline 无残留');
    await ticks(ctx.win, 3);
    const put = lastDraftCall(ctx);
    ok(put !== null && put.method === 'PUT', '发出了草稿写请求', put && put.method);
    let body = null;
    try { body = JSON.parse(put.body); } catch { /* let the assertion below report the error */ }
    ok(body !== null && body.subject === '主题A', '主题随草稿保存');
    ok(body !== null && body.body === '正文B', '正文随草稿保存');
    ok(body !== null && body.to === 'a@b.com', '收件人随草稿保存');
    ok(body !== null && body.mode === 'compose', '记录了写信模式（供恢复时选标题）');
  });

  await test('T2c 空表单关窗：不发任何草稿请求、不弹确认', async (ctx) => {
    await openCompose(ctx);
    ctx.stub.calls.length = 0;
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '不弹确认框');
    ok(!composerOpen(ctx), '弹窗关闭');
    ok(composing(ctx) === null, 'composing 已清空');
    ok(pendingFlag(ctx) === false, 'pending 无残留');
    ok(baselineOf(ctx) === null, 'composerBaseline 无残留');
    await ticks(ctx.win, 3);
    ok(ctx.stub.calls.filter((c) => c.url.startsWith('/api/drafts/')).length === 0, '空表单 -> 一条草稿请求都不发', String(ctx.stub.calls.length));
  });

  /* ---- T3 send path ---- */
  await test('T3a 发送成功 -> 直接关闭、不弹确认', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    setValue(ctx, '#f-subject', 's');
    setValue(ctx, '#f-body', 'body');
    clickEl(ctx, '#composer-send');
    ok(sendFlag(ctx) === true, '发送中 sendInFlight=true', String(sendFlag(ctx)));
    ok(ctx.stub.hasPendingSend(), '发送请求已发出且挂起');
    ctx.stub.settleSend(200, { ok: true });
    await ticks(ctx.win, 20);
    ok(!confirmShown(ctx), '发送成功 -> 不弹确认框');
    ok(!composerOpen(ctx), '发送成功 -> 弹窗直接关闭');
    ok(composing(ctx) === null, '发送成功 -> composing 已清空');
    ok(toastText(ctx).includes('已发送'), '发送成功 toast', toastText(ctx));
    ok(sendFlag(ctx) === false, 'finally 中 sendInFlight 复位', String(sendFlag(ctx)));
  });

  await test('T3b 发送失败 -> 弹窗不关、内容保留、仅报错', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    setValue(ctx, '#f-subject', 's');
    setValue(ctx, '#f-body', 'body');
    clickEl(ctx, '#composer-send');
    ctx.stub.settleSend(500, { error: 'boom' });
    await ticks(ctx.win, 20);

    ok(composerOpen(ctx), '发送失败 -> 弹窗仍打开');
    ok(!confirmShown(ctx), '发送失败 -> 不弹确认框');
    ok(val(ctx, '#f-to') === 'a@b.com', '发送失败 -> 收件人保留', val(ctx, '#f-to'));
    ok(val(ctx, '#f-subject') === 's', '发送失败 -> 主题保留', val(ctx, '#f-subject'));
    ok(val(ctx, '#f-body') === 'body', '发送失败 -> 正文保留', val(ctx, '#f-body'));
    ok(toastText(ctx).includes('发送失败') && toastText(ctx).includes('boom'), '发送失败 toast 含原因', toastText(ctx));
    ok(sendFlag(ctx) === false, '发送失败 -> sendInFlight 已复位', String(sendFlag(ctx)));

    // Content is still there after failure: click outside -> save draft and close (content carried into the draft, not silently dropped)
    const draftId = evalIn(ctx, 'state.composing.draftId');
    ctx.stub.calls.length = 0;
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '发送失败后再点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '发送失败后再点外部 -> 存草稿后关闭');
    await ticks(ctx.win, 3);
    const put = lastDraftCall(ctx);
    let db = null;
    try { db = JSON.parse(put.body); } catch { /* let the assertion below report the error */ }
    ok(put !== null && put.method === 'PUT' && put.url === `/api/drafts/${draftId}`, '失败的内容写入打开时那个草稿 id', put && `${put.method} ${put.url}`);
    ok(db !== null && db.body === 'body', '草稿正文与失败前一致（内容未丢）', db && db.body);
  });

  await test('T3c 发送进行中：遮罩 / 取消 / Esc 均被拦下', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    setValue(ctx, '#f-body', 'body');
    clickEl(ctx, '#composer-send');
    ok(sendFlag(ctx) === true, '发送中 sendInFlight=true', String(sendFlag(ctx)));

    clickMaskBlank(ctx);
    ok(composerOpen(ctx), '发送中点遮罩 -> 弹窗未被关闭');
    ok(!confirmShown(ctx), '发送中点遮罩 -> 不弹放弃确认框（区别于普通脏态）');
    ok(toastShown(ctx) && toastText(ctx).includes('发送'), '发送中点遮罩 -> toast 提示发送中', toastText(ctx));

    clickEl(ctx, '#composer-cancel');
    ok(composerOpen(ctx), '发送中点取消 -> 弹窗未被关闭');
    ok(!confirmShown(ctx), '发送中点取消 -> 不弹确认框');

    pressEsc(ctx);
    ok(composerOpen(ctx), '发送中按 Esc -> 弹窗未被关闭');
    ok(!confirmShown(ctx), '发送中按 Esc -> 不弹确认框');
    ok(evalIn(ctx, 'state.composing !== null') === true, '发送中 -> composing 未清空');

    ctx.stub.settleSend(200, { ok: true });
    await ticks(ctx.win, 20);
    ok(!composerOpen(ctx), '发送成功后弹窗关闭');
    ok(sendFlag(ctx) === false, 'sendInFlight 复位', String(sendFlag(ctx)));
  });

  await test('T3d 发送进行中：请求失败后内容仍在', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    setValue(ctx, '#f-body', 'body');
    clickEl(ctx, '#composer-send');
    clickMaskBlank(ctx); // blocked while sending
    ok(composerOpen(ctx), '发送中遮罩点击被拦下');
    ctx.stub.settleSend(500, { error: 'network' });
    await ticks(ctx.win, 20);
    ok(composerOpen(ctx), '失败后弹窗仍打开');
    ok(val(ctx, '#f-body') === 'body', '失败后正文仍在', val(ctx, '#f-body'));
    ok(evalIn(ctx, 'isComposerDirty()') === true, '失败后仍判脏');
  });

  /* ---- T4 reply composer baseline ---- */
  await test('T4a 回复预填不算「写了一半」：点外部直接关闭、且不产生草稿', async (ctx) => {
    openReply(ctx);
    ok(composerOpen(ctx), '回复弹窗已打开');
    ok(val(ctx, '#f-to') === 'sender@example.com', '收件人已预填', val(ctx, '#f-to'));
    ok(val(ctx, '#f-subject') === 'Re: Hello', '主题已预填', val(ctx, '#f-subject'));
    ok(evalIn(ctx, 'isComposerDirty()') === false, '仅预填 -> isComposerDirty()=false');
    ok(evalIn(ctx, 'hasDraftContent()') === false, '⭐ 仅预填 -> hasDraftContent()=false（预填的收件人不是「用户写的」）');
    ctx.stub.calls.length = 0;
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '回复仅预填点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '回复仅预填点外部 -> 直接关闭');
    await ticks(ctx.win, 3);
    ok(ctx.stub.calls.filter((c) => c.url.startsWith('/api/drafts/')).length === 0,
      '⭐ 点开回复又关掉 -> 一条草稿请求都不发（否则草稿箱会堆满用户没写过的回信）',
      String(ctx.stub.calls.length));
  });

  await test('T4b 回复点「引用原文」改正文 -> 关窗时随草稿保存', async (ctx) => {
    openReply(ctx);
    clickEl(ctx, '#f-quote');
    ok(val(ctx, '#f-body').length > 0, '引用后正文非空', `len=${val(ctx, '#f-body').length}`);
    ok(evalIn(ctx, 'isComposerDirty()') === true, '引用原文后 -> isComposerDirty()=true');
    ctx.stub.calls.length = 0;
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '不再弹确认框');
    ok(!composerOpen(ctx), '弹窗已关闭');
    await ticks(ctx.win, 3);
    const put = lastDraftCall(ctx);
    ok(put !== null && put.method === 'PUT', '引用内容已写入草稿', put && put.method);
    let body = null;
    try { body = JSON.parse(put.body); } catch { /* let the assertion below report the error */ }
    ok(body !== null && String(body.body).includes('line1'), '草稿正文含引用内容');
    ok(body !== null && body.mode === 'reply', '草稿记录了「回复」模式');
  });

  await test('T4c 回复中用户改动主题 -> 关窗时随草稿保存', async (ctx) => {
    openReply(ctx);
    setValue(ctx, '#f-subject', 'Re: Hello!');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '改动主题后判脏');
    ctx.stub.calls.length = 0;
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '不再弹确认框');
    await ticks(ctx.win, 3);
    const put = lastDraftCall(ctx);
    let body = null;
    try { body = JSON.parse(put.body); } catch { /* let the assertion below report the error */ }
    ok(body !== null && body.subject === 'Re: Hello!', '改过的主题随草稿保存');
  });

  await test('T4d 回复中用户清空预填主题 -> 关窗时仍落草稿（正文有预填引用）', async (ctx) => {
    openReply(ctx);
    setValue(ctx, '#f-subject', '');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '清空预填主题 -> 判脏（与基线不同）');
    ctx.stub.calls.length = 0;
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '不再弹确认框');
    ok(!composerOpen(ctx), '弹窗已关闭');
    await ticks(ctx.win, 3);
    ok(lastDraftCall(ctx) !== null, '产生了草稿写请求');
  });

  /* ---- T5 open/close state reset ---- */
  await test('T5a 存草稿关闭后重开：状态全部复位、草稿 id 换新', async (ctx) => {
    await openCompose(ctx);
    const firstId = evalIn(ctx, 'state.composing.draftId');
    setValue(ctx, '#f-subject', '草稿');
    clickMaskBlank(ctx);
    ok(!composerOpen(ctx), '已关闭');

    await openCompose(ctx);
    ok(composerOpen(ctx), '重新打开写信弹窗');
    ok(!confirmShown(ctx), '重开后确认框保持隐藏（无残留）');
    ok(pendingFlag(ctx) === false, '重开后 pending=false');
    ok(baselineOf(ctx) !== null, '重开后已建立新基线');
    ok(val(ctx, '#f-to') === '' && val(ctx, '#f-subject') === '' && val(ctx, '#f-body') === '', '重开后字段清空');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '重开后不脏');
    ok(evalIn(ctx, 'state.composing.draftId') !== firstId, '重开后是新的草稿 id（不会覆盖上一封）');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '重开后点外部 -> 直接关闭');
  });

  await test('T5b 有内容时再次调用 openComposer -> 状态重置、确认框保持隐藏', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '草稿');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '关窗后确认框始终隐藏');
    evalIn(ctx, 'openComposer()'); // equivalent to clicking "compose" again
    ok(!confirmShown(ctx), 'openComposer 后确认框保持隐藏');
    ok(pendingFlag(ctx) === false, 'openComposer 后 pending=false');
    ok(evalIn(ctx, 'isComposerDirty()') === false, 'openComposer 后不脏（新基线）');
    ok(confirmMaskCount(ctx) === 1, '未产生重复确认框 DOM', confirmMaskCount(ctx));
  });

  /* ---- T6 rich text ---- */
  await test('T6a 仅切换富文本按钮不弄脏表单', async (ctx) => {
    await openCompose(ctx);
    await toRich(ctx);
    ok(evalIn(ctx, 'isComposerDirty()') === false, '空表单切到富文本 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '切富文本后点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '切富文本后点外部 -> 直接关闭');
  });

  await test('T6b 先有文字再切富文本 -> 仍判脏', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-body', 'hello');
    await toRich(ctx);
    ok(evalIn(ctx, 'document.querySelector("#f-body-rich").textContent') === 'hello', '切富文本后文字被搬进富文本编辑器', evalIn(ctx, 'document.querySelector("#f-body-rich").textContent'));
    ok(evalIn(ctx, 'isComposerDirty()') === true, '切富文本后仍判脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '切富文本后点外部 -> 存草稿并关闭');
  });

  const richNotDirty = [
    ['<br>', '<br>'],
    ['<div></div>', '<div></div>'],
    ['&nbsp;', '&nbsp;'],
    ['<br><div></div>&nbsp;', '<br><div></div>&nbsp;'],
  ];
  for (const [label, markup] of richNotDirty) {
    await test(`T6c 富文本仅 ${label} 不算脏`, async (ctx) => {
      await openCompose(ctx);
      await toRich(ctx);
      evalIn(ctx, `document.querySelector("#f-body-rich").innerHTML = ${JSON.stringify(markup)}`);
      const pt = evalIn(ctx, 'richPlainText(document.querySelector("#f-body-rich"))');
      ok(pt === '', `richPlainText(${label}) 为空`, JSON.stringify(pt));
      ok(evalIn(ctx, 'isComposerDirty()') === false, `富文本仅 ${label} -> 不脏`);
      clickMaskBlank(ctx);
      ok(!confirmShown(ctx) && !composerOpen(ctx), `富文本仅 ${label} 点外部 -> 直接关闭`);
    });
  }

  await test('T6d 富文本有真实文字 -> 判脏', async (ctx) => {
    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "x"');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '富文本有文字 -> 脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '富文本有文字点外部 -> 存草稿并关闭');
  });

  /* ---- T7 draft auto-save (debounced) ---- */
  const wait = (ctx, ms) => new Promise((r) => ctx.win.setTimeout(r, ms));
  const draftCalls = (ctx) => ctx.stub.calls.filter((c) => c.url.startsWith('/api/drafts/'));

  await test('T7a 输入后自动保存：防抖窗口内不发请求，到点只发一次 PUT', async (ctx) => {
    await openCompose(ctx);
    ctx.stub.calls.length = 0;
    setValue(ctx, '#f-subject', '草');
    setValue(ctx, '#f-subject', '草稿');
    setValue(ctx, '#f-subject', '草稿A');
    ok(draftCalls(ctx).length === 0, '防抖窗口内还没发请求');
    await wait(ctx, 1500);
    const puts = draftCalls(ctx).filter((c) => c.method === 'PUT');
    ok(puts.length === 1, '防抖到点只发一次 PUT', `puts=${puts.length}`);
    let body = null;
    try { body = JSON.parse(puts[0].body); } catch { /* let the assertion below report the error */ }
    ok(body !== null && body.subject === '草稿A', '提交的是最新内容');
    ok(composerOpen(ctx), '自动保存不关窗');
  });

  await test('T7b 输入后又清空 -> 自动删除已落盘的草稿（不留空条目）', async (ctx) => {
    await openCompose(ctx);
    const draftId = evalIn(ctx, 'state.composing.draftId');
    ctx.stub.calls.length = 0;
    setValue(ctx, '#f-subject', 'x');
    await wait(ctx, 1500);
    ok(draftCalls(ctx).some((c) => c.method === 'PUT'), '先自动落盘一次草稿');
    ctx.stub.calls.length = 0;
    setValue(ctx, '#f-subject', '');
    await wait(ctx, 1500);
    const del = lastDraftCall(ctx);
    ok(del !== null && del.method === 'DELETE' && del.url === `/api/drafts/${draftId}`, '内容清空后自动删除草稿', del && `${del.method} ${del.url}`);
  });

  await test('T7c 关窗后不再有在途的自动保存（定时器已清）', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '草稿');
    ctx.stub.calls.length = 0;
    clickMaskBlank(ctx);
    await ticks(ctx.win, 3);
    const before = draftCalls(ctx).length;
    await wait(ctx, 1500);
    const after = draftCalls(ctx).length;
    ok(after === before, '关窗后防抖定时器已清，不再重复发请求', `${before} -> ${after}`);
    ok(!composerOpen(ctx), '弹窗保持关闭');
  });

  await test('T7d 点弹窗内部不触发关闭', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '草稿');
    clickComposerInside(ctx);
    ok(composerOpen(ctx), '点 #composer 内部 -> 弹窗不关闭');
    ok(composing(ctx) !== null, '内容未丢');
    ok(!confirmShown(ctx), '确认框全程隐藏');
  });

  /* ---- T8 edge cases ---- */
  await test('T8a 只输入一个空格（纯文本正文）-> 不脏、直接关闭', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-body', ' ');
    const dirty = evalIn(ctx, 'isComposerDirty()');
    info(`纯文本正文仅一个半角空格 -> isComposerDirty()=${dirty}`);
    ok(dirty === false, '纯文本仅空格 -> 不脏（Fix 2 norm() 归一化）');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '纯文本仅空格点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '纯文本仅空格点外部 -> 直接关闭');
  });

  await test('T8b 只输入一个空格（主题/收件人）-> 不脏、直接关闭', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', ' ');
    setValue(ctx, '#f-to', '  ');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '主题与收件人仅空格 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '主题/收件人仅空格点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '主题/收件人仅空格点外部 -> 直接关闭');
  });

  await test('T8c 只输入空格（富文本）-> 不脏（两种模式一致）', async (ctx) => {
    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "&nbsp;"');
    const dirty = evalIn(ctx, 'isComposerDirty()');
    info(`富文本仅 &nbsp;（等价一个空格）-> isComposerDirty()=${dirty}`);
    ok(dirty === false, '富文本仅空格 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '富文本仅空格点外部 -> 直接关闭');
  });

  await test('T8h 反向保护：纯文本真的输入文字、不切换模式 -> 存草稿并关闭', async (ctx) => {
    await openCompose(ctx);
    const draftId = evalIn(ctx, 'state.composing.draftId');
    setValue(ctx, '#f-body', 'hi');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '纯文本 "hi"（未切模式）-> 判脏');
    ctx.stub.calls.length = 0;
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '纯文本 "hi" 点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '纯文本 "hi" 点外部 -> 存草稿后关闭');
    await ticks(ctx.win, 3);
    const put = lastDraftCall(ctx);
    let body = null;
    try { body = JSON.parse(put.body); } catch { /* let the assertion below report the error */ }
    ok(put !== null && put.url === `/api/drafts/${draftId}`, '写入打开时生成的那个草稿 id', put && put.url);
    ok(body !== null && body.body === 'hi', '草稿正文 = "hi"（内容未丢）', body && body.body);
  });

  await test('T8d 输入后又清空 -> 回到不脏、直接关闭', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '临时');
    setValue(ctx, '#f-to', 'x@y.com');
    setValue(ctx, '#f-body', 'temp');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '输入后判脏');
    setValue(ctx, '#f-subject', '');
    setValue(ctx, '#f-to', '');
    setValue(ctx, '#f-body', '');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '全部清空后 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '清空后点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '清空后点外部 -> 直接关闭');
  });

  await test('T8e 只加附件后点外部 -> 存草稿并关闭（附件本身不随草稿持久化，已知限制）', async (ctx) => {
    await openCompose(ctx);
    const draftId = evalIn(ctx, 'state.composing.draftId');
    const r = await addAttachment(ctx, 'only.txt');
    ok(r.ok, '附件已加入 state.composing.files', r.reason || `count=${r.count}`);
    ok(evalIn(ctx, 'isComposerDirty()') === true, '仅附件 -> 判脏');
    ok(evalIn(ctx, 'hasDraftContent()') === true, '仅附件也算「有内容」，关窗时不会被静默丢弃');
    ctx.stub.calls.length = 0;
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '仅附件点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '仅附件点外部 -> 存草稿后关闭');
    await ticks(ctx.win, 3);
    const put = lastDraftCall(ctx);
    ok(put !== null && put.method === 'PUT' && put.url === `/api/drafts/${draftId}`, '仍然落一份草稿（让用户知道东西去哪了）', put && `${put.method} ${put.url}`);
    // Known limitation: attachments are in-memory base64, far exceeding D1's per-row limit, so they are not persisted with the draft.
    // Attachments must be re-added when restoring a draft -- this limitation is documented in the handoff notes, not asserted here (to avoid turning a limitation into an expectation).
    info('已知限制：附件不随草稿持久化（D1 单行上限），恢复草稿后需重新添加');
  });

  await test('T8f 移除附件后 -> 回到不脏', async (ctx) => {
    await openCompose(ctx);
    const r = await addAttachment(ctx, 'only.txt');
    if (!r.ok) throw new Error(`附件桩失败: ${r.reason}`);
    const rm = el(ctx, '#f-attach-list .rm');
    ok(!!rm, '附件 chip 上有移除按钮');
    rm.dispatchEvent(clickEvt(ctx.win));
    await ticks(ctx.win, 3);
    ok(evalIn(ctx, 'state.composing.files.length') === 0, '附件已移除', evalIn(ctx, 'state.composing.files.length'));
    ok(evalIn(ctx, 'isComposerDirty()') === false, '移除附件后 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '移除附件后点外部 -> 直接关闭');
  });

  await test('T8g Fix1 重点攻击：隐藏编辑器残留不再造成假提示', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-body', 'hi');
    await toRich(ctx);
    // After switching to rich text the visible content = hi; here we simulate the user deleting all visible content in the rich text editor
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = ""');
    const visible = evalIn(ctx, 'richPlainText(document.querySelector("#f-body-rich"))');
    const bodyStill = val(ctx, '#f-body');
    const dirty = evalIn(ctx, 'isComposerDirty()');
    info(`富文本可见内容="${visible}"  隐藏 #f-body 残留="${bodyStill}"  isComposerDirty=${dirty}`);
    ok(bodyStill === 'hi', '前提成立：隐藏的 #f-body 确实仍残留 "hi"', JSON.stringify(bodyStill));
    ok(visible === '', '可见富文本内容已为空');
    ok(dirty === false, 'Fix 1：只认可见编辑器 -> 不脏（修复前的假提示已消除）');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '该情形点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '该情形点外部 -> 直接关闭');
  });

  /* ---- T9 addendum: after failure sendInFlight must reset, otherwise closing would be permanently blocked by "sending" ---- */
  await test('T9 发送失败后 sendInFlight 复位，后续点外部不再被「发送中」拦截', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    setValue(ctx, '#f-body', 'body');
    clickEl(ctx, '#composer-send');
    ctx.stub.settleSend(500, { error: 'boom' });
    await ticks(ctx.win, 20);
    ok(sendFlag(ctx) === false, '失败后 sendInFlight=false');
    clickMaskBlank(ctx);
    ok(!composerOpen(ctx), '失败后点外部 -> 正常走关闭路径（没有被「发送中」拦住）');
    ok(!toastText(ctx).includes('正在发送中'), 'toast 不再是「发送中」文案', toastText(ctx));
  });

  /* ---- T10 overlay CSS contract + "discard confirm" fully retired (no trigger path) ---- */
  await test('T10 覆盖层 CSS 契约 +「放弃确认」已无调用点', async (ctx) => {
    const block = (sel) => {
      const i = APP_CSS.indexOf(`${sel} {`);
      if (i < 0) return null;
      const j = APP_CSS.indexOf('}', i);
      return APP_CSS.slice(i, j);
    };
    const modal = block('#modal-mask');
    const preview = block('#att-preview');
    const hidden = /\.hidden\s*\{[^}]*display:\s*none\s*!important/.test(APP_CSS);
    const z = (s) => { const m = s && s.match(/z-index:\s*(\d+)/); return m ? Number(m[1]) : NaN; };

    ok(hidden, '.hidden 使用 display:none !important（否则 id 选择器会盖过 .hidden）');
    ok(!!modal && /position:\s*fixed/.test(modal) && /inset:\s*0/.test(modal), '#modal-mask 为全屏 fixed 遮罩');
    ok(!!preview && /position:\s*fixed/.test(preview) && /inset:\s*0/.test(preview), '#att-preview 为全屏 fixed 遮罩');
    ok(z(preview) > z(modal), `#att-preview z-index(${z(preview)}) > #modal-mask z-index(${z(modal)}) -> 附件预览盖在写信弹窗之上`);

    // The "pop a discard confirm when closing" path must disappear completely. showDiscardConfirm still remains in the source
    // (this suite uses it as a "never appears" regression anchor), but it must have no call sites --
    // if anyone wires it back, this assertion fails immediately, reminding that "auto-save draft" was reverted to the old semantics.
    const callSites = APP_JS.split('\n')
      .filter((l) => /showDiscardConfirm\s*\(/.test(l) && !/^\s*function\s+showDiscardConfirm\s*\(/.test(l));
    ok(callSites.length === 0, '⭐ showDiscardConfirm 已无任何调用点：关窗不再弹「是否放弃」', callSites.join(' | ') || '（无）');
    info(`modal z=${z(modal)} preview z=${z(preview)}`);
  });

  /* ---- T11 whether changing the sender dropdown (from mailbox) counts as dirty ---- */
  await test('T11 Fix3：只切换发件邮箱 -> 判脏，但没什么可存（不发草稿请求）', async (ctx) => {
    await openCompose(ctx);
    const sel = el(ctx, '#f-mailbox');
    const options = Array.from(sel.options).map((o) => o.value);
    ok(options.length >= 2, '发件邮箱下拉有多个选项', options.join(','));
    ok(evalIn(ctx, 'isComposerDirty()') === false, '未改动时不脏');
    const original = sel.value;
    const other = options.find((v) => v !== original);
    sel.value = other;
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    const dirty = evalIn(ctx, 'isComposerDirty()');
    info(`切换发件邮箱 ${original} -> ${other} 后 isComposerDirty()=${dirty}`);
    ok(dirty === true, 'Fix 3：仅切换发件邮箱 -> 判脏（发件人已纳入基线）');
    ok(evalIn(ctx, 'hasDraftContent()') === false,
      '⭐ 但「有没有内容可存」是另一回事：只换下拉 -> hasDraftContent()=false');
    ctx.stub.calls.length = 0;
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '仅切换发件邮箱点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '仅切换发件邮箱点外部 -> 直接关闭');
    await ticks(ctx.win, 3);
    ok(ctx.stub.calls.filter((c) => c.url.startsWith('/api/drafts/')).length === 0,
      '⭐ 没有可落库的内容 -> 一条草稿请求都不发（否则草稿箱会多出空条目）',
      String(ctx.stub.calls.length));
  }, { mailboxes: [{ mailbox: 'me@example.com' }, { mailbox: 'alias@example.com' }] });

  await test('T11b 发件邮箱改回原值 -> 回到不脏', async (ctx) => {
    await openCompose(ctx);
    const sel = el(ctx, '#f-mailbox');
    const original = sel.value;
    const other = Array.from(sel.options).map((o) => o.value).find((v) => v !== original);
    sel.value = other;
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    ok(evalIn(ctx, 'isComposerDirty()') === true, '改发件人 -> 脏');
    sel.value = original;
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    ok(evalIn(ctx, 'isComposerDirty()') === false, '改回原值 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '改回原值点外部 -> 直接关闭');
  }, { mailboxes: [{ mailbox: 'me@example.com' }, { mailbox: 'alias@example.com' }] });

  /* ---- T11g change sender with body present: the draft must remember the changed address (not fall back to the default) ---- */
  await test('T11g 改发件人 + 写正文 -> 草稿里的 mailbox 是改选后的地址', async (ctx) => {
    await openCompose(ctx);
    const draftId = evalIn(ctx, 'state.composing.draftId');
    const sel = el(ctx, '#f-mailbox');
    const original = sel.value;
    const other = Array.from(sel.options).map((o) => o.value).find((v) => v !== original);
    sel.value = other;
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    setValue(ctx, '#f-body', '正文');
    ctx.stub.calls.length = 0;
    clickMaskBlank(ctx);
    await ticks(ctx.win, 3);
    const put = lastDraftCall(ctx);
    let body = null;
    try { body = JSON.parse(put.body); } catch { /* let the assertion below report the error */ }
    ok(put !== null && put.url === `/api/drafts/${draftId}`, 'PUT 到打开时那个草稿 id', put && put.url);
    ok(body !== null && body.mailbox === other, '⭐ 草稿记住改选后的发件人（否则恢复草稿时会用错地址发信）', body && JSON.stringify(body.mailbox));
  }, { mailboxes: [{ mailbox: 'me@example.com' }, { mailbox: 'alias@example.com' }] });

  /* ---- T11c reply: changing the sender must go into the request body (the backend once ignored it entirely) ---- */
  await test('T11c 回信时改选发件人 -> 请求体必须带上所选 mailbox', async (ctx) => {
    const orig = 'me@example.com';
    const other = 'alias@example.com';
    openReply(ctx, { mailbox: orig });
    await ticks(ctx.win, 2);
    ok(composerOpen(ctx), '回复弹窗已打开');

    const sel = el(ctx, '#f-mailbox');
    const opts = Array.from(sel.options).map((o) => o.value);
    ok(opts.join(',') === `${orig},${other}`, '发件人下拉含两个地址（否则下面的改选无从谈起）', opts.join(','));
    ok(sel.value === orig, '默认沿用「收到原邮件的那个信箱」', sel.value);

    sel.value = other;
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    setValue(ctx, '#f-body', '回复内容');
    clickEl(ctx, '#composer-send');
    ok(ctx.stub.hasPendingSend(), '发送请求已发出且挂起');

    const sent = ctx.stub.calls.filter((c) => c.method === 'POST' && /\/api\/messages\/m1\/reply$/.test(c.url));
    ok(sent.length === 1, '恰好 1 个回信请求（按 c.url 过滤，不是拿正则直接测对象）',
      sent.map((c) => c.url).join(',') || '（无）');
    const body = sent.length ? JSON.parse(sent[0].body) : null;
    ok(body && body.mailbox === other,
      '请求体 mailbox 是用户改选的地址（否则后端只能退回原邮件的收件信箱）',
      body && JSON.stringify(body.mailbox));
    ok(body && body.merge === undefined, '回信请求不得携带 merge（合并发送只对写信生效）');

    ctx.stub.settleSend(200, { ok: true });
    await ticks(ctx.win, 15);
  }, { mailboxes: [{ mailbox: 'me@example.com' }, { mailbox: 'alias@example.com' }] });

  /* ---- T11d sender: its own row + collapsed by default, summary always in sync ---- */
  await test('T11d 发件人独立一行：默认折叠、点开可选、摘要跟着选择走', async (ctx) => {
    await openCompose(ctx);
    const hid = (sel) => el(ctx, sel).classList.contains('hidden');
    const sel = el(ctx, '#f-mailbox');

    ok(!hid('#f-sender-row'), '发件人摘要行可见（独占一行，不再和收件人抢宽度）');
    ok(hid('#f-mailbox-row'), '⭐ 默认折叠：下拉行收起');
    ok(!hid('#f-to'), '收件人字段照常在（没有被发件人顶掉）');
    ok(el(ctx, '#f-sender-current').textContent === sel.value,
      '⭐ 折叠态摘要写着当前发件人（收起 ≠ 看不见用哪个地址发）',
      el(ctx, '#f-sender-current').textContent);
    ok(el(ctx, '#f-sender-toggle').getAttribute('aria-expanded') === 'false', 'aria-expanded=false');

    clickEl(ctx, '#f-sender-toggle');
    ok(!hid('#f-mailbox-row'), '⭐ 点开 -> 下拉行展开');
    ok(el(ctx, '#f-sender-toggle').getAttribute('aria-expanded') === 'true', '展开后 aria-expanded=true');

    const other = Array.from(sel.options).map((o) => o.value).find((v) => v !== sel.value);
    sel.value = other;
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    ok(el(ctx, '#f-sender-current').textContent === other,
      '⭐ 改选后摘要同步（不同步的话收起来会显示旧地址）', el(ctx, '#f-sender-current').textContent);
    ok(evalIn(ctx, 'isComposerDirty()') === true, '改过发件人 -> 判脏');

    clickEl(ctx, '#f-sender-toggle');
    ok(hid('#f-mailbox-row'), '再点一次 -> 收起');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '⭐ 收起只是收 UI，判脏不受影响');

    setValue(ctx, '#f-to', 'someone@x.com');
    setValue(ctx, '#f-body', '正文');
    clickEl(ctx, '#composer-send');
    ok(ctx.stub.hasPendingSend(), '发送请求已发出且挂起');
    const sent = ctx.stub.calls.filter((c) => c.method === 'POST' && /\/api\/messages$/.test(c.url));
    const body = sent.length ? JSON.parse(sent[0].body) : null;
    ok(body && body.mailbox === other,
      '⭐ 折叠状态下发信，请求体照样带上改选后的发件人', body && JSON.stringify(body.mailbox));
    ctx.stub.settleSend(200, { ok: true });
    await ticks(ctx.win, 15);
  }, { mailboxes: [{ mailbox: 'me@example.com' }, { mailbox: 'alias@example.com' }] });

  /* ---- T11e only one sender address: don't give the illusion of "expandable" ---- */
  await test('T11e 只有一个发件地址：摘要行不显示箭头，点了也不展开', async (ctx) => {
    await openCompose(ctx);
    const hid = (sel) => el(ctx, sel).classList.contains('hidden');
    ok(!hid('#f-sender-row'), '摘要行仍可见（至少让人知道用哪个地址发）');
    ok(el(ctx, '#f-sender-row').classList.contains('sender-solo'), '⭐ 单地址时带 sender-solo（CSS 靠它藏箭头）');
    clickEl(ctx, '#f-sender-toggle');
    ok(hid('#f-mailbox-row'), '⭐ 点了也不展开（只有一个选项，展开是空转）');
    ok(el(ctx, '#f-sender-current').textContent === 'me@example.com',
      '摘要就是那唯一的地址', el(ctx, '#f-sender-current').textContent);
  }, { mailboxes: [{ mailbox: 'me@example.com' }] });

  /* ---- T11f the sending identity is shown only once at the top (the duplicate, misnamed hint at the bottom was removed) ---- */
  await test('T11f 写信弹窗的操作行里不得再挂「发信身份」文字', async (ctx) => {
    await openCompose(ctx);
    ok(composerOpen(ctx), '前置：写信弹窗已打开（否则下面的断言空转）');

    ok(el(ctx, '#composer-info') === null,
      '⭐ #composer-info 已删除：它把 SEND_FROM_NAME 和实际发件地址拼在一起，回复/转发时会显示成「support <别人的地址>」');

    const acts = el(ctx, '.composer-actions');
    ok(!!acts, '.composer-actions 存在');
    ok(acts.querySelectorAll('span').length === 0,
      '⭐ 操作行里只剩按钮，没有多余的文字节点（发件人只在顶部那一行显示）',
      acts.querySelectorAll('span').length);
    const labels = Array.from(acts.querySelectorAll('button')).map((b) => b.textContent);
    ok(labels.join(',') === '取消,发送', '操作行就是「取消 / 发送」两个按钮', labels.join(','));
  }, { mailboxes: [{ mailbox: 'me@example.com' }] });

  /* ---- T13 norm() normalization edges ---- */
  await test('T13 norm() 边界：null/undefined/各类空白', async (ctx) => {
    const probe = (expr) => evalIn(ctx, `(() => { const r = norm(${expr}); return JSON.stringify(r); })()`);
    const cases = [
      ['norm(null)', 'null', '""'],
      ['norm(undefined)', 'undefined', '""'],
      ["norm('')", "''", '""'],
      ["norm('  ')", "'  '", '""'],
      ["norm('\\t\\n\\r')", "'\\t\\n\\r'", '""'],
      ["norm('\\u00a0')", "'\\u00a0'", '""'],
      ["norm('\\u3000')", "'\\u3000'", '""'],
      ["norm(' \\u3000 \\u00a0 ')", "' \\u3000 \\u00a0 '", '""'],
      ["norm('\\u3000x\\u3000')", "'\\u3000x\\u3000'", '"x"'],
      ["norm(' a b ')", "' a b '", '"a b"'],
      ['norm(0)', '0', '"0"'],
    ];
    for (const [label, expr, expect] of cases) {
      const got = probe(expr);
      ok(got === expect, `${label} -> ${expect}`, `实际 ${got}`);
    }
    info('JS trim() 的 WhiteSpace 含 U+3000 全角空格与 U+00A0 NBSP，实测已被去掉');
  });

  /* ---- T14 behavior consistency for full-width space / various whitespace ---- */
  const blankCases = [
    ['主题=全角空格', (ctx) => setValue(ctx, '#f-subject', '\u3000'), '#f-subject'],
    ['收件人=全角空格', (ctx) => setValue(ctx, '#f-to', '\u3000'), '#f-to'],
    ['正文=全角空格', (ctx) => setValue(ctx, '#f-body', '\u3000'), '#f-body'],
    ['正文=NBSP', (ctx) => setValue(ctx, '#f-body', '\u00a0'), '#f-body'],
    ['正文=换行制表符', (ctx) => setValue(ctx, '#f-body', '\n\t'), '#f-body'],
    ['正文=半角+全角混合', (ctx) => setValue(ctx, '#f-body', ' \u3000 \u00a0 '), '#f-body'],
  ];
  for (const [label, make, sel] of blankCases) {
    await test(`T14 ${label} -> 不脏、直接关闭`, async (ctx) => {
      await openCompose(ctx);
      make(ctx);
      const dirty = evalIn(ctx, 'isComposerDirty()');
      info(`${label} -> isComposerDirty()=${dirty}`);
      ok(dirty === false, `${label} -> 不脏`);
      clickMaskBlank(ctx);
      ok(!confirmShown(ctx) && !composerOpen(ctx), `${label} 点外部 -> 直接关闭、无提示`);
    });
  }

  await test('T14b 富文本=全角空格 -> 不脏（与纯文本一致）', async (ctx) => {
    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "\\u3000"');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '富文本仅全角空格 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '富文本仅全角空格点外部 -> 直接关闭');
  });

  await test('T14c 全角空格 + 真实文字 -> 判脏', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '\u3000x\u3000');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '全角空格包裹真实文字 -> 判脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '点外部 -> 存草稿并关闭');
  });

  await test('T14d 基线非空（回复预填主题）时首尾空格不改变判定', async (ctx) => {
    openReply(ctx); // baseline subject = "Re: Hello"
    ok(evalIn(ctx, 'isComposerDirty()') === false, '回复刚打开、未改动 -> 不脏');
    setValue(ctx, '#f-subject', 'Re: Hello   ');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '主题尾部加空格 -> 不脏（norm 去首尾空白）');
    setValue(ctx, '#f-subject', '   Re: Hello');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '主题首部加空格 -> 不脏');
    setValue(ctx, '#f-subject', '\u3000Re: Hello\u3000');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '主题首尾加全角空格 -> 不脏');
    setValue(ctx, '#f-subject', 'Re: Hello!');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '主题真的加字 -> 脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '点外部 -> 存草稿并关闭');
  });

  await test('T14e 内部空格差异仍算脏（norm 只去首尾、不折叠内部）', async (ctx) => {
    openReply(ctx); // baseline subject = "Re: Hello"
    setValue(ctx, '#f-subject', 'Re:  Hello');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '主题内部多一个空格 -> 仍脏（norm 不做内部归一化）');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '点外部 -> 存草稿并关闭');
  });

  /* ---- T14f real text with leading/trailing spaces in the body under an empty baseline -> still dirty ---- */
  await test('T14f 空基线下正文首尾带空格的真实文字 -> 仍脏', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-body', '  hello  ');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '基线为空、正文 "  hello  " -> 脏（去空格后仍有内容）');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '点外部 -> 存草稿并关闭');
  });

  /* ---- T16 consistency between guard-empty and send-validation (re-check kou's N1 fix) ---- */
  await test('T16 守卫判空 ⟺ 发送拒绝（htmlHasText 复用 richPlainText）', async (ctx) => {
    const cases = [
      ['<div>&nbsp;</div>', '实体 &nbsp;'],
      ['<div>&#160;</div>', '实体 &#160;'],
      ['<div> </div>', '裸空格'],
      ['<div><br></div>', '仅 <br>'],
      ['<img src="x">', '纯图片（无文字）'],
      ['<div>hi</div>', '真实文字'],
    ];
    for (const [markup, label] of cases) {
      const c = await boot();
      try {
        await openCompose(c);
        await toRich(c);
        evalIn(c, `document.querySelector("#f-body-rich").innerHTML = ${JSON.stringify(markup)}`);
        const guardDirty = evalIn(c, 'isComposerDirty()'); // recipient/subject are both empty, so it only reflects the body
        setValue(c, '#f-to', 'a@b.com');
        clickEl(c, '#composer-send');
        const sent = c.stub.hasPendingSend();
        info(`markup=${markup}  守卫判脏=${guardDirty}  发送放行=${sent}  toast="${toastText(c)}"`);
        ok(guardDirty === sent, `${label}：守卫判脏(${guardDirty}) 与 发送放行(${sent}) 口径一致`);
        if (sent) { c.stub.settleSend(200, { ok: true }); await ticks(c.win, 15); }
      } finally {
        c.close();
      }
    }
  });

  await test('T16b 有文字 + 图片：守卫判脏、发送放行且 html 原样保留', async (ctx) => {
    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "<div>hi<img src=\\"x\\"></div>"');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '文字+图片 -> 守卫判脏');
    setValue(ctx, '#f-to', 'a@b.com');
    clickEl(ctx, '#composer-send');
    ok(ctx.stub.hasPendingSend() === true, '发送放行');
    const post = ctx.stub.calls.find((x) => x.method === 'POST' && x.url.startsWith('/api/messages'));
    const payload = post && post.body ? JSON.parse(post.body) : null;
    info(`payload.html = ${payload && JSON.stringify(payload.html)}`);
    ok(!!payload && typeof payload.html === 'string' && payload.html.includes('<img'), 'payload.html 未被丢弃、图片仍在', payload && String(payload.html));
    if (ctx.stub.hasPendingSend()) { ctx.stub.settleSend(200, { ok: true }); await ticks(ctx.win, 15); }
  });


  await test('T15 富文本仅 &nbsp;：守卫判空且发送拒绝（N1 修复验证）', async (ctx) => {
    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "&nbsp;"');
    const dirty = evalIn(ctx, 'isComposerDirty()');
    info(`富文本仅 &nbsp;（收件人/主题均为空）-> isComposerDirty()=${dirty}`);
    ok(dirty === false, '守卫：仅 &nbsp; 视为无内容');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '仅 &nbsp; 点外部 -> 直接关闭、不提示');

    // Send side: htmlHasText now reuses richPlainText, so it should likewise treat this as "no content"
    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "&nbsp;"');
    setValue(ctx, '#f-to', 'a@b.com');
    clickEl(ctx, '#composer-send');
    const sent = ctx.stub.hasPendingSend();
    info(`点发送后是否发出请求 = ${sent}；toast="${toastText(ctx)}"`);
    ok(sent === false, '发送侧：仅 &nbsp; 不再被放行（N1 口径已统一）');
    ok(toastText(ctx).includes('请填写邮件内容'), '给出「请填写邮件内容」提示', toastText(ctx));
  });

  await test('T4e 回复 + 富文本中「引用原文」-> 存草稿并关闭', async (ctx) => {
    openReply(ctx);
    await toRich(ctx);
    clickEl(ctx, '#f-quote');
    ok(evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML').includes('blockquote'), '富文本中插入了引用块');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '富文本引用后判脏');
    ctx.stub.calls.length = 0;
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '富文本引用后点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '富文本引用后点外部 -> 存草稿后关闭');
    await ticks(ctx.win, 3);
    const put = lastDraftCall(ctx);
    let body = null;
    try { body = JSON.parse(put.body); } catch { /* let the assertion below report the error */ }
    ok(put !== null && put.method === 'PUT', '富文本引用内容写入草稿', put && put.method);
    ok(body !== null && body.mode === 'reply' && body.rich === true, '草稿记录了「回复 + 富文本」模式', body && `mode=${body.mode} rich=${body.rich}`);
    ok(body !== null && String(body.html).includes('blockquote'), '草稿里保留的是 HTML（含引用块），不是被降级的纯文本');
  });

  /* ---- T12 diagnostics: impact of jsdom's missing innerText (environment limitation, not an implementation bug) ---- */
  await test('T12 诊断：jsdom 未实现 innerText 对 rich->plain 往返的影响', async (ctx) => {
    const innerTextType = evalIn(ctx, 'typeof document.querySelector("#f-body-rich").innerText');
    info(`jsdom 中 #f-body-rich.innerText 的类型 = ${innerTextType}`);
    ok(innerTextType === 'undefined', 'jsdom 未实现 innerText（记录为测试环境局限）');

    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "hello"');
    ok(evalIn(ctx, 'richPlainText(document.querySelector("#f-body-rich"))') === 'hello', 'richPlainText 经 textContent 兜底可正确取到 hello');
    clickEl(ctx, '#f-mode'); // switch back to plain text
    await ticks(ctx.win, 2);
    const taValue = val(ctx, '#f-body');
    info(`切回纯文本后 #f-body.value = ${JSON.stringify(taValue)}（真浏览器应为 "hello"）`);
    ok(taValue === 'undefined', 'jsdom 下 textarea 被写成字符串 "undefined"（环境局限：toggleRich 的 rich->plain 分支依赖 innerText）');
    info('结论：rich->plain 往返路径在 jsdom 中不可信，需真浏览器人工复核；本条不计为实现 Bug。');
  });

  /* ---- summary ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) {
    console.log('（无）');
  } else {
    for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail ? `  [${f.detail}]` : ''}`);
  }
  console.log(`\n被测版本: md5=${FINGERPRINT.md5}  mtime=${FINGERPRINT.mtime}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})();
