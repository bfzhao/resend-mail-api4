'use strict';

/* =========================================================
 * Fresh-database initialisation (zero deps: node test/schema-init.test.js)
 *
 * A one-click deployment gets an **empty** D1 that the Worker must initialise on its first request. That path only ever
 * runs on a brand-new database, which is exactly why a bug there is invisible in production and fatal for new users:
 *
 *   · the database is not ready yet   -> retry
 *   · exec() rejects the whole script -> run the statements one by one
 *   · a real SQL error                -> surface it (and let the next request try again)
 * ========================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { failures.push(msg); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-init-'));
const OUT = path.join(WORK, 'build');

function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const srcCopy = path.join(WORK, 'src');
  fs.mkdirSync(srcCopy, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WORK, 'node_modules'), 'junction');
  for (const name of ['schema.ts', 'schema-sql.ts', 'types.ts']) {
    fs.copyFileSync(path.join(ROOT, 'src', name), path.join(srcCopy, name));
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
  delete cfg.include;
  delete cfg.exclude;
  cfg.files = fs.readdirSync(srcCopy).filter((x) => x.endsWith('.ts')).map((x) => path.join(srcCopy, x));
  cfg.compilerOptions = Object.assign({}, cfg.compilerOptions, {
    noEmit: false,
    module: 'commonjs',
    outDir: OUT,
    rootDir: srcCopy,
  });
  const cfgPath = path.join(WORK, 'tsconfig.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [tsc, '-p', cfgPath], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('tsc 编译失败(exit=' + r.status + '): ' + ((r.stdout || '') + (r.stderr || '')).trim());
}

try {
  build();
} catch (e) {
  console.error(`\n编译失败，无法继续：${e.message}`);
  console.error('（受限沙箱下请加 tsc 垫片：NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js"）');
  process.exit(2);
}
const SCHEMA_PATH = path.join(OUT, 'schema.js');
const freshSchema = () => {
  delete require.cache[require.resolve(SCHEMA_PATH)];
  return require(SCHEMA_PATH);
};
const schema = freshSchema();
const { SCHEMA_SQL } = require(path.join(OUT, 'schema-sql.js'));

console.log('全新 D1 的首次初始化');

section('S1 语句拆分（仅用于逐句回退）');
const stmts = schema.splitStatements(SCHEMA_SQL);
ok(stmts.length >= 25, '拆出全部语句', stmts.length);
ok(stmts.every((s) => !/--/.test(s)), '⭐ 注释已被剔除（逐句执行时注释会污染语句）');
ok(stmts.every((s) => /^(CREATE|INSERT|PRAGMA)/i.test(s)), '每条都是可执行的 DDL/DML', stmts.slice(-1)[0].slice(0, 30));
ok(stmts.some((s) => /CREATE TABLE IF NOT EXISTS messages/i.test(s)), '包含 messages 建表');
ok(stmts.some((s) => /CREATE INDEX/i.test(s)), '包含索引');

/** Fake D1 that records what happens. */
function fakeDb(opts = {}) {
  const calls = { first: [], run: [], exec: [] };
  const schemaExists = Boolean(opts.schemaExists);
  return {
    calls,
    prepare(sql) {
      const st = {
        async first() {
          calls.first.push(sql);
          if (opts.firstError && opts.firstError(sql)) throw new Error(opts.firstError(sql));
          if (!schemaExists) throw new Error('D1_ERROR: no such table: app_config');
          return { 1: 1 };
        },
        bind() { return st; },
        async run() {
          calls.run.push(sql);
          if (opts.runError && opts.runError(sql)) throw new Error(opts.runError(sql));
          return { success: true };
        },
      };
      return st;
    },
    async exec(sql) {
      calls.exec.push(sql);
      if (opts.execError) throw new Error(opts.execError);
      return { count: 1, duration: 1 };
    },
  };
}

(async () => {
  section('S2 全新库：exec 成功 → 不逐句执行');
  {
    const mod = freshSchema();
    const env = { DB: fakeDb({ schemaExists: false }) };
    await mod.ensureSchema(env);
    ok(env.DB.calls.exec.length === 1, '调用了一次 exec', env.DB.calls.exec.length);
    ok(env.DB.calls.run.length === 0, '没有走逐句回退', env.DB.calls.run.length);
  }

  section('S3 ⭐ exec 被引擎拒绝 → 逐句执行兜底（"数据库初始化失败"的来源之一）');
  {
    const mod = freshSchema();
    const env = { DB: fakeDb({ schemaExists: false, execError: 'D1_ERROR: too many SQL statements in exec()' }) };
    await mod.ensureSchema(env);
    ok(env.DB.calls.exec.length === 1, '先试了 exec', env.DB.calls.exec.length);
    ok(env.DB.calls.run.length === stmts.length, '⭐ 回退把每条语句都跑了', `${env.DB.calls.run.length}/${stmts.length}`);
    ok(env.DB.calls.run.every((s) => /^(CREATE|INSERT|PRAGMA)/i.test(s)), '回退的语句干净可执行');
  }

  section('S4 ⭐ 新库尚未就绪（D1 transient）→ 重试后成功');
  {
    const mod = freshSchema();
    let attempts = 0;
    const db = fakeDb({ schemaExists: false });
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const st = realPrepare(sql);
      if (/FROM app_config/.test(sql)) {
        const realFirst = st.first.bind(st);
        st.first = async () => {
          attempts++;
          if (attempts < 2) throw new Error('D1_ERROR: database is not ready yet');
          return realFirst();
        };
      }
      return st;
    };
    await mod.ensureSchema({ DB: db });
    ok(attempts >= 2, '⭐ 重试了', attempts);
    ok(db.calls.exec.length === 1, '重试后仍然执行了建表', db.calls.exec.length);
  }

  section('S5 真正的 SQL 错误 → 抛出，且不会把失败永久缓存');
  {
    const mod = freshSchema();
    const env = { DB: fakeDb({ schemaExists: false, execError: 'D1_ERROR: syntax error near "CREATE"', runError: () => 'D1_ERROR: syntax error' }) };
    let threw = false;
    try {
      await mod.ensureSchema(env);
    } catch (e) {
      threw = /syntax error/.test(e.message);
    }
    ok(threw, '⭐ 把原始错误抛给调用方', threw);

    const mod2 = freshSchema();
    const env2 = { DB: fakeDb({ schemaExists: false }) };
    let retried = false;
    try {
      await mod2.ensureSchema(env2);
      retried = env2.DB.calls.exec.length === 1;
    } catch {
      retried = false;
    }
    ok(retried, '⭐ 下一次请求重新尝试初始化（ready 未被永久缓存）');
  }

  section('S6 库已初始化 → 只做一次探测，不跑 DDL');
  {
    const mod = freshSchema();
    const env = { DB: fakeDb({ schemaExists: true }) };
    await mod.ensureSchema(env);
    ok(env.DB.calls.exec.length === 0, '⭐ 已有 schema 时不做任何 DDL', env.DB.calls.exec.length);
    ok(env.DB.calls.first.length >= 1, '只用了一次 SELECT 探测', env.DB.calls.first.length);
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n===== 结果: ${pass} passed, ${failures.length} failed =====`);
  if (failures.length) console.log(`失败项：\n- ${failures.join('\n- ')}`);
  process.exit(failures.length ? 1 : 0);
})();
