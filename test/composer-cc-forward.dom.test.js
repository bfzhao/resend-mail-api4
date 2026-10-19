'use strict';

/* =============================================================================
 * Recipient autocomplete / cc-bcc / forward -- real jsdom + full index.html + full app.js
 *
 * Run:
 *   NODE_PATH=<NODE_PATH> \
 *     <node.exe> test/composer-cc-forward.dom.test.js
 *
 * Exit code: 0 = all passed; 1 = some failed.
 *
 * Covers three things:
 *   1) Recipient autocomplete (to / cc / bcc share one dropdown): filter local contacts by the
 *      segment at the caret, replace only that segment on selection, keyboard up/down + Enter,
 *      Esc closes only the dropdown without closing the compose window;
 *   2) Cc / Bcc: expand/collapse, entering the request body, and the frontend blocking first when
 *      mutually exclusive with "merge send";
 *   3) Forward: read-pane button (present for both inbound and outbound), composer prefill
 *      (Fwd: subject / original quote / empty recipient), send hits /forward, warns instead of
 *      pretending success when attachments are skipped.
 *
 * This file does not modify any source under public/ and src/.
 * ===========================================================================*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
// QA_APP_JS is only for "mutation verification": points to a hand-crafted defective app.js.
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

/** Local contacts fixture: typing lili should hit the first three (name contains / email contains) but not Bob Li. */
const CONTACTS = [
  { name: 'Lili Wang', email: 'lili.wang@partner.com', count: 5 },
  { name: 'Lili Chen', email: 'lili.chen@other.com', count: 2 },
  { name: null, email: 'liliana@z.com', count: 1 },
  { name: 'Bob Li', email: 'bob@x.com', count: 9 },
];

/* ---------------------------------------------------------------------------
 * fetch stub
 * -------------------------------------------------------------------------*/
function makeFetchStub() {
  const calls = [];
  const state = {
    sendResponse: { status: 200, payload: { ok: true, id: 'row-1', resend_id: 're-1' } },
    contacts: CONTACTS,
    contactsHits: 0,
  };

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
    if (url.startsWith('/api/contacts')) {
      state.contactsHits++;
      return Promise.resolve(jsonRes({ contacts: state.contacts }));
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
    state,
    setSendResponse(status, payload) { state.sendResponse = { status, payload }; },
    sends() { return calls.filter((c) => c.method === 'POST' && /\/api\/messages(\/|$)/.test(c.url)); },
    lastSend() { const s = this.sends(); return s[s.length - 1]; },
    parseLastSendBody() { const s = this.lastSend(); return s ? JSON.parse(s.body) : null; },
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
 * Helpers
 * -------------------------------------------------------------------------*/
const clickEvt = (win) => new win.MouseEvent('click', { bubbles: true, cancelable: true });
const mouseEvt = (win) => new win.MouseEvent('mousedown', { bubbles: true, cancelable: true });
const keyEvt = (win, key) => new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });

function el(ctx, sel) { return ctx.doc.querySelector(sel); }
function clickEl(ctx, sel) { el(ctx, sel).dispatchEvent(clickEvt(ctx.win)); }
const composerOpen = (ctx) => !el(ctx, '#modal-mask').classList.contains('hidden');
const confirmShown = (ctx) => !el(ctx, '#confirm-mask').classList.contains('hidden');
const toastText = (ctx) => el(ctx, '#toast').textContent;
const val = (ctx, sel) => el(ctx, sel).value;
const evalIn = (ctx, expr) => ctx.win.eval(expr);
const composing = (ctx) => evalIn(ctx, 'state.composing');
const isDirty = (ctx) => evalIn(ctx, 'isComposerDirty()');
const suggestOpen = (ctx) => !el(ctx, '#addr-suggest').classList.contains('hidden');
const suggestItems = (ctx) => Array.from(el(ctx, '#addr-suggest').querySelectorAll('.addr-suggest-item'));
const suggestTexts = (ctx) => suggestItems(ctx).map((n) => n.textContent);
const hidden = (ctx, sel) => el(ctx, sel).classList.contains('hidden');

/** Simulate user input: write value and put the caret at the end (autocomplete takes the token at the caret). */
function typeInto(ctx, sel, text) {
  const node = el(ctx, sel);
  node.value = text;
  try { node.setSelectionRange(text.length, text.length); } catch { /* ignore */ }
  node.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
}

function setChecked(ctx, sel, v) {
  const node = el(ctx, sel);
  node.checked = v;
  node.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
}

async function openCompose(ctx) {
  clickEl(ctx, '#compose-btn');
  await ticks(ctx.win, 5); // wait for loadContacts() to settle
}

async function send(ctx) { clickEl(ctx, '#composer-send'); await ticks(ctx.win, 10); }

const MSG_IN = {
  id: 'm1', direction: 'inbound', from_email: 'alice@partner.com', from_name: 'Alice',
  to_emails: ['me@example.com'], cc: [], bcc: [], reply_to: [], subject: 'Hello',
  mailbox: 'me@example.com', received_at: 1700000000, body_text: 'line1\nline2',
  read: true, starred: false, status: 'received', attachments_count: 1,
};
const MSG_OUT = Object.assign({}, MSG_IN, { direction: 'outbound', from_email: 'me@example.com', from_name: null, status: 'sent' });
const ATTS = [{ id: 'a1', filename: 'note.txt', size: 5, inline: false, url: '/api/attachments/a1' }];

/** Render the read pane into the "some message is open" state (openId must match, otherwise the buttons do nothing). */
function renderReadFor(ctx, m, atts) {
  evalIn(ctx, `currentMessage = ${JSON.stringify(m)}; currentAttachments = ${JSON.stringify(atts || [])}; state.openId = ${JSON.stringify(m.id)}; renderRead();`);
}
function readActionButtons(ctx) {
  return Array.from(el(ctx, '#read-message').querySelectorAll('.env-actions button')).map((b) => b.textContent);
}
function clickReadAction(ctx, label) {
  const btn = Array.from(el(ctx, '#read-message').querySelectorAll('.env-actions button')).find((b) => b.textContent === label);
  if (!btn) throw new Error(`阅读面板里找不到「${label}」按钮（现有：${readActionButtons(ctx).join('/')}）`);
  btn.dispatchEvent(clickEvt(ctx.win));
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

  /* ---- D1 cc / bcc expand-collapse ---- */
  await test('D1 抄送/密送：默认收起、点击展开、有内容时不许收起', async (ctx) => {
    await openCompose(ctx);
    ok(hidden(ctx, '#f-cc-row') && hidden(ctx, '#f-bcc-row'), '默认两行都收起');
    ok(el(ctx, '#f-cc-toggle').textContent.includes('抄送'), '按钮文案含「抄送」', el(ctx, '#f-cc-toggle').textContent);

    clickEl(ctx, '#f-cc-toggle');
    ok(!hidden(ctx, '#f-cc-row') && !hidden(ctx, '#f-bcc-row'), '点击后两行都展开');

    typeInto(ctx, '#f-cc', 'cc@x.com');
    clickEl(ctx, '#f-cc-toggle');
    ok(!hidden(ctx, '#f-cc-row'), '⭐ 抄送已有内容 -> 不允许收起（否则看不见却发出去）');
    ok(toastText(ctx).includes('清空'), '给出明确提示', toastText(ctx));

    typeInto(ctx, '#f-cc', '');
    clickEl(ctx, '#f-cc-toggle');
    ok(hidden(ctx, '#f-cc-row'), '清空后可以收起');
  });

  /* ---- D2 cc/bcc go into the request body ---- */
  await test('D2 cc/bcc 进入请求体；为空时不带该字段', async (ctx) => {
    await openCompose(ctx);
    clickEl(ctx, '#f-cc-toggle');
    typeInto(ctx, '#f-to', 'a@x.com');
    typeInto(ctx, '#f-cc', 'c1@x.com, c2@x.com');
    typeInto(ctx, '#f-bcc', 's1@x.com');
    evalIn(ctx, "$('#f-body').value = 'body';");
    await send(ctx);

    const body = ctx.stub.parseLastSendBody();
    ok(!!body, '请求已发出（否则下面的断言空转）', JSON.stringify(body));
    ok(JSON.stringify(body.to) === JSON.stringify(['a@x.com']), 'to 正确', JSON.stringify(body.to));
    ok(JSON.stringify(body.cc) === JSON.stringify(['c1@x.com', 'c2@x.com']), '⭐ cc 进请求体', JSON.stringify(body.cc));
    ok(JSON.stringify(body.bcc) === JSON.stringify(['s1@x.com']), '⭐ bcc 进请求体', JSON.stringify(body.bcc));
    ok(ctx.stub.lastSend().url === '/api/messages', '打到写信接口', ctx.stub.lastSend().url);

    // Negative control: when cc/bcc are empty, don't include empty-array fields (the backend would treat them as "present")
    await openCompose(ctx);
    typeInto(ctx, '#f-to', 'a@x.com');
    evalIn(ctx, "$('#f-body').value = 'body';");
    await send(ctx);
    const b2 = ctx.stub.parseLastSendBody();
    ok(!('cc' in b2) && !('bcc' in b2), '负控制：没有 cc/bcc 时不带这两个字段', JSON.stringify(Object.keys(b2)));
  });

  /* ---- D3 merge and bcc mutually exclusive: the frontend blocks first ---- */
  await test('D3 合并发送 + 密送：前端先拦下，不发请求', async (ctx) => {
    await openCompose(ctx);
    clickEl(ctx, '#f-cc-toggle');
    typeInto(ctx, '#f-to', 'a@x.com, b@y.com');
    typeInto(ctx, '#f-bcc', 's@x.com');
    evalIn(ctx, "$('#f-body').value = 'body';");
    setChecked(ctx, '#f-merge', true);
    const before = ctx.stub.sends().length;
    await send(ctx);
    ok(ctx.stub.sends().length === before, '⭐ 一个请求都没发', `${before} -> ${ctx.stub.sends().length}`);
    ok(toastText(ctx).includes('密送'), '提示里说明是密送冲突', toastText(ctx));
    ok(composerOpen(ctx), '弹窗保持打开，内容不丢');

    // Negative control: after clearing bcc the same input can be sent
    typeInto(ctx, '#f-bcc', '');
    await send(ctx);
    ok(ctx.stub.sends().length === before + 1, '负控制：清空密送后能正常发送', ctx.stub.sends().length);
  });

  /* ---- D4 the "forward" button in the read pane ---- */
  await test('D4 阅读面板：入站有「回复+转发」，出站也有「转发」（无回复）', async (ctx) => {
    renderReadFor(ctx, MSG_IN, ATTS);
    const inBtns = readActionButtons(ctx);
    ok(inBtns.includes('回复'), '入站有「回复」', inBtns.join('/'));
    ok(inBtns.includes('转发'), '⭐ 入站有「转发」', inBtns.join('/'));

    renderReadFor(ctx, MSG_OUT, ATTS);
    const outBtns = readActionButtons(ctx);
    ok(outBtns.includes('转发'), '⭐ 出站（已发送）的邮件也有「转发」', outBtns.join('/'));
    ok(!outBtns.includes('回复'), '出站没有「回复」（只能回复收到的邮件）', outBtns.join('/'));
  });

  /* ---- D5 forward composer prefill + send ---- */
  await test('D5 转发弹窗：Fwd: 主题 / 原文引用 / 收件人留空 / 附件提示；发送打到 /forward', async (ctx) => {
    renderReadFor(ctx, MSG_IN, ATTS);
    clickReadAction(ctx, '转发');
    await ticks(ctx.win, 5);

    ok(composerOpen(ctx), '转发弹窗已打开');
    ok(composing(ctx) && composing(ctx).mode === 'forward', 'mode = forward', composing(ctx) && composing(ctx).mode);
    ok(val(ctx, '#f-to') === '', '⭐ 收件人留空（转发给谁由用户填）', JSON.stringify(val(ctx, '#f-to')));
    ok(val(ctx, '#f-subject') === 'Fwd: Hello', '⭐ 主题补 Fwd:', val(ctx, '#f-subject'));
    ok(val(ctx, '#f-body').includes('转发的邮件') && val(ctx, '#f-body').includes('line1'),
      '⭐ 正文预填原文引用块（含转发头与原文）', JSON.stringify(val(ctx, '#f-body').slice(0, 60)));
    ok(hidden(ctx, '.merge-row'), '转发隐藏「合并发送」行');
    ok(!hidden(ctx, '#f-forward-note'), '显示附件提示');
    ok(el(ctx, '#f-forward-note').textContent.includes('1 个附件'), '⭐ 提示会带上 1 个附件', el(ctx, '#f-forward-note').textContent);
    ok(isDirty(ctx) === false, '预填内容不算「用户输入」（不会一开弹窗就提示放弃）');

    typeInto(ctx, '#f-to', 'bob@x.com');
    ok(isDirty(ctx) === true, '填了收件人 -> 变脏');
    await send(ctx);
    const s = ctx.stub.lastSend();
    ok(s && s.url === '/api/messages/m1/forward', '⭐ 打到 /api/messages/m1/forward', s && s.url);
    const body = ctx.stub.parseLastSendBody();
    ok(body && body.include_original_attachments === true, '⭐ 请求体声明要带原附件（服务端去 R2 复制）', JSON.stringify(body && body.include_original_attachments));
    ok(toastText(ctx).includes('转发'), '成功提示是「已转发」而不是「已发送」', toastText(ctx));
  });

  /* ---- D6 attachment read failure on forward -> warn, don't pretend success ---- */
  await test('D6 转发响应里 skipped_attachments -> 警示 toast（不假装附件跟着走了）', async (ctx) => {
    ctx.stub.setSendResponse(200, { ok: true, id: 'row-9', resend_id: 're-9', skipped_attachments: ['note.txt'] });
    renderReadFor(ctx, MSG_IN, ATTS);
    clickReadAction(ctx, '转发');
    await ticks(ctx.win, 5);
    typeInto(ctx, '#f-to', 'bob@x.com');
    await send(ctx);
    ok(toastText(ctx).includes('note.txt'), '⭐ toast 里点名了被跳过的附件', toastText(ctx));
    ok(el(ctx, '#toast').classList.contains('error'), '以错误样式呈现', '');
  });

  /* ---- D7 autocomplete: type a name fragment -> dropdown -> click replaces with email ---- */
  await test('D7 联想：输入 lili -> 列出所有名字含 lili 的联系人 -> 选中替换为邮箱', async (ctx) => {
    await openCompose(ctx);
    typeInto(ctx, '#f-to', 'lili');
    ok(suggestOpen(ctx), '⭐ 输入 lili 后下拉打开');
    const texts = suggestTexts(ctx);
    ok(texts.length === 3, '⭐ 命中 3 个（姓名含 lili 的两个 + 邮箱含 lili 的一个）', JSON.stringify(texts));
    ok(texts.some((t) => t.includes('Lili Wang')) && texts.some((t) => t.includes('Lili Chen')),
      '姓名包含 lili 的都列出来了', JSON.stringify(texts));
    ok(!texts.some((t) => t.includes('Bob Li')), '不相关的联系人不在列表里', JSON.stringify(texts));

    suggestItems(ctx)[0].dispatchEvent(mouseEvt(ctx.win));
    ok(val(ctx, '#f-to') === 'lili.wang@partner.com, ',
      '⭐ 选中后该段被替换为纯邮箱（并补了分隔符方便接着输）', JSON.stringify(val(ctx, '#f-to')));
    ok(!suggestOpen(ctx), '选中后下拉收起');

    // Continue typing the second one: earlier selections are unaffected
    typeInto(ctx, '#f-to', 'lili.wang@partner.com, lili.chen');
    ok(suggestOpen(ctx), '继续输入第二个也能联想');
    suggestItems(ctx)[0].dispatchEvent(mouseEvt(ctx.win));
    ok(val(ctx, '#f-to') === 'lili.wang@partner.com, lili.chen@other.com, ',
      '⭐ 只替换光标所在的那一段，已选中的第一个原样保留', JSON.stringify(val(ctx, '#f-to')));
  });

  /* ---- D8 keyboard interaction ---- */
  await test('D8 联想：↓ 移动高亮、回车选中；无匹配时下拉不出现', async (ctx) => {
    await openCompose(ctx);
    typeInto(ctx, '#f-to', 'lili');
    ok(suggestOpen(ctx), '下拉已打开（否则下面的断言空转）');

    el(ctx, '#f-to').dispatchEvent(keyEvt(ctx.win, 'ArrowDown'));
    const active = el(ctx, '#addr-suggest').querySelectorAll('.addr-suggest-item.active');
    ok(active.length === 1, '恰好一项高亮', active.length);
    ok(active[0].textContent.includes('Lili Chen'), '↓ 之后高亮移到第二项', active[0].textContent);

    el(ctx, '#f-to').dispatchEvent(keyEvt(ctx.win, 'Enter'));
    ok(val(ctx, '#f-to') === 'lili.chen@other.com, ', '⭐ 回车选中高亮项', JSON.stringify(val(ctx, '#f-to')));

    typeInto(ctx, '#f-to', 'zzzz-no-such-contact');
    ok(!suggestOpen(ctx), '⭐ 没有匹配时下拉不出现（不显示空盒子）');
  });

  /* ---- D9 Esc closes only the dropdown, not the composer ---- */
  await test('D9 Esc：下拉打开时只收起下拉，绝不顺带关掉写信弹窗', async (ctx) => {
    await openCompose(ctx);
    typeInto(ctx, '#f-to', 'lili');
    ok(suggestOpen(ctx), '下拉已打开');

    el(ctx, '#f-to').dispatchEvent(keyEvt(ctx.win, 'Escape'));
    ok(!suggestOpen(ctx), '⭐ Esc 收起下拉');
    ok(composerOpen(ctx), '⭐ 弹窗仍然打开（stopPropagation 生效）');
    ok(!confirmShown(ctx), '⭐ 也没有弹出「放弃编辑」确认框');

    // When the dropdown is already collapsed, Esc restores the existing semantics: request close (this round's semantics is "save draft and close", no more confirm)
    el(ctx, '#f-to').dispatchEvent(keyEvt(ctx.win, 'Escape'));
    ok(!composerOpen(ctx), '下拉收起后 Esc 回到「请求关闭弹窗」的既有行为（存草稿并关闭）', `open=${composerOpen(ctx)}`);
    ok(!confirmShown(ctx), '不再弹「放弃编辑」确认框');
  });

  /* ---- D10 autocomplete also works for cc / bcc fields ---- */
  await test('D10 联想对 cc / bcc 字段同样生效（不是只有 to）', async (ctx) => {
    await openCompose(ctx);
    clickEl(ctx, '#f-cc-toggle');
    typeInto(ctx, '#f-cc', 'lili');
    ok(suggestOpen(ctx), '⭐ cc 字段能触发联想');
    suggestItems(ctx)[1].dispatchEvent(mouseEvt(ctx.win));
    ok(val(ctx, '#f-cc') === 'lili.chen@other.com, ', 'cc 字段选中后替换为邮箱', JSON.stringify(val(ctx, '#f-cc')));
    ok(val(ctx, '#f-to') === '', '负控制：没有误改到收件人字段', JSON.stringify(val(ctx, '#f-to')));

    typeInto(ctx, '#f-bcc', 'bob');
    ok(suggestOpen(ctx), '⭐ bcc 字段能触发联想');
    ok(suggestTexts(ctx).some((t) => t.includes('bob@x.com')), '按邮箱片段匹配到 Bob', JSON.stringify(suggestTexts(ctx)));
  });

  /* ---- D11 dirty check includes cc/bcc ---- */
  await test('D11 isComposerDirty 把 cc/bcc 计入（否则改了抄送直接关窗会静默丢弃）', async (ctx) => {
    await openCompose(ctx);
    ok(isDirty(ctx) === false, '刚打开 -> 不脏');
    clickEl(ctx, '#f-cc-toggle');
    typeInto(ctx, '#f-cc', 'cc@x.com');
    ok(isDirty(ctx) === true, '⭐ 只改了抄送 -> 判定为脏');
    typeInto(ctx, '#f-cc', '');
    ok(isDirty(ctx) === false, '清空抄送 -> 回到不脏');
    typeInto(ctx, '#f-bcc', 's@x.com');
    ok(isDirty(ctx) === true, '⭐ 只改了密送 -> 判定为脏');
    typeInto(ctx, '#f-bcc', '');
    ok(isDirty(ctx) === false, '清空密送 -> 回到不脏');
  });

  /* ---- D12 width strategy of the autocomplete dropdown ---- */
  await test('D12 联想下拉宽度：铺满弹窗内容宽度，不再跟随（很窄的）输入框', async (ctx) => {
    await openCompose(ctx);

    // 1) Pure function layer: the width is determined only by the composer content width; the anchor width doesn't participate
    const g = JSON.parse(evalIn(ctx,
      "JSON.stringify(suggestBoxGeom({ hostWidth: 320, padLeft: 14, padRight: 14, anchorTop: 40, anchorHeight: 36 }))"));
    ok(g.width === 292, '⭐ 宽度 = 内容宽度 - 左右内边距（320-14-14）', JSON.stringify(g.width));
    ok(g.left === 14, '左边界对齐内容左边缘（不是贴弹窗边框）', JSON.stringify(g.left));
    ok(g.top === 80, '上边界 = 锚点底边 + 4（40+36+4）', JSON.stringify(g.top));

    // 2) Real call path: make the input very narrow and the composer very wide; the width must follow the composer
    //    (jsdom has no layout, clientWidth/offsetWidth are always 0, so we must pin these two numbers ourselves)
    const host = el(ctx, '#composer');
    const input = el(ctx, '#f-to');
    Object.defineProperty(host, 'clientWidth', { value: 700, configurable: true });
    Object.defineProperty(input, 'offsetWidth', { value: 120, configurable: true });
    Object.defineProperty(input, 'offsetTop', { value: 60, configurable: true });
    Object.defineProperty(input, 'offsetHeight', { value: 34, configurable: true });

    evalIn(ctx, "positionSuggest($('#f-to'))");
    const box = el(ctx, '#addr-suggest');
    ok(box.style.width === '700px',
      '⭐ 下拉宽度=弹窗内容宽度（700），而不是输入框宽度（120）', box.style.width);
    ok(box.style.width !== `${input.offsetWidth}px`,
      '⭐ 负控制：宽度确实不再等于输入框宽度（回退成 anchor.offsetWidth 会被这条抓住）', box.style.width);
    ok(box.style.top === '98px', '位置仍跟着输入框（60+34+4）', box.style.top);

    // 3) Edge: when the composer is narrower than the padding, no negative width may appear
    const tiny = JSON.parse(evalIn(ctx,
      "JSON.stringify(suggestBoxGeom({ hostWidth: 10, padLeft: 14, padRight: 14, anchorTop: 0, anchorHeight: 0 }))"));
    ok(tiny.width === 0, '弹窗窄于内边距时宽度夹到 0，不产生负数', JSON.stringify(tiny.width));
  });

  /* ---- summary ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);

  console.log(`\n被测版本: app.js md5=${FINGERPRINT['public/app.js']}  index.html md5=${FINGERPRINT['public/index.html']}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
