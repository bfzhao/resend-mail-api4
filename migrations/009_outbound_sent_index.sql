-- Outbound send quota statistics (/api/usage's resend.day / resend.month): counts by received_at the number of messages "sent through this service"
-- (resend_id non-null). This partial index avoids a full-table scan. See resendUsage in src/repo.ts.
CREATE INDEX IF NOT EXISTS idx_messages_outbound_sent ON messages(received_at) WHERE direction='outbound' AND resend_id IS NOT NULL;
