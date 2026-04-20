-- 20260420000004_hume_sync_cron.sql
--
-- Schedules the Hume EVI nightly sync. Fires once per day at 09:30 UTC
-- (= 02:30 Pacific PDT / 01:30 Pacific PST). Off-peak by design — no
-- customer impact even if a deploy hiccup occurs during the sync window.
--
-- Auth pattern mirrors the other ai-phil cron jobs: Bearer token read from
-- vault.decrypted_secrets at invocation time. Never hardcode JWTs in SQL.
-- Intent row registers this job in ops.cron_job_intent so ops.cron_schedule_audit
-- does not report it as 'intent_missing'.
--
-- First live sync completed 2026-04-20 (run_id=1 status='ok', 3/3 configs
-- updated). Second sync returned noop via hash short-circuit. Function is
-- production-ready; this migration turns on autonomous nightly operation.

SELECT cron.schedule(
  'sync-hume-evi-nightly',
  '30 9 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://ylppltmwueasbdexepip.supabase.co/functions/v1/sync-hume-evi',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret
        FROM   vault.decrypted_secrets
        WHERE  name = 'supabase_anon_key'
      )
    ),
    body    := '{"trigger":"cron"}'::jsonb
  ) AS request_id;
  $$
);

INSERT INTO ops.cron_job_intent
  (jobname, owner_repo, purpose, local_tz, local_window, dst_strategy, notes)
VALUES (
  'sync-hume-evi-nightly',
  'ai-phil',
  'Nightly sync of _shared/salesVoice.ts shared blocks into the 3 Hume EVI prompts (Discovery / New Member / Implementation Coach).',
  NULL,
  '09:30 UTC daily',
  'none-required',
  'Fixed UTC by design. Marker-region surgical splice with hash short-circuit — 364 no-op runs/year do not churn Hume versions. Discovery config additionally carries the BRANDED_ACRONYM_EXPANSION_BLOCK addendum. Closes Non-Negotiable #1 on voice surfaces.'
) ON CONFLICT (jobname) DO UPDATE SET
  owner_repo   = EXCLUDED.owner_repo,
  purpose      = EXCLUDED.purpose,
  local_window = EXCLUDED.local_window,
  dst_strategy = EXCLUDED.dst_strategy,
  notes        = EXCLUDED.notes,
  updated_at   = now();
