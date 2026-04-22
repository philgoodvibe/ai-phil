-- =============================================================================
-- hume_config_registry: bundle_variant column + Discovery row flip to voice
-- =============================================================================
-- 2026-04-21: split the Hume EVI shared-bundle consumers into two variants.
--   full   = current, canonical buildHumeSharedBundle + buildHumeDiscoveryAddendum
--   voice  = compressed variant sized for Hume EVI 7k-char speech window
--
-- Discovery flips to 'voice'. New Member + Implementation Coach stay on 'full'
-- pending live validation of the voice pattern (future ship).
-- =============================================================================

ALTER TABLE ops.hume_config_registry
  ADD COLUMN bundle_variant TEXT NOT NULL DEFAULT 'full'
  CHECK (bundle_variant IN ('full', 'voice'));

COMMENT ON COLUMN ops.hume_config_registry.bundle_variant IS
  'Which salesVoice builder to use when syncing this config. ''full'' uses '
  'buildHumeSharedBundle + buildHumeDiscoveryAddendum (canonical long-form '
  'bundle for GHL-equivalent surfaces). ''voice'' uses buildHumeVoiceBundle + '
  'buildHumeDiscoveryVoiceAddendum, compressed for Hume EVI''s 7k-char speech '
  'model window. Discovery is ''voice'' as of 2026-04-21; New Member + '
  'Implementation Coach remain ''full'' until future ship.';

-- Flip Discovery to the voice variant.
UPDATE ops.hume_config_registry
  SET bundle_variant = 'voice'
  WHERE slug = 'discovery';

-- Migrate existing sync_state keys to per-variant form. Preserves last-synced
-- hash for the 'full' variant so New Member + Implementation Coach don't
-- re-sync unnecessarily on the first post-migration run.
INSERT INTO public.sync_state (key, value, updated_at)
  SELECT 'hume_evi_last_bundle_hash:full', value, NOW()
    FROM public.sync_state
    WHERE key = 'hume_evi_last_bundle_hash'
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO public.sync_state (key, value, updated_at)
  SELECT 'hume_evi_last_addendum_hash:full', value, NOW()
    FROM public.sync_state
    WHERE key = 'hume_evi_last_addendum_hash:discovery'
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- The voice variant has no previous sync — hashes will be null on first
-- voice sync, which triggers a clean first post of the Discovery config.
