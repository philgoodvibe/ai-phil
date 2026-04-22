# F.O.R.M. Extractor Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close voice-doc §10's "every AI Phil conversation" gap on `ghl-member-agent` and make the F.O.R.M. extractor observable from the DB via a new `ops.rapport_extractions` audit table.

**Architecture:** New audit table + discriminated-union return from `extractRapport` + a `recordExtraction` helper, wired into all 3 agent surfaces. No change to extractor conservatism, reply generation, or existing rapport semantics.

**Tech Stack:** Supabase (Postgres + edge functions, Deno runtime), TypeScript, Anthropic Haiku 4.5 for extraction.

**Spec:** `docs/superpowers/specs/2026-04-21-form-extractor-fix-design.md`

---

## File Structure

Files created or modified in this plan:

| Path | Responsibility | Task |
|---|---|---|
| `supabase/migrations/20260423000000_rapport_extractions_audit.sql` | New audit table with RLS, CHECK constraints, indexes, column COMMENTs | 1 |
| `supabase/functions/_shared/rapport.ts` | Add `ExtractResult` union + refactor `extractRapport` return + add `recordExtraction` | 2, 3 |
| `supabase/functions/_shared/rapport.test.ts` | New tests for each union branch, `recordExtraction`, migration validation | 2, 3, 7 |
| `supabase/functions/ghl-sales-agent/index.ts` | Step 9b adopts new return shape + audit | 4 |
| `supabase/functions/ghl-sales-agent/index.test.ts` | Stubbed Step 9b integration test | 4 |
| `supabase/functions/ghl-sales-followup/index.ts` | Touch-extraction site adopts new return shape + audit | 5 |
| `supabase/functions/ghl-sales-followup/index.test.ts` | Stubbed touch integration test | 5 |
| `supabase/functions/ghl-member-agent/index.ts` | New rapport step with skip-guard | 6 |
| `supabase/functions/ghl-member-agent/index.test.ts` | 3 stubbed tests | 6 |

Commit cadence: one commit per task (file boundary), matching recent history.

---

## Task 1: Migration for `ops.rapport_extractions`

**Files:**
- Create: `supabase/migrations/20260423000000_rapport_extractions_audit.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 20260423000000_rapport_extractions_audit.sql
-- F.O.R.M. extractor audit log. One row per extractRapport invocation across
-- ghl-sales-agent, ghl-sales-followup, ghl-member-agent. Distinguishes
-- "extractor ran and found nothing" from "never ran" vs "failed" — the gap
-- that made zero-rapport-rows look like a silent bug pre-2026-04-21.
-- See docs/superpowers/specs/2026-04-21-form-extractor-fix-design.md §3.2.

CREATE TABLE IF NOT EXISTS ops.rapport_extractions (
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

CREATE INDEX IF NOT EXISTS rapport_extractions_contact_time_idx
  ON ops.rapport_extractions (contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS rapport_extractions_created_idx
  ON ops.rapport_extractions (created_at DESC);

ALTER TABLE ops.rapport_extractions ENABLE ROW LEVEL SECURITY;
-- No policies => anon + authenticated have zero access.
-- service_role bypasses RLS automatically.

COMMENT ON TABLE ops.rapport_extractions IS
  'One row per F.O.R.M. extractor invocation across all AI Phil surfaces. Existence of a row = extractor ran. haiku_status distinguishes "ran and found nothing" from "never ran" vs "failed". See docs/superpowers/specs/2026-04-21-form-extractor-fix-design.md.';

COMMENT ON COLUMN ops.rapport_extractions.facts_added IS
  'Number of NEW facts added to ops.contact_rapport on this invocation. Zero when status=empty/error; matches the delta between pre- and post-merge pillar sums otherwise.';

COMMENT ON COLUMN ops.rapport_extractions.facts_total_after IS
  'Total fact count on ops.contact_rapport after this invocation. Snapshot for post-hoc trend analysis without joining to the rapport table.';

COMMENT ON COLUMN ops.rapport_extractions.error_snippet IS
  'First 200 chars of error or raw Haiku response when status != ok/empty. Never contains API keys, prompt contents, or conversation text.';
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260423000000_rapport_extractions_audit.sql
git commit -m "feat(migration): ops.rapport_extractions audit table

Closes observability gap — distinguishes extractor ran-empty vs never-ran
vs failed. RLS on, service-role-only, CHECK constraints on surface +
haiku_status enforce the ExtractResult union shape. COMMENT ON COLUMN
docstrings document the disambiguation rule.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Refactor `extractRapport` to `ExtractResult` union

**Files:**
- Modify: `supabase/functions/_shared/rapport.ts` (lines 247–385 area — the `extractRapport` section)
- Modify: `supabase/functions/_shared/rapport.test.ts`

- [ ] **Step 1: Write the failing tests (append to `rapport.test.ts`)**

Append at end of file (before any closing content):

```ts
// ---------------------------------------------------------------------------
// extractRapport return-shape tests (ExtractResult union)
// ---------------------------------------------------------------------------
import { extractRapport } from './rapport.ts';

// Shared: stub global fetch per test, restore after.
function withFetchStub(impl: (req: Request) => Promise<Response>, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    return impl(req);
  }) as typeof fetch;
  return fn().finally(() => { globalThis.fetch = original; });
}

Deno.test('extractRapport: ok branch — Haiku returns 1 fact', async () => {
  await withFetchStub(
    (_req) => Promise.resolve(new Response(JSON.stringify({
      content: [{ text: JSON.stringify({
        family: [{ key: 'dog_name', value: 'Lucy', source_conv: 'c1', extracted_at: '2026-04-21T00:00:00Z' }],
        occupation: [], recreation: [], money: [],
      }) }],
    }), { status: 200 })),
    async () => {
      const result = await extractRapport(
        { userMessage: 'my dog Lucy', assistantReply: 'nice', conversationId: 'c1' },
        { family: [], occupation: [], recreation: [], money: [] },
        'test-key',
      );
      assertEquals(result.status, 'ok');
      if (result.status === 'ok') {
        assertEquals(result.facts.family.length, 1);
        assert(result.latencyMs >= 0);
      }
    },
  );
});

Deno.test('extractRapport: empty branch — Haiku returns all-empty pillars', async () => {
  await withFetchStub(
    (_req) => Promise.resolve(new Response(JSON.stringify({
      content: [{ text: JSON.stringify({ family: [], occupation: [], recreation: [], money: [] }) }],
    }), { status: 200 })),
    async () => {
      const result = await extractRapport(
        { userMessage: 'k', assistantReply: 'got it', conversationId: 'c1' },
        { family: [], occupation: [], recreation: [], money: [] },
        'test-key',
      );
      assertEquals(result.status, 'empty');
    },
  );
});

Deno.test('extractRapport: http_error branch — 500 from Haiku', async () => {
  await withFetchStub(
    (_req) => Promise.resolve(new Response('upstream error', { status: 500 })),
    async () => {
      const result = await extractRapport(
        { userMessage: 'x', assistantReply: 'y', conversationId: 'c1' },
        { family: [], occupation: [], recreation: [], money: [] },
        'test-key',
      );
      assertEquals(result.status, 'http_error');
      if (result.status === 'http_error') {
        assertEquals(result.httpStatus, 500);
        assert(result.error.length > 0);
      }
    },
  );
});

Deno.test('extractRapport: parse_error branch — Haiku returns malformed JSON', async () => {
  await withFetchStub(
    (_req) => Promise.resolve(new Response(JSON.stringify({
      content: [{ text: 'not json {' }],
    }), { status: 200 })),
    async () => {
      const result = await extractRapport(
        { userMessage: 'x', assistantReply: 'y', conversationId: 'c1' },
        { family: [], occupation: [], recreation: [], money: [] },
        'test-key',
      );
      assertEquals(result.status, 'parse_error');
      if (result.status === 'parse_error') {
        assert(result.rawSnippet.length > 0);
      }
    },
  );
});

Deno.test('extractRapport: no_api_key branch — empty key short-circuits', async () => {
  const result = await extractRapport(
    { userMessage: 'x', assistantReply: 'y', conversationId: 'c1' },
    { family: [], occupation: [], recreation: [], money: [] },
    '',
  );
  assertEquals(result.status, 'no_api_key');
  assertEquals(result.latencyMs, 0);
});
```

Also add `assert` to the imports at top of file:

```ts
import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd supabase/functions/_shared
deno test rapport.test.ts --allow-net --allow-env 2>&1 | tail -20
```

Expected: failures on the 5 new tests — all because `extractRapport` currently returns `Promise<RapportFacts>`, not `Promise<ExtractResult>`, so `result.status` is undefined.

- [ ] **Step 3: Refactor `extractRapport` to return `ExtractResult`**

In `supabase/functions/_shared/rapport.ts`, between the `Types` section (around line 85) and the `formatRapportBlock` section, insert the new `ExtractStatus` + `ExtractResult` types:

```ts
// ---------------------------------------------------------------------------
// ExtractResult — discriminated union returned by extractRapport
// ---------------------------------------------------------------------------

export type ExtractStatus =
  | 'ok'
  | 'empty'
  | 'http_error'
  | 'parse_error'
  | 'no_api_key'
  | 'threw'
  | 'skipped_no_user_content';

export type ExtractResult =
  | { status: 'ok'; facts: RapportFacts; latencyMs: number }
  | { status: 'empty'; facts: RapportFacts; latencyMs: number }
  | { status: 'http_error'; error: string; httpStatus: number; latencyMs: number }
  | { status: 'parse_error'; error: string; rawSnippet: string; latencyMs: number }
  | { status: 'no_api_key'; latencyMs: 0 }
  | { status: 'threw'; error: string; latencyMs: number }
  | { status: 'skipped_no_user_content'; latencyMs: 0 };
```

Then replace the `extractRapport` function body (currently lines 287–365 area) with the following. Keep `HAIKU_MODEL`, `ANTHROPIC_ENDPOINT`, `EXTRACT_SYSTEM_PROMPT`, `summarizeExistingFacts`, `stripCodeFences` exactly as they are above/below.

```ts
export async function extractRapport(
  conversationTurn: {
    userMessage: string;
    assistantReply: string;
    conversationId?: string;
  },
  existingFacts: RapportFacts,
  anthropicApiKey: string,
): Promise<ExtractResult> {
  if (!anthropicApiKey) {
    console.error('[rapport] extractRapport called without anthropicApiKey');
    return { status: 'no_api_key', latencyMs: 0 };
  }

  const convId = conversationTurn.conversationId ?? 'unknown';
  const nowIso = new Date().toISOString();

  const existingSummary = summarizeExistingFacts(existingFacts);

  const userMessage = `CONVERSATION TURN

PROSPECT said:
${conversationTurn.userMessage}

AI replied:
${conversationTurn.assistantReply}

CONTEXT
- conv_id for source_conv field: ${convId}
- extracted_at to use in every fact: ${nowIso}

EXISTING_FACTS (do NOT re-record anything that matches one of these):
${existingSummary}

Return ONLY the JSON object. No prose. No code fences.`;

  const startedAt = Date.now();
  try {
    const res = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 500,
        system: EXTRACT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`[rapport] Haiku extract ${res.status}:`, body);
      return { status: 'http_error', error: body, httpStatus: res.status, latencyMs };
    }

    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = data.content?.[0]?.text?.trim();
    if (!text) {
      console.error('[rapport] Haiku extract returned empty content');
      return {
        status: 'parse_error',
        error: 'empty content block',
        rawSnippet: JSON.stringify(data).slice(0, 200),
        latencyMs,
      };
    }

    const cleaned = stripCodeFences(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[rapport] Haiku extract produced malformed JSON:', msg, cleaned.slice(0, 200));
      return {
        status: 'parse_error',
        error: msg,
        rawSnippet: cleaned.slice(0, 200),
        latencyMs,
      };
    }

    const facts = normalizeRapportShape(parsed);
    const hasAny =
      facts.family.length > 0 ||
      facts.occupation.length > 0 ||
      facts.recreation.length > 0 ||
      facts.money.length > 0;

    return hasAny
      ? { status: 'ok', facts, latencyMs }
      : { status: 'empty', facts, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[rapport] Haiku extract threw:', msg);
    return { status: 'threw', error: msg, latencyMs };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd supabase/functions/_shared
deno test rapport.test.ts --allow-net --allow-env 2>&1 | tail -20
```

Expected: all existing tests + 5 new tests pass.

- [ ] **Step 5: Run typecheck to confirm no compile errors**

From repo root:

```bash
npx deno check supabase/functions/_shared/rapport.ts
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/rapport.ts supabase/functions/_shared/rapport.test.ts
git commit -m "refactor(rapport): extractRapport returns ExtractResult union

Discriminated union replaces bare Promise<RapportFacts>. Callers can now
distinguish ok / empty / http_error / parse_error / no_api_key / threw
branches — the raw material for per-invocation audit rows.

Conservatism prompt unchanged. Happy path behavior identical.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `recordExtraction` helper

**Files:**
- Modify: `supabase/functions/_shared/rapport.ts`
- Modify: `supabase/functions/_shared/rapport.test.ts`

- [ ] **Step 1: Write the failing tests (append to `rapport.test.ts`)**

```ts
// ---------------------------------------------------------------------------
// recordExtraction tests
// ---------------------------------------------------------------------------
import { recordExtraction } from './rapport.ts';

Deno.test('recordExtraction: builds correct row shape', async () => {
  const inserts: unknown[] = [];
  const stub = {
    schema: (_: string) => ({
      from: (_t: string) => ({
        insert: (row: unknown) => {
          inserts.push(row);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };
  await recordExtraction(stub, {
    contactId: 'c1',
    conversationId: 'conv1',
    surface: 'ghl-sales-agent',
    status: 'ok',
    factsAdded: 2,
    factsTotalAfter: 5,
    latencyMs: 123,
  });
  assertEquals(inserts.length, 1);
  const row = inserts[0] as Record<string, unknown>;
  assertEquals(row.contact_id, 'c1');
  assertEquals(row.conversation_id, 'conv1');
  assertEquals(row.surface, 'ghl-sales-agent');
  assertEquals(row.haiku_status, 'ok');
  assertEquals(row.facts_added, 2);
  assertEquals(row.facts_total_after, 5);
  assertEquals(row.latency_ms, 123);
});

Deno.test('recordExtraction: caps errorSnippet at 200 chars', async () => {
  const inserts: unknown[] = [];
  const stub = {
    schema: (_: string) => ({
      from: (_t: string) => ({
        insert: (row: unknown) => { inserts.push(row); return Promise.resolve({ error: null }); },
      }),
    }),
  };
  const longErr = 'x'.repeat(500);
  await recordExtraction(stub, {
    contactId: 'c1', surface: 'ghl-sales-agent', status: 'threw',
    errorSnippet: longErr,
  });
  const row = inserts[0] as Record<string, unknown>;
  assertEquals((row.error_snippet as string).length, 200);
});

Deno.test('recordExtraction: swallows DB errors (non-fatal)', async () => {
  const stub = {
    schema: (_: string) => ({
      from: (_t: string) => ({
        insert: (_: unknown) => Promise.resolve({ error: { message: 'fake db err' } }),
      }),
    }),
  };
  // Must not throw.
  await recordExtraction(stub, {
    contactId: 'c1', surface: 'ghl-sales-agent', status: 'empty',
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd supabase/functions/_shared
deno test rapport.test.ts --allow-net --allow-env 2>&1 | tail -15
```

Expected: 3 failures on `recordExtraction is not defined`.

- [ ] **Step 3: Implement `recordExtraction` (append to end of `rapport.ts`)**

```ts
// ---------------------------------------------------------------------------
// recordExtraction — one audit row per extractor invocation
// ---------------------------------------------------------------------------

export interface ExtractionAuditRow {
  contactId: string;
  conversationId?: string | null;
  surface: 'ghl-sales-agent' | 'ghl-sales-followup' | 'ghl-member-agent';
  status: ExtractStatus;
  factsAdded?: number;
  factsTotalAfter?: number;
  latencyMs?: number;
  errorSnippet?: string;
}

const SNIPPET_CAP = 200;

/**
 * Insert one row into ops.rapport_extractions. Strictly additive: own
 * try/catch, own DB-error swallow. A bug in this helper must never surface
 * to the user-facing reply. errorSnippet is truncated to 200 chars.
 */
export async function recordExtraction(
  supabase: SupabaseLike,
  row: ExtractionAuditRow,
): Promise<void> {
  try {
    const { error } = await supabase
      .schema('ops')
      .from('rapport_extractions')
      .insert({
        contact_id: row.contactId,
        conversation_id: row.conversationId ?? null,
        surface: row.surface,
        haiku_status: row.status,
        facts_added: row.factsAdded ?? 0,
        facts_total_after: row.factsTotalAfter ?? 0,
        latency_ms: row.latencyMs ?? null,
        error_snippet: row.errorSnippet
          ? row.errorSnippet.slice(0, SNIPPET_CAP)
          : null,
      });
    if (error) {
      console.error('[rapport] audit insert error:', (error as { message?: string }).message ?? error);
    }
  } catch (err) {
    console.error('[rapport] audit insert threw:', err);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd supabase/functions/_shared
deno test rapport.test.ts --allow-net --allow-env 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/rapport.ts supabase/functions/_shared/rapport.test.ts
git commit -m "feat(rapport): recordExtraction helper writes audit rows

Single-row insert into ops.rapport_extractions. Own try/catch, own DB-error
swallow. errorSnippet capped at 200 chars. Caller-agnostic — each agent
surface passes its own surface identifier and ExtractResult status.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire `ghl-sales-agent` Step 9b to new shape + audit

**Files:**
- Modify: `supabase/functions/ghl-sales-agent/index.ts` lines 881–895 (Step 9b)
- Modify: `supabase/functions/ghl-sales-agent/index.test.ts`

- [ ] **Step 1: Update import in `ghl-sales-agent/index.ts`**

Change the import line (around line 11):

```ts
import { fetchRapport, extractRapport, storeRapport, mergeRapportFacts, recordExtraction } from '../_shared/rapport.ts';
```

- [ ] **Step 2: Replace Step 9b block**

In `ghl-sales-agent/index.ts`, the existing Step 9b (starts around line 881 with `// Step 9b: Post-conversation F.O.R.M. extraction`) currently ends around line 895. Replace entire block with:

```ts
    // Step 9b: Post-conversation F.O.R.M. extraction (non-fatal) + audit
    try {
      const currentRapport = await fetchRapport(supabase, contactId);
      const result = await extractRapport(
        { userMessage: messageBody, assistantReply: replyText, conversationId: conversationId ?? undefined },
        currentRapport,
        Deno.env.get('ANTHROPIC_API_KEY') ?? '',
      );

      const existingTotal =
        currentRapport.family.length +
        currentRapport.occupation.length +
        currentRapport.recreation.length +
        currentRapport.money.length;

      switch (result.status) {
        case 'ok': {
          const merged = mergeRapportFacts(currentRapport, result.facts);
          await storeRapport(supabase, contactId, merged);
          const addedTotal =
            result.facts.family.length +
            result.facts.occupation.length +
            result.facts.recreation.length +
            result.facts.money.length;
          const mergedTotal =
            merged.family.length +
            merged.occupation.length +
            merged.recreation.length +
            merged.money.length;
          await recordExtraction(supabase, {
            contactId,
            conversationId: conversationId ?? null,
            surface: 'ghl-sales-agent',
            status: 'ok',
            factsAdded: addedTotal,
            factsTotalAfter: mergedTotal,
            latencyMs: result.latencyMs,
          });
          break;
        }
        case 'empty':
          await recordExtraction(supabase, {
            contactId, conversationId: conversationId ?? null,
            surface: 'ghl-sales-agent', status: 'empty',
            factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
          });
          break;
        case 'http_error':
          await recordExtraction(supabase, {
            contactId, conversationId: conversationId ?? null,
            surface: 'ghl-sales-agent', status: 'http_error',
            factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
            errorSnippet: `HTTP ${result.httpStatus}: ${result.error}`,
          });
          break;
        case 'parse_error':
          await recordExtraction(supabase, {
            contactId, conversationId: conversationId ?? null,
            surface: 'ghl-sales-agent', status: 'parse_error',
            factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
            errorSnippet: result.error,
          });
          break;
        case 'no_api_key':
          await recordExtraction(supabase, {
            contactId, conversationId: conversationId ?? null,
            surface: 'ghl-sales-agent', status: 'no_api_key',
            factsTotalAfter: existingTotal, latencyMs: 0,
          });
          break;
        case 'threw':
          await recordExtraction(supabase, {
            contactId, conversationId: conversationId ?? null,
            surface: 'ghl-sales-agent', status: 'threw',
            factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
            errorSnippet: result.error,
          });
          break;
        case 'skipped_no_user_content':
          // Sales-agent never emits this status; included for switch
          // exhaustiveness. If the union widens elsewhere, TS flags this.
          break;
      }
    } catch (err) {
      console.error('[rapport] extract/audit threw (non-fatal):', err);
    }
```

- [ ] **Step 3: Add integration test (append to `ghl-sales-agent/index.test.ts`)**

Because the Step 9b logic is inline in the big handler, pull out a tiny pure helper for exhaustiveness that can be tested. Append this function to `ghl-sales-agent/index.ts`, above the existing exported helpers:

```ts
/**
 * Pure helper that maps an ExtractResult to the audit row args the handler
 * passes to recordExtraction. Extracted for unit testing the switch logic
 * without spinning up the handler.
 */
export function auditArgsFromResult(
  contactId: string,
  conversationId: string | null,
  surface: 'ghl-sales-agent',
  existingTotal: number,
  result: import('../_shared/rapport.ts').ExtractResult,
  mergedTotalWhenOk?: number,
  factsAddedWhenOk?: number,
): {
  contactId: string;
  conversationId: string | null;
  surface: 'ghl-sales-agent';
  status: import('../_shared/rapport.ts').ExtractStatus;
  factsAdded: number;
  factsTotalAfter: number;
  latencyMs: number;
  errorSnippet?: string;
} {
  switch (result.status) {
    case 'ok':
      return {
        contactId, conversationId, surface, status: 'ok',
        factsAdded: factsAddedWhenOk ?? 0,
        factsTotalAfter: mergedTotalWhenOk ?? existingTotal,
        latencyMs: result.latencyMs,
      };
    case 'empty':
      return {
        contactId, conversationId, surface, status: 'empty',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
      };
    case 'http_error':
      return {
        contactId, conversationId, surface, status: 'http_error',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
        errorSnippet: `HTTP ${result.httpStatus}: ${result.error}`,
      };
    case 'parse_error':
      return {
        contactId, conversationId, surface, status: 'parse_error',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
        errorSnippet: result.error,
      };
    case 'no_api_key':
      return {
        contactId, conversationId, surface, status: 'no_api_key',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: 0,
      };
    case 'threw':
      return {
        contactId, conversationId, surface, status: 'threw',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
        errorSnippet: result.error,
      };
    case 'skipped_no_user_content':
      return {
        contactId, conversationId, surface, status: 'skipped_no_user_content',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: 0,
      };
  }
}
```

Then update the inline Step 9b (from Step 2) to use this helper (DRY): replace the 7-case switch with a single `auditArgsFromResult(...)` call feeding `recordExtraction`. Keep `storeRapport` call in the `ok` branch. Final Step 9b body:

```ts
    // Step 9b: Post-conversation F.O.R.M. extraction (non-fatal) + audit
    try {
      const currentRapport = await fetchRapport(supabase, contactId);
      const result = await extractRapport(
        { userMessage: messageBody, assistantReply: replyText, conversationId: conversationId ?? undefined },
        currentRapport,
        Deno.env.get('ANTHROPIC_API_KEY') ?? '',
      );
      const existingTotal =
        currentRapport.family.length + currentRapport.occupation.length +
        currentRapport.recreation.length + currentRapport.money.length;

      let mergedTotalWhenOk: number | undefined;
      let factsAddedWhenOk: number | undefined;
      if (result.status === 'ok') {
        const merged = mergeRapportFacts(currentRapport, result.facts);
        await storeRapport(supabase, contactId, merged);
        mergedTotalWhenOk = merged.family.length + merged.occupation.length +
          merged.recreation.length + merged.money.length;
        factsAddedWhenOk = result.facts.family.length + result.facts.occupation.length +
          result.facts.recreation.length + result.facts.money.length;
      }

      await recordExtraction(
        supabase,
        auditArgsFromResult(
          contactId, conversationId ?? null, 'ghl-sales-agent',
          existingTotal, result, mergedTotalWhenOk, factsAddedWhenOk,
        ),
      );
    } catch (err) {
      console.error('[rapport] extract/audit threw (non-fatal):', err);
    }
```

Now add the test:

```ts
import { auditArgsFromResult } from './index.ts';

Deno.test('auditArgsFromResult: ok → factsAdded + factsTotalAfter reflect merge', () => {
  const args = auditArgsFromResult(
    'c1', 'conv1', 'ghl-sales-agent', 4,
    { status: 'ok', facts: { family: [], occupation: [], recreation: [], money: [] }, latencyMs: 100 },
    6, 2,
  );
  assertEquals(args.status, 'ok');
  assertEquals(args.factsAdded, 2);
  assertEquals(args.factsTotalAfter, 6);
  assertEquals(args.latencyMs, 100);
});

Deno.test('auditArgsFromResult: empty → factsAdded=0, factsTotalAfter=existing', () => {
  const args = auditArgsFromResult(
    'c1', 'conv1', 'ghl-sales-agent', 4,
    { status: 'empty', facts: { family: [], occupation: [], recreation: [], money: [] }, latencyMs: 50 },
  );
  assertEquals(args.status, 'empty');
  assertEquals(args.factsAdded, 0);
  assertEquals(args.factsTotalAfter, 4);
});

Deno.test('auditArgsFromResult: http_error → errorSnippet embeds status code', () => {
  const args = auditArgsFromResult(
    'c1', null, 'ghl-sales-agent', 3,
    { status: 'http_error', error: 'upstream-bad', httpStatus: 503, latencyMs: 42 },
  );
  assertEquals(args.status, 'http_error');
  assertEquals(args.factsTotalAfter, 3);
  assert(args.errorSnippet && args.errorSnippet.includes('HTTP 503'));
});
```

- [ ] **Step 4: Run tests**

```bash
cd supabase/functions/ghl-sales-agent
deno test index.test.ts --allow-net --allow-env 2>&1 | tail -20
```

Expected: all existing tests + 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ghl-sales-agent/index.ts supabase/functions/ghl-sales-agent/index.test.ts
git commit -m "feat(sales-agent): Step 9b records rapport audit rows

Adopts ExtractResult union; every branch writes one row to
ops.rapport_extractions via recordExtraction. Extracted auditArgsFromResult
for DRY across surfaces (also consumed by sales-followup + member-agent
in next tasks). No behavior change to reply generation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire `ghl-sales-followup` touch-extraction site

**Files:**
- Modify: `supabase/functions/ghl-sales-followup/index.ts` (touch-extract site around lines 487–505)
- Modify: `supabase/functions/ghl-sales-followup/index.test.ts`

- [ ] **Step 1: Read the current touch-extract site for context**

Run:
```bash
sed -n '480,510p' supabase/functions/ghl-sales-followup/index.ts
```

- [ ] **Step 2: Update import**

In `ghl-sales-followup/index.ts`, update the multi-line rapport import (lines 8–12) to include `recordExtraction` and the types:

```ts
import {
  fetchRapport,
  extractRapport,
  storeRapport,
  mergeRapportFacts,
  recordExtraction,
  type ExtractResult,
  type ExtractStatus,
} from '../_shared/rapport.ts';
```

- [ ] **Step 3: Define a local `auditArgsFromResult` helper in followup (DRY alternative: import from a new shared module; follow sales-agent's local-helper pattern for symmetry)**

Append near other helpers in `index.ts`:

```ts
export function followupAuditArgsFromResult(
  contactId: string,
  conversationId: string | null,
  existingTotal: number,
  result: ExtractResult,
  mergedTotalWhenOk?: number,
  factsAddedWhenOk?: number,
): {
  contactId: string;
  conversationId: string | null;
  surface: 'ghl-sales-followup';
  status: ExtractStatus;
  factsAdded: number;
  factsTotalAfter: number;
  latencyMs: number;
  errorSnippet?: string;
} {
  const surface = 'ghl-sales-followup' as const;
  switch (result.status) {
    case 'ok':
      return { contactId, conversationId, surface, status: 'ok',
        factsAdded: factsAddedWhenOk ?? 0,
        factsTotalAfter: mergedTotalWhenOk ?? existingTotal,
        latencyMs: result.latencyMs };
    case 'empty':
      return { contactId, conversationId, surface, status: 'empty',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs };
    case 'http_error':
      return { contactId, conversationId, surface, status: 'http_error',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
        errorSnippet: `HTTP ${result.httpStatus}: ${result.error}` };
    case 'parse_error':
      return { contactId, conversationId, surface, status: 'parse_error',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
        errorSnippet: result.error };
    case 'no_api_key':
      return { contactId, conversationId, surface, status: 'no_api_key',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: 0 };
    case 'threw':
      return { contactId, conversationId, surface, status: 'threw',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
        errorSnippet: result.error };
    case 'skipped_no_user_content':
      return { contactId, conversationId, surface, status: 'skipped_no_user_content',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: 0 };
  }
}
```

- [ ] **Step 4: Replace the touch-extract block**

The existing block is at lines 487–505, inside a `try/catch`. Replace the full `try/catch` with:

```ts
  // Step i: Extract rapport + audit (non-fatal). Outbound touch has no user
  // turn — extractor handles empty userMessage.
  try {
    const currentRapport = await fetchRapport(supabase, row.contact_id);
    const result = await extractRapport(
      { userMessage: '', assistantReply: replyText, conversationId: row.conversation_id },
      currentRapport,
      Deno.env.get('ANTHROPIC_API_KEY') ?? '',
    );
    const existingTotal =
      currentRapport.family.length + currentRapport.occupation.length +
      currentRapport.recreation.length + currentRapport.money.length;

    let mergedTotalWhenOk: number | undefined;
    let factsAddedWhenOk: number | undefined;
    if (result.status === 'ok') {
      const merged = mergeRapportFacts(currentRapport, result.facts);
      await storeRapport(supabase, row.contact_id, merged);
      mergedTotalWhenOk = merged.family.length + merged.occupation.length +
        merged.recreation.length + merged.money.length;
      factsAddedWhenOk = result.facts.family.length + result.facts.occupation.length +
        result.facts.recreation.length + result.facts.money.length;
    }

    await recordExtraction(
      supabase,
      followupAuditArgsFromResult(
        row.contact_id, row.conversation_id ?? null,
        existingTotal, result, mergedTotalWhenOk, factsAddedWhenOk,
      ),
    );
  } catch (err) {
    console.error('[rapport] followup extract/audit threw (non-fatal):', err);
  }
```

- [ ] **Step 5: Add test to `ghl-sales-followup/index.test.ts`**

```ts
import { followupAuditArgsFromResult } from './index.ts';

Deno.test('followupAuditArgsFromResult: surface is always ghl-sales-followup', () => {
  const args = followupAuditArgsFromResult(
    'c1', 'conv1', 3,
    { status: 'empty', facts: { family: [], occupation: [], recreation: [], money: [] }, latencyMs: 77 },
  );
  assertEquals(args.surface, 'ghl-sales-followup');
  assertEquals(args.status, 'empty');
  assertEquals(args.factsTotalAfter, 3);
  assertEquals(args.latencyMs, 77);
});

Deno.test('followupAuditArgsFromResult: threw branch captures errorSnippet', () => {
  const args = followupAuditArgsFromResult(
    'c1', null, 0,
    { status: 'threw', error: 'boom', latencyMs: 12 },
  );
  assertEquals(args.status, 'threw');
  assertEquals(args.errorSnippet, 'boom');
});
```

- [ ] **Step 6: Run tests**

```bash
cd supabase/functions/ghl-sales-followup
deno test index.test.ts --allow-net --allow-env 2>&1 | tail -15
```

Expected: pre-existing + 2 new tests pass.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/ghl-sales-followup/index.ts supabase/functions/ghl-sales-followup/index.test.ts
git commit -m "feat(sales-followup): record rapport audit on touch extraction

Parallel to sales-agent Step 9b. followupAuditArgsFromResult mirrors the
sales-agent helper; surface pinned to 'ghl-sales-followup'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Add rapport step to `ghl-member-agent`

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts` (new step after memory insert around line 1038, before Step 12)
- Modify: `supabase/functions/ghl-member-agent/index.test.ts`

- [ ] **Step 1: Add import**

At top of `ghl-member-agent/index.ts`, add near other imports:

```ts
import {
  fetchRapport,
  extractRapport,
  storeRapport,
  mergeRapportFacts,
  recordExtraction,
  type ExtractResult,
  type ExtractStatus,
} from '../_shared/rapport.ts';
```

- [ ] **Step 2: Add pure helpers (near other exported helpers)**

```ts
const CANNED_ESCALATION_MARKERS = [
  'a human teammate will get back to you shortly',
  "i'm flagging this to the team",
];

export function isCannedEscalationReply(reply: string): boolean {
  const lower = reply.toLowerCase();
  return CANNED_ESCALATION_MARKERS.some((m) => lower.includes(m));
}

/**
 * Decide whether to skip the Haiku extractor for this turn. Short escalation
 * messages and the canned-boilerplate reply carry no F.O.R.M. content;
 * running the extractor just burns tokens. When skipped, caller still logs
 * one audit row with status='skipped_no_user_content' so the skip is
 * externally visible.
 */
export function shouldSkipExtractor(
  intent: string,
  userMessage: string,
  assistantReply: string,
): boolean {
  if (intent === 'escalate' && userMessage.length < 40) return true;
  if (isCannedEscalationReply(assistantReply)) return true;
  return false;
}

export function memberAuditArgsFromResult(
  contactId: string,
  conversationId: string | null,
  existingTotal: number,
  result: ExtractResult,
  mergedTotalWhenOk?: number,
  factsAddedWhenOk?: number,
): {
  contactId: string;
  conversationId: string | null;
  surface: 'ghl-member-agent';
  status: ExtractStatus;
  factsAdded: number;
  factsTotalAfter: number;
  latencyMs: number;
  errorSnippet?: string;
} {
  const surface = 'ghl-member-agent' as const;
  switch (result.status) {
    case 'ok':
      return { contactId, conversationId, surface, status: 'ok',
        factsAdded: factsAddedWhenOk ?? 0,
        factsTotalAfter: mergedTotalWhenOk ?? existingTotal,
        latencyMs: result.latencyMs };
    case 'empty':
      return { contactId, conversationId, surface, status: 'empty',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs };
    case 'http_error':
      return { contactId, conversationId, surface, status: 'http_error',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
        errorSnippet: `HTTP ${result.httpStatus}: ${result.error}` };
    case 'parse_error':
      return { contactId, conversationId, surface, status: 'parse_error',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
        errorSnippet: result.error };
    case 'no_api_key':
      return { contactId, conversationId, surface, status: 'no_api_key',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: 0 };
    case 'threw':
      return { contactId, conversationId, surface, status: 'threw',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
        errorSnippet: result.error };
    case 'skipped_no_user_content':
      return { contactId, conversationId, surface, status: 'skipped_no_user_content',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: 0 };
  }
}
```

- [ ] **Step 3: Insert Step 11b (rapport) between existing Step 11 (memory insert) and Step 12 (escalation actions)**

Find the block that ends with the `[memory] insert threw` catch around line 1038, then the `// Step 12: Escalation actions` comment. Insert between:

```ts
    // Step 11b: Post-conversation F.O.R.M. extraction + audit (non-fatal)
    try {
      if (shouldSkipExtractor(finalIntent, messageBody, replyText)) {
        await recordExtraction(supabase, {
          contactId, conversationId: conversationId ?? null,
          surface: 'ghl-member-agent', status: 'skipped_no_user_content',
          factsTotalAfter: 0, latencyMs: 0,
        });
      } else {
        const currentRapport = await fetchRapport(supabase, contactId);
        const result = await extractRapport(
          { userMessage: messageBody, assistantReply: replyText, conversationId: conversationId ?? undefined },
          currentRapport,
          Deno.env.get('ANTHROPIC_API_KEY') ?? '',
        );
        const existingTotal =
          currentRapport.family.length + currentRapport.occupation.length +
          currentRapport.recreation.length + currentRapport.money.length;

        let mergedTotalWhenOk: number | undefined;
        let factsAddedWhenOk: number | undefined;
        if (result.status === 'ok') {
          const merged = mergeRapportFacts(currentRapport, result.facts);
          await storeRapport(supabase, contactId, merged);
          mergedTotalWhenOk = merged.family.length + merged.occupation.length +
            merged.recreation.length + merged.money.length;
          factsAddedWhenOk = result.facts.family.length + result.facts.occupation.length +
            result.facts.recreation.length + result.facts.money.length;
        }

        await recordExtraction(
          supabase,
          memberAuditArgsFromResult(
            contactId, conversationId ?? null,
            existingTotal, result, mergedTotalWhenOk, factsAddedWhenOk,
          ),
        );
      }
    } catch (err) {
      console.error('[rapport] member extract/audit threw (non-fatal):', err);
    }

```

- [ ] **Step 4: Add tests (append to `ghl-member-agent/index.test.ts`)**

```ts
import { shouldSkipExtractor, memberAuditArgsFromResult, isCannedEscalationReply } from './index.ts';

Deno.test('shouldSkipExtractor: short escalate message skips', () => {
  assertEquals(shouldSkipExtractor('escalate', 'please help', 'some reply'), true);
});

Deno.test('shouldSkipExtractor: long escalate message does NOT skip', () => {
  const long = 'x'.repeat(60);
  assertEquals(shouldSkipExtractor('escalate', long, 'some reply'), false);
});

Deno.test('shouldSkipExtractor: canned escalation reply skips regardless of intent', () => {
  assertEquals(
    shouldSkipExtractor('support', 'some question',
      'Hi Penny, thanks for the message. A human teammate will get back to you shortly.'),
    true,
  );
});

Deno.test('isCannedEscalationReply: case-insensitive match', () => {
  assertEquals(isCannedEscalationReply('A HUMAN TEAMMATE WILL GET BACK TO YOU SHORTLY'), true);
  assertEquals(isCannedEscalationReply('here is the answer'), false);
});

Deno.test('memberAuditArgsFromResult: skipped_no_user_content branch', () => {
  const args = memberAuditArgsFromResult(
    'c1', 'conv1', 2,
    { status: 'skipped_no_user_content', latencyMs: 0 },
  );
  assertEquals(args.surface, 'ghl-member-agent');
  assertEquals(args.status, 'skipped_no_user_content');
  assertEquals(args.latencyMs, 0);
});

Deno.test('memberAuditArgsFromResult: ok branch uses merged totals', () => {
  const args = memberAuditArgsFromResult(
    'c1', null, 4,
    { status: 'ok', facts: { family: [], occupation: [], recreation: [], money: [] }, latencyMs: 220 },
    7, 3,
  );
  assertEquals(args.factsAdded, 3);
  assertEquals(args.factsTotalAfter, 7);
});
```

Also add `assert, assertEquals` imports at top if not already present:

```ts
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
```

- [ ] **Step 5: Run tests**

```bash
cd supabase/functions/ghl-member-agent
deno test index.test.ts --allow-net --allow-env 2>&1 | tail -15
```

Expected: pre-existing + 6 new tests pass. (Note: CLAUDE.md warns one pre-existing test at line 129 has a regex/substring mismatch unrelated to this work — if it still fails, leave it, flag in close-out.)

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/ghl-member-agent/index.ts supabase/functions/ghl-member-agent/index.test.ts
git commit -m "feat(member-agent): rapport extraction closes voice-doc §10 gap

Step 11b runs fetchRapport → extractRapport → storeRapport + recordExtraction
on every non-gated turn. Skip-guard avoids burning Haiku on short-escalate
turns or canned-boilerplate replies, but still logs an audit row so the
skip is externally visible. Member-agent is now voice-doc §10 compliant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Migration-CHECK-vs-TypeScript-union drift test

**Files:**
- Modify: `supabase/functions/_shared/rapport.test.ts`

Goal: prevent a future PR that widens `ExtractStatus` (TS) without widening the SQL CHECK constraint — the exact silent-CHECK-drop class of bug (member-agent Apr 16–20).

- [ ] **Step 1: Add the test**

Append to `rapport.test.ts`:

```ts
Deno.test('migration CHECK covers every ExtractStatus value', async () => {
  const sqlPath = new URL('../../migrations/20260423000000_rapport_extractions_audit.sql', import.meta.url);
  const sql = await Deno.readTextFile(sqlPath);
  // Every value we expect to see allowed by the CHECK constraint:
  const expected: ExtractStatus[] = [
    'ok', 'empty', 'http_error', 'parse_error',
    'no_api_key', 'threw', 'skipped_no_user_content',
  ];
  for (const v of expected) {
    assert(
      sql.includes(`'${v}'`),
      `migration CHECK missing '${v}' — update the SQL or drop the TS status`,
    );
  }
});
```

Also import the type at top of file:

```ts
import { type ExtractStatus } from './rapport.ts';
```

- [ ] **Step 2: Run**

```bash
cd supabase/functions/_shared
deno test rapport.test.ts --allow-net --allow-env --allow-read 2>&1 | tail -10
```

Expected: pass (because Task 1 migration and Task 2 union are in sync).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/rapport.test.ts
git commit -m "test(rapport): migration CHECK parity with ExtractStatus union

Reads the migration file, asserts every TS union value is present in the
haiku_status CHECK constraint. Prevents the silent-CHECK-drop pattern
that bit ghl-member-agent v1 (Apr 16–20, 4 days of lost inserts).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Final typecheck + full test sweep

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 2: Full Deno test sweep**

```bash
deno test supabase/ --allow-net --allow-env --allow-read 2>&1 | tail -25
```

Expected: all tests pass. If pre-existing failures unrelated to this work appear (CLAUDE.md flagged `ghl-member-agent` test:129 and the `ghl-sales-agent` env-var test as pre-existing), note them in the close-out summary but do not block on them.

- [ ] **Step 3: Git status sanity check**

```bash
git status
git log origin/main..HEAD --oneline
```

Expected: clean working tree, 7 new commits (one per task).

---

## Post-plan: deploy-pending note

This plan ends with commits pushed locally only. Migration + edge-function deploy happens out-of-session (Supabase MCP not attached; no PAT). Session summary must:

1. List the 7 commits with their SHAs
2. Include the exact MCP + CLI commands Phillip can run to deploy
3. Leave a "Pick up here" block naming the verification SQL for post-deploy: `SELECT surface, haiku_status, count(*) FROM ops.rapport_extractions WHERE created_at > now() - interval '1h' GROUP BY 1,2;` after the first live inbound on each surface.
