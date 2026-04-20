# Phase 0 Task 2 — Liveness Drift Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore `ops.ai_inbox_conversation_memory` writes for member-agent, remove double SMS signature, retarget audit signals to `quimby`. Verify with a live SMS from Phillip.

**Architecture:** (1) Migration widens `intent` + `stage` CHECK constraints to accept member-agent taxonomy. (2) Member-agent insert uses `intent = finalIntent`, `stage = 'member'`. (3) Pure `stripTrailingSignature` helper drops LLM-emitted `-Ai Phil` before the SMS sanitizer appends one. (4) All three GHL edge functions (`ghl-sales-agent`, `ghl-member-agent`, `ghl-sales-followup`) retarget `target_agent: 'richie-cc2'` → `'quimby'`.

**Tech Stack:** Supabase Postgres (migrations + MCP), Supabase Edge Functions (Deno), TypeScript, `deno test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-04-19-phase0-task2-liveness-drift-fix-design.md`

---

## Pre-Flight (before any write)

- [ ] **PF-1: Verify no signal-dispatch routing table exists.**

Run via Supabase MCP `execute_sql`:

```sql
select table_schema, table_name
from information_schema.tables
where table_schema in ('public','ops','vault')
  and (table_name ilike '%rout%' or table_name ilike '%dispatch%');
```

Expected: zero rows OR only a dispatch-log/audit table (no routing config). If a routing config table IS returned, STOP and add a §2.4 sub-step to update it alongside the agent code; then resume.

- [ ] **PF-2: Verify `ops.agent_registry` has no dispatch URL column.**

Run via Supabase MCP `execute_sql`:

```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'ops' and table_name = 'agent_registry'
order by ordinal_position;
```

Expected: heartbeat/status metadata columns only. If any `endpoint_url` / `gateway_url` / `dispatch_url` column exists, STOP and add a task to update the `richie-cc2` row to `quimby` (or null) alongside the code changes.

- [ ] **PF-3: Verify all 100 existing rows stay valid after constraint widening.**

Run via Supabase MCP `execute_sql`:

```sql
select intent, stage, count(*)
from ops.ai_inbox_conversation_memory
group by intent, stage
order by count(*) desc;
```

Expected: only combinations where intent ∈ `{sales,event,support,unknown}` and stage = `'qualifying'`. Any row with a value outside those sets is an existing constraint violation (unlikely per current schema, but confirm). If found, capture in the follow-up roadmap.

---

## Task 1: Migration — widen CHECK constraints

**Files:**
- Create: `supabase/migrations/20260420000000_broaden_ai_inbox_memory_checks.sql`

- [ ] **Step 1.1: Write the migration file.**

Create `supabase/migrations/20260420000000_broaden_ai_inbox_memory_checks.sql` with content:

```sql
-- Phase 0 Task 2 — broaden ai_inbox_conversation_memory CHECK constraints.
--
-- Member-agent (shipped 2026-04-16) has been silently failing every insert
-- because its intent='member_support' and stage ∈ {onboarding,content,event,
-- coaching,support,escalate} both violate the sales-funnel-only CHECK
-- constraints originally defined for sales-agent use.
--
-- Fix: widen intent to accept the member sub-state taxonomy, widen stage to
-- accept a single literal 'member' value. Member sub-state lives in the
-- intent column. Downstream analytics MUST filter by stage=='member' first
-- before aggregating by intent to avoid conflating prospect-support with
-- member-support.

alter table ops.ai_inbox_conversation_memory
  drop constraint ai_inbox_conversation_memory_intent_check;

alter table ops.ai_inbox_conversation_memory
  add constraint ai_inbox_conversation_memory_intent_check
  check (intent = any (array[
    'sales','event','support','unknown',
    'onboarding','content','coaching','escalate'
  ]));

alter table ops.ai_inbox_conversation_memory
  drop constraint ai_inbox_conversation_memory_stage_check;

alter table ops.ai_inbox_conversation_memory
  add constraint ai_inbox_conversation_memory_stage_check
  check (stage = any (array[
    'qualifying','presenting','objection','closed','nurture',
    'member'
  ]));

comment on column ops.ai_inbox_conversation_memory.intent is
  'Per-surface intent vocabulary. Sales-agent writes one of '
  '{sales,event,support,unknown}. Member-agent writes one of '
  '{onboarding,content,event,coaching,support,escalate}. '
  'event/support overlap between both surfaces — use stage to disambiguate: '
  'stage=''member'' means the row originated from the member-agent surface.';

comment on column ops.ai_inbox_conversation_memory.stage is
  'Conversation stage. Sales-agent writes one of '
  '{qualifying,presenting,objection,closed,nurture} (the sales-funnel taxonomy). '
  'Member-agent writes the literal ''member'' — member sub-state lives in '
  'the intent column. Downstream analytics MUST filter by stage before '
  'aggregating by intent to avoid conflating prospect-support with '
  'member-support.';
```

- [ ] **Step 1.2: Apply the migration via Supabase MCP.**

Run: `mcp__claude_ai_Superbase_MCP__apply_migration` with `name = "broaden_ai_inbox_memory_checks"` and `query =` the full SQL above.

Expected: success response with no error.

- [ ] **Step 1.3: Verify the new constraints are in place.**

Run via `execute_sql`:

```sql
select constraint_name, check_clause
from information_schema.check_constraints
where constraint_schema = 'ops'
  and constraint_name in (
    'ai_inbox_conversation_memory_intent_check',
    'ai_inbox_conversation_memory_stage_check'
  );
```

Expected:
- `intent_check`: `(intent = ANY (ARRAY['sales'::text, 'event'::text, 'support'::text, 'unknown'::text, 'onboarding'::text, 'content'::text, 'coaching'::text, 'escalate'::text]))`
- `stage_check`: `(stage = ANY (ARRAY['qualifying'::text, 'presenting'::text, 'objection'::text, 'closed'::text, 'nurture'::text, 'member'::text]))`

- [ ] **Step 1.4: Smoke-test insert with a member-shape tuple (then delete it).**

Run via `execute_sql`:

```sql
insert into ops.ai_inbox_conversation_memory
  (contact_id, conversation_id, channel, role, message, intent, stage)
values
  ('_smoke_test', '_smoke_test', 'sms', 'user', 'smoke test',
   'onboarding', 'member');

delete from ops.ai_inbox_conversation_memory
where contact_id = '_smoke_test';
```

Expected: insert succeeds (constraint accepts `intent='onboarding'` + `stage='member'`), delete succeeds.

- [ ] **Step 1.5: Commit.**

```bash
git add supabase/migrations/20260420000000_broaden_ai_inbox_memory_checks.sql
git commit -m "feat(migration): broaden ai_inbox_conversation_memory CHECK constraints

Member-agent inserts have silently failed since v1 (2026-04-16) because
intent='member_support' and stage=<memberIntent> violated the sales-funnel
CHECK constraints. Widen intent to accept member sub-state taxonomy and
add literal 'member' to stage. Member sub-state lives in intent column.
COMMENT ON COLUMN documents the disambiguation rule for analytics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Unit test + helper — `stripTrailingSignature`

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts` (export new helper, call it in SMS sanitizer ~L985)
- Modify: `supabase/functions/ghl-member-agent/index.test.ts` (add test block)

- [ ] **Step 2.1: Read the existing test file to match its style.**

Run: Read `supabase/functions/ghl-member-agent/index.test.ts` to confirm the `Deno.test` / import patterns used by existing tests (e.g., `resolveChannel`, `matchesEscalationKeyword`).

- [ ] **Step 2.2: Write the failing tests.**

Append to `supabase/functions/ghl-member-agent/index.test.ts`:

```typescript
import { stripTrailingSignature } from './index.ts';

Deno.test('stripTrailingSignature — single trailing -Ai Phil', () => {
  const input = 'Hello there.\n-Ai Phil';
  const out = stripTrailingSignature(input);
  if (out !== 'Hello there.') throw new Error(`got "${out}"`);
});

Deno.test('stripTrailingSignature — inline -Ai Phil before trailing one', () => {
  const input = 'Hello there.\n-Ai Phil\n-Ai Phil';
  const out = stripTrailingSignature(input);
  if (out !== 'Hello there.') throw new Error(`got "${out}"`);
});

Deno.test('stripTrailingSignature — preserves body when no trailing sig', () => {
  const input = 'Ai Phil helps you.';
  const out = stripTrailingSignature(input);
  if (out !== 'Ai Phil helps you.') throw new Error(`got "${out}"`);
});

Deno.test('stripTrailingSignature — tolerant of whitespace variants', () => {
  const input = 'Got it.   - Ai  Phil   \n';
  const out = stripTrailingSignature(input);
  if (out !== 'Got it.') throw new Error(`got "${out}"`);
});

Deno.test('stripTrailingSignature — empty string passthrough', () => {
  const out = stripTrailingSignature('');
  if (out !== '') throw new Error(`got "${out}"`);
});
```

- [ ] **Step 2.3: Run tests to verify they fail.**

Run from repo root:

```bash
cd supabase/functions && deno test ghl-member-agent/index.test.ts \
  --allow-read --allow-net --no-check 2>&1 | tail -20
```

Expected: `error: module "file://.../ghl-member-agent/index.ts" does not provide an export named "stripTrailingSignature"` (or equivalent TypeScript import error — the export doesn't exist yet).

- [ ] **Step 2.4: Add the helper to `index.ts`.**

In `supabase/functions/ghl-member-agent/index.ts`, find the "Webhook body extractors" section (~line 100) and insert this block after `normalizeChannel` (just before the `resolveChannel` section ~line 129):

```typescript
// ---------------------------------------------------------------------------
// stripTrailingSignature — pure helper
// ---------------------------------------------------------------------------
//
// Removes one-or-more trailing "-Ai Phil" signatures from a reply body before
// the SMS sanitizer appends the canonical signature. Necessary because Claude
// sometimes emits "-Ai Phil" inside the body when the system prompt leans on
// the signature example, producing a double-signed SMS like
// "message\n-Ai Phil\n-Ai Phil". Trailing-anchored so "Ai Phil helps you"
// in the middle of a body is preserved.

export function stripTrailingSignature(text: string): string {
  return text.replace(/(?:\s*-\s*Ai\s*Phil\s*)+$/i, '').trimEnd();
}
```

- [ ] **Step 2.5: Run tests to verify they pass.**

Run:

```bash
cd supabase/functions && deno test ghl-member-agent/index.test.ts \
  --allow-read --allow-net --no-check 2>&1 | tail -20
```

Expected: 5 new tests pass, all existing tests still pass. Look for `ok | X passed | 0 failed`.

- [ ] **Step 2.6: Wire the helper into the SMS sanitizer.**

In `supabase/functions/ghl-member-agent/index.ts`, find the SMS sanitizer block (`if (channel === 'sms') { ... }`, ~line 984). Change from:

```typescript
    if (channel === 'sms') {
      const SMS_SIGNATURE = '\n-Ai Phil';
      const SMS_LIMIT = 480;
      const maxBody = SMS_LIMIT - SMS_SIGNATURE.length; // 472
      replyText = stripMarkdown(replyText);
      if (replyText.length > maxBody) replyText = replyText.substring(0, maxBody - 3) + '...';
      replyText = replyText + SMS_SIGNATURE;
    }
```

To:

```typescript
    if (channel === 'sms') {
      const SMS_SIGNATURE = '\n-Ai Phil';
      const SMS_LIMIT = 480;
      const maxBody = SMS_LIMIT - SMS_SIGNATURE.length; // 472
      replyText = stripMarkdown(replyText);
      replyText = stripTrailingSignature(replyText);
      if (replyText.length > maxBody) replyText = replyText.substring(0, maxBody - 3) + '...';
      replyText = replyText + SMS_SIGNATURE;
    }
```

Also check the injection-refusal branch at ~line 891-893 — the existing code already hand-builds `${SECURITY_REFUSAL_PRIMARY}\n-Ai Phil` for SMS, so it does NOT flow through the sanitizer. Leave that branch unchanged; `SECURITY_REFUSAL_PRIMARY` is a constant that never contains an `-Ai Phil` tail.

- [ ] **Step 2.7: Re-run the full member-agent test file.**

```bash
cd supabase/functions && deno test ghl-member-agent/index.test.ts \
  --allow-read --allow-net --no-check 2>&1 | tail -20
```

Expected: all tests still pass.

- [ ] **Step 2.8: Commit.**

```bash
git add supabase/functions/ghl-member-agent/index.ts supabase/functions/ghl-member-agent/index.test.ts
git commit -m "feat(ghl-member-agent): strip trailing -Ai Phil before SMS sanitizer appends

Claude occasionally emits -Ai Phil inside the reply body when the system
prompt leans on the signature example, producing double-signed SMS like
\"message\\n-Ai Phil\\n-Ai Phil\" (observed in the 2026-04-19 liveness
test). stripTrailingSignature is a pure trailing-anchored regex helper;
5 unit tests cover single, double, none, whitespace, and empty inputs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Member-agent insert uses new taxonomy

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts` (insert payload ~L1000-1018)

- [ ] **Step 3.1: Find the conversation-memory insert.**

In `supabase/functions/ghl-member-agent/index.ts`, locate the block at ~line 999-1018 that inserts into `ai_inbox_conversation_memory`. The current payload has `intent: 'member_support'` and `stage: finalIntent` for both user and assistant rows.

- [ ] **Step 3.2: Swap the intent/stage fields.**

Replace the `.insert([ ... ])` call's payload with:

```typescript
      const { error } = await supabase.schema('ops').from('ai_inbox_conversation_memory').insert([
        {
          contact_id: contactId,
          conversation_id: conversationId,
          channel,
          role: 'user',
          message: messageBody,
          intent: finalIntent,
          stage: 'member',
        },
        {
          contact_id: contactId,
          conversation_id: conversationId,
          channel,
          role: 'assistant',
          message: replyText,
          intent: finalIntent,
          stage: 'member',
        },
      ]);
```

(Only the `intent` and `stage` values change. Everything else is identical to the current code.)

- [ ] **Step 3.3: Confirm the type/enum alignment.**

`finalIntent: Intent` (declared at line 68) is `'onboarding' | 'content' | 'event' | 'coaching' | 'support' | 'escalate'`. All six values are in the widened `intent` CHECK from Task 1. Read the `Intent` type declaration to confirm no drift.

- [ ] **Step 3.4: Run full member-agent tests.**

```bash
cd supabase/functions && deno test ghl-member-agent/index.test.ts \
  --allow-read --allow-net --no-check 2>&1 | tail -20
```

Expected: all tests pass (this change is handler-level; unit tests of pure helpers are unaffected).

- [ ] **Step 3.5: Commit.**

```bash
git add supabase/functions/ghl-member-agent/index.ts
git commit -m "fix(ghl-member-agent): write finalIntent in intent column, literal 'member' in stage

Member-agent has been silently failing every ai_inbox_conversation_memory
insert since v1 (2026-04-16) because intent='member_support' and
stage=finalIntent violated the sales-funnel CHECK constraints. Task 1's
migration widened both checks. This change aligns the insert payload
with the new taxonomy: sub-state in intent, literal 'member' in stage.
The try/catch wrapper that masked the failure is intentionally left
alone — the insert is now non-fatal AND succeeds.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Retarget all `target_agent: 'richie-cc2'` → `'quimby'`

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts` (4 refs: lines 830, 899, 1041, 1070)
- Modify: `supabase/functions/ghl-sales-agent/index.ts` (6 refs: lines 610, 682, 717, 830, 960, 986)
- Modify: `supabase/functions/ghl-sales-followup/index.ts` (4 refs: lines 354, 435, 548, 617)

- [ ] **Step 4.1: Verify exact ref count before editing.**

Run via Grep tool:

```
pattern: "target_agent: 'richie-cc2'"
path: supabase/functions
output_mode: content
```

Expected: 14 matches across the three files listed above. If the count differs, audit before proceeding.

- [ ] **Step 4.2: Global replace across all three files.**

Use the Edit tool on each file with `replace_all: true`:

For `supabase/functions/ghl-member-agent/index.ts`:
- `old_string`: `target_agent: 'richie-cc2',`
- `new_string`: `target_agent: 'quimby',`
- `replace_all`: true

Same pattern for `ghl-sales-agent/index.ts` and `ghl-sales-followup/index.ts`.

- [ ] **Step 4.3: Verify zero remaining `richie-cc2` references in the functions tree.**

Run via Grep tool:

```
pattern: "richie-cc2"
path: supabase/functions
output_mode: content
```

Expected: zero matches. (If any remain — e.g., in comments or logs — decide per instance whether to update. Typical case: comments referring to historical richie-cc2 behavior are left untouched; active code references are all target_agent assignments and should be zero.)

- [ ] **Step 4.4: Run full test suites for all three functions.**

```bash
cd supabase/functions && deno test \
  ghl-member-agent/index.test.ts \
  ghl-sales-agent/index.test.ts \
  --allow-read --allow-net --allow-env --no-check \
  2>&1 | tail -30
```

(`ghl-sales-agent` tests require `--allow-env` per prior memory.)

Expected: all tests pass.

- [ ] **Step 4.5: Commit.**

```bash
git add supabase/functions/ghl-member-agent/index.ts supabase/functions/ghl-sales-agent/index.ts supabase/functions/ghl-sales-followup/index.ts
git commit -m "refactor(ghl-*): retarget audit signals richie-cc2 → quimby

Richie retired per Phil 2026-04-19 (architecture.md Step 2). Quimby is
the canonical audit/escalation steward. Signal-dispatch v12 will still
try HTTP dispatch on 'quimby' until v13 adds it to POLL_ONLY_AGENTS —
tracked as cross-repo follow-up (Leo CC2 / Philgood OS territory).
Audit rows themselves land cleanly in agent_signals regardless; only
the dispatch-log companion row will carry a DNS error until v13.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Deploy edge functions + verify source parity

**Files:**
- Deploy: `ghl-sales-agent` (v14), `ghl-member-agent` (v5), `ghl-sales-followup` (v3)

- [ ] **Step 5.1: Confirm working tree is clean before deploying.**

```bash
git status --short
```

Expected: clean (no uncommitted changes across the 3 edge-function dirs + migration + test).

- [ ] **Step 5.2: Deploy `ghl-member-agent` via Supabase MCP.**

Use `mcp__claude_ai_Superbase_MCP__deploy_edge_function` with:

- `function_slug`: `ghl-member-agent`
- `files`: array of two entries, paths relative to per the CLAUDE.md guardrail "Multi-file edge function deploys with `_shared/` imports":
  - `{ name: "_shared/salesVoice.ts", content: <file contents> }`
  - `{ name: "source/index.ts", content: <file contents> }`

The bundler prepends `source/` to each name, so files land at `source/_shared/salesVoice.ts` and `source/source/index.ts` — the entrypoint's `import '../_shared/salesVoice.ts'` resolves. (Use the Read tool to pull file contents before dispatching the deploy call.)

Expected: deploy succeeds, new version = 5.

- [ ] **Step 5.3: Deploy `ghl-sales-agent` via Supabase MCP.**

Same pattern as Step 5.2 but with `function_slug: "ghl-sales-agent"`. Expected new version: 14.

- [ ] **Step 5.4: Deploy `ghl-sales-followup` via Supabase MCP.**

`ghl-sales-followup` is SINGLE-FILE (no `_shared/` imports at the function level — check first via Grep `from '../_shared'` on `supabase/functions/ghl-sales-followup/index.ts`; if any shared imports, use multi-file pattern above). Otherwise:

- `function_slug`: `ghl-sales-followup`
- `files`: `[{ name: "index.ts", content: <file contents> }]`

Expected new version: 3.

- [ ] **Step 5.5: Verify deployed source parity.**

For each of the three functions, run `mcp__claude_ai_Superbase_MCP__get_edge_function` with the slug and confirm the `files[].content` matches the local committed source (line-for-line for each file). This is the CLAUDE.md "deployed-but-uncommitted" guardrail check.

Expected: every deployed file matches its local source exactly.

- [ ] **Step 5.6: Verify the migration is listed.**

Run `mcp__claude_ai_Superbase_MCP__list_migrations`. Expected: `broaden_ai_inbox_memory_checks` appears with version `20260420000000`.

- [ ] **Step 5.7: Run `get_advisors('security')`.**

Run `mcp__claude_ai_Superbase_MCP__get_advisors` with `type: 'security'`.

Expected: zero new ERRORs introduced by this migration. (WARNs unrelated to this shipment — `public_bucket_allows_listing`, `auth_leaked_password_protection` — are pre-existing and carry forward.)

---

## Task 6: Live verification (requires Phillip)

**Files:** none (human action + SQL observation)

- [ ] **Step 6.1: Ask Phillip to send one plain SMS.**

Example text: `"Verification SMS — checking member-agent memory + signature + audit signal."` (Any benign content works; must NOT contain injection patterns like "ignore previous" or "reveal system prompt".)

- [ ] **Step 6.2: Within 2 minutes of the SMS, verify the memory insert landed.**

Run via `execute_sql`:

```sql
select created_at::text, role, channel, intent, stage, left(message, 100) as msg
from ops.ai_inbox_conversation_memory
where created_at > now() - interval '5 minutes'
order by created_at desc
limit 10;
```

Expected: two fresh rows (one `role='user'`, one `role='assistant'`). Both have `intent ∈ {onboarding,content,event,coaching,support,escalate}` and `stage = 'member'`.

If ZERO rows appear: the insert is still failing. Check function logs via `get_logs('edge-function')` for `[memory] insert error:` lines.

- [ ] **Step 6.3: Verify the SMS reply has exactly one `-Ai Phil`.**

Ask Phillip to paste the received SMS text back. Count occurrences of `-Ai Phil`. Expected: exactly 1, at the end of the message.

- [ ] **Step 6.4: Verify the audit signal landed with `target_agent = 'quimby'`.**

Run via `execute_sql`:

```sql
select created_at::text, source_agent, target_agent, signal_type, status,
       payload->'results' as dispatch_results,
       left(payload->>'reply_preview', 100) as reply_preview
from public.agent_signals
where created_at > now() - interval '5 minutes'
  and source_agent = 'ghl-member-agent'
order by created_at desc
limit 5;
```

Expected: at least one row with `target_agent = 'quimby'`, `signal_type = 'ai-member-reply-sent'`, `status = 'delivered'`. Reply preview has a single `-Ai Phil` tail.

A companion `dispatch-log` row (from signal-dispatch) with `payload.results.quimby` containing a DNS error is EXPECTED — tracked as the signal-dispatch v13 cross-repo follow-up.

---

## Task 7: Close-out — tracking in 3 locations

**Files:**
- Modify: `vault/60-content/ai-phil/_ROADMAP.md` (shared drive)
- Create or modify: `vault/_system/cross-repo-followups.md` (shared drive)
- Modify: `vault/_system/leo-cc2-architecture-ping.md` (shared drive)

Vault root: `/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/Shared drives/AiAi Mastermind/01_Knowledge Base/AIAI-Vault/`

- [ ] **Step 7.1: Update `_ROADMAP.md` — move Task 2 to Shipped, add cross-repo follow-ups section.**

Read `60-content/ai-phil/_ROADMAP.md`; move the Task 2 row from Priorities → Shipped with the date `2026-04-19` (or `2026-04-20` if past midnight UTC when closing).

In the same file, under a new `## Cross-repo follow-ups` section (add if not present), insert:

```markdown
- **signal-dispatch v13** (Leo CC2 / Philgood OS repo) — add `'quimby'` to `POLL_ONLY_AGENTS` set in `signal-dispatch/index.ts` to eliminate DNS-error ride-along on every member-/sales-agent audit signal. Expedite trigger: rolling 7-day DNS-error rows > 100/day OR calendar reaches 2026-05-03. Quimby adapter shape (poll-only vs HTTP) is a Phase 0 Step 2 decision. Spec: `ai-phil/docs/superpowers/specs/2026-04-19-phase0-task2-liveness-drift-fix-design.md`. Monitoring SQL in spec §2.4.
```

- [ ] **Step 7.2: Create (or update) `vault/_system/cross-repo-followups.md`.**

If the file does not exist, create it with frontmatter + the signal-dispatch v13 row. Content:

```markdown
---
type: system
purpose: Canonical accretion point for items that belong in another repo.
          Leo CC2 / Philgood OS agents scan this for "pickups" during
          nightly sync.
created: 2026-04-19
---

# Cross-repo follow-ups

Items filed here must live in another repo than where they were written.
Drop the pointer so the TODO doesn't rot in the wrong tree.

---

## Open

### signal-dispatch v13 — `POLL_ONLY_AGENTS += 'quimby'`

**Created:** 2026-04-19 (from ai-phil Phase 0 Task 2 close-out).
**Target repo:** Leo CC2 / Philgood OS (wherever the signal-dispatch edge
function source is tracked — v12 was deployed by Leo CC2 on 2026-04-12).
**Scope:** one-line edit — add `'quimby'` to the `POLL_ONLY_AGENTS` Set in
`signal-dispatch/index.ts`. Redeploy as v13.
**Why:** ai-phil's ghl-member-agent, ghl-sales-agent, ghl-sales-followup
now write `target_agent: 'quimby'` to `public.agent_signals`.
signal-dispatch v12's `explicit_target` rule tries HTTP dispatch for any
named target not in `POLL_ONLY_AGENTS`, producing a DNS error (Mac mini
hostname unreachable) on every inbound. Audit signal itself lands fine;
only the companion `dispatch-log` row carries noise.
**Expedite trigger:** rolling 7-day DNS-error dispatch-log rows > 100/day,
OR calendar reaches 2026-05-03 (whichever first).
**Defer until Quimby adapter shape is decided:** per Phil 2026-04-19,
whether Quimby stays poll-only or gets an HTTP adapter (pointing at his
Paperclip URL) is a Step 2 decision. Simplest interim fix is poll-only;
adapter change is cheap if swapped later.
**Monitoring SQL:**
\`\`\`sql
select date_trunc('day', created_at) as day, count(*) as dns_errors
from public.agent_signals
where signal_type = 'dispatch-log'
  and payload->'results'->>'quimby' like '%dns error%'
  and created_at > now() - interval '14 days'
group by 1 order by 1 desc;
\`\`\`
**Spec:** `ai-phil/docs/superpowers/specs/2026-04-19-phase0-task2-liveness-drift-fix-design.md`

---

## Closed

(none yet)
```

If the file already exists, append the signal-dispatch v13 block under `## Open` (keep frontmatter + Closed section intact).

- [ ] **Step 7.3: Update `vault/_system/leo-cc2-architecture-ping.md`.**

Read the file. It's a Telegram message draft; add an `## Open follow-ups` block (or append a new bullet if one exists) so the next time Phil pushes this ping to Leo via Telegram, the signal-dispatch v13 item is included. Example addition:

```markdown
## Open follow-ups (paste into Telegram after the main message)

- signal-dispatch v13 needed: add `'quimby'` to `POLL_ONLY_AGENTS`. ai-phil's 3 GHL edge functions now target `quimby` for audit signals; without your edit, each inbound produces a cosmetic DNS-error row. Details: `_system/cross-repo-followups.md`.
```

- [ ] **Step 7.4: Commit the vault updates** (vault has its own git; if it does NOT, skip the commit — Google Drive auto-syncs).

```bash
cd "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/Shared drives/AiAi Mastermind/01_Knowledge Base/AIAI-Vault"
# Check if under git:
git status 2>/dev/null && git add 60-content/ai-phil/_ROADMAP.md _system/cross-repo-followups.md _system/leo-cc2-architecture-ping.md && git commit -m "docs: ai-phil Phase 0 Task 2 close-out + cross-repo follow-up

$(cd - > /dev/null)
```

If the vault is not a git repo, leave the files in place; Google Drive sync picks them up.

- [ ] **Step 7.5: Return to ai-phil repo and write the session summary.**

Create `vault/50-meetings/2026-04-19-phase0-task2-liveness-drift-fix.md` (or `2026-04-20-...` if past UTC midnight) with a "Pick up here" block at the top mirroring the Task 1 summary's shape: live state, pending human action (Hume + live smoke still open from Task 1; add the signal-dispatch v13 follow-up), blocked-by nothing, next-up (Phase 0 Task 3 = `ghl-sales-followup-hourly` cron TZ fix per architecture.md Step 1).

- [ ] **Step 7.6: Final `git status` + `git log origin/main..HEAD` in ai-phil.**

```bash
git status
git log --oneline origin/main..HEAD
```

Expected: working tree clean, 4-5 new commits (migration, stripTrailingSignature, member-insert taxonomy, richie→quimby retarget, any close-out doc commits). Decide with Phillip whether to push (per CLAUDE.md close-out §1: push decision is always explicit).

---

## Self-review checklist (pre-ship)

- [ ] All tasks reference the exact spec section they implement.
- [ ] No `TBD` / `TODO` / `fill in later` anywhere in this plan.
- [ ] Type `Intent` used in Task 3 matches the `Intent` union in `index.ts:68`.
- [ ] Helper `stripTrailingSignature` exported in Task 2, called in Task 2.6 — names match.
- [ ] Migration timestamp `20260420000000` is later than latest existing migration `20260419000000_injection_attempts.sql`.
- [ ] Richie retargeting touches all three GHL edge functions (14 total refs: 4 + 6 + 4).
- [ ] `get_advisors('security')` step present (CLAUDE.md mandatory post-migration).
- [ ] Deploy steps follow the corrected `_shared/salesVoice.ts` (NOT `../_shared/...`) naming convention per CLAUDE.md 2026-04-19 update.
- [ ] Live SMS verification is a human step, clearly flagged as requiring Phillip.
- [ ] Cross-repo follow-up is logged in 3 locations per Phil's review flag #1.
- [ ] DNS-error noise budget threshold is explicit (7-day avg > 100 OR 2026-05-03).

---

## Rollback

If verification (Task 6) fails after Task 5 ships:

1. `git revert <commits>` for Tasks 2-4 code changes (deploys are re-run from reverted source).
2. Redeploy `ghl-member-agent` / `ghl-sales-agent` / `ghl-sales-followup` from reverted source via Supabase MCP.
3. The migration is widening-only — no need to revert; the new constraints still accept all pre-existing (sales-agent) tuples.
4. If the migration itself fails to apply: investigate before retrying. Existing 100 rows cannot violate the widened constraints; any apply-time error would point at a DDL-level issue (e.g., a concurrent lock from pg_cron), not a semantic one.
