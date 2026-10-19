-- Resend inbox data model (simplified Gmail).
-- messages table: inbound (received) and outbound (sent/replied) are stored together, distinguished by direction; folders = query views.

CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,                 -- internal primary key (uuid)
    direction     TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
    message_id    TEXT,                             -- RFC5322 Message-ID
    in_reply_to   TEXT,                             -- original message Message-ID (populated when replying)
    "references"  TEXT,                             -- original References (used for thread grouping)
    thread_id     TEXT,                             -- conversation root id (root-most References token)
    mailbox       TEXT NOT NULL DEFAULT '',         -- owning recipient address (e.g. support@example.com)
    mailbox_domain TEXT,                            -- derived: lowercased domain part of mailbox, for efficient per-domain filtering
    from_name     TEXT,
    from_email    TEXT,
    to_emails     TEXT NOT NULL DEFAULT '[]',       -- JSON array; **inbound = real To: header** (was the delivery address before the fix, see delivered_to)
    delivered_to  TEXT,                             -- JSON array; **delivery address (envelope recipient)** of an inbound message, from Resend's to/received_for
    cc            TEXT,                             -- JSON array
    bcc           TEXT,                             -- JSON array
    reply_to      TEXT,                             -- JSON array
    subject       TEXT,
    body_html     TEXT,
    body_text     TEXT,
    received_at   INTEGER NOT NULL,                 -- second-level unix timestamp (sort key)
    status        TEXT NOT NULL DEFAULT 'received', -- inbound: received; outbound: queued/sent/delivered/bounced/failed
    resend_id     TEXT,                             -- for outbound, the message id returned by Resend (receipt matching)
    read          INTEGER NOT NULL DEFAULT 0,
    starred       INTEGER NOT NULL DEFAULT 0,
    deleted       INTEGER NOT NULL DEFAULT 0,       -- soft delete -> Deleted folder
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_inbox  ON messages(mailbox, deleted, received_at DESC) WHERE direction='inbound';
CREATE INDEX IF NOT EXISTS idx_messages_sent   ON messages(mailbox, deleted, received_at DESC) WHERE direction='outbound';
CREATE INDEX IF NOT EXISTS idx_messages_star   ON messages(deleted, received_at DESC, starred) WHERE starred=1;
CREATE INDEX IF NOT EXISTS idx_messages_trash  ON messages(deleted, received_at DESC) WHERE deleted=1;
CREATE INDEX IF NOT EXISTS idx_messages_resend ON messages(resend_id) WHERE resend_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, received_at);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox, received_at DESC);
-- Per-domain filtering (top bar domain switcher): lets `WHERE mailbox_domain = ?` use an index instead of a LIKE full scan.
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_domain ON messages(mailbox_domain, deleted, received_at DESC);

-- Performance: makes /api/counts and /api/mailboxes **pure index scans**, no longer full-table scanning and reading each row's large body fields
-- (measured on 20000 rows: counts 88ms → 4.6ms; account grouping 100ms → 4.0ms)
CREATE INDEX IF NOT EXISTS idx_messages_counts ON messages(mailbox, direction, deleted, read, starred);
-- Performance: the "All mailboxes" view has no mailbox condition, so the leading column of the existing idx_messages_inbox/sent cannot be used
-- and it can only fall back to a temporary B-tree sort; these two indexes let it fetch in received_at DESC order even without a mailbox condition
-- (measured on 20000 rows with deep pagination to 5000: 128ms → 0.5ms)
CREATE INDEX IF NOT EXISTS idx_messages_inbox_all ON messages(deleted, received_at DESC) WHERE direction='inbound';
CREATE INDEX IF NOT EXISTS idx_messages_sent_all  ON messages(deleted, received_at DESC) WHERE direction='outbound';

-- A given Resend inbound email (email_id) is inserted only once (safeguard against concurrency/duplicate delivery)
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_inbound_resend ON messages(resend_id) WHERE direction='inbound' AND resend_id IS NOT NULL;

-- Outbound send quota statistics (/api/usage): counts messages "sent through this service" by received_at; this partial index avoids a full-table scan. See migrations/009_outbound_sent_index.sql.
CREATE INDEX IF NOT EXISTS idx_messages_outbound_sent ON messages(received_at) WHERE direction='outbound' AND resend_id IS NOT NULL;

-- Attachment metadata table (binary content lives in R2)
CREATE TABLE IF NOT EXISTS attachments (
    id           TEXT PRIMARY KEY,                  -- uuid
    message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    r2_key       TEXT NOT NULL,                     -- attachments/{messageId}/{uuid}-{filename}
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size         INTEGER NOT NULL DEFAULT 0,
    inline       INTEGER NOT NULL DEFAULT 0,        -- whether it is an inline image (cid)
    content_id   TEXT,                              -- normalized cid (no angle brackets)
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- Outbound delivery event receipts (email.sent/delivered/bounced/failed, optional)
CREATE TABLE IF NOT EXISTS delivery_events (
    id         TEXT PRIMARY KEY,                    -- svix event id
    message_id TEXT NOT NULL,                       -- references messages.id
    event_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    data       TEXT NOT NULL                        -- raw payload
);
CREATE INDEX IF NOT EXISTS idx_delivery_events_message ON delivery_events(message_id);

-- Webhook idempotency log (Resend retries failed deliveries)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id           TEXT PRIMARY KEY,                  -- svix event id
    processed_at INTEGER NOT NULL
);

-- Cloudflare inbound "never lose" index (see migrations/006_inbound_cf.sql).
-- CF Email Routing is a router, **not a mailbox** (unlike Resend, which stores mail for 30 days and can re-fetch it), so the first thing done on
-- receiving a message is to stream the raw .eml to R2 and register it here, then enqueue for async parsing — the raw message always has a durable copy.
CREATE TABLE IF NOT EXISTS inbound_raw (
    id           TEXT PRIMARY KEY,                  -- uuid; also used as the Queue pointer and the webhook_deliveries idempotency id
    r2_key       TEXT NOT NULL,                     -- R2 key of the raw .eml
    from_email   TEXT,                              -- envelope sender (SMTP MAIL FROM)
    to_email     TEXT,                              -- envelope recipient (delivery address)
    size         INTEGER NOT NULL DEFAULT 0,        -- raw byte count (message.rawSize)
    message_id   TEXT,                              -- Message-ID in the headers (angle brackets stripped), for diagnostics only
    subject      TEXT,                              -- Subject header (recorded before parsing, for the "inbound errors" notice)
    received_at  INTEGER NOT NULL,
    parsed_at    INTEGER,                           -- parse completion time; NULL = pending parse
    message_row  TEXT,                              -- messages.id written after parsing (idempotent: non-null = already stored)
    error        TEXT,                              -- permanent parse failure reason (raw message is still kept in R2)
    attempts     INTEGER NOT NULL DEFAULT 0         -- retry count (transient failures); no more retries after the threshold
);
CREATE INDEX IF NOT EXISTS idx_inbound_raw_pending ON inbound_raw(parsed_at, received_at) WHERE parsed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_raw_message_id ON inbound_raw(message_id) WHERE message_id IS NOT NULL;

-- Drafts (half-written messages). See migrations/005_drafts.sql for why this is a separate table.
-- Any column change to this table must **also** update migration 005, keeping the "full database creation" and "incremental upgrade" paths consistent.
CREATE TABLE IF NOT EXISTS drafts (
    id          TEXT PRIMARY KEY,               -- uuid (generated by the frontend so autosave can upsert directly)
    mailbox     TEXT NOT NULL DEFAULT '',
    mailbox_domain TEXT,
    mode        TEXT NOT NULL DEFAULT 'new',    -- new | reply | forward
    source_id   TEXT,
    to_emails   TEXT NOT NULL DEFAULT '[]',
    cc          TEXT,
    bcc         TEXT,
    subject     TEXT,
    body_html   TEXT,
    body_text   TEXT,
    rich        INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_mailbox ON drafts(mailbox, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_mailbox_domain ON drafts(mailbox_domain, updated_at DESC);

-- Usage statistics cache (frontend shows D1 / R2 usage percentage so you know ahead of time when to upgrade).
-- Values are **estimates**: D1 = sum of UTF-8 bytes of text/binary columns across tables; R2 = sum of listed objects. See getStorageUsage in src/repo.ts.
-- Computing it live is expensive (D1 full-table scan / R2 listing billed as Class A), so it is cached here with a TTL. See migrations/008_app_stats.sql.
CREATE TABLE IF NOT EXISTS app_stats (
    key        TEXT PRIMARY KEY,                    -- e.g. 'd1_bytes' / 'r2_bytes' / 'r2_objects'
    value      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

-- Application config (key/value written by the setup wizard). Keys such as: domain / zone_id / from_address / from_name /
-- resend_api_key / session_secret / routing_enabled / setup_complete.
-- Stored in the **user's own** D1 (BYO: secrets never leave the user's account). See migrations/010_setup_auth.sql.
-- Installation state only: `session_secret` (HMAC key for session cookies) and `setup_complete`. Everything that is
-- scoped to a domain lives in `domains` — the single-domain keys this table used to hold (domain / zone_id /
-- resend_domain_id / from_address / from_name / worker_name / resend_api_key) are ignored and retired automatically.
CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at INTEGER NOT NULL
);

-- Admin account (password login set within the wizard). password_hash is PBKDF2-SHA256 (format `pbkdf2$iterations$salt$hash`, all base64).
-- Either this or the env API_USERNAME/API_PASSWORD: if env is set, Basic Auth is used; otherwise session login via this table.
-- See migration/010_setup_auth.sql and src/auth.ts / src/session.ts.
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,                 -- uuid
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- Configured sending/receiving domains (multi-domain). One row per domain; the setup wizard upserts here.
-- Any address whose domain is in this table may send (see senderIdentity in src/send.ts),
-- and the top bar switches the whole inbox to one of these domains.
-- app_config still keeps the "primary" domain / from_address for backward compatibility.
CREATE TABLE IF NOT EXISTS domains (
    domain           TEXT PRIMARY KEY,              -- e.g. 'example.com' (lowercased)
    zone_id          TEXT,                          -- Cloudflare zone id
    resend_domain_id TEXT,                          -- Resend sending-domain id
    resend_api_key   TEXT,                          -- this domain's own Resend key (domains may live in different Resend accounts)
    from_address     TEXT,                          -- default sender for this domain (e.g. 'noreply@example.com')
    from_name        TEXT,                          -- default display name for this domain
    worker_name      TEXT,                          -- Worker script the catch-all points at
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);
