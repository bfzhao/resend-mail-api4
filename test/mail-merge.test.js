'use strict';

/* =========================================================
 * "Merge send" regression test (zero dependencies, node test/mail-merge.test.js)
 *
 * The project frontend is a build-less native SPA with no npm test framework. Here we follow
 * the approach of test/compose-guard.test.js: use Node's built-in vm to extract the **real functions**
 * related to composing from public/app.js verbatim and run them, with a minimal DOM stub,
 * verifying the real source's behavior without introducing any dependency.
 *
 * Covers:
 *   1. parseRecipients pure function (separators / trim / drop empty / case-insensitive dedup / boundaries)
 *   2. frontend merge branch: all succeed -> close + toast
 *                      partial failure -> dialog stays open, #f-to keeps only the failed ones, toast includes address and reason
 *                      all fail -> likewise stays open, #f-to equivalent to the original input
 *   3. non-merge branch: behavior identical to before the change (one request, to as an array)
 *   4. checkbox reset: every time the dialog opens it is unchecked
 *   5. dirty detection: only checking / unchecking the checkbox does not produce a dirty state
 *   6. hint text: when checked and >1 recipient, show the count; with 0/1 recipients, do not show
 *   7. mode isolation: .merge-row is shown only in compose mode; in reply mode it is hidden and the payload never contains merge (hard defense)
 *   8. dedup: the same address repeated 100 times still counts as 1 person, and does not trigger the backend's dynamic cap
 *
 * Note: the backend merge loop (src/index.ts) is TS and the project has no build step,
 * so a zero-dependency script cannot require it; it is therefore not covered here, and integration verification is done by QA with a real wrangler dev.
 * ========================================================= */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// QA_APP_JS is only for "mutation verification": point it at a hand-crafted defective app.js.
// Without the hook, the mutation script would "run the repo's original file while thinking it is the variant" -> the variant is never caught (false negative).
const APP_JS_PATH = process.env.QA_APP_JS || path.join(__dirname, '..', 'public', 'app.js');
const SRC = fs.readFileSync(APP_JS_PATH, 'utf8');

function slice(startMarker, endMarker, label) {
  const s = SRC.indexOf(startMarker);
  if (s < 0) throw new Error(`未找到起始标记（${label}）：${startMarker}`);
  const e = SRC.indexOf(endMarker, s);
  if (e < 0) throw new Error(`未找到结束标记（${label}）：${endMarker}`);
  return SRC.slice(s, e);
}

const pieces = [
  slice('function esc(s) {', '\n}\n', 'esc') + '\n}\n',
  slice('function timeLong(sec) {', '\n}\n', 'timeLong') + '\n}\n',
  slice('function fmtSize(n) {', '\n}\n', 'fmtSize') + '\n}\n',
  // all the compose-related real implementations (including parseRecipients / updateMergeHint / resetMergePick /
  // openComposer / openReplyComposer / guard block / sendCompose)
  slice(
    'function plainToHtmlText(text) {',
    '\n\n/* ---------------- Search / keyboard / events / sync ---------------- */',
    'compose 主体'
  ),
  // the event wiring in setupEvents related to the composer dialog (including the #f-merge / #f-to listeners)
  slice(
    "  $('#compose-btn').addEventListener('click', openComposer);",
    '\n\n  setupSearch();',
    '事件接线'
  ),
  // mobile layout module (isMobile / syncLayout / setDrawer / closeDrawer).
  // The "event wiring" slice above references setDrawer / closeDrawer / drawerOpen,
  // so not extracting this piece together would directly ReferenceError; it itself only depends on $ / state / globalThis, all present in the stubs.
  slice('/* ---------------- Mobile layout', '/* ---------------- API ---------------- */', '移动端布局'),
];

// symbols that are not extracted but will be referenced
const stubs = `
const MAX_FILE_BYTES = 40 * 1024 * 1024;
let currentMessage = null;
function showToast(msg, isError) { globalThis.__toasts.push({ msg, isError: !!isError }); }
function api(...args) { return globalThis.__apiImpl(...args); }
function invalidateFolderCaches() {}
function refreshCounts() {}
function loadMailboxes() {}
function openFolder() {}
function loadFolder() {}
function isTypingTarget() { return false; }
function moveSelection() {}
// The detail pane's close/render are outside this suite's concern (and depend on a whole detail state such as detailSeq / currentThread),
// but the event wiring references them, so a stub is given. Mobile behavior is covered by test/mobile-layout.dom.test.js with the real implementation.
function closeMessagePane() {}
// Multi-domain entry lives in the gate section (outside this slice) but setupEvents references it.
function openAddDomain() {}
`;

// probe: expose the block-level let bindings for external observation and reset (test only)
const probe = `
globalThis.__t = {
  get sendInFlight() { return sendInFlight; },
  get baseline() { return composerBaseline; },
  resetGuard() { discardConfirmPending = false; composerLastFocus = null; },
  clearBaseline() { composerBaseline = null; },
  setCurrentMessage(m) { currentMessage = m; },
  // re-snapshot the current form as the baseline (same expression as inside openComposer),
  // used to isolate the single variable of "checking the checkbox".
  rebaseline() {
    composerBaseline = {
      to: $('#f-to').value,
      subject: $('#f-subject').value,
      body: $('#f-body').value,
      richText: richPlainText($('#f-body-rich')),
      mailbox: $('#f-mailbox').value,
    };
  },
};
`;

/* ---------------- minimal DOM stub ---------------- */

const els = {};
const listeners = {};

function on(sel, ev, fn) {
  (listeners[`${sel}:${ev}`] = listeners[`${sel}:${ev}`] || []).push(fn);
}
function fire(sel, ev, event = {}) {
  const fns = listeners[`${sel}:${ev}`] || [];
  if (!fns.length) throw new Error(`没有注册的监听器：${sel} / ${ev}`);
  for (const fn of fns) fn(event);
}

class El {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.checked = false; // checkbox support
    this.disabled = false;
    this._text = '';
    this._html = '';
    this.focused = 0;
    this.parent = null;
    this._classes = new Set();
    this._attrs = {};
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      contains: (c) => this._classes.has(c),
      toggle: (c, on2) => (on2 ? this._classes.add(c) : this._classes.delete(c)),
    };
  }
  get innerText() { return this._text; }
  set innerText(v) { this._text = v; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this._text = this._html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|&#160;|&#xa0;/gi, '\u00a0')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }
  focus() { this.focused++; }
  // production code writes aria-expanded on the sender summary row (in a real browser DOM elements have these two methods natively)
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
  addEventListener(ev, fn) { on(this.id, ev, fn); }
  appendChild() {}
  contains(other) {
    let n = other;
    while (n) { if (n === this) return true; n = n.parent; }
    return false;
  }
}

function el(id) {
  if (!els[id]) els[id] = new El(id);
  return els[id];
}

const composer = el('#composer');
const modalMask = el('#modal-mask');
const confirmMask = el('#confirm-mask');
modalMask.classList.add('hidden');
confirmMask.classList.add('hidden');
composer.parent = modalMask;

const documentStub = {
  body: { contains: (n) => Object.values(els).includes(n) },
  querySelector: (s) => el(s),
  createElement: (tag) => new El(`<${tag}>`),
  addEventListener: (ev, fn) => on('#document', ev, fn),
};

const sandbox = {
  console,
  document: documentStub,
  state: {
    composing: null,
    canSend: true,
    fromName: '',
    fromAddress: 'me@example.com',
    fromEmail: 'me@example.com',
    mailbox: '',
    mailboxList: [],
    folder: 'inbox',
    cache: { countsAt: 0 },
    // the real state also has these two fields (used for recipient suggestions); add them so the stub does not drift from the production shape
    contacts: [],
    contactsLoaded: false,
    // mobile layout (syncLayout) reads it; likewise "add it so the shape does not drift"
    openId: null,
  },
  $: (s) => el(s),
  __toasts: [],
  __apiImpl: () => Promise.reject(new Error('api 桩未被设置')),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(`'use strict';\n${stubs}\n${pieces.join('\n')}\n${probe}\n`, sandbox);

const S = sandbox;
const T = S.__t;
const st = S.state;
const toasts = S.__toasts;

/* ---------------- assertion helpers ---------------- */

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  FAIL  ${msg}`); }
}
const composerOpen = () => !modalMask.classList.contains('hidden');
const confirmShown = () => !confirmMask.classList.contains('hidden');
const lastToast = () => (toasts.length ? toasts[toasts.length - 1].msg : '');
const hint = () => el('#merge-hint').textContent;
const mergeRowHidden = () => el('.merge-row').classList.contains('hidden');
const MERGE_HINT = (n) => `将分别单独发送给 ${n} 位收件人`;

const REPLY_MSG = {
  id: 'msg-1',
  direction: 'inbound',
  from_email: 'alice@example.com',
  from_name: 'Alice',
  subject: '会议纪要',
  mailbox: 'me@example.com',
  reply_to: [],
  received_at: 1700000000,
  body_text: '原文第一行\n原文第二行',
};

/** Go through the real openComposer(), so the baseline / checkbox reset are performed by production code */
function reset() {
  for (const e of Object.values(els)) e.focused = 0;
  toasts.length = 0;
  T.resetGuard();
  S.openComposer();
  T.resetGuard();
}
/** Go through the real openReplyComposer() */
function resetReply() {
  for (const e of Object.values(els)) e.focused = 0;
  toasts.length = 0;
  T.resetGuard();
  T.setCurrentMessage(REPLY_MSG);
  S.openReplyComposer();
  T.resetGuard();
}

/** Record each api call's url/opts, and return a controller that can be resolved manually */
function captureApi() {
  const calls = [];
  let resolveFn;
  let rejectFn;
  const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  S.__apiImpl = (url, opts) => { calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null }); return p; };
  return { calls, resolve: resolveFn, reject: rejectFn };
}

/* ---------------- test cases ---------------- */

async function main() {
  console.log('\n[1] parseRecipients：分隔符 / trim / 去空 / 大小写去重 / 边界');
  const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), `${msg} -> ${JSON.stringify(got)}`);
  eq(S.parseRecipients('a@x.com, b@y.com'), ['a@x.com', 'b@y.com'], '英文逗号分隔');
  eq(S.parseRecipients('a@x.com;b@y.com'), ['a@x.com', 'b@y.com'], '英文分号分隔');
  eq(S.parseRecipients('a@x.com，b@y.com；c@z.com'), ['a@x.com', 'b@y.com', 'c@z.com'], '中文逗号 + 中文分号');
  eq(S.parseRecipients('a@x.com, b@y.com;c@z.com'), ['a@x.com', 'b@y.com', 'c@z.com'], '混合分隔符');
  eq(S.parseRecipients('  a@x.com  \n\t b@y.com  '), ['a@x.com', 'b@y.com'], '空白分隔 + 两端 trim');
  eq(S.parseRecipients('a@x.com,,;;  ,,b@y.com'), ['a@x.com', 'b@y.com'], '连续/空段被丢弃');
  eq(S.parseRecipients('  ,  ;  '), [], '只有分隔符 -> 空数组');
  eq(S.parseRecipients('A@X.com, a@x.com, A@x.COM'), ['A@X.com'], '大小写去重且保留首次写法');
  eq(S.parseRecipients('a@x.com,a@x.com,a@x.com'), ['a@x.com'], '重复同一地址 -> 1 个');
  eq(S.parseRecipients('a@x.com'), ['a@x.com'], '单个地址');
  eq(S.parseRecipients(''), [], '空串 -> 空数组');
  eq(S.parseRecipients('   '), [], '仅空白 -> 空数组');
  eq(S.parseRecipients(null), [], 'null -> 空数组');
  eq(S.parseRecipients(undefined), [], 'undefined -> 空数组');
  // the only call site is input.value (always a string); here we only confirm non-string arguments do not throw
  eq(S.parseRecipients(0), ['0'], '非字符串入参经 String() 归一化，不抛错');

  console.log('\n[2] hint 文案：勾选且 >1 收件人才显示人数');
  reset();
  ok(hint() === '', '刚打开 -> 无提示');
  el('#f-to').value = 'a@x.com';
  fire('#f-to', 'input', {});
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  ok(hint() === '', '1 位收件人 -> 不显示');
  el('#f-to').value = 'a@x.com, b@y.com';
  fire('#f-to', 'input', {});
  ok(hint() === MERGE_HINT(2), `改成 2 位 -> 显示「${MERGE_HINT(2)}」`);
  el('#f-to').value = 'a@x.com, b@y.com, c@z.com;d@w.com';
  fire('#f-to', 'input', {});
  ok(hint() === MERGE_HINT(4), '改成 4 位 -> 人数跟着变');
  el('#f-to').value = 'a@x.com, A@X.COM';
  fire('#f-to', 'input', {});
  ok(hint() === '', '去重后只剩 1 位 -> 不显示');
  el('#f-to').value = '';
  fire('#f-to', 'input', {});
  ok(hint() === '', '清空收件人 -> 不显示');
  el('#f-to').value = 'a@x.com, b@y.com';
  fire('#f-to', 'input', {});
  el('#f-merge').checked = false;
  fire('#f-merge', 'change', {});
  ok(hint() === '', '取消勾选 -> 清空提示');

  console.log('\n[3] checkbox 重置：每次打开弹窗都是未勾选');
  reset();
  el('#f-merge').checked = true;
  el('#f-to').value = 'a@x.com, b@y.com';
  fire('#f-merge', 'change', {});
  ok(hint() !== '', '先制造「已勾选 + 有提示」的残留状态');
  S.requestCloseComposer();
  reset();
  ok(el('#f-merge').checked === false, '重开写信弹窗 -> 未勾选');
  ok(hint() === '', '重开写信弹窗 -> 提示已清空');
  resetReply();
  ok(el('#f-merge').checked === false, '打开回复弹窗 -> 未勾选');
  ok(hint() === '', '打开回复弹窗 -> 提示已清空');
  el('#f-merge').checked = true;
  resetReply();
  ok(el('#f-merge').checked === false, '回复弹窗重开 -> 未勾选');

  console.log('\n[4] 脏检测：仅勾选 / 取消 checkbox 不产生脏状态');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-body').value = 'body';
  T.rebaseline(); // bring the recipients/body into the baseline, isolating the single variable of the checkbox
  ok(S.isComposerDirty() === false, '基线状态下 -> 不脏');
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  ok(S.isComposerDirty() === false, '勾选 checkbox -> 仍不脏');
  el('#f-merge').checked = false;
  fire('#f-merge', 'change', {});
  ok(S.isComposerDirty() === false, '取消勾选 -> 仍不脏');
  // checking the box on an empty form then clicking outside: nothing to lose, should close directly instead of popping the "discard" confirm
  reset();
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  S.requestCloseComposer();
  ok(composerOpen() === false, '空表单勾选后点外部 -> 直接关闭');
  ok(confirmShown() === false, '空表单勾选后点外部 -> 不弹放弃确认');

  console.log('\n[5] 非 merge 分支：一次请求、to 为数组（其余行为不变）');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-subject').value = 's';
  el('#f-body').value = 'body';
  const c5 = captureApi();
  const s5 = S.sendCompose();
  ok(T.sendInFlight === true, '发送中 sendInFlight=true');
  c5.resolve({ ok: true, id: 'row-1', resend_id: 'rs-1' });
  await s5;
  ok(c5.calls.length === 1, '只发出 1 次请求');
  ok(c5.calls[0].url === '/api/messages', '打到 /api/messages');
  ok(Array.isArray(c5.calls[0].body.to), 'payload.to 是数组');
  ok(JSON.stringify(c5.calls[0].body.to) === JSON.stringify(['a@x.com', 'b@y.com']), 'payload.to 已切分为 2 个地址');
  ok(c5.calls[0].body.merge === undefined, '未勾选 -> payload 不含 merge');
  ok(lastToast() === '邮件已发送', 'toast 与改造前一致');
  ok(composerOpen() === false, '发送成功后关闭弹窗');
  ok(T.sendInFlight === false, 'sendInFlight 已复位');

  console.log('\n[5b] 非 merge 分支：单收件人也是数组；空收件人被拦下');
  reset();
  el('#f-to').value = 'a@x.com';
  el('#f-body').value = 'body';
  const c5b = captureApi();
  c5b.resolve({ ok: true, id: 'row-2' });
  await S.sendCompose();
  ok(JSON.stringify(c5b.calls[0].body.to) === JSON.stringify(['a@x.com']), '单收件人 -> ["a@x.com"]');
  reset();
  el('#f-to').value = '  , ;  ';
  el('#f-body').value = 'body';
  let calls5c = 0;
  S.__apiImpl = () => { calls5c++; return Promise.resolve({}); };
  toasts.length = 0;
  await S.sendCompose();
  ok(calls5c === 0, '仅分隔符 -> 不发请求');
  ok(lastToast() === '请填写收件人', '仅分隔符 -> 提示「请填写收件人」');
  ok(composerOpen() === true, '弹窗保持打开');

  console.log('\n[5c] 非 merge 分支：失败路径与改造前一致');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-body').value = 'body';
  const c5d = captureApi();
  const s5d = S.sendCompose();
  c5d.reject(new Error('网络错误'));
  await s5d;
  ok(composerOpen() === true, '失败 -> 弹窗不关');
  ok(st.composing !== null && el('#f-body').value === 'body', '失败 -> 内容保留');
  ok(lastToast().includes('发送失败'), '失败 -> 提示发送失败');
  ok(T.sendInFlight === false, '失败 -> sendInFlight 已复位');

  console.log('\n[6] merge 分支：全部成功 -> 关窗 + 正确 toast');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-subject').value = '通知';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c6 = captureApi();
  const s6 = S.sendCompose();
  c6.resolve({
    ok: true, merge: true, total: 2, sent_count: 2, failed_count: 0,
    sent: [{ to: 'a@x.com', id: 'r1', resend_id: 'x1' }, { to: 'b@y.com', id: 'r2', resend_id: 'x2' }],
    failed: [],
  });
  await s6;
  ok(c6.calls.length === 1, '只发出 1 次请求（由后端循环，附件只上传一次）');
  ok(c6.calls[0].body.merge === true, 'payload.merge=true');
  ok(JSON.stringify(c6.calls[0].body.to) === JSON.stringify(['a@x.com', 'b@y.com']), 'payload.to 为 2 个地址的数组');
  ok(lastToast() === '已分别发送给 2 位收件人', `toast = 「已分别发送给 2 位收件人」（实际：${lastToast()}）`);
  ok(composerOpen() === false, '全部成功 -> 关闭弹窗');
  ok(st.composing === null, '全部成功 -> 状态已清理');
  ok(T.sendInFlight === false, '全部成功 -> sendInFlight 已复位');

  console.log('\n[7] merge 分支：部分失败 -> 弹窗不关、#f-to 只剩失败者、toast 含地址与原因');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com, c@z.com';
  el('#f-subject').value = '通知';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c7 = captureApi();
  const s7 = S.sendCompose();
  c7.resolve({
    ok: true, merge: true, total: 3, sent_count: 2, failed_count: 1,
    sent: [{ to: 'a@x.com', id: 'r1', resend_id: 'x1' }, { to: 'b@y.com', id: 'r2', resend_id: 'x2' }],
    failed: [{ to: 'c@z.com', error: 'Resend 返回错误: invalid to' }],
  });
  await s7;
  ok(composerOpen() === true, '部分失败 -> 弹窗不关');
  ok(st.composing !== null, '部分失败 -> composing 状态保留');
  ok(el('#f-to').value === 'c@z.com', `#f-to 只剩失败者（实际：${el('#f-to').value}）`);
  ok(el('#f-subject').value === '通知', '主题保留');
  ok(el('#f-body').value === '正文', '正文保留');
  ok(el('#f-merge').checked === true, 'checkbox 保持勾选（重试仍是合并发送）');
  ok(lastToast().includes('已发送 2 封'), `toast 含已发送封数（实际：${lastToast()}）`);
  ok(lastToast().includes('1 封失败'), 'toast 含失败封数');
  ok(lastToast().includes('c@z.com'), 'toast 含失败地址');
  ok(lastToast().includes('Resend 返回错误: invalid to'), 'toast 含失败原因');
  ok(toasts[toasts.length - 1].isError === true, 'toast 以错误样式展示');
  ok(el('#composer-send').disabled === false, '部分失败后发送按钮已恢复可点');
  ok(T.sendInFlight === false, '部分失败 -> sendInFlight 已复位');
  ok(hint() === '', '只剩 1 位失败者 -> hint 清空');

  console.log('\n[7b] merge 分支：多失败者全部写回 #f-to，可再次重试');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com, c@z.com, d@w.com';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c7b = captureApi();
  const s7b = S.sendCompose();
  c7b.resolve({
    ok: true, merge: true, total: 4, sent_count: 2, failed_count: 2,
    sent: [{ to: 'a@x.com', id: 'r1' }, { to: 'b@y.com', id: 'r2' }],
    failed: [{ to: 'c@z.com', error: 'boom-c' }, { to: 'd@w.com', error: 'boom-d' }],
  });
  await s7b;
  ok(el('#f-to').value === 'c@z.com, d@w.com', `两个失败者都写回（实际：${el('#f-to').value}）`);
  ok(S.parseRecipients(el('#f-to').value).length === 2, '写回内容可被再次解析为 2 个地址');
  ok(hint() === MERGE_HINT(2), '写回后 hint 同步为 2 位');
  ok(lastToast().includes('c@z.com'), 'toast 展示第一个失败者');

  console.log('\n[8] merge 分支：全部失败 -> 仍 HTTP 200，前端不抛错、不关窗、不丢内容');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-subject').value = '通知';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c8 = captureApi();
  const s8 = S.sendCompose();
  // key contract: HTTP 200 + ok:false + failed details (so api() does not throw and the frontend can get failed)
  c8.resolve({
    ok: false, merge: true, total: 2, sent_count: 0, failed_count: 2,
    sent: [],
    failed: [{ to: 'a@x.com', error: 'boom-a' }, { to: 'b@y.com', error: 'boom-b' }],
  });
  await s8;
  ok(composerOpen() === true, '全失败 -> 弹窗不关');
  ok(confirmShown() === false, '全失败 -> 不弹放弃确认框');
  ok(st.composing !== null && el('#f-body').value === '正文', '全失败 -> 内容完整保留');
  ok(el('#f-to').value === 'a@x.com, b@y.com', `全失败 -> #f-to 等价于原输入（实际：${el('#f-to').value}）`);
  ok(el('#f-merge').checked === true, '全失败 -> checkbox 仍勾选');
  ok(lastToast().includes('已发送 0 封') && lastToast().includes('2 封失败'), `toast 反映全失败（实际：${lastToast()}）`);
  ok(!lastToast().includes('发送失败：'), '全失败不走「发送失败」异常分支（说明响应为 200）');
  ok(T.sendInFlight === false, '全失败 -> sendInFlight 已复位');
  // after all fail the dialog can still be closed normally (since this round the semantics are "save draft and close"; the content really was not sent, so it is saved as a draft)
  S.requestCloseComposer();
  ok(confirmShown() === false, '全失败后点外部 -> 不弹放弃确认');
  ok(composerOpen() === false, '全失败后点外部 -> 存草稿并关闭');

  console.log('\n[9] merge 分支：后端 400（超上限）走异常分支，内容保留');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c9 = captureApi();
  const s9 = S.sendCompose();
  c9.reject(new Error('单次合并发送最多 22 位收件人'));
  await s9;
  ok(composerOpen() === true, '400 -> 弹窗不关');
  ok(lastToast().includes('发送失败') && lastToast().includes('最多 22 位'), `toast 透出后端错误（实际：${lastToast()}）`);
  ok(el('#f-to').value === 'a@x.com, b@y.com', '400 -> 收件人未被改写');
  ok(T.sendInFlight === false, '400 -> sendInFlight 已复位');

  console.log('\n[10] 发送中守卫不被破坏（merge 路径）');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c10 = captureApi();
  const s10 = S.sendCompose();
  ok(T.sendInFlight === true, 'merge 发送中 sendInFlight=true');
  toasts.length = 0;
  S.requestCloseComposer();
  ok(composerOpen() === true, 'merge 发送中请求关闭 -> 弹窗不关');
  ok(confirmShown() === false, 'merge 发送中 -> 不弹放弃确认');
  ok(lastToast().includes('正在发送中'), 'merge 发送中 -> 提示「邮件正在发送中」');
  c10.resolve({ ok: true, merge: true, total: 2, sent_count: 2, failed_count: 0, sent: [], failed: [] });
  await s10;
  ok(composerOpen() === false, 'merge 发送完成后正常关闭');
  ok(T.sendInFlight === false, 'merge 发送完成后 sendInFlight 已复位');

  console.log('\n[11] 回复模式：.merge-row 隐藏，且硬防御保证 payload 绝不含 merge');
  resetReply();
  ok(el('#f-to').value === 'alice@example.com', '收件人已预填');
  ok(mergeRowHidden() === true, '回复模式 -> .merge-row 带 hidden');
  ok(el('#f-merge').checked === false, '回复模式 -> checkbox 未勾选');
  el('#f-body').value = '收到';
  const c11 = captureApi();
  const s11 = S.sendCompose();
  c11.resolve({ ok: true, id: 'r-reply' });
  await s11;
  ok(c11.calls[0].url === '/api/messages/msg-1/reply', '打到回复接口');
  ok(Array.isArray(c11.calls[0].body.to) && c11.calls[0].body.to[0] === 'alice@example.com', '回复 payload.to 也是数组');
  ok(c11.calls[0].body.merge === undefined, '回复 payload 不含 merge');
  ok(lastToast() === '回复已发送', 'toast 与改造前一致');
  // hard defense: even if the checkbox is force-checked (DOM modified / stale state), never send merge to the reply endpoint
  resetReply();
  el('#f-to').value = 'alice@example.com, bob@example.com';
  el('#f-body').value = '收到';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c11b = captureApi();
  const s11b = S.sendCompose();
  c11b.resolve({ ok: true, id: 'r-reply' });
  await s11b;
  ok(c11b.calls[0].body.merge === undefined, '回复模式强行勾选 -> payload 仍不含 merge（硬防御生效）');
  ok(c11b.calls[0].body.to.length === 2, '回复模式 -> payload.to 仍按输入切分为 2 个地址');
  // contrast: in compose mode with the same DOM state, merge must be sent as usual
  reset();
  ok(mergeRowHidden() === false, '写信模式 -> .merge-row 不带 hidden');
  el('#f-to').value = 'alice@example.com, bob@example.com';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c11c = captureApi();
  const s11c = S.sendCompose();
  c11c.resolve({ ok: true, merge: true, total: 2, sent_count: 2, failed_count: 0, sent: [], failed: [] });
  await s11c;
  ok(c11c.calls[0].body.merge === true, '对照：写信模式勾选 -> payload.merge=true');

  console.log('\n[12] 去重：同一地址重复 100 次 -> 只算 1 人，不可能触发后端动态上限');
  const hundred = Array.from({ length: 100 }, () => 'a@x.com').join(', ');
  const deduped = S.parseRecipients(hundred);
  ok(deduped.length === 1, `100 次重复 -> 去重后 1 人（实际 ${deduped.length}）`);
  ok(deduped[0] === 'a@x.com', '保留原地址');
  ok(S.parseRecipients(hundred).length <= 22, '去重后远低于动态上限 -> 后端 mergeRecipientCap 不会触发');
  reset();
  el('#f-to').value = hundred;
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  ok(hint() === '', '100 次重复去重后仅 1 人 -> 不显示合并提示');
  const c12 = captureApi();
  const s12 = S.sendCompose();
  c12.resolve({ ok: true, merge: true, total: 1, sent_count: 1, failed_count: 0, sent: [], failed: [] });
  await s12;
  ok(c12.calls[0].body.to.length === 1, `payload.to 只带 1 个地址（实际 ${c12.calls[0].body.to.length}）`);
  ok(JSON.stringify(c12.calls[0].body.to) === JSON.stringify(['a@x.com']), 'payload.to = ["a@x.com"]');
  ok(lastToast() === '已分别发送给 1 位收件人', `只发 1 封（实际「${lastToast()}」）`);

  console.log(`\n===== 结果: ${pass} passed, ${fail} failed =====`);
  if (fail) console.log('失败用例：\n - ' + failures.join('\n - '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
