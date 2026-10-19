'use strict';

/* =========================================================
 * Deploy preflight rules (zero deps: node test/predeploy.test.js)
 *
 * The setup page lets the user pick an existing D1 / R2 or create a new one ("+ Create new"); the chosen resource is
 * written back into wrangler.toml (name + id). The guard runs before `wrangler deploy` and its job is safety:
 *
 *   · id present + created for this deploy   -> use it
 *   · id present + used by another worker    -> STOP (this is the "test deploy wrote into production" case)
 *   · id present + used by nobody            -> use it (picked on purpose)
 *   · placeholder id                         -> keep what the worker is bound to, else create "<project>-db"
 *   · R2 has no id, so a bucket owned by another worker -> STOP as well
 * ========================================================= */

const pre = require('../scripts/predeploy.js');

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { failures.push(msg); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const TOML = `name = "resend-mail-api3"
main = "src/index.ts"
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "resend-webhooks-db"
database_id = "<DATABASE_ID>"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "resend-mail-attachments"

[vars]
MERGE_SUBREQ_BUDGET = "45"
`;

const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const recent = new Date(Date.now() - 60 * 1000).toISOString();

/** Fake API. `state.workers` maps script name → { d1Ids, bucketNames } (used for the ownership checks). */
function fakeApi(state) {
  const created = { d1: [], r2: [] };
  return {
    created,
    async ownBindings(name) {
      const w = (state.workers || {})[name];
      return w ? { exists: true, d1Ids: w.d1Ids || [], bucketNames: w.bucketNames || [] } : { exists: false, d1Ids: [], bucketNames: [] };
    },
    async listScripts() { return { list: Object.keys(state.workers || {}) }; },
    async listD1() { return { list: state.db.slice() }; },
    async createD1(name) {
      const row = { id: `id-${name}`, name, created: new Date().toISOString() };
      state.db.push(row);
      created.d1.push(name);
      return { id: row.id, name };
    },
    async listR2() { return { list: state.buckets.slice() }; },
    async createR2(name) {
      state.buckets.push({ name, created: new Date().toISOString() });
      created.r2.push(name);
      return { name };
    },
  };
}

const dbNameOf = (t) => pre.readValue(t, '[[d1_databases]]', 'database_name');
const dbIdOf = (t) => pre.readValue(t, '[[d1_databases]]', 'database_id');
const bucketOf = (t) => pre.readValue(t, '[[r2_buckets]]', 'bucket_name');
const withId = (id, name) => TOML.replace('database_id = "<DATABASE_ID>"', `database_id = "${id}"`).replace('database_name = "resend-webhooks-db"', `database_name = "${name}"`);

(async () => {
  console.log('部署前置守卫 —— 尊重部署页选中的资源，同时不允许静默共享别人的数据');

  section('P1 toml 读写 + 名字派生');
  ok(pre.workerName(TOML) === 'resend-mail-api3', '读到 worker 名', pre.workerName(TOML));
  const edited = pre.setValue(TOML, '[[d1_databases]]', 'database_name', 'x-db');
  ok(dbNameOf(edited) === 'x-db' && bucketOf(edited) === 'resend-mail-attachments', '只改目标段');
  ok(pre.derivedNames('Resend.Mail_3').db === 'resend-mail-3-db', '⭐ 项目名派生（点/下划线→连字符、小写）', pre.derivedNames('Resend.Mail_3').db);
  ok(pre.derivedNames('').bucket === 'resend-mail-bucket', '空名字有兜底', pre.derivedNames('').bucket);

  section('P2 部署页选了一个新建的库（id 已写回，刚创建）→ 直接用，不另建');
  {
    const state = { db: [{ id: 'new-db-id', name: 'my-picked-db', created: recent }], buckets: [{ name: 'my-picked-bucket', created: recent }], workers: {} };
    const api = fakeApi(state);
    const r = await pre.resolveResources(withId('new-db-id', 'my-picked-db'), api, { workerName: 'resend-mail-api3' });
    ok(r.conflicts.length === 0, '不报错', JSON.stringify(r.conflicts));
    ok(dbIdOf(r.toml) === 'new-db-id' && dbNameOf(r.toml) === 'my-picked-db', '⭐ 用选中的库', `${dbNameOf(r.toml)}/${dbIdOf(r.toml)}`);
    ok(api.created.d1.length === 0, '没有另建库', JSON.stringify(api.created.d1));
  }

  section('P3 ⭐ 选中的库正被别的 worker 使用（上次事故）→ 停止部署');
  {
    const state = {
      db: [{ id: 'prod-db-id', name: 'resend-webhooks-db', created: old }],
      buckets: [{ name: 'resend-mail-attachments', created: old }],
      workers: { 'resend-mail-api': { d1Ids: ['prod-db-id'], bucketNames: ['resend-mail-attachments'] } },
    };
    const api = fakeApi(state);
    const r = await pre.resolveResources(withId('prod-db-id', 'resend-webhooks-db'), api, { workerName: 'resend-mail-api3' });
    ok(r.conflicts.length >= 1, '⭐ 直接停（不再静默绑别人的库）', JSON.stringify(r.conflicts.map((c) => c.slice(0, 60))));
    ok(/already used by the worker "resend-mail-api"/.test(r.conflicts[0]), '错误里点名是谁在用', r.conflicts[0].slice(0, 110));
    ok(/Create new/.test(r.conflicts[0]), '⭐ 告诉用户改选「+ Create new」', r.conflicts[0].slice(-60));
  }

  section('P4 选中的库存在、但没有任何 worker 在用（孤立旧库）→ 允许复用并说明');
  {
    const state = { db: [{ id: 'orphan-id', name: 'orphan-db', created: old }], buckets: [{ name: 'orphan-bucket', created: old }], workers: {} };
    const api = fakeApi(state);
    const r = await pre.resolveResources(withId('orphan-id', 'orphan-db'), api, { workerName: 'resend-mail-api3' });
    ok(r.conflicts.length === 0, '不报错', JSON.stringify(r.conflicts));
    ok(dbIdOf(r.toml) === 'orphan-id', '用这个库', dbIdOf(r.toml));
    ok(/selected in the setup page/.test(r.notes.join(' ')), '日志说明是手动选的', r.notes.join(' | '));
  }

  section('P5 占位 id + worker 已绑定资源 → 保留绑定（重部署不换库）');
  {
    const state = {
      db: [{ id: 'bound-db', name: 'resend-webhooks-db', created: old }],
      buckets: [{ name: 'resend-mail-attachments', created: old }],
      workers: { 'resend-mail-api3': { d1Ids: ['bound-db'], bucketNames: ['resend-mail-attachments'] } },
    };
    const api = fakeApi(state);
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api3' });
    ok(r.conflicts.length === 0, '不报错');
    ok(dbIdOf(r.toml) === 'bound-db' && bucketOf(r.toml) === 'resend-mail-attachments', '⭐ 名字/id 对齐到已绑定资源', `${dbIdOf(r.toml)}/${bucketOf(r.toml)}`);
    ok(api.created.d1.length === 0 && api.created.r2.length === 0, '没有新建');
  }

  section('P6 全新部署、什么都没选（占位 id）→ 按项目名建库建桶');
  {
    const api = fakeApi({ db: [], buckets: [], workers: {} });
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api3' });
    ok(r.conflicts.length === 0, '不报错', JSON.stringify(r.conflicts));
    ok(dbNameOf(r.toml) === 'resend-mail-api3-db' && dbIdOf(r.toml) === 'id-resend-mail-api3-db', '⭐ 库名来自项目名', dbNameOf(r.toml));
    ok(bucketOf(r.toml) === 'resend-mail-api3-bucket', '⭐ 桶名来自项目名', bucketOf(r.toml));
  }

  section('P7 派生出来的名字被别的 worker 占用 → 停止');
  {
    const state = {
      db: [{ id: 'taken-id', name: 'resend-mail-api3-db', created: old }],
      buckets: [],
      workers: { other: { d1Ids: ['taken-id'], bucketNames: [] } },
    };
    const api = fakeApi(state);
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api3' });
    ok(r.conflicts.length >= 1, '报错', JSON.stringify(r.conflicts.map((c) => c.slice(0, 50))));
    ok(/belongs to "other"/.test(r.conflicts[0]), '点名占用者', r.conflicts[0].slice(0, 90));
  }

  section('P8 选中的桶被别的 worker 使用 → 停止（R2 没有 id 可兜底）');
  {
    const state = {
      db: [{ id: 'd', name: 'resend-webhooks-db', created: recent }],
      buckets: [{ name: 'resend-mail-attachments', created: old }],
      workers: { 'resend-mail-api': { d1Ids: ['d'], bucketNames: ['resend-mail-attachments'] } },
    };
    const api = fakeApi(state);
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api3' });
    ok(r.conflicts.length >= 1, '报错', JSON.stringify(r.conflicts.map((c) => c.slice(0, 40))));
    ok(/already used by the worker/.test(r.conflicts[0]), '说明归属', r.conflicts[0].slice(0, 90));
  }

  section('P9 配置里的 id 在本账号不存在 → 明确报错（回部署页重选）');
  {
    const api = fakeApi({ db: [], buckets: [], workers: {} });
    const r = await pre.resolveResources(withId('ghost-id', 'whatever'), api, { workerName: 'resend-mail-api3' });
    ok(r.conflicts.length === 1 && /does not exist in this account/.test(r.conflicts[0]), '⭐ 报错并指向部署页', r.conflicts[0].slice(0, 90));
  }

  section('P10 API 读不到时：不阻塞、不改写（只告警）');
  {
    const api = fakeApi({ db: [], buckets: [], workers: {} });
    api.listD1 = async () => ({ error: 'boom' });
    api.listR2 = async () => ({ error: 'boom' });
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api3' });
    ok(r.conflicts.length === 0, '不报错');
    ok(r.toml === TOML, '不改写配置');
    ok(r.notes.filter((n) => /could not list/.test(n)).length === 2, '两条告警', r.notes.join(' | '));
  }

  section('P11 无 token 时 main() 直接放行');
  {
    const saved = { t: process.env.CLOUDFLARE_API_TOKEN, a: process.env.CLOUDFLARE_ACCOUNT_ID };
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    ok((await pre.main()) === 0, '退出码 0（跳过守卫）');
    if (saved.t) process.env.CLOUDFLARE_API_TOKEN = saved.t;
    if (saved.a) process.env.CLOUDFLARE_ACCOUNT_ID = saved.a;
  }

  console.log(`\n===== 结果: ${pass} passed, ${failures.length} failed =====`);
  if (failures.length) console.log(`失败项：\n- ${failures.join('\n- ')}`);
  process.exit(failures.length ? 1 : 0);
})();
