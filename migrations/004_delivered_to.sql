-- 004: distinguish the "real To: header" from the "delivery address (envelope recipient)"
--
-- Background (measured on production data): the `to` field returned by Resend's inbound API is the **delivery address**, not the `To:` header.
-- Example: sender erin@example.com → To: frank@example.net, Cc: dana@example.com;
-- this message lands in dana's inbox as `to = ["dana@example.com"]`, `cc = ["dana@example.com"]`.
-- The real To header only remains in `headers.to`. Previously `to_emails` stored the delivery address directly, which made the detail page
-- show "recipient" as the user themselves.
--
-- After the fix:
--   * `to_emails`    = real `To:` header (falls back to the delivery address when unavailable, so behavior does not regress)
--   * `delivered_to` = delivery address (envelope recipient), always written
--
-- Historical rows have `delivered_to` = NULL — the frontend uses this to detect that the row was "stored before the fix"
-- and subtracts cc/bcc from the delivery address when displaying the recipient (to avoid marking the user as a recipient).

ALTER TABLE messages ADD COLUMN delivered_to TEXT;
