-- 20260417000001_kb_doc_cache.sql
-- Cache Google Doc contents for 30-minute TTL to cut API calls at scale.

CREATE TABLE IF NOT EXISTS ops.kb_doc_cache (
  doc_id      text PRIMARY KEY,
  content     text NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ops.kb_doc_cache ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.kb_doc_cache IS
  '30-min TTL cache for Google Doc text exports. Read-through by _shared/kbCache.ts. Reduces Docs API calls from per-conversation to per-30min.';
