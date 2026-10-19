'use strict';

/* =========================================================
 * Detail-pane identity & reply-button regression (zero deps: node test/detail-actions.test.js)
 *
 * Two user-reported issues, both rooted in the old single-account assumption:
 *   1. Outbound mail was labelled with the literal "我" (avatar). With several managed domains that send to each other,
 *      both sides are "me", so the marker is meaningless — the real address must be shown instead.
 *   2. A message we sent to one of our own addresses is stored twice: the thread keeps the outbound copy and folds the
 *      received one into `copy_ids`. That made "incoming" mail from another managed domain show only 转发, no 回复.
 *      `inboundCopyIdOf()` resolves the folded inbound copy so the reply button can target it.
 *
 * As with compose-guard.test.js, the real functions are extracted from public/app.js verbatim and run in a vm sandbox
 * (the project has no test framework and no build step).
 * ========================================================= */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS_PATH = process.env.QA_APP_JS || path.join(__dirname, '..', 'public', 'app.js');
const SRC = fs.readFileSync(APP_JS_PATH, 'utf8');

function slice(startMarker, endMarker, label) {
  const s = SRC.indexOf(startMarker);
  if (s < 0) throw new Error(`未找到起始标记（${label}）：${startMarker}`);
  const e = SRC.indexOf(endMarker, s);
  if (e < 0) throw new Error(`未找到结束标记（${label}）：${endMarker}`);
  return SRC.slice(s, e);
}

const BLOCK = [
  slice('function jsonArr(v) {', '\n}\n', 'jsonArr') + '\n}\n',
  slice('function avatarChar(item) {', '\n}\n', 'avatarChar') + '\n}\n',
  slice('function isCurrentThreadRow(t) {', '\n}\n', 'isCurrentThreadRow') + '\n}\n',
  slice('function inboundCopyIdOf(m) {', '\n}\n', 'inboundCopyIdOf') + '\n}\n',
  slice('function addrDomain(addr) {', '\n}\n', 'addrDomain') + '\n}\n',
  slice('const DOMAIN_PALETTE = [', '\n];\n', 'DOMAIN_PALETTE') + '\n];\n',
  slice('function domainSlot(domain) {', '\n}\n', 'domainSlot') + '\n}\n',
  slice('function domainColor(domain) {', '\n}\n', 'domainColor') + '\n}\n',
  slice('function domainHue(domain) {', '\n}\n', 'domainHue') + '\n}\n',
  slice('function itemDomain(item) {', '\n}\n', 'itemDomain') + '\n}\n',
  slice('function setDomainHue(el, domain) {', '\n}\n', 'setDomainHue') + '\n}\n',
].join('\n');

/** A minimal element stand-in for setDomainHue (jsdom is not needed for these pure functions). */
function fakeEl() {
  const classes = new Set();
  const props = new Map();
  return {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
      getPropertyValue: (k) => props.get(k) || '',
    },
    classes,
    props,
  };
}

/** Run the extracted functions with a fresh module state (currentMessage / currentThread / state are module-level). */
function sandbox(opts = {}) {
  const ctx = {
    currentMessage: opts.currentMessage || null,
    currentThread: opts.currentThread || [],
    state: { domains: opts.domains || [] },
  };
  vm.createContext(ctx);
  vm.runInContext(BLOCK, ctx);
  return ctx;
}

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { failures.push(msg); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

console.log('详情页身份标记 / 回复按钮 —— 抽取 public/app.js 真实函数运行');

section('A1 头像不再用「我」：出站显示实际发件地址首字母');
{
  const ctx = sandbox();
  const ch = ctx.avatarChar({ direction: 'outbound', from_email: 'support@beta-mail.test', mailbox: 'support@beta-mail.test' });
  ok(ch !== '我', '⭐ 出站不再返回「我」', ch);
  ok(ch === 'S', '出站头像 = 发件地址首字母（support -> S）', ch);
  const ch2 = ctx.avatarChar({ direction: 'outbound', from_email: 'noreply@alpha-mail.test', mailbox: 'noreply@alpha-mail.test' });
  ok(ch2 === 'N', '不同域的出站邮件显示各自地址的首字母', ch2);
  const empty = ctx.avatarChar({ direction: 'outbound' });
  ok(empty === '?', '没有地址时退回 ?（不再假装是「我」）', empty);
}

section('A2 入站头像仍优先显示发件人名字');
{
  const ctx = sandbox();
  ok(ctx.avatarChar({ direction: 'inbound', from_name: '张丽丽', from_email: 'zhang@x.com' }) === '张', '用名字首字');
  ok(ctx.avatarChar({ direction: 'inbound', from_email: 'alice@x.com' }) === 'A', '没有名字时用地址首字母');
}

section('A3 自寄邮件（回环副本）：能定位到入站副本，从而提供「回复」');
{
  // outbound origin with a folded inbound copy
  const origin = { id: 'o1', direction: 'outbound', mailbox: 'b@wenwen.com', from_email: 'a@notion.com', copy_ids: ['i1'] };
  const ctx = sandbox({ currentMessage: origin, currentThread: [{ ...origin, copy_ids: ['i1'] }] });
  ok(ctx.isCurrentThreadRow({ id: 'o1', copy_ids: [] }), '当前消息匹配到会话行');
  ok(ctx.inboundCopyIdOf(origin) === 'i1', '⭐ 解析出被折叠的入站副本 id（回复要打给它）', ctx.inboundCopyIdOf(origin));

  // plain outbound with no received copy -> no reply button
  const plain = { id: 'o2', direction: 'outbound', copy_ids: [] };
  const ctx2 = sandbox({ currentMessage: plain, currentThread: [plain] });
  ok(ctx2.inboundCopyIdOf(plain) === '', '没有入站副本时返回空（不提供回复）', ctx2.inboundCopyIdOf(plain));

  // inbound message: the reply button is driven by direction, no copy needed
  const inbound = { id: 'i2', direction: 'inbound', mailbox: 'b@wenwen.com' };
  const ctx3 = sandbox({ currentMessage: inbound, currentThread: [inbound] });
  ok(ctx3.inboundCopyIdOf(inbound) === '', '入站消息本身不需要找副本', ctx3.inboundCopyIdOf(inbound));

  // copy_ids may arrive as a JSON string (thread rows pass through the API as-is)
  const originStr = { id: 'o3', direction: 'outbound', mailbox: 'b@wenwen.com', from_email: 'a@notion.com' };
  const ctx4 = sandbox({ currentMessage: originStr, currentThread: [{ ...originStr, copy_ids: '["i3"]' }] });
  ok(ctx4.inboundCopyIdOf(originStr) === 'i3', 'copy_ids 是 JSON 字符串时也能解析', ctx4.inboundCopyIdOf(originStr));
}

section('A4 每个域名一个颜色：用固定调色板，相邻色也能区分');
{
  const ctx = sandbox();
  // `const` at script top level lives in the context's global lexical scope, not on the context object.
  const P = vm.runInContext('DOMAIN_PALETTE', ctx);
  ok(Array.isArray(P) && P.length >= 6, '调色板至少 6 色', P && P.length);
  ok(P.every((c) => Number.isInteger(c.h) && c.h >= 0 && c.h < 360 && c.s > 0 && c.s <= 100),
    '每色都是合法 hue/saturation', JSON.stringify(P));

  // 色彩学上的可区分性：相邻色相至少差 25°，且不出现「泥泞」的黄绿中间带被重复占用
  const hues = P.map((c) => c.h).sort((a, b) => a - b);
  const gaps = hues.map((h, i) => (i === 0 ? h + 360 - hues[hues.length - 1] : h - hues[i - 1]));
  ok(Math.min(...gaps) >= 25, '⭐ 任意两色的色相至少相差 25°（不会糊成一片）', JSON.stringify(gaps));
  ok(new Set(P.map((c) => `${c.h}/${c.s}`)).size === P.length, '没有重复的颜色', JSON.stringify(P.map((c) => `${c.h}/${c.s}`)));

  // 分配：按已配置域名的顺序取槽位 -> 前 8 个域必然互不相同
  const eight = ['d1.com', 'd2.com', 'd3.com', 'd4.com', 'd5.com', 'd6.com', 'd7.com', 'd8.com'];
  const ctx8 = sandbox({ domains: eight });
  const colors8 = eight.map((d) => ctx8.domainColor(d));
  ok(colors8.every((c) => !!c), '每个域都拿到一个颜色', JSON.stringify(colors8));
  ok(new Set(colors8.map((c) => `${c.h}/${c.s}`)).size === 8,
    '⭐ 前 8 个域名颜色两两不同（不会再撞色）', JSON.stringify(colors8.map((c) => `${c.h}/${c.s}`)));

  // 真实两个域
  const real = sandbox({ domains: ['alpha-mail.test', 'beta-mail.test'] });
  ok(real.domainHue('alpha-mail.test') !== real.domainHue('beta-mail.test'),
    '⭐ 两个真实域名的色相不同', `${real.domainHue('alpha-mail.test')} vs ${real.domainHue('beta-mail.test')}`);
  ok(real.domainColor('ALPHA-MAIL.TEST') === real.domainColor('alpha-mail.test'), '大小写不影响颜色');

  // 还没进列表的域名：仍从调色板取色（不会出现随机色相）
  const unknown = ctx.domainColor('brand-new.com');
  ok(!!unknown && P.some((c) => c.h === unknown.h), '⭐ 未配置的域名也从调色板取色', JSON.stringify(unknown));
  ok(ctx.domainColor('') === null, '没有域名时无色（不着色）', String(ctx.domainColor('')));

  ok(ctx.itemDomain({ mailbox: 'noreply@alpha-mail.test' }) === 'alpha-mail.test', '取 mailbox 的域名（收件=收件域）');
  ok(ctx.itemDomain({ mailbox: 'support@beta-mail.test', direction: 'outbound' }) === 'beta-mail.test',
    '出站也取 mailbox 的域名（= 发件域）');
  ok(ctx.itemDomain({}) === '', '没有 mailbox 时为空（例如未选发件人的草稿）');
}

section('A5 setDomainHue：写入 --dom-h / --dom-s 与标记类，域名未知时清掉');
{
  const ctx = sandbox({ domains: ['alpha-mail.test', 'beta-mail.test'] });
  const el = fakeEl();
  ok(ctx.setDomainHue(el, 'beta-mail.test') === true, '设置成功');
  const c = ctx.domainColor('beta-mail.test');
  ok(el.props.get('--dom-h') === String(c.h), '⭐ 写入了该域名的色相', el.props.get('--dom-h'));
  ok(el.props.get('--dom-s') === `${c.s}%`, '⭐ 写入了该域名的饱和度（CSS 用它算底色）', el.props.get('--dom-s'));
  ok(el.classList.contains('has-dom-color'), '加了 has-dom-color 标记（CSS 据此上底色）');
  ok(ctx.setDomainHue(el, '') === false, '域名未知时返回 false');
  ok(!el.classList.contains('has-dom-color') && el.props.get('--dom-h') === undefined && el.props.get('--dom-s') === undefined,
    '⭐ 未知域名会清掉颜色（不着色）');
}

console.log(`\n===== 结果: ${pass} passed, ${failures.length} failed =====`);
if (failures.length) console.log(`失败项：\n- ${failures.join('\n- ')}`);
process.exit(failures.length ? 1 : 0);
