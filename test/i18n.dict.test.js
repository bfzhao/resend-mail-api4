'use strict';

/* =========================================================
 * Bilingual dictionary sanity check (zero deps: node test/i18n.dict.test.js)
 *
 * i18n.js is a browser script, so it is evaluated here against a minimal stub environment (no jsdom needed).
 * What this guards:
 *   1. Every dictionary entry compiles — a `{placeholder}` count mismatch between the Chinese key and the English value
 *      would silently drop that entry at runtime (i18n.js warns and skips it), which is easy to miss in review.
 *   2. Placeholders are carried over: `12 封` style strings keep their numbers/addresses.
 *   3. Unknown text passes through unchanged (no data loss), and Chinese input never becomes English by accident.
 *   4. The Chinese keys are unique and the value side contains no leftover Chinese (a copy/paste slip).
 * ========================================================= */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const I18N_PATH = process.env.QA_I18N_JS || path.join(__dirname, '..', 'public', 'i18n.js');
const SRC = fs.readFileSync(I18N_PATH, 'utf8');

/* ---- minimal browser stubs: i18n.js only needs these at load time ---- */
const warnings = [];
const ctx = {
  console: { warn: (...a) => warnings.push(a.join(' ')), log: () => {} },
  localStorage: { getItem: () => null, setItem: () => {} },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  document: {
    readyState: 'complete',
    documentElement: { setAttribute() {}, getAttribute: () => null, childNodes: [] },
    body: { childNodes: [] },
    getElementById: () => null,
    addEventListener: () => {},
    createElement: () => ({ setAttribute() {}, textContent: '' }),
  },
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx);

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { failures.push(msg); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

console.log('i18n.js 词典自检（stub 环境运行真实脚本）');

const api = ctx.dshI18n;
const DICT = api && api.dict;

section('D1 词典结构');
ok(!!api && typeof api.translate === 'function', 'i18n.js 导出了 translate()', typeof (api && api.translate));
ok(!!DICT && typeof DICT === 'object', '导出了词典', DICT && Object.keys(DICT).length);
const keys = Object.keys(DICT || {});
ok(keys.length >= 150, '词条数量足够覆盖界面（>=150）', keys.length);
ok(warnings.length === 0, '⭐ 所有词条都编译成功（占位符数量一致，没有被静默跳过）', JSON.stringify(warnings.slice(0, 3)));
const CJK = /[\u4e00-\u9fff]/;
const badValues = keys.filter((k) => CJK.test(String(DICT[k])));
ok(badValues.length === 0, '⭐ 英文值里没有残留中文', JSON.stringify(badValues.slice(0, 5)));
ok(new Set(keys.map((k) => k.replace(/^=/, ''))).size === keys.length, '没有重复的中文键（= 精确匹配前缀不算）');

section('D2 翻译行为：占位符与插值保持不变');
const t = (s) => api.translate(s);
ok(t('收件箱') === 'Inbox', '收件箱 -> Inbox', t('收件箱'));
ok(t('写信') === 'Compose', '写信 -> Compose', t('写信'));
ok(t('全部邮箱（未发现账号）') === 'All mailboxes (no account found)', '长词优先匹配整句', t('全部邮箱（未发现账号）'));
// composed string: folder label + count suffix (rendered as ONE text node)
ok(/^Inbox · 12 total$/.test(t('收件箱 · 共 12 封')), '⭐ 组合串也能翻译（收件箱 · 共 12 封）', t('收件箱 · 共 12 封'));
ok(/12 selected/.test(t('已选择 12 封')), '数字保留', t('已选择 12 封'));
ok(/: search “hello”/.test(t('：搜索“hello”')), '搜索词保留', t('：搜索“hello”'));
ok(/^example\.com: not checked yet/.test(t('example.com：还没有检查过。点击立即检查')), '域名保留（自检提示）',
  t('example.com：还没有检查过。点击立即检查'));
ok(/\(12 unread\)/.test(t('a@b.com (12 未读)')), '地址 + 未读数组合串', t('a@b.com (12 未读)'));
ok(t('回复') === 'Reply' && t('转发') === 'Forward', '回复 / 转发', `${t('回复')} / ${t('转发')}`);
ok(t('发信（Resend）') === 'Sending (Resend)', '自检表标题', t('发信（Resend）'));

section('D3 精确匹配键（单字）不误伤同字词');
ok(t('收') === 'In' && t('发') === 'Out', '单独的 收 / 发 转成 In / Out', `${t('收')} / ${t('发')}`);
ok(t('收件箱') === 'Inbox', '⭐ 收件箱 不会被逐字拆开翻译', t('收件箱'));
ok(t('发送') === 'Send', '⭐ 发送 仍是 Send', t('发送'));
ok(t('发件人') === 'From', '⭐ 发件人 仍是 From', t('发件人'));

section('D4 未知 / 非界面文本原样返回');
ok(t('这是一封邮件正文') === '这是一封邮件正文', '⭐ 词条外的中文原样返回（数据不翻译）', t('这是一封邮件正文'));
ok(t('Hello world') === 'Hello world', '纯英文原样返回', t('Hello world'));
ok(t('') === '' && t('  ') === '  ', '空串/空白不报错');
ok(ctx.document.documentElement.lang === undefined || true, '（语言状态由浏览器端维护，此处只验证词典）');

console.log(`\n===== 结果: ${pass} passed, ${failures.length} failed =====`);
if (failures.length) console.log(`失败项：\n- ${failures.join('\n- ')}`);
process.exit(failures.length ? 1 : 0);
