'use strict';

/* =========================================================
 * Composer sender picker regression test (zero dependencies, node test/composer-sender-options.test.js)
 *
 * Bug: after adding a second domain, the account had no message history yet, so the sender list was empty and the
 * composer hid the whole sender row (#f-sender-row / #f-mailbox-row) — including the "＋ 自定义" entry — leaving no way
 * to pick a sender and therefore no way to send at all.
 *
 * The project frontend is a build-less native SPA with no npm test framework, so (like test/compose-guard.test.js) the
 * real functions are extracted from public/app.js verbatim and run in a vm context with a stubbed `state`. That keeps
 * this test dependency-free (no jsdom) while still asserting the production source.
 *
 * Invariants:
 *   ⭐ Configured default senders (GET /api/account.senders) are offered even with zero message history.
 *   ⭐ The list is never empty while a domain is configured (a non-empty list is exactly what makes the row visible).
 *   ⭐ A domain filter narrows the senders to that domain.
 *   ⭐ Negative control: nothing configured at all still yields an empty list (the row stays hidden; there is no domain).
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
  slice('function addrDomain(addr) {', '\n}\n', 'addrDomain') + '\n}\n',
  slice('function composerMailboxOptions() {', '\n}\n', 'composerMailboxOptions') + '\n}\n',
].join('\n');

const UNKNOWN_MAILBOX = '(未识别)';

function baseState() {
  return {
    mailboxList: [],
    customSenders: [],
    senders: [],
    fromAddress: '',
    composing: null,
    domainSel: [],
    domains: [],
  };
}

/** Run the real composerMailboxOptions() over a state patch. */
function options(patch) {
  const ctx = {
    state: Object.assign(baseState(), patch),
    UNKNOWN_MAILBOX,
  };
  vm.createContext(ctx);
  vm.runInContext(`${BLOCK}\n__out = composerMailboxOptions();`, ctx);
  return ctx.__out;
}

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { failures.push(msg); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

console.log('写信发件人选择器 —— 直接抽取 public/app.js 的真实函数运行');

section('S1 新增域名后没有任何邮件历史：发件人仍然可选');
{
  const list = options({
    domains: ['old.com', 'new.com'],
    senders: ['support@old.com', 'noreply@new.com'],
    fromAddress: 'support@old.com',
  });
  ok(list.length > 0, '⭐ 选项非空（非空 = 发件人行可见，#f-sender-row 不会被 hidden）', JSON.stringify(list));
  ok(list[0] === 'support@old.com', '默认发件人（配置的 from address）排在最前', JSON.stringify(list));
  ok(list.includes('noreply@new.com'), '新域的默认地址可选', JSON.stringify(list));
}

section('S2 选中某个域名：只显示该域的发件人');
{
  const list = options({
    domains: ['old.com', 'new.com'],
    senders: ['support@old.com', 'noreply@new.com'],
    fromAddress: 'support@old.com',
    domainSel: ['new.com'],
  });
  ok(list.join(',') === 'noreply@new.com', '⭐ 过滤器生效：只留 new.com 的地址（且非空）', JSON.stringify(list));
  const old = options({
    domains: ['old.com', 'new.com'],
    senders: ['support@old.com', 'noreply@new.com'],
    fromAddress: 'support@old.com',
    domainSel: ['old.com'],
  });
  ok(old.includes('support@old.com'), '切回 old.com 能选到它自己的发件人（旧域没有丢）', JSON.stringify(old));
}

section('S3 后端没给 senders（旧部署 / 降级）：用域名的默认地址兜底');
{
  const list = options({ domains: ['new.com'], senders: [] });
  ok(list.join(',') === 'noreply@new.com', '⭐ 兜底 noreply@<domain>（否则整行隐藏、无法发信）', JSON.stringify(list));
  const scoped = options({ domains: ['old.com', 'new.com'], senders: [], domainSel: ['new.com'] });
  ok(scoped.join(',') === 'noreply@new.com', '过滤到某域时同样有兜底', JSON.stringify(scoped));
}

section('S4 有历史邮箱：历史 + 配置默认地址去重合并');
{
  const list = options({
    domains: ['old.com'],
    mailboxList: [
      { mailbox: 'a@old.com', inbox_unread: 1 },
      { mailbox: UNKNOWN_MAILBOX, inbox_unread: 1 },
    ],
    senders: ['support@old.com', 'a@old.com'],
    fromAddress: 'support@old.com',
  });
  ok(list.includes('a@old.com') && list.includes('support@old.com'), '历史邮箱与配置地址都在', JSON.stringify(list));
  ok(!list.includes(UNKNOWN_MAILBOX), '「(未识别)」聚合分组不会出现在发件人里', JSON.stringify(list));
  ok(new Set(list).size === list.length, '无重复项', JSON.stringify(list));
}

section('S5 自定义发件人（会话内）参与候选');
{
  const list = options({
    domains: ['old.com'],
    senders: ['support@old.com'],
    customSenders: ['billing@old.com'],
  });
  ok(list.includes('billing@old.com'), '自定义发件人可被选中', JSON.stringify(list));
}

section('S6 负控制：完全没配置任何域名 -> 空列表（行保持隐藏）');
{
  const list = options({});
  ok(list.length === 0, '没有域名时返回空（此时也确实无法发信）', JSON.stringify(list));
}

console.log(`\n===== 结果: ${pass} passed, ${failures.length} failed =====`);
if (failures.length) console.log(`失败项：\n- ${failures.join('\n- ')}`);
process.exit(failures.length ? 1 : 0);
