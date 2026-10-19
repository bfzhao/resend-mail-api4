import type { AttachmentRow, Env, Folder, InboundRawRow, MessageRow } from './types';
import { nowSec, uuid, contentDisposition, jsonArr, domainOf } from './util';

export interface PreparedAttachment {
  filename: string;
  contentType: string;
  size: number;
  inline: number;
  contentId: string | null;
  r2Key: string;
}

export interface InboundInput {
  rowId: string;
  resendId: string;                          // Resend's email_id (inbound idempotency/dedup)
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  threadId: string;
  mailbox: string;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  /** The **delivery address (envelope recipient)** of an inbound mail; null for outbound. See migrations/004_delivered_to.sql. */
  deliveredTo?: string[] | null;
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  receivedAt: number;
  attachments: PreparedAttachment[];
}

export interface OutboundInput {
  messageId?: string | null;
  inReplyTo: string | null;
  references: string | null;
  threadId: string;
  mailbox: string;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  cc: string[];
  /** BCC. Optional: treated as an empty array when older callers (and tests) do not pass it. */
  bcc?: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  resendId: string;
  receivedAt: number;
}

const LIST_LIMIT = 50;
const LIST_MAX = 200;

/**
 * Rows with an empty-string or NULL mailbox fall into this explicit group on the "receiving address" dimension.
 * It must stay consistent with UNKNOWN_MAILBOX in the frontend public/app.js.
 * This way mailboxes() covers all rows, guaranteeing "all mailboxes" count = the sum of each group's count.
 */
export const UNKNOWN_MAILBOX = '(未识别)';

export interface ListOpts {
  folder: Folder;
  q?: string | null;
  unread?: boolean;
  mailbox?: string;
  /** Restrict to one domain (top-bar switcher); matches the derived `mailbox_domain` column. */
  domain?: string;
  limit: number;
  offset: number;
}

export interface FolderRow {
  id: string;
  direction: string;
  /** The receiving mailbox this row belongs to; the frontend relies on it to show "received to …" when optimistically rendering the envelope card, so it must be returned with the list. */
  mailbox: string | null;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  to_emails: string;
  preview: string | null;
  received_at: number;
  read: number;
  starred: number;
  status: string;
  attachments_count: number;
  /** Number of messages in the same thread; 1 means a standalone message. */
  thread_count: number;
  /** Number of unread messages in the same thread; the list row should be marked unread when > 0. */
  thread_unread: number;
}

/** mailbox filter condition: empty/NULL groups match via a sentinel value, the rest match exactly (consistent with mailboxes()). */
function mailboxCond(mailbox: string): { sql: string; params: unknown[] } {
  if (mailbox === UNKNOWN_MAILBOX) return { sql: "(mailbox IS NULL OR mailbox = '')", params: [] };
  return { sql: 'mailbox = ?', params: [mailbox] };
}

/**
 * domain filter condition: matches the derived `mailbox_domain` column (lowercased). Applies to messages and drafts alike.
 * Accepts one domain or a **comma-separated list** (the top-bar domain filter is multi-select; an empty selection = all).
 */
/**
 * The domain filter as SQL. `undefined` = no filter at all (every domain), while an **empty list** (the caller passed
 * `''`, i.e. "no domain ticked in the UI") matches **no rows**: ticking nothing must show nothing, not everything.
 */
function domainCond(domain: string): { sql: string; params: unknown[] } {
  const list = String(domain)
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return { sql: '0 = 1', params: [] };
  if (list.length === 1) return { sql: 'mailbox_domain = ?', params: list };
  return { sql: `mailbox_domain IN (${list.map(() => '?').join(',')})`, params: list };
}

/** The DB row params assembled after uploading stored attachments to R2 are already included in attachments[]. */
function whereForFolder(
  folder: Folder,
  q: string | null | undefined,
  unread: boolean,
  mailbox?: string,
  domain?: string
): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  switch (folder) {
    case 'inbox':
      conds.push("direction = 'inbound'", 'deleted = 0');
      if (unread) conds.push('read = 0');
      break;
    case 'sent':
      conds.push("direction = 'outbound'", 'deleted = 0');
      break;
    case 'starred':
      conds.push('starred = 1', 'deleted = 0');
      break;
    case 'trash':
      conds.push('deleted = 1');
      break;
  }
  if (mailbox) {
    const c = mailboxCond(mailbox);
    conds.push(c.sql);
    params.push(...c.params);
  }
  // `''` (explicitly "no domain selected") must be applied too — see domainCond.
  if (domain !== undefined && domain !== null) {
    const c = domainCond(domain);
    conds.push(c.sql);
    params.push(...c.params);
  }
  if (q) {
    const like = `%${q}%`;
    conds.push('(subject LIKE ? OR from_name LIKE ? OR from_email LIKE ? OR body_text LIKE ? OR to_emails LIKE ?)');
    params.push(like, like, like, like, like);
  }
  return { sql: conds.join(' AND '), params };
}

const LIST_SELECT = `SELECT
    m.id, m.direction, m.mailbox, m.from_name, m.from_email, m.subject, m.to_emails,
    substr(coalesce(NULLIF(m.body_text, ''), ''), 1, 200) AS preview,
    m.received_at, m.read, m.starred, m.status,
    (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachments_count
  FROM messages m`;

/**
 * Correct a list row's `thread_count` so it matches the thread panel convention in the reading view.
 *
 * The list's `thread_count` is the SQL window `COUNT(*)` (**raw row count**), whereas the thread panel
 * (listThread → foldLoopbackCopies) folds away "loopback copies of the same physical message".
 * Without correction you get the user-reported bug "badge shows 3 on the left, but only 2 open".
 *
 * A single-message thread (thread_count = 1) cannot contain a loopback copy, so skip it; only run an extra query for multi-message
 * threads on the page, fetching all rows of each thread, then folding with the **same** foldLoopbackCopies and backfilling the message count.
 * (Loopback copy determination keeps a single source of truth with the panel, not another parallel logic written in SQL.)
 */
async function applyFoldedThreadCounts(env: Env, items: FolderRow[]): Promise<void> {
  const ids = items.filter((it) => (it.thread_count || 1) > 1).map((it) => it.id);
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  const rows = (
    await env.DB.prepare(
      `SELECT id, direction, mailbox, from_name, from_email, to_emails, cc, bcc, subject,
              substr(coalesce(NULLIF(body_text, ''), ''), 1, 160) AS preview,
              received_at, read, deleted,
              COALESCE(NULLIF(thread_id, ''), id) AS pk
       FROM messages
       WHERE COALESCE(NULLIF(thread_id, ''), id) IN (
         SELECT COALESCE(NULLIF(thread_id, ''), id) FROM messages WHERE id IN (${ph})
       )`
    )
      .bind(...ids)
      .all<ThreadRow & { pk: string }>()
  ).results;

  // Row id → thread primary key; thread primary key → all rows of that thread (folding is decided only on row attributes, not order).
  const pkOf = new Map<string, string>();
  const byPk = new Map<string, ThreadRow[]>();
  for (const r of rows) {
    pkOf.set(r.id, r.pk);
    const g = byPk.get(r.pk);
    if (g) g.push(r);
    else byPk.set(r.pk, [r]);
  }
  for (const it of items) {
    if ((it.thread_count || 1) <= 1) continue;
    const pk = pkOf.get(it.id);
    const group = pk ? byPk.get(pk) : undefined;
    if (group) it.thread_count = foldLoopbackCopies(group).length;
  }
}

export async function listFolder(env: Env, opts: ListOpts): Promise<{ items: FolderRow[]; total: number }> {
  // unread is not handled in whereForFolder, but filtered by the thread_unread computed by an outer window function,
  // so "unread only" shows "the latest message of the whole thread containing unread mail", not just that unread message itself.
  const w = whereForFolder(opts.folder, opts.q, false, opts.mailbox, opts.domain);
  const whereSql = w.sql ? `WHERE ${w.sql}` : '';
  const unreadCond = opts.unread === true ? 'AND thread_unread > 0' : '';

  // The **Sent** folder is not collapsed by thread: it is a chronological log of what you sent, and grouping there hid
  // individual messages behind a thread row (user-requested). Every other folder keeps the conversation grouping.
  const grouped = opts.folder !== 'sent';
  const outerKey = grouped ? "COALESCE(NULLIF(m.thread_id, ''), m.id)" : 'm.id';
  const innerKey = grouped ? "COALESCE(NULLIF(thread_id, ''), id)" : 'id';

  const items = (
    await env.DB.prepare(
      `WITH folder_threads AS (
         SELECT DISTINCT ${innerKey} AS pk
         FROM messages m
         ${whereSql}
       ),
       ranked AS (
         SELECT
           m.id, m.direction, m.mailbox, m.from_name, m.from_email, m.subject, m.to_emails,
           substr(coalesce(NULLIF(m.body_text, ''), ''), 1, 200) AS preview,
           m.received_at, m.read, m.starred, m.status,
           (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachments_count,
           ROW_NUMBER() OVER (
             PARTITION BY ${outerKey}
             ORDER BY m.received_at DESC, m.id DESC
           ) AS rn,
           COUNT(*) OVER (PARTITION BY ${outerKey}) AS thread_count,
           SUM(CASE WHEN m.read = 0 THEN 1 ELSE 0 END) OVER (PARTITION BY ${outerKey}) AS thread_unread
         FROM messages m
         WHERE ${outerKey} IN (SELECT pk FROM folder_threads)
       )
       SELECT
         id, direction, mailbox, from_name, from_email, subject, to_emails,
         preview, received_at, read, starred, status, attachments_count,
         thread_count, thread_unread
       FROM ranked
       WHERE rn = 1 ${unreadCond}
       ORDER BY received_at DESC, id DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...w.params, opts.limit, opts.offset)
      .all<FolderRow>()
  ).results;

  const totalSql =
    opts.unread === true
      ? `SELECT COUNT(*) AS n FROM (
           SELECT ${innerKey} AS pk,
                  SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS thread_unread
           FROM messages m
           WHERE ${outerKey} IN (
             SELECT DISTINCT ${innerKey} FROM messages m2 ${whereSql}
           )
           GROUP BY pk
           HAVING thread_unread > 0
         )`
      : `SELECT COUNT(DISTINCT ${outerKey}) AS n FROM messages m WHERE ${outerKey} IN (SELECT DISTINCT ${innerKey} FROM messages m2 ${whereSql})`;

  const totalRow = (
    await env.DB.prepare(totalSql).bind(...w.params).first<{ n: number }>()
  )?.n ?? 0;

  // The badge count is aligned with the thread panel (fold loopback copies). See applyFoldedThreadCounts.
  await applyFoldedThreadCounts(env, items);

  return { items, total: totalRow };
}

/* ---------------- Drafts ----------------
 * Drafts live in a separate drafts table (reason in the table creation comment in schema.sql):
 * they have no delivery semantics (no message_id / thread_id / status / resend_id),
 * and mixing them into messages would force every folder query to carry an extra "exclude drafts" condition.
 */

/** A row of the drafts table. */
export interface DraftRow {
  id: string;
  mailbox: string;
  mode: string;
  source_id: string | null;
  to_emails: string;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  rich: number;
  updated_at: number;
  created_at: number;
}

export interface DraftInput {
  id: string;
  mailbox: string;
  mode: string;
  sourceId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  rich: boolean;
}

/**
 * Draft list.
 *
 * The returned shape is **deliberately identical to listFolder** (disguised as a message with `direction='draft'`):
 * the frontend's list rendering, cache fingerprint, paging, and search can all be reused as-is, with only the "opening it shows
 * a compose dialog instead of a detail" branch differing. `received_at` is filled with `updated_at` — a draft's ordering semantics is "last modified time".
 *
 * ⚠️ Drafts are **never** filtered by the mailbox / domain filters (only by search `q`). A draft belongs to the sender
 * you picked, not to the address you are currently browsing, so filtering them made a draft written from another
 * address/domain silently disappear — which reads as "my draft was lost" (user-reported).
 */
export async function listDrafts(
  env: Env,
  opts: { q?: string | null; mailbox?: string; domain?: string; limit: number; offset: number }
): Promise<{ items: FolderRow[]; total: number }> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.q) {
    const like = `%${opts.q}%`;
    conds.push('(subject LIKE ? OR to_emails LIKE ? OR body_text LIKE ?)');
    params.push(like, like, like);
  }
  const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const rows = (
    await env.DB.prepare(
      `SELECT id, mailbox, subject, to_emails,
              substr(coalesce(NULLIF(body_text, ''), ''), 1, 200) AS preview,
              updated_at
       FROM drafts ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
    )
      .bind(...params, opts.limit, opts.offset)
      .all<{ id: string; mailbox: string; subject: string | null; to_emails: string; preview: string | null; updated_at: number }>()
  ).results;

  const total =
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM drafts ${whereSql}`).bind(...params).first<{ n: number }>())?.n ?? 0;

  const items: FolderRow[] = rows.map((r) => ({
    id: r.id,
    direction: 'draft',
    mailbox: r.mailbox,
    from_name: null,
    from_email: null,
    subject: r.subject,
    to_emails: r.to_emails,
    preview: r.preview,
    received_at: r.updated_at,
    read: 1, // drafts have no unread semantics
    starred: 0,
    status: 'draft',
    attachments_count: 0,
    thread_count: 1,
    thread_unread: 0,
  }));
  return { items, total };
}

export async function getDraft(env: Env, id: string): Promise<DraftRow | null> {
  return (await env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<DraftRow>()) ?? null;
}

/** Create or overwrite a draft. The frontend generates the id when opening the compose dialog, and autosave upserts directly, saving one round trip. */
export async function upsertDraft(env: Env, d: DraftInput): Promise<void> {
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO drafts (id, mailbox, mailbox_domain, mode, source_id, to_emails, cc, bcc, subject, body_html, body_text, rich, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mailbox = excluded.mailbox,
       mailbox_domain = excluded.mailbox_domain,
       mode = excluded.mode,
       source_id = excluded.source_id,
       to_emails = excluded.to_emails,
       cc = excluded.cc,
       bcc = excluded.bcc,
       subject = excluded.subject,
       body_html = excluded.body_html,
       body_text = excluded.body_text,
       rich = excluded.rich,
       updated_at = excluded.updated_at`
  )
    .bind(
      d.id,
      d.mailbox,
      domainOf(d.mailbox),
      d.mode,
      d.sourceId,
      JSON.stringify(d.to),
      d.cc.length ? JSON.stringify(d.cc) : null,
      d.bcc.length ? JSON.stringify(d.bcc) : null,
      d.subject,
      d.html,
      d.text,
      d.rich ? 1 : 0,
      now,
      now
    )
    .run();
}

export async function deleteDraft(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM drafts WHERE id = ?').bind(id).run();
}

export async function sidebarCounts(env: Env, mailbox?: string, domain?: string): Promise<{
  inbox_unread: number;
  inbox_total: number;
  sent_total: number;
  starred_total: number;
  trash_total: number;
  drafts_total: number;
}> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (mailbox) {
    const c = mailboxCond(mailbox);
    conds.push(c.sql);
    params.push(...c.params);
  }
  // `''` (explicitly "no domain selected") matches nothing — see domainCond; undefined/null = all domains.
  if (domain !== undefined && domain !== null) {
    const c = domainCond(domain);
    conds.push(c.sql);
    params.push(...c.params);
  }
  const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  // Drafts are counted **without** the mailbox/domain filters, matching listDrafts: a draft belongs to the sender you
  // picked, not to the address you are browsing, so it must not vanish (nor bounce the badge) when you switch filters.
  const [row, draftRow] = await Promise.all([
    env.DB.prepare(
      `SELECT
        SUM(CASE WHEN direction='inbound' AND deleted=0 AND read=0 THEN 1 ELSE 0 END) AS inbox_unread,
        SUM(CASE WHEN direction='inbound' AND deleted=0 THEN 1 ELSE 0 END) AS inbox_total,
        SUM(CASE WHEN direction='outbound' AND deleted=0 THEN 1 ELSE 0 END) AS sent_total,
        SUM(CASE WHEN starred=1 AND deleted=0 THEN 1 ELSE 0 END) AS starred_total,
        SUM(CASE WHEN deleted=1 THEN 1 ELSE 0 END) AS trash_total
       FROM messages ${whereSql}`
    ).bind(...params).first<{ inbox_unread: number | null; inbox_total: number | null; sent_total: number | null; starred_total: number | null; trash_total: number | null }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM drafts')
      .first<{ n: number | null }>(),
  ]);

  return {
    inbox_unread: row?.inbox_unread ?? 0,
    inbox_total: row?.inbox_total ?? 0,
    sent_total: row?.sent_total ?? 0,
    starred_total: row?.starred_total ?? 0,
    trash_total: row?.trash_total ?? 0,
    drafts_total: draftRow?.n ?? 0,
  };
}

/**
 * Receiving address list (with each address's unread count/total), for sidebar switching.
 * Covers **all** rows: empty-string/NULL mailbox falls into the UNKNOWN_MAILBOX group, no longer silently dropped,
 * thus guaranteeing "all mailboxes" count (sidebarCounts with no mailbox arg) === the sum of each group's count (BUG-3b).
 *
 * Performance: GROUP BY uses the **raw column** `mailbox` (the leading column of idx_messages_counts), which can be satisfied directly
 * by an ordered scan of the covering index, no longer producing `TEMP B-TREE FOR GROUP BY` (measured 20000 rows 100ms → 4.0ms).
 * Empty-string/NULL normalization is marked as a sentinel in the SELECT and merged by sentinel key in JS (if NULL and '' appear together they produce two rows).
 */
/**
 * Unread inbound counts **per domain**, for the new-mail badge on the domain chips. One GROUP BY, no filtering by the
 * current selection: every chip shows its own count.
 */
export async function domainUnreadCounts(env: Env): Promise<Record<string, number>> {
  const rows = (
    await env.DB.prepare(
      `SELECT lower(trim(mailbox_domain)) AS d, COUNT(*) AS n
         FROM messages
        WHERE direction = 'inbound' AND deleted = 0 AND read = 0 AND mailbox_domain IS NOT NULL AND mailbox_domain != ''
        GROUP BY lower(trim(mailbox_domain))`
    ).all<{ d: string; n: number }>()
  ).results;
  const out: Record<string, number> = {};
  for (const r of rows) if (r.d) out[r.d] = Number(r.n) || 0;
  return out;
}

export async function mailboxes(env: Env, domain?: string): Promise<
  Array<{ mailbox: string; inbox_unread: number; inbox_total: number; sent_total: number }>
> {
  const groupExpr = "CASE WHEN mailbox IS NULL OR mailbox = '' THEN ? ELSE mailbox END";
  // `''` = explicitly nothing selected -> match nothing (see domainCond); undefined = all domains.
  const domCond = domain === undefined || domain === null ? null : domainCond(domain);
  const whereSql = domCond ? `WHERE ${domCond.sql}` : '';
  const rows = await env.DB.prepare(
    `SELECT
       ${groupExpr} AS mailbox,
       SUM(CASE WHEN direction='inbound' AND deleted=0 AND read=0 THEN 1 ELSE 0 END) AS inbox_unread,
       SUM(CASE WHEN direction='inbound' AND deleted=0 THEN 1 ELSE 0 END) AS inbox_total,
       SUM(CASE WHEN direction='outbound' AND deleted=0 THEN 1 ELSE 0 END) AS sent_total
     FROM messages
     ${whereSql}
     GROUP BY mailbox
     ORDER BY inbox_unread DESC, mailbox ASC`
  ).bind(...[UNKNOWN_MAILBOX, ...((domCond?.params ?? []) as string[])]).all<{ mailbox: string | null; inbox_unread: number | null; inbox_total: number | null; sent_total: number | null }>();

  // Merge the '' / NULL sentinel group (with GROUP BY on the raw column the two are different groups and may each return a row).
  const merged = new Map<string, { mailbox: string; inbox_unread: number; inbox_total: number; sent_total: number }>();
  for (const r of rows.results) {
    const key = r.mailbox === null || r.mailbox === '' ? UNKNOWN_MAILBOX : r.mailbox;
    const prev = merged.get(key);
    if (prev) {
      prev.inbox_unread += r.inbox_unread ?? 0;
      prev.inbox_total += r.inbox_total ?? 0;
      prev.sent_total += r.sent_total ?? 0;
    } else {
      merged.set(key, {
        mailbox: key,
        inbox_unread: r.inbox_unread ?? 0,
        inbox_total: r.inbox_total ?? 0,
        sent_total: r.sent_total ?? 0,
      });
    }
  }
  const out = [...merged.values()];
  // Merging disrupts the SQL ordering (unread descending), so re-sort in JS with the same convention; return an empty array when the group count is 0 (no inventing groups).
  out.sort((a, b) => (b.inbox_unread - a.inbox_unread) || (a.mailbox < b.mailbox ? -1 : a.mailbox > b.mailbox ? 1 : 0));
  return out;
}

/** A row of the `domains` table (multi-domain config; see schema.sql). */
export interface DomainRow {
  domain: string;
  zone_id: string | null;
  resend_domain_id: string | null;
  /** This domain's own Resend key (domains can live in different Resend accounts). NULL = use the global key. */
  resend_api_key?: string | null;
  from_address: string | null;
  from_name: string | null;
  worker_name: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface DomainInput {
  domain: string;
  zoneId?: string | null;
  resendDomainId?: string | null;
  resendApiKey?: string | null;
  fromAddress?: string | null;
  fromName?: string | null;
  workerName?: string | null;
  enabled?: boolean;
}

/** All configured domains, newest first. Tolerates a missing table (older databases) by returning an empty list. */
export async function listDomains(env: Env): Promise<DomainRow[]> {
  try {
    const rows = (
      await env.DB.prepare('SELECT * FROM domains ORDER BY created_at ASC, rowid ASC').all<DomainRow>()
    ).results;
    return rows ?? [];
  } catch {
    return [];
  }
}

/**
 * Update a domain's own settings (only the fields provided). Returns false when the database predates migration 012
 * (no `resend_api_key` column) so the caller can fall back to the global key instead of losing the value.
 */
export async function updateDomainSettings(
  env: Env,
  domain: string,
  patch: { apiKey?: string | null; fromAddress?: string | null; fromName?: string | null }
): Promise<boolean> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.apiKey !== undefined) {
    sets.push('resend_api_key = ?');
    args.push(patch.apiKey);
  }
  if (patch.fromAddress !== undefined) {
    sets.push('from_address = ?');
    args.push(patch.fromAddress);
  }
  if (patch.fromName !== undefined) {
    sets.push('from_name = ?');
    args.push(patch.fromName);
  }
  if (!sets.length) return true;
  sets.push('updated_at = ?');
  args.push(nowSec(), domain.trim().toLowerCase());
  try {
    await env.DB.prepare(`UPDATE domains SET ${sets.join(', ')} WHERE domain = ?`).bind(...args).run();
    return true;
  } catch {
    return false;
  }
}

/** Convenience wrapper for the per-domain key only (returns false on a pre-012 database). */
export async function setDomainKey(env: Env, domain: string, apiKey: string | null): Promise<boolean> {
  return updateDomainSettings(env, domain, { apiKey });
}

/** Insert or update a domain row (the setup wizard calls this after a successful configure). */
export async function upsertDomain(env: Env, d: DomainInput): Promise<void> {
  const domain = d.domain.trim().toLowerCase();
  const now = nowSec();
  const args = [
    domain,
    d.zoneId ?? null,
    d.resendDomainId ?? null,
    d.fromAddress ?? null,
    d.fromName ?? null,
    d.workerName ?? null,
    d.enabled === false ? 0 : 1,
    now,
    now,
  ];
  const base = `INSERT INTO domains (domain, zone_id, resend_domain_id, from_address, from_name, worker_name, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       zone_id = excluded.zone_id,
       resend_domain_id = excluded.resend_domain_id,
       from_address = excluded.from_address,
       from_name = excluded.from_name,
       worker_name = excluded.worker_name,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`;
  try {
    await env.DB.prepare(
      `INSERT INTO domains (domain, zone_id, resend_domain_id, resend_api_key, from_address, from_name, worker_name, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET
         zone_id = excluded.zone_id,
         resend_domain_id = excluded.resend_domain_id,
         resend_api_key = COALESCE(excluded.resend_api_key, domains.resend_api_key),
         from_address = excluded.from_address,
         from_name = excluded.from_name,
         worker_name = excluded.worker_name,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`
    )
      .bind(domain, args[1], args[2], d.resendApiKey ?? null, ...args.slice(3))
      .run();
  } catch (e) {
    // Database predates migration 012 (no `resend_api_key` column): write the rest so the domain still works, and let
    // the caller decide what to do with the key (it can still be kept as the global key).
    if (!/resend_api_key|no column|has no column/i.test(String(e))) throw e;
    await env.DB.prepare(base).bind(...args).run();
  }
}

export interface ContactRow {
  name: string | null;
  email: string;
  /** Interaction count (inbox + sent), used to put frequent contacts first. */
  count: number;
}

/**
 * Local contacts (for recipient input suggestions): aggregated from existing mail correspondence, no extra address-book table needed.
 *
 * - **Emails**: inbound `from_email` + outbound/inbound `to_emails` / `cc` (JSON arrays, expanded with `json_each`).
 * - **Names**: can only come from inbound `from_name` (for outbound we store only the bare address).
 *   For the same address take the spelling from the **latest mail with a name** — relying on SQLite's rule that "a bare column and min()/max() take the same row".
 *
 * ⚠️ About that bare-column rule (measured on real SQLite 3.51.2 on 2026-10-03):
 *   the docs say a bare column takes that row only when there is **exactly one** min()/max() aggregate, but measurement shows it is **more lenient**:
 *   when `COUNT(*)` / `SUM(...)` are also present, the bare column **still** takes the max row.
 *   That is, "adding one more aggregate" does **not** break this query — but this is undocumented lenient behavior,
 *   so do not rely on it, and do not change this SQL based on it. What really breaks it is the **direction**:
 *   switching to `MIN(received_at)`, or writing the name as `MAX(from_name)` (taking the lexicographically largest rather than the latest),
 *   both silently return the wrong name (test/contacts.backend.test.js C2 covers each).
 * - **Do not exclude your own receiving mailbox** (user decision on 2026-10-03): the `mailbox` column contains both "my own identity"
 *   and possibly **colleagues'/team addresses** (e.g. an account configured to receive at `erin@`) — the user **wants to send** to these addresses anyway.
 *   Early versions excluded all of them by `DISTINCT mailbox`, causing such colleague addresses to **silently disappear** from suggestions (user-reported bug).
 *   Now your own addresses also appear in suggestions (the user explicitly said "you can send to yourself too").
 *
 * ⚠️ Two measured facts about `json_each` (verified on real SQLite on 2026-10-03):
 *   1. `json_each(NULL)` / `json_each('[]')` are both **0 rows** (no empty address is produced);
 *   2. but `json_each('')` / any invalid JSON **directly throws `malformed JSON`**,
 *      and a check in `WHERE` **cannot stop it** — the table-valued function is evaluated at the JOIN stage, earlier than WHERE.
 *      Measured: `FROM messages, json_each(cc) WHERE trim(cc) <> ''` still throws when `cc = ''`.
 *   So "is it a valid JSON array" must be written into `json_each`'s **argument expression** (the arrayArg below),
 *   which also excludes valid-but-non-array JSON like `'{}'` / `'123'` / `'null'`, otherwise it would produce ghost contacts like `'123'`.
 *   (`json_type()` cannot be used here: `json_type('')` itself throws.)
 */
export async function contacts(env: Env, limit = 500): Promise<ContactRow[]> {
  const arrayArg = (col: string) =>
    `CASE WHEN json_valid(${col}) AND substr(trim(${col}), 1, 1) = '[' THEN ${col} ELSE '[]' END`;

  const addrRows = (
    await env.DB.prepare(
      `SELECT lower(email) AS email, COUNT(*) AS cnt FROM (
         SELECT from_email AS email FROM messages
           WHERE from_email IS NOT NULL AND trim(from_email) <> ''
         UNION ALL
         SELECT je.value AS email FROM messages, json_each(${arrayArg('messages.to_emails')}) je
         UNION ALL
         SELECT je.value AS email FROM messages, json_each(${arrayArg('messages.cc')}) je
       )
       WHERE email IS NOT NULL AND trim(email) <> ''
       GROUP BY lower(email)`
    ).all<{ email: string; cnt: number }>()
  ).results;

  const nameRows = (
    await env.DB.prepare(
      `SELECT lower(from_email) AS email, from_name AS name, MAX(received_at) AS mx
       FROM messages
       WHERE from_name IS NOT NULL AND trim(from_name) <> ''
         AND from_email IS NOT NULL AND trim(from_email) <> ''
       GROUP BY lower(from_email)`
    ).all<{ email: string; name: string; mx: number }>()
  ).results;

  const names = new Map<string, string>();
  for (const r of nameRows) if (r.name && r.name.trim()) names.set(r.email, r.name.trim());

  const out: ContactRow[] = [];
  for (const r of addrRows) {
    out.push({ name: names.get(r.email) ?? null, email: r.email, count: r.cnt });
  }
  out.sort((a, b) => b.count - a.count || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  return out.slice(0, limit);
}

/**
 * The shape of a thread row (a context entry in the reading view).
 *
 * ⚠️ `copy_ids` **is not a DB column** — it is "the other record ids of the same physical message" attached by `foldLoopbackCopies()`
 * when folding. The frontend uses it to count "the currently open one being exactly the folded copy"
 * as the current row too, otherwise no row in the thread panel is highlighted, looking like "the one I opened is gone".
 */
export interface ThreadRow {
  id: string;
  direction: string;
  mailbox: string;
  from_name: string | null;
  from_email: string | null;
  to_emails: string;
  /** Real Cc / Bcc headers (JSON array text, may be NULL). Folding loopback copies relies on them. */
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  preview: string | null;
  received_at: number;
  read: number;
  deleted: number;
  copy_ids?: string[];
}

/** Time window (seconds) for loopback copies. Production measured only 1~2 seconds between the outbound and loopback store times. */
const LOOPBACK_WINDOW_SEC = 300;

function normAddr(v: string | null | undefined): string {
  return String(v ?? '').trim().toLowerCase();
}

/** All recipients of a row (to + cc + bcc, normalized lowercase). */
function rowRecipients(row: ThreadRow): string[] {
  return [...jsonArr(row.to_emails), ...jsonArr(row.cc), ...jsonArr(row.bcc)]
    .map(normAddr)
    .filter(Boolean);
}

/**
 * Fold "loopback copies of the same physical message within this account".
 *
 * Background (measured on production data 2026-10-08): several receiving mailboxes are configured under the account (dana@ / support@ / erin@).
 * When dana@ sends to an external recipient and **also cc's erin@**, Resend delivers the same message back to
 * erin@, so two records are left in the DB:
 *   - outbound: `to=[frank@…]` `cc=[erin@…]`        —— the copy I sent
 *   - inbound: `mailbox=erin@` `from=dana@` `to=[frank@…]` `cc=[erin@…]`
 *                                                    —— the copy delivered back to this account
 * The two have identical from / to / cc / subject / in_reply_to and store times only 1~2 seconds apart; the thread panel's time
 * is precise to the minute → the two rows are **verbatim identical**, so the user sees "the same message shown twice".
 *
 * Determining "some inbound row is a loopback copy of some outbound row" requires **simultaneously**:
 *   ① the same thread (the caller has already filtered by thread_id);
 *   ② `from_email` identical and non-empty — the copy's sender is our own sending identity;
 *   ③ the inbound row's **delivery mailbox** (`mailbox`) appears in that outbound row's to/cc/bcc — whoever I sent to, it comes back from;
 *   ④ store times differ by no more than LOOPBACK_WINDOW_SEC.
 * All four must hold to fold: a real incoming mail (sender is the other party) fails ②; the other party replying later fails ④;
 * mail delivered to an address **not in this account** fails ③. If any one does not hold, it is kept as-is.
 *
 * The folding direction is fixed as "keep outbound, drop inbound": the thread panel answers "the correspondence of this message", not
 * "what each mailbox individually received" — the folded copy still shows normally in erin@'s own inbox.
 *
 * Side effect: if a folded row was unread, set the surviving row's `read` to 0 — otherwise folding would silently swallow an unread signal.
 */
export function foldLoopbackCopies(rows: ThreadRow[]): ThreadRow[] {
  const outbounds = rows.filter((r) => r.direction === 'outbound');
  if (!outbounds.length) return rows;

  const copyOf = new Map<string, string>(); // inbound copy id -> outbound row id
  const kept = rows.filter((r) => {
    if (r.direction !== 'inbound') return true;
    const from = normAddr(r.from_email);
    const box = normAddr(r.mailbox);
    if (!from || !box) return true;
    const origin = outbounds.find(
      (o) =>
        normAddr(o.from_email) === from &&
        Math.abs(o.received_at - r.received_at) <= LOOPBACK_WINDOW_SEC &&
        rowRecipients(o).includes(box)
    );
    if (!origin) return true;
    copyOf.set(r.id, origin.id);
    return false;
  });

  for (const [copyId, originId] of copyOf) {
    const origin = kept.find((r) => r.id === originId);
    if (!origin) continue;
    origin.copy_ids = origin.copy_ids ? [...origin.copy_ids, copyId] : [copyId];
    const copy = rows.find((r) => r.id === copyId);
    if (copy && !copy.read) origin.read = 0;
  }
  return kept;
}

/**
 * Messages within the same thread, **descending (most recent first)**, for the reading view context.
 * Loopback copies of "the same physical message" are folded before returning (see `foldLoopbackCopies`).
 *
 * `id DESC` only provides a stable order within the same second and carries no business meaning.
 */
export async function listThread(env: Env, threadId: string): Promise<ThreadRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, direction, mailbox, from_name, from_email, to_emails, cc, bcc, subject,
            substr(coalesce(NULLIF(body_text,''), ''), 1, 160) AS preview,
            received_at, read, deleted
     FROM messages
     WHERE thread_id = ?
     ORDER BY received_at DESC, id DESC`
  ).bind(threadId).all<ThreadRow>();
  return foldLoopbackCopies(rows.results);
}

export async function getMessage(env: Env, id: string): Promise<MessageRow | null> {
  return (
    (await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<MessageRow>()) ?? null
  );
}

/** Look up an already-stored inbound mail by Resend email_id (for dedup). */
export async function findInboundByResendId(env: Env, emailId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT id FROM messages WHERE direction = 'inbound' AND resend_id = ? LIMIT 1"
  ).bind(emailId).first<{ id: string }>();
  return row?.id ?? null;
}

export async function listAttachments(env: Env, messageId: string): Promise<AttachmentRow[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM attachments WHERE message_id = ? ORDER BY inline DESC, created_at ASC'
  ).bind(messageId).all<AttachmentRow>();
  return rows.results;
}

export async function markRead(env: Env, id: string): Promise<void> {
  await env.DB.prepare('UPDATE messages SET read = 1, updated_at = ? WHERE id = ?')
    .bind(nowSec(), id)
    .run();
}

export interface PatchBody {
  read?: boolean;
  starred?: boolean;
  deleted?: boolean;
}

export async function patchMessage(env: Env, id: string, patch: PatchBody): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.read !== undefined) {
    sets.push('read = ?');
    params.push(patch.read ? 1 : 0);
  }
  if (patch.starred !== undefined) {
    sets.push('starred = ?');
    params.push(patch.starred ? 1 : 0);
  }
  if (patch.deleted !== undefined) {
    sets.push('deleted = ?');
    params.push(patch.deleted ? 1 : 0);
  }
  if (!sets.length) return false;
  sets.push('updated_at = ?');
  params.push(nowSec(), id);
  const res = await env.DB.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
  return res.meta.changes > 0;
}

export type BatchAction =
  | 'read'
  | 'unread'
  | 'star'
  | 'unstar'
  | 'trash'
  | 'restore'
  | 'delete';

async function permanentDelete(env: Env, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const attachRows = (
    await env.DB.prepare(`SELECT r2_key FROM attachments WHERE message_id IN (${placeholders})`)
      .bind(...ids)
      .all<{ r2_key: string }>()
  ).results;

  await env.DB.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).bind(...ids).run();
  await env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${placeholders})`).bind(...ids).run();
  await env.DB.prepare(`DELETE FROM delivery_events WHERE message_id IN (${placeholders})`).bind(...ids).run();

  await Promise.all(
    attachRows.map((r) => env.BUCKET.delete(r.r2_key).catch(() => undefined))
  );
  return attachRows.length;
}

export async function batchAction(env: Env, ids: string[], action: BatchAction): Promise<{ changed: number }> {
  if (!ids.length) return { changed: 0 };
  const clean = [...new Set(ids)];
  if (action === 'delete') {
    await permanentDelete(env, clean);
    return { changed: clean.length };
  }

  let col: string;
  let value: number;
  switch (action) {
    case 'read':
      col = 'read';
      value = 1;
      break;
    case 'unread':
      col = 'read';
      value = 0;
      break;
    case 'star':
      col = 'starred';
      value = 1;
      break;
    case 'unstar':
      col = 'starred';
      value = 0;
      break;
    case 'trash':
      col = 'deleted';
      value = 1;
      break;
    case 'restore':
      col = 'deleted';
      value = 0;
      break;
    default:
      return { changed: 0 };
  }
  const placeholders = clean.map(() => '?').join(',');
  const res = await env.DB.prepare(`UPDATE messages SET ${col} = ?, updated_at = ? WHERE id IN (${placeholders})`)
    .bind(value, nowSec(), ...clean)
    .run();
  return { changed: res.meta.changes };
}

function insertMessageStmt(env: Env, row: {
  id: string;
  direction: 'inbound' | 'outbound';
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  threadId: string;
  mailbox: string;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  deliveredTo?: string[] | null;
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  receivedAt: number;
  status: string;
  resendId: string | null;
  /** Read state. Default: **outbound=1** (mail you sent has no "unread" semantics), inbound=0. */
  read?: number;
}): D1PreparedStatement {
  // Outbound mail defaults to read: no unread should appear in the sent folder.
  // Historically read was hardcoded to 0, making all sent mail show as unread in the list and stay that way when opened
  // (syncOpenedReadState only handles inbound), surfacing as "the sent folder is all unread".
  const read = row.read ?? (row.direction === 'outbound' ? 1 : 0);
  return env.DB.prepare(
    `INSERT INTO messages
      (id, direction, message_id, in_reply_to, "references", thread_id, mailbox, mailbox_domain,
       from_name, from_email, to_emails, delivered_to, cc, bcc, reply_to, subject, body_html,
       body_text, received_at, status, resend_id, read, starred, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  ).bind(
    row.id,
    row.direction,
    row.messageId,
    row.inReplyTo,
    row.references,
    row.threadId,
    row.mailbox,
    domainOf(row.mailbox),
    row.fromName,
    row.fromEmail,
    JSON.stringify(row.to),
    row.deliveredTo && row.deliveredTo.length ? JSON.stringify(row.deliveredTo) : null,
    row.cc.length ? JSON.stringify(row.cc) : null,
    row.bcc.length ? JSON.stringify(row.bcc) : null,
    row.replyTo.length ? JSON.stringify(row.replyTo) : null,
    row.subject,
    row.html,
    row.text,
    row.receivedAt,
    row.status,
    row.resendId,
    read,
    nowSec(),
    nowSec()
  );
}

/** Inbound message + attachments + webhook idempotency record, written atomically in the same D1 batch transaction. */
export async function saveInbound(env: Env, input: InboundInput, deliveryEventId: string): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    insertMessageStmt(env, {
      id: input.rowId,
      direction: 'inbound',
      messageId: input.messageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
      threadId: input.threadId,
      mailbox: input.mailbox,
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      to: input.to,
      deliveredTo: input.deliveredTo,
      cc: input.cc,
      bcc: input.bcc,
      replyTo: input.replyTo,
      subject: input.subject,
      html: input.html,
      text: input.text,
      receivedAt: input.receivedAt,
      status: 'received',
      resendId: input.resendId,
    }),
  ];

  for (const a of input.attachments) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO attachments (id, message_id, r2_key, filename, content_type, size, inline, content_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(uuid(), input.rowId, a.r2Key, a.filename, a.contentType, a.size, a.inline, a.contentId, nowSec())
    );
  }

  stmts.push(
    env.DB.prepare('INSERT OR IGNORE INTO webhook_deliveries (id, processed_at) VALUES (?, ?)').bind(
      deliveryEventId,
      nowSec()
    )
  );

  await env.DB.batch(stmts);
}

export async function saveOutbound(env: Env, input: OutboundInput): Promise<string> {
  const rowId = uuid();
  const messageId = input.messageId ?? rowId;
  await insertMessageStmt(env, {
    id: rowId,
    direction: 'outbound',
    messageId,
    inReplyTo: input.inReplyTo,
    references: input.references,
    threadId: input.threadId,
    mailbox: input.mailbox,
    fromName: input.fromName,
    fromEmail: input.fromEmail,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc ?? [],
    replyTo: [],
    subject: input.subject,
    html: input.html,
    text: input.text,
    receivedAt: input.receivedAt,
    status: 'sent',
    resendId: input.resendId,
  }).run();
  return rowId;
}

/** Append attachment records for a message (outbound attachments are already in R2). */
export async function insertOutboundAttachments(env: Env, messageId: string, files: Array<{ filename: string; contentType: string; size: number; r2Key: string }>): Promise<void> {
  if (!files.length) return;
  const stmts = files.map((f) =>
    env.DB.prepare(
      `INSERT INTO attachments (id, message_id, r2_key, filename, content_type, size, inline, content_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`
    ).bind(uuid(), messageId, f.r2Key, f.filename, f.contentType, f.size, nowSec())
  );
  await env.DB.batch(stmts);
}

/** Whether the attachment metadata table exists (for proxy reads). */
export async function getAttachment(env: Env, id: string): Promise<AttachmentRow | null> {
  return (
    (await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first<AttachmentRow>()) ?? null
  );
}

/**
 * Whether this type can be **inlined** for browser preview (rather than forced download).
 *
 * Only allow types "the browser can natively render and that do not execute scripts in this origin":
 *  - Images: `image/*`, **but excluding SVG** — SVG can carry `<script>`, and inlining it means executing any sender's
 *    script in this app's same-origin context (XSS);
 *  - `application/pdf` / `video/*` / `audio/*`: native browser viewers, the industry standard for mail clients;
 *  - Plain-text types: only allow `text/plain` / `text/csv` / `text/markdown` / `application/json`,
 *    all other `text/*` (especially `text/html`, `text/xml`) are always downloaded.
 *
 * Note it works with the `text/html → octet-stream` downgrade in `proxyAttachment`: that defense line is still there.
 */
export function isInlinePreviewType(contentType: string): boolean {
  const t = (contentType || '').toLowerCase().split(';')[0].trim();
  if (!t) return false;
  if (t === 'image/svg+xml') return false;
  if (t.startsWith('image/') || t.startsWith('video/') || t.startsWith('audio/')) return true;
  if (t === 'application/pdf') return true;
  return t === 'text/plain' || t === 'text/csv' || t === 'text/markdown' || t === 'application/json';
}

/**
 * Attachment proxy.
 *
 * `opts.forceDownload` corresponds to `?dl=1`: regardless of type, always `Content-Disposition: attachment`
 * — every attachment in the frontend has its own "download" button that uses this parameter; without the parameter,
 * `isInlinePreviewType()` decides inline (previewable) vs. download.
 */
export async function proxyAttachment(
  env: Env,
  id: string,
  opts: { forceDownload?: boolean } = {}
): Promise<Response | null> {
  const row = await getAttachment(env, id);
  if (!row) return null;
  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) return null;

  const type = row.content_type && !row.content_type.startsWith('text/html')
    ? row.content_type
    : 'application/octet-stream';
  // Previewable types are inlined for browser rendering; the rest (including SVG / HTML) are always downloaded, to avoid opening user-uploaded content as a page.
  const inline = !opts.forceDownload && isInlinePreviewType(type);
  const headers = new Headers();
  headers.set('Content-Type', type);
  headers.set('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', row.filename));
  headers.set('Content-Length', String(obj.size));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, max-age=3600');

  if (!obj.body) return null;
  return new Response(obj.body, { headers });
}

/* ---------------- Inbound alerts dashboard (visibility for CF inbound "received but not in the inbox") ---------------- */

/** The external shape of an "inbound alert". */
export interface InboundAlert {
  id: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  size: number;
  received_at: number;
  error: string | null;
  attempts: number;
  /** true = still retrying/pending (no error yet); false = determined to have failed. */
  pending: boolean;
}

/** If parsing is not finished after this many seconds, it counts as "stuck" rather than "processing". */
const INBOUND_PENDING_GRACE_SEC = 600;

/**
 * List "inbound alerts": either an error is recorded, or it was received more than 10 minutes ago and still not parsed.
 *
 * The receiving path already guarantees the raw message is in R2 and the index in inbound_raw — this list **exposes** these
 * "not in the inbox" messages **to the UI** (otherwise they are just backend logs and the user never knows what was lost).
 * Already-stored ones (message_row non-empty) do not count as alerts.
 */
export async function listInboundAlerts(env: Env, limit = 50): Promise<InboundAlert[]> {
  const rows = await env.DB.prepare(
    `SELECT id, from_email, to_email, subject, size, received_at, parsed_at, error, attempts
       FROM inbound_raw
      WHERE message_row IS NULL
        AND (error IS NOT NULL OR (parsed_at IS NULL AND received_at < ?))
      ORDER BY received_at DESC
      LIMIT ?`
  )
    .bind(nowSec() - INBOUND_PENDING_GRACE_SEC, limit)
    .all<{
      id: string;
      from_email: string | null;
      to_email: string | null;
      subject: string | null;
      size: number;
      received_at: number;
      parsed_at: number | null;
      error: string | null;
      attempts: number;
    }>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    from: r.from_email,
    to: r.to_email,
    subject: r.subject,
    size: r.size,
    received_at: r.received_at,
    error: r.error,
    attempts: r.attempts,
    pending: r.error == null,
  }));
}

/** Fetch one inbound_raw index row. */
export async function getInboundRaw(env: Env, id: string): Promise<InboundRawRow | null> {
  return env.DB.prepare('SELECT * FROM inbound_raw WHERE id = ?').bind(id).first<InboundRawRow>();
}

/**
 * Manually replay an inbound alert: clear error, zero attempts, set `parsed_at` to NULL, then enqueue for reparsing.
 * Idempotency is guaranteed by the consumer (message_row / findInboundByResendId).
 */
export async function retryInbound(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT id FROM inbound_raw WHERE id = ?')
    .bind(id)
    .first<{ id: string }>();
  if (!row) return false;
  await env.DB.prepare('UPDATE inbound_raw SET error = NULL, attempts = 0, parsed_at = NULL WHERE id = ?')
    .bind(id)
    .run();
  if (env.INBOUND_QUEUE) await env.INBOUND_QUEUE.send({ rawId: id });
  return true;
}

/** Fetch an inbound alert's **raw .eml** for the user to download (fallback when it is not in the inbox). */
export async function proxyInboundRaw(env: Env, id: string): Promise<Response | null> {
  const row = await getInboundRaw(env, id);
  if (!row) return null;
  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj || !obj.body) return null;
  const headers = new Headers();
  headers.set('Content-Type', 'message/rfc822');
  headers.set('Content-Disposition', contentDisposition('attachment', `inbound-${id}.eml`));
  headers.set('Content-Length', String(obj.size));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers });
}

/* ---------------- Backend base status (CF storage/inbound + Resend quota), giving the frontend one screen and advance warning of when to upgrade ----------------
 * Free tier capacity: CF D1 500MB per DB, R2 10GB; Resend 100/day, 3000/month.
 * Storage can only be **estimated**:
 *   · D1: no pragma permission (page/file sizes are unreadable) and no DB size API → sum the UTF-8 bytes of the TEXT/BLOB columns
 *     of each table. Note `LENGTH(text)` counts **characters**, so it must be `CAST(x AS BLOB)` to count bytes.
 *   · R2: no "bucket size" API → list objects and sum their sizes.
 * Both are expensive (D1 full scan, R2 listing billed as Class A), so results are cached in app_stats and only recomputed after 6 hours by default.
 * The inbound count (inbound_raw COUNT) and send quota (messages COUNT) are cheap and computed in real time every time.
 */

/** Free tier capacity limits (bytes). Paid tiers override with env.D1_LIMIT_BYTES / env.R2_LIMIT_BYTES. */
const D1_FREE_LIMIT = 500 * 1024 * 1024;
const R2_FREE_LIMIT = 10 * 1024 * 1024 * 1024;
/** Resend free tier send quota (messages/day, messages/month). Paid tiers override with env.RESEND_DAY_LIMIT / RESEND_MONTH_LIMIT. */
const RESEND_DAY_FREE = 100;
const RESEND_MONTH_FREE = 3000;
/** Usage cache duration (seconds): recomputed on the next request after expiry, to avoid a full scan / object listing on every page open. */
const USAGE_TTL_SEC = 6 * 3600;
/** Safety valve for listing R2: at most this many pages (1000 each), preventing a request timeout when there are very many objects. */
const R2_LIST_MAX_PAGES = 100;

/** Backend base status: CF (D1/R2 usage + inbound queue) + Resend (send quota), for the frontend's one-screen view. */
export interface BackendStatus {
  d1: { usedBytes: number; limitBytes: number; percent: number };
  r2: { usedBytes: number; limitBytes: number; percent: number; objects: number };
  /** CF inbound pipeline status (never-lose): pending parse / alerts / cumulative received. */
  inbound: { pending: number; alerts: number; total: number };
  /** Resend outbound quota: messages sent today / this month (estimated from our own outbound records). */
  resend: {
    configured: boolean;
    day: { used: number; limit: number; percent: number };
    month: { used: number; limit: number; percent: number };
  };
  /** Storage data time (the earlier updated_at of the two D1 / R2 samples, in seconds). */
  updatedAt: number;
  /** D1/R2 are estimates (see the notes above); the frontend should mark them "approx.". */
  approximate: boolean;
}

function pct(used: number, limit: number): number {
  if (!limit) return 0;
  return Math.round((used / limit) * 1000) / 10; // keep one decimal place
}

/** Sum the UTF-8 bytes of each table's TEXT/BLOB columns as an estimate of D1 usage (the real file includes indexes/pages and will be slightly larger). */
async function estimateD1Bytes(env: Env): Promise<number> {
  const tables = await env.DB.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name <> 'd1_migrations'
        AND substr(name, 1, 3) <> '_cf'`
  ).all<{ name: string }>();
  let total = 0;
  for (const t of tables.results ?? []) {
    const ident = t.name.replace(/"/g, '""');
    const cols = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('${t.name.replace(/'/g, "''")}')
        WHERE type LIKE '%TEXT%' OR type LIKE '%BLOB%'`
    ).all<{ name: string }>();
    const names = (cols.results ?? []).map((c) => c.name);
    if (!names.length) continue;
    const expr = names.map((n) => `LENGTH(CAST(COALESCE("${n.replace(/"/g, '""')}",'') AS BLOB))`).join(' + ');
    const row = await env.DB.prepare(`SELECT COALESCE(SUM(${expr}), 0) AS b FROM "${ident}"`).first<{ b: number }>();
    total += Number(row?.b || 0);
  }
  return total;
}

/** List the entire R2 bucket, accumulating object sizes and count. */
async function measureR2(env: Env): Promise<{ bytes: number; objects: number }> {
  let cursor: string | undefined;
  let bytes = 0;
  let objects = 0;
  let pages = 0;
  do {
    const res = await env.BUCKET.list(cursor ? { cursor, limit: 1000 } : { limit: 1000 });
    for (const o of res.objects) {
      bytes += o.size;
      objects++;
    }
    cursor = res.truncated ? res.cursor : undefined;
    pages++;
  } while (cursor && pages < R2_LIST_MAX_PAGES);
  return { bytes, objects };
}

/** CF inbound pipeline status: pending parse (parsed_at IS NULL), alerts (same convention as the notice bar), cumulative received. */
async function inboundStatus(env: Env): Promise<{ pending: number; alerts: number; total: number }> {
  const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbound_raw WHERE parsed_at IS NULL')
    .first<{ n: number }>();
  const alerts = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM inbound_raw
      WHERE message_row IS NULL
        AND (error IS NOT NULL OR (parsed_at IS NULL AND received_at < ?))`
  )
    .bind(nowSec() - INBOUND_PENDING_GRACE_SEC)
    .first<{ n: number }>();
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbound_raw').first<{ n: number }>();
  return { pending: Number(pending?.n || 0), alerts: Number(alerts?.n || 0), total: Number(total?.n || 0) };
}

/**
 * Resend outbound quota usage: count the messages we ourselves sent (resend_id non-empty).
 * Free tier is 100/day, 3000/month, resetting at UTC midnight and the start of the month. Note: it only counts what this service sent;
 * if the same Resend account also sends from elsewhere, this will be low.
 */
async function resendUsage(env: Env): Promise<{ day: number; month: number }> {
  const now = nowSec();
  const d = new Date(now * 1000);
  const dayStart = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
  const monthStart = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END), 0) AS day,
       COALESCE(SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END), 0) AS month
     FROM messages
     WHERE direction = 'outbound' AND resend_id IS NOT NULL`
  )
    .bind(dayStart, monthStart)
    .first<{ day: number; month: number }>();
  return { day: Number(row?.day || 0), month: Number(row?.month || 0) };
}

async function readStat(env: Env, key: string): Promise<{ value: number; updated_at: number } | null> {
  return env.DB.prepare('SELECT value, updated_at FROM app_stats WHERE key = ?')
    .bind(key)
    .first<{ value: number; updated_at: number }>();
}

async function writeStat(env: Env, key: string, value: number, at: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_stats (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value, at)
    .run();
}

/**
 * Get the backend base status: CF (D1/R2 usage + inbound queue) + Resend (send quota).
 * D1/R2 go through the cache (`force` forces recomputation); the inbound count and send quota are cheap and computed in real time every time.
 */
export async function getBackendStatus(env: Env, opts: { force?: boolean } = {}): Promise<BackendStatus> {
  const now = nowSec();
  const stale = (s: { updated_at: number } | null): boolean => opts.force || !s || now - s.updated_at > USAGE_TTL_SEC;

  let d1 = await readStat(env, 'd1_bytes');
  if (stale(d1)) {
    const bytes = await estimateD1Bytes(env);
    await writeStat(env, 'd1_bytes', bytes, now);
    d1 = { value: bytes, updated_at: now };
  }

  let r2 = await readStat(env, 'r2_bytes');
  let r2Objects = await readStat(env, 'r2_objects');
  if (stale(r2)) {
    const m = await measureR2(env);
    await writeStat(env, 'r2_bytes', m.bytes, now);
    await writeStat(env, 'r2_objects', m.objects, now);
    r2 = { value: m.bytes, updated_at: now };
    r2Objects = { value: m.objects, updated_at: now };
  }

  const [inbound, resend] = await Promise.all([inboundStatus(env), resendUsage(env)]);

  const d1Limit = Number(env.D1_LIMIT_BYTES) || D1_FREE_LIMIT;
  const r2Limit = Number(env.R2_LIMIT_BYTES) || R2_FREE_LIMIT;
  const dayLimit = Number(env.RESEND_DAY_LIMIT) || RESEND_DAY_FREE;
  const monthLimit = Number(env.RESEND_MONTH_LIMIT) || RESEND_MONTH_FREE;
  const d1Used = d1?.value ?? 0;
  const r2Used = r2?.value ?? 0;
  return {
    d1: { usedBytes: d1Used, limitBytes: d1Limit, percent: pct(d1Used, d1Limit) },
    r2: { usedBytes: r2Used, limitBytes: r2Limit, percent: pct(r2Used, r2Limit), objects: r2Objects?.value ?? 0 },
    inbound,
    resend: {
      configured: Boolean(env.RESEND_API_KEY),
      day: { used: resend.day, limit: dayLimit, percent: pct(resend.day, dayLimit) },
      month: { used: resend.month, limit: monthLimit, percent: pct(resend.month, monthLimit) },
    },
    updatedAt: Math.min(d1?.updated_at ?? now, r2?.updated_at ?? now),
    approximate: true,
  };
}

/* ---------------- Setup wizard / auth (app_config + users) ---------------- */

/** Read one app config entry (key/value written by the wizard). Returns null if absent. */
export async function getConfig(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?').bind(key).first<{ value: string | null }>();
  return row ? row.value : null;
}

/** Read all config at once (needed for wizard status and self-check). */
export async function getConfigMap(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('SELECT key, value FROM app_config').all<{ key: string; value: string | null }>();
  const out: Record<string, string> = {};
  for (const r of results || []) out[r.key] = r.value ?? '';
  return out;
}

export async function setConfig(env: Env, key: string, value: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value, nowSec())
    .run();
}

/** Drop several app_config entries in one statement (used to retire the single-domain keys the domains table replaced). */
export async function deleteConfigKeys(env: Env, keys: string[]): Promise<void> {
  const list = keys.filter(Boolean);
  if (!list.length) return;
  const placeholders = list.map(() => '?').join(', ');
  await env.DB.prepare(`DELETE FROM app_config WHERE key IN (${placeholders})`).bind(...list).run();
}

/** Drop one app_config entry (used to retire the legacy global Resend key after it was migrated per domain). */
export async function deleteConfig(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM app_config WHERE key = ?').bind(key).run();
}

export interface AdminUserRow {
  id: string;
  username: string;
  password_hash: string;
}

/** Whether an admin account has been set up (determines whether the app is "uninitialized" or "needs login"). */
export async function hasAdminUser(env: Env): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS n FROM users LIMIT 1').first<{ n: number }>();
  return !!row;
}

export async function getAdminByUsername(env: Env, username: string): Promise<AdminUserRow | null> {
  return (await env.DB.prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .bind(username)
    .first<AdminUserRow>()) ?? null;
}

export async function createAdmin(env: Env, username: string, passwordHash: string): Promise<string> {
  const id = uuid();
  const now = nowSec();
  await env.DB.prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, username, passwordHash, now, now)
    .run();
  return id;
}
