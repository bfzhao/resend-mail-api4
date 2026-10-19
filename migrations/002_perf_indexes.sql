-- =============================================================================
-- 002_perf_indexes.sql —— performance index migration (only affects "existing" databases)
--
-- Background: the CREATE INDEX IF NOT EXISTS statements in schema.sql only run on a **newly created database**;
--       an already-created D1 database will not get the indexes automatically, so this migration must be run manually.
--
-- Usage (local):
--   node node_modules/wrangler/bin/wrangler.js d1 execute resend-webhooks-db --local \
--     --file migrations/002_perf_indexes.sql
-- Usage (remote):
--   node node_modules/wrangler/bin/wrangler.js d1 execute resend-webhooks-db --remote \
--     --file migrations/002_perf_indexes.sql
--
-- Idempotent: everything uses IF NOT EXISTS, so it can be run repeatedly.
--
-- Gains (20000 rows of synthetic data, measured with node:sqlite; see the delivery notes for details):
--   GET /api/counts           88.4 ms → 4.6 ms (SCAN → COVERING INDEX)
--   GET /api/counts?mailbox=  64.7 ms → 1.7 ms
--   GET /api/mailboxes       100.0 ms → 4.0 ms (eliminates TEMP B-TREE FOR GROUP BY)
--   GET /api/folders/inbox deep pagination 128.5 ms → 0.5 ms (eliminates TEMP B-TREE FOR ORDER BY)
-- =============================================================================

-- Covering index: makes /api/counts and /api/mailboxes pure index scans that no longer read large body fields
CREATE INDEX IF NOT EXISTS idx_messages_counts ON messages(mailbox, direction, deleted, read, starred);

-- Dedicated to the "All mailboxes" view: even without a mailbox condition it can fetch in received_at DESC order directly, avoiding a temporary B-tree sort
CREATE INDEX IF NOT EXISTS idx_messages_inbox_all ON messages(deleted, received_at DESC) WHERE direction='inbound';
CREATE INDEX IF NOT EXISTS idx_messages_sent_all  ON messages(deleted, received_at DESC) WHERE direction='outbound';
