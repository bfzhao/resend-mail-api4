'use strict';

/* =========================================================
 * wrangler.toml structural guard (zero deps: node test/wrangler-toml.test.js)
 *
 * Why: a TOML key belongs to the **table header that precedes it**. Putting `workers_dev = true` after `[assets]` made
 * wrangler warn
 *     "Unexpected fields found in assets field: workers_dev, preview_urls"
 * — the deploy still worked, but the setting silently landed in the wrong table. This test parses the template line by
 * line (comments ignored) and pins down which keys are allowed in the root table and in each section, so that class of
 * mistake fails the suite instead of flashing a warning at deploy time.
 * ========================================================= */

const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { failures.push(msg); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/** Minimal TOML reader: returns { root: {k:v}, tables: [{header, keys:[...]}] } — enough for a wrangler config. */
function parse(text) {
  const root = {};
  const tables = [];
  let current = root;
  let currentHeader = '(root)';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      currentHeader = header[1].trim();
      current = {};
      tables.push({ header: currentHeader, keys: current });
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (kv) current[kv[1]] = kv[2].trim();
  }
  return { root, tables };
}

const file = path.join(__dirname, '..', 'wrangler.toml');
const text = fs.readFileSync(file, 'utf8');
const { root, tables } = parse(text);

console.log('wrangler.toml 结构检查（防止键落进错误的表）');

section('W1 根表只放顶层键');
const rootKeys = Object.keys(root).sort();
ok(rootKeys.join(',') === 'compatibility_date,main,name,preview_urls,workers_dev', '⭐ 根表正好是 name / main / compatibility_date / workers_dev / preview_urls', JSON.stringify(rootKeys));
ok(root.workers_dev === 'true', '⭐ workers_dev 在根表（不是 assets 里）', root.workers_dev);
ok(root.preview_urls === 'false', '⭐ preview_urls 在根表', root.preview_urls);
ok(root.name === '"resend-mail-api"', 'name 是模板默认名', root.name);
ok(root.main === '"src/index.ts"', 'main 指向 src/index.ts', root.main);

section('W2 assets 段只允许 wrangler 认识的字段');
const assets = tables.find((t) => t.header === 'assets');
ok(!!assets, 'assets 段存在');
const assetKeys = assets ? Object.keys(assets.keys).sort() : [];
ok(assetKeys.join(',') === 'binding,directory,not_found_handling,run_worker_first',
  '⭐ assets 只含 binding / directory / run_worker_first / not_found_handling', JSON.stringify(assetKeys));
ok(!assets || assets.keys.directory === '"./public"', 'assets.directory = ./public', assets && assets.keys.directory);

section('W3 D1 / R2 绑定：D1 用占位 id，R2 有名（部署页会把它选中的结果写回这里）');
const d1 = tables.find((t) => t.header === 'd1_databases');
ok(!!d1, '有 [[d1_databases]] 段');
ok(d1 && d1.keys.binding === '"DB"', 'D1 binding = DB', d1 && d1.keys.binding);
ok(d1 && d1.keys.database_id === '"<DATABASE_ID>"', '⭐ database_id 是占位符（留给部署页/守卫填）', d1 && d1.keys.database_id);
const r2 = tables.find((t) => t.header === 'r2_buckets');
ok(!!r2 && r2.keys.binding === '"BUCKET"', 'R2 binding = BUCKET', r2 && r2.keys.binding);
ok(!!r2 && !!r2.keys.bucket_name, 'R2 有默认桶名', r2 && r2.keys.bucket_name);
ok(/predeploy\.js/.test(text), '注释说明守卫会在部署前处理这两个绑定');

section('W4 默认不带 Queue（Cloudflare 一个队列只能有一个 consumer）');
ok(!tables.some((t) => /^queues\./.test(t.header)), '⭐ 模板里没有 queues.* 段（第二次部署不会撞 11004）',
  JSON.stringify(tables.map((t) => t.header)));

section('W5 vars 里不再放占位发件人 / worker 名');
const vars = tables.find((t) => t.header === 'vars');
const varKeys = vars ? Object.keys(vars.keys).sort() : [];
ok(!!vars, 'vars 段存在');
ok(!varKeys.some((k) => /^SEND_FROM_|^WORKER_NAME$/.test(k)),
  '⭐ 没有 SEND_FROM_ADDRESS / SEND_FROM_NAME / WORKER_NAME（向导会写进 D1）', JSON.stringify(varKeys));
ok(varKeys.join(',') === 'MERGE_SUBREQ_BUDGET', 'vars 只剩 MERGE_SUBREQ_BUDGET', JSON.stringify(varKeys));

section('W6 cron 与 dev 段');
const triggers = tables.find((t) => t.header === 'triggers');
ok(!!triggers && triggers.keys.crons === '["*/15 * * * *"]', '保留 */15 的自愈 cron', triggers && triggers.keys.crons);
ok(!!tables.find((t) => t.header === 'dev'), 'dev 段（本地端口）仍在');

section('W7 注释里提到的队列示例不会变成真段');
const commented = text.split('\n').filter((l) => /^\s*#\s*\[\[queues/.test(l)).length;
ok(commented >= 2, '队列示例以注释形式保留（说明怎么开启）', commented);

console.log(`\n===== 结果: ${pass} passed, ${failures.length} failed =====`);
if (failures.length) console.log(`失败项：\n- ${failures.join('\n- ')}`);
process.exit(failures.length ? 1 : 0);
