-- sync_state: general key-value store for sync bookmarks and doc content hashes
CREATE TABLE public.sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: service-role only (same pattern as kb_documents)
ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;

-- Seed: sentinel date so first run picks up all existing docs
INSERT INTO public.sync_state (key, value)
VALUES ('ai_phil_docs_last_synced', '2024-01-01T00:00:00Z')
ON CONFLICT (key) DO NOTHING;
