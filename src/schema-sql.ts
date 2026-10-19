// This file is generated from schema.sql (pure DDL with comments stripped); do not edit by hand.
// To change the schema, edit schema.sql then run: npm run schema:sync
// Inlined rather than importing schema.sql directly: both the Worker and the tests are compiled with tsc, which cannot handle .sql text imports.
export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    direction     TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
    message_id    TEXT,
    in_reply_to   TEXT,
    "references"  TEXT,
    thread_id     TEXT,
    mailbox       TEXT NOT NULL DEFAULT '',
    mailbox_domain TEXT,
    from_name     TEXT,
    from_email    TEXT,
    to_emails     TEXT NOT NULL DEFAULT '[]',
    delivered_to  TEXT,
    cc            TEXT,
    bcc           TEXT,
    reply_to      TEXT,
    subject       TEXT,
    body_html     TEXT,
    body_text     TEXT,
    received_at   INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'received',
    resend_id     TEXT,
    read          INTEGER NOT NULL DEFAULT 0,
    starred       INTEGER NOT NULL DEFAULT 0,
    deleted       INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_domain ON messages(mailbox_domain, deleted, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_counts ON messages(mailbox, direction, deleted, read, starred);
CREATE INDEX IF NOT EXISTS idx_messages_inbox_all ON messages(deleted, received_at DESC) WHERE direction='inbound';
CREATE INDEX IF NOT EXISTS idx_messages_sent_all  ON messages(deleted, received_at DESC) WHERE direction='outbound';
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_inbound_resend ON messages(resend_id) WHERE direction='inbound' AND resend_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_outbound_sent ON messages(received_at) WHERE direction='outbound' AND resend_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS attachments (
    id           TEXT PRIMARY KEY,
    message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    r2_key       TEXT NOT NULL,
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size         INTEGER NOT NULL DEFAULT 0,
    inline       INTEGER NOT NULL DEFAULT 0,
    content_id   TEXT,
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE TABLE IF NOT EXISTS delivery_events (
    id         TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_events_message ON delivery_events(message_id);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id           TEXT PRIMARY KEY,
    processed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inbound_raw (
    id           TEXT PRIMARY KEY,
    r2_key       TEXT NOT NULL,
    from_email   TEXT,
    to_email     TEXT,
    size         INTEGER NOT NULL DEFAULT 0,
    message_id   TEXT,
    subject      TEXT,
    received_at  INTEGER NOT NULL,
    parsed_at    INTEGER,
    message_row  TEXT,
    error        TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inbound_raw_pending ON inbound_raw(parsed_at, received_at) WHERE parsed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_raw_message_id ON inbound_raw(message_id) WHERE message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS drafts (
    id          TEXT PRIMARY KEY,
    mailbox     TEXT NOT NULL DEFAULT '',
    mailbox_domain TEXT,
    mode        TEXT NOT NULL DEFAULT 'new',
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
CREATE TABLE IF NOT EXISTS app_stats (
    key        TEXT PRIMARY KEY,
    value      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS domains (
    domain           TEXT PRIMARY KEY,
    zone_id          TEXT,
    resend_domain_id TEXT,
    resend_api_key   TEXT,
    from_address     TEXT,
    from_name        TEXT,
    worker_name      TEXT,
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);`;
