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

In `supabase/functions/ghl-member-agent/index.ts` SMS sanitizer (around line 985), between `stripMarkdown` and the `replyText + SMS_SIGNATURE` append:

```typescript
replyText = stripMarkdown(replyText);
replyText = replyText.replace(/(?:\s*-\s*Ai\s*Phil\s*)+$/i, '').trimEnd();
// existing length-cap + sig-append follow unchanged
```

The regex is trailing-anchored, case-insensitive, whitespace-tolerant, and greedy across one-or-more signature repeats (covers the double-signature seen in the test SMS and any future triple).

Test cases:
- `"Hello -Ai Phil"` → `"Hello"`
- `"Hello\n-Ai Phil"` → `"Hello"`
- `"Hello\n-Ai Phil\n-Ai Phil"` → `"Hello"`
- `"Ai Phil helps you"` → unchanged (no trailing anchor).
- `""` → unchanged.

Email channel (`channel !== 'sms'`) is untouched; signature is SMS-only.

### 2.4 — Retarget audit signals to `quimby` (ai-phil side only; signal-dispatch follow-up)

In both `ghl-member-agent/index.ts` and `ghl-sales-agent/index.ts`, every `writeAgentSignal({ ..., target_agent: 'richie-cc2', ... })` becomes `target_agent: 'quimby'`.

**Signal-dispatch behaviour after retargeting.** `signal-dispatch` v12 (source in Leo CC2 / Philgood OS domain, not in this repo) routes named `target_agent` via the `explicit_target` rule. An unknown target falls through HTTP dispatch to `${GATEWAY_URL}/dispatch` (currently `archies-mac-mini.tail51ba6f.ts.net`, dead). `quimby` is not yet in the `POLL_ONLY_AGENTS` set, so after the retarget each inbound will still produce one `dispatch-log` audit row with a DNS-error field in `payload.results.quimby`. The underlying audit row in `agent_signals` still lands, so **no signal is lost** — only a cosmetic error string rides along.

**Why not fix signal-dispatch in this PR.** It lives outside the ai-phil repo, owned by Leo CC2 / Philgood OS. Reaching in from an ai-phil drift fix is scope creep into another repo's ownership. The DR-2026-04-19-Paperclip-Adoption commits the signal bus to staying put as the realtime comms primitive, so there is no architectural question here — it's a one-line edit (add `'quimby'` to `POLL_ONLY_AGENTS`) that belongs in its own small PR in its own repo.

**Why not keep `richie-cc2`.** Architecture.md names Quimby as the canonical escalation / audit steward. Richie is retiring per Phil 2026-04-19. Leaving the target pointed at Richie is semantically wrong regardless of the DNS noise.

**Why not drop the audit signal.** The DR explicitly keeps the signal bus for realtime inter-agent comms. Dropping the audit deprives Quimby of context he will want as soon as he lands.

**Why not aim at another existing poll-only agent (e.g., `leo-cc2`).** Architecturally dishonest — Leo is technical-ops, not the CEO steward. Would create a second drift.

**Follow-up (tracked, NOT in this PR):** signal-dispatch v13 — add `'quimby'` to `POLL_ONLY_AGENTS`. This eliminates the DNS-error ride-along and makes the audit stream clean. Whether Quimby stays poll-only long-term or gets an HTTP adapter pointing at his Paperclip URL is a Step 2 decision — deferred to Quimby-setup time per Phil's guidance 2026-04-19 ("put it on the table to review once we set up Quimby").

**Tracking placement (both required at close-out so the TODO lives where it fires, not where it was written):**

1. `vault/60-content/ai-phil/_ROADMAP.md` — under a new "Cross-repo follow-ups" subsection: one row pointing at the signal-dispatch v13 one-liner with the DNS-error threshold (below) and the defer-until-Quimby clause.
2. `vault/_system/cross-repo-followups.md` — create if missing; this becomes the canonical accretion point for "this needs to happen in another repo" items Leo CC2 / Philgood OS agents are expected to scan. First row = signal-dispatch v13. Link back to this spec.
3. Next `vault/_system/leo-cc2-architecture-ping.md` push — add a one-liner under an "Open follow-ups" block so Leo sees it at his next architecture-ping read (the existing ping doc is a message draft for Telegram thread 859).

**DNS-error noise budget (trigger to expedite v13):**

- Baseline expected: ≈ 1 dispatch-log row with `payload.results.quimby` DNS error per member-agent inbound. Current traffic ≈ 20–40 inbounds/day → ≈ 20–40 cosmetic-error rows/day.
- **Expedite if EITHER triggers:** (a) rolling 7-day average of DNS-error dispatch-log rows > 100/day (signals traffic ramp — noise is no longer cosmetic), OR (b) calendar date reaches 2026-05-03 without signal-dispatch v13 landing (14 days from spec — don't let this silently become permanent).
- **Monitoring query** (include in Ops dashboard or run weekly during close-out):
  ```sql
  select date_trunc('day', created_at) as day, count(*) as dns_errors
  from public.agent_signals
  where signal_type = 'dispatch-log'
    and payload->'results'->>'quimby' like '%dns error%'
    and created_at > now() - interval '14 days'
  group by 1 order by 1 desc;
  ```

### Execution order

**Pre-flight check (before any write):**
- Confirm `signal-dispatch` routing is source-code-only (no `signal_routing_config` / `agent_routes` table). Query: `select table_name from information_schema.tables where table_schema in ('public','ops') and table_name ilike any (array['%rout%','%dispatch%']);`. Expected: zero or a dispatch-log/edge-function audit table, no routing config. If a routing table IS found, pause and add a §2.4 sub-step to update it alongside.
- Confirm `ops.agent_registry` is advisory-only (no dispatch routing there). Query: `select column_name from information_schema.columns where table_schema='ops' and table_name='agent_registry';` — look for any `endpoint_url` / `gateway_url` / `dispatch_url` column. Expected: none (only heartbeat / status metadata).

1. 2.1 (migration) — apply first, widens acceptance before any code change lands so intermediate deploys don't break.
2. 2.2 + 2.3 + 2.4 — one commit per concern, deploy both agents once.
3. Verification SMS — Phillip sends one plain SMS. Expected:
   - New row in `ops.ai_inbox_conversation_memory` with `intent ∈ {onboarding,content,event,coaching,support,escalate}` and `stage = 'member'`.
   - SMS reply has exactly one `-Ai Phil` signature.
   - `public.agent_signals` row with `target_agent = 'quimby'`, `signal_type = 'ai-member-reply-sent'` (the audit). Companion `dispatch-log` row may still carry a DNS error in `payload.results.quimby` — expected until signal-dispatch v13 lands the follow-up one-liner.

## Risks

- **Sales-agent regression from widened constraints.** Mitigated: widening never invalidates existing valid tuples, and sales-agent writes `{sales|event|support|unknown} + qualifying` exclusively — all still valid.
- **Claude keeps emitting `-Ai Phil` inside the body.** The regex strip handles it; side-effect-free.
- **Hardcoded richie-cc2 elsewhere.** Grep for `richie-cc2` across `supabase/functions/` + `supabase/migrations/` + `src/` before closing. If other references are found, they may need independent decisions.
- **Signal-dispatch routing table** — moved from risks to the pre-flight check above. Must be answered (not deferred) before any write.

## Testing

- Unit: stripSignature regex cases (4 above).
- Unit: deno test for member-agent `finalIntent ∈ {...}` passes new CHECK (via seeding a test row if the existing harness supports it, otherwise assertion on the regex).
- Integration: single live SMS from Phillip after redeploy. Three observable assertions above.
- Rollback: if verification SMS fails, `git revert` the code changes and redeploy; the migration is widening-only, no need to revert.

## Decisions

- **stage collapses to `'member'`** — single new value, sub-state lives in intent. Per Phillip 2026-04-19.
- **target_agent = `quimby`** — canonical-not-yet-live, per Phillip 2026-04-19.
- **signal-dispatch edit NOT in this PR** — cross-repo scope, belongs in Leo CC2 / Philgood OS territory. Accept cosmetic DNS-error ride-along until signal-dispatch v13 lands the `POLL_ONLY_AGENTS` one-liner. The underlying audit signal lands correctly regardless.
- **Quimby adapter shape (poll-only vs HTTP)** — deferred to Quimby-setup (architecture Step 2) per Phil 2026-04-19 ("put it on the table to review once we set up Quimby").
- **No backfill** — 48h of lost member-agent memory is acceptable; rapport layer reads GHL history directly.

## Out-of-scope (defer to later drift-fix rounds)

- Monitor alert on `ai_inbox_conversation_memory` silence > 24h during business hours.
- Archive/DROP `ops.ghl_convo_triage_decisions` + `ops.ghl_convo_triage_runs` once Richie is fully retired.
- Adding `stage = 'member'` to any downstream analytics / reporting queries.
