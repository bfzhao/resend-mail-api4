'use strict';

/* =============================================================================
 * Regression: "added a domain, lost the previous one" + "no sender to choose from"
 *
 * Run:
 *   <node.exe> test/multi-domain-account.backend.test.js
 *
 * Approach (no test framework, zero extra deps):
 *   1. Compile the real src/ with the repo's own tsc into a temp dir outside the repo;
 *   2. Drive the real Worker routing (`worker.default.fetch`) against a **real SQLite** D1 built from schema.sql;
 *   3. Stub api.cloudflare.com / api.resend.com / dns.google so the setup wizard can run end to end.
 *
 * Scenarios that must hold (production bug report, 2026-10):
 *   ⭐ A deployment configured only through env vars (SEND_FROM_ADDRESS=support@old.com) keeps old.com in
 *      GET /api/account.domains after a second domain is added in-app — it must not be replaced by the new domain.
 *   ⭐ GET /api/account.senders always offers a usable default sender, even for a domain with **no message history**
 *      (that emptiness used to hide the composer's sender row completely, so no mail could be sent).
 *   ⭐ The in-app domain wizard must not hijack app_config's primary domain / default sender.
 *   ⭐ The RFC 2606 template placeholder (inbox@example.com) never shows up as a sending domain.
 *
 * Exit codes: 0 = all pass; 1 = failures; 2 = missing environment.
 * This file does not modify public/ or src/.
 * ===========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('node:sqlite 不可用（需要 Node >= 22.5）。', String(e && e.message));
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const WORK_DIR = path.join(os.tmpdir(), `multi-domain-qa-build-${process.pid}`);
const SRC_COPY = path.join(WORK_DIR, 'src');
const BUILD_DIR = path.join(WORK_DIR, 'out');

function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc: ${tsc}`);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(SRC_COPY, { recursive: true });
  try {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WORK_DIR, 'node_modules'), 'junction');
  } catch (e) {
    throw new Error(`无法为临时编译目录链接 node_modules: ${e.message}`);
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (f.endsWith('.ts')) fs.copyFileSync(path.join(ROOT, 'src', f), path.join(SRC_COPY, f));
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
  delete cfg.include;
  delete cfg.exclude;
  cfg.files = fs.readdirSync(SRC_COPY).filter((f) => f.endsWith('.ts')).map((f) => path.join(SRC_COPY, f));
  cfg.compilerOptions = Object.assign({}, cfg.compilerOptions, {
    noEmit: false,
    module: 'commonjs',
    outDir: BUILD_DIR,
    rootDir: SRC_COPY,
  });
  const cfgPath = path.join(WORK_DIR, 'tsconfig.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  // stdio: 'inherit' — a captured pipe needs a named pipe, which some confined sandboxes deny (EPERM); the compile
  // output is not asserted anyway, only the exit status.
  const r = spawnSync(process.execPath, [tsc, '-p', cfgPath], { cwd: ROOT, stdio: 'inherit' });
  if (r.error) throw new Error(`tsc 无法启动: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`tsc 编译失败(exit=${r.status})`);
  if (!fs.existsSync(path.join(BUILD_DIR, 'index.js'))) throw new Error(`编译产物缺失: ${path.join(BUILD_DIR, 'index.js')}`);
  return BUILD_DIR;
}

function cleanup() {
  const link = path.join(WORK_DIR, 'node_modules');
  try {
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch { /* ignore */ }
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeD1() {
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const prepare = (sql) => {
    const st = {
      sql, args: [],
      bind(...a) { st.args = a; return st; },
      async run() { const r = db.prepare(sql).run(...norm(st.args)); return { success: true, results: [], meta: { changes: Number(r.changes) } }; },
      async first() { const row = db.prepare(sql).get(...norm(st.args)); return row === undefined ? null : row; },
      async all() { return { results: db.prepare(sql).all(...norm(st.args)), success: true, meta: {} }; },
    };
    return st;
  };
  return {
    prepare,
    batch: async (arr) => { for (const s of arr) await s.run(); return []; },
    exec: async () => ({ count: 0, duration: 0 }),
    query: (sql, ...a) => db.prepare(sql).all(...norm(a)),
    queryOne: (sql, ...a) => { const r = db.prepare(sql).get(...norm(a)); return r === undefined ? null : r; },
    run: (sql, ...a) => db.prepare(sql).run(...norm(a)),
  };
}

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { failures.push(msg); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

function sessionCookieOf(res) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  const c = all.find((x) => x && x.startsWith('mail_session='));
  return c ? c.split(';')[0] : null;
}

const CF_TOKEN = 'cf-secret-token-xyz';
const RESEND_KEY = 're_totally_secret_key';

(async function main() {
  console.log('多域账号信息（旧域不丢 / 发件人可选）—— 真实 SQLite + 真实编译产物 + 真实 Worker 路由');
  let entry;
  try { entry = build(); }
  catch (e) {
    console.error(`\n编译失败，无法继续：${e.message}`);
    process.exit(2);
  }

  const worker = require(path.join(entry, 'index.js'));
  const send = require(path.join(entry, 'send.js'));
  const db = makeD1();

  // Production situation: the deployment was configured through env vars only (no app_config.domain).
  const env = {
    DB: db,
    RESEND_API_KEY: 're_env_key',
    SEND_FROM_ADDRESS: 'support@old.com',
    SEND_FROM_NAME: 'Old Brand',
  };

  /* ---------------- external API stubs ---------------- */
  const dnsRecords = [];
  /** Authorization headers of the real send calls (POST /emails), in order — proves which domain's key was used. */
  const sentAuth = [];
  const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = String((init && init.method) || 'GET').toUpperCase();
    const body = init && init.body ? JSON.parse(init.body) : null;

    if (u.startsWith('https://api.cloudflare.com/client/v4/zones?')) {
      const name = new URL(u).searchParams.get('name') || '';
      return jsonRes({ success: true, result: [{ id: 'zone-1', name }] });
    }
    if (/\/zones\/zone-1\/email\/routing$/.test(u)) return jsonRes({ success: true, result: { enabled: true } });
    if (/\/zones\/zone-1\/email\/routing\/dns$/.test(u) && method === 'POST') return jsonRes({ success: true, result: { enabled: true } });
    if (/\/zones\/zone-1\/email\/routing\/rules\/catch_all$/.test(u)) return jsonRes({ success: true, result: { enabled: true, actions: body.actions } });
    if (/\/zones\/zone-1\/dns_records\?/.test(u) && method === 'GET') {
      const q = new URL(u);
      const name = q.searchParams.get('name') || '';
      const type = q.searchParams.get('type') || '';
      return jsonRes({ success: true, result: dnsRecords.filter((r) => r.name === name && (!type || r.type === type)) });
    }
    if (/\/zones\/zone-1\/dns_records$/.test(u) && method === 'POST') {
      const rec = { id: `dns-${dnsRecords.length + 1}`, ...body };
      dnsRecords.push(rec);
      return jsonRes({ success: true, result: rec });
    }
    if (/\/zones\/zone-1\/dns_records\/[^/]+$/.test(u) && method === 'PUT') {
      const id = u.split('/').pop();
      const i = dnsRecords.findIndex((r) => r.id === id);
      if (i >= 0) dnsRecords[i] = { id, ...body };
      return jsonRes({ success: true, result: { id, ...body } });
    }
    if (u === 'https://api.resend.com/domains' && method === 'POST') {
      const nm = body.name;
      return jsonRes({
        id: `dom-${nm}`, name: nm, status: 'not_started',
        records: [
          { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: `p=DKIM-${nm}`, ttl: 'Auto' },
          { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10, ttl: 'Auto' },
          { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', ttl: 'Auto' },
          { record: 'DMARC', name: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=none;', ttl: 'Auto' },
        ],
      });
    }
    const vf = /^https:\/\/api\.resend\.com\/domains\/([^/]+)\/verify$/.exec(u);
    if (vf && method === 'POST') return jsonRes({ id: vf[1] });
    const gd = /^https:\/\/api\.resend\.com\/domains\/([^/]+)$/.exec(u);
    if (gd) return jsonRes({ id: gd[1], name: String(gd[1]).replace(/^dom-/, ''), status: 'pending' });
    // GET /domains — "which domains does *this* key see". The saved key (RESEND_KEY) belongs to a team that only knows
    // old.com, which is exactly the production situation where the dashboard shows a verified domain the sending key
    // cannot use; 're_fixed_key' is a key that can see everything.
    if (u === 'https://api.resend.com/domains' && method === 'GET') {
      const auth = String((init && init.headers && (init.headers.Authorization || init.headers.authorization)) || '');
      if (auth.includes('re_broken_key')) return jsonRes({ message: 'API key is invalid' }, 401);
      if (auth.includes('re_send_only')) return jsonRes({ message: 'This API key is restricted to only send emails.' }, 401);
      const seen = auth.includes('re_fixed_key') ? ['old.com', 'new.com', 'third.com'] : ['old.com'];
      return jsonRes({ data: seen.map((n) => ({ id: `dom-${n}`, name: n, status: 'verified' })) });
    }
    // POST /emails — the real send. Record which key was used: the key must follow the **from domain** bound key.
    if (u === 'https://api.resend.com/emails' && method === 'POST') {
      sentAuth.push(String((init && init.headers && (init.headers.Authorization || init.headers.authorization)) || ''));
      return jsonRes({ id: 're_sent_1' });
    }
    if (u.startsWith('https://dns.google/resolve')) {
      const q = new URL(u);
      const name = q.searchParams.get('name') || '';
      const type = q.searchParams.get('type') || '';
      if (type === 'MX' && /^(old|new|third)\.com$/.test(name)) return jsonRes({ Answer: [{ name, type: 15, data: '10 route1.mx.cloudflare.net.' }] });
      if (type === 'MX' && /^send\./.test(name)) return jsonRes({ Answer: [{ name, type: 15, data: '10 feedback-smtp.us-east-1.amazonses.com.' }] });
      if (type === 'TXT' && /^resend\._domainkey\./.test(name)) return jsonRes({ Answer: [{ name, type: 16, data: '"p=MIGf..."' }] });
      if (type === 'TXT' && /^send\./.test(name)) return jsonRes({ Answer: [{ name, type: 16, data: '"v=spf1 include:amazonses.com ~all"' }] });
      if (type === 'TXT' && /^_dmarc\./.test(name)) return jsonRes({ Answer: [{ name, type: 16, data: '"v=DMARC1; p=none;"' }] });
      return jsonRes({ Answer: [] });
    }
    return jsonRes({});
  };

  const call = async (method, p, body, cookie, envOverride) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers['cookie'] = cookie;
    const req = new Request(`https://example.com${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await worker.default.fetch(req, envOverride || env);
    return { status: res.status, json: await res.json().catch(() => null), setCookie: sessionCookieOf(res) };
  };

  const cfg = (key) => { const r = db.queryOne('SELECT value FROM app_config WHERE key = ?', key); return r ? r.value : null; };
  const domainsTable = () =>
    db.query('SELECT domain, from_address, resend_domain_id, resend_api_key FROM domains ORDER BY created_at ASC');
  const account = async (cookie) => (await call('GET', '/api/account', undefined, cookie)).json;

  section('T0 环境自检 + 建管理员');
  ok(typeof worker.default.fetch === 'function', 'Worker 入口已加载');
  let r = await call('POST', '/api/setup/admin', { username: 'admin', password: 'secret123' });
  ok(r.status === 200, '建管理员成功', r.status);
  const cookie = r.setCookie;
  ok(!!cookie, '拿到会话 cookie');

  section('T1 只有 env 配置：旧域可用，且 env 配置被一次性导入数据库');
  let acc = await account(cookie);
  ok(Array.isArray(acc.domains) && acc.domains.join(',') === 'old.com', 'domains 只有 env 里的 old.com', JSON.stringify(acc.domains));
  ok(acc.domain === 'old.com', 'domain（主域）= old.com', acc.domain);
  ok(Array.isArray(acc.senders) && acc.senders[0] === 'support@old.com',
    '⭐ senders[0] 是配置的默认发件人（没有历史邮箱也有发件人）', JSON.stringify(acc.senders));
  ok(cfg('resend_api_key') === null, '⭐ app_config 里不再有全局 Key（Key 只跟随域名）', cfg('resend_api_key'));
  ok(cfg('from_address') === null, 'app_config 里不再有全局发件人', cfg('from_address'));
  ok(cfg('domain') === null, 'app_config 里不再有全局主域', cfg('domain'));
  // The domain itself is adopted into the domains table too, otherwise it would vanish from the switcher / sender set
  // once the database becomes authoritative for the key and the default sender.
  const adoptedRow = domainsTable().find((d) => d.domain === 'old.com');
  ok(!!adoptedRow && adoptedRow.from_address === 'support@old.com',
    '⭐ 只存在于环境变量的旧域被吸收进 domains 表（带默认发件人）', JSON.stringify(adoptedRow));
  ok(!!adoptedRow && adoptedRow.resend_domain_id === null, '吸收的行没有 Resend 域名 id（该域当初是手工在 Resend 里验证的）');
  ok(!!adoptedRow && adoptedRow.resend_api_key === 're_env_key',
    '⭐ 吸收时把环境变量里的 Key 记成该域的专属 Key（它本来就属于这个域所在的 Resend 账号）', adoptedRow && adoptedRow.resend_api_key);

  section('T2 应用内新增 new.com：旧域不得被挤掉');
  r = await call('POST', '/api/setup/domain', {
    domain: 'new.com', cf_token: CF_TOKEN, resend_key: RESEND_KEY, worker_name: 'resend-mail-api',
  }, cookie);
  ok(r.status === 200 && r.json && r.json.ok === true, '向导配置 new.com 成功', r.json && JSON.stringify(r.json.steps));

  acc = await account(cookie);
  ok(acc.domains.includes('old.com') && acc.domains.includes('new.com'),
    '⭐ domains 同时包含 old.com 与 new.com（旧域没消失）', JSON.stringify(acc.domains));
  ok(acc.domains[0] === 'old.com', '旧域仍排在第一位（主域未被新域顶替）', JSON.stringify(acc.domains));
  ok(acc.domain === 'old.com', '⭐ 主域仍由数据推导（最早配置的 old.com），不会被新域顶替', acc.domain);
  ok(acc.senders[0] === 'support@old.com', '⭐ 默认发件人仍是 support@old.com（来自 old.com 的 domains 行）', JSON.stringify(acc.senders));

  const rows = domainsTable();
  ok(rows.length === 2 && rows.map((r) => r.domain).join(',') === 'old.com,new.com',
    'domains 表 = 吸收的 old.com + 新增的 new.com', JSON.stringify(rows.map((r) => r.domain)));
  const newRow = rows.find((r) => r.domain === 'new.com');
  ok(newRow && newRow.from_address === 'noreply@new.com', 'new.com 的默认发件地址落库', newRow && newRow.from_address);
  ok(newRow && newRow.resend_api_key === RESEND_KEY,
    '⭐ 新增域名的 Key 存为该域的**专属** Key（另一个 Resend 账号也能共存）', newRow && newRow.resend_api_key);
  const keysByDomain = Object.fromEntries(rows.map((x) => [x.domain, x.resend_api_key]));
  ok(keysByDomain['old.com'] === 're_env_key' && keysByDomain['new.com'] === RESEND_KEY,
    '⭐ 两个域各用自己账号的 Key（互不覆盖）', JSON.stringify(keysByDomain));
  ok((r.json.steps || []).some((s) => s.name === '发信 Key' && /专属发信 Key/.test(s.detail || '')),
    '配置结果说明保存的是该域专属 Key', JSON.stringify((r.json.steps || []).filter((s) => s.name === '发信 Key')));

  section('T3 发件人候选：新域没有任何邮件历史也必须可选');
  acc = await account(cookie);
  ok(Array.isArray(acc.senders), '/api/account 返回 senders');
  ok(acc.senders[0] === 'support@old.com', 'senders[0] = 配置的默认发件人', JSON.stringify(acc.senders));
  ok(acc.senders.includes('noreply@new.com'), '⭐ senders 含 new.com 的默认地址（否则发件人选择器为空）', JSON.stringify(acc.senders));
  ok(!acc.senders.some((s) => /@example\.(com|net|org)$/.test(s)), 'senders 不含占位域名 example.com', JSON.stringify(acc.senders));

  section('T4 域集合 / 发件人身份（编译后的真实函数）');
  const runtimeEnv = { ...env, SENDING_DOMAINS: 'new.com' };
  ok(send.sendingDomains(runtimeEnv).join(',') === 'old.com,new.com',
    '⭐ sendingDomains = 旧主域 + domains 表（并集，不是二选一）', JSON.stringify(send.sendingDomains(runtimeEnv)));
  ok(send.sendingDomain(runtimeEnv) === 'old.com', 'sendingDomain（第一个）= old.com', send.sendingDomain(runtimeEnv));
  ok(send.senderIdentity(runtimeEnv, 'billing@old.com').address === 'billing@old.com',
    '旧域上的自定义发件人仍然可以发（回归保护）', JSON.stringify(send.senderIdentity(runtimeEnv, 'billing@old.com')));
  ok(send.senderIdentity(runtimeEnv, 'hi@new.com').address === 'hi@new.com',
    '新域上的自定义发件人可以发', JSON.stringify(send.senderIdentity(runtimeEnv, 'hi@new.com')));
  ok(send.sendingDomains({ SEND_FROM_ADDRESS: 'inbox@example.com', SENDING_DOMAINS: 'foo.com' }).join(',') === 'foo.com',
    '已配置真实域时，模板占位域 example.com 不进发送域集合', JSON.stringify(send.sendingDomains({ SEND_FROM_ADDRESS: 'inbox@example.com', SENDING_DOMAINS: 'foo.com' })));
  ok(send.sendingDomains({ SEND_FROM_ADDRESS: 'inbox@example.com' }).join(',') === 'example.com',
    '例外：默认地址是唯一配置时保持原行为（不被占位域过滤清空）', JSON.stringify(send.sendingDomains({ SEND_FROM_ADDRESS: 'inbox@example.com' })));
  // Negative control: a fresh single-domain deployment is unchanged.
  ok(send.sendingDomains({ SENDING_DOMAINS: 'only.com' }).join(',') === 'only.com',
    '负控制：单一域名部署的域集合不变', JSON.stringify(send.sendingDomains({ SENDING_DOMAINS: 'only.com' })));
  ok(send.sendingDomains({ SEND_FROM_ADDRESS: 'x@legacy.com' }).join(',') === 'legacy.com',
    '负控制：只有默认地址时仍取该地址的域', JSON.stringify(send.sendingDomains({ SEND_FROM_ADDRESS: 'x@legacy.com' })));

  section('T5 老的 app_config 主域行已无意义：主域完全由 domains 表推导');
  // Simulate an old database that still carries the single-domain keys, with *wrong* values on purpose: if anything
  // still read them, the primary domain / default sender would now change.
  db.run(
    "INSERT INTO app_config (key, value, updated_at) VALUES ('domain', 'bogus.com', 1) ON CONFLICT(key) DO UPDATE SET value='bogus.com'"
  );
  db.run(
    "INSERT INTO app_config (key, value, updated_at) VALUES ('from_address', 'bogus@bogus.com', 1) ON CONFLICT(key) DO UPDATE SET value='bogus@bogus.com'"
  );
  acc = await account(cookie);
  ok(acc.domain === 'old.com', '⭐ 主域仍是 old.com（来自 domains 表最早的那行，不是 app_config.domain）', acc.domain);
  ok(acc.from_address === 'support@old.com', '⭐ 默认发件人仍是 support@old.com（来自 old.com 那行）', acc.from_address);
  ok(!acc.domains.includes('bogus.com'), '⭐ 失效的 app_config.domain 不会变成合法发送域', JSON.stringify(acc.domains));

  r = await call('POST', '/api/setup/domain', {
    domain: 'third.com', cf_token: CF_TOKEN, resend_key: RESEND_KEY, from_address: 'hi@third.com',
  }, cookie);
  ok(r.status === 200 && r.json && r.json.ok === true, '向导配置 third.com 成功', r.json && JSON.stringify(r.json.steps));
  ok(cfg('domain') === null, '⭐ 脏值已被自动清除（下一次请求就退役单域键）', cfg('domain'));
  acc = await account(cookie);
  ok(acc.domains.join(',') === 'old.com,new.com,third.com', '三个域都在域名清单里（主域 still first）', JSON.stringify(acc.domains));
  ok(acc.domain === 'old.com', '⭐ 加了第三个域，主域仍是 old.com', acc.domain);
  ok(acc.senders.includes('hi@third.com'), 'third.com 的默认发件地址出现在 senders 里', JSON.stringify(acc.senders));

  // The stale keys are retired automatically on the next request — no manual migration needed.
  const retired = db.query("SELECT key FROM app_config WHERE key IN ('domain','from_address','zone_id','from_name','worker_name','resend_domain_id')");
  ok(retired.length === 0, '⭐ 遗留的单域键被自动清除（不用手工迁移）', JSON.stringify(retired));
  acc = await account(cookie);
  ok(acc.domain === 'old.com' && acc.from_address === 'support@old.com',
    '⭐ 清除后行为完全不变（domains 表才是唯一来源）', `${acc.domain}/${acc.from_address}`);

  section('T6 自检：Key 按域绑定（没有全局 Key 一级）与该 Key 在 Resend 侧能看到哪些域');
  let chk = (await call('GET', '/api/setup/check', undefined, cookie)).json;
  const item = (n) => ((chk && chk.items) || []).find((i) => i.name === n) || {};
  ok(!!chk && Array.isArray(chk.items), '/api/setup/check 返回 items', chk && (chk.items || []).length);
  ok(!(chk.items || []).some((i) => i.name === '全局发信 Key'), '⭐ 不再有「全局 Key」这一级', JSON.stringify((chk.items || []).map((i) => i.name)));
  ok(!(chk.items || []).some((i) => i.name === '发件地址'), '⭐ 不再把「发件地址」当成检查项（写信时才选）');
  ok(!(chk.items || []).some((i) => i.name === '域名'), '不再有「域名」汇总行（面板只看一个域）');
  ok(item('发信 Key · old.com').ok === true && /域名绑定/.test(item('发信 Key · old.com').detail || ''),
    '⭐ old.com 用它域名绑定的 Key（吸收时从环境变量记下）', item('发信 Key · old.com').detail);
  ok(item('发信 Key · new.com').ok === true && /域名绑定/.test(item('发信 Key · new.com').detail || ''),
    'new.com 的 Key 也是域名绑定', item('发信 Key · new.com').detail);
  ok(item('Resend · old.com').ok === true, 'old.com 在自己的 Key 下可见且已验证', item('Resend · old.com').detail);
  ok(item('Resend · new.com').ok === false && /看不到/.test(item('Resend · new.com').detail || ''),
    '⭐ new.com 在它那把 Key 下看不到 —— 正是「两个域分属不同 Resend 账号」的症状', item('Resend · new.com').detail);
  ok(chk.ok === false, '结论 ok=false（DNS 全绿也要看 Resend 侧）');

  section('T7 逐域设置 Key：给某个域单独换 Key（先校验，换完该域转绿）');
  const settings = (body, envOverride) => call('POST', '/api/settings/send', body, cookie, envOverride);
  // 格式不合法 -> 400，且不写库
  r = await settings({ domain: 'new.com', resend_key: 'not-a-key' });
  ok(r.status === 400, '格式不对的 Key -> 400', r.json && r.json.error);
  ok((domainsTable().find((d) => d.domain === 'new.com') || {}).resend_api_key === RESEND_KEY,
    '校验失败不落库（该域原有的 Key 未变）', (domainsTable().find((d) => d.domain === 'new.com') || {}).resend_api_key);
  // Resend 说这把 Key 无效 -> 400，且不覆盖该域原有的 Key
  r = await settings({ domain: 'new.com', resend_key: 're_broken_key123456' });
  ok(r.status === 400 && /校验失败/.test((r.json && r.json.error) || ''), 'Resend 拒绝的 Key -> 400 且不覆盖', r.json && r.json.error);
  ok((domainsTable().find((d) => d.domain === 'new.com') || {}).resend_api_key === RESEND_KEY, '无效 Key 不会覆盖该域原有的 Key');
  // 未知域名 -> 400
  r = await settings({ domain: 'nope.com', resend_key: 're_fixed_key' });
  ok(r.status === 400 && /未知域名/.test((r.json && r.json.error) || ''), '未知域名 -> 400', r.json && r.json.error);
  // 有效 Key：只写这一个域
  r = await settings({ domain: 'new.com', resend_key: 're_fixed_key' });
  ok(r.status === 200 && r.json && r.json.ok === true, '给 new.com 保存专属 Key 成功', r.json && JSON.stringify(r.json.updated));
  ok(r.json.domain === 'new.com', '响应标明改的是哪个域', r.json.domain);
  ok((domainsTable().find((d) => d.domain === 'new.com') || {}).resend_api_key === 're_fixed_key',
    '⭐ Key 写入该域的 domains 行', (domainsTable().find((d) => d.domain === 'new.com') || {}).resend_api_key);
  ok((domainsTable().find((d) => d.domain === 'old.com') || {}).resend_api_key === 're_env_key',
    '⭐ 另一个域的 Key 不受影响', (domainsTable().find((d) => d.domain === 'old.com') || {}).resend_api_key);
  const seen = (r.json.key_check && r.json.key_check.domains) || [];
  ok(seen.length === 3, '保存时回显这把 Key 能看到 3 个域', JSON.stringify(seen));
  // 与域名不匹配的 Key 会给出警告（仍允许保存：可能是仅发送权限 / 域限制）
  r = await settings({ domain: 'third.com', resend_key: 're_fixed_key' });
  ok(r.status === 200, '给 third.com 也保存 Key', r.status);

  chk = (await call('GET', '/api/setup/check', undefined, cookie)).json;
  const resendItems = (chk.items || []).filter((i) => i.name.startsWith('Resend · '));
  ok(resendItems.length >= 2 && resendItems.every((i) => i.ok),
    '⭐ 三个域各自用自己的 Key 后，Resend 侧逐域转绿', JSON.stringify(resendItems.map((i) => [i.name, i.ok])));

  section('T7b 「仅发送」权限的 Key：能发信但查不到 Resend 状态 -> 提示而不是报错');
  r = await settings({ domain: 'old.com', resend_key: 're_send_only' });
  ok(r.status === 200 && r.json.key_check && /仅发送/.test(r.json.key_check.warning || ''),
    '保存时提示该 Key 仅发送权限', r.json && (r.json.key_check || {}).warning);
  chk = (await call('GET', '/api/setup/check', undefined, cookie)).json;
  const sendOnlyRow = ((chk.items || []).find((i) => i.name === 'Resend · old.com')) || {};
  ok(sendOnlyRow.ok === true && sendOnlyRow.warn === true,
    '⭐ 自检把「查不到状态」记为提示（橙色 !），不判该域为故障', JSON.stringify(sendOnlyRow));
  ok(!/未验证|看不到/.test(sendOnlyRow.detail || ''), '不会误报成「看不到该域」', sendOnlyRow.detail);
  // 还原成正常 Key，后面的回填用例依赖它
  await settings({ domain: 'old.com', resend_key: 're_fixed_key' });

  // 默认发件人 / 显示名：同样可以按域设置
  r = await settings({ domain: 'new.com', from_address: 'hello@new.com' });
  ok(r.status === 200, '按域设置默认发件人成功', r.status);
  ok((domainsTable().find((d) => d.domain === 'new.com') || {}).from_address === 'hello@new.com',
    '⭐ 默认发件人写进该域的行', (domainsTable().find((d) => d.domain === 'new.com') || {}).from_address);
  acc = await account(cookie);
  ok(acc.senders.includes('hello@new.com'), '新发件人立即出现在 /api/account.senders', JSON.stringify(acc.senders.slice(0, 4)));
  // 不带 domain 时改的是「主域（最早配置的那个域）」的默认发件人 —— 没有全局默认发件人了
  r = await settings({ from_address: 'global@old.com', from_name: 'Hi' });
  ok(r.status === 200, '不带 domain 的保存成功', r.status);
  ok(r.json.domain === 'old.com', '⭐ 落到主域 old.com 的 domains 行', r.json.domain);
  const oldRowNow = domainsTable().find((d) => d.domain === 'old.com') || {};
  ok(oldRowNow.from_address === 'global@old.com', '⭐ 主域 from_address 被更新', oldRowNow.from_address);
  const cfgKeysNow = db.query('SELECT key FROM app_config').map((x) => x.key);
  ok(!cfgKeysNow.includes('from_address') && !cfgKeysNow.includes('from_name'), 'app_config 里不写全局发件人', JSON.stringify(cfgKeysNow));
  acc = await account(cookie);
  ok(acc.from_address === 'global@old.com', '主域发件人立即生效', acc.from_address);

  section('T8 已有域名缺专属 Key：不再自动回填，发信时用 env 兜底（bootstrap 语义）');
  db.run("UPDATE domains SET resend_api_key = NULL WHERE domain = 'old.com'");
  ok((domainsTable().find((d) => d.domain === 'old.com') || {}).resend_api_key === null, '前置：old.com 暂时没有专属 Key');
  await account(cookie); // any /api request runs withRuntimeConfig
  ok((domainsTable().find((d) => d.domain === 'old.com') || {}).resend_api_key === null,
    '⭐ 环境变量不再被悄悄写进域名（只有 bootstrap 首次吸收时才写）',
    (domainsTable().find((d) => d.domain === 'old.com') || {}).resend_api_key);

  section('T9 真正发信：Key 跟着发件域走（含 "名字 <地址>" 形式）');
  // 回归：resendKeyFor 曾用 util.domainOf() 解析 from，而 from 是 "hi <hi@new.com>" 这种带显示名的形式，
  // 解析出的是 "new.com>"，按域查 Key 落空 → 退回环境变量那把（别的 Resend 账号）→ 发信报「域名未验证」，
  // 而自检（按域名查 Key）全绿。
  sentAuth.length = 0;
  const newKey = (domainsTable().find((d) => d.domain === 'new.com') || {}).resend_api_key;
  r = await call('POST', '/api/messages', { to: ['x@y.com'], subject: 't1', body: 'hi', mailbox: 'hi@new.com' }, cookie);
  ok(r.status === 200, '用 new.com 上的新地址发信成功', r.json && JSON.stringify(r.json));
  ok(sentAuth.length === 1, '恰好调用一次 Resend', sentAuth.length);
  ok(sentAuth[0] === `Bearer ${newKey}`,
    '⭐ new.com 发信用的是它自己绑定的 Key（不是环境变量那把）', `${sentAuth[0]} vs ${newKey}`);

  sentAuth.length = 0;
  const oldRowKey = (domainsTable().find((d) => d.domain === 'old.com') || {}).resend_api_key;
  r = await call('POST', '/api/messages', { to: ['x@y.com'], subject: 't2', body: 'hi', mailbox: 'billing@old.com' }, cookie);
  ok(r.status === 200, '用 old.com 上的地址发信成功', r.json && JSON.stringify(r.json));
  ok(!oldRowKey && sentAuth[0] === 'Bearer re_env_key',
    '⭐ 没有专属 Key 时发信回退到环境变量那把（而不是被静默写库）', `${sentAuth[0]} vs row=${oldRowKey}`);

  // 直接对 resendKeyFor 做一次断言：带显示名的 from 也要解析出正确域名
  const sendMod = require(path.join(entry, 'send.js'));
  const keyEnv = { RESEND_API_KEY: 're_env_key', RESEND_API_KEYS: JSON.stringify({ 'new.com': 're_domain_key' }) };
  ok(sendMod.resendKeyFor(keyEnv, 'Hi <hi@new.com>') === 're_domain_key',
    '⭐ "名字 <地址>" 形式解析出 new.com 并使用该域绑定的 Key', sendMod.resendKeyFor(keyEnv, 'Hi <hi@new.com>'));
  ok(sendMod.resendKeyFor(keyEnv, 'hi@new.com') === 're_domain_key', '裸地址同样命中', sendMod.resendKeyFor(keyEnv, 'hi@new.com'));
  ok(sendMod.resendKeyFor(keyEnv, 'x@other.com') === 're_env_key', '未绑定的域回退到环境变量 Key');

  section('T9b 域名过滤：不带参数 = 全部；带空 domain= = 什么都不返回');
  // 前端「一个域名都不勾选」会显式发 domain=（空），语义必须是「不匹配任何域」，而不是「全部」。
  r = await call('GET', '/api/folders/sent', undefined, cookie);
  const allSent = (r.json && r.json.total) || 0;
  ok(allSent >= 2, '不带 domain 参数 -> 返回全部已发送', allSent);
  r = await call('GET', '/api/folders/sent?domain=', undefined, cookie);
  ok(r.status === 200 && r.json && r.json.total === 0, '⭐ domain=（空）-> 0 条（不勾选 = 什么都不显示）',
    r.json && JSON.stringify({ status: r.status, total: r.json.total, items: (r.json.items || []).length }));
  ok((r.json.items || []).length === 0, '列表也是空的', (r.json.items || []).length);
  const countsAll = (await call('GET', '/api/counts', undefined, cookie)).json;
  const countsNone = (await call('GET', '/api/counts?domain=', undefined, cookie)).json;
  ok(countsAll.sent_total >= 2, '不带参数：计数正常', countsAll.sent_total);
  ok(countsNone.sent_total === 0 && countsNone.inbox_total === 0, '⭐ domain=（空）：计数全 0',
    JSON.stringify({ sent: countsNone.sent_total, inbox: countsNone.inbox_total }));
  const mbNone = (await call('GET', '/api/mailboxes?domain=', undefined, cookie)).json;
  ok(Array.isArray(mbNone.mailboxes) && mbNone.mailboxes.length === 0, '⭐ domain=（空）：地址列表也为空',
    JSON.stringify(mbNone.mailboxes));

  section('T10 Resend 错误 → 可操作提示（原文必须保留）');
  const re = require(path.join(entry, 'resend-errors.js'));
  const notVerified = re.explainResendError(
    'The new.com domain is not verified. Please, add and verify your domain on https://resend.com/domains',
    { from: 'noreply@new.com' }
  );
  ok(notVerified.includes('domain is not verified'), '保留 Resend 原文（前端 toast / 排查都以它为准）', notVerified.slice(0, 46));
  ok(/new\.com/.test(notVerified) && /Team/.test(notVerified) && /Full access|Key/.test(notVerified),
    '⭐ 追加「Key 的 Team / 域名完全一致」排查方向', notVerified.slice(0, 120));
  const restricted = re.explainResendError('This API key is restricted to only send emails.');
  ok(/Full access/.test(restricted) && /only send emails/.test(restricted), '仅发送权限 -> 提示改用 Full access', restricted.slice(0, 80));
  ok(re.explainResendError('invalid recipient') === 'invalid recipient', '未知错误原样返回（不臆造提示）');
  ok(re.maskSecret('re_1234567890abcdef') === 're_123…cdef', '掩码不泄露完整 Key', re.maskSecret('re_1234567890abcdef'));
  ok(re.domainOfFrom('Name <a@b.com>') === 'b.com', 'from 字段里取域（支持 Name <addr> 形式）');

  section('T12 环境变量只在 bootstrap 生效：删掉的域不会被 env 复活，也不会被 env Key 回填');
  db.run("DELETE FROM domains WHERE domain = 'third.com'");
  acc = await account(cookie); // any /api request runs withRuntimeConfig
  ok(!acc.domains.includes('third.com'), '⭐ 删掉的 third.com 没有因为 env 重新出现', JSON.stringify(acc.domains));
  ok(acc.domains.join(',') === 'old.com,new.com', '剩下的两个域不变', JSON.stringify(acc.domains));
  const keysNow = Object.fromEntries(domainsTable().map((d) => [d.domain, d.resend_api_key]));
  ok(!keysNow['old.com'], '⭐ 没有专属 Key 的域仍保持为空（env Key 不会被悄悄写入）', JSON.stringify(keysNow));
  ok(keysNow['new.com'] === 're_fixed_key', '有专属 Key 的域不受影响', keysNow['new.com']);

  console.log(`\n===== 结果: ${pass} passed, ${failures.length} failed =====`);
  if (failures.length) console.log(`失败项：\n- ${failures.join('\n- ')}`);
  cleanup();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('测试运行异常：', e);
  cleanup();
  process.exit(1);
});
