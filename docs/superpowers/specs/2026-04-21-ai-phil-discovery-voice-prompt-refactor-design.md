# AI Phil Discovery — Voice Prompt Refactor

**Date:** 2026-04-21
**Author:** Claude (brainstorming session with Phillip)
**Scope:** Discovery Hume EVI config only. New Member + Implementation Coach left on the existing "full" bundle.

## Problem

The Discovery Hume EVI prompt is 17,471 chars. Hume's speech model truncates at 7,000. All Discovery-specific voice-pacing rules (*"Keep responses to 1-2 sentences"*, *"Ask only one question at a time"*, *"Mirror their words"*) and the 6-step conversation arc currently sit past position ~11,100 in the prompt. **The speech model cannot see them.** This is the root cause of Discovery sounding like it plows straight in — it's behaving on generic voice guidance from the shared bundle, with no Discovery pacing instructions visible.

Secondary issue: the prompt is near the top of Hume's recommended 2–5k-token band (8k–20k chars). Trimming frees cache headroom for a more stable cache signature.

## Goals

1. Final Discovery prompt fits inside the 7,000-char speech-model window (all safety, voice-pacing, and arc content visible to the speech model, not just semantic content).
2. Discovery-specific voice-pacing rules appear in the first ~2,300 chars.
3. Voice consistency with GHL agents preserved — voice content still sources from `supabase/functions/_shared/salesVoice.ts` (respects Non-Negotiable #1).
4. Zero blast radius to `ghl-sales-agent`, `ghl-member-agent`, `ghl-sales-followup`, and the New Member + Implementation Coach Hume configs.

## Non-Goals

- Refactoring New Member or Implementation Coach Hume prompts. Follow-up ship once this pattern is verified live.
- Changing `buildSystemPrompt()` or anything the GHL agents consume.
- Removing `buildHumeSharedBundle()` or `buildHumeDiscoveryAddendum()` — they stay in place for variant=`'full'` consumers.

## Final Prompt Shape (target ~6,850 chars)

Top → bottom in the Hume dashboard:

| # | Region | Source | ~Chars | Cumulative |
|---|---|---|---|---|
| 1 | Discovery wrapper | Hume-dashboard authored, outside markers | 2,350 | 2,350 |
| 2 | `AIPHIL-SHARED-BEGIN` … `AIPHIL-SHARED-END` | `buildHumeVoiceBundle()` | 3,900 | 6,250 |
| 3 | `AIPHIL-DISCOVERY-ADDENDUM-BEGIN` … `AIPHIL-DISCOVERY-ADDENDUM-END` | `buildHumeDiscoveryVoiceAddendum()` | 600 | 6,850 |

**Marker names stay the same** (`AIPHIL-SHARED-*` and `AIPHIL-DISCOVERY-ADDENDUM-*`). The voice vs. full distinction is expressed in the registry row, not the marker names — Discovery's `bundle_variant` tells syncCore which builder to call; the marker delimiters are identical.

## Discovery Wrapper (authored text, Hume dashboard, ~2,350 chars)

```
# Voice rules for this config

Keep responses to 1-2 sentences. Let the prospect talk. Ask only one
question at a time. Mirror their words back — if they say "spinning my
wheels," use "spinning my wheels." Validate before you pivot. Never
pitch features, only transformation. Never name competitors. Never
apologize for or discount the price.

# Discovery context

You're on the AIAI Mastermind landing page. This conversation IS the
prospect's discovery experience — no booked call, no follow-up team.
You're warm, genuinely curious, no pressure. You ask more than you
state. You listen more than you talk.

# Conversation arc

1. Open. The first message already asked for their name and agency
   basics. When they answer, dig in with curiosity: "What made you stop
   and look at this today?"
2. Diagnose. Find the real pain. "What's the biggest challenge in your
   agency right now?" Let them describe it in their words.
3. Amplify. Slow down on the pain. "How long has that been going on?"
   "What's that costing you, time, money, or mental weight?"
4. Vision. Lift the energy. "If that problem was solved, what would
   change for your agency?"
5. Bridge. Connect their outcome to the program. "That's exactly what
   agents are getting inside AIAI Mastermind." Specific to what they
   told you. No feature lists.
6. Decision. Invite them in directly. "Based on what you've shared,
   this sounds like a fit. Membership is $549/month or $5,499/year.
   You can start right now at https://aiaimastermind.com/join." Then
   silence. Let them respond. When they confirm, call
   book_discovery_call to capture name + email.

# Objection cheatsheet (stay curious, never defensive)

- Price: "What would it cost your agency to stay where you are for
  another year?"
- "Need to think": "Totally fair. What's the main thing you'd want to
  think through?"
- Too busy: "What would have to be true for this to feel like the
  right time?"
- Tried before: "What happened with that? What did it miss for you?"
- Skeptical: "What would you need to see to believe this could work
  for your agency?"
- Spouse/partner: "Absolutely. How soon can you both take a look
  together?"
- Just want recordings: "What moves the needle is the live
  implementation and having someone in your corner. What's behind
  the question?"

# Tools

search_knowledge_base(query) for specific questions about programs,
pricing, or modules. book_discovery_call(first_name, email, ...) when
they commit.

# Not a fit

If clearly not a captive insurance agent: "This is built for captive
agency owners, can you tell me more about your situation so I can
make sure it's the right fit?"
```

## `AIPHIL-SHARED` region content (voice variant, ~3,900 chars)

Rendered by a new `buildHumeVoiceBundle()` in `_shared/salesVoice.ts`. Contents (in order):

**1. `IDENTITY_VOICE_BLOCK` (~425 chars)** — lightly tightened from current `IDENTITY_BLOCK`. Drops nothing substantive; just word-trim.

**2. `VOICE_HORMOZI_VOICE_BLOCK` (~710 chars)** — merges current `VOICE_BLOCK` + Hormozi opener into one block. Voice attributes as a compact bullet list. Hormozi rule as 3 lines.

**3. `SECURITY_VOICE_BLOCK` (~1,050 chars)** — compressed from current `SECURITY_BOUNDARY_BLOCK` (2,200 chars):
- Keeps: override-attempt language, never-reveal list (single paragraph), default-unknown posture, refusal mode (one canonical phrasing).
- **Drops:** Tier 1/2 identity taxonomy (Discovery is always Tier 0), tool-use boundaries table (Discovery exposes only two tools, listed inline in the wrapper), secondary refusal phrasing, "indirect probing" paragraph (covered by aggregate-level rule in never-reveal list).

**4. `FORM_VOICE_BLOCK` (~440 chars)** — compressed from current `FORM_FRAMEWORK_BLOCK` (1,100 chars). Four pillars in one paragraph plus the "at most one fact per reply, never list-dump" rule. Drops pillar explainers (what a "recreation fact" is is self-evident to a coach).

**5. `NEVER_LIE_VOICE_BLOCK` (~470 chars)** — consolidates 7 rules → 4. Merges #2+#4 (no fabrication of numbers/case studies/events) and #5+#6 (don't pretend access, don't fabricate familiarity). Keeps #1 (never claim to be Phillip) and #7 (escalate when you can't answer honestly) verbatim in spirit.

**6. `AGENCY_BOUNDARIES_VOICE_BLOCK` (~720 chars)** — compressed from `AGENCY_BOUNDARIES_BLOCK` (1,100 chars). Drops the "do instead" examples bullet list (education/self-serve/weekly-call options). Keeps the core rule and the two canonical declining phrasings.

**Dropped from voice variant entirely** (rely on `search_knowledge_base` retrieval):
- `PROOF_SHAPE_BLOCK` — it's a template, model can apply gestalt of "cite real agencies with real numbers" from VOICE_HORMOZI.
- `INSURANCE_VOCABULARY_BLOCK` — 900-char glossary, low per-call relevance, model can retrieve when vocabulary comes up.

## `AIPHIL-DISCOVERY-ADDENDUM` region content (voice variant, ~600 chars)

Rendered by `buildHumeDiscoveryVoiceAddendum()`. Compressed branded acronym rule:

```
# AiAi product acronyms — expand on first mention

Prospects haven't been through the program. On first mention in a
reply, expand the acronym with a brief positioning phrase. Later
mentions in the same reply can be bare.

- MAX = Marketing Ads Accelerator (Google Ads mastery program)
- MAYA = Marketing Assistant to Your Agency (AI social media system)
- ATOM = Automated Team Onboarding Machine (AI training builder)
- SARA = automated recruiting pipeline (roadmap Q3 2026)
- AVA = AI interview system (roadmap Q3 2026)
- ATLAS = financial dashboard and operational analysis (roadmap Q4 2026)

Exception: if the prospect used the acronym first, skip the expansion.
```

## Code Surface Changes

### `supabase/functions/_shared/salesVoice.ts`

**New exports (appended, no replacements):**
- `IDENTITY_VOICE_BLOCK`, `VOICE_HORMOZI_VOICE_BLOCK`, `SECURITY_VOICE_BLOCK`, `FORM_VOICE_BLOCK`, `NEVER_LIE_VOICE_BLOCK`, `AGENCY_BOUNDARIES_VOICE_BLOCK`, `BRANDED_ACRONYM_VOICE_BLOCK`
- `buildHumeVoiceBundle(): Promise<HumeBundle>` — concatenates the voice blocks
- `buildHumeDiscoveryVoiceAddendum(): Promise<HumeBundle>` — wraps `BRANDED_ACRONYM_VOICE_BLOCK`

**Unchanged:**
- All existing blocks (`IDENTITY_BLOCK`, `VOICE_BLOCK`, `SECURITY_BOUNDARY_BLOCK`, `FORM_FRAMEWORK_BLOCK`, `PROOF_SHAPE_BLOCK`, `NEVER_LIE_BLOCK`, `AGENCY_BOUNDARIES_BLOCK`, `INSURANCE_VOCABULARY_BLOCK`, `BRANDED_ACRONYM_EXPANSION_BLOCK`, `VOCABULARY_BLOCK` shim)
- `buildSystemPrompt()` — GHL agents' builder
- `buildHumeSharedBundle()` and `buildHumeDiscoveryAddendum()` — 'full'-variant consumers

### Database: `ops.hume_config_registry`

Migration: `supabase/migrations/YYYYMMDDHHMMSS_hume_config_registry_bundle_variant.sql`

```sql
ALTER TABLE ops.hume_config_registry
  ADD COLUMN bundle_variant TEXT NOT NULL DEFAULT 'full'
  CHECK (bundle_variant IN ('full', 'voice'));

COMMENT ON COLUMN ops.hume_config_registry.bundle_variant IS
  'Which salesVoice builder to use when syncing this config. ''full'' uses '
  'buildHumeSharedBundle + buildHumeDiscoveryAddendum (the canonical long-form '
  'bundle for GHL-equivalent surfaces). ''voice'' uses buildHumeVoiceBundle + '
  'buildHumeDiscoveryVoiceAddendum, a compressed variant sized for Hume EVI '
  'speech model''s 7k-char window. Discovery config is ''voice'' as of 2026-04-21; '
  'New Member + Implementation Coach remain ''full'' until future ship.';

UPDATE ops.hume_config_registry
  SET bundle_variant = 'voice'
  WHERE slug = 'discovery';
```

### `supabase/functions/sync-hume-evi/syncCore.ts`

**`RegistryRow`** — add `bundle_variant: 'full' | 'voice'` field.

**`SyncDeps`** — replace:
```ts
buildBundle: () => Promise<BundleOut>;
buildAddendum: () => Promise<BundleOut>;
loadLastBundleHash: () => Promise<string | null>;
loadLastAddendumHash: () => Promise<string | null>;
saveLastBundleHash: (hash: string) => Promise<void>;
saveLastAddendumHash: (hash: string) => Promise<void>;
```
with per-variant variants:
```ts
buildBundle: (variant: 'full' | 'voice') => Promise<BundleOut>;
buildAddendum: (variant: 'full' | 'voice') => Promise<BundleOut>;
loadLastBundleHash: (variant: 'full' | 'voice') => Promise<string | null>;
loadLastAddendumHash: (variant: 'full' | 'voice') => Promise<string | null>;
saveLastBundleHash: (variant: 'full' | 'voice', hash: string) => Promise<void>;
saveLastAddendumHash: (variant: 'full' | 'voice', hash: string) => Promise<void>;
```

**`runSync`**: iterates variants in use across registry rows, computes bundle + addendum per variant, checks "any variant changed" for noop detection, dispatches each registry row to its variant's bundle/addendum when splicing.

**`syncOneConfig`**: takes an additional `variant` parameter (or pulls from row), calls the right builder's output.

### `supabase/functions/sync-hume-evi/index.ts`

`SyncDeps` wiring updated to pass variant-aware builders and per-variant sync_state keys:
- `hume_evi_last_bundle_hash:full`
- `hume_evi_last_bundle_hash:voice`
- `hume_evi_last_addendum_hash:full` (keyed per-variant for the Discovery addendum; current key is `hume_evi_last_addendum_hash:discovery`, we migrate to the variant-keyed form)
- `hume_evi_last_addendum_hash:voice`

Data migration for existing sync_state: on first voice sync, the voice hash keys are null, so sync treats as "changed" and runs — expected.

### `supabase/functions/sync-hume-evi/markers.ts`

**No changes.** Voice and full variants share `AIPHIL-SHARED-*` and `AIPHIL-DISCOVERY-ADDENDUM-*` marker delimiters. The registry row's `bundle_variant` determines which content goes inside, not which marker.

## Migration Sequence

Ordered to keep the live Discovery config working at every step:

1. **Code changes shipped to `supabase/functions/_shared/salesVoice.ts`** — new blocks + builders + unit tests. No behavior change yet (nothing calls the new builders).
2. **syncCore + index.ts refactored** — per-variant builder dispatch. Registry rows default to `'full'`, so current behavior is preserved.
3. **DB migration applied** — adds `bundle_variant` column, flips Discovery to `'voice'`.
4. **`sync-hume-evi` edge function redeployed** with new code.
5. **Manually rewrite the Discovery Hume dashboard prompt:** move the wrapper text to the TOP, replace with the new ~2,350-char wrapper from this spec, keep the two marker regions below (they'll be re-synced on next run).
6. **Trigger sync:** `POST /api/admin/sync-hume` with admin bearer.
7. **Verify:** Hume dashboard shows updated Discovery prompt; `get_edge_function` + SQL check `ops.hume_sync_runs` for `status='ok'`; total char count in Hume dashboard < 7,000.
8. **Live test:** load the embed widget on `aiphil.aiaimastermind.com`, run through the 6-step arc, confirm the agent respects 1-2 sentence responses and one question at a time.

## Testing

- **Unit tests (per new block):** snapshot-style — import each `*_VOICE_BLOCK` and assert it contains the key rule (e.g., `NEVER_LIE_VOICE_BLOCK` contains `"Never claim to be Phillip"`). Keeps regressions out of the rule set without freezing exact wording.
- **`buildHumeVoiceBundle` / `buildHumeDiscoveryVoiceAddendum` tests:** verify hash stability across runs (deterministic), char-count sanity (bundle < 4,500, addendum < 800).
- **`syncCore` tests:** a mock registry with one `'full'` row and one `'voice'` row; assert each row gets the right bundle content spliced in. Assert hashes are tracked per variant (voice row's content drift does not retrigger the full row).
- **Live smoke after deploy:** trigger sync, assert `ops.hume_sync_runs` has one new row with `status='ok'` and `configs_updated >= 1`; assert Hume Discovery prompt includes the new wrapper text and is < 7,000 chars.

## Blast Radius Verification

- **GHL agents** (`ghl-sales-agent`, `ghl-member-agent`, `ghl-sales-followup`) call `buildSystemPrompt()`, which we do not touch. ✅
- **New Member + Implementation Coach** Hume configs: their registry rows stay `bundle_variant='full'`. syncCore continues to call `buildHumeSharedBundle()` + `buildHumeDiscoveryAddendum()` for them. Their synced content is unchanged bit-for-bit (same builders, same bundle hash, sync detects noop and skips). ✅
- **sync_state key migration:** adding new per-variant keys doesn't affect the existing `hume_evi_last_bundle_hash` and `hume_evi_last_addendum_hash:discovery` keys. First voice sync treats voice hash as new and runs (expected). After first voice sync, the old `hume_evi_last_bundle_hash` key becomes orphaned — manual cleanup in a follow-up, non-blocking.

## Follow-ups (not in this ship)

- **Hume prompt-text retrieval path:** extend `sync-hume-evi` `bootstrap-inspect` mode to optionally return the full prompt text (not just metadata) so future sessions can read Hume prompts via Supabase MCP. Tracked in `memory/feedback_try_retrieval_before_asking.md`. 1-session follow-up.
- **New Member + Implementation Coach voice refactor:** same pattern as Discovery; author their wrappers + flip `bundle_variant` to `'voice'`. Schedule after 1-week live validation of Discovery.
- **Orphan sync_state key cleanup:** remove `hume_evi_last_bundle_hash` (un-variant-keyed) and `hume_evi_last_addendum_hash:discovery` keys after all configs migrated. Low-priority housekeeping.

## Rollback Plan

If the voice-refactored Discovery prompt degrades live behavior:

1. In the Hume dashboard, restore the previous wrapper text (keep a copy before the swap).
2. In DB: `UPDATE ops.hume_config_registry SET bundle_variant = 'full' WHERE slug = 'discovery';`
3. Trigger sync: next run will repopulate the shared region with `buildHumeSharedBundle()` content, matching pre-ship state.

No code rollback required — `bundle_variant` column is additive and the full-variant path is unchanged.
