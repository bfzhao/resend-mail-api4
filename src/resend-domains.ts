/**
 * Resend domain API client (used by the setup wizard to "add sending authentication for a domain").
 *
 * Flow: POST /domains to create the domain → get the DKIM/SPF/DMARC records → (written to the user's DNS by cloudflare.ts)
 *      → POST /domains/:id/verify to trigger verification → GET /domains/:id to poll status.
 */

import { explainResendError } from './resend-errors';

const RESEND_API = 'https://api.resend.com';

export class ResendError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ResendError';
    this.status = status;
  }
}

export interface ResendDnsRecord {
  record: string; // 'DKIM' | 'SPF' | 'Receiving MX' | 'Tracking' | 'TrackingCAA' | 'DMARC'
  name: string; // relative subdomain, e.g. 'send' / 'resend._domainkey' / '_dmarc'
  type: string; // MX | TXT | CNAME | CAA
  value: string;
  ttl?: string;
  priority?: number;
  status?: string;
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string; // 'not_started' | 'pending' | 'verified' | 'failed' | ...
  records?: ResendDnsRecord[];
}

async function resendFetch<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`${RESEND_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
  } catch (err) {
    throw new ResendError(`无法访问 Resend API：${String(err)}`, 0);
  }
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!resp.ok) {
    const msg = (body as { message?: string; error?: string } | null)?.message ||
      (body as { error?: string } | null)?.error ||
      `HTTP ${resp.status}`;
    throw new ResendError(explainResendError(`Resend API 错误：${msg}`), resp.status);
  }
  return body as T;
}

export async function addDomain(apiKey: string, name: string): Promise<ResendDomain> {
  return resendFetch<ResendDomain>(apiKey, '/domains', { method: 'POST', body: JSON.stringify({ name }) });
}

export async function listDomains(apiKey: string): Promise<ResendDomain[]> {
  const r = await resendFetch<{ data?: ResendDomain[] }>(apiKey, '/domains');
  return r.data || [];
}

export async function getDomain(apiKey: string, id: string): Promise<ResendDomain> {
  return resendFetch<ResendDomain>(apiKey, `/domains/${id}`);
}

export async function verifyDomain(apiKey: string, id: string): Promise<void> {
  await resendFetch(apiKey, `/domains/${id}/verify`, { method: 'POST' });
}

/** The `name` in a Resend record is a relative subdomain ('send' / 'resend._domainkey'); join it into a full FQDN. */
export function fqdn(name: string, domain: string): string {
  const n = (name || '').trim();
  if (!n || n === '@') return domain;
  if (n === domain || n.endsWith(`.${domain}`)) return n;
  return `${n}.${domain}`;
}
