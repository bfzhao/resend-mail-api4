import type { Env } from './types';
import { SCHEMA_SQL } from './schema-sql';

// A brand-new empty D1 (auto-created on Deploy Button / wrangler deploy) has no tables:
// the Worker idempotently initializes them on first access, so "usable right after deploy". See schema.sql / src/schema-sql.ts.
//
// Each isolate probes only once: first check whether app_config exists; if so, skip (the common hot path costs just one extra SELECT),
// and only run the full DDL if it does not. All DDL is IF NOT EXISTS, so repeated execution is safe.
//
// Two failure modes are handled explicitly, because they both hit *only* a freshly provisioned database (i.e. exactly the
// one-click deploy, never the long-lived production one) and used to surface as a bare "数据库初始化失败":
//   · the database is not ready yet / a transient D1 error right after provisioning → retry a few times with a backoff;
//   · `exec()` rejecting the whole multi-statement script → fall back to running the statements one by one, so a single
//     statement the engine dislikes cannot brick the deployment.
let ready: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
  if (!ready) {
    ready = initialise(env).catch((err) => {
      ready = null; // allow the next request to retry on failure
      throw err;
    });
  }
  return ready;
}

/** D1 says "not ready" / times out while a new database is being provisioned: worth retrying, unlike a SQL error. */
function isTransient(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return (
    msg.includes('not ready') ||
    msg.includes('database is locked') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('storage operation exceeded') ||
    msg.includes('internal error')
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Does the schema already exist? Throws the D1 error so the caller can decide whether it is transient. */
async function hasSchema(env: Env): Promise<boolean> {
  try {
    await env.DB.prepare('SELECT 1 FROM app_config LIMIT 1').first();
    return true;
  } catch (err) {
    // "no such table: app_config" is the expected answer on a fresh database.
    if (/no such table/i.test(err instanceof Error ? err.message : String(err))) return false;
    throw err;
  }
}

/** Split the DDL into statements, dropping `--` comment lines (used only for the per-statement fallback path). */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .map((line) => line.replace(/\s*--.*$/, ''))
    .join('\n');
  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function applySchema(env: Env): Promise<void> {
  try {
    await env.DB.exec(SCHEMA_SQL);
    return;
  } catch (err) {
    // Keep the reason: if the per-statement path succeeds, the deployment is fine, but the log still explains what happened.
    console.warn('[schema] exec() failed, retrying statement by statement:', err instanceof Error ? err.message : err);
  }
  for (const statement of splitStatements(SCHEMA_SQL)) {
    await env.DB.prepare(statement).run();
  }
}

async function initialise(env: Env): Promise<void> {
  if (!env.DB) return;

  for (let attempt = 0; ; attempt++) {
    try {
      if (await hasSchema(env)) return; // already initialized
      await applySchema(env);
      return;
    } catch (err) {
      if (attempt >= 2 || !isTransient(err)) throw err;
      console.warn(`[schema] transient failure (attempt ${attempt + 1}), retrying:`, err instanceof Error ? err.message : err);
      await sleep(150 * (attempt + 1));
    }
  }
}
