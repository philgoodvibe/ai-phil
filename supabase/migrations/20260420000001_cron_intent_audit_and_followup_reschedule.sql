-- 20260420000001_cron_intent_audit_and_followup_reschedule.sql
--
-- Phase 0 Task 3 — pg_cron timezone fix + self-enforcing audit.
--
-- 1. Creates ops.cron_job_intent (sidecar declaring owner/purpose/local-window/DST-strategy)
-- 2. Creates ops.cron_schedule_audit view (ERROR/WARN/OK drift detector)
-- 3. Reschedules ghl-sales-followup-hourly from '0 9-17 * * 1-5' (authored-as-Pacific, fires
--    UTC 09-17 = 2a-10a PDT / 1a-9a PST) to '0 * * * 1-5' (every hour Mon-Fri UTC).
--    The ghl-sales-followup edge function now gates on Pacific local time in TypeScript via
--    isWithinBusinessHours() — DST-agnostic.
-- 4. Seeds ops.cron_job_intent for both ai-phil-owned jobnames (sync-ai-phil-docs +
--    ghl-sales-followup-hourly). Philgood-OS-owned rows intentionally NOT seeded — they
--    surface as ERROR intent_missing in the audit view, which is the cross-repo follow-up
--    signal per CLAUDE.md's 3-location drop convention.
--
-- Design spec: docs/superpowers/specs/2026-04-20-phase0-task3-cron-timezone-audit-design.md

-- ---------------------------------------------------------------------------
-- 1. Sidecar table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.cron_job_intent (
  jobname         TEXT PRIMARY KEY,
  owner_repo      TEXT NOT NULL CHECK (owner_repo IN ('ai-phil', 'philgood-os', 'shared')),
  purpose         TEXT NOT NULL,
  local_tz        TEXT,
  local_window    TEXT NOT NULL,
  dst_strategy    TEXT NOT NULL CHECK (dst_strategy IN ('app-layer', 'interval', 'fixed-utc', 'none-required')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ops.cron_job_intent ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (which bypasses RLS) can read/write.

COMMENT ON TABLE ops.cron_job_intent IS
  'Sidecar to cron.job declaring the intent behind each scheduled job. Every row in cron.job SHOULD have a matching row here; absence is flagged as ERROR by ops.cron_schedule_audit. dst_strategy is explicit: app-layer means the function gates on local time; interval means every-N-minutes so timezone is irrelevant; fixed-utc means a deliberate UTC moment; none-required means purely interval-based with no local-hour intent.';

-- ---------------------------------------------------------------------------
-- 2. Audit view
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW ops.cron_schedule_audit AS
WITH job_with_intent AS (
  SELECT
    j.jobid,
    j.jobname,
    j.schedule,
    j.command,
    j.active,
    i.owner_repo,
    i.local_window,
    i.dst_strategy,
    i.purpose,
    (i.jobname IS NULL) AS intent_missing,
    (j.command ~ '(eyJ[A-Za-z0-9_-]+\.|sk_live_|sk_test_|sb_secret_)') AS secret_in_command,
    (j.schedule ~ '^[0-9,*/-]+ [0-9]+(-[0-9]+)? [0-9,*/-]+ [0-9,*/-]+ [0-9,*/-]+$') AS hour_bounded_schedule
  FROM cron.job j
  LEFT JOIN ops.cron_job_intent i ON i.jobname = j.jobname
)
SELECT
  jobid, jobname, schedule, active, owner_repo, local_window, dst_strategy, purpose,
  CASE
    WHEN intent_missing                                                             THEN 'ERROR'
    WHEN secret_in_command                                                          THEN 'ERROR'
    WHEN hour_bounded_schedule AND dst_strategy IS DISTINCT FROM 'app-layer'        THEN 'WARN'
    ELSE 'OK'
  END AS severity,
  CASE
    WHEN intent_missing                                                             THEN 'intent_missing'
    WHEN secret_in_command                                                          THEN 'secret_in_command'
    WHEN hour_bounded_schedule AND dst_strategy IS DISTINCT FROM 'app-layer'        THEN 'hour_bounded_without_app_layer_dst'
    ELSE 'ok'
  END AS audit_code
FROM job_with_intent
ORDER BY
  CASE
    WHEN intent_missing OR secret_in_command                                        THEN 0
    WHEN hour_bounded_schedule AND dst_strategy IS DISTINCT FROM 'app-layer'        THEN 1
    ELSE 2
  END,
  jobname;

COMMENT ON VIEW ops.cron_schedule_audit IS
  'Self-enforcing cron drift detector. Severity ERROR = must fix (intent_missing OR secret_in_command). Severity WARN = hour-bounded schedule without app-layer DST handling (likely authored in local time). Run at every session close-out alongside get_advisors(''security'').';

-- ---------------------------------------------------------------------------
-- 3. Reschedule ghl-sales-followup-hourly (UTC → app-layer DST gate)
-- ---------------------------------------------------------------------------
SELECT cron.unschedule('ghl-sales-followup-hourly');

SELECT cron.schedule(
  'ghl-sales-followup-hourly',
  '0 * * * 1-5',
  $$
  SELECT net.http_post(
    url     := 'https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-sales-followup',
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

-- ---------------------------------------------------------------------------
-- 4. Seed intent for ai-phil-owned jobnames
-- ---------------------------------------------------------------------------
INSERT INTO ops.cron_job_intent (jobname, owner_repo, purpose, local_tz, local_window, dst_strategy, notes) VALUES
(
  'sync-ai-phil-docs',
  'ai-phil',
  'Every 30 min: trigger sync-knowledge-base edge function to pull Drive doc changes into kb_documents.',
  NULL,
  'every 30m',
  'none-required',
  'Auth via vault.decrypted_secrets.supabase_anon_key. Interval-based, no local-hour intent.'
),
(
  'ghl-sales-followup-hourly',
  'ai-phil',
  'Every hour Mon-Fri UTC: trigger ghl-sales-followup to drain ops.ai_inbox_followup_queue. Edge function gates on Pacific business hours (9a-5p PT) via isWithinBusinessHours().',
  'America/Los_Angeles',
  '9a-5p Mon-Fri PT',
  'app-layer',
  'Cron fires hourly Mon-Fri UTC regardless of local time; business-hours gate lives in supabase/functions/ghl-sales-followup/businessHours.ts. DST-agnostic. Outside-window invocations return 200 { gated: outside-business-hours } + an ai-followup-gated audit signal.'
)
ON CONFLICT (jobname) DO UPDATE SET
  owner_repo   = EXCLUDED.owner_repo,
  purpose      = EXCLUDED.purpose,
  local_tz     = EXCLUDED.local_tz,
  local_window = EXCLUDED.local_window,
  dst_strategy = EXCLUDED.dst_strategy,
  notes        = EXCLUDED.notes,
  updated_at   = now();
