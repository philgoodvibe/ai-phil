# F.O.R.M. Extractor Fix — Design Spec

**Date:** 2026-04-21
**Phase:** 0, Task 5
**Status:** Approved design, ready for implementation plan
**Related docs:**
- `vault/60-content/ai-phil/AI-Phil-Voice-Philosophy.md` §10 (Rapport memory)
- `vault/_system/ai-phil-session-kickstart.md` §6 (extractor diagnosis item)
- `vault/60-content/ai-phil/_ROADMAP.md` P4 (RIS pillar)

---

## 1. Context

`ops.contact_rapport` held 3 rows across ~14 days of live traffic at session-start
(2026-04-21). The session-kickstart framed this as a silent extractor failure and
proposed "fix OR replace with inline diary write." Diagnosis against live prod
data (queried via PostgREST with service_role) invalidates the silent-failure
hypothesis and surfaces two different gaps.

### 1.1 Diagnostic findings (2026-04-21 evening)

Sales-agent traffic (`stage='qualifying'`, `role='user'`) since 2026-04-14:
- 6 distinct contact_ids across 51 user turns
- 3 had substantive F.O.R.M. content → all 3 produced rapport rows (4, 5, 7 facts)
- 3 had single-turn trivial content ("hello test", "price?", "I think something is
  wrong") → all 3 correctly produced no rapport rows
- Extraction rate among contacts with F.O.R.M. content: **100%**

The symptom is low-denominator, not a silent failure. The conservative Haiku
prompt is doing its job per voice doc §10 ("Bad rapport data is worse than no
rapport data").

### 1.2 Actual gaps surfaced

**Gap 1 — Coverage (clear bug).** `supabase/functions/ghl-member-agent/index.ts`
has zero rapport references. Member-agent traffic (`stage='member'`,
`role='user'`) in the window = 15 user turns across 4 distinct contacts, with
substantive F.O.R.M. content present (carrier details, stated bottlenecks,
account context). All 4 member contacts produced zero rapport rows. Voice doc
§10 is explicit: "Every AI Phil conversation reads from and writes to
`ops.contact_rapport`." Member-agent is out of compliance.

**Gap 2 — Observability (why this looked like a silent bug).** The extractor
flow (`fetchRapport` → `extractRapport` → `storeRapport`) has three stacked
log-and-swallow paths. The `storeRapport` call is only reached when Haiku
returns ≥1 fact (`ghl-sales-agent/index.ts:889`). If Haiku HTTP-errors, parses
wrong, 401s, or returns empty for any reason, nothing is written to the DB. No
metric, no signal, no audit trail. "Zero rapport rows for 14 days" reads
identical from outside whether the extractor ran 100 times finding nothing, or
ran 100 times failing, or never ran at all. This violates Non-Negotiable #4:
"Memory/knowledge/DB is foundation — no building on silent failures."

The Apr 16–20 member-agent CHECK-constraint silent drop (4 days of lost inserts
masked by a 200 return) is the exact failure class this fix prevents.

---

## 2. Goals and non-goals

### Goals

1. Bring `ghl-member-agent` to voice-doc §10 compliance (Gap 1).
2. Make extractor health observable from the DB without reading source code or
   conversation content (Gap 2).
3. Preserve extractor conservatism — do not widen the Haiku prompt, do not lower
   the dedup threshold, do not invent "interest signal" weak facts.
4. Stay forward-compatible with the Phase 1 memory layer swap to Graphiti per
   `DR-2026-04-19-Graphiti-For-Diaries.md`. Extractor remains the signal
   producer; storage backend can change without reshaping the fix.

### Non-goals

- Hume EVI voice surfaces. Voice transcripts aren't in
  `ai_inbox_conversation_memory` yet; that's a separate data-plane problem.
- The `_shared/salesVoice.ts` prompt composer. Unchanged.
- `ghl-sales-agent` / `ghl-sales-followup` reply generation. Unchanged.
- `ops.contact_rapport` schema, semantics, or existing 3 rows. Unchanged.
- Backfill of past conversations. Out of scope.

---

## 3. Architecture

### 3.1 Surfaces touched

| File | Kind | Lines (approx) |
|---|---|---|
| `supabase/migrations/<ts>_rapport_extractions_audit.sql` | NEW | ~30 |
| `supabase/functions/_shared/rapport.ts` | Modify — add `ExtractResult` union, refactor `extractRapport` return, add `recordExtraction` export | ~60 net |
| `supabase/functions/_shared/rapport.test.ts` | Modify — add 5 new tests | +5 tests |
| `supabase/functions/ghl-sales-agent/index.ts` | Modify Step 9b — adopt new return shape, call `recordExtraction` on every branch | ~15 |
| `supabase/functions/ghl-sales-followup/index.ts` | Modify touch-extraction site — same treatment | ~15 |
| `supabase/functions/ghl-member-agent/index.ts` | Add new post-reply step — full rapport cycle + audit | ~40 |
| Edge-function test files for 3 agents | Add 1–3 new tests per agent | +5 tests total |

**Not touched:** Hume EVI configs, `sync-hume-evi`, `salesVoice.ts`, widget UI,
embed scripts, GHL webhook contract, Supabase RLS policies on existing tables.

### 3.2 Data model

New table `ops.rapport_extractions`:

```sql
CREATE TABLE ops.rapport_extractions (
  id                bigserial PRIMARY KEY,
  contact_id        text NOT NULL,
  conversation_id   text,
  surface           text NOT NULL
    CHECK (surface IN (
      'ghl-sales-agent',
      'ghl-sales-followup',
      'ghl-member-agent'
    )),
  haiku_status      text NOT NULL
    CHECK (haiku_status IN (
      'ok',
      'empty',
      'http_error',
      'parse_error',
      'no_api_key',
      'threw',
      'skipped_no_user_content'
    )),
  facts_added       int NOT NULL DEFAULT 0,
  facts_total_after int NOT NULL DEFAULT 0,
  latency_ms        int,
  error_snippet     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rapport_extractions_contact_idx
  ON ops.rapport_extractions (contact_id, created_at DESC);
CREATE INDEX rapport_extractions_created_idx
  ON ops.rapport_extractions (created_at DESC);

ALTER TABLE ops.rapport_extractions ENABLE ROW LEVEL SECURITY;
-- service_role bypasses RLS automatically; no policies for anon/authenticated.

COMMENT ON TABLE ops.rapport_extractions IS
  'One row per F.O.R.M. extractor invocation across all AI Phil surfaces. '
  'Existence of a row = extractor ran. haiku_status distinguishes '
  '"ran and found nothing" from "never ran" vs "failed".';

COMMENT ON COLUMN ops.rapport_extractions.facts_added IS
  'Number of NEW facts added to ops.contact_rapport on this invocation. '
  'Zero when status=empty/error; matches the delta between pre- and '
  'post-merge pillar sums otherwise.';
COMMENT ON COLUMN ops.rapport_extractions.facts_total_after IS
  'Total fact count on ops.contact_rapport after this invocation. Snapshot '
  'for post-hoc trend analysis without joining to the rapport table.';
COMMENT ON COLUMN ops.rapport_extractions.error_snippet IS
  'First 200 chars of error or raw Haiku response when status != ok/empty. '
  'Never contains API keys, prompt contents, or conversation text.';
```

### 3.3 `ExtractResult` union

In `rapport.ts`, replace the bare `Promise<RapportFacts>` return of
`extractRapport` with a discriminated union:

```ts
export type ExtractStatus =
  | 'ok'
  | 'empty'
  | 'http_error'
  | 'parse_error'
  | 'no_api_key'
  | 'threw'
  | 'skipped_no_user_content';

export type ExtractResult =
  | { status: 'ok';        facts: RapportFacts; latencyMs: number }
  | { status: 'empty';     facts: RapportFacts; latencyMs: number }
  | { status: 'http_error';   error: string; httpStatus: number; latencyMs: number }
  | { status: 'parse_error';  error: string; rawSnippet: string; latencyMs: number }
  | { status: 'no_api_key';   latencyMs: 0 }
  | { status: 'threw';        error: string; latencyMs: number }
  | { status: 'skipped_no_user_content'; latencyMs: 0 };

export async function extractRapport(
  turn: { userMessage: string; assistantReply: string; conversationId?: string },
  existingFacts: RapportFacts,
  anthropicApiKey: string,
): Promise<ExtractResult>;
```

`facts` lives only on `ok` and `empty`. Every other branch gives callers a
status + enough context to record an audit row.

### 3.4 `recordExtraction` export

```ts
export interface ExtractionAuditRow {
  contactId: string;
  conversationId?: string | null;
  surface: 'ghl-sales-agent' | 'ghl-sales-followup' | 'ghl-member-agent';
  status: ExtractStatus;
  factsAdded?: number;        // default 0
  factsTotalAfter?: number;   // default 0
  latencyMs?: number;          // default null
  errorSnippet?: string;        // capped to 200 chars inside helper
}

export async function recordExtraction(
  supabase: SupabaseLike,
  row: ExtractionAuditRow,
): Promise<void>;
```

Implementation: single-row insert into `ops.rapport_extractions`, own try/catch,
caps `errorSnippet` at 200 chars, silently swallows its own DB errors (logged
to `console.error` only).

---

## 4. Data flow

### 4.1 Sales-agent Step 9b (new shape)

```
fetch existing rapport
    → call extractRapport(turn, existing, apiKey)
    → switch on result.status:
         'ok':
             merged = mergeRapportFacts(existing, result.facts)
             storeRapport(merged)
             recordExtraction('ok', factsAdded = sum(result.facts), factsTotalAfter = sum(merged))
         'empty':
             recordExtraction('empty', factsAdded=0, factsTotalAfter = sum(existing))
         'http_error' | 'parse_error' | 'threw':
             recordExtraction(<status>, 0, sum(existing), latencyMs, errorSnippet)
         'no_api_key':
             recordExtraction('no_api_key', 0, sum(existing), 0)
         'skipped_no_user_content':
             (sales-agent never produces this; unreachable but switch is
              exhaustive for typesafety)
all of above wrapped in outer try/catch that logs and swallows so audit
failure cannot 500 the user-facing reply
```

Same shape at the `ghl-sales-followup` touch-extraction site (`surface='ghl-sales-followup'`).

### 4.2 Member-agent new step

Insertion point: after the existing memory-insert write near
`ghl-member-agent/index.ts` ~line 1050–1090 (just before the 200 return).

**Skip-guard.** Before calling Haiku, check:
- `intent === 'escalate'` AND the user message is shorter than 40 chars
- OR the assistant reply is the canned escalation boilerplate

If either, skip the Haiku call and emit
`recordExtraction(status='skipped_no_user_content', latencyMs=0)` so we can
see the skip in audit. This avoids burning Haiku tokens on turns that
structurally can't contain F.O.R.M. content.

Otherwise, identical flow to sales-agent Step 9b with `surface='ghl-member-agent'`.

### 4.3 Existing call-site compatibility

`ghl-sales-agent` and `ghl-sales-followup` currently call
`extractRapport` and check `Object.values(newFacts).some(arr => arr.length > 0)`.
After the return-shape change:
- `result.status === 'ok'` replaces the `.some(arr.length > 0)` check.
- `result.status === 'empty'` is the inverse.
- Error branches are newly visible and require explicit handling rather than
  silently returning the empty shape.

---

## 5. Error handling + security

1. Audit path is strictly additive. A bug in `recordExtraction` never
   surfaces to the user-facing response.
2. `error_snippet` is capped at 200 chars inside `recordExtraction` helper.
   Callers may pass full error strings; the helper truncates before insert.
3. `error_snippet` must never contain API keys, Authorization headers, prompt
   text, or conversation content. Callers pass the result's `.error` or
   `.rawSnippet` fields, not raw upstream responses.
4. Existing security posture is preserved. Injection-gated turns are
   short-circuited before reply in all 3 agents. Short-circuit exits before
   rapport extraction — so `rapport_extractions` will not show gated-injection
   contacts, and Haiku is never called on injection attempts.
5. No change to RLS on `ops.contact_rapport`. No change to SECURITY BOUNDARY
   BLOCK. No change to injection detection.

---

## 6. Testing

### 6.1 Unit (Deno)

| Target | New tests | Description |
|---|---|---|
| `_shared/rapport.ts`, `extractRapport` return shape | 4 | Each union branch via stubbed `fetch`: ok, empty, http_error, parse_error. |
| `_shared/rapport.ts`, `recordExtraction` | 1 | Builds correct row, truncates `errorSnippet` at 200, swallows DB errors. |
| `ghl-sales-agent` Step 9b | 1 | Given each result status, correct `surface` + `haiku_status` on audit row. |
| `ghl-sales-followup` touch site | 1 | Same as above, `surface='ghl-sales-followup'`. |
| `ghl-member-agent` new step | 3 | (a) happy path, (b) skip-guard triggers `skipped_no_user_content`, (c) Haiku `throw` still writes `threw` audit row. |

### 6.2 Migration validation

One test in `rapport.test.ts` reads the migration file and asserts the
`haiku_status` CHECK constraint contains every value in the `ExtractStatus`
type. Prevents the exact class of silent-CHECK-constraint drop that bit
`ghl-member-agent` v1 (Apr 16–20).

### 6.3 End-to-end (manual, post-deploy)

Run after Phillip applies migration + deploys edge functions. Not done in this
session.

1. Send a non-sensitive test SMS to the sales-agent webhook. Expect
   one new row in `ops.rapport_extractions` with `surface='ghl-sales-agent'`,
   `haiku_status ∈ {ok, empty}`, `latency_ms > 0`.
2. Same for a member-agent SMS (active-member test contact). Expect same shape
   with `surface='ghl-member-agent'`.
3. Verify no new rows on injection-gated turns.
4. `SELECT surface, haiku_status, count(*) FROM ops.rapport_extractions GROUP BY 1,2` —
   non-zero across both surfaces.

### 6.4 Acceptance bar

- `deno test supabase/` all green
- `npm run typecheck` clean
- No diff in user-facing reply text or timing envelope
- Migration file lands cleanly in `supabase/migrations/`
- Spec + plan committed, pushed

Deploy-time (post-session):
- Migration applies cleanly, `get_advisors('security')` reports no new ERRORs
- First live inbound on each of the 3 surfaces produces an audit row

---

## 7. Rollout

### 7.1 In-session (this spec)

1. Write migration file
2. Update `rapport.ts` + tests
3. Update 3 edge functions + their tests
4. Local `deno test` + `npm run typecheck` green
5. Git commit (separate commits by logical unit)
6. Push to `origin/main`

### 7.2 Deploy-pending (out of session)

Phillip (or a Supabase-MCP-attached session):
1. Review migration SQL
2. Apply migration
3. `get_advisors('security')` — fix any new ERRORs
4. Deploy `sync-hume-evi`-style: deploy updated versions of
   `ghl-sales-agent`, `ghl-sales-followup`, `ghl-member-agent`. Each deploy
   immediately followed by `get_edge_function` byte-compare against local
   committed source (CLAUDE.md v7→v9 guardrail).
5. Live verification per §6.3.

### 7.3 Rollback plan

- If post-deploy audit table stays empty despite traffic: revert edge-function
  deploys to previous versions. Migration stays in place (table is harmless
  when unused). No data lost because table didn't previously exist.
- If Haiku latency rises measurably on any surface after deploy (unlikely —
  flow is unchanged): revert. Audit recording runs after storeRapport, which
  already existed on sales surfaces.

---

## 8. Open questions

None at spec-approval time. The diagnosis invalidated every open question
from the session-kickstart framing ("fix vs replace", "widen vs preserve
conservatism") because the extractor is working.

---

## 9. Success criteria

- Migration applied, table exists, RLS on, advisors clean
- Three edge functions re-deployed with byte-compared parity
- First inbound on sales-agent produces `haiku_status='ok'` or `'empty'` row
- First inbound on member-agent produces same (voice-doc §10 compliance
  closed)
- `SELECT count(*) FROM ops.rapport_extractions WHERE created_at > now() - interval '24h'`
  shows rows matching expected traffic volume — denominator is finally
  visible
- `ops.contact_rapport` continues to grow at its natural rate (not artificially
  inflated by relaxed conservatism)
