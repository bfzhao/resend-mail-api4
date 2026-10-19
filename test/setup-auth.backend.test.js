'use strict';

/* =============================================================================
 * Setup wizard / login backend regression -- real SQLite as D1 + real compiled src/ artifacts + real Worker routing
 *
 * Run (this sandbox needs the tsc shim, see notes at end of file):
 *   NODE_OPTIONS="--require <temp dir>/mm-tsc-shim.js" node test/setup-auth.backend.test.js
 * Normal environment:
 *   node test/setup-auth.backend.test.js
 *
 * Exit codes: 0 = all pass; 1 = failures; 2 = missing environment (node:sqlite / tsc unavailable).
 *
 * Invariants to watch:
 *   ⭐ Uninitialized (no env auth, no admin): /api/setup/status -> mode='none', and business APIs are allowed (historical behavior).
 *   ⭐ Wizard creates admin: only 1 allowed; password stored via PBKDF2 (never plaintext); session cookie issued immediately after creation.
 *   ⭐ After admin is created: business API with no cookie -> 401; with valid cookie -> 200.
 *   ⭐ Login: wrong password 401; correct password 200 + verifiable session cookie; logout clears cookie.
 *   ⭐ In env Basic Auth mode: wizard is disabled (400), original Basic validation applies.
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
const WORK_DIR = path.join(os.tmpdir(), `setup-auth-qa-build-${process.pid}`);
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
  const r = spawnSync(process.execPath, [tsc, '-p', cfgPath], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) throw new Error(`tsc 编译失败(exit=${r.status}): ${out}`);
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
      async run() {
        const r = db.prepare(sql).run(...norm(st.args));
        return { success: true, results: [], meta: { changes: Number(r.changes) } };
      },
      async first() {
        const row = db.prepare(sql).get(...norm(st.args));
        return row === undefined ? null : row;
      },
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
  };
}

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { failures.push(msg); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/** Extract the mail_session cookie from the response ('mail_session=...'). */
function sessionCookieOf(res) {
  const all = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const c = all.find((x) => x && x.startsWith('mail_session='));
  return c ? c.split(';')[0] : null;
}

(async function main() {
  console.log('安装向导 / 登录 —— 真实 SQLite + 真实编译产物 + 真实 Worker 路由');
  let entry;
  try {
    entry = build();
  } catch (e) {
    console.error(`\n编译失败，无法继续：${e.message}`);
    console.error('（受限沙箱下请加 tsc 垫片：NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js"）');
    process.exit(2);
  }

  const worker = require(path.join(entry, 'index.js'));
  const db = makeD1();
  const env = { DB: db };

  const call = async (method, p, body, cookie) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers['cookie'] = cookie;
    const req = new Request(`https://example.com${p}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await worker.default.fetch(req, env);
    return { status: res.status, json: await res.json().catch(() => null), setCookie: sessionCookieOf(res) };
  };

  section('T0 环境自检');
  await db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)').bind('self', '1', 1).run();
  ok(Number(db.queryOne('SELECT COUNT(*) AS n FROM app_config').n) === 1, 'app_config 表存在且可写（schema.sql 全量建库）');
  await db.prepare('DELETE FROM app_config WHERE key = ?').bind('self').run();
  ok(Number(db.queryOne('SELECT COUNT(*) AS n FROM users').n) === 0, 'users 表存在且初始为空');
  ok(typeof worker.default.fetch === 'function', 'Worker 入口已加载（真实路由 + 真实 repo）');

  section('T1 未初始化：status -> none，业务 API 放行（历史行为）');
  let r = await call('GET', '/api/setup/status');
  ok(r.status === 200 && r.json && r.json.mode === 'none', 'mode = none', r.json && r.json.mode);
  ok(r.json && r.json.configured === false, 'configured = false', r.json && r.json.configured);
  r = await call('GET', '/api/account');
  ok(r.status === 200, '未初始化时业务 API 不拦（无 401）', r.status);

  section('T2 向导建管理员：校验 + 只建一次 + 发会话 cookie');
  r = await call('POST', '/api/setup/admin', { username: 'admin', password: '123' });
  ok(r.status === 400, '密码过短 -> 400', r.status);
  r = await call('POST', '/api/setup/admin', { username: '', password: 'secret123' });
  ok(r.status === 400, '用户名为空 -> 400', r.status);

  r = await call('POST', '/api/setup/admin', { username: 'admin', password: 'secret123' });
  ok(r.status === 200 && r.json && r.json.ok === true, '创建成功 -> 200 ok', r.status);
  const wizardCookie = r.setCookie;
  ok(!!wizardCookie && wizardCookie.startsWith('mail_session='), '响应带 mail_session cookie', wizardCookie);

  const row = db.queryOne('SELECT * FROM users WHERE username = ?', 'admin');
  ok(!!row, 'users 里写入了一行 admin');
  ok(row && row.password_hash.startsWith('pbkdf2$'), '口令以 PBKDF2 存储', row && row.password_hash.slice(0, 12));
  ok(row && row.password_hash !== 'secret123' && !row.password_hash.includes('secret123'), '口令**不是**明文');
  const secretRow = db.queryOne('SELECT value FROM app_config WHERE key = ?', 'session_secret');
  ok(!!secretRow && String(secretRow.value).length >= 32, 'session_secret 已生成并落库', secretRow && String(secretRow.value).length);

  r = await call('POST', '/api/setup/admin', { username: 'admin2', password: 'secret456' });
  ok(r.status === 409, '已有管理员 -> 409（不能重复建）', r.status);
  ok(Number(db.queryOne('SELECT COUNT(*) AS n FROM users').n) === 1, '仍然只有 1 个管理员');

  section('T3 初始化后：无 cookie 401 / 有 cookie 200');
  r = await call('GET', '/api/account');
  ok(r.status === 401, '无 cookie 的业务 API -> 401', r.status);
  r = await call('GET', '/api/account', undefined, wizardCookie);
  ok(r.status === 200, '带向导下发的 cookie -> 200', r.status);

  r = await call('GET', '/api/setup/status');
  ok(r.json && r.json.mode === 'session' && r.json.authenticated === false, 'status: session 且未登录', r.json && `${r.json.mode}/${r.json.authenticated}`);
  r = await call('GET', '/api/setup/status', undefined, wizardCookie);
  ok(r.json && r.json.authenticated === true, 'status: 带 cookie -> authenticated', r.json && r.json.authenticated);

  section('T4 登录：错口令 401 / 对口令 200 + 有效 cookie');
  r = await call('POST', '/api/login', { username: 'admin', password: 'wrong' });
  ok(r.status === 401, '错误口令 -> 401', r.status);
  r = await call('POST', '/api/login', { username: 'nobody', password: 'secret123' });
  ok(r.status === 401, '不存在的用户 -> 401', r.status);

  r = await call('POST', '/api/login', { username: 'admin', password: 'secret123' });
  ok(r.status === 200 && r.json && r.json.ok === true, '正确口令 -> 200', r.status);
  const loginCookie = r.setCookie;
  ok(!!loginCookie, '登录下发 cookie', loginCookie);
  r = await call('GET', '/api/account', undefined, loginCookie);
  ok(r.status === 200, '登录 cookie 可用于业务 API', r.status);

  section('T5 退出：清 cookie');
  r = await call('POST', '/api/logout');
  ok(r.status === 200 && r.json && r.json.ok === true, 'logout -> 200', r.status);
  const cleared = typeof r.setCookie === 'string' && r.setCookie.startsWith('mail_session=');
  ok(cleared, 'logout 下发清理 cookie（同名覆盖）', r.setCookie);

  section('T5b session_secret 丢失：登录现场补一把（不再 409 锁死）');
  const secretBefore = db.queryOne('SELECT value FROM app_config WHERE key = ?', 'session_secret');
  db.prepare('DELETE FROM app_config WHERE key = ?').bind('session_secret').run();
  ok(!db.queryOne('SELECT value FROM app_config WHERE key = ?', 'session_secret'), '前置：签名密钥已被删除');
  r = await call('GET', '/api/account', undefined, loginCookie);
  ok(r.status === 401, '旧 cookie 立刻失效（签名密钥已变）', r.status);

  r = await call('POST', '/api/login', { username: 'admin', password: 'secret123' });
  ok(r.status === 200 && r.json && r.json.ok === true, '⭐ 密钥缺失时登录仍然成功（不再返回 409）', r.status);
  const healedCookie = r.setCookie;
  ok(!!healedCookie, '登录重新下发 cookie', healedCookie);
  const secretAfter = db.queryOne('SELECT value FROM app_config WHERE key = ?', 'session_secret');
  ok(!!secretAfter && String(secretAfter.value).length >= 32, '⭐ 新的 session_secret 已落库', secretAfter && String(secretAfter.value).length);
  ok(secretAfter && secretBefore && secretAfter.value !== secretBefore.value, '新密钥与旧的不同（不复用）');
  r = await call('GET', '/api/account', undefined, healedCookie);
  ok(r.status === 200, '⭐ 新 cookie 可正常访问', r.status);
  r = await call('GET', '/api/setup/status', undefined, healedCookie);
  ok(r.json && r.json.authenticated === true, 'status 也认得新 cookie', r.json && r.json.authenticated);

  r = await call('POST', '/api/login', { username: 'admin', password: 'wrong' });
  ok(r.status === 401 && !r.setCookie, '错误口令时不会顺手重建密钥', r.status);

  section('T6 env Basic Auth 模式：向导禁用，走 Basic 校验');
  const db2 = makeD1();
  const envBasic = { DB: db2, API_USERNAME: 'u', API_PASSWORD: 'p' };
  const callB = async (method, p, body, auth) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) headers['authorization'] = 'Basic ' + Buffer.from(auth).toString('base64');
    const req = new Request(`https://example.com${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await worker.default.fetch(req, envBasic);
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  r = await callB('GET', '/api/setup/status');
  ok(r.status === 200 && r.json && r.json.mode === 'basic', 'mode = basic（env 认证优先）', r.json && r.json.mode);
  r = await callB('GET', '/api/account');
  ok(r.status === 401, 'Basic 模式下无 Authorization -> 401', r.status);
  r = await callB('GET', '/api/account', undefined, 'u:p');
  ok(r.status === 200, 'Basic 模式下正确凭据 -> 200', r.status);
  r = await callB('GET', '/api/account', undefined, 'u:wrong');
  ok(r.status === 401, 'Basic 模式下错误凭据 -> 401', r.status);
  r = await callB('POST', '/api/setup/admin', { username: 'admin', password: 'secret123' });
  ok(r.status === 400, 'Basic 模式下向导端点被禁用 -> 400', r.status);
  ok(Number(db2.queryOne('SELECT COUNT(*) AS n FROM users').n) === 0, 'Basic 模式下未写入任何管理员');

  cleanup();
  console.log(`\n===== 总结：${pass} 通过，${failures.length} 失败 =====`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试运行异常：', e);
  cleanup();
  process.exit(1);
});
