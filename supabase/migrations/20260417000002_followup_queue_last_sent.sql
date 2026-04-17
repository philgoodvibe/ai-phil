-- 20260417000002_followup_queue_last_sent.sql
-- Idempotency guard: prevent dual-sends if cron retries a row after GHL send
-- succeeded but DB update failed.

ALTER TABLE ops.ai_inbox_followup_queue
  ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;

COMMENT ON COLUMN ops.ai_inbox_followup_queue.last_sent_at IS
  'Timestamp of last successful send from this row. ghl-sales-followup refuses to resend if last_sent_at is within the last 1 hour.';
