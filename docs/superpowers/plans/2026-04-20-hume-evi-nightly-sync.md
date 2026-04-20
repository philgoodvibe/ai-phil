# Hume EVI Nightly Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship nightly sync of shared prompt blocks from `_shared/salesVoice.ts` into the three Hume EVI prompts (Discovery / New Member / Implementation Coach), plus the admin-trigger fast path, closing Non-Negotiable #1 on voice surfaces.

**Architecture:** Marker-region surgical splice: each Hume prompt carries a `<!-- AIPHIL-SHARED-BEGIN/END -->` region that the sync replaces; Discovery also carries a `<!-- AIPHIL-DISCOVERY-ADDENDUM-BEGIN/END -->` region for the prospect-only acronym-expansion block. Sync function is a Supabase edge function, triggered nightly by pg_cron or on demand by `/api/admin/sync-hume`. Hash short-circuit avoids churning Hume versions on no-op nights. All Hume API calls go through the existing `hume-admin` v5 proxy.

**Tech Stack:** Deno edge functions (Supabase, TypeScript strict) • `deno test` for unit tests • Supabase MCP (`apply_migration`, `deploy_edge_function`, `get_advisors`, `execute_sql`) for ops • Hume REST API via `hume-admin` • Next.js 14 App Router for admin route • pg_cron + `ops.cron_job_intent` audit.

**Spec:** `docs/superpowers/specs/2026-04-20-hume-evi-nightly-sync-design.md` (at commit `a4aeb6f`).

**Source authority:** `_system/architecture.md` (Drive `1FrLGjuQz400cORLlwU0qisz9ZdJoOba3`) NN #1 + Step 1 deliverables. Standing Orders: `80-processes/Working-With-Phillip.md` (Drive `1Lsbx1KR1fFAj308qB_gLAfdszJ_JxueY`).

---

## Task 0: Pre-flight

**Files:** none

- [ ] **Step 0.1: Confirm clean working tree**

```bash
cd "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Ai Phil"
git status --short
```

Expected: clean (no `M`, no `??` except for `.next/`, `node_modules/`, or already-gitignored dirs).

- [ ] **Step 0.2: Confirm deployed edge functions match committed source**

Via Supabase MCP `list_edge_functions`, record: `hume-admin` v5, `ghl-sales-agent` v14, `ghl-member-agent` v5, `ghl-sales-followup` v5. If any deployed version differs from local committed source (diff via `get_edge_function`), STOP and run the CLAUDE.md "deployed-but-uncommitted" recovery first.

- [ ] **Step 0.3: Confirm Hume env vars are set locally**

```bash
grep -E "^(HUME_API_KEY|HUME_EVI_CONFIG_NEW_MEMBER|HUME_EVI_CONFIG_IMPLEMENTATION|HUME_EVI_CONFIG_DISCOVERY|SYNC_ADMIN_SECRET)" .env.local | wc -l
```

Expected: `5`. If less, stop and ask Phil which ones are missing — `SYNC_ADMIN_SECRET` especially (it's the auth secret for the admin route; also used by `/api/admin/sync-docs`).

- [ ] **Step 0.4: Confirm Supabase edge secret `HUME_TOOL_SECRET` is set**

Via Supabase MCP `execute_sql` against the secrets table is not possible (vault access); instead: manually confirm with Phil or attempt a no-op `hume-admin` call via MCP. Call through `hume-admin`:

```
POST to https://ylppltmwueasbdexepip.supabase.co/functions/v1/hume-admin
headers: { "x-tool-secret": "<HUME_TOOL_SECRET from .env.local if present>" }
body: { "method": "GET", "path": "/v0/evi/configs?pageSize=1" }
```

Expected: `200` with `ok: true` and a body containing Hume config data. If 401 Unauthorized, stop and ask Phil for the current `HUME_TOOL_SECRET`.

---

## Task 1: Split `VOCABULARY_BLOCK` into universal + prospect-only (TDD)

**Files:**
- Modify: `supabase/functions/_shared/salesVoice.ts`
- Modify: `supabase/functions/_shared/salesVoice.test.ts`

Context: `VOCABULARY_BLOCK` today conflates insurance-operator vocabulary (universal) with the branded-acronym expansion rule (prospect-only). The fix: split into `INSURANCE_VOCABULARY_BLOCK` + `BRANDED_ACRONYM_EXPANSION_BLOCK`; keep `VOCABULARY_BLOCK` as a deprecation shim (re-export concatenation) so no edge function breaks mid-ship. `buildSystemPrompt` appends the acronym block only for `sales-*` contexts; `INSURANCE_VOCABULARY_BLOCK` appends universally.

- [ ] **Step 1.1: Write failing tests — split blocks + shim parity**

Append to `supabase/functions/_shared/salesVoice.test.ts`:

```ts
import {
  INSURANCE_VOCABULARY_BLOCK,
  BRANDED_ACRONYM_EXPANSION_BLOCK,
  VOCABULARY_BLOCK,
  buildSystemPrompt,
} from './salesVoice.ts';

Deno.test('INSURANCE_VOCABULARY_BLOCK has operator vocab + no acronym-expansion rule', () => {
  assert(INSURANCE_VOCABULARY_BLOCK.includes('PIF'));
  assert(INSURANCE_VOCABULARY_BLOCK.includes('quote-to-bind'));
  assert(INSURANCE_VOCABULARY_BLOCK.includes('State Farm'));
  // acronym-expansion rule must NOT be here
  assert(!INSURANCE_VOCABULARY_BLOCK.includes('Marketing Ads Accelerator'));
  assert(!INSURANCE_VOCABULARY_BLOCK.includes('ALWAYS expand on first mention'));
});

Deno.test('BRANDED_ACRONYM_EXPANSION_BLOCK has MAX/MAYA/ATOM expansions', () => {
  assert(BRANDED_ACRONYM_EXPANSION_BLOCK.includes('MAX = Marketing Ads Accelerator'));
  assert(BRANDED_ACRONYM_EXPANSION_BLOCK.includes('MAYA = Marketing Assistant'));
  assert(BRANDED_ACRONYM_EXPANSION_BLOCK.includes('ATOM = Automated Team Onboarding'));
  assert(BRANDED_ACRONYM_EXPANSION_BLOCK.includes('first mention'));
});

Deno.test('VOCABULARY_BLOCK shim equals insurance + acronym concat', () => {
  const expected = `${INSURANCE_VOCABULARY_BLOCK}\n\n${BRANDED_ACRONYM_EXPANSION_BLOCK}`;
  assertEquals(VOCABULARY_BLOCK, expected);
});

Deno.test('sales-live prompt includes both new blocks', () => {
  const p = buildSystemPrompt('sales-live', { family: [], occupation: [], recreation: [], money: [] }, '');
  assert(p.includes('PIF'));
  assert(p.includes('MAX = Marketing Ads Accelerator'));
});

Deno.test('support prompt includes insurance vocab but NOT acronym-expansion', () => {
  const p = buildSystemPrompt('support', { family: [], occupation: [], recreation: [], money: [] }, '');
  assert(p.includes('PIF'), 'members are operators; insurance vocab stays');
  assert(!p.includes('MAX = Marketing Ads Accelerator'), 'members already know the acronyms');
});
```

- [ ] **Step 1.2: Run tests — confirm they fail**

```bash
cd "supabase/functions/_shared" && deno test salesVoice.test.ts
```

Expected: failures on the new tests (`INSURANCE_VOCABULARY_BLOCK is not defined` et al).

- [ ] **Step 1.3: Refactor `VOCABULARY_BLOCK` in `salesVoice.ts`**

Replace the existing `VOCABULARY_BLOCK` export (at around line 433 in the current file) with:

```ts
/** Insurance-operator vocabulary. Applies to every AI Phil surface — members and
 *  prospects are both insurance operators; using their native vocabulary makes
 *  Phil sound like Phil on every channel. Split from the former VOCABULARY_BLOCK
 *  2026-04-20 after flagging the composition bug in the Hume-sync design review. */
export const INSURANCE_VOCABULARY_BLOCK = `# Preferred operator vocabulary

Use these insurance-operator terms naturally when they fit. They are Phillip's actual vocabulary from 759 Fathom meetings.

Product / program names (use verbatim when referencing):
- Insurance Marketing Machine (IMM)
- Google Ads Mastery
- Automated Agency Circle

Operator terminology (prefer over generic business-speak):
- PIF (policies in force)
- Premium, premium volume, written premium, retained premium
- Close rate, quote-to-bind, quote ratio
- Retention, retention ratio
- Production per producer, staff leverage
- Book of business, carrier mix, carrier relationships
- Lines of business: auto, home, commercial, life, workers comp
- OEP (open enrollment period), renewal
- Cost per click, cost per lead
- Captive vs. independent, organic vs. acquired growth

Use specific carrier names when relevant: State Farm, Allstate, Farmers, Prime, etc. "A State Farm agent in Dallas" beats "an agent in the Midwest."`;

/** Branded AIAI product acronym expansion rule. Prospect-only: members already
 *  know MAX/MAYA/ATOM. Auto-expansion on a member voice surface reads pedantic. */
export const BRANDED_ACRONYM_EXPANSION_BLOCK = `# Branded AiAi product acronyms — ALWAYS expand on first mention

Prospects from cold or sales contexts have NOT been through the program. They do not know what MAX, MAYA, ATOM, SARA, AVA, or ATLAS mean. Dropping a bare acronym reads like insider jargon and breaks trust.

Rule: on first mention in any reply, expand the acronym with a brief positioning phrase. On subsequent mentions in the same reply, the bare acronym is fine.

Canonical expansions (use exactly these):
- MAX = Marketing Ads Accelerator (our Google Ads mastery program)
- MAYA = Marketing Assistant to Your Agency (our AI social media system)
- ATOM = Automated Team Onboarding Machine (our AI training and onboarding builder)
- SARA = automated recruiting pipeline (roadmap Q3 2026)
- AVA = AI interview system (roadmap Q3 2026)
- ATLAS = financial dashboard and operational analysis (roadmap Q4 2026)

Good: "MAX, our Marketing Ads Accelerator program, is built for exactly this. MAX handles six Google Ads campaign types end to end."
Bad: "That's what MAX was built for." (bare acronym on first mention, no expansion, reads like insider jargon.)

Exception: if the prospect has already used the acronym in their own message (they know the product), you can skip the expansion on your first mention.`;

/** DEPRECATED — do not use in new code. Shim concatenating INSURANCE_VOCABULARY_BLOCK
 *  + BRANDED_ACRONYM_EXPANSION_BLOCK so existing callers continue to compile for
 *  one release cycle. Remove after all callers audited. */
export const VOCABULARY_BLOCK = `${INSURANCE_VOCABULARY_BLOCK}\n\n${BRANDED_ACRONYM_EXPANSION_BLOCK}`;
```

- [ ] **Step 1.4: Update `buildSystemPrompt` composition**

Replace the sales-only gate (around line 631 today) with a universal insurance-vocab append and a sales-only acronym append:

```ts
  // Insurance operator vocabulary applies to every surface — members are operators too.
  blocks.push(INSURANCE_VOCABULARY_BLOCK);

  if (context.startsWith('sales-')) {
    blocks.push(SALES_FRAMEWORKS_BLOCK);
    blocks.push(BRANDED_ACRONYM_EXPANSION_BLOCK);
  }
```

(Remove the old `blocks.push(VOCABULARY_BLOCK);` line inside the `sales-*` branch.)

- [ ] **Step 1.5: Re-run tests — all pass**

```bash
cd "supabase/functions/_shared" && deno test salesVoice.test.ts
```

Expected: all green, including any pre-existing tests (the old `VOCABULARY_BLOCK` tests should still pass via the shim).

- [ ] **Step 1.6: Commit**

```bash
git add supabase/functions/_shared/salesVoice.ts supabase/functions/_shared/salesVoice.test.ts
git commit -m "$(cat <<'EOF'
refactor(salesVoice): split VOCABULARY_BLOCK into universal + prospect-only

INSURANCE_VOCABULARY_BLOCK applies to every AI Phil surface (members
and prospects are both operators). BRANDED_ACRONYM_EXPANSION_BLOCK is
prospect-only (members already know MAX/MAYA/ATOM; auto-expansion on
voice reads pedantic).

buildSystemPrompt now appends INSURANCE_VOCABULARY_BLOCK universally
and BRANDED_ACRONYM_EXPANSION_BLOCK only for sales-* contexts. Legacy
VOCABULARY_BLOCK export remains as a one-release shim.

Prereq for Hume EVI nightly sync (spec 2026-04-20).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `buildHumeSharedBundle` + `buildHumeDiscoveryAddendum` exports (TDD)

**Files:**
- Modify: `supabase/functions/_shared/salesVoice.ts`
- Modify: `supabase/functions/_shared/salesVoice.test.ts`

Context: The Hume-sync edge function needs deterministic renders of (a) the universal shared bundle for all 3 configs and (b) the Discovery-only addendum, plus SHA-256 hashes for short-circuit logic.

- [ ] **Step 2.1: Write failing tests — bundle composition + determinism + hash shape**

Append to `salesVoice.test.ts`:

```ts
import { buildHumeSharedBundle, buildHumeDiscoveryAddendum } from './salesVoice.ts';

Deno.test('buildHumeSharedBundle includes the 8 expected blocks in order', () => {
  const b = buildHumeSharedBundle();
  assertEquals(b.blockNames, [
    'SECURITY_BOUNDARY_BLOCK',
    'IDENTITY_BLOCK',
    'VOICE_BLOCK',
    'FORM_FRAMEWORK_BLOCK',
    'PROOF_SHAPE_BLOCK',
    'NEVER_LIE_BLOCK',
    'AGENCY_BOUNDARIES_BLOCK',
    'INSURANCE_VOCABULARY_BLOCK',
  ]);
  // First block (security) must appear before second (identity) in text.
  const secIdx = b.text.indexOf('Security boundaries (non-negotiable)');
  const idIdx = b.text.indexOf('# Identity');
  assert(secIdx >= 0 && idIdx > secIdx, 'security must precede identity');
  // Excluded
  assert(!b.text.includes('Branded AiAi product acronyms'), 'acronym rule stays out of shared bundle');
  assert(!b.text.includes('# Sales frameworks'), 'sales playbook stays out');
});

Deno.test('buildHumeSharedBundle is deterministic — same text + hash across calls', () => {
  const a = buildHumeSharedBundle();
  const b = buildHumeSharedBundle();
  assertEquals(a.text, b.text);
  assertEquals(a.hash, b.hash);
  // SHA-256 hex is 64 chars
  assertEquals(a.hash.length, 64);
  assert(/^[0-9a-f]{64}$/.test(a.hash));
});

Deno.test('buildHumeDiscoveryAddendum = BRANDED_ACRONYM_EXPANSION_BLOCK only', () => {
  const a = buildHumeDiscoveryAddendum();
  assertEquals(a.blockNames, ['BRANDED_ACRONYM_EXPANSION_BLOCK']);
  assert(a.text.includes('MAX = Marketing Ads Accelerator'));
  // The addendum is a small doc — not the whole shared bundle
  assert(a.text.length < 2000);
  assertEquals(a.hash.length, 64);
});
```

- [ ] **Step 2.2: Run — confirm failures**

```bash
cd "supabase/functions/_shared" && deno test salesVoice.test.ts
```

Expected: three new failures (`buildHumeSharedBundle is not defined`).

- [ ] **Step 2.3: Implement the two exports in `salesVoice.ts`**

Add near the bottom of `salesVoice.ts`, after `buildSystemPrompt`:

```ts
// ---------------------------------------------------------------------------
// Hume EVI nightly sync — render helpers
// ---------------------------------------------------------------------------

const SHARED_BUNDLE_BLOCKS: Array<[string, string]> = [
  ['SECURITY_BOUNDARY_BLOCK', SECURITY_BOUNDARY_BLOCK],
  ['IDENTITY_BLOCK', IDENTITY_BLOCK],
  ['VOICE_BLOCK', VOICE_BLOCK],
  ['FORM_FRAMEWORK_BLOCK', FORM_FRAMEWORK_BLOCK],
  ['PROOF_SHAPE_BLOCK', PROOF_SHAPE_BLOCK],
  ['NEVER_LIE_BLOCK', NEVER_LIE_BLOCK],
  ['AGENCY_BOUNDARIES_BLOCK', AGENCY_BOUNDARIES_BLOCK],
  ['INSURANCE_VOCABULARY_BLOCK', INSURANCE_VOCABULARY_BLOCK],
];

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface HumeBundle {
  text: string;
  hash: string;
  blockNames: string[];
}

/** Render the universal shared-block bundle for Hume EVI prompts. Every Hume
 *  config (Discovery / New Member / Implementation Coach) receives this in the
 *  AIPHIL-SHARED marker region. */
export async function buildHumeSharedBundle(): Promise<HumeBundle> {
  const text = SHARED_BUNDLE_BLOCKS.map(([, body]) => body).join('\n\n---\n\n');
  const hash = await sha256Hex(text);
  const blockNames = SHARED_BUNDLE_BLOCKS.map(([name]) => name);
  return { text, hash, blockNames };
}

/** Discovery-only addendum: branded AIAI acronym expansion rule. The Discovery
 *  Hume config serves prospects who have not been through the program; members
 *  already know the acronyms. Not included in New Member / Implementation Coach. */
export async function buildHumeDiscoveryAddendum(): Promise<HumeBundle> {
  const text = BRANDED_ACRONYM_EXPANSION_BLOCK;
  const hash = await sha256Hex(text);
  return { text, hash, blockNames: ['BRANDED_ACRONYM_EXPANSION_BLOCK'] };
}
```

**Note on async:** `buildHumeSharedBundle` must be `async` because `crypto.subtle.digest` is async. Update the test file's calls to `await buildHumeSharedBundle()`.

- [ ] **Step 2.4: Adjust tests to await async functions**

Change the test bodies added in Step 2.1 from synchronous to `async` with `await`:

```ts
Deno.test('buildHumeSharedBundle includes the 8 expected blocks in order', async () => {
  const b = await buildHumeSharedBundle();
  // ...same asserts as before...
});
// and the other two tests similarly
```

- [ ] **Step 2.5: Run tests — all green**

```bash
cd "supabase/functions/_shared" && deno test salesVoice.test.ts
```

Expected: all pass.

- [ ] **Step 2.6: Commit**

```bash
git add supabase/functions/_shared/salesVoice.ts supabase/functions/_shared/salesVoice.test.ts
git commit -m "$(cat <<'EOF'
feat(salesVoice): add buildHumeSharedBundle + buildHumeDiscoveryAddendum

Deterministic render + SHA-256 hash of the shared prompt blocks used
by the Hume EVI nightly sync. Shared bundle is the 8 universal blocks
in canonical order. Discovery addendum is the prospect-only acronym-
expansion rule, carried in a separate marker region on the Discovery
config only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create `ops.hume_sync_runs` + `ops.hume_config_registry` tables

**Files:**
- Create: `supabase/migrations/20260420000002_hume_sync_runs.sql`

- [ ] **Step 3.1: Write the migration**

Write the file exactly:

```sql
-- 20260420000002_hume_sync_runs.sql
--
-- Phase 0 Task 4 — Hume EVI nightly sync support tables.
--
-- ops.hume_sync_runs: one row per sync invocation (cron, admin, or test).
-- ops.hume_config_registry: one row per Hume EVI config (3 at ship; grows if
-- phone voice or additional configs join later). Seeded in a follow-up
-- migration after one-time inspection of each config's current prompt_id.
--
-- Design spec: docs/superpowers/specs/2026-04-20-hume-evi-nightly-sync-design.md

-- ---------------------------------------------------------------------------
-- hume_sync_runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.hume_sync_runs (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  trigger         TEXT NOT NULL CHECK (trigger IN ('cron','admin','test')),
  bundle_hash     TEXT NOT NULL,
  addendum_hash   TEXT,
  bundle_changed  BOOLEAN NOT NULL DEFAULT false,
  configs_checked INT NOT NULL DEFAULT 0,
  configs_updated INT NOT NULL DEFAULT 0,
  configs_failed  INT NOT NULL DEFAULT 0,
  hume_versions   JSONB,
  error           TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','ok','noop','partial','error'))
);

CREATE INDEX IF NOT EXISTS hume_sync_runs_started_at_desc_idx
  ON ops.hume_sync_runs (started_at DESC);

ALTER TABLE ops.hume_sync_runs ENABLE ROW LEVEL SECURITY;
-- No policies: service_role bypasses RLS; no anon/authenticated read.

COMMENT ON TABLE ops.hume_sync_runs IS
  'One row per sync-hume-evi invocation. trigger: cron | admin | test. status: running | ok (all configs updated) | noop (hash unchanged, no Hume calls) | partial (1-2 of 3 failed) | error (pre-config failure or all configs failed). hume_versions JSONB contains per-config {slug, prompt_version, config_version, error?}.';

-- ---------------------------------------------------------------------------
-- hume_config_registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.hume_config_registry (
  slug              TEXT PRIMARY KEY CHECK (slug IN ('discovery','new-member','implementation')),
  hume_config_id    UUID NOT NULL,
  hume_prompt_id    UUID NOT NULL,
  carries_addendum  BOOLEAN NOT NULL DEFAULT false,
  last_synced_at    TIMESTAMPTZ,
  last_prompt_ver   INT,
  last_config_ver   INT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ops.hume_config_registry ENABLE ROW LEVEL SECURITY;
-- No policies: service_role only.

COMMENT ON TABLE ops.hume_config_registry IS
  'Seeded registry of Hume EVI configs the sync function touches. slug is stable; hume_*_id are the Hume resource IDs. carries_addendum=true flags configs that additionally render the Discovery addendum region (currently only discovery). last_* fields are advisory — source of truth for the current Hume version is Hume itself.';

-- ---------------------------------------------------------------------------
-- sync_state key placeholder (documented here so future sessions see it)
-- ---------------------------------------------------------------------------
-- Runtime code writes these sync_state rows (schema ops.sync_state, created in
-- earlier migration 20260415000000_sync_state.sql):
--   key = 'hume_evi_last_bundle_hash', value = <sha256 hex of last synced shared bundle>
--   key = 'hume_evi_last_addendum_hash:discovery', value = <sha256 hex of last synced addendum>
```

- [ ] **Step 3.2: Apply via Supabase MCP**

Call `apply_migration` with name `hume_sync_runs` and the SQL above. Expected: success.

- [ ] **Step 3.3: Verify tables exist + RLS is enabled**

Via Supabase MCP `execute_sql`:

```sql
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'ops' AND tablename IN ('hume_sync_runs','hume_config_registry')
ORDER BY tablename;
```

Expected: 2 rows, both `rowsecurity = true`.

- [ ] **Step 3.4: Run security advisors**

Supabase MCP `get_advisors({"type": "security"})`. Expected: no new ERROR rows. If a new ERROR appears for either table, STOP and investigate before committing.

- [ ] **Step 3.5: Commit**

```bash
git add supabase/migrations/20260420000002_hume_sync_runs.sql
git commit -m "$(cat <<'EOF'
feat(migration): ops.hume_sync_runs + ops.hume_config_registry

Backing tables for the Hume EVI nightly sync edge function:
- hume_sync_runs: one row per invocation, status noop|ok|partial|error
- hume_config_registry: 3 rows post-seed (discovery|new-member|implementation)

RLS enabled on both; service_role only. Seed of the registry lands in
a follow-up migration after one-time inspection of each config's
current prompt_id via hume-admin.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Marker-region splice helpers with tests (TDD)

**Files:**
- Create: `supabase/functions/sync-hume-evi/markers.ts`
- Create: `supabase/functions/sync-hume-evi/markers.test.ts`

Context: The splice logic is pure and must be bulletproof — it mutates prompts that go live on voice surfaces. TDD the marker helpers before wiring the HTTP layer.

- [ ] **Step 4.1: Write the test file first**

Create `supabase/functions/sync-hume-evi/markers.test.ts`:

```ts
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { spliceMarkerRegion, SHARED_BEGIN, SHARED_END, makeMarkerBlock } from './markers.ts';

Deno.test('spliceMarkerRegion replaces an existing region in-place', () => {
  const prompt = `preamble\n\n${SHARED_BEGIN} v=old\nOLD BODY\n${SHARED_END}\n\ntail content`;
  const out = spliceMarkerRegion(prompt, { begin: SHARED_BEGIN, end: SHARED_END }, 'NEW BODY', 'abc123');
  assert(out.includes('NEW BODY'));
  assert(!out.includes('OLD BODY'));
  assert(out.includes('v=abc123'));
  // preamble and tail preserved
  assert(out.startsWith('preamble'));
  assert(out.endsWith('tail content'));
});

Deno.test('spliceMarkerRegion prepends markers when absent (first-run)', () => {
  const prompt = 'just some human-curated prompt content';
  const out = spliceMarkerRegion(prompt, { begin: SHARED_BEGIN, end: SHARED_END }, 'FRESH BODY', 'hashX');
  assert(out.startsWith(`${SHARED_BEGIN} v=hashX`));
  assert(out.includes('FRESH BODY'));
  assert(out.includes(SHARED_END));
  // Original content preserved below the markers
  assert(out.includes('just some human-curated prompt content'));
});

Deno.test('spliceMarkerRegion throws on malformed region (begin without end)', () => {
  const prompt = `${SHARED_BEGIN} v=x\nstuck open\n\n(no end marker)`;
  let threw = false;
  try { spliceMarkerRegion(prompt, { begin: SHARED_BEGIN, end: SHARED_END }, 'BODY', 'h'); }
  catch { threw = true; }
  assert(threw, 'malformed region must throw, not silently do nothing');
});

Deno.test('spliceMarkerRegion is idempotent with unchanged body', () => {
  const prompt = `${SHARED_BEGIN} v=h1\nBODY\n${SHARED_END}\nafter`;
  const once = spliceMarkerRegion(prompt, { begin: SHARED_BEGIN, end: SHARED_END }, 'BODY', 'h1');
  const twice = spliceMarkerRegion(once, { begin: SHARED_BEGIN, end: SHARED_END }, 'BODY', 'h1');
  assertEquals(once, twice);
});

Deno.test('makeMarkerBlock builds a valid region', () => {
  const block = makeMarkerBlock(SHARED_BEGIN, SHARED_END, 'inner', 'hashY');
  assert(block.includes(`${SHARED_BEGIN} v=hashY`));
  assert(block.includes('inner'));
  assert(block.includes(SHARED_END));
});
```

- [ ] **Step 4.2: Run tests — confirm failures**

```bash
cd supabase/functions/sync-hume-evi && deno test markers.test.ts
```

Expected: cannot resolve `./markers.ts`.

- [ ] **Step 4.3: Implement `markers.ts`**

Create `supabase/functions/sync-hume-evi/markers.ts`:

```ts
// markers.ts — pure splice helpers for Hume EVI prompt shared-block regions.
//
// Convention:
//   <!-- AIPHIL-SHARED-BEGIN v=<hash> -->
//   ...body...
//   <!-- AIPHIL-SHARED-END -->
//
// Or, for the Discovery-only addendum:
//   <!-- AIPHIL-DISCOVERY-ADDENDUM-BEGIN v=<hash> -->
//   ...body...
//   <!-- AIPHIL-DISCOVERY-ADDENDUM-END -->
//
// Splice rules:
// - If the begin+end pair is found, replace everything between them with the
//   new body and update the version annotation.
// - If neither marker is present, prepend a fresh marker block to the prompt.
// - If only begin is present (or only end), throw — the prompt is malformed
//   and a human needs to look at it.

export const SHARED_BEGIN = '<!-- AIPHIL-SHARED-BEGIN';
export const SHARED_END = '<!-- AIPHIL-SHARED-END -->';
export const ADDENDUM_BEGIN = '<!-- AIPHIL-DISCOVERY-ADDENDUM-BEGIN';
export const ADDENDUM_END = '<!-- AIPHIL-DISCOVERY-ADDENDUM-END -->';

export interface MarkerPair {
  begin: string;
  end: string;
}

/** Build a fresh marker block with body + version annotation. */
export function makeMarkerBlock(
  begin: string,
  end: string,
  body: string,
  versionHash: string,
): string {
  return `${begin} v=${versionHash} -->\n${body}\n${end}`;
}

/** Replace the region between begin/end with body+version. If neither marker
 *  is present, prepend a fresh marker block to the prompt. Throws on malformed
 *  regions (begin without end or vice versa). */
export function spliceMarkerRegion(
  prompt: string,
  pair: MarkerPair,
  body: string,
  versionHash: string,
): string {
  const hasBegin = prompt.includes(pair.begin);
  const hasEnd = prompt.includes(pair.end);

  if (hasBegin !== hasEnd) {
    throw new Error(
      `Malformed Hume prompt region: begin=${hasBegin} end=${hasEnd}. ` +
      `Human review required — do NOT sync until resolved.`,
    );
  }

  if (!hasBegin && !hasEnd) {
    // First-run bootstrap: prepend a fresh marker block to the existing prompt.
    const freshBlock = makeMarkerBlock(pair.begin, pair.end, body, versionHash);
    return prompt.startsWith(pair.begin)
      ? prompt
      : `${freshBlock}\n\n${prompt}`;
  }

  // Existing region: regex-replace from begin through end (non-greedy).
  const re = new RegExp(
    `${escapeRe(pair.begin)}[\\s\\S]*?${escapeRe(pair.end)}`,
    'g',
  );
  const freshBlock = makeMarkerBlock(pair.begin, pair.end, body, versionHash);
  return prompt.replace(re, freshBlock);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 4.4: Run tests — all pass**

```bash
cd supabase/functions/sync-hume-evi && deno test markers.test.ts
```

Expected: all 5 tests green.

- [ ] **Step 4.5: Commit**

```bash
git add supabase/functions/sync-hume-evi/markers.ts supabase/functions/sync-hume-evi/markers.test.ts
git commit -m "$(cat <<'EOF'
feat(sync-hume-evi): pure marker-region splice helpers + tests

spliceMarkerRegion replaces the AIPHIL-SHARED (or DISCOVERY-ADDENDUM)
region in-place, prepends a fresh marker block on first-run bootstrap,
and throws loudly on malformed (unbalanced) regions.

All logic is pure — no network, no file I/O. Tested with 5 Deno tests
covering replace, first-run, malformed throw, idempotency, and block
construction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Hume API client wrapper

**Files:**
- Create: `supabase/functions/sync-hume-evi/humeClient.ts`
- Create: `supabase/functions/sync-hume-evi/humeClient.test.ts`

Context: The sync function calls Hume via `hume-admin` proxy. This wrapper centralizes request shape, parses responses, and returns typed results so the main handler stays readable.

- [ ] **Step 5.1: Write the test file first**

Create `humeClient.test.ts`:

```ts
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { HumeClient, type HumeProxyFetch } from './humeClient.ts';

function mockFetch(responses: Array<{ status: number; ok: boolean; body: unknown }>): {
  calls: Array<{ method: string; path: string; payload?: unknown }>;
  fetch: HumeProxyFetch;
} {
  const calls: Array<{ method: string; path: string; payload?: unknown }> = [];
  let i = 0;
  const fetch: HumeProxyFetch = async ({ method, path, payload }) => {
    calls.push({ method, path, payload });
    const r = responses[i++] ?? { status: 500, ok: false, body: { error: 'no mock' } };
    return r;
  };
  return { calls, fetch };
}

Deno.test('getPromptLatest calls GET /v0/evi/prompts/{id}', async () => {
  const { calls, fetch } = mockFetch([
    { status: 200, ok: true, body: { id: 'p1', version: 3, text: 'hello' } },
  ]);
  const c = new HumeClient(fetch);
  const r = await c.getPromptLatest('p1');
  assertEquals(calls[0].method, 'GET');
  assertEquals(calls[0].path, '/v0/evi/prompts/p1');
  assertEquals(r.text, 'hello');
  assertEquals(r.version, 3);
});

Deno.test('postPromptVersion calls POST /v0/evi/prompts/{id} with text+desc', async () => {
  const { calls, fetch } = mockFetch([
    { status: 200, ok: true, body: { id: 'p1', version: 4 } },
  ]);
  const c = new HumeClient(fetch);
  const v = await c.postPromptVersion('p1', 'new text', 'security block bumped');
  assertEquals(calls[0].method, 'POST');
  assertEquals(calls[0].path, '/v0/evi/prompts/p1');
  assertEquals((calls[0].payload as { text: string }).text, 'new text');
  assertEquals(v, 4);
});

Deno.test('getConfigLatest parses prompt reference', async () => {
  const { fetch } = mockFetch([
    { status: 200, ok: true, body: { id: 'c1', version: 7, prompt: { id: 'p1', version: 3 } } },
  ]);
  const c = new HumeClient(fetch);
  const r = await c.getConfigLatest('c1');
  assertEquals(r.version, 7);
  assertEquals(r.promptId, 'p1');
  assertEquals(r.promptVersion, 3);
});

Deno.test('postConfigVersion includes prompt pointer + carry-over fields', async () => {
  const { calls, fetch } = mockFetch([
    { status: 200, ok: true, body: { id: 'c1', version: 8 } },
  ]);
  const c = new HumeClient(fetch);
  const current = { id: 'c1', version: 7, prompt: { id: 'p1', version: 3 }, voice: { name: 'Philip' } };
  const v = await c.postConfigVersion('c1', current, { id: 'p1', version: 4 });
  assertEquals(calls[0].method, 'POST');
  assertEquals(calls[0].path, '/v0/evi/configs/c1');
  const payload = calls[0].payload as { prompt: unknown; voice: unknown };
  assertEquals(payload.prompt, { id: 'p1', version: 4 });
  assertEquals(payload.voice, { name: 'Philip' }); // carried over
  assertEquals(v, 8);
});

Deno.test('any non-ok response throws a readable error', async () => {
  const { fetch } = mockFetch([{ status: 422, ok: false, body: { error: 'bad' } }]);
  const c = new HumeClient(fetch);
  let msg = '';
  try { await c.getPromptLatest('p1'); } catch (e) { msg = (e as Error).message; }
  assert(msg.includes('422'));
  assert(msg.includes('bad') || msg.toLowerCase().includes('error'));
});
```

- [ ] **Step 5.2: Run tests — confirm failures**

```bash
cd supabase/functions/sync-hume-evi && deno test humeClient.test.ts
```

Expected: module not found.

- [ ] **Step 5.3: Implement `humeClient.ts`**

```ts
// humeClient.ts — typed wrapper over the hume-admin edge function proxy.
// Centralizes request shape and response parsing for the sync function.

export interface HumeProxyResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

export interface HumeProxyRequest {
  method: 'GET' | 'POST';
  path: string;
  payload?: unknown;
}

export type HumeProxyFetch = (req: HumeProxyRequest) => Promise<HumeProxyResponse>;

export interface HumePrompt {
  id: string;
  version: number;
  text: string;
}

export interface HumeConfig {
  id: string;
  version: number;
  promptId: string;
  promptVersion: number;
  raw: Record<string, unknown>;   // full current config body, for carry-over on new version
}

export class HumeClient {
  constructor(private readonly proxyFetch: HumeProxyFetch) {}

  async getPromptLatest(promptId: string): Promise<HumePrompt> {
    const r = await this.proxyFetch({ method: 'GET', path: `/v0/evi/prompts/${promptId}` });
    if (!r.ok) throw new Error(`Hume GET prompt ${promptId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const b = r.body as { id: string; version: number; text: string };
    if (!b.id || typeof b.version !== 'number' || typeof b.text !== 'string') {
      throw new Error(`Hume GET prompt ${promptId} returned unexpected shape: ${JSON.stringify(b)}`);
    }
    return { id: b.id, version: b.version, text: b.text };
  }

  async postPromptVersion(promptId: string, text: string, versionDescription: string): Promise<number> {
    const r = await this.proxyFetch({
      method: 'POST',
      path: `/v0/evi/prompts/${promptId}`,
      payload: { text, versionDescription },
    });
    if (!r.ok) throw new Error(`Hume POST prompt ${promptId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const v = (r.body as { version?: number }).version;
    if (typeof v !== 'number') {
      throw new Error(`Hume POST prompt ${promptId} returned no version: ${JSON.stringify(r.body)}`);
    }
    return v;
  }

  async getConfigLatest(configId: string): Promise<HumeConfig> {
    const r = await this.proxyFetch({ method: 'GET', path: `/v0/evi/configs/${configId}` });
    if (!r.ok) throw new Error(`Hume GET config ${configId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const b = r.body as { id: string; version: number; prompt?: { id?: string; version?: number } };
    if (!b.prompt?.id || typeof b.prompt.version !== 'number') {
      throw new Error(`Hume GET config ${configId} missing prompt reference: ${JSON.stringify(b)}`);
    }
    return {
      id: b.id,
      version: b.version,
      promptId: b.prompt.id,
      promptVersion: b.prompt.version,
      raw: b as unknown as Record<string, unknown>,
    };
  }

  async postConfigVersion(
    configId: string,
    currentConfigBody: Record<string, unknown>,
    newPromptRef: { id: string; version: number },
  ): Promise<number> {
    // Carry over everything from the current config EXCEPT id/version (Hume sets those)
    // and replace `prompt` with the new reference.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, version: _version, ...carryOver } = currentConfigBody;
    const payload = { ...carryOver, prompt: newPromptRef };
    const r = await this.proxyFetch({ method: 'POST', path: `/v0/evi/configs/${configId}`, payload });
    if (!r.ok) throw new Error(`Hume POST config ${configId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const v = (r.body as { version?: number }).version;
    if (typeof v !== 'number') {
      throw new Error(`Hume POST config ${configId} returned no version: ${JSON.stringify(r.body)}`);
    }
    return v;
  }
}
```

- [ ] **Step 5.4: Run tests — all pass**

```bash
cd supabase/functions/sync-hume-evi && deno test humeClient.test.ts
```

- [ ] **Step 5.5: Commit**

```bash
git add supabase/functions/sync-hume-evi/humeClient.ts supabase/functions/sync-hume-evi/humeClient.test.ts
git commit -m "$(cat <<'EOF'
feat(sync-hume-evi): HumeClient wraps hume-admin proxy with typed methods

getPromptLatest / postPromptVersion / getConfigLatest / postConfigVersion.
Every call goes through an injected HumeProxyFetch so unit tests can
assert on path + payload without hitting the network. Non-ok responses
throw readable errors with status + body.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Main `sync-hume-evi` edge function handler (TDD)

**Files:**
- Create: `supabase/functions/sync-hume-evi/index.ts`
- Create: `supabase/functions/sync-hume-evi/index.test.ts`
- Create: `supabase/functions/sync-hume-evi/syncCore.ts` (core orchestration, pure-ish — takes deps by injection)
- Create: `supabase/functions/sync-hume-evi/syncCore.test.ts`

Context: Separating `syncCore.ts` (all orchestration logic, injected deps — Hume client, supabase client stub, bundle builders, logger) from `index.ts` (HTTP wrapper + dep wiring) keeps the tested surface pure. This is the pattern from other edge functions.

- [ ] **Step 6.1: Write `syncCore.test.ts` — four key scenarios**

Create `supabase/functions/sync-hume-evi/syncCore.test.ts`:

```ts
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { runSync, type SyncDeps, type RegistryRow } from './syncCore.ts';
import { SHARED_BEGIN, SHARED_END, ADDENDUM_BEGIN, ADDENDUM_END } from './markers.ts';

function buildRegistry(): RegistryRow[] {
  return [
    { slug: 'discovery',      hume_config_id: 'c-d', hume_prompt_id: 'p-d', carries_addendum: true },
    { slug: 'new-member',     hume_config_id: 'c-n', hume_prompt_id: 'p-n', carries_addendum: false },
    { slug: 'implementation', hume_config_id: 'c-i', hume_prompt_id: 'p-i', carries_addendum: false },
  ];
}

function wrap(preamble: string, body: string, hash: string, begin: string, end: string): string {
  return `${preamble}\n${begin} v=${hash} -->\n${body}\n${end}\n(tail)`;
}

function baseDeps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return {
    buildBundle: async () => ({ text: 'NEW_BUNDLE', hash: 'h-new', blockNames: ['SECURITY_BOUNDARY_BLOCK'] }),
    buildAddendum: async () => ({ text: 'NEW_ADDENDUM', hash: 'h-add', blockNames: ['BRANDED_ACRONYM_EXPANSION_BLOCK'] }),
    loadRegistry: async () => buildRegistry(),
    loadLastBundleHash: async () => 'h-old',
    loadLastAddendumHash: async () => 'h-add-old',
    saveLastBundleHash: async () => {},
    saveLastAddendumHash: async () => {},
    hume: {
      getPromptLatest: async (pid) => ({ id: pid, version: 1, text: wrap('pre', 'OLD_BODY', 'h-old', SHARED_BEGIN, SHARED_END) }),
      postPromptVersion: async () => 2,
      getConfigLatest: async (cid) => ({ id: cid, version: 5, promptId: cid.replace('c-','p-'), promptVersion: 1, raw: { id: cid, version: 5, prompt: { id: cid.replace('c-','p-'), version: 1 }, voice: { name: 'Philip' } } }),
      postConfigVersion: async () => 6,
    },
    updateRegistryRow: async () => {},
    trigger: 'test',
    log: () => {},
    ...overrides,
  };
}

Deno.test('noop when bundle+addendum hashes unchanged', async () => {
  const deps = baseDeps({
    loadLastBundleHash: async () => 'h-new',     // matches current
    loadLastAddendumHash: async () => 'h-add',   // matches current
  });
  const result = await runSync(deps);
  assertEquals(result.status, 'noop');
  assertEquals(result.configsChecked, 0);
  assertEquals(result.configsUpdated, 0);
});

Deno.test('happy path — bundle changed, all 3 configs update', async () => {
  const deps = baseDeps();
  const result = await runSync(deps);
  assertEquals(result.status, 'ok');
  assertEquals(result.configsChecked, 3);
  assertEquals(result.configsUpdated, 3);
  assertEquals(result.configsFailed, 0);
  assertEquals(result.humeVersions.length, 3);
  // Each entry has new prompt + config versions
  for (const v of result.humeVersions) {
    assertEquals(v.prompt_version, 2);
    assertEquals(v.config_version, 6);
    assert(!v.error);
  }
});

Deno.test('partial failure — one config errors, other two succeed', async () => {
  let calls = 0;
  const deps = baseDeps({
    hume: {
      ...baseDeps().hume,
      postPromptVersion: async () => {
        calls++;
        if (calls === 2) throw new Error('hume-500');
        return 2;
      },
    },
  });
  const result = await runSync(deps);
  assertEquals(result.status, 'partial');
  assertEquals(result.configsUpdated, 2);
  assertEquals(result.configsFailed, 1);
  const failed = result.humeVersions.find((v) => v.error);
  assert(failed, 'one entry should carry an error');
});

Deno.test('first-run bootstrap — markers absent, added without loss of tail content', async () => {
  const deps = baseDeps({
    hume: {
      ...baseDeps().hume,
      getPromptLatest: async (pid) => ({
        id: pid, version: 1,
        text: 'Human-curated Hume prompt with no markers yet.\n\nVoice rules: keep it short.',
      }),
      postPromptVersion: async (_pid, text) => {
        // assert the posted text still contains the original tail + freshly-prepended markers
        assert(text.includes('Human-curated Hume prompt with no markers yet'));
        assert(text.includes('Voice rules: keep it short'));
        assert(text.includes(SHARED_BEGIN));
        assert(text.includes(SHARED_END));
        assert(text.includes('NEW_BUNDLE'));
        return 2;
      },
    },
  });
  const result = await runSync(deps);
  assertEquals(result.status, 'ok');
});

Deno.test('Discovery addendum is posted only for slug=discovery', async () => {
  let addendumPromptCalls = 0;
  const deps = baseDeps({
    hume: {
      ...baseDeps().hume,
      postPromptVersion: async (_pid, text) => {
        if (text.includes('NEW_ADDENDUM')) addendumPromptCalls++;
        return 2;
      },
    },
  });
  await runSync(deps);
  // Addendum body ends up in exactly one config's prompt text (discovery).
  assertEquals(addendumPromptCalls, 1);
});
```

- [ ] **Step 6.2: Run tests — confirm module-not-found failures**

```bash
cd supabase/functions/sync-hume-evi && deno test syncCore.test.ts
```

Expected: `Cannot resolve ./syncCore.ts`.

- [ ] **Step 6.3: Implement `syncCore.ts`**

Create `syncCore.ts`:

```ts
// syncCore.ts — dependency-injected orchestration for the Hume EVI sync.
// All I/O (Hume, Supabase, sync_state) arrives via the SyncDeps interface so
// tests can drive every code path without a network or a database.

import {
  SHARED_BEGIN,
  SHARED_END,
  ADDENDUM_BEGIN,
  ADDENDUM_END,
  spliceMarkerRegion,
} from './markers.ts';
import type { HumeClient, HumePrompt, HumeConfig } from './humeClient.ts';

export interface RegistryRow {
  slug: 'discovery' | 'new-member' | 'implementation';
  hume_config_id: string;
  hume_prompt_id: string;
  carries_addendum: boolean;
}

export interface BundleOut {
  text: string;
  hash: string;
  blockNames: string[];
}

// Stripped-down HumeClient surface for injection
export interface HumeClientLite {
  getPromptLatest(promptId: string): Promise<HumePrompt>;
  postPromptVersion(promptId: string, text: string, versionDescription: string): Promise<number>;
  getConfigLatest(configId: string): Promise<HumeConfig>;
  postConfigVersion(configId: string, currentRaw: Record<string, unknown>, newPromptRef: { id: string; version: number }): Promise<number>;
}

export interface SyncDeps {
  buildBundle: () => Promise<BundleOut>;
  buildAddendum: () => Promise<BundleOut>;
  loadRegistry: () => Promise<RegistryRow[]>;
  loadLastBundleHash: () => Promise<string | null>;
  loadLastAddendumHash: () => Promise<string | null>;
  saveLastBundleHash: (hash: string) => Promise<void>;
  saveLastAddendumHash: (hash: string) => Promise<void>;
  updateRegistryRow: (slug: string, patch: { last_prompt_ver: number; last_config_ver: number; last_synced_at: string }) => Promise<void>;
  hume: HumeClientLite;
  trigger: 'cron' | 'admin' | 'test';
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface SyncVersionEntry {
  slug: string;
  prompt_version?: number;
  config_version?: number;
  error?: string;
}

export interface SyncResult {
  status: 'running' | 'ok' | 'noop' | 'partial' | 'error';
  bundleHash: string;
  addendumHash: string;
  bundleChanged: boolean;
  configsChecked: number;
  configsUpdated: number;
  configsFailed: number;
  humeVersions: SyncVersionEntry[];
  error?: string;
}

export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const bundle = await deps.buildBundle();
  const addendum = await deps.buildAddendum();
  const lastBundleHash = await deps.loadLastBundleHash();
  const lastAddendumHash = await deps.loadLastAddendumHash();

  const bundleChanged = lastBundleHash !== bundle.hash;
  const addendumChanged = lastAddendumHash !== addendum.hash;

  if (!bundleChanged && !addendumChanged) {
    deps.log('noop: bundle+addendum hashes unchanged', { bundleHash: bundle.hash });
    return {
      status: 'noop',
      bundleHash: bundle.hash,
      addendumHash: addendum.hash,
      bundleChanged: false,
      configsChecked: 0,
      configsUpdated: 0,
      configsFailed: 0,
      humeVersions: [],
    };
  }

  let registry: RegistryRow[];
  try {
    registry = await deps.loadRegistry();
  } catch (err) {
    return {
      status: 'error',
      bundleHash: bundle.hash,
      addendumHash: addendum.hash,
      bundleChanged,
      configsChecked: 0,
      configsUpdated: 0,
      configsFailed: 0,
      humeVersions: [],
      error: `loadRegistry failed: ${(err as Error).message}`,
    };
  }

  if (registry.length === 0) {
    return {
      status: 'error',
      bundleHash: bundle.hash,
      addendumHash: addendum.hash,
      bundleChanged,
      configsChecked: 0,
      configsUpdated: 0,
      configsFailed: 0,
      humeVersions: [],
      error: 'registry is empty — seed ops.hume_config_registry before syncing',
    };
  }

  const entries: SyncVersionEntry[] = [];
  await Promise.all(
    registry.map(async (row) => {
      try {
        const v = await syncOneConfig(row, bundle, addendum, deps);
        entries.push({ slug: row.slug, prompt_version: v.promptVersion, config_version: v.configVersion });
        await deps.updateRegistryRow(row.slug, {
          last_prompt_ver: v.promptVersion,
          last_config_ver: v.configVersion,
          last_synced_at: new Date().toISOString(),
        });
      } catch (err) {
        entries.push({ slug: row.slug, error: (err as Error).message });
        deps.log(`config ${row.slug} failed: ${(err as Error).message}`);
      }
    }),
  );

  const configsUpdated = entries.filter((e) => !e.error).length;
  const configsFailed = entries.filter((e) => e.error).length;

  let status: SyncResult['status'];
  if (configsFailed === 0) status = 'ok';
  else if (configsUpdated === 0) status = 'error';
  else status = 'partial';

  // Only advance the hash if at least one config succeeded — prevents "we think
  // we synced but didn't" drift.
  if (configsUpdated > 0) {
    if (bundleChanged) await deps.saveLastBundleHash(bundle.hash);
    if (addendumChanged) await deps.saveLastAddendumHash(addendum.hash);
  }

  return {
    status,
    bundleHash: bundle.hash,
    addendumHash: addendum.hash,
    bundleChanged,
    configsChecked: registry.length,
    configsUpdated,
    configsFailed,
    humeVersions: entries,
  };
}

async function syncOneConfig(
  row: RegistryRow,
  bundle: BundleOut,
  addendum: BundleOut,
  deps: SyncDeps,
): Promise<{ promptVersion: number; configVersion: number }> {
  const current = await deps.hume.getPromptLatest(row.hume_prompt_id);
  let newText = spliceMarkerRegion(
    current.text,
    { begin: SHARED_BEGIN, end: SHARED_END },
    bundle.text,
    bundle.hash.slice(0, 12),
  );
  if (row.carries_addendum) {
    newText = spliceMarkerRegion(
      newText,
      { begin: ADDENDUM_BEGIN, end: ADDENDUM_END },
      addendum.text,
      addendum.hash.slice(0, 12),
    );
  }

  const desc = `salesVoice sync ${deps.trigger}: bundle=${bundle.hash.slice(0, 12)}${row.carries_addendum ? ` addendum=${addendum.hash.slice(0, 12)}` : ''}`;
  const promptVersion = await deps.hume.postPromptVersion(row.hume_prompt_id, newText, desc);

  const currentConfig = await deps.hume.getConfigLatest(row.hume_config_id);
  const configVersion = await deps.hume.postConfigVersion(
    row.hume_config_id,
    currentConfig.raw,
    { id: row.hume_prompt_id, version: promptVersion },
  );

  return { promptVersion, configVersion };
}
```

- [ ] **Step 6.4: Run syncCore tests — all pass**

```bash
cd supabase/functions/sync-hume-evi && deno test syncCore.test.ts
```

- [ ] **Step 6.5: Implement `index.ts` — HTTP wrapper + real dep wiring**

Create `supabase/functions/sync-hume-evi/index.ts`:

```ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  buildHumeSharedBundle,
  buildHumeDiscoveryAddendum,
} from '../_shared/salesVoice.ts';
import { HumeClient, type HumeProxyFetch, type HumeProxyResponse } from './humeClient.ts';
import { runSync, type RegistryRow } from './syncCore.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const HUME_TOOL_SECRET = Deno.env.get('HUME_TOOL_SECRET')!;
const HUME_ADMIN_URL = `${SUPABASE_URL}/functions/v1/hume-admin`;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

const humeProxyFetch: HumeProxyFetch = async ({ method, path, payload }) => {
  const res = await fetch(HUME_ADMIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tool-secret': HUME_TOOL_SECRET,
    },
    body: JSON.stringify({ method, path, payload }),
  });
  const body = await res.json() as HumeProxyResponse;
  // hume-admin already returns { status, ok, body } — pass through
  return body;
};

const humeClient = new HumeClient(humeProxyFetch);

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Bearer auth — matches sync-knowledge-base / ghl-sales-followup pattern.
  // pg_cron supplies supabase_anon_key; admin route supplies service_role.
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ') || auth.length < 27) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { trigger?: 'cron' | 'admin' | 'test' };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const trigger = body.trigger ?? 'admin';

  // Insert a "running" sync run row up front so we can always find it in the audit.
  const { data: runInsert, error: runInsertErr } = await supabase
    .schema('ops')
    .from('hume_sync_runs')
    .insert({
      trigger,
      bundle_hash: 'pending',
      bundle_changed: false,
      status: 'running',
    })
    .select('id')
    .single();

  if (runInsertErr || !runInsert) {
    console.error('[sync-hume-evi] could not insert run row:', runInsertErr);
    return new Response(JSON.stringify({ error: 'audit_insert_failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const runId: number = runInsert.id as number;

  try {
    const result = await runSync({
      buildBundle: buildHumeSharedBundle,
      buildAddendum: buildHumeDiscoveryAddendum,
      loadRegistry: async () => {
        const { data, error } = await supabase
          .schema('ops')
          .from('hume_config_registry')
          .select('slug, hume_config_id, hume_prompt_id, carries_addendum');
        if (error) throw new Error(`registry load: ${error.message}`);
        return (data ?? []) as RegistryRow[];
      },
      loadLastBundleHash: async () => loadSyncState('hume_evi_last_bundle_hash'),
      loadLastAddendumHash: async () => loadSyncState('hume_evi_last_addendum_hash:discovery'),
      saveLastBundleHash: (h) => saveSyncState('hume_evi_last_bundle_hash', h),
      saveLastAddendumHash: (h) => saveSyncState('hume_evi_last_addendum_hash:discovery', h),
      updateRegistryRow: async (slug, patch) => {
        const { error } = await supabase
          .schema('ops')
          .from('hume_config_registry')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('slug', slug);
        if (error) throw new Error(`registry update ${slug}: ${error.message}`);
      },
      hume: humeClient,
      trigger,
      log: (m, meta) => console.log(`[sync-hume-evi] ${m}`, meta ?? ''),
    });

    await supabase
      .schema('ops')
      .from('hume_sync_runs')
      .update({
        completed_at: new Date().toISOString(),
        bundle_hash: result.bundleHash,
        addendum_hash: result.addendumHash,
        bundle_changed: result.bundleChanged,
        configs_checked: result.configsChecked,
        configs_updated: result.configsUpdated,
        configs_failed: result.configsFailed,
        hume_versions: result.humeVersions,
        error: result.error ?? null,
        status: result.status,
      })
      .eq('id', runId);

    if (result.status === 'partial' || result.status === 'error') {
      await writeAgentSignal({
        source_agent: 'sync-hume-evi',
        target_agent: 'quimby',
        signal_type: 'hume_sync_issue',
        status: result.status,
        priority: 3,
        payload: { run_id: runId, configs_failed: result.configsFailed, entries: result.humeVersions },
      });
      await postGoogleChat(
        `⚠️ Hume EVI sync ${result.status}: ${result.configsFailed}/${result.configsChecked} configs failed (run ${runId}).`,
      );
    }

    return new Response(JSON.stringify({ run_id: runId, ...result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = (err as Error).message;
    await supabase
      .schema('ops')
      .from('hume_sync_runs')
      .update({
        completed_at: new Date().toISOString(),
        status: 'error',
        error: msg,
      })
      .eq('id', runId);
    await postGoogleChat(`🚨 Hume EVI sync THREW: ${msg} (run ${runId}).`);
    return new Response(JSON.stringify({ run_id: runId, error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});

async function loadSyncState(key: string): Promise<string | null> {
  const { data, error } = await supabase
    .schema('ops')
    .from('sync_state')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw new Error(`sync_state load ${key}: ${error.message}`);
  return (data?.value as string | null) ?? null;
}

async function saveSyncState(key: string, value: string): Promise<void> {
  const { error } = await supabase
    .schema('ops')
    .from('sync_state')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(`sync_state save ${key}: ${error.message}`);
}

interface AgentSignalPayload {
  source_agent: string;
  target_agent: string;
  signal_type: string;
  status?: string;
  channel?: string;
  priority?: number;
  payload?: Record<string, unknown>;
}

async function writeAgentSignal(sig: AgentSignalPayload): Promise<void> {
  try {
    const { error } = await supabase.from('agent_signals').insert({
      source_agent: sig.source_agent,
      target_agent: sig.target_agent,
      signal_type: sig.signal_type,
      status: sig.status ?? 'delivered',
      channel: sig.channel ?? 'open',
      priority: sig.priority ?? 5,
      payload: sig.payload ?? {},
    });
    if (error) console.error('[agent_signals] insert error:', error.message);
  } catch (err) {
    console.error('[agent_signals] write threw:', err);
  }
}

async function postGoogleChat(text: string): Promise<void> {
  const url = Deno.env.get('GOOGLE_CHAT_WEBHOOK_URL');
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('[gchat] post threw:', err);
  }
}
```

- [ ] **Step 6.6: Run all sync-hume-evi tests — all pass**

```bash
cd supabase/functions/sync-hume-evi && deno test
```

Expected: all tests across `markers.test.ts`, `humeClient.test.ts`, `syncCore.test.ts` green.

- [ ] **Step 6.7: Commit**

```bash
git add supabase/functions/sync-hume-evi/
git commit -m "$(cat <<'EOF'
feat(sync-hume-evi): dependency-injected sync orchestrator + HTTP wrapper

runSync(deps) is pure-ish: all I/O arrives by injection so tests drive
every code path (noop hash short-circuit, happy path, partial failure,
first-run bootstrap, discovery-addendum targeting) without a network
or database.

index.ts wires real deps — Supabase client for registry + sync_state
+ hume_sync_runs audit; HumeClient over hume-admin proxy; writeAgentSignal
+ postGoogleChat on partial/error outcomes. Bearer-auth gate. Inserts
a 'running' run row up front so failures are never invisible.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Deploy edge function + one-time config inspection + seed registry

**Files:**
- Create: `supabase/migrations/20260420000003_hume_config_registry_seed.sql`

Context: we must deploy the edge function BEFORE seeding (so the seed migration can only ship with known-working IDs captured from live Hume).

- [ ] **Step 7.1: Deploy `sync-hume-evi` v1 via Supabase MCP**

Call `deploy_edge_function` with function_name `sync-hume-evi` and all four files (`index.ts`, `syncCore.ts`, `markers.ts`, `humeClient.ts`). The function imports `../_shared/salesVoice.ts` — follow the current ai-phil guardrail: try `name: "_shared/salesVoice.ts"` first, fall back to `name: "../_shared/salesVoice.ts"` if the bundler errors with "Module not found".

Expected: version `1` ACTIVE.

- [ ] **Step 7.2: Verify deploy matches local byte-for-byte (MANDATORY per CLAUDE.md)**

Via Supabase MCP `get_edge_function("sync-hume-evi")`, diff each file's content against the local committed source. If any drift, STOP and re-deploy with correct `name:` paths before proceeding.

- [ ] **Step 7.3: Inspect each of the 3 Hume configs via `hume-admin` (MCP one-shot)**

For each of `discovery`, `new-member`, `implementation` — use the env-var config IDs from `.env.local` (`HUME_EVI_CONFIG_DISCOVERY`, `_NEW_MEMBER`, `_IMPLEMENTATION`). Call via Bash (not edge function) through curl since this is a one-time read:

```bash
ANON_KEY=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)
TOOL_SECRET=$(grep '^HUME_TOOL_SECRET=' .env.local | cut -d= -f2-)

for slug in discovery new-member implementation; do
  case "$slug" in
    discovery)      CONFIG_ID=$(grep '^HUME_EVI_CONFIG_DISCOVERY=' .env.local | cut -d= -f2-) ;;
    new-member)     CONFIG_ID=$(grep '^HUME_EVI_CONFIG_NEW_MEMBER=' .env.local | cut -d= -f2-) ;;
    implementation) CONFIG_ID=$(grep '^HUME_EVI_CONFIG_IMPLEMENTATION=' .env.local | cut -d= -f2-) ;;
  esac
  echo "--- $slug ($CONFIG_ID) ---"
  curl -sS -X POST https://ylppltmwueasbdexepip.supabase.co/functions/v1/hume-admin \
    -H "x-tool-secret: $TOOL_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"method\":\"GET\",\"path\":\"/v0/evi/configs/$CONFIG_ID\"}" | jq '.body | {id, version, prompt: .prompt}'
done
```

Expected output per config: `{id: "<config_id>", version: <int>, prompt: {id: "<prompt_id>", version: <int>}}`. Record each `prompt.id` as `HUME_PROMPT_DISCOVERY`, `HUME_PROMPT_NEW_MEMBER`, `HUME_PROMPT_IMPLEMENTATION` in scratch notes for the next step. **If the `HUME_EVI_CONFIG_*` env values don't actually match real Hume configs (e.g., stale), STOP and ask Phil to reconcile before seeding.**

- [ ] **Step 7.4: Write the seed migration with captured IDs**

Create `supabase/migrations/20260420000003_hume_config_registry_seed.sql`:

```sql
-- 20260420000003_hume_config_registry_seed.sql
--
-- Seeds ops.hume_config_registry with the 3 live Hume EVI configs
-- (Discovery / New Member / Implementation Coach).
--
-- IDs captured 2026-04-20 via hume-admin proxy one-shot inspection.
-- Only the Discovery config carries the branded-acronym addendum region;
-- the other two serve members who already know MAX/MAYA/ATOM.

INSERT INTO ops.hume_config_registry
  (slug, hume_config_id, hume_prompt_id, carries_addendum, notes)
VALUES
  ('discovery',      '7b0c4b13-f495-449a-884a-5f3e38c661c0'::uuid, '<PROMPT_ID_FROM_STEP_7_3>'::uuid, true,
   'Prospect-facing voice config. Carries BRANDED_ACRONYM_EXPANSION_BLOCK in the AIPHIL-DISCOVERY-ADDENDUM region.'),
  ('new-member',     '9e13d89f-3f42-4609-8060-32d36965d73e'::uuid, '<PROMPT_ID_FROM_STEP_7_3>'::uuid, false,
   'New-member voice config. Shared bundle only.'),
  ('implementation', '500e7bd2-5fc5-4bd1-90b8-e0b6d61a4eaf'::uuid, '<PROMPT_ID_FROM_STEP_7_3>'::uuid, false,
   'Implementation Coach voice config. Shared bundle only.')
ON CONFLICT (slug) DO UPDATE SET
  hume_config_id   = EXCLUDED.hume_config_id,
  hume_prompt_id   = EXCLUDED.hume_prompt_id,
  carries_addendum = EXCLUDED.carries_addendum,
  notes            = EXCLUDED.notes,
  updated_at       = now();
```

Replace each `<PROMPT_ID_FROM_STEP_7_3>` with the literal UUID captured in Step 7.3. If any prompt_id is missing or invalid, STOP.

- [ ] **Step 7.5: Apply the seed migration**

Supabase MCP `apply_migration` with name `hume_config_registry_seed`. Expected: success.

Verify:
```sql
SELECT slug, hume_config_id, hume_prompt_id, carries_addendum FROM ops.hume_config_registry ORDER BY slug;
```
Expected: 3 rows. `discovery` has `carries_addendum = true`; the other two `false`.

- [ ] **Step 7.6: Run `get_advisors('security')` — clean**

No new ERROR rows.

- [ ] **Step 7.7: Commit**

```bash
git add supabase/migrations/20260420000003_hume_config_registry_seed.sql
git commit -m "$(cat <<'EOF'
feat(migration): seed ops.hume_config_registry with 3 live Hume EVI configs

IDs captured 2026-04-20 via one-time hume-admin proxy inspection.
Only Discovery carries_addendum=true (prospect-only acronym-expansion
block). New Member + Implementation Coach serve members who already
know MAX/MAYA/ATOM — shared bundle only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `/api/admin/sync-hume` Next.js route

**Files:**
- Create: `src/app/api/admin/sync-hume/route.ts`

- [ ] **Step 8.1: Write the route**

Create `src/app/api/admin/sync-hume/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-sync-secret");
  if (!secret || secret !== process.env.SYNC_ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { error: "Supabase env vars not configured" },
      { status: 500 },
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await supabase.functions.invoke("sync-hume-evi", {
    body: { trigger: "admin" },
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
```

- [ ] **Step 8.2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 8.3: Commit**

```bash
git add src/app/api/admin/sync-hume/route.ts
git commit -m "$(cat <<'EOF'
feat(api): /api/admin/sync-hume manual trigger for the Hume EVI sync

Mirrors /api/admin/sync-docs — x-sync-secret auth, invokes the
sync-hume-evi edge function with trigger='admin'. Returns the
sync run body (status, configs_updated, hume_versions).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: First live sync via admin endpoint, verify markers land correctly

**Files:** none

Context: run the actual sync once before scheduling the cron. We want to catch any surprise in the real Hume response shape BEFORE it fires unattended at 2:30am.

- [ ] **Step 9.1: Trigger the admin endpoint**

```bash
SECRET=$(grep '^SYNC_ADMIN_SECRET=' .env.local | cut -d= -f2-)
curl -sS -X POST https://ai-phil.vercel.app/api/admin/sync-hume \
  -H "x-sync-secret: $SECRET" \
  -H "Content-Type: application/json" | jq .
```

Expected response:
```json
{
  "run_id": <int>,
  "status": "ok",
  "bundleHash": "<64-hex>",
  "addendumHash": "<64-hex>",
  "bundleChanged": true,
  "configsChecked": 3,
  "configsUpdated": 3,
  "configsFailed": 0,
  "humeVersions": [
    {"slug": "discovery", "prompt_version": <n+1>, "config_version": <m+1>},
    {"slug": "new-member", "prompt_version": <n+1>, "config_version": <m+1>},
    {"slug": "implementation", "prompt_version": <n+1>, "config_version": <m+1>}
  ]
}
```

If any slug has `error` field, STOP and investigate. Common first-run error: marker splice hits a malformed region — unlikely because first-run prepends markers, but check `ops.hume_sync_runs` row for full error text.

- [ ] **Step 9.2: Fetch each post-sync prompt and verify marker region is present**

```bash
TOOL_SECRET=$(grep '^HUME_TOOL_SECRET=' .env.local | cut -d= -f2-)
# Using hume-admin proxy for each prompt_id captured in Task 7.3:
for pid in <PROMPT_ID_DISCOVERY> <PROMPT_ID_NEW_MEMBER> <PROMPT_ID_IMPLEMENTATION>; do
  echo "--- $pid ---"
  curl -sS -X POST https://ylppltmwueasbdexepip.supabase.co/functions/v1/hume-admin \
    -H "x-tool-secret: $TOOL_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"method\":\"GET\",\"path\":\"/v0/evi/prompts/$pid\"}" \
    | jq -r '.body.text' | head -20
done
```

Expected: every prompt starts with `<!-- AIPHIL-SHARED-BEGIN v=<12-hex> -->`, contains `Security boundaries (non-negotiable)`, contains `Preferred operator vocabulary`, and ends its shared region with `<!-- AIPHIL-SHARED-END -->` before the human-curated content. Only the Discovery prompt contains `<!-- AIPHIL-DISCOVERY-ADDENDUM-BEGIN` and `MAX = Marketing Ads Accelerator`.

- [ ] **Step 9.3: Spot-check the audit row**

Supabase MCP `execute_sql`:

```sql
SELECT id, trigger, status, bundle_changed, configs_checked, configs_updated, configs_failed,
       jsonb_pretty(hume_versions) AS versions
FROM ops.hume_sync_runs
ORDER BY id DESC
LIMIT 1;
```

Expected: status='ok', configs_updated=3, configs_failed=0, versions JSONB shows 3 entries.

- [ ] **Step 9.4: Trigger a second sync — verify noop short-circuit**

Re-run the curl from Step 9.1. Expected: `status: "noop"`, `configsChecked: 0`, `configsUpdated: 0`, `bundleChanged: false`. Verify no new Hume prompt versions were created (by calling `/v0/evi/prompts/<pid>` and confirming the latest version matches what Step 9.1 posted, not +1).

---

## Task 10: pg_cron registration + cron_job_intent row

**Files:**
- Create: `supabase/migrations/20260420000004_hume_sync_cron.sql`

- [ ] **Step 10.1: Write the cron migration**

```sql
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
```

- [ ] **Step 10.2: Apply**

Supabase MCP `apply_migration("hume_sync_cron")`.

- [ ] **Step 10.3: Verify the job is registered + intent is audited clean**

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'sync-hume-evi-nightly';
```
Expected: 1 row, `schedule='30 9 * * *'`, `active=true`.

```sql
SELECT jobname, severity, audit_code FROM ops.cron_schedule_audit WHERE jobname = 'sync-hume-evi-nightly';
```
Expected: 1 row, `severity='OK'`, `audit_code='ok'`.

- [ ] **Step 10.4: Commit**

```bash
git add supabase/migrations/20260420000004_hume_sync_cron.sql
git commit -m "$(cat <<'EOF'
feat(migration): nightly pg_cron for sync-hume-evi at 09:30 UTC

Off-peak (02:30 Pacific PDT / 01:30 PST). Auth via vault.decrypted_secrets
— no hardcoded JWT. ops.cron_job_intent row pairs with this schedule so
ops.cron_schedule_audit does not flag it.

Closes the manual-Hume-paste checkbox that has been open since
SECURITY_BOUNDARY_BLOCK shipped 2026-04-19. Nightly cron + on-demand
admin endpoint from Task 8 = NN #1 on voice surfaces.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Verify both edge functions still green after salesVoice refactor

**Files:** none

Context: Task 1 modified `_shared/salesVoice.ts` in a way that ripples through every edge function that imports it. Run their full Deno tests to confirm nothing regressed.

- [ ] **Step 11.1: Test ghl-sales-agent**

```bash
cd supabase/functions/ghl-sales-agent && deno test
```
Expected: all tests green. If any fail on the `VOCABULARY_BLOCK` shim or on missing acronym content: regression — fix before continuing.

- [ ] **Step 11.2: Test ghl-member-agent**

```bash
cd supabase/functions/ghl-member-agent && deno test
```
Expected: all green. A new assertion *may* be added here later claiming that member-agent's generated prompt now contains `PIF` (via universal insurance vocab). Not required for this plan.

- [ ] **Step 11.3: Test ghl-sales-followup**

```bash
cd supabase/functions/ghl-sales-followup && deno test
```
Expected: all green.

- [ ] **Step 11.4: Global typecheck (Next.js side)**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 11.5: If any regression surfaced, fix + commit in this task. Otherwise, no commit.**

---

## Task 12: Close-out — memory, roadmap, session summary

**Files:**
- Create: `~/.claude/projects/-Users-philgoodmac-.../memory/project_hume_sync_shipped.md` (project memory)
- Modify: `~/.claude/projects/.../memory/MEMORY.md`
- Modify: vault `60-content/ai-phil/_ROADMAP.md` (Shipped section)
- Create: vault `50-meetings/2026-04-20-hume-evi-nightly-sync.md`

- [ ] **Step 12.1: Write project memory**

Create `memory/project_hume_sync_shipped.md`:

```markdown
---
name: Hume EVI nightly sync shipped
description: sync-hume-evi edge function + nightly cron + admin endpoint live; closes NN#1 on voice surfaces
type: project
---

# Phase 0 Task 4 — Hume EVI nightly sync SHIPPED <DATE>

**Edge function:** `sync-hume-evi` v1 (version bumped on each deploy).
**Cron:** `sync-hume-evi-nightly` at `30 9 * * *` UTC = 02:30 Pacific PDT.
**Admin trigger:** `POST /api/admin/sync-hume` with `x-sync-secret: $SYNC_ADMIN_SECRET`.

**Sync targets (from `ops.hume_config_registry`):**
- `discovery` — prompt `<id>`, config `7b0c4b13-f495-449a-884a-5f3e38c661c0`, carries_addendum=true
- `new-member` — prompt `<id>`, config `9e13d89f-3f42-4609-8060-32d36965d73e`, carries_addendum=false
- `implementation` — prompt `<id>`, config `500e7bd2-5fc5-4bd1-90b8-e0b6d61a4eaf`, carries_addendum=false

**Marker convention:** `<!-- AIPHIL-SHARED-BEGIN v=<hash> --> ... <!-- AIPHIL-SHARED-END -->` universal; `<!-- AIPHIL-DISCOVERY-ADDENDUM-BEGIN v=<hash> --> ... <!-- AIPHIL-DISCOVERY-ADDENDUM-END -->` Discovery-only. Human-curated Hume-specific content lives below the markers and is NEVER touched by sync.

**Observability:** `ops.hume_sync_runs` (one row per run), `ops.cron_schedule_audit` (OK row), `agent_signals` + Google Chat alert on partial/error.

**VOCABULARY_BLOCK composition fix:** split into `INSURANCE_VOCABULARY_BLOCK` (universal) + `BRANDED_ACRONYM_EXPANSION_BLOCK` (prospect-only). Legacy `VOCABULARY_BLOCK` kept as deprecation shim for one release.

**Follow-ups:**
- Remove `VOCABULARY_BLOCK` deprecation shim after next ai-phil release
- Vault markdown voice doc → `_shared/salesVoice.ts` codegen (separate Step 1 deliverable)
- Phone-voice (Hume+Twilio) config gets added to `hume_config_registry` when shipped
```

- [ ] **Step 12.2: Update MEMORY.md index**

Add to the index under existing entries:

```markdown
- [Hume EVI nightly sync shipped](project_hume_sync_shipped.md) — sync-hume-evi edge function + nightly cron @ 09:30 UTC + admin endpoint; closes NN#1 on voice surfaces; VOCABULARY_BLOCK split
```

- [ ] **Step 12.3: Update vault `_ROADMAP.md` Shipped section**

Append a row (mirrors prior Shipped entries):

```markdown
| <YYYY-MM-DD> | **Phase 0 Task 4 — Hume EVI nightly sync shipped** | `sync-hume-evi` edge function v1 + `ops.hume_sync_runs` + `ops.hume_config_registry` (3 rows seeded) + `sync-hume-evi-nightly` pg_cron @ 09:30 UTC (dst_strategy=none-required) + `/api/admin/sync-hume` manual trigger. `_shared/salesVoice.ts` gains `buildHumeSharedBundle()` + `buildHumeDiscoveryAddendum()` exports; `VOCABULARY_BLOCK` split into `INSURANCE_VOCABULARY_BLOCK` (universal) + `BRANDED_ACRONYM_EXPANSION_BLOCK` (prospect-only) with one-release deprecation shim. Marker-region splice preserves Hume-channel-specific curated content. Hash short-circuit = zero Hume-version churn on no-op nights. First live sync confirmed: 3/3 configs updated, noop on 2nd trigger. Closes Non-Negotiable #1 (one AI Phil brain across every surface) on voice. Spec + plan: `docs/superpowers/{specs,plans}/2026-04-20-hume-evi-nightly-sync-*.md`. |
```

- [ ] **Step 12.4: Write session summary in vault `50-meetings/`**

Create `50-meetings/2026-04-20-hume-evi-nightly-sync.md` with the "Pick up here" block per CLAUDE.md close-out §4.

- [ ] **Step 12.5: Close-out checks**

Run all of these in sequence (zero tolerance for failures):

```bash
git status --short      # clean expected
git log origin/main..HEAD --oneline  # review commit count — this plan lands ~12 commits
npm run typecheck       # pass
```

Supabase MCP:
- `get_advisors('security')` — zero new ERRORs
- `execute_sql("SELECT * FROM ops.cron_schedule_audit WHERE severity IN ('ERROR','WARN') AND jobname LIKE 'sync-hume%' OR jobname = 'sync-hume-evi-nightly'")` — zero rows

- [ ] **Step 12.6: Commit close-out docs**

```bash
git add .claude/... vault paths as applicable
git commit -m "$(cat <<'EOF'
docs(close-out): Hume EVI nightly sync shipped — memory + roadmap + session summary

Phase 0 Task 4 close-out per CLAUDE.md protocol. Project memory,
MEMORY.md index, vault roadmap Shipped row, and session summary
('Pick up here' block at the top).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 12.7: Decide on push**

Per CLAUDE.md close-out §1 "Push decision is explicit every close-out." Default posture in this session: **ask Phil** — 12 commits is a substantial landing; if he wants review before Vercel picks up the Next.js route, we hold.

---

## Self-Review Checklist (author completed)

- [x] **Spec coverage:** every spec section maps to a task — VOCABULARY split (T1), helpers (T2), tables (T3), markers (T4), Hume client (T5), orchestrator+handler (T6), deploy+seed (T7), admin route (T8), first live sync (T9), cron (T10), regression sweep (T11), close-out (T12).
- [x] **Placeholders:** two intentional `<PROMPT_ID_FROM_STEP_7_3>` markers in Task 7.4 — these are captured at runtime, not authorable now. Flagged with STOP if missing.
- [x] **Type consistency:** `RegistryRow`, `SyncDeps`, `SyncResult`, `HumeClient` signatures consistent across T4/T5/T6. `buildHumeSharedBundle` is async everywhere.
- [x] **Scope:** bootstrap (one plan's worth of work), reversible in pieces (T4/T5 pure, T6 tested with injected deps, T7/T10 are migrations, T9 verifies before cron fires unattended).
