import type { Env, SendResult } from './types';
import { escapeHtml, parseJsonObject, domainOf, isPlaceholderDomain } from './util';
import { explainResendError, domainOfFrom } from './resend-errors';

/** Convert plain text into safely displayable HTML (escape + line breaks). */
export function textToHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => escapeHtml(l))
    .join('<br>');
}

export function buildFrom(env: Env): string {
  const name = (env.SEND_FROM_NAME || '').trim();
  const addr = (env.SEND_FROM_ADDRESS || '').trim();
  if (!addr) return '';
  return name ? `${name} <${addr}>` : addr;
}

/** Take the local part of an address as the display name (`zhanglili@example.com` → `zhanglili`). */
function localPart(addr: string): string {
  const at = addr.indexOf('@');
  return at > 0 ? addr.slice(0, at) : addr;
}

export interface SenderIdentity {
  /** The full form of the Resend `from` field (`Name <address>` or a bare address). */
  from: string;
  /** The sender address actually used (lowercase, stored as `mailbox`). */
  address: string;
  /** The display name actually used (empty string = no display name). */
  name: string;
}

/**
 * Resolve the sender identity (`from` / address / display name) for the given mailbox.
 *
 * ⚠️ It once applied the global `SEND_FROM_NAME` as the display name to **all** mailboxes in the same domain — so mail sent from
 * `zhanglili@example.com` appeared to the recipient as "support", making multiple accounts
 * completely indistinguishable. Production data measured: inbound `from_name` was always `"support"`.
 *
 * Current convention (three tiers):
 *  1. the requested address is the default address (`SEND_FROM_ADDRESS`) → use `SEND_FROM_NAME` (the brand name is still configurable);
 *  2. another mailbox in the same domain → use the **address prefix** as the display name, so accounts are distinguishable;
 *  3. non-default domain / unspecified → fall back to the default sender as a whole (existing protection, unchanged).
 */
export function senderIdentity(env: Env, mailbox: string): SenderIdentity {
  const addr = (mailbox || '').trim().toLowerCase();
  const def = (env.SEND_FROM_ADDRESS || '').trim().toLowerCase();
  const domains = sendingDomains(env);
  const mboxDomain = domainOf(addr) ?? '';
  const defaultName = (env.SEND_FROM_NAME || '').trim();

  // The gate is the **set of configured domains**: any local part on any of them may send (custom senders work even if they
  // differ from the default address). Empty or cross-domain senders fall back to the default, so we never
  // impersonate an unverified domain.
  if (addr && mboxDomain && domains.includes(mboxDomain)) {
    const name = addr === def ? defaultName : localPart(addr);
    return { from: name ? `${name} <${addr}>` : addr, address: addr, name };
  }
  return { from: buildFrom(env), address: def, name: defaultName };
}

/**
 * All domains allowed to send, in display order: the primary domain (SENDING_DOMAIN — derived from the oldest enabled
 * row of the domains table), the default from address's domain, then the configured set (SENDING_DOMAINS, also derived
 * from the domains table). No part of this comes from app_config any more.
 *
 * ⚠️ The set must be a **union**, not "SENDING_DOMAINS else the single domain": a deployment configured only through
 * env vars (SEND_FROM_ADDRESS / SENDING_DOMAIN) has no app_config.domain, so the moment the wizard adds the first
 * in-app domain the derived SENDING_DOMAINS becomes non-empty and the original domain silently vanishes from the
 * top-bar switcher, from /api/account and from the sender whitelist (the "added a domain and lost the old one" bug).
 */
export function sendingDomains(env: Env): string[] {
  const out: string[] = [];
  const add = (raw: string | null | undefined): void => {
    const d = String(raw ?? '').trim().toLowerCase();
    if (d && !out.includes(d)) out.push(d);
  };
  const configured = Boolean((env.SENDING_DOMAIN || '').trim() || (env.SENDING_DOMAINS || '').trim());
  // The primary/legacy domain leads: it is what the pre-multi-domain config (and every fallback) called "the domain".
  add(env.SENDING_DOMAIN);
  // The default sender's domain is allowed by definition (buildFrom() uses it when no mailbox is chosen), so it belongs
  // in the set even when it never made it into app_config / the domains table. It comes before the table's domains so
  // that an env-configured deployment keeps its original primary domain.
  // Exception: the template placeholder is dropped once a real domain is configured — a deployment that never replaced
  // `SEND_FROM_ADDRESS = inbox@example.com` must not grow an "example.com" entry in the domain switcher. When the
  // default address is the *only* thing configured it is kept as-is (that is the pre-existing single-domain behavior).
  const fromDomain = domainOf((env.SEND_FROM_ADDRESS || '').trim().toLowerCase());
  if (fromDomain && !(configured && isPlaceholderDomain(fromDomain))) add(fromDomain);
  for (const raw of (env.SENDING_DOMAINS || '').split(',')) add(raw);
  return out;
}

/** The primary sending domain: the first of sendingDomains(). */
export function sendingDomain(env: Env): string {
  return sendingDomains(env)[0] || '';
}

/** Build the sender for the given mailbox; fall back to the default sender if the mailbox's domain is not the default sending domain. */
export function senderFromMailbox(env: Env, mailbox: string): string {
  return senderIdentity(env, mailbox).from;
}

/**
 * The Resend key to use for an address / `from` value, most specific first:
 *
 *   domains.resend_api_key (bound to the domain, built into env.RESEND_API_KEYS)
 *     → env RESEND_API_KEY (deployment-wide fallback)
 *
 * There is deliberately **no** global database level: two domains can live in different Resend accounts, so one
 * "global" key can never be right for both — it only created the illusion that a domain was configured while it was
 * quietly using another account's key (the classic "Resend shows the domain verified, but sending says it is not").
 *
 * ⚠️ `from` is the **full header value**, e.g. `support <support@example.com>` (see senderIdentity). Using
 * util.domainOf() here returned `example.com>` — the `>` broke the per-domain lookup, the key silently fell back to the
 * env one, and sending from a domain bound to another Resend account failed with "domain is not verified" while the
 * self-check (which resolves the key from the domain name) was all green.
 */
export function resendKeyFor(env: Env, from?: string | null): string {
  const domain = domainOfFrom(from);
  if (domain) {
    const perDomain = parseJsonObject<Record<string, string>>(env.RESEND_API_KEYS || '');
    const key = perDomain && typeof perDomain[domain] === 'string' ? perDomain[domain].trim() : '';
    if (key) return key;
  }
  return (env.RESEND_API_KEY || '').trim();
}

export interface ResendAttachment {
  filename: string;
  content: string; // base64
  content_type?: string;
}

interface ResendRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: ResendAttachment[];
  /** Sender override (e.g. send from the selected mailbox); defaults to the env default */
  from?: string;
}

/** Send mail via the Resend HTTP API (avoiding a Node dependency in the Worker). */
export async function resendSend(env: Env, req: ResendRequest): Promise<SendResult> {
  const from = req.from ?? buildFrom(env);
  // The key follows the sending domain: domains in different Resend accounts each have their own.
  const apiKey = resendKeyFor(env, from);
  if (!apiKey) {
    const d = domainOfFrom(from);
    return { ok: false, error: d ? `未配置 RESEND_API_KEY（${d} 没有绑定 Key，环境变量里也没有）` : '未配置 RESEND_API_KEY' };
  }
  if (!from) return { ok: false, error: '未配置 SEND_FROM_ADDRESS' };
  // Any one of to / cc / bcc non-empty is enough to send (a BCC-only email is legal)
  const hasRecipient = req.to.length > 0 || (req.cc?.length ?? 0) > 0 || (req.bcc?.length ?? 0) > 0;
  if (!hasRecipient) return { ok: false, error: '缺少收件人' };

  let resp: Response;
  try {
    resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: req.to,
        cc: req.cc && req.cc.length ? req.cc : undefined,
        bcc: req.bcc && req.bcc.length ? req.bcc : undefined,
        subject: req.subject || '(no subject)',
        html: req.html,
        text: req.text,
        headers: req.headers,
        attachments: req.attachments && req.attachments.length ? req.attachments : undefined,
      }),
    });
  } catch (err) {
    return { ok: false, error: `网络错误: ${String(err)}` };
  }

  const body = parseJsonObject<{ id?: string; message?: string }>(await resp.text());
  if (!resp.ok) {
    const msg = body?.message || body?.id || `HTTP ${resp.status}`;
    // Keep Resend's wording, but say what to do about it ("domain is not verified" is almost always a *key* problem,
    // not a DNS problem — see src/resend-errors.ts).
    return { ok: false, error: `Resend 返回错误: ${explainResendError(msg, { from })}` };
  }
  if (!body?.id) return { ok: false, error: 'Resend 未返回邮件 id' };
  return { ok: true, id: body.id };
}

/** Generate the reply subject: add a Re: prefix by default. */
export function replySubject(subject: string | null | undefined): string {
  const s = (subject || '').trim();
  if (!s) return '(no subject)';
  return /^\s*re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** Generate the forward subject: add a Fwd: prefix by default (not stacked again if a Fwd:/Fw: prefix is already present). */
export function forwardSubject(subject: string | null | undefined): string {
  const s = (subject || '').trim();
  if (!s) return '(no subject)';
  return /^\s*fwd?\s*:/i.test(s) ? s : `Fwd: ${s}`;
}
