-- Schedules sync-knowledge-base every 30 minutes via pg_cron + pg_net.
-- Requires: vault.decrypted_secrets entry named 'supabase_anon_key' (one-time manual setup).
-- To verify vault entry exists: SELECT name FROM vault.decrypted_secrets WHERE name = 'supabase_anon_key';
-- To create it if missing: SELECT vault.create_secret('<ANON_KEY_VALUE>', 'supabase_anon_key');
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
          WHERE  name = 'supabase_anon_key'
        )
      ),
      body    := '{"trigger":"cron"}'::jsonb
    ) AS request_id;
  $$
);
