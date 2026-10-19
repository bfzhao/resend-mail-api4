import type { Address } from './types';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** Parse an address of the form `Name <email>` / `<email>` / `email` and return the address entity. */
export function parseAddress(raw: string | null | undefined): Address | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = /^\s*(?:"([^"]*)"|([^<]*?))\s*<([^>]+)>\s*$/.exec(s);
  if (m) {
    const name = (m[1] || m[2] || '').trim();
    const email = m[3].trim().toLowerCase();
    if (email) return { name: name || null, email };
    return null;
  }
  // A plain email without angle brackets, or with only the email part left
  const t = s.replace(/^.*<([^>]+)>.*$/, '$1').trim().toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return { name: null, email: t };
  return null;
}

/** Parse a list of raw addresses (strings) into an Address list, dropping invalid entries. */
export function parseAddressList(list: unknown): Address[] {
  if (Array.isArray(list)) {
    return list
      .map((x) => (typeof x === 'string' ? parseAddress(x) : null))
      .filter((x): x is Address => x !== null);
  }
  if (typeof list === 'string') {
    const one = parseAddress(list);
    return one ? [one] : [];
  }
  return [];
}

export function toEmailList(addrs: Address[]): string[] {
  return addrs.map((a) => a.email);
}

/**
 * Domain part of an email address, lowercased (for the derived `mailbox_domain` column / per-domain filtering).
 * Returns null when the address has no `@` or is empty.
 */
export function domainOf(addr: string | null | undefined): string | null {
  const s = (addr ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at > 0 && at < s.length - 1 ? s.slice(at + 1) : null;
}

/**
 * The RFC 2606 reserved names used as placeholders in the deployment template (`SEND_FROM_ADDRESS = inbox@example.com`).
 * They can never be verified as sending domains, so they must never be shown or adopted as a real domain.
 */
export function isPlaceholderDomain(domain: string | null | undefined): boolean {
  const d = String(domain ?? '').trim().toLowerCase();
  return d === 'example.com' || d === 'example.net' || d === 'example.org';
}

export function jsonArr(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

/** Strip the angle brackets from both ends of a message_id / content-id. */
export function stripAngle(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (t.startsWith('<') && t.endsWith('>')) return t.slice(1, -1);
  return t || null;
}

/**
 * Extract all Message-IDs from the References / In-Reply-To headers, returning the **canonical angle-bracketed form**.
 *
 * ⚠️ **Production measurement (2026-10-15)**: the `headers.references` value returned by the Resend receiving API is **not**
 * an RFC 5322 space-separated list, but **JSON array text** — of the form `["<a@b>","<c@d>"]`.
 *
 * The old implementation used `refs.split(/\s+/)[0]` to take the first item, which yielded the whole JSON text (including the `["` prefix),
 * and `stripAngle` only recognized leading/trailing angle brackets and could not remove the square brackets, so `thread_id` ended up as
 * a malformed value like `["<a@b>","<c@d>"]`. Worse, `reply()` spliced this JSON text verbatim into the
 * new References sent back to Resend, and when the other party replied the escaping level went one deeper
 * (measured nesting already four levels deep, `["<\",\"<\\\",\\\"<\\\\\\\"...`),
 * causing **the same physical thread to get a different thread_id on every round trip** — what the user sees is
 * "several back-and-forths, but only two messages in the thread panel".
 *
 * So it no longer splits on separators, but instead **extracts all `<...>`**: JSON arrays, space-separated, single values,
 * and historically escape-polluted values all extract correctly (the first `<...>` inside a nested string
 * is exactly the real root Message-ID).
 *
 * Returns with angle brackets, convenient for directly assembling headers (`join(' ')` is a valid References).
 */
export function parseReferences(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const re = /<([^<>]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const id = m[1].trim();
    if (id) out.push(`<${id}>`);
  }
  if (out.length) return out;
  // Fallback: the whole string has no `<...>` at all, but is itself a **clean bare Message-ID**
  // (non-canonical form that the old implementation accepted tolerantly via stripAngle, which must not be lost by this change).
  // The criterion is deliberately tightened to "a single token with no separators / quotes / square brackets" —
  // otherwise a malformed string like `["", ""]` would be split into a pile of junk ids.
  const t = raw.trim();
  if (/^[^\s,<>[\]"']+$/.test(t)) return [`<${t}>`];
  return [];
}

/** Take the first parseable Message-ID (without angle brackets); return null when there is no `<...>`. */
function firstMessageId(raw: string | null | undefined): string | null {
  const first = parseReferences(raw)[0];
  return first ? stripAngle(first) : null;
}

/**
 * Thread root: the earliest Message-ID in the References chain (shared by the whole thread),
 * falling back to in_reply_to / its own message_id when unavailable. The result is de-angle-bracketed for easy grouping.
 *
 * Parsing always goes through `parseReferences()` (see its notes: Resend's References is JSON array text,
 * and splitting on whitespace yields a malformed root). `messageId` additionally accepts a **bare id without angle brackets**
 * — an outbound mail's `message_id` stores an internal uuid.
 */
export function rootThreadId(opts: { references?: string | null; inReplyTo?: string | null; messageId?: string | null; fallback?: string }): string {
  const root = firstMessageId(opts.references);
  if (root) return root;
  const inReply = firstMessageId(opts.inReplyTo);
  if (inReply) return inReply;
  const own = firstMessageId(opts.messageId) ?? stripAngle(opts.messageId);
  if (own) return own;
  return opts.fallback ?? '';
}

/**
 * Whether `thread_id` is a **normal value** that we computed ourselves.
 *
 * Historical data stored malformed JSON text (see `parseReferences`), characterized by square brackets / quotes /
 * backslashes / angle brackets / whitespace. When replying, if the original mail's `thread_id` is clean it is inherited directly
 * (semantically "a reply of course belongs to the original mail's thread", and it also covers incoming mail with a missing References header);
 * if malformed, fall back to re-deriving from References.
 */
export function isSaneThreadId(v: string | null | undefined): boolean {
  const s = (v ?? '').trim();
  return !!s && !/[\s[\]"\\<>]/.test(s);
}

/** Get a value from a header array by name (case-insensitive); there may be multiple duplicate names. */
export function headerValue(headers: unknown, name: string): string | null {
  if (!Array.isArray(headers)) return null;
  const lname = name.toLowerCase();
  for (const h of headers) {
    if (h && typeof h === 'object' && 'name' in h) {
      const hn = String((h as { name: unknown }).name);
      if (hn.toLowerCase() === lname && 'value' in h) {
        const v = String((h as { value: unknown }).value);
        if (v) return v;
      }
    }
  }
  return null;
}

/** Get a value from a headers object (key names of arbitrary case). */
export function headerValueMap(headers: Record<string, unknown> | null | undefined, name: string): string | null {
  if (!headers) return null;
  const lname = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lname && v != null) return String(v);
  }
  return null;
}

/** Crudely extract plain text from HTML, for the default body_text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** base64 -> bytes (the Worker runtime has no Buffer). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * bytes -> base64 (the Worker runtime has no Buffer).
 * Chunked String.fromCharCode avoids `apply` blowing the stack on very large arrays (attachments can reach tens of MB).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Generate a safe Content-Disposition value (preserving non-ASCII filenames). */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').replace(/\s+/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function parseJsonObject<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
