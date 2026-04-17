-- 20260417000004_ghl_sales_followup_cron.sql
-- Registers a pg_cron job that invokes the ghl-sales-followup edge function
-- at the top of each business hour (9am-5pm Mon-Fri).
--
-- Auth uses vault.decrypted_secrets.supabase_anon_key, matching the pattern
-- used by the sync-ai-phil-docs cron job. Never hardcode JWTs in migrations
-- (CLAUDE.md guardrail — prior incident with hardcoded anon JWT in a DB trigger
-- on 2026-04-15 cost us public exposure).
--
-- The edge function validates the Bearer token itself (length >= 20 + prefix
-- check), then drains up to 100 due rows from ops.ai_inbox_followup_queue.
-- Pure no-op when the queue is empty.

SELECT cron.schedule(
  'ghl-sales-followup-hourly',
  '0 9-17 * * 1-5',
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
