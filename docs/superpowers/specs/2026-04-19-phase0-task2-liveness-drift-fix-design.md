# Phase 0 Task 2 — Sales-/Member-Agent Liveness Drift Fix (Design)

**Status:** design, pending approval
**Owner:** Phillip Ngo
**Dates:** brainstormed 2026-04-19
**Supersedes:** none (first spec for this drift)

---

## Context

`ops.ghl_convo_triage_decisions` has been silent since 2026-04-12 23:53 UTC (7 days). Phase 0 Task 2 in `_system/architecture.md` Step 1 calls it out as one of the four drift fixes blocking exit from the Foundation phase.

Live investigation on 2026-04-19 (test SMS sent by Phillip) reframed the premise:

1. `ghl_convo_triage_decisions` is written by the `richie-cc2` daemon, not by any edge function. Its silence aligns with the architecture decision to retire Richie (architecture.md Step 2 — "Richie — retire"). **Not a drift; table will be abandoned.**
2. The real silent thing is `ops.ai_inbox_conversation_memory`: no rows since 2026-04-17 22:41 UTC (48h before test). Root cause investigation showed:
   - `ghl-member-agent v4` handles test SMS correctly end-to-end (fetches contact, classifies intent, calls Claude haiku, sends GHL reply, returns 200 in ~3.8s).
   - Insert into `ops.ai_inbox_conversation_memory` silently fails because the written tuple violates two CHECK constraints:
     - `intent` check accepts `{sales, event, support, unknown}`; member-agent writes `'member_support'` → fail.
     - `stage` check accepts `{qualifying, presenting, objection, closed, nurture}`; member-agent writes `stage = finalIntent` ∈ `{onboarding, content, event, coaching, support, escalate}` → fail.
   - The insert is wrapped in try/catch with `console.error` — no exception propagates, so the function returns 200 and the error is invisible to callers. Every member-agent memory write since v1 shipped (2026-04-16) has been silently dropped. All 100 existing rows in the table are sales-agent writes.
3. Test-run uncovered two additional defects:
   - Double `-Ai Phil` SMS signature — Claude is emitting the signature inside the reply body, then the SMS sanitizer appends it again.
   - `agent_signals` dispatch to `target_agent = 'richie-cc2'` fails DNS resolution (`archies-mac-mini.tail51ba6f.ts.net` unreachable). One error per inbound. Expected given Richie retirement; needs un-wiring.

## Goals

Make `ops.ai_inbox_conversation_memory` live again for member-agent traffic, remove the SMS double-signature, and stop routing audit signals to retired Richie. Verify with a single end-to-end test SMS.

## Non-Goals

- Migrating the 100 existing sales-agent rows to a richer taxonomy.
- Backfilling the 48h of dropped member-agent inserts (data is lost; the reply was sent, the fact-extraction downstream will still pick up rapport from GHL history).
- Fixing `ghl_convo_triage_decisions` silence (table is abandoned per architecture).
- Any sales-agent-side correctness beyond confirming the constraint widening doesn't break its existing writes.

## Design

### 2.1 — Broaden CHECK constraints (migration)

Decision (from brainstorming): stage collapses to a single `'member'` value for all member-agent inserts; member sub-state (`onboarding | content | event | coaching | support | escalate`) lives in the `intent` column.

**Migration — new file `supabase/migrations/<timestamp>_broaden_ai_inbox_memory_checks.sql`:**

```sql
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
```

**Validation:** all 100 existing rows use `intent ∈ {sales,event,support,unknown}` and `stage = 'qualifying'` — all remain valid under the new constraints.

### 2.2 — Member-agent writes use the new taxonomy

In `supabase/functions/ghl-member-agent/index.ts` line ~1000, change the insert payload:

```typescript
// BEFORE
{ ..., intent: 'member_support', stage: finalIntent }

// AFTER
{ ..., intent: finalIntent, stage: 'member' }
```

`finalIntent ∈ {onboarding, content, event, coaching, support, escalate}`. All six values are in the widened `intent` set (escalate + onboarding + content + coaching are new; event + support already existed). `stage = 'member'` is the sole new stage value.

Add a unit test in `supabase/functions/ghl-member-agent/index.test.ts` verifying that all six member intents pass the CHECK constraint (via in-memory validator or a seed-and-assert pattern, whichever matches the existing test style).

### 2.3 — Strip pre-existing `-Ai Phil` before sanitizer appends

In `supabase/functions/ghl-member-agent/index.ts` SMS sanitizer (around line 985), before appending `\n-Ai Phil`:

```typescript
replyText = stripMarkdown(replyText);
replyText = replyText.replace(/\s*-\s*Ai\s*Phil\s*$/i, '').trimEnd();
```

Test cases:
- `"Hello -Ai Phil"` → `"Hello"`
- `"Hello\n-Ai Phil"` → `"Hello"`
- `"Hello\n-Ai Phil\n-Ai Phil"` → `"Hello\n-Ai Phil"` first trim (one pass is enough — second sig lives in the sig slot, we want to nuke the LLM-emitted one). Actually: run the regex in a loop until no match, OR use `.replace(/(\s*-\s*Ai\s*Phil\s*)+$/i, '')` to strip one-or-more trailing signatures. Spec picks the loop-free one-or-more variant.
- `"Ai Phil helps you"` → unchanged (no trailing anchor).

Final regex: `/(?:\s*-\s*Ai\s*Phil\s*)+$/i` — greedy, trailing, handles 1..n.

No behavior change for email channel (signature is SMS-only).

### 2.4 — Route audit signals to `quimby`

In both `ghl-member-agent/index.ts` and `ghl-sales-agent/index.ts`, every `writeAgentSignal({ ..., target_agent: 'richie-cc2', ... })` becomes `target_agent: 'quimby'`.

Additionally, check `signal-dispatch` edge function for any hardcoded `richie-cc2` routing rule; if found, update to `quimby`. This is ORTHOGONAL to removing the DNS failure — the DNS failure comes from signal-dispatch trying to POST to `archies-mac-mini.tail51ba6f.ts.net`. The fix is to either:

- **(a)** remove the HTTP dispatch for `quimby` entirely (Quimby doesn't exist yet; audit rows in `agent_signals` are sufficient; dispatch-log noise goes away)
- **(b)** leave dispatch alone and accept one audit-signal error per inbound until Quimby lands

Recommendation: **(a)**. Check `signal-dispatch` source; if it has a URL map, set `quimby` to null/skip; if it uses per-row URL lookup from a config table, remove the richie-cc2 row. This keeps audit rows clean and removes noise.

### Execution order

1. 2.1 (migration) — apply first, widens acceptance before any code change lands so intermediate deploys don't break.
2. 2.2 + 2.3 + 2.4 — one commit per concern, deploy both agents once.
3. Verification SMS — Phillip sends one plain SMS. Expected:
   - New row in `ops.ai_inbox_conversation_memory` with `intent ∈ {onboarding,content,event,coaching,support,escalate}` and `stage = 'member'`.
   - SMS reply has exactly one `-Ai Phil` signature.
   - `public.agent_signals` dispatch row has no DNS error (or no dispatch-log row for `quimby` at all if we take path (a)).

## Risks

- **Sales-agent regression from widened constraints.** Mitigated: widening never invalidates existing valid tuples, and sales-agent writes `{sales|event|support|unknown} + qualifying` exclusively — all still valid.
- **Claude keeps emitting `-Ai Phil` inside the body.** The regex strip handles it; side-effect-free.
- **Hardcoded richie-cc2 elsewhere.** Grep for `richie-cc2` across `supabase/functions/` + `supabase/migrations/` + `src/` before closing. If other references are found, they may need independent decisions.
- **`signal-dispatch` routing config in a table.** If the routing lives in a Postgres table, removing richie-cc2 is a data change that should be paired with the migration.

## Testing

- Unit: stripSignature regex cases (4 above).
- Unit: deno test for member-agent `finalIntent ∈ {...}` passes new CHECK (via seeding a test row if the existing harness supports it, otherwise assertion on the regex).
- Integration: single live SMS from Phillip after redeploy. Three observable assertions above.
- Rollback: if verification SMS fails, `git revert` the code changes and redeploy; the migration is widening-only, no need to revert.

## Decisions

- **stage collapses to `'member'`** — single new value, sub-state lives in intent. Per Phillip 2026-04-19.
- **target_agent = `quimby`** — canonical-not-yet-live, per Phillip 2026-04-19.
- **signal-dispatch noise fix: take path (a)** — remove the HTTP dispatch for quimby entirely rather than accept error rows.
- **No backfill** — 48h of lost member-agent memory is acceptable; rapport layer reads GHL history directly.

## Out-of-scope (defer to later drift-fix rounds)

- Monitor alert on `ai_inbox_conversation_memory` silence > 24h during business hours.
- Archive/DROP `ops.ghl_convo_triage_decisions` + `ops.ghl_convo_triage_runs` once Richie is fully retired.
- Adding `stage = 'member'` to any downstream analytics / reporting queries.
