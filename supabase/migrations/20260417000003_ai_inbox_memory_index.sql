-- 20260417000003_ai_inbox_memory_index.sql
-- Index for the hot-path history query:
-- SELECT ... WHERE contact_id = ? ORDER BY created_at DESC LIMIT 20

CREATE INDEX IF NOT EXISTS ai_inbox_memory_contact_created_idx
  ON ops.ai_inbox_conversation_memory (contact_id, created_at DESC);
