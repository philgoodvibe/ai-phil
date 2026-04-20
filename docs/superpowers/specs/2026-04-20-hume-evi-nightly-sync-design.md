# Hume EVI Nightly Sync — Voice Source-of-Truth Consolidation

**Owner:** Claude (ai-phil session, 2026-04-20)
**Step:** Step 1 Foundation deliverable — "Voice source-of-truth consolidation — auto-gen `_shared/salesVoice.ts`, nightly sync to Hume EVI prompts" (per `_system/architecture.md`).
**Non-Negotiable:** #1 — one AI Phil brain and persona across every surface. `_shared/salesVoice.ts` is the ONLY voice source; every surface reads it at boot.
**Status:** design-approved by architecture.md Step 1 deliverables; no re-survey required.

---

## Problem

Three Hume EVI configs (Discovery, New Member, Implementation Coach) carry AI Phil's voice on the web widget's voice channel. Today they are maintained by manual paste from `_shared/salesVoice.ts` into the Hume dashboard. Every edit to a shared block — `SECURITY_BOUNDARY_BLOCK`, `IDENTITY_BLOCK`, `VOICE_BLOCK`, `FORM_FRAMEWORK_BLOCK`, `PROOF_SHAPE_BLOCK`, `NEVER_LIE_BLOCK`, `AGENCY_BOUNDARIES_BLOCK`, `VOCABULARY_BLOCK` — requires a manual paste into three separate Hume configs, tracked as a checkbox. The 2026-04-19 `SECURITY_BOUNDARY_BLOCK` ship is currently pending that manual paste.

This violates Non-Negotiable #1 in practice: the voice surfaces drift.

## Goal

Eliminate the manual paste. When `_shared/salesVoice.ts` ships a change, Hume picks it up automatically within 24 hours (nightly cron) or within seconds on demand (admin endpoint).

**Success criteria:**
1. After this ships, a dev can edit a shared block in `_shared/salesVoice.ts`, commit, push, deploy — and within 24h (or immediately via manual trigger) all three Hume prompts reflect the new shared content.
2. Hume-specific curated content in each prompt (voice-channel rules, tool-use framing, conversation framing) is preserved intact.
3. Sync job is a first-class monitored cron registered in `ops.cron_job_intent`; absence fails `ops.cron_schedule_audit`.
4. Sync runs are observable in `ops.hume_sync_runs`; silent failures are impossible (the 2026-04-16→20 silent data-loss class of bug does not repeat).
5. Every sync is reversible: Hume versions all prompts and configs by construction.

## Non-goals (out of scope for this spec)

- **Vault markdown doc → TypeScript auto-gen.** `AI-Phil-Voice-Philosophy.md` → `_shared/salesVoice.ts` codegen is a separate Step 1 deliverable. This spec treats `_shared/salesVoice.ts` as the upstream source for the Hume sync.
- **Phone voice (Hume + Twilio).** When that ships, it gets a fourth config and the sync picks it up via config-registry seed — no code changes.
- **Non-shared block content.** Each Hume config has its own voice-channel rules, tool-use framing, etc. Those stay human-curated in the Hume dashboard below the marker region.

## Design

### Architecture (one-line)

`_shared/salesVoice.ts` → `sync-hume-evi` edge function (nightly cron + admin trigger) → `hume-admin` proxy → Hume Prompts API (POST new version) → Hume Configs API (POST new version pointing at new prompt version) → `ops.hume_sync_runs` audit row.

### Marker-region splice

Each Hume prompt carries a shared-block region bounded by literal markers:

```
<!-- AIPHIL-SHARED-BEGIN v=<hash> -->
<rendered shared blocks from _shared/salesVoice.ts, joined by \n\n---\n\n>
<!-- AIPHIL-SHARED-END -->

(human-curated Hume-specific content below, never touched by sync)
```

The sync function:
1. Reads `_shared/salesVoice.ts` at build time (edge function bundler — blocks are inlined).
2. Computes the rendered shared-block bundle + SHA-256 hash of that bundle.
3. Short-circuits if the hash matches `sync_state.key = 'hume_evi_last_bundle_hash'` — no Hume calls, clean no-op, log a 200.
4. If changed, per config: GET current prompt via `hume-admin`, replace the marker region (or prepend markers on first run if absent), POST new prompt version via `hume-admin`, POST new config version via `hume-admin` pointing at the new prompt version.
5. Per-config try/catch so one config's failure does not block the other two.
6. Writes one `ops.hume_sync_runs` row per run with per-config outcome + new Hume version numbers.

**Why markers not full regeneration:** Hume-channel-specific content (1-2 sentence rule, tool framing, conversation framing) is legitimately Hume-specific and does not live in `salesVoice.ts`. Full regeneration would force that curated content into TypeScript, ballooning the module and tying voice-channel ergonomics to a build cycle. Markers are surgical, reversible, and match the threat model (drift on guardrails, not drift on voice-channel rules).

### Hume API contract (confirmed from SDK source)

Hume has two versioned resources:

- **Prompts:** `POST /v0/evi/prompts/{id}` with `{text: string, versionDescription: string}` → new prompt version. Versions are integers, immutable.
- **Configs:** `POST /v0/evi/configs/{id}` with `{prompt: {id, version}, ...otherFieldsCarriedFromCurrent}` → new config version pointing at the chosen prompt version.

Both go through `hume-admin` edge function (already deployed v5) as a thin proxy with `X-Hume-Api-Key` auth.

### Shared-block render contract

A new exported function in `_shared/salesVoice.ts`:

```ts
export function buildHumeSharedBundle(): {
  text: string;           // rendered markdown
  hash: string;           // SHA-256 of text
  blockNames: string[];   // in-order block labels for versionDescription
};
```

Included blocks (in order):
1. `SECURITY_BOUNDARY_BLOCK`
2. `IDENTITY_BLOCK`
3. `VOICE_BLOCK`
4. `FORM_FRAMEWORK_BLOCK`
5. `PROOF_SHAPE_BLOCK`
6. `NEVER_LIE_BLOCK`
7. `AGENCY_BOUNDARIES_BLOCK`
8. `VOCABULARY_BLOCK`

`SALES_FRAMEWORKS_BLOCK` is deliberately excluded — Hume configs are voice conversations, not SMS sales funnels. `CONTEXT_DIRECTIVES` are also excluded — voice context is the Hume-specific curated content below the marker.

### Data model

**New migration `20260420000002_hume_sync_runs.sql`:**

```sql
CREATE TABLE IF NOT EXISTS ops.hume_sync_runs (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  trigger         TEXT NOT NULL CHECK (trigger IN ('cron','admin','test')),
  bundle_hash     TEXT NOT NULL,
  bundle_changed  BOOLEAN NOT NULL,
  configs_checked INT NOT NULL DEFAULT 0,
  configs_updated INT NOT NULL DEFAULT 0,
  configs_failed  INT NOT NULL DEFAULT 0,
  hume_versions   JSONB,
  error           TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','ok','noop','partial','error'))
);
ALTER TABLE ops.hume_sync_runs ENABLE ROW LEVEL SECURITY;
-- service_role only; no policies.

CREATE TABLE IF NOT EXISTS ops.hume_config_registry (
  slug              TEXT PRIMARY KEY CHECK (slug IN ('discovery','new-member','implementation')),
  hume_config_id    UUID NOT NULL,
  hume_prompt_id    UUID NOT NULL,
  last_synced_at    TIMESTAMPTZ,
  last_prompt_ver   INT,
  last_config_ver   INT,
  notes             TEXT
);
ALTER TABLE ops.hume_config_registry ENABLE ROW LEVEL SECURITY;
-- service_role only; seeded via a follow-up migration after one-time inspection.
```

**`sync_state` key:** `hume_evi_last_bundle_hash` — stores the last successfully-synced bundle hash for fast short-circuit.

### Edge function: `sync-hume-evi`

- **Path:** `supabase/functions/sync-hume-evi/index.ts` + shared helpers co-located (`markers.ts`, `humeClient.ts`).
- **Auth:** service-role Bearer (same pattern as `ghl-sales-followup`).
- **Entry request body:** `{trigger: 'cron' | 'admin' | 'test'}`.
- **Flow:**
  1. Insert `ops.hume_sync_runs` row with `status='running'`.
  2. Compute `buildHumeSharedBundle()`, hash, compare against `sync_state.hume_evi_last_bundle_hash`.
  3. If hash equal: update run row `status='noop'`, bundle_changed=false, return 200.
  4. Load `ops.hume_config_registry` (3 rows).
  5. For each config (parallel `Promise.allSettled`):
     - GET latest prompt via `hume-admin` `{method: 'GET', path: '/v0/evi/prompts/{prompt_id}'}`
     - Find `AIPHIL-SHARED-BEGIN/END` markers; if absent, prepend the marker block.
     - Replace marker region with fresh bundle.
     - POST new prompt version via `hume-admin` `{method: 'POST', path: '/v0/evi/prompts/{prompt_id}', payload: {text, versionDescription}}`.
     - POST new config version via `hume-admin` `{method: 'POST', path: '/v0/evi/configs/{config_id}', payload: {prompt: {id, version: <new>}, ...carryOverFields}}`.
     - On success: update `hume_config_registry` row with new versions.
  6. Update `ops.hume_sync_runs` row: status `'ok'` (all 3 succeeded), `'partial'` (1-2 failed), or `'error'` (all failed or pre-config failure). Per-config outcomes in `hume_versions` JSONB.
  7. On `'partial'` or `'error'`: call `writeAgentSignal` (same pattern as other edge functions) and send Google Chat alert.
  8. Update `sync_state.hume_evi_last_bundle_hash` only if at least one config succeeded.

### Admin manual trigger

`src/app/api/admin/sync-hume/route.ts` — mirrors `src/app/api/admin/sync-docs/route.ts`:
- POST-only, admin auth via existing pattern.
- Invokes the edge function with `{trigger: 'admin'}`.
- Returns the `hume_sync_runs` row.

### Cron registration

Migration `20260420000003_hume_sync_cron.sql`:

```sql
SELECT cron.schedule(
  'sync-hume-evi-nightly',
  '30 9 * * *',   -- 2:30am Pacific, off-peak
  $$SELECT net.http_post(
    url     := 'https://ylppltmwueasbdexepip.supabase.co/functions/v1/sync-hume-evi',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='supabase_anon_key')
    ),
    body    := '{"trigger":"cron"}'::jsonb
  )$$
);

INSERT INTO ops.cron_job_intent (jobname, owner_repo, purpose, local_tz, local_window, dst_strategy, notes)
VALUES (
  'sync-hume-evi-nightly',
  'ai-phil',
  'Nightly sync of _shared/salesVoice.ts shared blocks into the 3 Hume EVI prompts.',
  NULL,
  '09:30 UTC daily',
  'none-required',
  'Fixed UTC by design. Marker-region surgical splice; no-op when bundle hash unchanged. Short-circuits so 365 no-op runs/year do not churn Hume versions.'
) ON CONFLICT (jobname) DO NOTHING;
```

### Testing

Deno tests in `supabase/functions/sync-hume-evi/sync-hume-evi.test.ts`:

- `markers.test`: splice correctness (markers present, markers absent first-run, markers nested/malformed guards).
- `bundle.test`: `buildHumeSharedBundle` returns expected blocks in expected order; hash is deterministic across runs.
- `sync.test`: mock `hume-admin` fetch. Cases:
  1. Hash unchanged → noop, no Hume calls, `hume_sync_runs.status='noop'`.
  2. Hash changed → 3 configs × 2 POSTs each = 6 Hume calls, all succeed, `status='ok'`.
  3. One config prompt POST fails → 2 configs succeed, `status='partial'`, signal + alert fired.
  4. Hume prompt POST succeeds but config POST fails → registry is NOT updated, retry on next run repoints.
  5. Missing config_registry row → `status='error'`, no Hume calls.

End-to-end smoke: one-time manual POST to `/admin/sync-hume?dryRun=true` (optional `dryRun` flag returns what would be posted without calling Hume) before turning on the cron.

### Bootstrap sequence (one-time, executed by next session)

1. Deploy `sync-hume-evi` edge function (with `dryRun` flag).
2. Apply migrations `20260420000002_hume_sync_runs.sql` and `20260420000003_hume_sync_cron.sql` (cron will start firing nightly).
3. One-time via `hume-admin` MCP call: inspect each of the 3 configs, capture `hume_config_id` + `hume_prompt_id` + current prompt text, manually inject the `<!-- AIPHIL-SHARED-BEGIN/END -->` markers in each Hume prompt at the top via dashboard (or by hitting the sync endpoint with `dryRun=false` after seeding the registry).
4. Seed `ops.hume_config_registry` via a follow-up migration.
5. Run the admin trigger once with `dryRun=true`, review output, then run without dryRun. Confirm `hume_sync_runs.status='ok'` and `ops.cron_schedule_audit` shows OK for the new job.

### Security + close-out

- `get_advisors('security')` must be clean after migrations (Step 1 drift-fix guardrail).
- No secrets in SQL (grep for `eyJ` before commit).
- `ops.cron_schedule_audit` must show OK for `sync-hume-evi-nightly` (new jobname must appear in registry).
- Session summary must record: edge function version, bundle hash at first successful sync, per-config Hume prompt/config versions shipped.
- Close-out §5: add memory entry `project_hume_sync_shipped.md` once live.

### Rollback

- Edge function bug: redeploy prior version.
- Bad bundle shipped to Hume: manually re-POST prior prompt version to each config (versions retained by Hume); update `sync_state.hume_evi_last_bundle_hash` to the prior hash to prevent re-firing.
- Full disable: `SELECT cron.unschedule('sync-hume-evi-nightly')` + revert `ops.cron_job_intent` row.

### File map

```
supabase/functions/sync-hume-evi/
  index.ts                    # entry
  markers.ts                  # splice helpers + tests
  humeClient.ts               # hume-admin proxy wrapper
  sync-hume-evi.test.ts       # Deno tests
supabase/functions/_shared/
  salesVoice.ts               # add buildHumeSharedBundle() export
supabase/migrations/
  20260420000002_hume_sync_runs.sql
  20260420000003_hume_sync_cron.sql
  20260420000004_hume_config_registry_seed.sql  # after one-time inspection
src/app/api/admin/sync-hume/route.ts
docs/superpowers/plans/2026-04-20-hume-evi-nightly-sync-plan.md
```

### KPI mapping

- **KPI #1 (Phillip hrs/wk ≤ 5):** removes recurring manual copy-paste on every shared-block edit (currently every security/identity/voice/form/proof/never-lie/agency/vocabulary change triggers 3 manual pastes). Small per-incident, but compounds.
- **KPI #3 (silent-agent count = 0):** new cron registered in `ops.cron_job_intent`, self-monitored by `ops.cron_schedule_audit`. Per-run audit row in `ops.hume_sync_runs` — cannot fail silently.

### NN mapping

- **NN #1 (one AI Phil brain across every surface):** this spec IS the implementation for the Hume half of NN #1. Sales SMS + email surfaces already read `salesVoice.ts` at boot; after this ships, Hume EVI voice surfaces sync from it within 24h.
- **NN #2 (prompt-injection safeguards on every surface):** `SECURITY_BOUNDARY_BLOCK` stops drifting off voice surfaces.
- **NN #4 (no silent failures):** `hume_sync_runs` + `cron_schedule_audit` + partial-failure alerting.
