import type { Env } from './types';
import { json, nowSec, parseAddress, parseAddressList, headerValueMap, stripAngle, stripHtml, uuid, rootThreadId, parseReferences } from './util';
import { Resend } from 'resend';
import { saveInbound, findInboundByResendId } from './repo';
import type { InboundInput } from './repo';
import { fetchReceivedEmail, listReceivedAttachmentDownloads, downloadSignedUrl } from './receiving';
import type { ReceivedEmail, AttachmentDownloadItem } from './receiving';

// ============ Resend standard Webhook signature verification ============
// Uses the official Resend SDK's resend.webhooks.verify (internally an HMAC-SHA256 check based on Svix's standardwebhooks library).
// Ref: https://resend.com/docs/webhooks/verify-webhooks-requests
// verify only does local computation and makes no network request; constructing Resend only needs a placeholder key.
const resendClient = new Resend('re_00000000000000000000000000000000');

/** Verify the Svix signature against the raw body text. Returns false if invalid/missing. */
export function verifySignature(secret: string, rawBody: string, headers: Headers): boolean {
  const id = headers.get('svix-id') ?? headers.get('webhook-id');
  const timestamp = headers.get('svix-timestamp') ?? headers.get('webhook-timestamp');
  const signature = headers.get('svix-signature') ?? headers.get('webhook-signature');
  if (!id || !timestamp || !signature) return false;

  try {
    const options = {
      payload: rawBody,
      headers: { id, timestamp, signature },
      webhookSecret: secret,
    } as Parameters<typeof resendClient.webhooks.verify>[0];
    resendClient.webhooks.verify(options);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(request: Request): Promise<{ text: string; payload: T | null }> {
  const text = await request.text();
  try {
    return { text, payload: JSON.parse(text) as T };
  } catch {
    return { text, payload: null };
  }
}

// ============ Inbound receive (email.received) ============

interface SvixEnvelope {
  id?: string;
  type?: string;
  created_at?: string;
  data?: Record<string, unknown>;
}

function safeFilename(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/[^A-Za-z0-9._()+\- ]/g, '_').slice(0, 120) || 'attachment';
  return base;
}

async function uploadToBucket(
  env: Env,
  messageId: string,
  filename: string,
  contentType: string,
  bytes: Uint8Array
): Promise<string> {
  const key = `attachments/${messageId}/${uuid()}-${safeFilename(filename)}`;
  await env.BUCKET.put(key, bytes, {
    httpMetadata: { contentType: contentType || 'application/octet-stream' },
  });
  return key;
}

function eventIdFrom(request: Request, payload?: SvixEnvelope | null): string | null {
  // The Svix event ID is in the request headers (svix-id / webhook-id); the payload usually has no top-level id
  return (
    request.headers.get('svix-id') ??
    request.headers.get('webhook-id') ??
    payload?.id ??
    null
  );
}

/** Determine which local receiving address (mailbox) this inbound mail belongs to. */
/**
 * Normalize the recipient list.
 *
 * ⚠️ The webhook payload's `data.to` and the Received Emails API's `email.to` **may both be strings**,
 * not necessarily the array we assume. `parseAddressList()` handles both (util.ts has a dedicated branch for strings),
 * but historically this hand-wrote `Array.isArray(...)` checks everywhere, inconsistent with it — measured to cause 11 messages
 * actually sent to support@example.com to have `mailbox` stored as an empty string, shown in the sidebar as "(unknown)".
 * Go through this function uniformly; do not hand-write type checks again.
 */
function recipientList(email: ReceivedEmail, data: Record<string, unknown>): ReturnType<typeof parseAddressList> {
  const fromApi = parseAddressList(email.to);
  if (fromApi.length) return fromApi;
  return parseAddressList(data['to']);
}

/**
 * The real `To:` header.
 *
 * ⚠️ **Do not use `email.to` as the recipient** (learned the hard way): the `to` returned by the Resend receiving API is the
 * **delivery address (envelope recipient)**, not the `To:` header. Production data measured — sender
 * erin@example.com sends to `To: frank@example.net`, `Cc: dana@example.com`,
 * and this message in dana's inbox stores as `email.to = ["dana@example.com"]`,
 * `email.cc = ["dana@example.com"]`; the real To header is kept only in `headers.to`.
 * Taking `email.to` directly as the recipient → the detail page's "recipient" shows the user themselves.
 *
 * Resend's official docs confirm this division of labor: the receiving event's `from` is only the bare address,
 * and the display name is kept in `headers.from` — i.e. `headers` is the raw header table.
 * When `headers.to` is unavailable, fall back to the delivery address (behavior does not regress).
 */
function headerRecipientList(email: ReceivedEmail): ReturnType<typeof parseAddressList> {
  return parseAddressList(headerValueMap(email.headers, 'to'));
}

function pickMailbox(email: ReceivedEmail, data: Record<string, unknown>): string {
  // 1) Resend's official recommendation: received_for is the actual delivery address of this message
  const receivedFor = data['received_for'];
  if (Array.isArray(receivedFor) && receivedFor.length && typeof receivedFor[0] === 'string') {
    const m = receivedFor[0].trim();
    if (m) return m.toLowerCase();
  }
  // 2) Fall back to to (both string/array must be handled, see the notes on recipientList)
  const tos = recipientList(email, data);
  if (tos.length) return tos[0].email;
  return '';
}

/** Take the first Message-ID in the header (angle brackets already stripped). The header value may be JSON array text, see util.parseReferences. */
function firstRef(raw: string | null): string | null {
  const first = parseReferences(raw)[0];
  return first ? stripAngle(first) : null;
}

export async function handleInbound(request: Request, env: Env): Promise<Response> {
  if (!env.RESEND_WEBHOOK_SECRET) {
    return json({ error: 'webhook secret not configured (RESEND_WEBHOOK_SECRET)' }, 503);
  }
  if (!env.RESEND_API_KEY) {
    return json({ error: 'RESEND_API_KEY not configured (needed to fetch received email content)' }, 503);
  }

  const { text, payload } = await readJson<SvixEnvelope>(request);
  const valid = verifySignature(env.RESEND_WEBHOOK_SECRET, text, request.headers);
  if (!valid) return json({ error: 'invalid signature' }, 401);

  const eventId = eventIdFrom(request, payload);
  const data = payload?.data;
  // The official email.received payload has only type/created_at/data at the top level, no id
  if (!eventId || !payload || payload.type !== 'email.received' || !data) {
    return json({ error: 'unexpected payload' }, 400);
  }
  const emailId = data && typeof data['email_id'] === 'string' ? data['email_id'] : null;
  if (!emailId) {
    return json({ error: 'unexpected payload: missing email_id' }, 400);
  }

  // Idempotency: the same event already processed → 200 directly
  const dup = await env.DB.prepare('SELECT id FROM webhook_deliveries WHERE id = ?')
    .bind(eventId)
    .first();
  if (dup) return new Response('OK', { status: 200 });

  // The same email already stored (duplicate delivery); only record this event
  const existingId = await findInboundByResendId(env, emailId);
  if (existingId) {
    await env.DB.prepare('INSERT OR IGNORE INTO webhook_deliveries (id, processed_at) VALUES (?, ?)')
      .bind(eventId, nowSec())
      .run();
    return new Response('OK', { status: 200 });
  }

  // The webhook only has metadata; the body/headers must be fetched via the Received Emails API (html_format=cid keeps inline image references)
  let email: ReceivedEmail;
  try {
    email = await fetchReceivedEmail(env, emailId);
  } catch (err) {
    console.error('fetchReceivedEmail failed:', err);
    return json({ error: 'failed to fetch received email content', detail: String(err instanceof Error ? err.message : err) }, 502);
  }

  const rowId = uuid();
  const html = typeof email.html === 'string' ? email.html : null;
  const emailText = typeof email.text === 'string' ? email.text : null;
  const textBody = emailText ?? (html ? stripHtml(html) : null);

  const createdAtRaw =
    email.created_at ?? (typeof data['created_at'] === 'string' ? data['created_at'] : '') ?? '';
  const createdAt = createdAtRaw ? Math.floor(new Date(createdAtRaw).getTime() / 1000) : nowSec();

  const fromRaw = email.from ?? (typeof data['from'] === 'string' ? data['from'] : '');
  const from = parseAddress(fromRaw) ?? null;
  const fromDisplay = parseAddress(headerValueMap(email.headers, 'from'));
  const fromName = fromDisplay?.name ?? from?.name ?? null;
  const fromEmail = (from?.email ?? fromRaw) || null;

  const rawMessageId =
    email.message_id ?? (typeof data['message_id'] === 'string' ? data['message_id'] : null);

  // Thread grouping: take the root Message-ID from References/In-Reply-To
  const refsRaw = headerValueMap(email.headers, 'References');
  const inReplyRaw = headerValueMap(email.headers, 'In-Reply-To');
  const mailbox = pickMailbox(email, data);
  // Delivery address (envelope recipient) — Resend's `to`; the real To header goes via headers.to (see the notes on headerRecipientList)
  const deliveredTo = recipientList(email, data).map((a) => a.email);
  const headerTo = headerRecipientList(email).map((a) => a.email);

  const input: InboundInput = {
    rowId,
    resendId: emailId,
    messageId: stripAngle(rawMessageId),
    // In-Reply-To is likewise in "JSON array text" form (see util.parseReferences);
    // a direct stripAngle only removes the outer angle brackets and leaves a `["...` remnant.
    inReplyTo: firstRef(inReplyRaw),
    references: refsRaw ?? null,
    threadId: rootThreadId({
      references: refsRaw,
      inReplyTo: inReplyRaw,
      messageId: rawMessageId,
      fallback: rowId,
    }),
    mailbox,
    fromName,
    fromEmail,
    to: headerTo.length ? headerTo : deliveredTo,
    deliveredTo,
    cc: parseAddressList(email.cc ?? data['cc']).map((a) => a.email),
    bcc: parseAddressList(email.bcc ?? data['bcc']).map((a) => a.email),
    replyTo: parseAddressList(email.reply_to ?? []).map((a) => a.email),
    subject: email.subject ?? (typeof data['subject'] === 'string' ? data['subject'] : null),
    html,
    text: textBody,
    receivedAt: Number.isFinite(createdAt) ? createdAt : nowSec(),
    attachments: [],
  };

  // Download attachments to R2: get a signed download_url via the attachments API
  const metas = Array.isArray(email.attachments) ? email.attachments : [];
  if (metas.length) {
    let downloads: Map<string, AttachmentDownloadItem>;
    try {
      downloads = await listReceivedAttachmentDownloads(env, emailId);
    } catch (err) {
      console.error('listReceivedAttachmentDownloads failed:', err);
      downloads = new Map();
    }
    for (const meta of metas) {
      const dl = downloads.get(meta.id);
      if (!dl) {
        console.error('no download url for attachment:', meta.id);
        continue;
      }
      try {
        const downloaded = await downloadSignedUrl(dl.download_url);
        let contentType =
          (downloaded.contentType && !downloaded.contentType.startsWith('application/octet-stream'))
            ? downloaded.contentType
            : (meta.content_type || 'application/octet-stream');
        if (contentType.includes(';')) contentType = contentType.split(';')[0].trim();

        const contentId = meta.content_id ? stripAngle(meta.content_id) : null;
        const inline =
          contentId != null || meta.content_disposition === 'inline' ? 1 : 0;
        const r2Key = await uploadToBucket(
          env,
          rowId,
          meta.filename || 'attachment',
          contentType,
          downloaded.bytes
        );
        input.attachments.push({
          filename: meta.filename || 'attachment',
          contentType,
          size: downloaded.bytes.length,
          inline,
          contentId,
          r2Key,
        });
      } catch (err) {
        console.error('attachment store failed:', meta.id, err);
      }
    }
  }

  try {
    await saveInbound(env, input, eventId);
  } catch (err) {
    // Conflict/transient error: return 500 so Resend retries later (the idempotency table guarantees no duplication)
    console.error('saveInbound failed:', err);
    return json({ error: `storage failed: ${err}` }, 500);
  }

  return new Response('OK', { status: 200 });
}

// ============ Outbound receipts (email.sent / delivered / ...) ============
const STATUS_MAP: Record<string, string> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complaint',
  'email.failed': 'failed',
};

export async function handleEvents(request: Request, env: Env): Promise<Response> {
  const secret = env.RESEND_EVENTS_SECRET || env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return json({ error: 'webhook secret not configured (RESEND_EVENTS_SECRET / RESEND_WEBHOOK_SECRET)' }, 503);
  }
  const { text, payload } = await readJson<SvixEnvelope>(request);
  const valid = verifySignature(secret, text, request.headers);
  if (!valid) return json({ error: 'invalid signature' }, 401);

  const eventId = eventIdFrom(request, payload);
  const type = payload?.type;
  const data = payload?.data;
  if (!eventId || !type || !data) return json({ error: 'unexpected payload' }, 400);
  if (!type.startsWith('email.')) return new Response('OK', { status: 200 });

  const resendEmailId = (data['email_id'] as string) ?? (data['id'] as string) ?? null;
  const status = STATUS_MAP[type];

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      'INSERT OR IGNORE INTO webhook_deliveries (id, processed_at) VALUES (?, ?)'
    ).bind(eventId, nowSec()),
  ];

  if (resendEmailId) {
    const row = await env.DB.prepare('SELECT id, direction FROM messages WHERE resend_id = ? LIMIT 1')
      .bind(resendEmailId)
      .first<{ id: string; direction: string }>();
    if (row) {
      stmts.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO delivery_events (id, message_id, event_type, created_at, data) VALUES (?, ?, ?, ?, ?)'
        ).bind(eventId, row.id, type, nowSec(), text)
      );
      if (status) {
        stmts.push(
          env.DB.prepare('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?').bind(status, nowSec(), row.id)
        );
      }
    }
  }

  await env.DB.batch(stmts);
  return new Response('OK', { status: 200 });
}
