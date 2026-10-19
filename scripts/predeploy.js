'use strict';

/* =============================================================================
 * Deploy preflight for the "Deploy to Cloudflare button".
 *
 * Why this exists
 * ---------------
 * Cloudflare's template URL only rewrites the **worker name**; the resource names in wrangler.toml are literals. So when
 * `database_name` / `bucket_name` already exist in the account, the button attaches those resources and backfills their
 * ids — silently pointing a second deployment at the first one's production D1 / R2 (observed: a "test" deployment ended
 * up bound to the live database).
 *
 * What it does (before `wrangler deploy` runs)
 * -------------------------------------------
 * For D1 and R2:
 *   · name does not exist            -> keep it (fresh install; the button's provisioning may have just created it)
 *   · exists and **is ours**         -> keep it (we already own it: the worker's current bindings, or it was created in
 *                                       the last 15 minutes by this very deploy)
 *   · exists and is somebody else's  -> append "-<worker name>" to the name (stable across redeploys, unlike a random
 *                                       suffix which would create a brand-new empty database on every deploy), create
 *                                       that resource, and write the new name + id back into wrangler.toml
 *   · the suffixed name is taken too -> **fail loudly** and tell the user what to change
 *
 * Without CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (a plain local `wrangler deploy`), or with PREDEPLOY_SKIP=1, it
 * exits immediately and the deploy behaves exactly as before.
 * =========================================================================== */

const fs = require('fs');
const path = require('path');

const API = 'https://api.cloudflare.com/client/v4';
const FRESH_MS = 15 * 60 * 1000; // a resource created this recently was almost certainly provisioned by this deploy

/** Read the (non-comment) value of `key` from a wrangler.toml section, e.g. database_name inside [[d1_databases]]. */
function readValue(toml, section, key) {
  const lines = toml.split('\n');
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && !trimmed.startsWith('#')) {
      inSection = trimmed === section;
      continue;
    }
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue;
    const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`).exec(trimmed);
    if (m) return m[1];
  }
  return null;
}

/** Replace the (non-comment) `key = "…"` line inside a section, keeping comments / formatting intact. */
function setValue(toml, section, key, value) {
  const lines = toml.split('\n');
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[') && !trimmed.startsWith('#')) {
      inSection = trimmed === section;
      continue;
    }
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue;
    const m = new RegExp(`^(\\s*)${key}(\\s*=\\s*)"[^"]*"`).exec(lines[i]);
    if (m) {
      lines[i] = `${m[1]}${key}${m[2]}"${value}"`;
      return lines.join('\n');
    }
  }
  return toml;
}

/**
 * Write key/value pairs into a TOML section, **adding the section** when the file does not declare it.
 * The Deploy Button template ships with the D1 / R2 blocks commented out (so its setup page shows no resource pickers),
 * which means the guard has to create the blocks rather than edit existing lines.
 */
function upsertSection(toml, header, values) {
  const exists = toml.split('\n').some((line) => line.trim() === header);
  if (exists) {
    let out = toml;
    for (const [k, v] of Object.entries(values)) out = setValue(out, header, k, v);
    return out;
  }
  const block = `\n${header}\n` + Object.entries(values).map(([k, v]) => `${k} = "${v}"`).join('\n') + '\n';
  return toml.replace(/\s*$/, '\n') + block;
}

function workerName(toml) {
  return readValue(toml, '', 'name') || (/^name\s*=\s*"([^"]+)"/m.exec(toml) || [])[1] || '';
}

/** The names the template ships with. They are placeholders: the defaults below are derived from the project name. */
const TEMPLATE_DB = 'resend-webhooks-db';
const TEMPLATE_BUCKET = 'resend-mail-attachments';

/** R2 / D1 resource names: lowercase, letters/digits/hyphens, <= 60 chars (leave room for "-attachments"). */
function sanitizeName(raw, fallback) {
  const base = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  return base && !/^[0-9]+$/.test(base) ? base : fallback;
}

/**
 * Derive this deployment's resource names from the project name — the one value the Deploy Button reliably writes into
 * the repository. `name` is the Worker name, so two projects never fight over the same database or bucket.
 */
function derivedNames(rawWorker) {
  const base = sanitizeName(rawWorker, 'resend-mail');
  return { db: `${base}-db`, bucket: `${base}-bucket` };
}

function isFresh(createdAt) {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && Date.now() - t < FRESH_MS;
}

function makeApi(token, accountId, fetchImpl) {
  const call = async (method, p, body) => {
    const res = await fetchImpl(`${API}/accounts/${accountId}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok && json && json.success !== false, json };
  };

  return {
    /** The worker's current bindings, so a redeploy recognises its own resources. null when the script does not exist. */
    async ownBindings(name) {
      const r = await call('GET', `/workers/scripts/${encodeURIComponent(name)}/settings`);
      if (r.status === 404) return { exists: false, d1Ids: [], bucketNames: [] };
      if (!r.ok) return { error: (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || `HTTP ${r.status}` };
      const bindings = (r.json && r.json.result && r.json.result.bindings) || [];
      return {
        exists: true,
        d1Ids: bindings.filter((b) => b.type === 'd1').map((b) => b.id).filter(Boolean),
        bucketNames: bindings.filter((b) => b.type === 'r2_bucket').map((b) => b.bucket_name).filter(Boolean),
      };
    },
    /** Every worker script in the account (used to detect "this resource already belongs to another deployment"). */
    async listScripts() {
      const r = await call('GET', '/workers/scripts');
      if (!r.ok) return { error: (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || `HTTP ${r.status}` };
      return { list: (r.json.result || []).map((x) => x.id).filter(Boolean) };
    },
    async listD1() {
      const r = await call('GET', '/d1/database?per_page=100');
      if (!r.ok) return { error: (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || `HTTP ${r.status}` };
      return { list: (r.json.result || []).map((d) => ({ id: d.uuid, name: d.name, created: d.created_at })) };
    },
    async createD1(name) {
      const r = await call('POST', '/d1/database', { name });
      if (!r.ok) return { error: (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || `HTTP ${r.status}` };
      return { id: r.json.result && r.json.result.uuid, name: r.json.result && r.json.result.name };
    },
    async listR2() {
      const r = await call('GET', '/r2/buckets?per_page=100');
      if (!r.ok) return { error: (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || `HTTP ${r.status}` };
      const buckets = (r.json.result && r.json.result.buckets) || [];
      return { list: buckets.map((b) => ({ name: b.name, created: b.creation_date })) };
    },
    async createR2(name) {
      const r = await call('POST', '/r2/buckets', { name });
      if (!r.ok) return { error: (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || `HTTP ${r.status}` };
      return { name };
    },
  };
}

/**
 * Resolve the D1 / R2 bindings, then write the result back into wrangler.toml.
 *
 * The Deploy Button's setup page lets the user **pick an existing resource or create a new one**, and writes the resolved
 * id (or bucket name) into the repository. So the guard's job is not to invent names — it is to make sure the deploy
 * cannot silently end up sharing another deployment's data, and to fill in what the page could not.
 *
 * Priority:
 *   1. A real id in the file  -> that is what the page resolved; use it.
 *      · created moments ago            -> it was just created for this deployment.
 *      · used by another worker         -> **stop** (this is the "test deployment wrote into production" case).
 *      · not used by anyone             -> use it (an existing, unbound resource was picked on purpose).
 *   2. No id (placeholder)    -> keep the resource this worker is already bound to, otherwise derive
 *      "<project>-db" / "<project>-bucket" from the project name and create it when that name is free.
 *
 * Returns { toml, notes, conflicts }; a non-empty `conflicts` aborts the deploy.
 */
async function resolveResources(toml, api, opts = {}) {
  const name = opts.workerName || workerName(toml);
  const notes = [];
  const conflicts = [];
  const derived = derivedNames(name);

  const d1Name = readValue(toml, '[[d1_databases]]', 'database_name');
  const d1Id = readValue(toml, '[[d1_databases]]', 'database_id');
  const bucketName = readValue(toml, '[[r2_buckets]]', 'bucket_name');
  const hasRealId = Boolean(d1Id && d1Id !== '<DATABASE_ID>');

  const own = api ? await api.ownBindings(name) : { exists: false, d1Ids: [], bucketNames: [] };
  if (own.error) notes.push(`could not read this worker's bindings (${own.error}); assuming none`);
  const boundDbId = (own.d1Ids || [])[0] || null;
  const boundBucket = (own.bucketNames || [])[0] || null;

  /** Who else (besides this worker) already binds that database / bucket? */
  const ownerOfD1 = async (id) => {
    if (!api || !id) return null;
    if ((own.d1Ids || []).includes(id)) return null; // ours
    const scripts = await api.listScripts();
    if (scripts.error) return { unknown: scripts.error };
    for (const script of scripts.list.filter((x) => x !== name).slice(0, 15)) {
      const b = await api.ownBindings(script).catch(() => null);
      if (b && (b.d1Ids || []).includes(id)) return { script };
    }
    return null;
  };
  const ownerOfBucket = async (bucket) => {
    if (!api || !bucket) return null;
    if ((own.bucketNames || []).includes(bucket)) return null;
    const scripts = await api.listScripts();
    if (scripts.error) return { unknown: scripts.error };
    for (const script of scripts.list.filter((x) => x !== name).slice(0, 15)) {
      const b = await api.ownBindings(script).catch(() => null);
      if (b && (b.bucketNames || []).includes(bucket)) return { script };
    }
    return null;
  };

  /* ---------------- D1 ---------------- */
  if (api) {
    const listed = await api.listD1();
    if (listed.error) {
      notes.push(`could not list D1 databases (${listed.error}); leaving the binding untouched`);
    } else {
      const byFileId = hasRealId ? listed.list.find((d) => d.id === d1Id) : null;
      if (hasRealId && !byFileId) {
        conflicts.push(
          `wrangler.toml points at a D1 database id (${d1Id}) that does not exist in this account. Pick an existing ` +
            `database (or "+ Create new") in the setup page and deploy again.`
        );
      } else if (byFileId) {
        const owner = await ownerOfD1(byFileId.id);
        if (owner && owner.script) {
          conflicts.push(
            `the database selected in the setup page ("${byFileId.name}") is already used by the worker "${owner.script}". ` +
              `Binding it would mix two deployments' mail — choose "+ Create new" instead.`
          );
        } else {
          toml = upsertSection(toml, '[[d1_databases]]', { binding: 'DB', database_name: byFileId.name, database_id: byFileId.id });
          notes.push(
            isFresh(byFileId.created)
              ? `using D1 ${byFileId.name} (created for this deployment)`
              : `using D1 ${byFileId.name} (selected in the setup page; not used by any other worker)`
          );
        }
      } else if (boundDbId && listed.list.some((d) => d.id === boundDbId)) {
        const bound = listed.list.find((d) => d.id === boundDbId);
        toml = upsertSection(toml, '[[d1_databases]]', { binding: 'DB', database_name: bound.name, database_id: bound.id });
        notes.push(`keeping the D1 database this worker is bound to: ${bound.name}`);
      } else {
        const target = derived.db;
        const existing = listed.list.find((d) => d.name === target);
        const owner = existing ? await ownerOfD1(existing.id) : null;
        if (existing && owner && owner.script) {
          conflicts.push(`D1 "${target}" already exists and belongs to "${owner.script}". Rename the project (resource names follow it) or delete that database.`);
        } else {
          const created = existing
            ? { id: existing.id, name: existing.name }
            : await api.createD1(target);
          if (created.error) conflicts.push(`could not create D1 "${target}": ${created.error}`);
          else {
            toml = upsertSection(toml, '[[d1_databases]]', { binding: 'DB', database_name: created.name || target, database_id: created.id });
            notes.push(existing ? `reusing unused D1 ${target}` : `created D1 ${created.name || target} (${created.id})`);
          }
        }
      }
    }
  }

  /* ---------------- R2 ---------------- */
  if (api) {
    const listed = await api.listR2();
    if (listed.error) {
      notes.push(`could not list R2 buckets (${listed.error}); leaving the binding untouched`);
    } else {
      const target = bucketName || boundBucket || derived.bucket;
      const picked = listed.list.find((b) => b.name === target);

      if (picked) {
        const owner = await ownerOfBucket(picked.name);
        if (owner && owner.script) {
          conflicts.push(
            `the R2 bucket selected in the setup page ("${picked.name}") is already used by the worker "${owner.script}". ` +
              `Binding it would mix two deployments' attachments — choose "+ Create new" instead.`
          );
        } else {
          toml = upsertSection(toml, '[[r2_buckets]]', { binding: 'BUCKET', bucket_name: picked.name });
          notes.push(
            isFresh(picked.created)
              ? `using R2 bucket ${picked.name} (created for this deployment)`
              : `using R2 bucket ${picked.name} (selected in the setup page; not used by any other worker)`
          );
        }
      } else {
        // Nothing by that name exists. A still-default name is only a placeholder, so create the project-derived bucket;
        // an explicit name (typed in the setup page) is created as asked.
        const createName = !bucketName || bucketName === TEMPLATE_BUCKET ? derived.bucket : bucketName;
        const created = await api.createR2(createName);
        if (created.error) conflicts.push(`could not create R2 bucket "${createName}": ${created.error}`);
        else {
          toml = upsertSection(toml, '[[r2_buckets]]', { binding: 'BUCKET', bucket_name: createName });
          notes.push(`created R2 bucket ${createName}`);
        }
      }
    }
  }

  return { toml, notes, conflicts };
}

async function main() {
  const file = process.env.PREDEPLOY_TOML || path.join(__dirname, '..', 'wrangler.toml');
  if (process.env.PREDEPLOY_SKIP === '1') {
    console.log('[predeploy] skipped (PREDEPLOY_SKIP=1)');
    return 0;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '';
  if (!token || !accountId) {
    console.log('[predeploy] no CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — skipping the resource-name guard');
    return 0;
  }

  const original = fs.readFileSync(file, 'utf8');
  const api = makeApi(token, accountId, typeof fetch === 'function' ? fetch : globalThis.fetch);
  const { toml, notes, conflicts } = await resolveResources(original, api);

  for (const n of notes) console.log(`[predeploy] ${n}`);
  if (conflicts.length) {
    console.error('\n[predeploy] ✘ deploy stopped — the template cannot pick a free resource name:\n');
    for (const c of conflicts) console.error(`  · ${c}`);
    console.error('');
    return 1;
  }
  if (toml !== original) {
    fs.writeFileSync(file, toml, 'utf8');
    console.log('[predeploy] wrangler.toml updated with the resource names actually used');
  }
  console.log('[predeploy] resource names are safe for this deployment');
  return 0;
}

module.exports = { readValue, setValue, upsertSection, workerName, sanitizeName, derivedNames, isFresh, resolveResources, makeApi, main };

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[predeploy] unexpected failure:', err && err.stack ? err.stack : err);
      process.exit(1);
    });
}
