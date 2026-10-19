-- Migration 001 (one-time run on existing databases): add thread_id / mailbox to messages
-- For a fresh install use schema.sql in the repository root directly; this file need not be run.
-- Usage: npm run db:migrate:up (just run it before the base migrations; this file idempotently handles already-created tables)

ALTER TABLE messages ADD COLUMN thread_id TEXT;
ALTER TABLE messages ADD COLUMN mailbox TEXT NOT NULL DEFAULT '';

-- Rebuild the list indexes that depend on mailbox (the old definitions did not include mailbox)
DROP INDEX IF EXISTS idx_messages_inbox;
DROP INDEX IF EXISTS idx_messages_sent;
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(mailbox, deleted, received_at DESC) WHERE direction='inbound';
CREATE INDEX IF NOT EXISTS idx_messages_sent  ON messages(mailbox, deleted, received_at DESC) WHERE direction='outbound';
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, received_at);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox, received_at DESC);

-- Backfill old messages: use each message's own message_id as thread_id (with no reference history each becomes its own conversation)
UPDATE messages
   SET thread_id = message_id
 WHERE thread_id IS NULL OR thread_id = '';
