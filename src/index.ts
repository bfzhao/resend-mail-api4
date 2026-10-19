import type { Env, Folder, InboundQueueMessage } from './types';
import { authenticate, unauthorized, authMode, isAuthenticated } from './auth';
import { hashPassword, verifyPassword, signSession, sessionCookie, clearSessionCookie, randomHex, SESSION_TTL_SEC } from './session';
import { handleInbound, handleEvents } from './webhook';
import { handleInboundEmail, handleInboundQueue, replayPendingInbound } from './inbound-email';
import * as repo from './repo';
import { configureDomain, selfCheck, withRuntimeConfig } from './setup';
import * as rd from './resend-domains';
import { ensureSchema } from './schema';
import { resendSend, replySubject, forwardSubject, textToHtml, senderIdentity, sendingDomain, sendingDomains } from './send';
import type { ResendAttachment } from './send';
import { json, jsonArr, nowSec, parseAddress, parseAddressList, rootThreadId, isSaneThreadId, parseReferences, stripAngle, uuid, base64ToBytes, bytesToBase64, stripHtml } from './util';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/health' && method === 'GET') {
      return json({ status: 'ok', timestamp: nowSec() });
    }

    // A brand-new empty DB (auto-created by the Deploy Button) is idempotently initialized on first request, so "usable right after deploy". See src/schema.ts.
    try {
      await ensureSchema(env);
    } catch (err) {
      console.error('ensureSchema failed:', err);
      return json({ error: '数据库初始化失败' }, 500);
    }

    // Webhook entry points: signature check only, no Basic Auth
    if (path === '/webhook/inbound' && method === 'POST') return handleInbound(request, env);
    if (path === '/webhook/events' && method === 'POST') return handleEvents(request, env);

    // Setup wizard / login: must be publicly reachable (users need to reach it before they have credentials); each endpoint constrains itself by state.
    if (path.startsWith('/api/setup/') || path === '/api/login' || path === '/api/logout') {
      return routeGate(request, env, path);
    }

    // Everything else requires authentication (API + page assets)
    if (!(await authenticate(request, env))) return unauthorized();

    if (path.startsWith('/api/')) {
      // Layer the send config written by the wizard into D1 (Resend Key / from address, plus the multi-domain set)
      // on top of env, so existing send/account logic can use the D1 config without changes.
      const runtimeEnv = await withRuntimeConfig(env);
      return routeApi(request, runtimeEnv, path, url);
    }

    // SPA static assets (index.html / app.js / app.css) are served by assets (no DB config needed)
    if ((method === 'GET' || method === 'HEAD') && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return json({ error: 'Not Found' }, 404);
  },

  // CF Email Routing inbound: write the raw message to R2 + register + enqueue (see the notes in src/inbound-email.ts).
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await ensureSchema(env);
    await handleInboundEmail(env, message);
  },

  // Inbound async parse consumption (stage two of the never-lose pipeline).
  async queue(batch: MessageBatch<InboundQueueMessage>, env: Env): Promise<void> {
    await ensureSchema(env);
    await handleInboundQueue(batch, env);
  },

  // Recovery cron (never-lose fallback): re-enqueue inbound mail that is "already in R2 but not fully parsed".
  // See replayPendingInbound in src/inbound-email.ts and [triggers] in wrangler.toml.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await ensureSchema(env);
    const n = await replayPendingInbound(env);
    if (n) console.log(`inbound: replay enqueued ${n} pending raw message(s)`);
  },
};

/* ---------------- Setup wizard / login (public routes) ---------------- */

/**
 * Wizard and login. **None require pre-authentication**, but each endpoint constrains itself:
 *   - `status`: tell the frontend the current mode (basic/session/none) and whether logged in.
 *   - `admin` : only allow creating the first admin while "uninitialized" (no env auth, no admin).
 *   - `login` / `logout`: create/clear the session cookie.
 */
async function routeGate(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;
  if (path === '/api/setup/status' && method === 'GET') return setupStatus(request, env);
  if (path === '/api/setup/admin' && method === 'POST') return setupAdmin(request, env);
  // The following endpoints require being logged in (the session cookie from just creating the admin is enough)
  if (path === '/api/setup/domain' && method === 'POST') {
    if (!(await isAuthenticated(request, env))) return unauthorized();
    return setupDomain(request, env);
  }
  if (path === '/api/setup/check' && method === 'GET') {
    if (!(await isAuthenticated(request, env))) return unauthorized();
    return json(await selfCheck(env));
  }
  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/logout' && method === 'POST') return logout();
  return json({ error: 'Not Found' }, 404);
}

async function setupDomain(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { domain?: unknown; cf_token?: unknown; resend_key?: unknown; from_address?: unknown; from_name?: unknown; worker_name?: unknown }
    | null;
  if (!body) return json({ error: '参数错误' }, 400);
  const result = await configureDomain(env, {
    domain: body.domain,
    cfToken: body.cf_token,
    resendKey: body.resend_key,
    fromAddress: body.from_address,
    fromName: body.from_name,
    workerName: body.worker_name,
  });
  return json(result, result.error && result.steps.length === 0 ? 400 : 200);
}

async function setupStatus(request: Request, env: Env): Promise<Response> {
  const mode = await authMode(env);
  const cfg = env.DB ? await repo.getConfigMap(env).catch(() => ({} as Record<string, string>)) : {};
  // Report the *effective* config (D1 wins, env is only a bootstrap fallback). Running the merge here also imports a
  // purely env-configured deployment into D1 on the very first request, so the wizard does not nag a deployment that is
  // already fully configured through env vars.
  const rt = await withRuntimeConfig(env).catch(() => env);
  return json({
    configured: mode !== 'none',
    mode,
    authenticated: await isAuthenticated(request, env),
    domain: rt.SENDING_DOMAIN || '',
    from_address: rt.SEND_FROM_ADDRESS || '',
    from_name: rt.SEND_FROM_NAME || '',
    // Whether the wizard completed: `setup_complete` is a historical flag, the domains table is the real signal (so a
    // database whose app_config was cleaned up does not drop the user back into the wizard).
    complete:
      cfg.setup_complete === '1' || (env.DB ? (await repo.listDomains(env).catch(() => [] as repo.DomainRow[])).length > 0 : false),
    sending_configured: Boolean(rt.RESEND_API_KEY),
  });
}

async function setupAdmin(request: Request, env: Env): Promise<Response> {
  if (env.API_USERNAME || env.API_PASSWORD) {
    return json({ error: '已通过环境变量配置认证，无需设置向导账号' }, 400);
  }
  const body = (await request.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password) return json({ error: '用户名或密码不能为空' }, 400);
  if (username.length > 64) return json({ error: '用户名过长' }, 400);
  if (password.length < 6) return json({ error: '密码至少 6 位' }, 400);
  if (await repo.hasAdminUser(env)) return json({ error: '管理员已存在，请直接登录' }, 409);

  const uid = await repo.createAdmin(env, username, await hashPassword(password));
  const secret = (await repo.getConfig(env, 'session_secret')) || randomHex(32);
  await repo.setConfig(env, 'session_secret', secret);
  const token = await signSession(secret, uid);
  return withCookie(json({ ok: true, username }), sessionCookie(token, SESSION_TTL_SEC));
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password) return json({ error: '用户名或密码不能为空' }, 400);

  const user = await repo.getAdminByUsername(env, username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json({ error: '用户名或密码错误' }, 401);
  }
  // The signing key normally comes into being together with the first admin (see setupAdmin). When it is missing — the
  // row was cleaned up, lost, or the database was restored without app_config — mint a new one here instead of refusing
  // to log in. The password check above has already proved who this is, so this cannot be an auth bypass, and the old
  // state is unrecoverable anyway: every existing cookie was signed with the vanished key and is invalid either way.
  // Refusing (409) used to be a one-way trap, because setup/admin rejects creating an admin that already exists.
  let secret = await repo.getConfig(env, 'session_secret');
  if (!secret) {
    secret = randomHex(32);
    await repo.setConfig(env, 'session_secret', secret);
    console.warn('[auth] session_secret was missing; minted a new one on login (older sessions are now invalid)');
  }
  const token = await signSession(secret, user.id);
  return withCookie(json({ ok: true, username: user.username }), sessionCookie(token, SESSION_TTL_SEC));
}

function logout(): Response {
  return withCookie(json({ ok: true }), clearSessionCookie());
}

function withCookie(resp: Response, cookie: string): Response {
  resp.headers.append('Set-Cookie', cookie);
  return resp;
}

async function routeApi(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const method = request.method;

  // Inbox/sent/starred/trash folder list (optionally filtered by mailbox)
  const folderMatch = /^\/api\/folders\/(inbox|sent|starred|trash)$/.exec(path);
  if (folderMatch && method === 'GET') {
    const folder = folderMatch[1] as Folder;
    const q = url.searchParams.get('q') || null;
    const unread = url.searchParams.get('unread') === '1';
    const mailbox = url.searchParams.get('mailbox') || undefined;
    const domain = readDomainParam(url);
    const limit = clampInt(url.searchParams.get('limit'), 50, 200);
    const offset = clampInt(url.searchParams.get('offset'), 0, 100000);
    const result = await repo.listFolder(env, { folder, q, unread, mailbox, domain, limit, offset });
    return json({ folder, items: result.items, total: result.total, limit, offset });
  }

  // Draft list. Drafts live in a separate table (see the drafts notes in schema.sql),
  // but the **returned shape is exactly the same as the other folders** (disguised as a message with direction='draft'),
  // so the frontend can reuse the same list rendering / cache / paging / search logic.
  if (path === '/api/folders/drafts' && method === 'GET') {
    const q = url.searchParams.get('q') || null;
    const mailbox = url.searchParams.get('mailbox') || undefined;
    const domain = readDomainParam(url);
    const limit = clampInt(url.searchParams.get('limit'), 50, 200);
    const offset = clampInt(url.searchParams.get('offset'), 0, 100000);
    const result = await repo.listDrafts(env, { q, mailbox, domain, limit, offset });
    return json({ folder: 'drafts', items: result.items, total: result.total, limit, offset });
  }

  // Single draft: GET to restore editing / PUT to autosave (upsert) / DELETE to discard
  const draftMatch = /^\/api\/drafts\/([^/]+)$/.exec(path);
  if (draftMatch) {
    const draftId = decodeURIComponent(draftMatch[1]);
    if (method === 'GET') {
      const d = await repo.getDraft(env, draftId);
      if (!d) return json({ error: '草稿不存在' }, 404);
      return json({ draft: draftJson(d) });
    }
    if (method === 'PUT') {
      const body = await request.json().catch(() => null);
      const input = parseDraftInput(draftId, body);
      if (!input) return json({ error: '参数错误' }, 400);
      await repo.upsertDraft(env, input);
      return json({ ok: true, id: draftId });
    }
    if (method === 'DELETE') {
      await repo.deleteDraft(env, draftId);
      return json({ ok: true });
    }
    return json({ error: 'Method Not Allowed' }, 405);
  }

  // Sidebar counts (optionally filtered by mailbox/domain)
  if (path === '/api/counts' && method === 'GET') {
    const mailbox = url.searchParams.get('mailbox') || undefined;
    const domain = readDomainParam(url);
    return json(await repo.sidebarCounts(env, mailbox, domain));
  }

  // Receiving address list (multi-mailbox switching; optionally restricted to one domain)
  if (path === '/api/mailboxes' && method === 'GET') {
    const domain = readDomainParam(url);
    return json({ mailboxes: await repo.mailboxes(env, domain) });
  }

  // Configured domains (multi-domain top-bar switcher); app_config's primary domain is included even before the domains table is populated.
  if (path === '/api/domains' && method === 'GET') {
    const rows = await repo.listDomains(env);
    const seen = new Set<string>();
    const domains: Array<{ domain: string; from_address: string | null; from_name: string | null; zone_id: string | null }> = [];
    for (const r of rows) {
      if (r.enabled === 0 || !r.domain || seen.has(r.domain)) continue;
      seen.add(r.domain);
      domains.push({ domain: r.domain, from_address: r.from_address, from_name: r.from_name, zone_id: r.zone_id || null });
    }
    for (const d of sendingDomains(env)) {
      if (!seen.has(d)) {
        seen.add(d);
        domains.push({ domain: d, from_address: env.SEND_FROM_ADDRESS || null, from_name: env.SEND_FROM_NAME || null, zone_id: null });
      }
    }
    // Per-domain unread counts drive the new-mail badge on each chip (a separate GROUP BY keeps this cheap).
    const unread = await repo.domainUnreadCounts(env).catch(() => ({} as Record<string, number>));
    return json({ domains, unread });
  }

  // Local contacts (recipient input suggestions for compose/reply/forward)
  if (path === '/api/contacts' && method === 'GET') {
    return json({ contacts: await repo.contacts(env) });
  }

  // Sending settings (in-app editing). The key is **bound to a domain** (two domains may live in different Resend
  // accounts), so editing a key requires `domain`. Only the *default sender* can be set globally (it is optional: the
  // composer picks the sender per message).
  if (path === '/api/settings/send' && method === 'POST') {
    const body = (await request.json().catch(() => null)) as
      | { domain?: unknown; resend_key?: unknown; from_address?: unknown; from_name?: unknown }
      | null;
    if (!body) return json({ error: '参数错误' }, 400);
    let targetDomain = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : '';
    const updates: Array<[string, string]> = [];
    const domainPatch: { apiKey?: string; fromAddress?: string; fromName?: string } = {};
    let keyCheck: { domains?: Array<{ name: string; status: string }>; warning?: string } | null = null;
    // A sender without an explicit domain is the **primary** domain's default sender. There is no global one any more:
    // a from-address that belongs to no domain cannot be sent with, and keeping it in app_config is exactly how a stale
    // "global sender" used to shadow the per-domain one.
    const primaryDomainFor = async (): Promise<string> => {
      if (targetDomain) return targetDomain;
      const rows = await repo.listDomains(env).catch(() => [] as repo.DomainRow[]);
      const first = rows.find((r) => r.enabled !== 0 && String(r.domain || '').trim());
      return first ? String(first.domain).trim().toLowerCase() : '';
    };

    if (typeof body.resend_key === 'string' && body.resend_key.trim()) {
      const key = body.resend_key.trim();
      if (!targetDomain) return json({ error: 'Resend Key 是按域名保存的，请指定 domain' }, 400);
      if (!/^re_[A-Za-z0-9_-]{6,}$/.test(key)) return json({ error: 'Resend API Key 格式不正确（应以 re_ 开头）' }, 400);
      // Verify before replacing a working key: a typo would silently break sending for that domain.
      try {
        const list = await rd.listDomains(key);
        keyCheck = { domains: list.map((d) => ({ name: d.name, status: d.status })) };
        // Cross-check against the domain being edited: saving a key from the wrong Resend account is exactly the mistake
        // per-domain keys exist to prevent, so warn loudly (still allowed: a key may be domain-limited).
        if (!list.some((d) => String(d.name || '').trim().toLowerCase() === targetDomain)) {
          keyCheck.warning = `这把 Key 在 Resend 里看不到 ${targetDomain}，保存后该域发信仍会报「domain is not verified」。请确认用的是该域所在 Resend 账号的 Key。`;
        }
      } catch (e) {
        const msg = (e as Error).message;
        // A "sending access" key is legitimate for sending, it just cannot list domains — accept it, but say so.
        if (/restricted to only send emails/i.test(msg)) {
          keyCheck = { warning: '这把 Key 是「仅发送」权限：可以发信，但不能建域 / 验证域名。' };
        } else {
          return json({ error: `新 Key 校验失败，未保存：${msg}` }, 400);
        }
      }
      domainPatch.apiKey = key;
    }
    if (typeof body.from_address === 'string' && body.from_address.trim()) {
      const addr = body.from_address.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return json({ error: '发件地址格式不正确' }, 400);
      targetDomain = await primaryDomainFor();
      if (!targetDomain) return json({ error: '还没有域名：请先在向导里添加一个域名' }, 400);
      domainPatch.fromAddress = addr;
    }
    // An empty display name is a legitimate value ("send without a name"), so it is always written when provided.
    if (typeof body.from_name === 'string') {
      targetDomain = await primaryDomainFor();
      if (!targetDomain) return json({ error: '还没有域名：请先在向导里添加一个域名' }, 400);
      domainPatch.fromName = body.from_name.trim();
    }
    const hasDomainPatch = Object.keys(domainPatch).length > 0;
    if (!updates.length && !hasDomainPatch) return json({ error: '没有需要保存的内容' }, 400);

    if (hasDomainPatch) {
      const rows = await repo.listDomains(env).catch(() => [] as repo.DomainRow[]);
      if (!rows.some((r) => String(r.domain).trim().toLowerCase() === targetDomain)) {
        return json({ error: `未知域名：${targetDomain}` }, 400);
      }
      const ok = await repo.updateDomainSettings(env, targetDomain, domainPatch);
      if (!ok) {
        // The database predates migration 012 (no domains.resend_api_key column): nothing to write, so say so instead of
        // silently storing a global key that would then shadow the per-domain model.
        return json({ error: '数据库版本过旧（缺少 domains.resend_api_key），请先执行 migrations/012_domain_api_keys.sql' }, 400);
      }
    }
    for (const [k, v] of updates) await repo.setConfig(env, k, v);
    return json({
      ok: true,
      domain: targetDomain || null,
      updated: updates.map((u) => u[0]).concat(Object.keys(domainPatch)),
      key_check: keyCheck,
    });
  }

  // Account/send capability info (for the compose UI to show the sender)
  if (path === '/api/account' && method === 'GET') {
    // Sender candidates for the composer. The frontend can derive senders from "mailboxes that have messages", which is
    // empty on a brand-new domain — that left the picker with nothing to show, hiding the whole sender row (and the
    // "custom sender" entry) so no mail could be sent at all. So the configured defaults are listed here explicitly:
    // the default from address first (the pre-multi-domain sender), then each configured domain's own default address.
    const domRows = await repo.listDomains(env).catch(() => [] as repo.DomainRow[]);
    const rowByDomain = new Map<string, repo.DomainRow>();
    for (const r of domRows) {
      if (r.enabled === 0 || !r.domain) continue;
      rowByDomain.set(String(r.domain).trim().toLowerCase(), r);
    }
    const senders: string[] = [];
    const addSender = (raw: unknown): void => {
      const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (v && v.includes('@') && !senders.includes(v)) senders.push(v);
    };
    addSender(env.SEND_FROM_ADDRESS);
    for (const d of sendingDomains(env)) addSender(rowByDomain.get(d)?.from_address || `noreply@${d}`);

    return json({
      // A key is required to send, but it is bound per domain (or falls back to env) — so "can send" means at least one
      // of those exists.
      can_send: Boolean(env.RESEND_API_KEY) || sendingDomains(env).some((d) => (rowByDomain.get(d)?.resend_api_key || '').trim()),
      from_name: env.SEND_FROM_NAME || '',
      from_address: env.SEND_FROM_ADDRESS || '',
      domain: sendingDomain(env),
      domains: sendingDomains(env),
      senders,
    });
  }

  // Backend status: CF (D1/R2 usage + inbound queue) + Resend (send quota). The frontend sees it all at a glance and knows in advance when to upgrade. ?refresh=1 forces a storage recalculation.
  if (path === '/api/usage' && method === 'GET') {
    return json(await repo.getBackendStatus(env, { force: url.searchParams.get('refresh') === '1' }));
  }

  // Batch operations: /api/messages/batch
  if (path === '/api/messages/batch' && method === 'POST') {
    const body = (await request.json().catch(() => null)) as { ids?: unknown; action?: unknown } | null;
    if (!body || !Array.isArray(body.ids) || typeof body.action !== 'string') {
      return json({ error: '参数错误' }, 400);
    }
    const ids = (body.ids as unknown[]).filter((x): x is string => typeof x === 'string');
    const result = await repo.batchAction(env, ids, body.action as repo.BatchAction);
    return json(result);
  }

  // Compose: /api/messages
  if (path === '/api/messages' && method === 'POST') {
    return compose(env, request);
  }

  // Reply: /api/messages/:id/reply
  const replyMatch = /^\/api\/messages\/([^/]+)\/reply$/.exec(path);
  if (replyMatch && method === 'POST') {
    return reply(env, request, decodeURIComponent(replyMatch[1]));
  }

  // Forward: /api/messages/:id/forward (a message in any direction can be forwarded)
  const forwardMatch = /^\/api\/messages\/([^/]+)\/forward$/.exec(path);
  if (forwardMatch && method === 'POST') {
    return forward(env, request, decodeURIComponent(forwardMatch[1]));
  }

  // Single message detail / update
  const messageMatch = /^\/api\/messages\/([^/]+)$/.exec(path);
  if (messageMatch) {
    const id = decodeURIComponent(messageMatch[1]);
    if (method === 'GET') return getMessageDetail(env, id);
    if (method === 'PATCH') {
      const body = (await request.json().catch(() => null)) as repo.PatchBody | null;
      if (!body) return json({ error: '参数错误' }, 400);
      const ok = await repo.patchMessage(env, id, body);
      return ok ? json({ ok: true }) : json({ error: '未找到该邮件' }, 404);
    }
    return json({ error: 'Method Not Allowed' }, 405);
  }

  // Attachment proxy: /api/attachments/:id  (?dl=1 forces download; without it, inline preview is decided by type)
  const attachmentMatch = /^\/api\/attachments\/([^/]+)$/.exec(path);
  if (attachmentMatch && method === 'GET') {
    const resp = await repo.proxyAttachment(env, decodeURIComponent(attachmentMatch[1]), {
      forceDownload: url.searchParams.get('dl') === '1',
    });
    if (!resp) return json({ error: '附件不存在' }, 404);
    return resp;
  }

  // Inbound alerts dashboard: CF inbound mail that was "received but not parsed into the inbox" (the raw message is still safely stored in R2).
  // This is the antidote to "nothing in the backend logs and the user has no way to know" — explicitly expose mail that did not make it into the inbox.
  if (path === '/api/inbound/alerts' && method === 'GET') {
    const alerts = await repo.listInboundAlerts(env);
    return json({ alerts, count: alerts.length });
  }

  // Manually replay one inbound alert
  const inboundRetryMatch = /^\/api\/inbound\/alerts\/([^/]+)\/retry$/.exec(path);
  if (inboundRetryMatch && method === 'POST') {
    const ok = await repo.retryInbound(env, decodeURIComponent(inboundRetryMatch[1]));
    return ok ? json({ ok: true }) : json({ error: '未找到该入站记录' }, 404);
  }

  // Download the raw .eml of an inbound alert (manual fallback for when it is not in the inbox)
  const inboundRawMatch = /^\/api\/inbound\/alerts\/([^/]+)\/raw$/.exec(path);
  if (inboundRawMatch && method === 'GET') {
    const resp = await repo.proxyInboundRaw(env, decodeURIComponent(inboundRawMatch[1]));
    return resp || json({ error: '原始邮件不存在' }, 404);
  }

  return json({ error: 'Not Found' }, 404);
}

/* ---------------- Draft helpers ---------------- */

/** Draft row → frontend shape (recipients split into arrays, rich to boolean, missing fields filled with empty strings). */
function draftJson(d: repo.DraftRow) {
  return {
    id: d.id,
    mailbox: d.mailbox,
    mode: d.mode,
    source_id: d.source_id,
    to: jsonArr(d.to_emails),
    cc: jsonArr(d.cc),
    bcc: jsonArr(d.bcc),
    subject: d.subject || '',
    body_html: d.body_html || '',
    body_text: d.body_text || '',
    rich: d.rich === 1,
    updated_at: d.updated_at,
  };
}

/**
 * Parse the autosave request body.
 *
 * Recipients always go through the **same-source splitting** of `normalizeRecipients` (comma / semicolon / whitespace),
 * ensuring the "recipients stored in the draft" and the "recipients actually sent out" match exactly —
 * two different conventions would let a user see 3 recipients in a draft but only 2 get sent.
 */
function parseDraftInput(id: string, body: unknown): repo.DraftInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const { to, cc, bcc } = normalizeRecipients(parseRecipient(b.to), parseRecipient(b.cc), parseRecipient(b.bcc));
  const mode = b.mode === 'reply' || b.mode === 'forward' ? b.mode : 'new';
  return {
    id,
    mailbox: typeof b.mailbox === 'string' ? b.mailbox.trim().toLowerCase() : '',
    mode,
    sourceId: typeof b.source_id === 'string' && b.source_id ? b.source_id : null,
    to,
    cc,
    bcc,
    subject: typeof b.subject === 'string' ? b.subject : '',
    html: typeof b.html === 'string' ? b.html : '',
    text: typeof b.body === 'string' ? b.body : '',
    rich: b.rich === true,
  };
}

/** Discard the corresponding draft after a successful send. Failure does **not affect** the send result (at worst one extra draft lingers, which the user can delete manually). */
/**
 * The `domain` query parameter, keeping the difference that matters to the UI:
 *   · absent            -> undefined = every domain (plain API usage)
 *   · present but empty -> \`\`         = nothing ticked = match nothing (the top-bar filter with no tick)
 *   · "a.com,b.com"     -> both domains
 */
function readDomainParam(url: URL): string | undefined {
  const raw = url.searchParams.get('domain');
  return raw === null ? undefined : raw;
}

async function dropDraft(env: Env, draftId: string | undefined | null): Promise<void> {
  if (!draftId) return;
  try {
    await repo.deleteDraft(env, draftId);
  } catch (err) {
    console.error('deleteDraft failed:', err);
  }
}

function clampInt(raw: string | null, def: number, max: number): number {
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(Math.floor(n), max);
}

async function getMessageDetail(env: Env, id: string): Promise<Response> {
  const message = await repo.getMessage(env, id);
  if (!message) return json({ error: '邮件不存在' }, 404);

  if (message.direction === 'inbound' && message.read === 0) {
    await repo.markRead(env, id);
    message.read = 1;
  }

  // Attachments and thread context do not depend on each other, so fetch them in parallel (one fewer serial D1 round trip); markRead must complete before returning, so it stays serial above.
  const noThread: Awaited<ReturnType<typeof repo.listThread>> = [];
  const [attachmentsRaw, threadRaw] = await Promise.all([
    repo.listAttachments(env, id),
    message.thread_id ? repo.listThread(env, message.thread_id) : Promise.resolve(noThread),
  ]);

  const attachments = attachmentsRaw.map((a) => ({
    id: a.id,
    message_id: a.message_id,
    filename: a.filename,
    content_type: a.content_type,
    size: a.size,
    inline: a.inline === 1,
    content_id: a.content_id,
    url: `/api/attachments/${a.id}`,
  }));

  // Thread context (within the same thread_id, **descending: most recent first**; loopback copies are already folded by listThread)
  const thread: Array<Record<string, unknown>> = threadRaw.map((t) => ({
    id: t.id,
    direction: t.direction,
    mailbox: t.mailbox,
    from_name: t.from_name,
    from_email: t.from_email,
    to: jsonArr(t.to_emails),
    subject: t.subject,
    preview: t.preview,
    received_at: t.received_at,
    read: t.read === 1,
    deleted: t.deleted === 1,
    // Other record ids of the same physical message (the folded-away loopback copies). The frontend uses this to treat "the copy currently open"
    // as the current row too; `current` is also computed correctly here to avoid two different conventions drifting apart.
    copy_ids: t.copy_ids ?? [],
    current: t.id === id || (t.copy_ids ?? []).includes(id),
  }));

  const { to_emails, delivered_to, cc, bcc, reply_to, ...rest } = message;
  return json({
    message: {
      ...rest,
      id,
      to_emails: jsonArr(to_emails),
      // Inbound: delivery address (envelope recipient). Historical rows are null — the frontend uses that to detect "stored before the fix",
      // and when showing recipients subtracts cc/bcc from the delivery address so it does not label itself as a recipient.
      delivered_to: delivered_to ? jsonArr(delivered_to) : null,
      cc: jsonArr(cc),
      bcc: jsonArr(bcc),
      reply_to: jsonArr(reply_to),
    },
    attachments,
    thread,
  });
}

/** Dedupe recipients case-insensitively (keeping the first original spelling), trimming and dropping empties along the way. */
function dedupeRecipients(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const addr = raw.trim();
    const key = addr.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

/**
 * Split a multi-recipient string: comma / semicolon (including the full-width Chinese forms) / whitespace are all separators,
 * each segment is trimmed then emptied, then deduped case-insensitively. Same convention as the frontend parseRecipients.
 */
function splitRecipients(raw: string): string[] {
  return dedupeRecipients(raw.split(/[,;，；\s]+/));
}

function parseRecipient(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const r of raw) {
      if (typeof r === 'string') out.push(r.trim());
      else if (r && typeof r === 'object') {
        const o = r as Record<string, unknown>;
        if (typeof o.email === 'string') out.push(o.email.trim());
      }
    }
    return out.filter(Boolean);
  }
  if (typeof raw === 'string') return splitRecipients(raw);
  return [];
}

/**
 * Normalize the to / cc / bcc recipient groups:
 * - **to kept as-is** (order and duplicates untouched) — this is the existing behavior locked by B13, and changing it would turn the old assertions red;
 * - cc / bcc deduped, and addresses already present in a higher-priority group removed (to > cc > bcc).
 *
 * Removing duplicates is required: when the same address appears in both to and cc, Resend delivers the same message twice,
 * and the recipient receives two identical emails.
 */
function normalizeRecipients(
  to: string[],
  cc: string[],
  bcc: string[]
): { to: string[]; cc: string[]; bcc: string[] } {
  const toClean = to.filter((x) => x.trim());
  const taken = new Set(toClean.map((x) => x.trim().toLowerCase()));
  const ccClean = dedupeRecipients(cc).filter((x) => !taken.has(x.toLowerCase()));
  for (const x of ccClean) taken.add(x.toLowerCase());
  const bccClean = dedupeRecipients(bcc).filter((x) => !taken.has(x.toLowerCase()));
  return { to: toClean, cc: ccClean, bcc: bccClean };
}

/** base64 length -> raw byte count (only for the rough pre-check of "does the total size exceed the limit", without decoding). */
function approxBase64Bytes(b64: string): number {
  const n = b64.replace(/\s+/g, '').length;
  return Math.floor((n * 3) / 4);
}

const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024; // Align with the Resend attachment limit
/**
 * Subrequests each recipient consumes in a merge send:
 *   1 Resend fetch + 1 D1 .run() (saveOutbound)
 *   + 1 R2 put per attachment + 1 D1 .batch() when there are attachments (writing attachment metadata).
 *
 * ⚠️ Cloudflare's subrequest accounting **includes calls to R2 / D1**, not just fetch.
 * This assumes `DB.batch()` counts as 1 subrequest (a single transactional round trip).
 */
function perRecipientSubrequests(attachmentCount: number): number {
  return 2 + attachmentCount + (attachmentCount > 0 ? 1 : 0);
}

/** Absolute cap: a fallback for serial sending, preventing an over-large budget from making a single request take too long. */
const MAX_MERGE_RECIPIENTS = 200;

/**
 * Maximum recipients per merge send (computed dynamically from the attachment count).
 * The default budget is 45 (Free tier's 50 subrequests with 5 to spare). Hitting the cap throws mid-loop → some emails are already sent and
 * a user retry may duplicate delivery, so headroom is required; do not use right up to 50.
 * Paid tiers can raise MERGE_SUBREQ_BUDGET in wrangler.toml.
 */
function mergeRecipientCap(env: Env, attachmentCount: number): number {
  const budget = clampInt(env.MERGE_SUBREQ_BUDGET ?? null, 45, 10000);
  const cost = perRecipientSubrequests(attachmentCount);
  return Math.max(1, Math.min(MAX_MERGE_RECIPIENTS, Math.floor(budget / cost)));
}

function parseAttachments(raw: unknown): ResendAttachment[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out: ResendAttachment[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') return null;
    const o = it as Record<string, unknown>;
    if (typeof o.filename !== 'string' || typeof o.content !== 'string') return null;
    if (o.content_type != null && typeof o.content_type !== 'string') return null;
    out.push({ filename: o.filename, content: o.content, content_type: o.content_type || undefined });
  }
  return out;
}

function safeFilename(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/[^A-Za-z0-9._()+\- ]/g, '_').slice(0, 120) || 'attachment';
  return base;
}

/** Sent attachments: base64 -> R2 + attachments rows (for reviewing/downloading in "Sent"). */
async function storeOutboundAttachments(env: Env, messageId: string, files: ResendAttachment[]): Promise<void> {
  const rows: Array<{ filename: string; contentType: string; size: number; r2Key: string }> = [];
  for (const f of files) {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(f.content);
    } catch {
      continue;
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) continue;
    const r2Key = `attachments/${messageId}/${uuid()}-${safeFilename(f.filename)}`;
    await env.BUCKET.put(r2Key, bytes, {
      httpMetadata: { contentType: f.content_type || 'application/octet-stream' },
    });
    rows.push({ filename: f.filename || 'attachment', contentType: f.content_type || 'application/octet-stream', size: bytes.length, r2Key });
  }
  if (rows.length) {
    await repo.insertOutboundAttachments(env, messageId, rows);
  }
}

/** Unified compose/reply body: body plain text + optional html (rich text), each falling back to the other. */
function bodyFrom(b: { body?: unknown; html?: unknown }): { text: string; html: string } {
  const text = typeof b.body === 'string' ? b.body : '';
  const rawHtml = typeof b.html === 'string' ? b.html : '';
  if (rawHtml) {
    const fallbackText = text || stripHtml(rawHtml);
    return { text: fallbackText, html: rawHtml };
  }
  return { text, html: textToHtml(text) };
}

/**
 * Decide the sender: prefer the requested mailbox, but only use it when its domain belongs to a verified sending domain.
 * Also returns the **display name actually used** for the outbound DB row (`from_name`) —
 * otherwise every account's sent mail in the inbox would show the global `SEND_FROM_NAME`.
 */
function resolveSender(
  env: Env,
  mailboxCandidate?: string
): { from: string; mailbox: string; fromName: string | null } {
  const identity = senderIdentity(env, mailboxCandidate || '');
  const mailbox = identity.address || (env.SEND_FROM_ADDRESS || '').trim().toLowerCase();
  return { from: identity.from, mailbox, fromName: identity.name || null };
}

interface MergeInput {
  recipients: string[];
  cc: string[];
  subject: string;
  content: { text: string; html: string };
  attachments: ResendAttachment[];
  sender: { from: string; mailbox: string; fromName: string | null };
  /** Draft id to discard after all sends succeed. */
  draftId?: string;
}

/**
 * Merge send: serially send a separate email to each recipient (body/subject/attachments identical),
 * storing an independent outbound record per person (independent thread), with a single failure not interrupting the rest.
 *
 * Always return HTTP 200: partial success is neither all-right nor all-wrong, so the frontend uses the `failed` detail to "resend only the failures".
 * `ok` means "did **all** succeed" (`failed.length === 0`); partial success or total failure is both `false`,
 * but the status code is always 200, so the caller must look at the `sent`/`failed` detail.
 */
async function composeMerge(env: Env, input: MergeInput): Promise<Response> {
  const sent: Array<{ to: string; id: string; resend_id: string }> = [];
  const failed: Array<{ to: string; error: string }> = [];

  for (const addr of input.recipients) {
    let resendId: string;
    try {
      const result = await resendSend(env, {
        from: input.sender.from,
        to: [addr],
        cc: input.cc,
        subject: input.subject,
        text: input.content.text,
        html: input.content.html,
        attachments: input.attachments,
      });
      if (!result.ok) {
        failed.push({ to: addr, error: result.error || '发送失败' });
        continue;
      }
      resendId = result.id!;
    } catch (err) {
      failed.push({ to: addr, error: `发送失败: ${String(err)}` });
      continue;
    }

    // The email has already been delivered: a DB write failure must not count as "not sent", otherwise a user retry would duplicate delivery
    let rowId = '';
    try {
      rowId = await repo.saveOutbound(env, {
        inReplyTo: null,
        references: null,
        threadId: uuid(), // independent thread per person
        mailbox: input.sender.mailbox,
        fromName: input.sender.fromName,
        fromEmail: input.sender.mailbox,
        to: [addr],
        cc: input.cc,
        subject: input.subject,
        html: input.content.html,
        text: input.content.text,
        resendId,
        receivedAt: nowSec(),
      });
      await storeOutboundAttachments(env, rowId, input.attachments).catch((err) => {
        console.error('storeOutboundAttachments failed:', err);
      });
    } catch (err) {
      console.error('merge saveOutbound failed:', err);
    }
    sent.push({ to: addr, id: rowId, resend_id: resendId });
  }

  // Discard the draft only when **all succeeded**: keep it on partial success, so the user can resend the failed ones from the drafts folder
  // (deleting the draft without sending everything would lose the content).
  if (failed.length === 0) await dropDraft(env, input.draftId);

  return json({
    ok: failed.length === 0,
    merge: true,
    total: input.recipients.length,
    sent_count: sent.length,
    failed_count: failed.length,
    sent,
    failed,
  });
}

async function compose(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown; body?: unknown; html?: unknown; mailbox?: unknown; attachments?: unknown; merge?: unknown; draft_id?: unknown }
    | null;
  if (!body) return json({ error: '参数错误' }, 400);

  const { to, cc, bcc } = normalizeRecipients(
    parseRecipient(body.to),
    parseRecipient(body.cc),
    parseRecipient(body.bcc)
  );
  // Any one of to / cc / bcc non-empty is enough (a BCC-only email is legal)
  if (!to.length && !cc.length && !bcc.length) return json({ error: '缺少收件人' }, 400);
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const content = bodyFrom(body);
  const attachments = parseAttachments(body.attachments);
  if (attachments === null) return json({ error: '附件格式错误' }, 400);

  const sender = resolveSender(env, typeof body.mailbox === 'string' ? body.mailbox : undefined);
  // Draft to discard after a successful send (the id the frontend uses for autosave)
  const draftId = typeof body.draft_id === 'string' ? body.draft_id : '';

  // Merge send: send a separate email to each recipient (content and subject unchanged)
  if (body.merge === true) {
    // Merge send means "send one separately to each person", while BCC makes the BCC'd person receive N duplicate emails.
    // The two semantics conflict → explicitly reject, rather than silently ignoring bcc (the user would think BCC took effect).
    if (bcc.length) return json({ error: '合并发送不支持密送（BCC），请取消其中一个' }, 400);
    const recipients = dedupeRecipients(to);
    if (!recipients.length) return json({ error: '缺少收件人' }, 400);
    const cap = mergeRecipientCap(env, attachments.length);
    if (recipients.length > cap) {
      const why = attachments.length > 0 ? `（当前 ${attachments.length} 个附件）` : '';
      return json({ error: `单次合并发送最多 ${cap} 位收件人${why}` }, 400);
    }
    return composeMerge(env, { recipients, cc, subject, content, attachments, sender, draftId });
  }

  const result = await resendSend(env, {
    from: sender.from,
    to,
    cc,
    bcc,
    subject,
    text: content.text,
    html: content.html,
    attachments,
  });
  if (!result.ok) return json({ error: result.error }, 400);

  const rowId = await repo.saveOutbound(env, {
    inReplyTo: null,
    references: null,
    threadId: uuid(), // independent thread
    mailbox: sender.mailbox,
    fromName: sender.fromName,
    fromEmail: sender.mailbox,
    to,
    cc,
    bcc,
    subject,
    html: content.html,
    text: content.text,
    resendId: result.id!,
    receivedAt: nowSec(),
  });

  await storeOutboundAttachments(env, rowId, attachments).catch((err) => {
    console.error('storeOutboundAttachments failed:', err);
  });
  await dropDraft(env, draftId);

  return json({ ok: true, id: rowId, resend_id: result.id });
}

async function reply(env: Env, request: Request, id: string): Promise<Response> {
  const original = await repo.getMessage(env, id);
  if (!original) return json({ error: '原邮件不存在' }, 404);
  if (original.direction !== 'inbound') {
    return json({ error: '只能回复收到的邮件' }, 400);
  }

  const raw = (await request.json().catch(() => null)) as
    | { to?: unknown; cc?: unknown; bcc?: unknown; body?: unknown; html?: unknown; attachments?: unknown; mailbox?: unknown; draft_id?: unknown }
    | null;
  const content = bodyFrom(raw || {});
  if (!content.text.trim() && !content.html.trim()) return json({ error: '回复内容为空' }, 400);

  const replyTo = parseAddressList(original.reply_to)[0] ?? parseAddress(original.from_email);
  if (!replyTo) return json({ error: '原邮件缺少发件地址' }, 400);

  // ⚠️ It once unconditionally used to: [replyTo.email] → recipients the user added in the reply box (comma-separated) were **discarded entirely**:
  // the new people did not get the mail, and the sent record kept only the original sender.
  // Now the request body's to takes precedence (the frontend reply box pre-fills the original sender, which the user can append to/edit);
  // only when the request body provides no to at all (old clients / direct API calls) does it fall back to the single address derived from the original mail.
  const requestedTo = dedupeRecipients(parseRecipient(raw?.to));
  // cc / bcc are filled in by the user (no automatic "reply all"); normalization removes addresses duplicated with to to avoid duplicate delivery.
  const { to, cc, bcc } = normalizeRecipients(
    requestedTo.length ? requestedTo : [replyTo.email],
    parseRecipient(raw?.cc),
    parseRecipient(raw?.bcc)
  );

  const attachments = parseAttachments(raw?.attachments);
  if (attachments === null) return json({ error: '附件格式错误' }, 400);

  const origMessageId = original.message_id || original.id;
  // References chain = the original mail's References + the original mail's Message-ID (deduped).
  // ⚠️ The original mail's references column stores the **JSON array text** Resend gave (see util.parseReferences);
  // the old implementation spliced it whole into the header and sent it back to Resend, causing the escaping level to nest each round (production measured up to four levels),
  // and thread_id drifted every round accordingly — it must be parsed into a canonical `<id>` list before joining.
  const refChain = parseReferences(original.references);
  const seenRefs = new Set(refChain.map((x) => stripAngle(x)));
  if (origMessageId && !seenRefs.has(origMessageId)) refChain.push(`<${origMessageId}>`);
  const newReferences = refChain.join(' ');

  const subject = replySubject(original.subject);
  // Sender: prefer the user's choice in the "From" dropdown (exactly the same convention as compose),
  // and only fall back to "the mailbox that received the original mail" when unspecified.
  // ⚠️ It once unconditionally used original.mailbox → changing the sender when replying had no effect at all; it still sent from the original mail's recipient mailbox.
  // Domain validation is covered by senderFromMailbox (non-default domains fall back to the default sender); no extra whitelist is done here.
  const requestedMailbox = typeof raw?.mailbox === 'string' ? raw.mailbox.trim() : '';
  const sender = resolveSender(env, requestedMailbox || original.mailbox || undefined);

  const result = await resendSend(env, {
    from: sender.from,
    to,
    cc,
    bcc,
    subject,
    text: content.text,
    html: content.html,
    attachments,
    headers: {
      'In-Reply-To': `<${origMessageId}>`,
      References: newReferences || `<${origMessageId}>`,
    },
  });
  if (!result.ok) return json({ error: result.error }, 400);

  // Thread ownership: **prefer inheriting the original mail's (clean) thread_id**.
  // Deriving from References alone is not enough — if the other client sends only In-Reply-To and not References,
  // the derived root degenerates to "the original mail's message_id", so a new thread is opened each round trip,
  // showing "several back-and-forths but only two messages". Only fall back to derivation when the original thread_id is malformed (historical data).
  const derivedThread = rootThreadId({
    references: newReferences,
    inReplyTo: origMessageId,
    messageId: origMessageId,
    fallback: original.thread_id ?? uuid(),
  });
  const threadId = isSaneThreadId(original.thread_id) ? String(original.thread_id) : derivedThread;

  const rowId = await repo.saveOutbound(env, {
    inReplyTo: origMessageId,
    references: newReferences || null,
    threadId,
    mailbox: sender.mailbox,
    fromName: sender.fromName,
    fromEmail: sender.mailbox,
    to,
    cc,
    bcc,
    subject,
    html: content.html,
    text: content.text,
    resendId: result.id!,
    receivedAt: nowSec(),
  });

  await storeOutboundAttachments(env, rowId, attachments).catch((err) => {
    console.error('storeOutboundAttachments failed:', err);
  });
  await dropDraft(env, typeof raw?.draft_id === 'string' ? raw.draft_id : '');

  return json({ ok: true, id: rowId, resend_id: result.id, original_id: original.id });
}

/** Total size limit for the original mail's attachments when forwarding (aligns with Resend's 40 MB per message). */
const MAX_FORWARD_TOTAL_BYTES = 40 * 1024 * 1024;

/** Copy the source mail's attachments under the target message (new R2 keys), for forwarding. */
async function copyAttachmentsToMessage(
  env: Env,
  messageId: string,
  source: Array<{ r2_key: string; filename: string; content_type: string }>
): Promise<void> {
  const rows: Array<{ filename: string; contentType: string; size: number; r2Key: string }> = [];
  for (const a of source) {
    const obj = await env.BUCKET.get(a.r2_key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const r2Key = `attachments/${messageId}/${uuid()}-${safeFilename(a.filename)}`;
    await env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: a.content_type } });
    rows.push({ filename: a.filename, contentType: a.content_type, size: bytes.length, r2Key });
  }
  if (rows.length) await repo.insertOutboundAttachments(env, messageId, rows);
}

/**
 * Forward: a message in **any direction** can be forwarded to any recipient (unlike reply, which only handles received mail).
 *
 * Key semantics:
 * - the subject gets a `Fwd:` prefix (not stacked again if already present);
 * - `In-Reply-To` / `References` are **not set** — forwarding is a **new thread**, and including them would string it into the original thread;
 * - the original mail's attachments are read by the **server** from R2, sent with the mail, and copied to new R2 keys for storage
 *   (keys cannot be shared: `permanentDelete` deletes R2 objects, so sharing would make "delete the original mail" also delete the forwarded mail's attachments);
 * - inline images (cid) are not forwarded: the body reference goes as plain text, and carrying them over would just become a pile of unreferenced image attachments;
 * - when an attachment cannot be read / the total exceeds the limit, **do not stay silent**: the former is skipped and listed in the response as `skipped_attachments`,
 *   the latter returns 400 with the reason (better to let the user delete attachments themselves than to send a mail missing half its attachments).
 */
async function forward(env: Env, request: Request, id: string): Promise<Response> {
  const original = await repo.getMessage(env, id);
  if (!original) return json({ error: '原邮件不存在' }, 404);

  const raw = (await request.json().catch(() => null)) as
    | {
        to?: unknown;
        cc?: unknown;
        bcc?: unknown;
        body?: unknown;
        html?: unknown;
        attachments?: unknown;
        mailbox?: unknown;
        include_original_attachments?: unknown;
        draft_id?: unknown;
      }
    | null;

  const { to, cc, bcc } = normalizeRecipients(
    parseRecipient(raw?.to),
    parseRecipient(raw?.cc),
    parseRecipient(raw?.bcc)
  );
  if (!to.length && !cc.length && !bcc.length) return json({ error: '缺少收件人' }, 400);

  const content = bodyFrom(raw || {});
  if (!content.text.trim() && !content.html.trim()) return json({ error: '转发内容为空' }, 400);

  const extra = parseAttachments(raw?.attachments);
  if (extra === null) return json({ error: '附件格式错误' }, 400);

  const includeOriginal = raw?.include_original_attachments !== false;
  const requestedMailbox = typeof raw?.mailbox === 'string' ? raw.mailbox.trim() : '';
  const sender = resolveSender(env, requestedMailbox || original.mailbox || undefined);

  // Read the original attachments: inline images (cid) are skipped; a single unreadable one is skipped too, but **recorded to inform the user**
  const sourceRows = includeOriginal
    ? (await repo.listAttachments(env, id)).filter((a) => a.inline !== 1)
    : [];
  let totalBytes = extra.reduce((n, f) => n + approxBase64Bytes(f.content), 0);
  const originalFiles: ResendAttachment[] = [];
  const skipped: string[] = [];
  for (const a of sourceRows) {
    const obj = await env.BUCKET.get(a.r2_key);
    if (!obj) {
      skipped.push(a.filename);
      continue;
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    totalBytes += bytes.length;
    if (totalBytes > MAX_FORWARD_TOTAL_BYTES) {
      return json(
        { error: `附件合计超过 ${Math.floor(MAX_FORWARD_TOTAL_BYTES / 1024 / 1024)} MB，无法转发（可先删除部分附件）` },
        400
      );
    }
    originalFiles.push({ filename: a.filename, content: bytesToBase64(bytes), content_type: a.content_type });
  }

  const subject = forwardSubject(original.subject);
  const result = await resendSend(env, {
    from: sender.from,
    to,
    cc,
    bcc,
    subject,
    text: content.text,
    html: content.html,
    attachments: [...originalFiles, ...extra],
  });
  if (!result.ok) return json({ error: result.error }, 400);

  const rowId = await repo.saveOutbound(env, {
    inReplyTo: null,
    references: null,
    threadId: uuid(), // forward opens a new thread
    mailbox: sender.mailbox,
    fromName: sender.fromName,
    fromEmail: sender.mailbox,
    to,
    cc,
    bcc,
    subject,
    html: content.html,
    text: content.text,
    resendId: result.id!,
    receivedAt: nowSec(),
  });

  // The email has already been delivered: a failed attachment store must not be treated as "not sent" (otherwise a user retry would duplicate delivery)
  await storeOutboundAttachments(env, rowId, extra).catch((err) => {
    console.error('forward: storeOutboundAttachments failed:', err);
  });
  await copyAttachmentsToMessage(env, rowId, sourceRows).catch((err) => {
    console.error('forward: copyAttachmentsToMessage failed:', err);
  });
  await dropDraft(env, typeof raw?.draft_id === 'string' ? raw.draft_id : '');

  return json({
    ok: true,
    id: rowId,
    resend_id: result.id,
    original_id: original.id,
    forwarded_attachments: originalFiles.length,
    skipped_attachments: skipped,
  });
}
