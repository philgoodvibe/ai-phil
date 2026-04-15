-- Schedules sync-knowledge-base every 30 minutes via pg_cron + pg_net.
-- Requires: vault.decrypted_secrets entry named 'service_role_key' (one-time manual setup).
-- To verify vault entry exists: SELECT name FROM vault.decrypted_secrets WHERE name = 'service_role_key';
-- To create it if missing: SELECT vault.create_secret('<SERVICE_ROLE_KEY_VALUE>', 'service_role_key');
SELECT cron.schedule(
  'sync-ai-phil-docs',
  '*/30 * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://ylppltmwueasbdexepip.supabase.co/functions/v1/sync-knowledge-base',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
          FROM   vault.decrypted_secrets
          WHERE  name = 'service_role_key'
        )
      ),
      body    := '{"trigger":"cron"}'::jsonb
    ) AS request_id;
  $$
);
