-- Migration: widen ops.hume_sync_runs trigger CHECK to include 'set-wrapper'
--
-- The set-wrapper admin mode (sync-hume-evi v4) writes audit rows with
-- trigger='set-wrapper'. The existing CHECK constraint only allowed
-- 'cron' | 'admin' | 'test', causing silent insert failures.
-- Applied live 2026-04-22 via execute_sql before this migration was written.

ALTER TABLE ops.hume_sync_runs
  DROP CONSTRAINT hume_sync_runs_trigger_check,
  ADD CONSTRAINT hume_sync_runs_trigger_check
    CHECK (trigger = ANY (ARRAY['cron'::text, 'admin'::text, 'test'::text, 'set-wrapper'::text]));
