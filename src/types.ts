export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  RESEND_WEBHOOK_SECRET: string;
  RESEND_EVENTS_SECRET?: string;
  RESEND_API_KEY?: string;
  /**
   * Per-domain Resend keys as JSON `{ "<domain>": "re_…" }`, built by withRuntimeConfig from the domains table.
   * Two domains may live in **different Resend accounts**, so a domain's own key always wins over RESEND_API_KEY
   * (see resendKeyFor in src/send.ts). Domains without an entry fall back to the global key.
   */
  RESEND_API_KEYS?: string;
  SEND_FROM_ADDRESS?: string;
  SEND_FROM_NAME?: string;
  /**
   * The "primary" sending domain: the oldest enabled row of the domains table (derived on every request by
   * withRuntimeConfig — there is no stored primary). Any address on this domain may send.
   */
  SENDING_DOMAIN?: string;
  /** Comma-separated list of **all** configured domains (multi-domain). Supersedes SENDING_DOMAIN; populated by withRuntimeConfig. */
  SENDING_DOMAINS?: string;
  MERGE_SUBREQ_BUDGET?: string;
  API_USERNAME?: string;
  API_PASSWORD?: string;
  /** This Worker's script name (the setup wizard points the catch-all route at it). Defaults to 'resend-mail-api'. */
  WORKER_NAME?: string;
  /** The denominator for the storage usage "percentage" (bytes). Defaults to the Free tier: D1 500MB, R2 10GB. Paid tiers can override. */
  D1_LIMIT_BYTES?: string;
  R2_LIMIT_BYTES?: string;
  /** Resend send quota (messages/day, messages/month). Defaults to the Free tier: 100/day, 3000/month. Paid tiers can override. */
  RESEND_DAY_LIMIT?: string;
  RESEND_MONTH_LIMIT?: string;
  /**
   * CF inbound async parse queue (stage two of the never-lose pipeline).
   * When unset (undefined), `email()` still writes the raw message to R2 + registers inbound_raw,
   * it just has no consumer to parse it into messages — so local `wrangler dev` and deployments without a queue do not have to error out.
   */
  INBOUND_QUEUE?: Queue<InboundQueueMessage>;
}

/** Inbound queue message: **only pass an id pointer** (the body is in R2). A Queue message is ≤128 KB, so the MIME must never be stuffed in here. */
export interface InboundQueueMessage {
  rawId: string;
}

/** A row of the `inbound_raw` table. */
export interface InboundRawRow {
  id: string;
  r2_key: string;
  from_email: string | null;
  to_email: string | null;
  size: number;
  message_id: string | null;
  /** Subject header (recorded at receive time, for the "inbound alert" notice to display). */
  subject: string | null;
  received_at: number;
  parsed_at: number | null;
  message_row: string | null;
  error: string | null;
  attempts: number;
}

export type Direction = 'inbound' | 'outbound';

export type Folder = 'inbox' | 'sent' | 'starred' | 'trash';

export interface MessageRow {
  id: string;
  direction: Direction;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  thread_id: string | null;
  mailbox: string;
  from_name: string | null;
  from_email: string | null;
  to_emails: string;
  /** Delivery address (envelope recipient) of an inbound mail; historical rows are NULL. See migrations/004_delivered_to.sql. */
  delivered_to: string | null;
  cc: string | null;
  bcc: string | null;
  reply_to: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  received_at: number;
  status: string;
  resend_id: string | null;
  read: number;
  starred: number;
  deleted: number;
  created_at: number;
  updated_at: number;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
  inline: number;
  content_id: string | null;
  created_at: number;
}

export interface Address {
  name: string | null;
  email: string;
}

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}
