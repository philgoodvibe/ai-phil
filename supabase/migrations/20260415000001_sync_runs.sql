-- sync_runs: one row per sync execution; provides observability
CREATE TABLE public.sync_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  trigger        TEXT NOT NULL CHECK (trigger IN ('cron', 'manual')),
  files_seen     INT NOT NULL DEFAULT 0,
  files_synced   INT NOT NULL DEFAULT 0,
  files_skipped  INT NOT NULL DEFAULT 0,
  files_errored  INT NOT NULL DEFAULT 0,
  error_details  JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_ms    INT
);

-- RLS: service-role only
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;

-- Index for fast "show me recent runs" queries
CREATE INDEX sync_runs_started_at_idx ON public.sync_runs (started_at DESC);
