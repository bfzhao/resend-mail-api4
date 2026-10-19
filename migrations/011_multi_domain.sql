-- 011 · Multi-domain support
--
-- Background: the app could only be configured with a single domain. This migration adds:
--   1) a `domains` table — the per-domain source of truth (zone/resend ids, default sender, worker name);
--   2) a derived `mailbox_domain` column on messages/drafts, so the top-bar domain switcher can filter
--      with an indexed `WHERE mailbox_domain = ?` instead of a LIKE full scan.
--
-- app_config still keeps the "primary" domain / from_address / resend key for backward compatibility;
-- the domains table is populated by the setup wizard (see configureDomain in src/setup.ts).
--
-- The CREATE TABLE / index statements are kept identical to the corresponding sections in schema.sql.

CREATE TABLE IF NOT EXISTS domains (
    domain           TEXT PRIMARY KEY,
    zone_id          TEXT,
    resend_domain_id TEXT,
    from_address     TEXT,
    from_name        TEXT,
    worker_name      TEXT,
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);

ALTER TABLE messages ADD COLUMN mailbox_domain TEXT;
ALTER TABLE drafts ADD COLUMN mailbox_domain TEXT;

-- Backfill: derive the (lowercased) domain from the mailbox address of existing rows.
UPDATE messages
   SET mailbox_domain = lower(substr(mailbox, instr(mailbox, '@') + 1))
 WHERE mailbox_domain IS NULL
   AND mailbox IS NOT NULL
   AND mailbox <> ''
   AND instr(mailbox, '@') > 0;

UPDATE drafts
   SET mailbox_domain = lower(substr(mailbox, instr(mailbox, '@') + 1))
 WHERE mailbox_domain IS NULL
   AND mailbox IS NOT NULL
   AND mailbox <> ''
   AND instr(mailbox, '@') > 0;

CREATE INDEX IF NOT EXISTS idx_messages_mailbox_domain ON messages(mailbox_domain, deleted, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_mailbox_domain ON drafts(mailbox_domain, updated_at DESC);

-- Seed the domains table from the single domain the wizard previously wrote into app_config.
INSERT OR IGNORE INTO domains (domain, zone_id, resend_domain_id, from_address, from_name, worker_name, enabled, created_at, updated_at)
SELECT
    lower(value),
    (SELECT value FROM app_config WHERE key = 'zone_id'),
    (SELECT value FROM app_config WHERE key = 'resend_domain_id'),
    (SELECT value FROM app_config WHERE key = 'from_address'),
    (SELECT value FROM app_config WHERE key = 'from_name'),
    (SELECT value FROM app_config WHERE key = 'worker_name'),
    1,
    CAST(strftime('%s', 'now') AS INTEGER),
    CAST(strftime('%s', 'now') AS INTEGER)
  FROM app_config
 WHERE key = 'domain'
   AND value IS NOT NULL
   AND value <> '';
