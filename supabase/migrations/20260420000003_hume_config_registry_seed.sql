-- 20260420000003_hume_config_registry_seed.sql
--
-- Seeds ops.hume_config_registry with the 3 live Hume EVI configs
-- (Discovery / New Member / Implementation Coach).
--
-- IDs captured 2026-04-20 via sync-hume-evi bootstrap-inspect against the
-- live Hume API (read-only GET /v0/evi/configs/{id} via hume-admin proxy).
-- Only the Discovery config carries the branded-acronym addendum region;
-- the other two serve members who already know MAX/MAYA/ATOM.
--
-- At seed time each prompt was at version 0; config versions were Discovery=4,
-- New Member=6, Implementation=1 (recorded here as reference, not seeded —
-- Hume itself is source of truth for current versions, registry last_* fields
-- advance as the sync runs).

INSERT INTO ops.hume_config_registry
  (slug, hume_config_id, hume_prompt_id, carries_addendum, notes)
VALUES
  ('discovery',
   '7b0c4b13-f495-449a-884a-5f3e38c661c0'::uuid,
   '51a4afbd-1cba-4205-9e8f-5605214b0262'::uuid,
   true,
   'Prospect-facing voice config (AI Phil - Discovery Guide). Carries BRANDED_ACRONYM_EXPANSION_BLOCK in the AIPHIL-DISCOVERY-ADDENDUM region.'),
  ('new-member',
   '9e13d89f-3f42-4609-8060-32d36965d73e'::uuid,
   '8b44860b-fd9e-402b-ab50-6bcba75d782b'::uuid,
   false,
   'New-member voice config (AI Phil - New Member Guide). Shared bundle only.'),
  ('implementation',
   '500e7bd2-5fc5-4bd1-90b8-e0b6d61a4eaf'::uuid,
   '07352a38-fe56-461e-b231-6fa5d243ccd8'::uuid,
   false,
   'Implementation Coach voice config (AI Phil - Implementation Coach). Shared bundle only.')
ON CONFLICT (slug) DO UPDATE SET
  hume_config_id   = EXCLUDED.hume_config_id,
  hume_prompt_id   = EXCLUDED.hume_prompt_id,
  carries_addendum = EXCLUDED.carries_addendum,
  notes            = EXCLUDED.notes,
  updated_at       = now();
