-- 007: add the subject column to inbound_raw.
--
-- Background: CF inbound "stores the raw message + registers the index first, then parses asynchronously". A failed/stuck message has only a message_id,
-- which is unrecognizable in the UI. So the Subject header is recorded here on receipt, letting the "inbound errors" notice show "who it came from and what the subject is",
-- so the user can tell whether it is spam or a message genuinely worth recovering.
--
-- Kept consistent with the inbound_raw definition in schema.sql (both the full database creation and incremental upgrade paths need this column).

ALTER TABLE inbound_raw ADD COLUMN subject TEXT;
