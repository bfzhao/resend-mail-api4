import PostalMime from 'postal-mime';
import type { Address as PostalAddress, Attachment as PostalAttachment, Email as PostalEmail } from 'postal-mime';
import type { Env, InboundQueueMessage, InboundRawRow } from './types';
import type { InboundInput, PreparedAttachment } from './repo';
import { findInboundByResendId, saveInbound } from './repo';
import { nowSec, parseReferences, rootThreadId, stripAngle, stripHtml, uuid } from './util';

/**
 * Cloudflare Email Routing inbound (the new primary path replacing Resend inbound).
 *
 * ⚠️ The fundamental difference from Resend: **CF does not store mail** (Email Routing is a router, and there is officially no API
 * to refetch received mail). So the primary goal here is "**never lose**", and only then "parse well". Two-stage pipeline:
 *
 *   1. `handleInboundEmail()` (the `email()` handler)
 *      — read headers + **stream** `message.raw` into R2 + register a row in `inbound_raw` + enqueue (sending only an id pointer).
 *        ⚠️ The queue binding is **optional**: without it the message is parsed inline right here (same routine), and the
 *      The cost of this stage is independent of message size (it is not fully read into memory), so the Free tier's 10ms CPU can handle it.
 *   2. `handleInboundQueue()` (the `queue()` consumer)
 *      — fetch the raw message from R2 → parse with postal-mime → **reuse the existing `saveInbound()`** to write messages/attachments
 *        → backfill `inbound_raw.parsed_at` / `message_row`.
 *
 * Data compatibility: the parse result is assembled into an `InboundInput` **identical** to Resend inbound, and lands in the **same**
 * `messages` / `attachments` tables (columns unchanged). Historical rows and the still-enabled `/webhook/inbound` (Resend fallback path)
 * do not affect each other.
 */

/** R2 prefix for the raw .eml. */
const RAW_PREFIX = 'inbound-raw/';
/** Maximum retries for a transient parse/store failure; beyond this it is kept as "pending" for the recovery cron, so poisonous messages do not stall the whole batch, yet nothing is lost. */
const MAX_RAW_ATTEMPTS = 5;
/** Small backoff retry count for D1/R2/Queue within a single `email()`/`queue()` (CF only gives one chance to receive mail, so do not give up if you can avoid it). */
const RETRY_ATTEMPTS = 3;
/**
 * The D1 hard limit for a "single row/string/BLOB" is 2,000,000 bytes. A `messages` row contains body_html + body_text + References etc.,
 * and if it exceeds that it can **permanently** not be written (retrying the same data any number of times gives the same result).
 * A budget more conservative than the limit is used here to decide early; on a hit, mark a terminal state, remove from the queue, and
 * stop retrying (the raw .eml is still in R2 and can be downloaded under "inbound alerts").
 */
const MAX_MESSAGE_ROW_BYTES = 1_900_000;

const UTF8 = new TextEncoder();

/** UTF-8 byte count (D1's "row size" is counted in bytes; a CJK character is up to 3 bytes, so .length cannot be used as the count). */
function utf8Bytes(s: string | null | undefined): number {
  if (!s) return 0;
  return UTF8.encode(s).length;
}

/**
 * Whether a DB write failure is **permanent**: retrying the same data any number of times gives the same result, so mark terminal and stop retrying.
 *  - Row/field exceeds the D1 limit (`too big` / `too large` / `SQLITE_TOOBIG`);
 *  - Constraint conflict (NOT NULL / UNIQUE etc.).
 * Everything else (network, D1 overloaded, timeout) is treated as transient and goes to retry.
 */
function isPermanentSaveError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /too big|too large|sqlite_toobig/.test(m) || /constraint failed|constraint violation/.test(m);
}

/** Small backoff retry: if `fn` throws, retry with increasing delays of 50ms, 100ms… until it succeeds or attempts run out, then throw the last error. */
async function withRetry<T>(fn: () => Promise<T>, attempts = RETRY_ATTEMPTS): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  throw lastErr;
}

interface SimpleAddress {
  name: string | null;
  email: string;
}

/** Flatten postal-mime addresses (including the group form) into a flat address list. */
function flattenAddresses(addrs: PostalAddress[] | undefined): SimpleAddress[] {
  const out: SimpleAddress[] = [];
  for (const a of addrs ?? []) {
    if (!a) continue;
    if (a.group) {
      for (const g of a.group) {
        if (g.address) out.push({ name: g.name?.trim() || null, email: g.address.trim().toLowerCase() });
      }
    } else if (a.address) {
      out.push({ name: a.name?.trim() || null, email: a.address.trim().toLowerCase() });
    }
  }
  return out;
}

/** The From header is single-valued; take the first parseable address. */
function primaryAddress(a: PostalAddress | undefined): SimpleAddress | null {
  const first = flattenAddresses(a ? [a] : undefined)[0];
  return first ?? null;
}

/** Take the first Message-ID (angle brackets stripped) from the References / In-Reply-To header. Same convention as `webhook.ts`. */
function firstRef(raw: string | null | undefined): string | null {
  const first = parseReferences(raw)[0];
  return first ? stripAngle(first) : null;
}

function safeFilename(name: string): string {
  return name.replace(/[\\/]/g, '_').replace(/[^A-Za-z0-9._()+\- ]/g, '_').slice(0, 120) || 'attachment';
}

/** A postal-mime attachment's content → bytes. The content may be ArrayBuffer / Uint8Array / string (varies by encoding). */
function toBytes(content: PostalAttachment['content']): Uint8Array | null {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return null;
}

export interface EnvelopeInfo {
  /** Envelope sender (SMTP MAIL FROM). */
  from: string;
  /** Envelope recipient (delivery address = mailbox). */
  to: string;
  /** `inbound_raw.id`, used as the fallback for the synthetic provider id and as the idempotent event id. */
  rawId: string;
}

/**
 * Parse raw MIME → `InboundInput` (same shape as Resend inbound).
 * Attachments are uploaded to R2 as well (`attachments/{rowId}/…`, key rules consistent with existing code).
 */
export async function buildInboundInput(
  env: Env,
  raw: ArrayBuffer | Uint8Array,
  envelope: EnvelopeInfo
): Promise<InboundInput> {
  const email: PostalEmail = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const rowId = uuid();

  const from = primaryAddress(email.from);
  const envelopeFrom = (envelope.from || '').trim().toLowerCase();
  const fromEmail = from?.email || envelopeFrom || null;
  const fromName = from?.name ?? null;

  // Envelope recipient = delivery address (mailbox / delivered_to). CF's `message.to` is exactly that.
  const deliveredTo = envelope.to ? [envelope.to.trim().toLowerCase()] : [];
  const headerTo = flattenAddresses(email.to).map((a) => a.email);
  const cc = flattenAddresses(email.cc).map((a) => a.email);
  const bcc = flattenAddresses(email.bcc).map((a) => a.email);
  const replyTo = flattenAddresses(email.replyTo).map((a) => a.email);

  const messageId = stripAngle(email.messageId);
  const references = email.references ?? null;
  const inReplyTo = stripAngle(email.inReplyTo) ?? firstRef(email.references);

  const html = typeof email.html === 'string' ? email.html : null;
  const text = (typeof email.text === 'string' ? email.text : null) ?? (html ? stripHtml(html) : null);

  const dateSec = email.date ? Math.floor(new Date(email.date).getTime() / 1000) : NaN;

  // Synthetic provider id: prefer Message-ID (real mail always has one, naturally deduped), otherwise fall back to rawId (guaranteed unique).
  const resendId = `cf:${messageId || envelope.rawId}`;

  const attachments: PreparedAttachment[] = [];
  for (const a of email.attachments) {
    const bytes = toBytes(a.content);
    if (!bytes || !bytes.length) continue;
    const contentId = a.contentId ? stripAngle(a.contentId) : null;
    const filename = a.filename || (contentId ? contentId : 'attachment');
    const contentType = (a.mimeType || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
    const inline = contentId != null || a.disposition === 'inline' || a.related === true ? 1 : 0;
    const r2Key = `attachments/${rowId}/${uuid()}-${safeFilename(filename)}`;
    await env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType } });
    attachments.push({ filename, contentType, size: bytes.length, inline, contentId, r2Key });
  }

  return {
    rowId,
    resendId,
    messageId,
    inReplyTo,
    references,
    threadId: rootThreadId({
      references,
      inReplyTo: email.inReplyTo,
      messageId: email.messageId,
      fallback: rowId,
    }),
    mailbox: deliveredTo[0] ?? '',
    fromName,
    fromEmail,
    to: headerTo.length ? headerTo : deliveredTo,
    deliveredTo,
    cc,
    bcc,
    replyTo,
    subject: email.subject ?? null,
    html,
    text,
    receivedAt: Number.isFinite(dateSec) ? dateSec : nowSec(),
    attachments,
  };
}

/**
 * The body of the `email()` handler: **only "keep this message"**, no parsing.
 *
 * - `message.raw` is a **one-shot** ReadableStream; `put` it straight to R2 (streaming, not fully read into memory);
 * - `message.headers` is an independent object that does not consume the stream, used to conveniently grab the Message-ID;
 * - on a store/enqueue failure **do not stay silent**: reject (`setReject`) so the sender gets a bounce, rather than treating it as delivered.
 */
export async function handleInboundEmail(env: Env, message: ForwardableEmailMessage): Promise<void> {
  const rawId = uuid();
  const r2Key = `${RAW_PREFIX}${rawId}.eml`;
  const messageId = stripAngle(message.headers.get('message-id'));
  const subject = message.headers.get('subject');

  // ⚠️ The "intent" must be registered before writing to R2: r2_key is the **planned** key.
  // This way, if the subsequent R2 write fails, the original error text can still be read from inbound_raw (instead of finding nothing, as before).
  let rowCreated = false;
  try {
    await withRetry(() =>
      env.DB.prepare(
        `INSERT INTO inbound_raw
           (id, r2_key, from_email, to_email, size, message_id, subject, received_at, parsed_at, message_row, error, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)`
      )
        .bind(rawId, r2Key, message.from || null, message.to || null, message.rawSize || 0, messageId, subject, nowSec())
        .run()
    );
    rowCreated = true;
  } catch (err) {
    console.error('inbound: create raw row failed:', err);
  }

  try {
    // ⚠️ Do not hand `message.raw` (a ReadableStream) directly to R2.put: every other write in this repo stores "bytes",
    // and the official CF Email Workers example also does `new Response(message.raw).arrayBuffer()` first.
    // Passing the stream directly causes intermittent put failures → setReject → the mail is rejected and inbound_raw is empty (exactly the production symptom).
    const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
    await withRetry(() =>
      env.BUCKET.put(r2Key, rawBytes, {
        httpMetadata: { contentType: 'message/rfc822' },
        customMetadata: { from: message.from || '', to: message.to || '' },
      })
    );
  } catch (err) {
    const detail = `r2 put failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error('inbound:', detail);
    if (rowCreated) await markRawErrorQuiet(env, rawId, detail);
    message.setReject('temporary storage failure');
    return;
  }

  // Registration failed + write succeeded → the raw message is in R2 but has no index row: still reject (otherwise the mail "looks successful" but no one can parse it).
  if (!rowCreated) {
    message.setReject('temporary storage failure');
    return;
  }

  if (!env.INBOUND_QUEUE) {
    // No queue configured (the one-click deploy template leaves it out): parse inline instead. Raw message + index row are
    // already durable, so a failure here is not a loss — the */15 cron parses whatever is still pending.
    try {
      await storeRawMessage(env, rawId);
    } catch (err) {
      console.error('inbound: inline parse failed:', rawId, err);
    }
    return;
  }
  try {
    await withRetry(() => env.INBOUND_QUEUE!.send({ rawId }));
  } catch (err) {
    // An enqueue failure does not break "never lose": raw + inbound_raw are both present, and the replay entry point is inbound_raw(parsed_at IS NULL).
    console.error('inbound: enqueue failed:', rawId, err);
  }
}

async function markRawParsed(env: Env, rawId: string, messageRow: string): Promise<void> {
  await env.DB.prepare('UPDATE inbound_raw SET parsed_at = ?, message_row = ?, error = NULL WHERE id = ?')
    .bind(nowSec(), messageRow, rawId)
    .run();
}

async function markRawError(env: Env, rawId: string, error: string): Promise<void> {
  await env.DB.prepare('UPDATE inbound_raw SET parsed_at = ?, error = ? WHERE id = ?')
    .bind(nowSec(), error.slice(0, 500), rawId)
    .run();
}

async function markRawErrorQuiet(env: Env, rawId: string, error: string): Promise<void> {
  try {
    await markRawError(env, rawId, error);
  } catch (err) {
    console.error('inbound: record raw error failed:', rawId, err);
  }
}

/**
 * The body of the `queue()` consumer: parse and store one by one.
 *
 * ⚠️ `ack()` / `retry()` per message — Queue retries batches all-or-nothing by default, and one poisonous message stalls the whole batch.
 * ⚠️ Queue is **at-least-once**: rely on `inbound_raw.message_row` (non-empty = already stored) and
 * `findInboundByResendId` for double idempotency, so the same message consumed twice is not stored twice.
 */
/** Outcome of turning one registered raw message into an inbox row. */
export type RawStoreResult = 'stored' | 'skipped' | 'permanent' | 'transient';

/**
 * Parse + store **one** registered raw message (idempotent).
 *
 * Shared by the `queue()` consumer and the no-queue inline path, so both behave identically:
 *   · `skipped`   — nothing to do (unknown id, or the message row already exists from an at-least-once delivery)
 *   · `permanent` — can never succeed (raw object missing, unparsable, D1 row over the 2 MB limit, constraint conflict):
 *                     the reason is recorded and `parsed_at` is set so the recovery cron stops replaying it
 *   · `transient` — a momentary D1/R2 failure; `parsed_at` stays NULL so the cron retries later (never lose mail)
 *   · `stored`    — the message is in the inbox
 */
export async function storeRawMessage(env: Env, rawId: string): Promise<RawStoreResult> {
  const row = await env.DB.prepare('SELECT * FROM inbound_raw WHERE id = ?')
    .bind(rawId)
    .first<InboundRawRow>();
  if (!row) return 'skipped';
  if (row.message_row) return 'skipped'; // Already stored (duplicate consumption from at-least-once delivery)

  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) {
    await markRawError(env, rawId, 'raw object missing in R2');
    return 'permanent';
  }

  let input: InboundInput;
  try {
    const bytes = new Uint8Array(await obj.arrayBuffer());
    input = await buildInboundInput(env, bytes, {
      from: row.from_email || '',
      to: row.to_email || '',
      rawId,
    });
  } catch (err) {
    // A parse failure is **permanent** (retrying the same bytes yields the same result): record the reason; the raw message stays in R2.
    await markRawError(env, rawId, `parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'permanent';
  }

  // Before storing, check "does the row size exceed the D1 hard limit (2MB)". On a hit it **permanently** cannot be written:
  // mark terminal (error + parsed_at) so the cron does not replay it every 15 minutes forever.
  const rowBytes =
    utf8Bytes(input.html) + utf8Bytes(input.text) + utf8Bytes(input.references) + utf8Bytes(input.subject);
  if (rowBytes > MAX_MESSAGE_ROW_BYTES) {
    await markRawError(env, rawId, `message too large for D1 row (~${Math.round(rowBytes / 1024)}KB > 2MB limit); raw kept in R2`);
    return 'permanent';
  }

  try {
    const existing = await findInboundByResendId(env, input.resendId);
    if (existing) {
      await markRawParsed(env, rawId, existing);
      return 'stored';
    }
    await saveInbound(env, input, rawId);
    await markRawParsed(env, rawId, input.rowId);
    return 'stored';
  } catch (err) {
    const detail = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    // Permanent failure (over limit / constraint conflict): retrying the same data is useless → mark terminal, stop retrying.
    if (isPermanentSaveError(err)) {
      await markRawError(env, rawId, `permanent save failure: ${detail}`);
      return 'permanent';
    }
    // Transient (momentary D1/R2 failure): retry; if it still fails after retrying, **keep it pending** (do not clear parsed_at)
    // for the recovery cron to come back to later.
    // ⚠️ Never just mark it error+parsed_at — a message that happens to hit a brief failure would then be stuck forever.
    const attempts = (row.attempts || 0) + 1;
    console.error(`inbound: save failed (attempt ${attempts}):`, rawId, err);
    if (attempts >= MAX_RAW_ATTEMPTS) {
      await env.DB.prepare('UPDATE inbound_raw SET attempts = 0, error = ? WHERE id = ?')
        .bind(`save kept failing (×${attempts}): ${detail}`, rawId)
        .run();
      return 'permanent'; // the cron still replays it as a fallback, so a poisonous message does not block the batch
    }
    await env.DB.prepare('UPDATE inbound_raw SET attempts = ? WHERE id = ?').bind(attempts, rawId).run();
    return 'transient';
  }
}

/**
 * The body of the `queue()` consumer: parse and store one by one.
 *
 * ⚠️ `ack()` / `retry()` per message — Queue retries batches all-or-nothing by default, and one poisonous message stalls the whole batch.
 * ⚠️ Queue is **at-least-once**: `storeRawMessage` relies on `inbound_raw.message_row` and `findInboundByResendId` for
 * double idempotency, so the same message consumed twice is not stored twice.
 */
export async function handleInboundQueue(batch: MessageBatch<InboundQueueMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const rawId = msg.body?.rawId;
    if (!rawId) {
      msg.ack();
      continue;
    }
    const result = await storeRawMessage(env, rawId);
    if (result === 'transient') msg.retry();
    else msg.ack();
  }
}

/**
 * Body of the recovery cron (the never-lose fallback): re-enqueue mail that is "already in R2 but not fully parsed".
 *
 * Covers three kinds of silent stall:
 *   ① `INBOUND_QUEUE.send` failed in `email()` (raw + index are both present, it just never entered the queue);
 *   ② the consumer crashed / the invocation timed out, and the message was not fully processed;
 *   ③ transient store failures exceeded the threshold and were marked "pending" above.
 *
 * Idempotent: duplicate enqueues are doubly guarded by `inbound_raw.message_row` (already stored → skipped) + `findInboundByResendId`.
 * Returns the number successfully enqueued this time. CF does not store mail, so this cron is the self-healing loop for "received but not in the inbox".
 */
export async function replayPendingInbound(env: Env, limit = 100): Promise<number> {
  const rows = await env.DB.prepare(
    'SELECT id FROM inbound_raw WHERE parsed_at IS NULL ORDER BY received_at ASC LIMIT ?'
  )
    .bind(limit)
    .all<{ id: string }>();
  let n = 0;
  for (const r of rows.results ?? []) {
    const queue = env.INBOUND_QUEUE;
    // No queue binding: parse here and now with the very same routine the consumer would run.
    if (!queue) {
      try {
        const result = await storeRawMessage(env, r.id);
        if (result === 'stored') n++;
      } catch (err) {
        console.error('inbound: inline replay failed:', r.id, err);
      }
      continue;
    }
    try {
      await withRetry(() => queue.send({ rawId: r.id }));
      n++;
    } catch (err) {
      console.error('inbound: replay enqueue failed:', r.id, err);
    }
  }
  return n;
}
