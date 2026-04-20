-- 20260420000002_hume_sync_runs.sql
--
-- Phase 0 Task 4 — Hume EVI nightly sync support tables.
--
-- ops.hume_sync_runs: one row per sync invocation (cron, admin, or test).
-- ops.hume_config_registry: one row per Hume EVI config (3 at ship; grows if
-- phone voice or additional configs join later). Seeded in a follow-up
-- migration after one-time inspection of each config's current prompt_id.
--
-- Design spec: docs/superpowers/specs/2026-04-20-hume-evi-nightly-sync-design.md

-- ---------------------------------------------------------------------------
-- hume_sync_runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.hume_sync_runs (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  trigger         TEXT NOT NULL CHECK (trigger IN ('cron','admin','test')),
  bundle_hash     TEXT NOT NULL,
  addendum_hash   TEXT,
  bundle_changed  BOOLEAN NOT NULL DEFAULT false,
  configs_checked INT NOT NULL DEFAULT 0,
  configs_updated INT NOT NULL DEFAULT 0,
  configs_failed  INT NOT NULL DEFAULT 0,
  hume_versions   JSONB,
  error           TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','ok','noop','partial','error'))
);

CREATE INDEX IF NOT EXISTS hume_sync_runs_started_at_desc_idx
  ON ops.hume_sync_runs (started_at DESC);

ALTER TABLE ops.hume_sync_runs ENABLE ROW LEVEL SECURITY;
-- No policies: service_role bypasses RLS; no anon/authenticated read.

COMMENT ON TABLE ops.hume_sync_runs IS
  'One row per sync-hume-evi invocation. trigger: cron | admin | test. status: running | ok (all configs updated) | noop (hash unchanged, no Hume calls) | partial (1-2 of 3 failed) | error (pre-config failure or all configs failed). hume_versions JSONB contains per-config {slug, prompt_version, config_version, error?}.';

-- ---------------------------------------------------------------------------
-- hume_config_registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.hume_config_registry (
  slug              TEXT PRIMARY KEY CHECK (slug IN ('discovery','new-member','implementation')),
  hume_config_id    UUID NOT NULL,
  hume_prompt_id    UUID NOT NULL,
  carries_addendum  BOOLEAN NOT NULL DEFAULT false,
  last_synced_at    TIMESTAMPTZ,
  last_prompt_ver   INT,
  last_config_ver   INT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ops.hume_config_registry ENABLE ROW LEVEL SECURITY;
-- No policies: service_role only.

COMMENT ON TABLE ops.hume_config_registry IS
  'Seeded registry of Hume EVI configs the sync function touches. slug is stable; hume_*_id are the Hume resource IDs. carries_addendum=true flags configs that additionally render the Discovery addendum region (currently only discovery). last_* fields are advisory — source of truth for the current Hume version is Hume itself.';

-- ---------------------------------------------------------------------------
-- sync_state key placeholder (documented here so future sessions see it)
-- ---------------------------------------------------------------------------
-- Runtime code writes these sync_state rows (schema ops.sync_state, created in
-- earlier migration 20260415000000_sync_state.sql):
--   key = 'hume_evi_last_bundle_hash', value = <sha256 hex of last synced shared bundle>
--   key = 'hume_evi_last_addendum_hash:discovery', value = <sha256 hex of last synced addendum>
