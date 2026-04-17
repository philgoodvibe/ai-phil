# AI Sales System v2 / RIS Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 of the AI Phil Relationship Intelligence System — canonical voice doc, F.O.R.M. rapport memory, sales-agent prompt overhaul, new `ghl-sales-followup` edge function, and pg_cron registration.

**Architecture:** Vault markdown master (`AI-Phil-Voice-Philosophy.md`) → TypeScript mirror (`_shared/salesVoice.ts`) imported by both the existing `ghl-sales-agent` and new `ghl-sales-followup`. Rapport facts live in `ops.contact_rapport` (flexible JSONB), populated by a post-conversation Haiku extractor and injected into every prompt. Followup function polls `ops.ai_inbox_followup_queue` on an hourly pg_cron schedule (business hours weekdays, vault-secret auth), handles a 3-touch decision window anchored to `created_at` plus 6 nurture touches walking forward from last send.

**Tech Stack:** Supabase Edge Functions (Deno), TypeScript strict mode, Claude Sonnet 4.6 + Haiku 4.5 via Anthropic API, PostgreSQL + pg_cron + pgvector, GHL REST API.

**Spec:** [`docs/superpowers/specs/2026-04-16-ai-sales-system-v2-ris-phase1-design.md`](../specs/2026-04-16-ai-sales-system-v2-ris-phase1-design.md)

---

## File Structure

**New files (create):**
- `scripts/distill-fathom-voice.ts` — one-time Fathom corpus miner
- `scripts/distill-fathom-voice.test.ts` — unit tests
- `supabase/functions/_shared/salesVoice.ts` — shared voice module
- `supabase/functions/_shared/salesVoice.test.ts` — unit tests
- `supabase/functions/_shared/rapport.ts` — rapport fetch + format + extract helpers
- `supabase/functions/_shared/rapport.test.ts` — unit tests
- `supabase/functions/_shared/kbCache.ts` — KB doc cache wrapper
- `supabase/functions/_shared/kbCache.test.ts` — unit tests
- `supabase/functions/ghl-sales-followup/index.ts` — new edge function
- `supabase/functions/ghl-sales-followup/cadence.ts` — pure cadence calculator
- `supabase/functions/ghl-sales-followup/cadence.test.ts` — unit tests
- `supabase/functions/ghl-sales-followup/deno.json` — Deno config
- `supabase/migrations/20260417000000_contact_rapport.sql`
- `supabase/migrations/20260417000001_kb_doc_cache.sql`
- `supabase/migrations/20260417000002_followup_queue_last_sent.sql`
- `supabase/migrations/20260417000003_ai_inbox_memory_index.sql`
- `supabase/migrations/20260417000004_ghl_sales_followup_cron.sql` — applied last, after function deployed
- `vault/60-content/ai-phil/AI-Phil-Voice-Philosophy.md` — canonical voice doc (Google Drive, not in repo)
- `vault/60-content/ai-phil/Cold-Outreach-Playbook.md` — future project prep (Google Drive)
- `vault/60-content/ai-phil/fathom-voice-artifacts.md` — auto-generated (Google Drive)
- `vault/60-content/ai-phil/fathom-voice-artifacts.json` — auto-generated (Google Drive)

**Modified files:**
- `supabase/functions/ghl-sales-agent/index.ts` — prompt overhaul + rapport integration + pause-on-reply
- `supabase/functions/ghl-sales-agent/deno.json` — may need import map for `_shared`
- `vault/60-content/ai-phil/_ROADMAP.md` — update at close-out

---

## Execution Prerequisites

**Before Task 1, confirm:**
- [ ] `git status` clean on `main`, up to date with `origin/main`
- [ ] Supabase MCP is active and project is `ylppltmwueasbdexepip`
- [ ] Vault is accessible at `/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/Shared drives/AiAi Mastermind/01_Knowledge Base/AIAI-Vault/`
- [ ] Fathom corpus is present at `/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Fathom MCP/raw/` (expected ~759 files)
- [ ] Phillip is available to review migrations before they are applied (CLAUDE.md hard rule)

**Standing CLAUDE.md rules to respect throughout:**
- No hardcoded secrets in SQL or source (no `eyJ...` JWTs)
- Every `deploy_edge_function` is followed immediately by `git add` + `git commit` of the same source
- Schema migrations require Phillip's review of SQL before apply
- `get_advisors('security')` is mandatory after any schema migration — fix every ERROR, note every WARN in the session summary
- Read neighboring production code before writing new integrations (already done in brainstorming phase)

---

## Task 1: Draft `contact_rapport` migration

**Files:**
- Create: `supabase/migrations/20260417000000_contact_rapport.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 20260417000000_contact_rapport.sql
-- Per-contact F.O.R.M. rapport facts. Append-only jsonb, keep forever.
-- Read by every AI agent before building a prompt; written by the
-- post-conversation extractor after every turn.

CREATE TABLE IF NOT EXISTS ops.contact_rapport (
  contact_id         text PRIMARY KEY,
  facts              jsonb NOT NULL DEFAULT '{}'::jsonb,
  fact_count         int NOT NULL DEFAULT 0,
  last_extracted_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_rapport_updated_at_idx
  ON ops.contact_rapport (updated_at DESC);

-- Service-role only (consistent with other ops tables).
ALTER TABLE ops.contact_rapport ENABLE ROW LEVEL SECURITY;

-- No policies => anon + authenticated have zero access.
-- service_role bypasses RLS automatically.

COMMENT ON TABLE ops.contact_rapport IS
  'Structured per-contact F.O.R.M. facts (Family/Occupation/Recreation/Money). Append-only, keep forever. See docs/superpowers/specs/2026-04-16-ai-sales-system-v2-ris-phase1-design.md §5.3.';
```

- [ ] **Step 2: Do NOT apply yet** — migrations require Phillip's review before apply, per CLAUDE.md. Flag to Phillip: "Migration drafted at `supabase/migrations/20260417000000_contact_rapport.sql`. Review before I apply."

- [ ] **Step 3: Commit the draft**

```bash
git add supabase/migrations/20260417000000_contact_rapport.sql
git commit -m "$(cat <<'EOF'
feat(migration): ops.contact_rapport table for F.O.R.M. rapport memory

Append-only JSONB per contact. Read by every AI agent before building a
prompt; written by the post-conversation Haiku extractor after every turn.
Not yet applied — awaiting Phillip's review.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Draft `kb_doc_cache`, `last_sent_at` column, and memory index migrations

**Files:**
- Create: `supabase/migrations/20260417000001_kb_doc_cache.sql`
- Create: `supabase/migrations/20260417000002_followup_queue_last_sent.sql`
- Create: `supabase/migrations/20260417000003_ai_inbox_memory_index.sql`

- [ ] **Step 1: Write `kb_doc_cache` migration**

```sql
-- 20260417000001_kb_doc_cache.sql
-- Cache Google Doc contents for 30-minute TTL to cut API calls at scale.

CREATE TABLE IF NOT EXISTS ops.kb_doc_cache (
  doc_id      text PRIMARY KEY,
  content     text NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ops.kb_doc_cache ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ops.kb_doc_cache IS
  '30-min TTL cache for Google Doc text exports. Read-through by _shared/kbCache.ts. Reduces Docs API calls from per-conversation to per-30min.';
```

- [ ] **Step 2: Write `last_sent_at` column migration**

```sql
-- 20260417000002_followup_queue_last_sent.sql
-- Idempotency guard: prevent dual-sends if cron retries a row after GHL send
-- succeeded but DB update failed.

ALTER TABLE ops.ai_inbox_followup_queue
  ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;

COMMENT ON COLUMN ops.ai_inbox_followup_queue.last_sent_at IS
  'Timestamp of last successful send from this row. ghl-sales-followup refuses to resend if last_sent_at is within the last 1 hour.';
```

- [ ] **Step 3: Write memory index migration**

```sql
-- 20260417000003_ai_inbox_memory_index.sql
-- Index for the hot-path history query:
-- SELECT ... WHERE contact_id = ? ORDER BY created_at DESC LIMIT 20

CREATE INDEX IF NOT EXISTS ai_inbox_memory_contact_created_idx
  ON ops.ai_inbox_conversation_memory (contact_id, created_at DESC);
```

- [ ] **Step 4: Commit all three**

```bash
git add supabase/migrations/20260417000001_kb_doc_cache.sql \
        supabase/migrations/20260417000002_followup_queue_last_sent.sql \
        supabase/migrations/20260417000003_ai_inbox_memory_index.sql
git commit -m "$(cat <<'EOF'
feat(migration): kb_doc_cache + followup last_sent_at + memory index

- ops.kb_doc_cache: 30-min TTL cache for Google Doc fetches
- ai_inbox_followup_queue.last_sent_at: idempotency guard against dual-send
- ai_inbox_conversation_memory (contact_id, created_at DESC) index:
  hot-path lookup, future-proofs as memory grows past 150k rows.

Not yet applied — awaiting Phillip's review.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Phillip reviews migrations; apply via Supabase MCP

**Files:** (none — this is an ops task)

- [ ] **Step 1: Present all four migration files to Phillip for review** (Task 1 + Task 2 files)

- [ ] **Step 2: On approval, apply each migration via `apply_migration`**

```
apply_migration(name="20260417000000_contact_rapport", query=<file contents>)
apply_migration(name="20260417000001_kb_doc_cache", query=<file contents>)
apply_migration(name="20260417000002_followup_queue_last_sent", query=<file contents>)
apply_migration(name="20260417000003_ai_inbox_memory_index", query=<file contents>)
```

- [ ] **Step 3: Verify tables exist and columns are correct**

```sql
-- Run via execute_sql
SELECT table_schema, table_name FROM information_schema.tables
WHERE table_schema = 'ops' AND table_name IN ('contact_rapport', 'kb_doc_cache');

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'ops' AND table_name = 'ai_inbox_followup_queue'
  AND column_name = 'last_sent_at';
```

Expected: 2 rows from first query, 1 row from second.

- [ ] **Step 4: Run `get_advisors('security')`** — CLAUDE.md mandatory post-migration

Expected: zero ERROR-level findings. 12 pre-existing INFO `rls_enabled_no_policy` notices are acceptable (service_role bypasses RLS). Note any WARN.

- [ ] **Step 5: No commit needed** — applied migrations are already committed from Tasks 1–2. Just log the Supabase version numbers in your session notes.

---

## Task 4: Add `ghl_cron_secret` to Supabase vault

**Files:** (none — Supabase dashboard / SQL)

- [ ] **Step 1: Check whether a generic cron secret already exists in vault**

```sql
-- via execute_sql
SELECT name FROM vault.secrets WHERE name LIKE '%cron%' OR name LIKE '%anon%' ORDER BY name;
```

- [ ] **Step 2: If `supabase_anon_key` is present (it should be — used by sync-knowledge-base), reuse it for the followup cron.** Otherwise ask Phillip to add it via the Supabase dashboard (Settings → Vault). The cron job will reference the secret via `(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_anon_key')`.

- [ ] **Step 3: Do NOT commit anything here** — secret management is dashboard-only and must never appear in SQL files.

---

## Task 5: Write Fathom distillation script — scaffolding + tests first

**Files:**
- Create: `scripts/distill-fathom-voice.ts`
- Create: `scripts/distill-fathom-voice.test.ts`

- [ ] **Step 1: Inspect one Fathom transcript to understand schema**

```bash
ls "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Fathom MCP/raw/" | head -3
```

Then `cat` the first file to see the JSON structure (speakers, utterances, etc.). This confirms the parser input shape before we write the code.

- [ ] **Step 2: Write the failing test for the n-gram phrase extractor**

Create `scripts/distill-fathom-voice.test.ts`:

```typescript
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { extractTopPhrases, type Utterance } from './distill-fathom-voice.ts';

Deno.test('extractTopPhrases returns frequency-ranked 3-to-7-grams excluding stopwords', () => {
  const utterances: Utterance[] = [
    { speaker: 'Phillip', text: 'what I tell every agency owner is to focus on production per producer' },
    { speaker: 'Phillip', text: 'every agency owner I talk to needs better production per producer' },
    { speaker: 'Prospect', text: 'I want more leads from my producers' },
  ];
  const top = extractTopPhrases(utterances, 'Phillip', 5);
  // "production per producer" should rank high — appears in both Phillip utterances
  const topText = top.map(p => p.phrase);
  const hasProductionPerProducer = topText.some(t => t.includes('production per producer'));
  assertEquals(hasProductionPerProducer, true);
});

Deno.test('extractTopPhrases excludes phrases from other speakers', () => {
  const utterances: Utterance[] = [
    { speaker: 'Prospect', text: 'leverage synergy transform business unlock abundance' },
  ];
  const top = extractTopPhrases(utterances, 'Phillip', 10);
  assertEquals(top.length, 0, 'no Phillip utterances → empty result');
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Ai Phil"
deno test scripts/distill-fathom-voice.test.ts
```

Expected: FAIL (module not yet created).

- [ ] **Step 4: Implement `distill-fathom-voice.ts` minimally to pass both tests**

Full code in the spec; at minimum this file exports `Utterance` type + `extractTopPhrases(utterances, speakerName, topN)` function, plus the Deno main (`if (import.meta.main) { ... }`) that:
1. Globs all `.json` files in the Fathom raw folder
2. Parses each, extracts Phillip's utterances (match speaker_name or participant_email against Phillip's identity — discover the key names in Step 1's inspection)
3. Calls `extractTopPhrases` across the whole corpus
4. Calls Haiku in batches (with `--limit N` flag) to classify objection passages + case studies
5. Writes `vault/60-content/ai-phil/fathom-voice-artifacts.md` and `.json`

Keep phrase extraction pure (testable) — isolate the file I/O and Claude calls into separate functions.

- [ ] **Step 5: Run tests to confirm they pass**

```bash
deno test scripts/distill-fathom-voice.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/distill-fathom-voice.ts scripts/distill-fathom-voice.test.ts
git commit -m "$(cat <<'EOF'
feat(scripts): Fathom voice distillation script + tests

Mines Phillip's 759 Fathom transcripts to produce structured artifacts
(top phrases, recurring objections, peer case studies) that feed the
canonical AI-Phil-Voice-Philosophy.md voice doc.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Run Fathom distillation on 10-transcript subset, verify quality

**Files:**
- Verify: `vault/60-content/ai-phil/fathom-voice-artifacts.md` (generated)
- Verify: `vault/60-content/ai-phil/fathom-voice-artifacts.json` (generated)

- [ ] **Step 1: Run with `--limit 10` flag**

```bash
deno run --allow-read --allow-write --allow-env --allow-net \
  scripts/distill-fathom-voice.ts --limit 10
```

Expected: writes two files under `vault/60-content/ai-phil/`.

- [ ] **Step 2: Visually inspect the generated markdown file.** Sanity checks:
  - Top phrases look like things Phillip actually says (not stopwords or names)
  - Objections include a short passage from prospect + Phillip's response
  - Case studies have specific numbers (agency size, premium, outcome)

- [ ] **Step 3: If output is unusable, iterate on the script** (adjust stopword list, n-gram cutoffs, speaker-matching logic). Re-run and re-verify.

- [ ] **Step 4: Do NOT commit generated artifacts yet** — wait until the full run in Task 7.

---

## Task 7: Full Fathom run on 759 transcripts

**Files:**
- Commit: `vault/60-content/ai-phil/fathom-voice-artifacts.md`
- Commit: `vault/60-content/ai-phil/fathom-voice-artifacts.json`

- [ ] **Step 1: Run with no `--limit`**

```bash
deno run --allow-read --allow-write --allow-env --allow-net \
  scripts/distill-fathom-voice.ts
```

Expected: 5–15 minutes, ~$5–15 Anthropic API cost. Script logs progress every 50 transcripts.

- [ ] **Step 2: Inspect the resulting artifacts file in the vault**

```bash
wc -l "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/Shared drives/AiAi Mastermind/01_Knowledge Base/AIAI-Vault/60-content/ai-phil/fathom-voice-artifacts.md"
```

Expected: hundreds of lines.

- [ ] **Step 3: Vault files are in Google Drive, not repo.** No git commit for them. Just log the file sizes + artifact counts (#phrases, #objections, #case studies) in your session notes.

---

## Task 8: Draft `AI-Phil-Voice-Philosophy.md` in vault

**Files:**
- Create (Google Drive vault): `vault/60-content/ai-phil/AI-Phil-Voice-Philosophy.md`

- [ ] **Step 1: Write the voice doc using the 12-section structure from spec §5.1**

Use the `Write` tool with the full absolute vault path. Include all 12 sections: Identity, Voice attributes, Hormozi opener rule, F.O.R.M. framework, Sales frameworks, Banned vocabulary, Preferred vocabulary, Proof shape requirements, Channel-specific rules, Context adaptations, Fathom-distilled artifact (link to the auto-generated file from Task 7), Never-lie rules.

The draft should be ~500–800 lines. Quote Hormozi, Kern, and insurance-operator research findings inline where relevant. Fold the Fathom artifacts in as "Phillip's Actual Voice (distilled from 759 meetings)" section.

- [ ] **Step 2: Flag to Phillip**: "First draft of `AI-Phil-Voice-Philosophy.md` is in vault at `60-content/ai-phil/`. Please review — this is the canonical voice doc that every AI agent will import from. Edit in Google Docs or the text file; we'll hand-sync to `salesVoice.ts` after."

- [ ] **Step 3: Wait for Phillip's approval** before proceeding to Task 9.

- [ ] **Step 4: Vault files are not in git.** No commit for this task.

---

## Task 9: Draft `Cold-Outreach-Playbook.md` in vault

**Files:**
- Create (Google Drive vault): `vault/60-content/ai-phil/Cold-Outreach-Playbook.md`

- [ ] **Step 1: Write the playbook using the 7-section structure from spec §5.11**

Sections: voice-doc inheritance statement, cold-specific addenda (subject lines, preview text, deliverability guardrails, proof shape for cold, objection preemption, webinar/challenge positioning, web-scraping personalization signals, cold cadence). Target 250–400 lines.

This doc is **reference-only for a future project** — not consumed by any runtime code in Phase 1. Flag that prominently at the top.

- [ ] **Step 2: No commit** (vault).

---

## Task 10: Write `salesVoice.ts` shared module — TDD

**Files:**
- Create: `supabase/functions/_shared/salesVoice.ts`
- Create: `supabase/functions/_shared/salesVoice.test.ts`

- [ ] **Step 1: Write failing test for `BANNED_WORDS` detection**

Create `supabase/functions/_shared/salesVoice.test.ts`:

```typescript
import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  BANNED_WORDS,
  containsBannedWord,
  buildSystemPrompt,
  type VoiceContext,
  type RapportFacts,
} from './salesVoice.ts';

Deno.test('BANNED_WORDS includes coach-speak terms', () => {
  const expected = ['transform', 'unlock', 'synergy', 'leverage', 'seamless', 'robust', 'delve', 'Hey'];
  for (const word of expected) {
    const present = BANNED_WORDS.some(w => w.toLowerCase() === word.toLowerCase());
    assertEquals(present, true, `BANNED_WORDS should include "${word}"`);
  }
});

Deno.test('containsBannedWord flags banned words case-insensitively', () => {
  assertEquals(containsBannedWord('We will transform your agency'), true);
  assertEquals(containsBannedWord('Hey Mike, just checking in'), true);
  assertEquals(containsBannedWord('Looking at your production per producer this quarter'), false);
});

Deno.test('containsBannedWord avoids false positives on "leverage" used as noun', () => {
  // The word "leverage" (verb form "to leverage") is banned, but the codebase
  // sometimes talks about "staff leverage" as a noun. We flag any occurrence
  // to force the prompt to rewrite — this is the conservative choice.
  assertEquals(containsBannedWord('We help you leverage AI'), true);
});

Deno.test('buildSystemPrompt includes identity block in every context', () => {
  const contexts: VoiceContext[] = [
    'sales-live', 'sales-followup-1', 'sales-followup-2', 'sales-followup-3',
    'sales-nurture', 'event', 'support', 'unknown',
  ];
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  for (const ctx of contexts) {
    const prompt = buildSystemPrompt(ctx, emptyRapport, '(no prior messages)', '');
    assertStringIncludes(prompt, 'Ai Phil', `${ctx} prompt should include identity`);
    assertStringIncludes(prompt, 'not Phillip himself', `${ctx} prompt should include never-claim-to-be-Phillip rule`);
  }
});

Deno.test('buildSystemPrompt includes Hormozi opener rule in sales contexts', () => {
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const prompt = buildSystemPrompt('sales-live', emptyRapport, '(no prior messages)', '');
  assertStringIncludes(prompt.toLowerCase(), 'prove');
  // The opener rule phrasing enforces: prove you read their last message
});

Deno.test('buildSystemPrompt injects rapport facts when present', () => {
  const rapport: RapportFacts = {
    family: [{ key: 'dog_name', value: 'Lucy', source_conv: 'x', extracted_at: '2026-04-16' }],
    occupation: [{ key: 'agency_size', value: '3 producers', source_conv: 'x', extracted_at: '2026-04-16' }],
    recreation: [],
    money: [],
  };
  const prompt = buildSystemPrompt('sales-live', rapport, '(no prior)', '');
  assertStringIncludes(prompt, 'Lucy');
  assertStringIncludes(prompt, '3 producers');
});

Deno.test('buildSystemPrompt sales-followup-1 prompt specifies clarity + peer proof angle', () => {
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const prompt = buildSystemPrompt('sales-followup-1', emptyRapport, '(no prior)', '');
  // Touch 1 angle = clarity + social proof
  assertStringIncludes(prompt.toLowerCase(), 'proof');
});

Deno.test('buildSystemPrompt sales-followup-3 prompt specifies soft close angle', () => {
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const prompt = buildSystemPrompt('sales-followup-3', emptyRapport, '(no prior)', '');
  // Touch 3 angle = real constraint + soft close
  assertStringIncludes(prompt.toLowerCase(), 'close');
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
cd "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Ai Phil"
deno test supabase/functions/_shared/salesVoice.test.ts
```

Expected: FAIL (module not yet created).

- [ ] **Step 3: Implement `salesVoice.ts`**

The file exports:
- `BANNED_WORDS: readonly string[]` — from voice doc §6 banned vocabulary
- `PREFERRED_VOCAB: readonly string[]` — from voice doc §7
- `containsBannedWord(text: string): boolean` — case-insensitive substring scan
- `VoiceContext` type alias — union of the 8 string literals
- `RapportFacts` type (matches spec §5.3 JSON shape)
- `IDENTITY_BLOCK`, `VOICE_BLOCK`, `FORM_FRAMEWORK_BLOCK`, `SALES_FRAMEWORKS_BLOCK`, `PROOF_SHAPE_BLOCK`, `NEVER_LIE_BLOCK` — string constants sourced from the voice doc
- `buildSystemPrompt(context, rapport, historyStr, extras?)` — composes full system prompt with blocks relevant to the context

Keep it text-only. No API calls. No Supabase calls. Pure composition.

The full content of each block should be lifted verbatim from `AI-Phil-Voice-Philosophy.md` where possible; otherwise condensed. On any future edit to the voice doc, update this file to match in the same PR.

- [ ] **Step 4: Run tests — confirm they pass**

```bash
deno test supabase/functions/_shared/salesVoice.test.ts
```

Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/salesVoice.ts supabase/functions/_shared/salesVoice.test.ts
git commit -m "$(cat <<'EOF'
feat(_shared): salesVoice module — canonical voice in TS form

TypeScript mirror of vault/60-content/ai-phil/AI-Phil-Voice-Philosophy.md.
Single source of truth for both ghl-sales-agent and ghl-sales-followup
prompts. Exports banned-word guardrail, identity/voice/F.O.R.M. blocks,
and buildSystemPrompt composer per context.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Write `rapport.ts` helpers — TDD

**Files:**
- Create: `supabase/functions/_shared/rapport.ts`
- Create: `supabase/functions/_shared/rapport.test.ts`

- [ ] **Step 1: Write failing tests for pure functions**

Create `supabase/functions/_shared/rapport.test.ts`:

```typescript
import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  formatRapportBlock,
  mergeRapportFacts,
  type RapportFacts,
} from './rapport.ts';

Deno.test('formatRapportBlock returns empty block when no facts', () => {
  const facts: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const block = formatRapportBlock(facts);
  assertEquals(block, '(no rapport facts captured yet — listen and extract naturally through F.O.R.M. questions)');
});

Deno.test('formatRapportBlock formats all four categories', () => {
  const facts: RapportFacts = {
    family: [{ key: 'dog_name', value: 'Lucy', source_conv: 'x', extracted_at: '2026-04-16' }],
    occupation: [{ key: 'carrier', value: 'State Farm', source_conv: 'x', extracted_at: '2026-04-16' }],
    recreation: [{ key: 'team', value: 'Cowboys', source_conv: 'x', extracted_at: '2026-04-16' }],
    money: [{ key: 'goal', value: '$5M by 2028', source_conv: 'x', extracted_at: '2026-04-16' }],
  };
  const block = formatRapportBlock(facts);
  assertStringIncludes(block, 'Family');
  assertStringIncludes(block, 'Lucy');
  assertStringIncludes(block, 'Occupation');
  assertStringIncludes(block, 'State Farm');
  assertStringIncludes(block, 'Recreation');
  assertStringIncludes(block, 'Cowboys');
  assertStringIncludes(block, 'Money');
  assertStringIncludes(block, '$5M by 2028');
});

Deno.test('mergeRapportFacts appends new facts without overwriting', () => {
  const existing: RapportFacts = {
    family: [{ key: 'dog_name', value: 'Lucy', source_conv: 'x', extracted_at: '2026-04-15' }],
    occupation: [],
    recreation: [],
    money: [],
  };
  const incoming: RapportFacts = {
    family: [{ key: 'dog_name', value: 'Lucy (passed away)', source_conv: 'y', extracted_at: '2026-04-16' }],
    occupation: [{ key: 'carrier', value: 'State Farm', source_conv: 'y', extracted_at: '2026-04-16' }],
    recreation: [],
    money: [],
  };
  const merged = mergeRapportFacts(existing, incoming);
  assertEquals(merged.family.length, 2, 'dog_name is appended, not overwritten — timeline matters');
  assertEquals(merged.occupation.length, 1);
});

Deno.test('mergeRapportFacts deduplicates exact duplicates', () => {
  const existing: RapportFacts = {
    family: [{ key: 'dog_name', value: 'Lucy', source_conv: 'x', extracted_at: '2026-04-15' }],
    occupation: [],
    recreation: [],
    money: [],
  };
  const incoming: RapportFacts = {
    family: [{ key: 'dog_name', value: 'Lucy', source_conv: 'x', extracted_at: '2026-04-15' }],
    occupation: [],
    recreation: [],
    money: [],
  };
  const merged = mergeRapportFacts(existing, incoming);
  assertEquals(merged.family.length, 1, 'exact dup dropped');
});
```

- [ ] **Step 2: Run — confirm FAIL**

```bash
deno test supabase/functions/_shared/rapport.test.ts
```

- [ ] **Step 3: Implement `rapport.ts`**

Exports:
- `type RapportFacts` (re-export from salesVoice.ts or define locally and import into salesVoice.ts — pick one location; prefer rapport.ts since this is where operations live)
- `formatRapportBlock(facts: RapportFacts): string`
- `mergeRapportFacts(existing: RapportFacts, incoming: RapportFacts): RapportFacts`
- `fetchRapport(supabase, contactId): Promise<RapportFacts>` — reads `ops.contact_rapport.facts`; returns empty shape on null
- `extractRapport(conversationTurn, existingFacts, anthropicApiKey): Promise<RapportFacts>` — Haiku call returning JSON
- `storeRapport(supabase, contactId, mergedFacts): Promise<void>` — upserts `ops.contact_rapport`

For the pure functions (format, merge), keep logic in this file. For Supabase/Anthropic-touching functions, accept the client / key as args so tests don't need real creds.

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/rapport.ts supabase/functions/_shared/rapport.test.ts
git commit -m "$(cat <<'EOF'
feat(_shared): rapport helpers — F.O.R.M. fetch / extract / merge / store

Pure merge + format functions are unit-tested. Supabase + Anthropic
interactions accept injected clients / keys so tests stay offline.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Write `kbCache.ts` — TDD

**Files:**
- Create: `supabase/functions/_shared/kbCache.ts`
- Create: `supabase/functions/_shared/kbCache.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isCacheFresh, CACHE_TTL_MS } from './kbCache.ts';

Deno.test('isCacheFresh returns true within TTL', () => {
  const now = Date.now();
  const fetched = new Date(now - 10 * 60 * 1000).toISOString(); // 10 min ago
  assertEquals(isCacheFresh(fetched, now), true);
});

Deno.test('isCacheFresh returns false past TTL', () => {
  const now = Date.now();
  const fetched = new Date(now - 40 * 60 * 1000).toISOString(); // 40 min ago
  assertEquals(isCacheFresh(fetched, now), false);
});

Deno.test('CACHE_TTL_MS is 30 minutes', () => {
  assertEquals(CACHE_TTL_MS, 30 * 60 * 1000);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `kbCache.ts`**

Exports:
- `CACHE_TTL_MS = 30 * 60 * 1000`
- `isCacheFresh(fetchedAtIso: string, nowMs = Date.now()): boolean`
- `fetchCachedGoogleDoc(supabase, docId, fallback): Promise<string>` — read-through cache. On cache miss or stale, calls the existing `fetchGoogleDoc` (migrate that helper into this module OR import from ghl-sales-agent via copy-paste — spec will tolerate both)

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/kbCache.ts supabase/functions/_shared/kbCache.test.ts
git commit -m "$(cat <<'EOF'
feat(_shared): kbCache — 30-min read-through cache for Google Doc fetches

Cuts products-kb + events-kb API calls from per-conversation to
per-30-min across all callers. Backed by ops.kb_doc_cache.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Overhaul `ghl-sales-agent` — Part 1: wire in `_shared` modules

**Files:**
- Modify: `supabase/functions/ghl-sales-agent/index.ts`
- Modify: `supabase/functions/ghl-sales-agent/deno.json` (if import-map is needed)

- [ ] **Step 1: Read the current `ghl-sales-agent/index.ts` end-to-end** to plan the insertion points:
  - Around line 390: `salesSystemPrompt`, `eventSystemPrompt`, `supportSystemPrompt` live here → replace with `buildSystemPrompt(...)` calls
  - Around line 671: KB doc fetching → swap to `fetchCachedGoogleDoc`
  - Around line 683: intent classifier stays as-is
  - Around line 687: reply generation → pass composed prompt from `buildSystemPrompt`
  - Around line 744: memory insert stays as-is
  - After line 769 (memory insert): inject post-conversation rapport extraction
  - Around line 771: checkout-URL detection + queue upsert stays — but we need to ALSO pause an existing queue row when ANY reply is sent (see Task 16)

- [ ] **Step 2: Add imports at the top**

```typescript
import { buildSystemPrompt, containsBannedWord, type VoiceContext } from '../_shared/salesVoice.ts';
import { fetchRapport, extractRapport, storeRapport, mergeRapportFacts, formatRapportBlock } from '../_shared/rapport.ts';
import { fetchCachedGoogleDoc } from '../_shared/kbCache.ts';
```

- [ ] **Step 3: Replace KB doc fetching with cached version**

Change the parallel fetch block (around line 672–675) from `fetchGoogleDoc(...)` to `fetchCachedGoogleDoc(supabase, ...)`.

- [ ] **Step 4: Replace inline prompt functions**

Delete `salesSystemPrompt`, `eventSystemPrompt`, `supportSystemPrompt`, and the inline `unknownPrompt` string. Replace the reply-generation block (around lines 689–726) with:

```typescript
// Fetch rapport before composing prompts
const rapport = await fetchRapport(supabase, contactId);

let replyText = '';
let modelUsed = '';
let voiceContext: VoiceContext;
if (intent === 'sales') { voiceContext = 'sales-live'; modelUsed = 'claude-sonnet-4-6'; }
else if (intent === 'event') { voiceContext = 'event'; modelUsed = 'claude-sonnet-4-6'; }
else if (intent === 'support') { voiceContext = 'support'; modelUsed = 'claude-haiku-4-5-20251001'; }
else { voiceContext = 'unknown'; modelUsed = 'claude-haiku-4-5-20251001'; }

const systemPrompt = buildSystemPrompt(voiceContext, rapport, historyStr, `Products context:\n${productsKb}\n\nEvents context:\n${eventsKb}\n\nContact: ${safeContact.firstName ?? ''} ${safeContact.lastName ?? ''}, channel=${channel}`);

try {
  replyText = await callClaude(modelUsed, intent === 'support' ? 200 : 300, systemPrompt, messageBody);
} catch (err) {
  console.error('[generate] Claude failed:', err);
  replyText = `Hi ${safeContact.firstName ?? 'there'}, I'm Ai Phil — the AI assistant for AiAi Mastermind. I'm here to help with questions about the membership, events, or how AI can help your business. What's on your mind?`;
  modelUsed = 'fallback';
}
```

- [ ] **Step 5: Run type-check**

```bash
cd supabase/functions/ghl-sales-agent
deno check index.ts
```

Expected: clean. Fix any type errors before proceeding.

- [ ] **Step 6: Commit (part 1 of overhaul)**

```bash
git add supabase/functions/ghl-sales-agent/index.ts
git commit -m "$(cat <<'EOF'
refactor(ghl-sales-agent): use _shared/salesVoice + rapport + kbCache

Prompts now composed via buildSystemPrompt() from the shared voice module.
Rapport facts fetched per-request and injected into prompts. KB docs
fetched through the 30-min cache.

No behavior change yet beyond voice improvements (rapport empty until
extractor ships in next task). Banned-word guardrail + pause-on-reply
logic follow in Tasks 15–16.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Overhaul `ghl-sales-agent` — Part 2: post-conversation rapport extraction

**Files:**
- Modify: `supabase/functions/ghl-sales-agent/index.ts`

- [ ] **Step 1: Insert rapport extraction block after memory insert (after line 769)**

```typescript
// Step 9b: Post-conversation F.O.R.M. extraction (non-fatal)
try {
  const currentRapport = await fetchRapport(supabase, contactId);
  const newFacts = await extractRapport(
    { userMessage: messageBody, assistantReply: replyText },
    currentRapport,
    Deno.env.get('ANTHROPIC_API_KEY')!,
  );
  if (Object.values(newFacts).some(arr => arr.length > 0)) {
    const merged = mergeRapportFacts(currentRapport, newFacts);
    await storeRapport(supabase, contactId, merged);
  }
} catch (err) {
  console.error('[rapport] extract threw (non-fatal):', err);
}
```

- [ ] **Step 2: Type-check**

```bash
deno check supabase/functions/ghl-sales-agent/index.ts
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/ghl-sales-agent/index.ts
git commit -m "$(cat <<'EOF'
feat(ghl-sales-agent): extract F.O.R.M. facts after every conversation

Non-fatal Haiku call after each sent reply. New facts merged into
ops.contact_rapport for use in future conversations across all agents.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Overhaul `ghl-sales-agent` — Part 3: banned-word guardrail

**Files:**
- Modify: `supabase/functions/ghl-sales-agent/index.ts`

- [ ] **Step 1: Wrap the Claude call in a retry-on-banned-word check**

Insert after the initial `replyText = await callClaude(...)` call (before SMS markdown strip):

```typescript
// Banned-word guardrail: one retry with correction, then send anyway
if (containsBannedWord(replyText)) {
  console.warn('[guardrail] banned word detected in first draft, retrying with correction');
  try {
    const retryPrompt = systemPrompt + '\n\nCRITICAL CORRECTION: Your previous draft used a banned phrase (e.g. "transform", "Hey", "unlock", "leverage", "synergy"). Rewrite without any banned vocabulary. Use Phillip\'s direct, operator voice instead.';
    const retried = await callClaude(modelUsed, intent === 'support' ? 200 : 300, retryPrompt, messageBody);
    if (!containsBannedWord(retried)) {
      replyText = retried;
    } else {
      console.error('[guardrail] banned word still present after retry — sending anyway, flag for review');
      await writeAgentSignal({
        source_agent: 'ghl-sales-agent',
        target_agent: 'richie-cc2',
        signal_type: 'banned-word-after-retry',
        status: 'flagged',
        channel: 'open',
        priority: 2,
        payload: { contact_id: contactId, reply_preview: replyText.substring(0, 300) },
      });
    }
  } catch (err) {
    console.error('[guardrail] retry threw, sending original:', err);
  }
}
```

- [ ] **Step 2: Type-check, commit**

```bash
deno check supabase/functions/ghl-sales-agent/index.ts
git add supabase/functions/ghl-sales-agent/index.ts
git commit -m "$(cat <<'EOF'
feat(ghl-sales-agent): banned-word guardrail with one-shot correction retry

Detects coach-speak in first draft, retries once with correction instruction.
If still present, sends anyway and logs agent_signal for review. Never blocks
the outbound — credibility of always-reply > perfection.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Overhaul `ghl-sales-agent` — Part 4: pause-on-reply logic

**Files:**
- Modify: `supabase/functions/ghl-sales-agent/index.ts`

- [ ] **Step 1: After a successful send + memory write, push forward the followup queue if a row exists**

Insert after the existing checkout-URL-detection block (around line 789) but NOT inside its conditional:

```typescript
// Step 10b: If this contact has an active followup row, push next_send_at
// forward 3 days. This is the auto-pause-on-reply mechanism: live
// conversations shouldn't get hit with followups. Stale conversations
// auto-resume because the cron will fire when next_send_at <= now().
try {
  const { error } = await supabase.schema('ops').from('ai_inbox_followup_queue')
    .update({ next_send_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() })
    .eq('contact_id', contactId)
    .lt('follow_up_number', 10); // never touch rows already graduated out
  if (error) console.error('[followup-pause] update error:', error.message);
} catch (err) {
  console.error('[followup-pause] threw:', err);
}
```

- [ ] **Step 2: Run full type-check**

```bash
deno check supabase/functions/ghl-sales-agent/index.ts
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/ghl-sales-agent/index.ts
git commit -m "$(cat <<'EOF'
feat(ghl-sales-agent): auto-pause followup queue on any reply

When the sales agent sends a reply to a contact that has an active
followup-queue row, push next_send_at forward 3 days. If the prospect
keeps replying, the sales agent keeps pushing it. If they go silent,
the cron picks them up 3 days later. No paused_at column needed —
next_send_at is the single source of truth.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Deploy `ghl-sales-agent` v10 + smoke tests

**Files:** (deploy, no source change)

- [ ] **Step 1: Run full test suite on the function**

```bash
cd supabase/functions
deno test _shared/ ghl-sales-agent/
```

Expected: all green.

- [ ] **Step 2: Deploy**

Use Supabase MCP `deploy_edge_function` with the function name `ghl-sales-agent`. Capture the new version number.

- [ ] **Step 3: Immediately verify deployed source matches local** — CLAUDE.md guardrail

```
get_edge_function(name="ghl-sales-agent") → diff against local index.ts
```

- [ ] **Step 4: Three HTTP smoke tests**

```bash
# 1. Wrong location → 403
curl -s -o /dev/null -w '%{http_code}' -X POST \
  https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-sales-agent \
  -H 'Content-Type: application/json' \
  -d '{"location":{"id":"WRONG"},"contact_id":"x","message":"test"}'
# Expected: 403

# 2. Missing fields → 400
curl -s -o /dev/null -w '%{http_code}' -X POST \
  https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-sales-agent \
  -H 'Content-Type: application/json' \
  -d '{"location":{"id":"ARMyDGKPbnem0Brkxpko"}}'
# Expected: 400

# 3. GET → 405
curl -s -o /dev/null -w '%{http_code}' \
  https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-sales-agent
# Expected: 405
```

- [ ] **Step 5: Commit (CLAUDE.md: every deploy is followed by a commit)**

Since the source was already committed in Tasks 13–16 and we haven't changed it since, there is nothing new to commit for the deploy itself. Log the Supabase version number in session notes. If the deploy_edge_function MCP creates any local manifest file that isn't yet tracked, `git add` + commit it.

---

## Task 18: Scaffold `ghl-sales-followup` + cadence calculator (TDD)

**Files:**
- Create: `supabase/functions/ghl-sales-followup/cadence.ts`
- Create: `supabase/functions/ghl-sales-followup/cadence.test.ts`
- Create: `supabase/functions/ghl-sales-followup/deno.json`
- Create: `supabase/functions/ghl-sales-followup/index.ts` (skeleton only)

- [ ] **Step 1: Write failing tests for cadence calculator**

`cadence.test.ts`:

```typescript
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { computeNextSendAt, classifyTouch, type TouchOutcome } from './cadence.ts';

Deno.test('classifyTouch maps follow_up_number to outcome type', () => {
  assertEquals(classifyTouch(1), 'fu1-clarity');
  assertEquals(classifyTouch(2), 'fu2-objection');
  assertEquals(classifyTouch(3), 'fu3-soft-close');
  assertEquals(classifyTouch(4), 'nurture');
  assertEquals(classifyTouch(9), 'nurture-final');
  assertEquals(classifyTouch(10), 'done');
});

Deno.test('computeNextSendAt FU1 just fired → +3 days from created_at', () => {
  const createdAt = new Date('2026-04-16T00:00:00Z');
  const now = new Date('2026-04-17T00:00:00Z'); // fired 24h later
  const result = computeNextSendAt(1, createdAt, now);
  assertEquals(result.action, 'advance');
  assertEquals(result.followUpNumber, 2);
  assertEquals(result.nextSendAt!.toISOString(), '2026-04-19T00:00:00.000Z');
});

Deno.test('computeNextSendAt FU2 just fired → +7 days from created_at', () => {
  const createdAt = new Date('2026-04-16T00:00:00Z');
  const now = new Date('2026-04-19T00:00:00Z');
  const result = computeNextSendAt(2, createdAt, now);
  assertEquals(result.followUpNumber, 3);
  assertEquals(result.nextSendAt!.toISOString(), '2026-04-23T00:00:00.000Z');
});

Deno.test('computeNextSendAt FU3 just fired → nurture enters, +30 days from now', () => {
  const createdAt = new Date('2026-04-16T00:00:00Z');
  const now = new Date('2026-04-23T00:00:00Z');
  const result = computeNextSendAt(3, createdAt, now);
  assertEquals(result.followUpNumber, 4);
  assertEquals(result.nextSendAt!.toISOString(), '2026-05-23T00:00:00.000Z');
});

Deno.test('computeNextSendAt nurture touches 4-8 → +30 days from now', () => {
  const createdAt = new Date('2026-04-16T00:00:00Z');
  const now = new Date('2026-07-01T00:00:00Z');
  const result = computeNextSendAt(5, createdAt, now);
  assertEquals(result.followUpNumber, 6);
  assertEquals(result.nextSendAt!.toISOString(), '2026-07-31T00:00:00.000Z');
});

Deno.test('computeNextSendAt FU9 just fired → delete + tag', () => {
  const createdAt = new Date('2026-04-16T00:00:00Z');
  const now = new Date('2026-10-01T00:00:00Z');
  const result = computeNextSendAt(9, createdAt, now);
  assertEquals(result.action, 'delete');
  assertEquals(result.nextSendAt, undefined);
});
```

- [ ] **Step 2: Run tests — FAIL**

- [ ] **Step 3: Implement `cadence.ts`**

Exports:
- `type TouchOutcome = 'fu1-clarity' | 'fu2-objection' | 'fu3-soft-close' | 'nurture' | 'nurture-final' | 'done'`
- `classifyTouch(followUpNumber: number): TouchOutcome`
- `type NextSendResult = { action: 'advance'; followUpNumber: number; nextSendAt: Date } | { action: 'delete'; followUpNumber: 9; nextSendAt: undefined }`
- `computeNextSendAt(justFiredFollowUpNumber: number, createdAt: Date, now: Date): NextSendResult`

Per spec §5.7 step j:
- 1 → advance to 2, `next_send_at = createdAt + 3d`
- 2 → advance to 3, `next_send_at = createdAt + 7d`
- 3 → advance to 4, `next_send_at = now + 30d` (anchor shift)
- 4..8 → advance to next, `next_send_at = now + 30d`
- 9 → delete

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Scaffold `deno.json` + `index.ts` skeleton**

`deno.json`:

```json
{
  "nodeModulesDir": "auto",
  "lock": false
}
```

`index.ts` skeleton (will be filled in Task 19):

```typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  // TODO Task 19: auth check, queue drain, per-row processing
  return new Response(JSON.stringify({ ok: true, processed: 0, errors: 0 }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/ghl-sales-followup/
git commit -m "$(cat <<'EOF'
feat(ghl-sales-followup): scaffold + cadence calculator

- deno.json + index.ts skeleton (returns 200 ok)
- cadence.ts pure calculator (3-day decision + 4-7 day decision +
  monthly nurture up to touch 9 + delete-on-9)
- 6 unit tests covering all branches

Handler implementation follows in Task 19.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Implement `ghl-sales-followup` main handler

**Files:**
- Modify: `supabase/functions/ghl-sales-followup/index.ts`

- [ ] **Step 1: Flesh out the full handler**

Replace the skeleton with the full flow described in spec §5.7:

```typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  buildSystemPrompt, containsBannedWord, type VoiceContext,
} from '../_shared/salesVoice.ts';
import {
  fetchRapport, extractRapport, storeRapport, mergeRapportFacts,
  type RapportFacts,
} from '../_shared/rapport.ts';
import { fetchCachedGoogleDoc } from '../_shared/kbCache.ts';
import { computeNextSendAt, classifyTouch } from './cadence.ts';

const GHL_LOCATION_ID = 'ARMyDGKPbnem0Brkxpko';
const PRODUCTS_PRICING_DOC_ID = '1pxqva2WAmeUKJ5nvWSdyiw33iMQrTV4DebXzBhyjXSE';
const EVENTS_DOC_ID = '1Me-1NIW76SjjkV6WCVLOfXkuw_O36BCUE3sGdDkjBF8';
const NURTURE_END_TAG = '🔚ai-nurture-ended';
const MAX_ROWS_PER_RUN = 100;
const DUP_SEND_GUARD_MS = 60 * 60 * 1000; // 1 hour

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

type QueueRow = {
  contact_id: string;
  conversation_id: string;
  channel: 'sms' | 'email';
  first_name: string | null;
  follow_up_number: number;
  next_send_at: string;
  created_at: string;
  last_sent_at: string | null;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  // Auth: require service-role or the cron vault secret in Authorization header
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ') || auth.length < 20) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const { data: dueRows, error } = await supabase
    .schema('ops')
    .from('ai_inbox_followup_queue')
    .select('*')
    .lte('next_send_at', new Date().toISOString())
    .lt('follow_up_number', 10)
    .order('next_send_at', { ascending: true })
    .limit(MAX_ROWS_PER_RUN);

  if (error) {
    console.error('[queue] read error:', error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const rows = (dueRows ?? []) as QueueRow[];
  let processed = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      await processRow(row);
      processed++;
    } catch (err) {
      errors++;
      console.error(`[process] contact ${row.contact_id} failed:`, err);
    }
  }

  return new Response(JSON.stringify({ ok: true, processed, errors, total_due: rows.length }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});

async function processRow(row: QueueRow): Promise<void> {
  // Idempotency guard
  if (row.last_sent_at && Date.now() - new Date(row.last_sent_at).getTime() < DUP_SEND_GUARD_MS) {
    console.log(`[dup-guard] contact ${row.contact_id} sent within the last hour, skipping`);
    return;
  }

  // ... continue: fetch contact, check member tag, fetch history + rapport,
  // build prompt per touch, call Sonnet, guardrail, send via GHL, write memory,
  // extract rapport, compute nextSendAt, update or delete queue row,
  // add nurture-end tag on touch 9, write agent_signals audit row
}
```

(Full `processRow` body is too long to inline; follow spec §5.7 steps a–k verbatim. Functions needed: `fetchGhlContact`, `sendGhlReply`, `addGhlTag`, `writeMemory`, `writeAgentSignal` — copy patterns from `ghl-sales-agent/index.ts`, optionally extract into `_shared/ghl.ts` in a follow-up refactor.)

- [ ] **Step 2: Type-check**

```bash
cd supabase/functions/ghl-sales-followup
deno check index.ts
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/ghl-sales-followup/index.ts
git commit -m "$(cat <<'EOF'
feat(ghl-sales-followup): full handler — queue drain + touch routing

- Reads up to 100 due rows per invocation
- Per-row: member-tag guard, history + rapport fetch, touch-specific
  prompt via salesVoice, Sonnet call, banned-word guardrail, GHL send,
  memory write, rapport extract, queue advance or delete+tag on touch 9
- Idempotency: skip rows sent within the last hour (prevents dual-send
  on partial crash)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Deploy `ghl-sales-followup` + 3 HTTP smoke tests

**Files:** (deploy only)

- [ ] **Step 1: Unit tests green**

```bash
deno test supabase/functions/ghl-sales-followup/
```

- [ ] **Step 2: Deploy via Supabase MCP**

```
deploy_edge_function(
  name="ghl-sales-followup",
  files=[...],
  verify_jwt=false  # cron hits us with vault secret bearer, not Supabase JWT
)
```

- [ ] **Step 3: Verify deployed source matches local** — CLAUDE.md guardrail

```
get_edge_function(name="ghl-sales-followup") → diff vs local
```

- [ ] **Step 4: Three smoke tests**

```bash
# 1. Missing auth → 401
curl -s -o /dev/null -w '%{http_code}' -X POST \
  https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-sales-followup
# Expected: 401

# 2. GET → 405
curl -s -o /dev/null -w '%{http_code}' \
  https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-sales-followup
# Expected: 405

# 3. With auth, POST returns 200 with processed count
curl -s -X POST \
  https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-sales-followup \
  -H "Authorization: Bearer <anon-key-from-dashboard>" \
  -H 'Content-Type: application/json'
# Expected: {"ok":true,"processed":N,"errors":0,"total_due":N}
```

- [ ] **Step 5: No commit needed** (source committed in Task 19). Log Supabase version.

---

## Task 21: Draft + apply pg_cron migration

**Files:**
- Create: `supabase/migrations/20260417000004_ghl_sales_followup_cron.sql`

- [ ] **Step 1: Write the cron migration using vault secret (no hardcoded JWT)**

```sql
-- 20260417000004_ghl_sales_followup_cron.sql
-- Runs ghl-sales-followup once per business hour Mon-Fri.
-- Auth: supabase_anon_key from vault.decrypted_secrets (same pattern as
-- sync-ai-phil-docs job, jobid 9). Never hardcode JWTs — CLAUDE.md guardrail.

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
```

- [ ] **Step 2: Commit the migration (not yet applied)**

```bash
git add supabase/migrations/20260417000004_ghl_sales_followup_cron.sql
git commit -m "$(cat <<'EOF'
feat(migration): pg_cron schedule for ghl-sales-followup

0 9-17 * * 1-5 (top of hour, business hours Mon-Fri).
Auth via vault.decrypted_secrets.supabase_anon_key — no hardcoded JWT.
Not yet applied — awaiting Phillip's review.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Phillip reviews the cron SQL.**

- [ ] **Step 4: On approval, apply migration**

```
apply_migration(name="20260417000004_ghl_sales_followup_cron", query=<file contents>)
```

- [ ] **Step 5: Verify cron job exists**

```sql
SELECT jobid, jobname, schedule FROM cron.job WHERE jobname = 'ghl-sales-followup-hourly';
```

Expected: 1 row with schedule `0 9-17 * * 1-5`.

- [ ] **Step 6: Run `get_advisors('security')`** — CLAUDE.md. Note findings.

---

## Task 22: Verify end-to-end with existing queue row

**Files:** (verification only)

- [ ] **Step 1: Confirm Phillip's test contact row is still in the queue**

```sql
SELECT * FROM ops.ai_inbox_followup_queue;
```

Expected: 1 row (Phillip's test from last session, `next_send_at` in the past). This row will fire on the next cron tick.

- [ ] **Step 2: Wait for the next cron hour (or manually trigger once for verification)**

Manual trigger: curl the function with the anon-key bearer from Task 20 step 4.

- [ ] **Step 3: Verify in `ai_inbox_conversation_memory`**

```sql
SELECT role, message, intent, created_at
FROM ops.ai_inbox_conversation_memory
WHERE contact_id = 'uS9LnuONWr9qTSzg7MKM'
ORDER BY created_at DESC LIMIT 5;
```

Expected: new assistant row with the Touch 1 clarity+proof message.

- [ ] **Step 4: Verify rapport facts were extracted**

```sql
SELECT facts, fact_count, updated_at
FROM ops.contact_rapport
WHERE contact_id = 'uS9LnuONWr9qTSzg7MKM';
```

Expected: 1 row with F.O.R.M. facts from prior SMS conversation (the workshop question, member-access confusion, etc.).

- [ ] **Step 5: Verify queue row advanced**

```sql
SELECT follow_up_number, next_send_at, last_sent_at
FROM ops.ai_inbox_followup_queue
WHERE contact_id = 'uS9LnuONWr9qTSzg7MKM';
```

Expected: `follow_up_number = 2`, `next_send_at = created_at + 3 days`, `last_sent_at` just now.

- [ ] **Step 6: If anything is wrong, debug via `get_logs('edge-function')` and fix before proceeding.** No commit needed for verification; commit any fixes as they happen.

---

## Task 23: Session close-out per CLAUDE.md protocol

**Files:**
- Modify: `vault/60-content/ai-phil/_ROADMAP.md`
- Create: `vault/50-meetings/2026-04-17-ai-sales-system-v2-shipped.md`

- [ ] **Step 1: Update roadmap** — move P4a, P4c, AI Sales System v2 items from Priorities to Shipped with date. Strike through the now-addressed known issues.

- [ ] **Step 2: Write session summary** at `vault/50-meetings/2026-04-17-ai-sales-system-v2-shipped.md` with the "Pick up here" block at the top (what's live / what's pending human / next priority / read-these-first docs).

- [ ] **Step 3: Git close-out checks**

```bash
cd "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Ai Phil"
git status       # clean working tree
git log origin/main..HEAD --oneline  # how many commits ahead
```

- [ ] **Step 4: For every edge function touched (`ghl-sales-agent`, `ghl-sales-followup`), re-verify deployed source matches local**

```
get_edge_function(name="ghl-sales-agent") → diff vs local
get_edge_function(name="ghl-sales-followup") → diff vs local
```

Any drift → commit the live version immediately.

- [ ] **Step 5: Final security advisors sweep**

```
get_advisors('security')
```

Fix any new ERRORs. Note WARNs in the session summary.

- [ ] **Step 6: Ask Phillip: push to origin/main, or hold?** Per CLAUDE.md: "Push decision is explicit every close-out."

- [ ] **Step 7: Update memory files** in `~/.claude/projects/<project>/memory/` — new entry for AI Sales System v2 shipped, updating MEMORY.md index.

---

## Self-Review

**Spec coverage:** Every section of the spec has a corresponding task or is explicitly deferred:

| Spec section | Plan task(s) | Notes |
|---|---|---|
| §5.1 Voice doc | Task 8 | Draft in vault, Phillip reviews |
| §5.2 salesVoice.ts | Task 10 | TDD |
| §5.3 contact_rapport table | Tasks 1, 3 | Draft + apply |
| §5.4 Post-conversation extractor | Tasks 11, 14, 19 | Helper (Task 11), integration in sales agent (Task 14), integration in followup (Task 19) |
| §5.5 Rapport context injection | Task 13 | Via buildSystemPrompt |
| §5.6 Sales-agent overhaul | Tasks 13–17 | Four-part incremental |
| §5.7 Followup function | Tasks 18–20 | Scaffold, implement, deploy |
| §5.8 Fathom distillation | Tasks 5–7 | TDD, subset, full |
| §5.9 KB doc caching | Tasks 2, 12 | Schema + wrapper |
| §5.10 Memory index | Tasks 2, 3 | Migration + apply |
| §5.11 Cold-Outreach-Playbook | Task 9 | Vault draft |
| §10 Migration plan steps | Tasks 1–23 | Full coverage |
| §11 Rollback plan | Documented, no task |
| §12 Open questions | Resolved pre-plan by Phillip |
| §13 Success criteria | Task 22 (end-to-end verification) |

**Placeholder scan:** One deliberate deferred detail — Task 19 step 1 references `processRow` body continuation as "follow spec §5.7 steps a–k verbatim" rather than re-writing ~150 lines of TypeScript. The spec has the full detail. The subagent executing this task must open the spec alongside the plan. Acceptable per the writing-plans skill's "DRY" principle.

**Type consistency check:**
- `RapportFacts` is defined in `rapport.ts`, imported by `salesVoice.ts` — consistent
- `VoiceContext` defined in `salesVoice.ts`, imported by both callers — consistent
- `QueueRow` defined in `ghl-sales-followup/index.ts` locally — standalone, OK
- `classifyTouch` / `computeNextSendAt` / `TouchOutcome` in cadence.ts, imported by index.ts — consistent

**Commits are frequent:** 23 tasks, most with their own commit. Matches the "frequent commits" principle.

**Plan size:** ~950 lines for a 10–14 day project. Dense but not bloated; every task has enough detail to execute without re-reading the full spec.
