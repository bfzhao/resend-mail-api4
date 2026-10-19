-- 006: migrate inbound from Resend to Cloudflare Email Routing — the "never lose" index table
--
-- Background: CF Email Routing is a **router, not a mailbox**; it does not store received mail and has no interface to re-fetch it
-- (unlike Resend, which stores mail for 30 days and supports retrieve-received-email). So inbound's top priority is not "parse it well"
-- but "**never lose it**": on receipt store the raw copy first, so even a parse failure has a fallback.
--
-- Flow (`src/inbound-email.ts`):
--   1. `email()`: read headers + **stream** `message.raw` to R2 (without reading it all into memory) + register a row in this table + enqueue (sending only the id pointer)
--   2. `queue()`: fetch the raw message from R2 → parse with postal-mime → reuse the existing saveInbound to write messages/attachments
--      → backfill parsed_at / message_row
--
-- Idempotency: `id` is also used as the webhook_deliveries idempotency id (INSERT OR IGNORE inside saveInbound);
-- a non-null `message_row` means it is already stored, so a duplicate delivery (Queue at-least-once) is skipped directly.
--
-- This table is **purely additive** and changes no column of messages/attachments — historical data and the Resend inbound path (/webhook/inbound) are completely unaffected.

CREATE TABLE IF NOT EXISTS inbound_raw (
    id           TEXT PRIMARY KEY,                  -- uuid; also used as the Queue pointer and the webhook_deliveries idempotency id
    r2_key       TEXT NOT NULL,                     -- R2 key of the raw .eml
    from_email   TEXT,                              -- envelope sender (SMTP MAIL FROM)
    to_email     TEXT,                              -- envelope recipient (delivery address)
    size         INTEGER NOT NULL DEFAULT 0,        -- raw byte count
    message_id   TEXT,                              -- Message-ID in the headers (angle brackets stripped), for diagnostics only
    received_at  INTEGER NOT NULL,
    parsed_at    INTEGER,                           -- parse completion time; NULL = pending parse
    message_row  TEXT,                              -- messages.id written after parsing (idempotent: non-null = already stored)
    error        TEXT,                              -- permanent parse failure reason (raw message is still kept in R2)
    attempts     INTEGER NOT NULL DEFAULT 0         -- retry count (transient failures); no more retries after the threshold
);
CREATE INDEX IF NOT EXISTS idx_inbound_raw_pending ON inbound_raw(parsed_at, received_at) WHERE parsed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_raw_message_id ON inbound_raw(message_id) WHERE message_id IS NOT NULL;
