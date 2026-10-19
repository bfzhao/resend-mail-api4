-- 003: fix historical data (idempotent, can be run repeatedly)
--
-- Background (measured in production on 2026-09-29):
--   ① 11 messages actually belonging to support@example.com had an empty string mailbox
--      and were grouped under "(unrecognized)" in the sidebar. The root cause was the hand-written
--      Array.isArray(data.to) check in pickMailbox(), which did not recognize a string-form to (fixed, see src/webhook.ts).
--   ② All 29 outbound messages had read=0 and showed as unread in the Outbox, staying that way when opened.
--      The root cause was insertMessageStmt hardcoding read to 0 (fixed, see src/repo.ts).
--
-- This migration only fixes **existing data**; new data is guaranteed correct by the two code fixes above.
-- Every statement has a WHERE condition, so running it again is a no-op.

-- ① Inbound: when mailbox is empty, backfill with the first address in to_emails
UPDATE messages
   SET mailbox = lower(json_extract(to_emails, '$[0]')),
       updated_at = CAST(strftime('%s', 'now') AS INTEGER)
 WHERE (mailbox IS NULL OR mailbox = '')
   AND direction = 'inbound'
   AND json_valid(to_emails)
   AND json_extract(to_emails, '$[0]') IS NOT NULL
   AND trim(json_extract(to_emails, '$[0]')) <> '';

-- ② Outbound: when mailbox is empty, backfill with from_email (an outbound message's sender address is its owning account)
UPDATE messages
   SET mailbox = lower(from_email),
       updated_at = CAST(strftime('%s', 'now') AS INTEGER)
 WHERE (mailbox IS NULL OR mailbox = '')
   AND direction = 'outbound'
   AND from_email IS NOT NULL
   AND trim(from_email) <> '';

-- ③ Outbound messages are always read (messages you sent have no "unread" semantics)
UPDATE messages
   SET read = 1,
       updated_at = CAST(strftime('%s', 'now') AS INTEGER)
 WHERE direction = 'outbound'
   AND read = 0;
