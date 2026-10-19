#!/usr/bin/env node
'use strict';

/**
 * Layer 3 verification: real HTTP integration (merge send)
 *
 * Difference from the other 4 suites: this suite stubs **nothing**; it sends HTTP requests directly to a really running Worker,
 * exercising the real D1 / R2 / routes / JSON parsing. It fills in the end-to-end chain (routes, auth, static assets, real serialization)
 * that the "drive compose() after compiling" layer cannot cover.
 *
 * Usage:
 *   1) Open another terminal and start the local server:  npx wrangler dev --port 8799 --local
 *   2) Run this suite:                node test/mail-merge.live.js
 *   Override a different port/address:        BASE=http://127.0.0.1:8787 node test/mail-merge.live.js
 *
 * Zero dependencies: uses only Node's built-in capabilities (Node 18+'s global fetch).
 *
 * ⚠️ Without a real RESEND_API_KEY, all **actual deliveries** fail (the runtime error is a Chinese
 *    "RESEND_API_KEY not configured" message),
 *    so what this suite covers is: parameter validation, dynamic cap, dedup order, HTTP status contract, failure classification and response shape.
 *    Real delivery must be manually tested after configuring a key (see delivery notes E2-E4).
 */

const BASE = (process.env.BASE || process.argv[2] || 'http://127.0.0.1:8799').replace(/\/+$/, '');

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? `  -> ${detail}` : ''));
    console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep null on non-JSON, to aid assertion error reporting */ }
  return { status: res.status, data, text };
}

async function get(path) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  return { status: res.status, text };
}

const att = (n) =>
  Array.from({ length: n }, (_, i) => ({
    filename: `f${i}.txt`,
    content: Buffer.from('hello').toString('base64'),
    content_type: 'text/plain',
  }));

const addrs = (n) => Array.from({ length: n }, (_, i) => `u${i}@x.com`).join(', ');

const MERGE_KEYS = ['merge', 'total', 'sent_count', 'failed_count', 'sent', 'failed'];

async function main() {
  // ---- precondition: confirm the service is running, otherwise clearly say how to start it rather than masquerading as a failure ----
  let health;
  try {
    health = await get('/health');
  } catch (err) {
    console.log(`\n[跳过] 无法连接 ${BASE} —— ${String(err)}`);
    console.log('\n本套件需要一个正在运行的本地 Worker。请先：');
    console.log('  npx wrangler dev --port 8799 --local');
    console.log('然后在另一个终端运行：');
    console.log('  node test/mail-merge.live.js');
    console.log('\n（或指定地址：BASE=http://127.0.0.1:8787 node test/mail-merge.live.js）');
    process.exit(2);
  }
  ok(health.status === 200, '/health 可达且 200', `status=${health.status}`);

  // ---- A. static assets really carry the new feature ----
  section('[A] 静态资源：合并发送 UI 已随部署生效');
  const idx = await get('/');
  ok(idx.status === 200, '/ 返回 200', `status=${idx.status}`);
  ok(idx.text.includes('f-merge'), '/ 的 HTML 含 #f-merge（勾选框已上线）');
  ok(/<link[^>]+rel="icon"[^>]+favicon\.svg/.test(idx.text),
    '/ 的 HTML 引用 /favicon.svg（不再是空 data: -> 浏览器显示默认地球）');
  const ico = await get('/favicon.svg');
  ok(ico.status === 200, '/favicon.svg 返回 200（浏览器能真正取到图标）', `status=${ico.status}`);
  ok(/<svg[\s>]/.test(ico.text) && /<\/svg>/.test(ico.text),
    '/favicon.svg 是一份合法 SVG', ico.text.slice(0, 40).replace(/\n/g, ' '));
  const js = await get('/app.js');
  ok(js.status === 200, '/app.js 返回 200', `status=${js.status}`);
  ok(js.text.includes('parseRecipients'), '/app.js 含 parseRecipients（前端多收件人解析已上线）');
  ok(js.text.includes('f-merge'), '/app.js 含 f-merge 接线');
  // the conversation row / envelope card show "the actual sending/receiving mailbox" -- catches "code changed but did not take effect"
  ok(js.text.includes('endpointsOf'), '/app.js 含 endpointsOf（会话行收发双方口径已上线）');
  ok(js.text.includes('收至'), '/app.js 含「收至」（来信显示我方收件信箱）');

  // ---- B. parameter validation and dynamic cap (no real key needed)----
  section('[B] 参数校验与「按附件数动态计算」的上限');
  const b1 = await post('/api/messages', { to: '', subject: 'S', body: 'B', merge: true });
  ok(b1.status === 400, 'merge + 0 收件人 -> 400', `status=${b1.status}`);
  ok(b1.data && b1.data.error === '缺少收件人', '错误文案 = 缺少收件人', JSON.stringify(b1.data));

  const b2 = await post('/api/messages', { to: addrs(23), subject: 'S', body: 'B', merge: true });
  ok(b2.status === 400, '0 附件 + 23 人 -> 400（cap=22）', `status=${b2.status}`);
  ok(b2.data && b2.data.error === '单次合并发送最多 22 位收件人', '错误文案 = 最多 22 位（无附件无后缀）', JSON.stringify(b2.data));

  const b3 = await post('/api/messages', { to: addrs(22), subject: 'S', body: 'B', merge: true });
  ok(b3.status === 200, '0 附件 + 22 人 -> 200（正好在 cap 上）', `status=${b3.status}`);

  const b4 = await post('/api/messages', { to: addrs(12), subject: 'S', body: 'B', merge: true, attachments: att(1) });
  ok(b4.status === 400, '1 附件 + 12 人 -> 400（cap=11）', `status=${b4.status}`);
  ok(b4.data && b4.data.error === '单次合并发送最多 11 位收件人（当前 1 个附件）', '错误文案含附件后缀', JSON.stringify(b4.data));

  const b5 = await post('/api/messages', { to: addrs(11), subject: 'S', body: 'B', merge: true, attachments: att(1) });
  ok(b5.status === 200, '1 附件 + 11 人 -> 200', `status=${b5.status}`);

  const b6 = await post('/api/messages', { to: addrs(8), subject: 'S', body: 'B', merge: true, attachments: att(3) });
  ok(b6.status === 400, '3 附件 + 8 人 -> 400（cap=7）', `status=${b6.status}`);
  ok(b6.data && b6.data.error === '单次合并发送最多 7 位收件人（当前 3 个附件）', '错误文案 = 最多 7 位（3 个附件）', JSON.stringify(b6.data));

  const b7 = await post('/api/messages', { to: addrs(7), subject: 'S', body: 'B', merge: true, attachments: att(3) });
  ok(b7.status === 200, '3 附件 + 7 人 -> 200', `status=${b7.status}`);

  // dedup must happen before the cap check: 30 identical addresses dedup to only 1, and must never be flagged as over the cap
  const b8 = await post('/api/messages', { to: Array.from({ length: 30 }, () => 'a@x.com').join(', '), subject: 'S', body: 'B', merge: true });
  ok(b8.status === 200, '30 个相同地址 -> 200（去重先于判上限）', `status=${b8.status}`);
  ok(b8.data && b8.data.total === 1, '去重后 total=1', JSON.stringify(b8.data));

  const b9 = await post('/api/messages', { to: 'a@x.com', subject: 'S', body: 'B', merge: true, attachments: 'not-an-array' });
  ok(b9.status === 400, 'attachments 非数组 -> 400', `status=${b9.status}`);
  ok(b9.data && b9.data.error === '附件格式错误', '错误文案 = 附件格式错误', JSON.stringify(b9.data));

  // ---- C. merge response contract (real HTTP 200 + failure classification)----
  section('[C] merge 响应契约：一律 HTTP 200 + 失败明细');
  const c1 = await post('/api/messages', { to: 'a@x.com, b@y.com', subject: 'S', body: 'B', merge: true });
  ok(c1.status === 200, '全部失败仍是 HTTP 200（不是 5xx）', `status=${c1.status}`);
  const c = c1.data || {};
  ok(c.ok === false, 'ok=false（未全成功）');
  ok(c.merge === true, 'merge=true');
  ok(c.total === 2, 'total=2', String(c.total));
  ok(c.sent_count === 0, 'sent_count=0', String(c.sent_count));
  ok(c.failed_count === 2, 'failed_count=2', String(c.failed_count));
  ok(Array.isArray(c.sent) && c.sent.length === 0, 'sent 为空数组');
  ok(Array.isArray(c.failed) && c.failed.length === 2, 'failed 有 2 条', JSON.stringify(c.failed));
  ok(c.failed && c.failed[0] && c.failed[0].to === 'a@x.com' && c.failed[1] && c.failed[1].to === 'b@y.com', 'failed 保序对应输入', JSON.stringify(c.failed));
  ok(c.failed && c.failed.every((f) => typeof f.error === 'string' && f.error.length > 0), '每条 failed 都带非空 error');

  // ---- D. backward compatibility: a non-merge response must never contain any merge field ----
  section('[D] 向后兼容：非 merge 请求响应不含任何 merge 字段');
  for (const [label, val] of [['缺省', undefined], ['false', false], ['"true" 字符串', 'true'], ['1 数字', 1], ['null', null]]) {
    const body = { to: 'a@x.com', subject: 'S', body: 'B' };
    if (val !== undefined) body.merge = val;
    const r = await post('/api/messages', body);
    const d = r.data || {};
    const leaked = MERGE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(d, k));
    ok(leaked.length === 0, `merge=${label} -> 响应无 merge 字段`, `泄漏: ${leaked.join(',')} / body=${r.text.slice(0, 120)}`);
    ok(!('merge' in d), `merge=${label} -> 严格非 merge 路径`, r.text.slice(0, 120));
  }

  // ---- summary ----
  console.log('\n================ 失败用例清单 ================');
  if (failures.length === 0) {
    console.log('（无）');
  } else {
    failures.forEach((f, i) => console.log(`${i + 1}. ${f}`));
  }
  console.log(`\n目标服务: ${BASE}`);
  console.log(`===== 结果: ${passed} passed, ${failed} failed =====`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[异常]', err);
  process.exit(1);
});
