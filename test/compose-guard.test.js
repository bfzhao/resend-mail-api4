'use strict';

/* =========================================================
 * Composer "close-window guard" regression test (zero dependencies, node test/compose-guard.test.js)
 *
 * The semantics were changed this round from "pop a 'discard?' confirm dialog" to "auto-save the draft then close directly".
 * This suite therefore guards two things at once: ① closing must persist a draft (PUT to the draftId from when it was opened);
 * ② the confirm dialog must not appear on any path.
 *
 * The project frontend is a build-less native SPA with no npm test framework. Here Node's built-in vm
 * module is used to extract the compose-related code from public/app.js verbatim and run it, together with a minimal
 * DOM stub, verifying the real source's behavior without introducing any dependency.
 *
 * What is extracted are the real functions (openComposer / openReplyComposer / insertQuote /
 * sendCompose / isComposerDirty ...), with only the IO-class dependencies (api / showToast /
 * list refresh) replaced by stubs, so both the baseline snapshot and the in-send guard follow the production code path.
 *
 * Extraction relies on comment markers in the source; if a marker is changed, the script fails with a clear error.
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
  // all the compose-related real implementations (including isRich / openComposer / openReplyComposer /
  // guard block / insertQuote / toggleRich / sendCompose)
  slice(
    'function plainToHtmlText(text) {',
    '\n\n/* ---------------- Search / keyboard / events / sync ---------------- */',
    'compose 主体'
  ),
  // the event wiring in setupEvents related to the composer dialog
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
  get pending() { return discardConfirmPending; },
  get lastFocus() { return composerLastFocus; },
  get baseline() { return composerBaseline; },
  get sendInFlight() { return sendInFlight; },
  resetGuard() { discardConfirmPending = false; composerLastFocus = null; },
  clearBaseline() { composerBaseline = null; },
  setCurrentMessage(m) { currentMessage = m; },
  // re-snapshot the current form as the baseline (same expression as inside openComposer).
  // Used to isolate the single variable of "body": fill in the recipients first then rebaseline, so any later diff can only come from the body.
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
  // simulate the browser: block-level tags / <br> produce newlines, &nbsp; reads as \u00a0
  get innerText() { return this._text; }
  set innerText(v) { this._text = v; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v; }
  // in a real browser an innerHTML change also updates innerText; here we do the equivalent conversion
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this._text = this._html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|&#160;|&#xa0;/gi, '\u00a0') // the browser restores entities to a real U+00A0
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
const confirmShown = () => !confirmMask.classList.contains('hidden');
const composerOpen = () => !modalMask.classList.contains('hidden');
const pressEsc = () => fire('#document', 'keydown', { key: 'Escape', preventDefault() {} });
const clickMask = () => fire('#modal-mask', 'click', { target: modalMask, currentTarget: modalMask });
const lastToast = () => (toasts.length ? toasts[toasts.length - 1].msg : '');

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

/** Go through the real openComposer(), so the baseline is recorded by production code */
function reset() {
  for (const e of Object.values(els)) e.focused = 0;
  toasts.length = 0;
  T.resetGuard();
  S.openComposer();
  T.resetGuard(); // openComposer also clears it internally, here to make sure once more
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

/** Make api hang, returning a controller that resolves/rejects manually */
function deferApi() {
  let resolveFn;
  let rejectFn;
  const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  S.__apiImpl = () => p;
  return { resolve: resolveFn, reject: rejectFn };
}

/**
 * Wait one microtask + macrotask turn.
 * Closing to save a draft is **synchronous close, asynchronous persist** (the click must take effect immediately, cannot wait for a network round trip),
 * so asserting "which request was sent" must wait for the async part to finish.
 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ---------------- test cases ---------------- */

async function main() {
  console.log('\n[1] 空表单：不脏、不提示、直接关闭');
  reset();
  ok(S.isComposerDirty() === false, '全空 -> 不脏');
  ok(T.baseline !== null, 'openComposer 已记录基线');
  S.requestCloseComposer();
  ok(composerOpen() === false, '空表单请求关闭 -> 直接关闭');
  ok(confirmShown() === false, '空表单 -> 不弹确认');
  ok(st.composing === null, '状态已清理');
  ok(T.baseline === null, '基线已清理');

  console.log('\n[2] 脏检测：各字段单独触发');
  for (const [label, set] of [
    ['收件人', () => (el('#f-to').value = 'a@b.com')],
    ['主题', () => (el('#f-subject').value = 'hi')],
    ['正文(textarea)', () => (el('#f-body').value = 'hello')],
    ['附件', () => (st.composing.files = [{ name: 'a.txt' }])],
  ]) {
    reset();
    set();
    ok(S.isComposerDirty() === true, `${label} 非空 -> 脏`);
  }

  console.log('\n[2b] 输入后又改回原样 -> 不脏（无内容可丢）');
  reset();
  el('#f-subject').value = 'x';
  ok(S.isComposerDirty() === true, '输入 x -> 脏');
  el('#f-subject').value = '';
  ok(S.isComposerDirty() === false, '清空回到基线 -> 不脏');
  S.requestCloseComposer();
  ok(composerOpen() === false, '回到基线后请求关闭 -> 直接关闭，不弹确认');

  console.log('\n[3] 脏检测：富文本');
  reset();
  st.composing.rich = true;
  el('#f-body-rich').innerText = '\n';
  ok(S.isComposerDirty() === false, '富文本仅 <br> -> 不脏');
  el('#f-body-rich').innerText = '\u00a0';
  ok(S.isComposerDirty() === false, '富文本仅 &nbsp; -> 不脏');
  el('#f-body-rich').innerText = 'x';
  ok(S.isComposerDirty() === true, '富文本有文字 -> 脏');

  console.log('\n[4] 切换富文本本身不弄脏表单（走真实 toggleRich）');
  reset();
  S.toggleRich(); // real function: empty textarea -> rich text
  ok(st.composing.rich === true, '已切到富文本');
  ok(S.isComposerDirty() === false, '空表单切到富文本 -> 仍不脏');
  // real order: switch back to plain-text input first, then to rich text; the content should be carried over and not lost
  S.toggleRich(); // rich text -> textarea
  ok(st.composing.rich === false, '已切回纯文本');
  el('#f-body').value = 'hello';
  S.toggleRich(); // textarea -> rich text
  ok(st.composing.rich === true, '再次切到富文本');
  ok(el('#f-body-rich').innerHTML === 'hello', '内容已搬运到富文本');
  ok(S.isComposerDirty() === true, '有文字切到富文本 -> 脏');
  S.toggleRich(); // rich text -> textarea
  ok(st.composing.rich === false, '切回纯文本');
  ok(el('#f-body').value === 'hello', '来回切换未丢内容');
  ok(S.isComposerDirty() === true, '来回切换后仍脏');

  console.log('\n[5] 有内容时：遮罩/取消/Esc 三个入口都「存草稿并关闭」');
  for (const [label, act] of [
    ['遮罩空白区', clickMask],
    ['取消按钮', () => fire('#composer-cancel', 'click', {})],
    ['Esc', pressEsc],
  ]) {
    reset();
    const draftId = st.composing.draftId;
    let putUrl = '';
    let putBody = null;
    S.__apiImpl = (url, opts) => {
      putUrl = url;
      putBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true });
    };
    el('#f-subject').value = '草稿';
    act();
    ok(composerOpen() === false, `${label} -> 弹窗关闭`);
    ok(confirmShown() === false, `${label} -> 不再弹放弃确认框`);
    ok(st.composing === null, `${label} -> 状态已清理`);
    ok(lastToast() === '已存入草稿', `${label} -> 提示已存入草稿`);
    await tick();
    ok(putUrl === `/api/drafts/${draftId}`, `${label} -> PUT 到打开时生成的那个草稿 id`);
    ok(putBody !== null && putBody.subject === '草稿', `${label} -> 内容随请求提交`);
  }

  console.log('\n[6] 关窗后重复触发无副作用（state.composing 已清）');
  reset();
  el('#f-subject').value = '草稿';
  clickMask();
  ok(composerOpen() === false, '首次触发即关闭');
  clickMask();
  pressEsc();
  pressEsc();
  ok(composerOpen() === false, '重复触发后仍是关闭态');
  ok(st.composing === null, '状态保持已清理');
  ok(confirmShown() === false, '全程不弹确认框');

  console.log('\n[7] 草稿 id：每次打开写信都换新的（不会覆盖上一封）');
  reset();
  const draftIdA = st.composing.draftId;
  ok(typeof draftIdA === 'string' && draftIdA.length > 0, '打开弹窗即生成草稿 id');
  reset();
  ok(st.composing.draftId !== draftIdA, '再次打开写信 -> 新的草稿 id');
  resetReply();
  ok(st.composing.draftId !== draftIdA && typeof st.composing.draftId === 'string', '回复弹窗也有独立草稿 id');

  console.log('\n[8] 关窗提交的草稿内容与表单一致');
  reset();
  let body8 = null;
  S.__apiImpl = (url, opts) => { body8 = JSON.parse(opts.body); return Promise.resolve({}); };
  el('#f-to').value = 'a@b.com, c@d.com';
  el('#f-subject').value = '主题8';
  el('#f-body').value = 'draft body';
  S.requestCloseComposer();
  await tick();
  ok(body8 !== null && body8.subject === '主题8', '主题已提交');
  ok(body8 !== null && body8.body === 'draft body', '正文已提交');
  ok(body8 !== null && body8.to === 'a@b.com, c@d.com', '收件人原样提交（切分口径归服务端）');
  ok(body8 !== null && body8.rich === false, '标记为非富文本');
  ok(body8 !== null && body8.mode === 'compose', '记录模式（供恢复时选标题与按钮）');
  ok(composerOpen() === false, '弹窗已关闭');

  console.log('\n[9] 空表单关窗：不写草稿（草稿箱里不留空条目）');
  reset();
  let calls9 = 0;
  S.__apiImpl = () => { calls9++; return Promise.resolve({}); };
  S.requestCloseComposer();
  await tick();
  ok(calls9 === 0, '空表单 -> 不发任何请求');
  ok(composerOpen() === false, '弹窗已关闭');
  ok(confirmShown() === false, '不弹确认框');
  ok(st.composing === null, '状态已清理');
  ok(T.pending === false, 'pending 无残留状态');

  console.log('\n[10] 发送成功路径：直接关闭、不弹确认');
  reset();
  el('#f-to').value = 'a@b.com';
  el('#f-subject').value = 's';
  el('#f-body').value = 'body';
  const okApi = deferApi();
  const okSend = S.sendCompose();
  ok(T.sendInFlight === true, '发送中 sendInFlight=true');
  okApi.resolve({ id: 'sent-1' });
  await okSend;
  ok(T.sendInFlight === false, '发送完成后 sendInFlight=false');
  ok(confirmShown() === false, '不弹放弃确认');
  ok(composerOpen() === false, '弹窗已关闭');
  ok(st.composing === null, '状态已清理');
  ok(lastToast() === '邮件已发送', '提示发送成功');

  console.log('\n[11] 发送失败路径：内容保留、弹窗不关');
  reset();
  el('#f-to').value = 'a@b.com';
  el('#f-body').value = 'body';
  const badApi = deferApi();
  const badSend = S.sendCompose();
  badApi.reject(new Error('网络错误'));
  await badSend;
  ok(T.sendInFlight === false, '失败后 sendInFlight=false');
  ok(composerOpen() === true, '弹窗仍打开');
  ok(confirmShown() === false, '不弹确认框');
  ok(st.composing !== null && el('#f-body').value === 'body', '内容保留');
  ok(lastToast().includes('发送失败'), '提示发送失败');

  console.log('\n[12] Esc：直接关窗并落草稿');
  reset();
  const id12 = st.composing.draftId;
  let url12 = '';
  S.__apiImpl = (url) => { url12 = url; return Promise.resolve({}); };
  el('#f-subject').value = '草稿';
  pressEsc();
  ok(composerOpen() === false, 'Esc -> 弹窗关闭');
  ok(confirmShown() === false, '不再弹确认框');
  ok(st.composing === null, '状态已清理');
  await tick();
  ok(url12 === `/api/drafts/${id12}`, 'Esc 关闭同样落盘草稿');

  console.log('\n[13] Esc：输入框内按 Esc 同样生效（不被 isTypingTarget 吞掉）');
  reset();
  el('#f-subject').value = '草稿';
  let prevented = false;
  fire('#document', 'keydown', {
    key: 'Escape',
    target: el('#f-subject'),
    preventDefault: () => (prevented = true),
  });
  ok(composerOpen() === false, '在输入框内按 Esc -> 关闭弹窗');
  ok(prevented === true, '已 preventDefault');

  console.log('\n[14] 遮罩 handler 只在 target===currentTarget 时触发');
  reset();
  el('#f-subject').value = 'x';
  const inner = new El('#composer-inner');
  fire('#modal-mask', 'click', { target: inner, currentTarget: modalMask });
  ok(confirmShown() === false, '点弹窗内部 -> 不弹确认框');
  ok(composerOpen() === true, '点弹窗内部 -> 不关闭');

  console.log('\n[15] 打开写信/回复时重置状态');
  reset();
  el('#f-subject').value = 'x';
  S.requestCloseComposer();
  reset();
  ok(confirmShown() === false, '重新 openComposer 后确认框保持隐藏');
  ok(T.pending === false, '重新 openComposer 后 pending=false');
  ok(st.composing !== null && typeof st.composing.draftId === 'string', '新弹窗带独立草稿 id');

  console.log('\n[16] 回复模式：预填的收件人/主题不算用户输入');
  resetReply();
  ok(composerOpen() === true, '回复弹窗打开');
  ok(el('#f-to').value === 'alice@example.com', '收件人已预填');
  ok(el('#f-subject').value === 'Re: 会议纪要', '主题已预填');
  ok(S.isComposerDirty() === false, '刚打开回复弹窗 -> 不脏');
  S.requestCloseComposer();
  ok(composerOpen() === false, '刚打开就点外部 -> 直接关闭，不弹确认');
  ok(confirmShown() === false, '未弹确认框');

  console.log('\n[17] 回复模式：点「引用原文」后关窗 -> 引用内容随草稿保存');
  resetReply();
  S.insertQuote(); // real function, rewrites #f-body.value
  ok(el('#f-body').value.length > 0, '引用原文已写入正文');
  ok(S.isComposerDirty() === true, '点引用原文 -> 脏');
  let body17 = null;
  S.__apiImpl = (url, opts) => { body17 = JSON.parse(opts.body); return Promise.resolve({}); };
  S.requestCloseComposer();
  await tick();
  ok(body17 !== null && body17.body.includes('原文第一行'), '引用内容随草稿保存');
  ok(body17 !== null && body17.mode === 'reply', '草稿记录了「回复」模式');
  ok(composerOpen() === false, '弹窗已关闭');
  ok(confirmShown() === false, '不弹确认框');

  console.log('\n[18] 回复模式：手动删掉预填收件人也算脏');
  resetReply();
  el('#f-to').value = '';
  ok(S.isComposerDirty() === true, '清空预填收件人 -> 脏（与基线不同即脏）');

  console.log('\n[19] 基线为 null 的兜底：不抛错，退回「任一非空即脏」');
  reset();
  T.clearBaseline();
  ok(S.isComposerDirty() === false, '基线 null + 空表单 -> 不脏');
  el('#f-subject').value = '   ';
  ok(S.isComposerDirty() === false, '基线 null + 主题仅空格 -> 不脏');
  el('#f-subject').value = 'x';
  ok(S.isComposerDirty() === true, '基线 null + 主题非空 -> 脏');
  el('#f-subject').value = '';
  st.composing.rich = true;
  el('#f-body-rich').innerText = 'rich';
  ok(S.isComposerDirty() === true, '基线 null + 富文本非空 -> 脏');
  el('#f-body-rich').innerText = '';
  st.composing.rich = false;
  el('#f-body').value = 'plain';
  ok(S.isComposerDirty() === true, '基线 null + 纯文本非空 -> 脏');
  ok(S.norm(null) === '' && S.norm(undefined) === '' && S.norm('  x  ') === 'x', 'norm 归一化正确');

  console.log('\n[20] 发送中禁止放弃（成功路径）');
  reset();
  el('#f-to').value = 'a@b.com';
  el('#f-body').value = 'body';
  const d1 = deferApi();
  const s1 = S.sendCompose();
  ok(T.sendInFlight === true, '发送中 sendInFlight=true');
  toasts.length = 0;
  S.requestCloseComposer();
  ok(composerOpen() === true, '发送中请求关闭 -> 弹窗不关');
  ok(confirmShown() === false, '发送中 -> 不弹放弃确认');
  ok(st.composing !== null, '发送中 -> 内容保留');
  ok(lastToast().includes('正在发送中'), '提示「邮件正在发送中」');
  clickMask();
  ok(composerOpen() === true, '发送中点遮罩 -> 同样被挡住');
  pressEsc();
  ok(composerOpen() === true, '发送中按 Esc -> 同样被挡住');
  d1.resolve({});
  await s1;
  ok(composerOpen() === false, '发送成功后正常关闭');
  ok(T.sendInFlight === false, 'sendInFlight 已复位');

  console.log('\n[21] 发送中禁止放弃（失败路径 —— 修复前的数据丢失场景）');
  reset();
  el('#f-to').value = 'a@b.com';
  el('#f-body').value = 'body';
  const d2 = deferApi();
  const s2 = S.sendCompose();
  S.requestCloseComposer(); // before the fix this would close the dialog
  ok(composerOpen() === true, '发送中无法放弃');
  d2.reject(new Error('boom'));
  await s2;
  ok(composerOpen() === true, '发送失败后弹窗仍在（内容未丢失）');
  ok(st.composing !== null && el('#f-body').value === 'body', '发送失败后内容完整保留');
  ok(T.sendInFlight === false, 'sendInFlight 已复位');
  // after a failure the normal close flow should resume (which likewise goes through "save draft")
  S.requestCloseComposer();
  ok(composerOpen() === false, '失败后再次请求关闭 -> 存草稿并关闭');
  ok(confirmShown() === false, '不再弹放弃确认框');

  console.log('\n[22] Fix1：正文只认当前可见的编辑器（消除「假提示」）');
  reset();
  el('#f-body').value = 'hi'; // plain-text input
  ok(S.isComposerDirty() === true, '纯文本输入 hi -> 脏');
  S.toggleRich(); // switch to rich text, content is carried over
  ok(el('#f-body-rich').innerText === 'hi', '内容已搬到富文本');
  ok(S.isComposerDirty() === true, '富文本里仍可见 hi -> 脏');
  el('#f-body-rich').innerHTML = ''; // delete all visible content inside the rich text
  ok(el('#f-body').value === 'hi', '隐藏的 #f-body 仍残留 hi');
  ok(S.isComposerDirty() === false, '富文本已删光 -> 不脏（不被隐藏残留误导）');
  S.requestCloseComposer();
  ok(composerOpen() === false, '点外部 -> 直接关闭，不弹确认');
  ok(confirmShown() === false, '未弹确认框');

  console.log('\n[23] Fix2：只敲空格不算输入（两种模式一致）');
  for (const [label, set] of [
    ['收件人', () => (el('#f-to').value = '   ')],
    ['主题', () => (el('#f-subject').value = '   ')],
    ['正文(textarea)', () => (el('#f-body').value = '   ')],
  ]) {
    reset();
    set();
    ok(S.isComposerDirty() === false, `${label} 仅空格 -> 不脏`);
  }
  reset();
  st.composing.rich = true;
  el('#f-body-rich').innerText = '\u00a0\u00a0';
  ok(S.isComposerDirty() === false, '富文本仅 &nbsp; -> 不脏');
  reset();
  el('#f-body').value = '  hi  ';
  ok(S.isComposerDirty() === true, '前后有空格但含文字 -> 仍脏');
  reset();
  el('#f-to').value = '   ';
  S.requestCloseComposer();
  ok(composerOpen() === false, '只敲空格后点外部 -> 直接关闭，不弹确认');

  console.log('\n[24] Fix3：改「发件人」下拉 -> 脏，且新发件人随草稿保存');
  reset();
  const mbEl = el('#f-mailbox');
  ok(mbEl.value === 'me@example.com', '发件人已预选');
  ok(S.isComposerDirty() === false, '未改动 -> 不脏');
  mbEl.value = 'other@example.com';
  el('#f-subject').value = 's24'; // a draft only persists when there is real content (changing only the sender does not count as "content")
  ok(S.isComposerDirty() === true, '改了发件人 -> 脏');
  let body24 = null;
  S.__apiImpl = (url, opts) => { body24 = JSON.parse(opts.body); return Promise.resolve({}); };
  S.requestCloseComposer();
  await tick();
  ok(body24 !== null && body24.mailbox === 'other@example.com', '草稿带上了新选的发件人');
  ok(composerOpen() === false, '弹窗已关闭');

  console.log('\n[25] N1：富文本仅 &nbsp; -> 点发送应被拦下（修复前会发出空白邮件）');
  reset();
  el('#f-to').value = 'a@b.com';
  st.composing.rich = true;
  T.rebaseline(); // bring the recipients into the baseline, isolating the single variable of the body
  el('#f-body-rich').innerHTML = '<div>&nbsp;</div>';
  ok(S.isComposerDirty() === false, '守卫判「无内容」');
  let calls25 = 0;
  S.__apiImpl = () => { calls25++; return Promise.resolve({}); };
  toasts.length = 0;
  await S.sendCompose();
  ok(calls25 === 0, '未发出任何请求');
  ok(lastToast() === '请填写邮件内容', '提示「请填写邮件内容」');
  ok(composerOpen() === true, '弹窗未关闭，内容保留');

  console.log('\n[25b] 对照：富文本有真实文字 -> 正常发送（未改坏正常路径）');
  reset();
  el('#f-to').value = 'a@b.com';
  st.composing.rich = true;
  T.rebaseline();
  el('#f-body-rich').innerHTML = '<div>hi</div>';
  ok(S.isComposerDirty() === true, '守卫判「有内容」');
  let calls25b = 0;
  S.__apiImpl = () => { calls25b++; return Promise.resolve({}); };
  toasts.length = 0;
  await S.sendCompose();
  ok(calls25b === 1, '请求已发出');
  ok(lastToast() === '邮件已发送', '提示发送成功');
  ok(composerOpen() === false, '发送成功后关闭');

  console.log('\n[26] 守卫与发送校验对同一份富文本内容必须同判（方案 B 的目的）');
  for (const [label, richHtml, expect] of [
    ['仅 &nbsp;', '<div>&nbsp;</div>', false],
    ['仅 &#160;', '<div>&#160;</div>', false],
    ['仅 <br>', '<div><br></div>', false],
    ['仅空格', '<div> </div>', false],
    ['真实文字', '<div>hi</div>', true],
    ['文字夹 &nbsp;', '<div>&nbsp;hi&nbsp;</div>', true],
  ]) {
    reset();
    el('#f-to').value = 'a@b.com';
    st.composing.rich = true;
    T.rebaseline(); // fix everything except the body first, then only change the body
    el('#f-body-rich').innerHTML = richHtml;
    const guardSaysContent = S.isComposerDirty();
    let called = 0;
    S.__apiImpl = () => { called++; return Promise.resolve({}); };
    toasts.length = 0;
    await S.sendCompose();
    const sendProceeded = called > 0;
    ok(sendProceeded === guardSaysContent, `[${label}] 守卫=${guardSaysContent} 与发送侧=${sendProceeded} 一致`);
    ok(guardSaysContent === expect, `[${label}] 判定符合预期（期望 ${expect}）`);
  }

  console.log(`\n===== 结果: ${pass} passed, ${fail} failed =====`);
  if (fail) console.log('失败用例：\n - ' + failures.join('\n - '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
