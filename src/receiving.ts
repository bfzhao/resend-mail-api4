import type { Env } from './types';

/**
 * Resend Received Emails API.
 * Docs: the email.received webhook only contains metadata; the body/headers/attachments must be
 * fetched via https://resend.com/docs/api-reference/emails/retrieve-received-email and similar endpoints.
 */

const RESEND_API = 'https://api.resend.com';

function authHeader(env: Env): { Authorization: string } | never {
  if (!env.RESEND_API_KEY) {
    throw new Error('未配置 RESEND_API_KEY，无法拉取收信内容');
  }
  return { Authorization: `Bearer ${env.RESEND_API_KEY}` };
}

async function resendGet<T>(env: Env, path: string): Promise<T> {
  const resp = await fetch(`${RESEND_API}${path}`, { headers: authHeader(env) });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Resend API ${resp.status}: ${body.slice(0, 300)}`);
  }
  return (await resp.json()) as T;
}

export interface ReceivedAttachmentMeta {
  id: string;
  filename: string;
  content_type: string;
  content_disposition: string | null;
  content_id: string | null;
  size: number | null;
}

export interface ReceivedEmail {
  id: string;
  from: string | null;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  subject: string | null;
  html: string | null;
  html_format?: string | null;
  text: string | null;
  headers?: Record<string, string> | null;
  message_id: string | null;
  created_at: string | null;
  received_for?: string[];
  attachments?: ReceivedAttachmentMeta[];
}

export interface AttachmentDownloadItem extends ReceivedAttachmentMeta {
  download_url: string;
  expires_at?: string | null;
}

/** Fetch a received email's body and headers; html_format=cid keeps inline image cid references, making it easy to map to the attachment table. */
export async function fetchReceivedEmail(env: Env, emailId: string): Promise<ReceivedEmail> {
  return resendGet<ReceivedEmail>(
    env,
    `/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`
  );
}

/** Fetch the attachment download URLs for an email (a single call returns them all). */
export async function listReceivedAttachmentDownloads(env: Env, emailId: string): Promise<Map<string, AttachmentDownloadItem>> {
  const data = await resendGet<{ data: AttachmentDownloadItem[] }>(
    env,
    `/emails/receiving/${encodeURIComponent(emailId)}/attachments`
  );
  const map = new Map<string, AttachmentDownloadItem>();
  for (const item of data?.data ?? []) {
    if (item.download_url) map.set(item.id, item);
  }
  return map;
}

/** Download a signed URL (the Resend CDN returns the bytes directly). */
export async function downloadSignedUrl(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`attachment download failed: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  return { bytes: new Uint8Array(buf), contentType: resp.headers.get('content-type') };
}
