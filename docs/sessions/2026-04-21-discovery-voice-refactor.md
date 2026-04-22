# 2026-04-21 — Discovery voice prompt refactor

## Pick up here

**Live state:** Discovery Hume EVI config on voice variant. Total prompt
**7,449 chars** (down from 17,471 = 57% reduction). Voice-pacing rules
now sit in first ~2,300 chars — inside Hume's 7,000-char speech-model
window. Live smoke test in the embed widget on aiphil.aiaimastermind.com
passed (Phillip confirmed).

**Pending human action:** none. Ship is complete.

**Blocked:** nothing.

**Next priority:** New Member + Implementation Coach voice refactor —
same pattern as Discovery, after ~1 week of live validation on Discovery.

**Read these first:**
- `docs/superpowers/specs/2026-04-21-ai-phil-discovery-voice-prompt-refactor-design.md`
- `docs/superpowers/plans/2026-04-21-ai-phil-discovery-voice-prompt-refactor.md`

## What shipped

**Code (27 commits ahead of origin/main):**
- 7 voice-compressed blocks in `_shared/salesVoice.ts`: `IDENTITY_VOICE_BLOCK`,
  `VOICE_HORMOZI_VOICE_BLOCK`, `SECURITY_VOICE_BLOCK`, `FORM_VOICE_BLOCK`,
  `NEVER_LIE_VOICE_BLOCK`, `AGENCY_BOUNDARIES_VOICE_BLOCK`, `BRANDED_ACRONYM_VOICE_BLOCK`.
- `buildHumeVoiceBundle()` + `buildHumeDiscoveryVoiceAddendum()` builders.
- `ops.hume_config_registry.bundle_variant` column ('full' default, 'voice'
  for Discovery) with CHECK constraint.
- `syncCore.ts` per-variant dispatch — `RegistryRow.bundle_variant` routes
  to variant-specific builders; per-variant hash tracking prevents
  cross-variant re-syncs.
- `sync-hume-evi/index.ts` wired to new variant contract + NEW `set-wrapper`
  admin mode that accepts `{slug, wrapper_text}` and does the Hume POST
  directly. This mode closes the "handoff to human" gap — Claude Code can
  now rewrite Hume wrappers via Supabase MCP + pg_net, no HUME_TOOL_SECRET
  paste required.
- `sync-hume-evi` edge function deployed: **v4** (from v2). Byte parity
  verified against local HEAD.
- Discovery Hume prompt rewritten: prompt v3, config v7.

**DB migrations applied to prod:**
- `20260421000000_hume_config_registry_bundle_variant.sql` — adds column,
  flips Discovery, migrates sync_state keys to per-variant form.
- `20260422000000_hume_sync_runs_set_wrapper_trigger.sql` — widens
  `hume_sync_runs.trigger` CHECK to allow `'set-wrapper'` (discovered
  mid-ship when the new mode's audit insert silently failed).

**Verified behaviors:**
- Variant isolation: run #4 scanned all 3 configs, only Discovery synced;
  New Member + Implementation Coach correctly skipped (full-variant hash
  unchanged).
- `set-wrapper` end-to-end: run #6 (trigger=set-wrapper) succeeded, prompt
  version advanced 2→3, config version 6→7, status=ok.

## Known issues / follow-ups

- **Orphan sync_state keys:** `hume_evi_last_bundle_hash` (un-variant-keyed)
  and `hume_evi_last_addendum_hash:discovery` (slug-keyed) still present
  but unused. Low-priority cleanup.
- **Final prompt is 7,449 chars, overshooting the 6,850 spec target by ~600.**
  All speech-window-critical content (voice-pacing rules, identity,
  voice+Hormozi, security) is inside the first ~5,400 chars. Tail content
  past 7k is F.O.R.M. + never-lie + agency-boundaries + addendum, all
  semantic (supplemental LLM sees it). If live behavior degrades, trim
  objection cheatsheet + persona paragraph in the wrapper to land under 7k.
- **Audit log `bundle_hash` / `addendum_hash` fields in `ops.hume_sync_runs`**
  report the 'full' variant representative even on voice-only runs. Known
  semantic limitation — code reviewer flagged it, deferred to follow-up.
  Per-variant hashes are tracked in `sync_state` for the authoritative record.
- **Negative duration on run 6** (`set-wrapper` path): `completed_at <
  started_at` by ~77ms. Clock-ordering quirk in the update path, cosmetic.

## Cross-repo follow-ups

None — this ship is self-contained to ai-phil repo.

## Vault sync needed (Shared drive — cannot be done from this repo)

Phillip to mirror into `vault/` when convenient:
- `vault/50-meetings/2026-04-21-discovery-voice-refactor.md` — this file
- `vault/60-content/ai-phil/_ROADMAP.md` — move "Discovery voice refactor"
  item to Shipped 2026-04-21
- `vault/60-content/ai-phil/AI-Phil-Brain.md` — optionally note that
  Discovery is now on a voice-compressed prompt variant

## Commits

```
605e3b5 feat(sync-hume-evi): set-wrapper admin mode for Hume prompt authored sections
41b8d54 feat(sync-hume-evi): wire per-variant bundle dispatch in handler
5f43f75 refactor(sync-hume-evi): per-variant bundle dispatch in syncCore
877028b feat(migration): hume_config_registry bundle_variant column + Discovery flip
ada90cb feat(salesVoice): add buildHumeVoiceBundle + buildHumeDiscoveryVoiceAddendum
50ace02 feat(salesVoice): add 7 voice-compressed blocks for Hume EVI speech window
55a2598 docs(plan): Discovery voice prompt refactor implementation plan
6282d27 docs(spec): Discovery voice prompt refactor design
```

Plus the `20260422000000_hume_sync_runs_set_wrapper_trigger.sql` migration
committed in the same `605e3b5` commit (set-wrapper admin mode).

## Starter prompt for next session

```
Pick up from 2026-04-21 Discovery voice refactor ship.
Live state: Discovery Hume EVI at 7,449 chars, voice variant, prompt v3.
Next: New Member + Implementation Coach voice refactor (wait ~1 week for
Discovery validation first). Same pattern — author their wrappers, flip
bundle_variant='voice' in ops.hume_config_registry, use set-wrapper mode
in sync-hume-evi to push.
Read docs/sessions/2026-04-21-discovery-voice-refactor.md first.
```
