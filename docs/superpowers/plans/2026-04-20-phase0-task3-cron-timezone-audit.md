# Phase 0 Task 3 — pg_cron Timezone Fix + Self-Enforcing Audit (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the drifted `ghl-sales-followup-hourly` pg_cron schedule (pg_cron runs in UTC; job was authored as-if-Pacific) and ship `ops.cron_schedule_audit` so the same failure class is auto-caught at every future close-out.

**Architecture:** Single migration creates `ops.cron_job_intent` sidecar + `ops.cron_schedule_audit` view, reschedules the job from `0 9-17 * * 1-5` to `0 * * * 1-5`, and seeds intent rows for both ai-phil-owned jobnames. A new `businessHours.ts` helper inside the edge function gates the handler on `Intl.DateTimeFormat('America/Los_Angeles')` — DST-agnostic. Rows owned by Philgood OS stay untouched and surface as ERROR in the audit view, driving a 3-location cross-repo follow-up per Task 2 convention.

**Tech Stack:** Deno (edge function), TypeScript, PostgreSQL/pg_cron, Supabase MCP (`apply_migration`, `deploy_edge_function`, `execute_sql`), `Intl.DateTimeFormat`.

**Design spec:** `docs/superpowers/specs/2026-04-20-phase0-task3-cron-timezone-audit-design.md`

---

## File Structure

**Create:**
- `supabase/migrations/20260420000001_cron_intent_audit_and_followup_reschedule.sql` — table + view + reschedule + seed
- `supabase/functions/ghl-sales-followup/businessHours.ts` — pure helper
- `supabase/functions/ghl-sales-followup/businessHours.test.ts` — 9 Deno tests
- `vault/50-meetings/2026-04-20-phase0-task3-cron-timezone-audit.md` — session summary

**Modify:**
- `supabase/functions/ghl-sales-followup/index.ts` — import `isWithinBusinessHours`, gate handler after auth check (line 580) before queue query (line 582)
- `CLAUDE.md` — close-out §3 gets one SQL check line; mistakes table gets one new row
- `vault/60-content/ai-phil/_ROADMAP.md` — Phase 0 Task 3 Shipped row + Cross-repo follow-up addition
- `vault/_system/cross-repo-followups.md` — canonical accretion of the Philgood OS cron follow-up
- `vault/_system/leo-cc2-architecture-ping.md` — next-ping payload appended

**Untouched (explicit non-goals):** any other edge function, Philgood OS cron rows, sales-followup queue-drain logic.

---

## Task 1: Write `businessHours.ts` + failing tests (TDD)

**Files:**
- Create: `supabase/functions/ghl-sales-followup/businessHours.ts`
- Create: `supabase/functions/ghl-sales-followup/businessHours.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// supabase/functions/ghl-sales-followup/businessHours.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isWithinBusinessHours } from './businessHours.ts';

// Apr 20 2026 is a Monday; PDT is active (UTC-7).
// Nov 2 2026 is a Monday; PST is active (UTC-8) — fall-back was Sun Nov 1.

Deno.test('PDT: Mon 10:30 local is within window', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-20T17:30:00Z')), true);
});

Deno.test('PDT: Mon 08:59 local is before window', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-20T15:59:00Z')), false);
});

Deno.test('PDT: Mon 09:00 local is the first in-window tick', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-20T16:00:00Z')), true);
});

Deno.test('PDT: Mon 17:59 local is still in window (hour 17 is inclusive)', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-21T00:59:00Z')), true);
});

Deno.test('PDT: Mon 18:00 local is past window', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-21T01:00:00Z')), false);
});

Deno.test('PDT: Sat 10:30 local is a weekend → false', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-25T17:30:00Z')), false);
});

Deno.test('PDT: Sun 21:00 local is a weekend → false', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-20T04:00:00Z')), false);
});

Deno.test('PST fall-back: Mon 09:00 local is the first in-window tick', () => {
  // 2026-11-02 17:00 UTC = 09:00 PST (Mon)
  assertEquals(isWithinBusinessHours(new Date('2026-11-02T17:00:00Z')), true);
});

Deno.test('PST fall-back: Mon 08:00 local is before window', () => {
  // 2026-11-02 16:00 UTC = 08:00 PST (Mon) — the SAME UTC moment was 09:00 PDT the prior Monday
  assertEquals(isWithinBusinessHours(new Date('2026-11-02T16:00:00Z')), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "supabase/functions/ghl-sales-followup"
deno test --allow-env --allow-net businessHours.test.ts
```

Expected: all 9 tests FAIL with `Module not found "./businessHours.ts"` or similar.

- [ ] **Step 3: Write minimal implementation**

```typescript
// supabase/functions/ghl-sales-followup/businessHours.ts

/**
 * Pure, DST-aware business-hours gate for the ghl-sales-followup edge function.
 *
 * Pattern comes from Phase 0 Task 3 (2026-04-20): pg_cron on Supabase fires
 * in UTC only. Rather than author a cron schedule in UTC and drift every DST
 * boundary, we fire every hour Mon-Fri UTC and check the current Pacific
 * local hour here. Intl.DateTimeFormat handles DST automatically.
 *
 * Business window: 09:00 - 17:59 America/Los_Angeles, Mon-Fri.
 */

const FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour: 'numeric',
  hour12: false,
  weekday: 'short',
});

const BUSINESS_DAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
const START_HOUR = 9;
const END_HOUR = 17;

export function isWithinBusinessHours(now: Date = new Date()): boolean {
  const parts = FORMATTER.formatToParts(now);
  const hourStr = parts.find((p) => p.type === 'hour')?.value;
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  if (!hourStr || !weekday) return false;
  const hour = Number(hourStr);
  if (!Number.isFinite(hour)) return false;
  return BUSINESS_DAYS.has(weekday) && hour >= START_HOUR && hour <= END_HOUR;
}
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
deno test --allow-env --allow-net businessHours.test.ts
```

Expected: 9 passed, 0 failed. If any test fails, debug — do NOT modify the test assertions to match implementation.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ghl-sales-followup/businessHours.ts \
        supabase/functions/ghl-sales-followup/businessHours.test.ts
git commit -m "$(cat <<'EOF'
feat(ghl-sales-followup): add isWithinBusinessHours helper + 9 unit tests

Pure, DST-aware gate for Phase 0 Task 3 cron timezone fix. Intl
DateTimeFormat with timeZone America/Los_Angeles handles both PDT
and PST automatically; helper has no external deps. Tests cover
mid-PDT boundaries, PST fall-back boundary, and weekend exclusion.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire `isWithinBusinessHours` into the handler

**Files:**
- Modify: `supabase/functions/ghl-sales-followup/index.ts` (imports block near line 15; handler body after auth check, before queue query at line 582)

- [ ] **Step 1: Add import**

After the existing `import { computeNextSendAt, classifyTouch } from './cadence.ts';` line (around line 15), add:

```typescript
import { isWithinBusinessHours } from './businessHours.ts';
```

- [ ] **Step 2: Add the gate after auth, before queue query**

Between the auth-401 return block (ends around line 579) and the "Query due rows." comment (around line 581), insert:

```typescript
  // Business-hours gate (Phase 0 Task 3, 2026-04-20).
  // Cron fires every hour Mon-Fri UTC (schedule `0 * * * 1-5`); the
  // helper gates on America/Los_Angeles local time, which is DST-aware.
  // Outside the window: log + return 200 gated; no queue read, no send.
  if (!isWithinBusinessHours()) {
    await writeAgentSignal({
      source_agent: 'ghl-sales-followup',
      target_agent: 'quimby',
      signal_type: 'ai-followup-gated',
      status: 'delivered',
      channel: 'open',
      priority: 3,
      payload: { gated: 'outside-business-hours' },
    });
    return new Response(
      JSON.stringify({ ok: true, gated: 'outside-business-hours' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
```

- [ ] **Step 3: Typecheck by running existing Deno tests (no regressions expected)**

```bash
cd "supabase/functions/ghl-sales-followup"
deno test --allow-env --allow-net
```

Expected: `cadence.test.ts` + `businessHours.test.ts` all green. Any type error from the edit surfaces here.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/ghl-sales-followup/index.ts
git commit -m "$(cat <<'EOF'
feat(ghl-sales-followup): gate handler on business hours before queue drain

Handler now calls isWithinBusinessHours() after auth and before the
queue query. Outside the PT business window (9a-5p Mon-Fri), returns
200 { ok: true, gated: 'outside-business-hours' } and writes a
low-priority ai-followup-gated audit row. No queue read, no Sonnet
call, no GHL send. Pairs with the cron reschedule in the next
migration (0 9-17 UTC → 0 * UTC Mon-Fri, app-layer DST gate).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Write the migration (`ops.cron_job_intent` + audit view + reschedule + seed)

**Files:**
- Create: `supabase/migrations/20260420000001_cron_intent_audit_and_followup_reschedule.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 20260420000001_cron_intent_audit_and_followup_reschedule.sql
--
-- Phase 0 Task 3 — pg_cron timezone fix + self-enforcing audit.
--
-- 1. Creates ops.cron_job_intent (sidecar declaring owner/purpose/local-window/DST-strategy)
-- 2. Creates ops.cron_schedule_audit view (ERROR/WARN/OK drift detector)
-- 3. Reschedules ghl-sales-followup-hourly from '0 9-17 * * 1-5' (authored-as-Pacific, fires
--    UTC 09-17 = 2a-10a PDT / 1a-9a PST) to '0 * * * 1-5' (every hour Mon-Fri UTC).
--    The ghl-sales-followup edge function now gates on Pacific local time in TypeScript via
--    isWithinBusinessHours() — DST-agnostic.
-- 4. Seeds ops.cron_job_intent for both ai-phil-owned jobnames (sync-ai-phil-docs +
--    ghl-sales-followup-hourly). Philgood-OS-owned rows intentionally NOT seeded — they
--    surface as ERROR intent_missing in the audit view, which is the cross-repo follow-up
--    signal per CLAUDE.md's 3-location drop convention.
--
-- Design spec: docs/superpowers/specs/2026-04-20-phase0-task3-cron-timezone-audit-design.md

-- ---------------------------------------------------------------------------
-- 1. Sidecar table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.cron_job_intent (
  jobname         TEXT PRIMARY KEY,
  owner_repo      TEXT NOT NULL CHECK (owner_repo IN ('ai-phil', 'philgood-os', 'shared')),
  purpose         TEXT NOT NULL,
  local_tz        TEXT,
  local_window    TEXT NOT NULL,
  dst_strategy    TEXT NOT NULL CHECK (dst_strategy IN ('app-layer', 'interval', 'fixed-utc', 'none-required')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ops.cron_job_intent ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (which bypasses RLS) can read/write.

COMMENT ON TABLE ops.cron_job_intent IS
  'Sidecar to cron.job declaring the intent behind each scheduled job. Every row in cron.job SHOULD have a matching row here; absence is flagged as ERROR by ops.cron_schedule_audit. dst_strategy is explicit: app-layer means the function gates on local time; interval means every-N-minutes so timezone is irrelevant; fixed-utc means a deliberate UTC moment; none-required means purely interval-based with no local-hour intent.';

-- ---------------------------------------------------------------------------
-- 2. Audit view
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW ops.cron_schedule_audit AS
WITH job_with_intent AS (
  SELECT
    j.jobid,
    j.jobname,
    j.schedule,
    j.command,
    j.active,
    i.owner_repo,
    i.local_window,
    i.dst_strategy,
    i.purpose,
    (i.jobname IS NULL) AS intent_missing,
    (j.command ~ '(eyJ[A-Za-z0-9_-]+\.|sk_live_|sk_test_|sb_secret_)') AS secret_in_command,
    (j.schedule ~ '^[0-9,*/-]+ [0-9]+(-[0-9]+)? [0-9,*/-]+ [0-9,*/-]+ [0-9,*/-]+$') AS hour_bounded_schedule
  FROM cron.job j
  LEFT JOIN ops.cron_job_intent i ON i.jobname = j.jobname
)
SELECT
  jobid, jobname, schedule, active, owner_repo, local_window, dst_strategy, purpose,
  CASE
    WHEN intent_missing                                                             THEN 'ERROR'
    WHEN secret_in_command                                                          THEN 'ERROR'
    WHEN hour_bounded_schedule AND dst_strategy IS DISTINCT FROM 'app-layer'        THEN 'WARN'
    ELSE 'OK'
  END AS severity,
  CASE
    WHEN intent_missing                                                             THEN 'intent_missing'
    WHEN secret_in_command                                                          THEN 'secret_in_command'
    WHEN hour_bounded_schedule AND dst_strategy IS DISTINCT FROM 'app-layer'        THEN 'hour_bounded_without_app_layer_dst'
    ELSE 'ok'
  END AS audit_code
FROM job_with_intent
ORDER BY
  CASE
    WHEN intent_missing OR secret_in_command                                        THEN 0
    WHEN hour_bounded_schedule AND dst_strategy IS DISTINCT FROM 'app-layer'        THEN 1
    ELSE 2
  END,
  jobname;

COMMENT ON VIEW ops.cron_schedule_audit IS
  'Self-enforcing cron drift detector. Severity ERROR = must fix (intent_missing OR secret_in_command). Severity WARN = hour-bounded schedule without app-layer DST handling (likely authored in local time). Run at every session close-out alongside get_advisors(''security'').';

-- ---------------------------------------------------------------------------
-- 3. Reschedule ghl-sales-followup-hourly (UTC → app-layer DST gate)
-- ---------------------------------------------------------------------------
SELECT cron.unschedule('ghl-sales-followup-hourly');

SELECT cron.schedule(
  'ghl-sales-followup-hourly',
  '0 * * * 1-5',
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

-- ---------------------------------------------------------------------------
-- 4. Seed intent for ai-phil-owned jobnames
-- ---------------------------------------------------------------------------
INSERT INTO ops.cron_job_intent (jobname, owner_repo, purpose, local_tz, local_window, dst_strategy, notes) VALUES
(
  'sync-ai-phil-docs',
  'ai-phil',
  'Every 30 min: trigger sync-knowledge-base edge function to pull Drive doc changes into kb_documents.',
  NULL,
  'every 30m',
  'none-required',
  'Auth via vault.decrypted_secrets.supabase_anon_key. Interval-based, no local-hour intent.'
),
(
  'ghl-sales-followup-hourly',
  'ai-phil',
  'Every hour Mon-Fri UTC: trigger ghl-sales-followup to drain ops.ai_inbox_followup_queue. Edge function gates on Pacific business hours (9a-5p PT) via isWithinBusinessHours().',
  'America/Los_Angeles',
  '9a-5p Mon-Fri PT',
  'app-layer',
  'Cron fires hourly Mon-Fri UTC regardless of local time; business-hours gate lives in supabase/functions/ghl-sales-followup/businessHours.ts. DST-agnostic. Outside-window invocations return 200 { gated: outside-business-hours } + an ai-followup-gated audit signal.'
)
ON CONFLICT (jobname) DO UPDATE SET
  owner_repo   = EXCLUDED.owner_repo,
  purpose      = EXCLUDED.purpose,
  local_tz     = EXCLUDED.local_tz,
  local_window = EXCLUDED.local_window,
  dst_strategy = EXCLUDED.dst_strategy,
  notes        = EXCLUDED.notes,
  updated_at   = now();
```

- [ ] **Step 2: Commit the migration**

```bash
git add supabase/migrations/20260420000001_cron_intent_audit_and_followup_reschedule.sql
git commit -m "$(cat <<'EOF'
feat(migration): ops.cron_job_intent + audit view + followup reschedule

Phase 0 Task 3 migration. Creates the sidecar intent table and the
ops.cron_schedule_audit view (ERROR/WARN/OK drift detector),
reschedules ghl-sales-followup-hourly from '0 9-17 * * 1-5' (which
fired 2a-10a PDT / 1a-9a PST — exactly backward) to '0 * * * 1-5'
(every hour Mon-Fri UTC) paired with the in-function
isWithinBusinessHours() DST gate, and seeds intent for the two
ai-phil-owned jobnames. Philgood-OS-owned rows stay unseeded on
purpose — they flag as ERROR intent_missing in the audit view,
driving the 3-location cross-repo follow-up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Apply the migration to prod Supabase + verify via SQL

**Tool:** Supabase MCP `apply_migration` + `execute_sql`.

- [ ] **Step 1: Apply the migration**

Use the MCP `apply_migration` tool with:
- `name`: `cron_intent_audit_and_followup_reschedule`
- `query`: the full SQL body from Task 3 (exclude the leading comment lines if needed)

Expected: no error. Supabase records the migration in its migrations table.

- [ ] **Step 2: Verify the reschedule took effect**

Run via `execute_sql`:
```sql
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'ghl-sales-followup-hourly';
```

Expected: exactly one row, `schedule = '0 * * * 1-5'`, `active = true`.

- [ ] **Step 3: Verify intent seed**

```sql
SELECT jobname, owner_repo, dst_strategy
FROM ops.cron_job_intent
ORDER BY jobname;
```

Expected: two rows — `ghl-sales-followup-hourly` (app-layer) and `sync-ai-phil-docs` (none-required).

- [ ] **Step 4: Verify the audit view flags the expected drift (ai-phil clean, Philgood OS noisy)**

```sql
SELECT severity, audit_code, count(*)
FROM ops.cron_schedule_audit
GROUP BY 1, 2
ORDER BY 1, 2;
```

Expected rows include:
- `ERROR | intent_missing | 6` (the 6 Philgood-OS-owned rows)
- `ERROR | secret_in_command | 0` — wait: severity precedence puts `intent_missing` first. Re-query with the drilled-down form:

```sql
SELECT jobname, severity, audit_code
FROM ops.cron_schedule_audit
ORDER BY severity, jobname;
```

Expected: all 6 Philgood-OS-owned jobnames → ERROR intent_missing; both ai-phil-owned jobnames → OK.

To confirm the secret-in-command detection fires when `intent_missing` doesn't hide it, run:

```sql
SELECT jobname, (command ~ '(eyJ[A-Za-z0-9_-]+\.|sk_live_|sk_test_|sb_secret_)') AS secret_detected
FROM cron.job
ORDER BY jobid;
```

Expected: `email-rules-cache-sync`, `people-sync-n2s`, `people-sync-s2n`, `email-rules-s2n` all → `true`; all others → `false`.

- [ ] **Step 5: Run security advisors (mandatory after schema migration)**

MCP `get_advisors('security')`. Zero new ERRORs expected (the new table has RLS enabled with no policies — correct for service-role-only access).

---

## Task 5: Deploy `ghl-sales-followup` v4 + verify deployed-vs-local parity

**Tool:** Supabase MCP `deploy_edge_function` + `get_edge_function`.

- [ ] **Step 1: Deploy the updated function**

Use `deploy_edge_function` with:
- `name`: `ghl-sales-followup`
- `files`: three entries (paths exactly as shown — Supabase MCP's bundler will prefix `source/`)
  - `{ name: 'index.ts', content: <full current contents of supabase/functions/ghl-sales-followup/index.ts> }`
  - `{ name: 'cadence.ts', content: <full current contents> }`
  - `{ name: 'businessHours.ts', content: <full current contents> }`
- `entrypoint_path`: `index.ts`
- `import_map_path`: omit (the function uses inline JSR imports)

Note: this function has no `../_shared/*.ts` imports, so the bundler gotcha from CLAUDE.md ("multi-file edge function deploys with _shared/ imports") does not apply. This is a single-directory bundle.

Expected: successful deploy; new version number recorded (v4 if current deployed is v3).

- [ ] **Step 2: Verify deployed source matches local source**

Use `get_edge_function` with `function_slug = 'ghl-sales-followup'`. Compare the returned `files` entries to the three local files byte-for-byte. If they differ, the commit is stale — re-deploy before proceeding.

Expected: deployed `index.ts` contains `import { isWithinBusinessHours } from './businessHours.ts';` at the top; contains the gate block after the auth check; `businessHours.ts` is present in the bundle.

---

## Task 6: Live smoke tests

**Tool:** `curl` or `fetch` against the deployed URL. Requires the `supabase_anon_key` Bearer token (available via `supabase.vault.decrypted_secrets` from a `service_role`-authenticated SQL shell).

- [ ] **Step 1: Fetch the anon key out of vault for the smoke tests**

Via MCP `execute_sql`:
```sql
SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_anon_key';
```

Store the result as `$ANON_KEY` for the two curls below.

- [ ] **Step 2: Smoke test the "inside business hours" path**

If the current Pacific local time is within 9a-5p Mon-Fri, run:

```bash
curl -X POST https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-sales-followup \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"trigger":"smoke"}' \
  -sS | tee /tmp/followup-inside.json
```

Expected: HTTP 200 with body shape `{"ok":true,"processed":<n>,"errors":<n>,"total_due":<n>}` (queue is usually empty, so typical response is `{"ok":true,"processed":0,"errors":0,"total_due":0}`).

If current local time is outside 9a-5p Mon-Fri, skip this step and note in the session summary that the inside-window test was deferred. The audit-signal row from the cron will serve as liveness evidence.

- [ ] **Step 3: Smoke test the "outside business hours" path**

Force a gated response regardless of current local time by setting the system clock is not available against prod. Instead, since we can't time-travel the deployed function, verify via the cron trail: after at least one natural UTC-hour cron tick fires **outside** the PT 9-17 window (e.g., a 06:00 UTC tick = 23:00 PDT prior day / 22:00 PST prior day), run:

```sql
SELECT created_at, signal_type, payload
FROM public.agent_signals
WHERE target_agent = 'quimby'
  AND signal_type = 'ai-followup-gated'
ORDER BY created_at DESC
LIMIT 5;
```

Expected: at least one row whose `payload->>'gated' = 'outside-business-hours'`.

If no such row has landed yet (e.g., the migration just applied during business hours and it's still inside the window), defer this verification to the next close-out and note in the session summary.

- [ ] **Step 4: Note evidence in the session summary** (deferred to Task 8 — just capture outputs now)

Save the `/tmp/followup-inside.json` contents + the SELECT result as strings for reference.

---

## Task 7: Update `CLAUDE.md` (close-out §3 + mistakes table row)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add audit-view check to close-out §3**

In `CLAUDE.md`, locate the section `### 3. Security (mandatory if schema touched, strongly recommended otherwise)`. After the existing `get_advisors('security')` bullet, add:

```markdown
- `SELECT * FROM ops.cron_schedule_audit WHERE severity = 'ERROR';` via Supabase MCP. Zero rows required for any ai-phil-owned jobname. Philgood-OS-owned rows will show ERROR until their matching intent records are filed from their home repo — note the row count in the session summary; do not edit Philgood OS cron rows from ai-phil.
```

- [ ] **Step 2: Add one row to "Mistakes-we've-already-made guardrails" table**

Append this row at the end of that table:

```markdown
| pg_cron schedule authored in local time without app-layer DST gate (Apr 17, fixed Apr 20) | `ghl-sales-followup-hourly` shipped as `0 9-17 * * 1-5` expecting Pacific business hours but pg_cron runs UTC, so the job fired 2a-10a PDT / 1a-9a PST Mon-Fri. Fix pattern: cron fires every hour Mon-Fri UTC (`0 * * * 1-5`), edge function calls `isWithinBusinessHours()` using `Intl.DateTimeFormat` with `timeZone: 'America/Los_Angeles'`. Seed `ops.cron_job_intent` with `dst_strategy = 'app-layer'`. The `ops.cron_schedule_audit` view catches any future hour-bounded schedule that isn't paired with app-layer DST. Added to close-out §3. |
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(CLAUDE): cron-schedule audit check in close-out + Phase 0 Task 3 guardrail

Adds 'SELECT * FROM ops.cron_schedule_audit WHERE severity=ERROR'
to session close-out §3 Security alongside get_advisors('security').
Adds one new row to the mistakes-we've-already-made guardrails
table documenting the pg_cron-authored-as-Pacific failure that
ghl-sales-followup-hourly shipped with on Apr 17 and the
app-layer-DST-gate pattern that Task 3 ships today.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: File cross-repo follow-ups in 3 vault locations

**Files:**
- Modify: `vault/60-content/ai-phil/_ROADMAP.md` (Cross-repo follow-ups section)
- Modify: `vault/_system/cross-repo-followups.md` (canonical accretion)
- Modify: `vault/_system/leo-cc2-architecture-ping.md` (next-ping payload)

Note: the vault is on a Shared Drive, not inside this repo. Edits to those three files do not go through `git` in this repo.

- [ ] **Step 1: Append to `_ROADMAP.md` Cross-repo follow-ups**

In `vault/60-content/ai-phil/_ROADMAP.md` inside the `## Cross-repo follow-ups` section, add a new bullet:

```markdown
- **Philgood OS cron — 4 secret rotations + 6 intent declarations** (Leo CC2 / Philgood OS) — shipped from ai-phil Phase 0 Task 3 (2026-04-20): four `cron.job` rows currently hardcode plaintext JWT or `sb_secret_…` values in `cron.command` (`email-rules-cache-sync`, `people-sync-n2s`, `people-sync-s2n`, `email-rules-s2n`); all six Philgood-OS-owned `cron.job` rows lack entries in the new `ops.cron_job_intent` sidecar, so they flag as ERROR intent_missing at every ai-phil session close-out until filed from Philgood OS. Migration pattern to copy: `supabase/migrations/20260417000004_ghl_sales_followup_cron.sql` (vault.decrypted_secrets lookup). **Expedite triggers:** (a) `SELECT count(*) FROM ops.cron_schedule_audit WHERE severity='ERROR' AND audit_code='secret_in_command'` > 0 for > 30 days, (b) any compliance/security review of the Supabase project, or (c) calendar reaches 2026-05-20. Monitoring SQL + context in the design spec §7 and in `_system/cross-repo-followups.md`.
```

- [ ] **Step 2: Append to `_system/cross-repo-followups.md`**

Read the file, find the end of the latest "filed 2026-04-XX" section, and append the same payload in the file's conventional format (typically: date, source, target, task, expedite, monitoring SQL). Copy the shape of the immediately preceding entry (the `signal-dispatch v13` follow-up filed 2026-04-20). The body should be the expanded form of the roadmap bullet above.

- [ ] **Step 3: Append to `_system/leo-cc2-architecture-ping.md`**

Read the file and append a new section under the most recent "open items" heading with a short summary of the two sub-tasks (4 secret rotations + 6 intent rows) and a pointer to the ai-phil spec path.

- [ ] **Step 4: Do NOT `git add` these** — they're in the vault Shared Drive, not the repo.

---

## Task 9: Update `_ROADMAP.md` Shipped + write session summary

**Files:**
- Modify: `vault/60-content/ai-phil/_ROADMAP.md` (move Phase 0 Task 3 to Shipped section)
- Create: `vault/50-meetings/2026-04-20-phase0-task3-cron-timezone-audit.md`

- [ ] **Step 1: Add Phase 0 Task 3 Shipped row to `_ROADMAP.md`**

At the top of the `## Shipped ✅` table, insert:

```markdown
| 2026-04-20 | **Phase 0 Task 3 — pg_cron timezone fix + self-enforcing audit** | `ghl-sales-followup-hourly` rescheduled from `0 9-17 * * 1-5` (fired 2a-10a PDT / 1a-9a PST) to `0 * * * 1-5` paired with `isWithinBusinessHours()` in `ghl-sales-followup/businessHours.ts` (9 unit tests; PDT + PST fall-back boundary covered). `ops.cron_job_intent` + `ops.cron_schedule_audit` shipped as the self-enforcing drift detector: 2 ai-phil-owned jobs seeded and clean; 6 Philgood-OS-owned rows flag ERROR intent_missing + 4 flag ERROR secret_in_command as the cross-repo follow-up driver. CLAUDE.md close-out §3 now runs the audit view alongside `get_advisors('security')`. Deployed: `ghl-sales-followup` v4. `get_advisors('security')` clean. Session summary: `vault/50-meetings/2026-04-20-phase0-task3-cron-timezone-audit.md`. Spec + plan: `docs/superpowers/{specs,plans}/2026-04-20-phase0-task3-*.md` in ai-phil repo. |
```

- [ ] **Step 2: Write the session summary**

Create `vault/50-meetings/2026-04-20-phase0-task3-cron-timezone-audit.md` using the Task 2 session summary as a template. Required sections:

```markdown
# 🔧 Phase 0 Task 3 — pg_cron timezone fix + self-enforcing audit shipped (2026-04-20)

## Pick up here

**Live state:**
- `cron.job` row `ghl-sales-followup-hourly` schedule is now `0 * * * 1-5` (every hour Mon-Fri UTC).
- `ghl-sales-followup` v4 deployed to prod Supabase; `isWithinBusinessHours()` gate enforces 9a-5p PT business window via Intl.DateTimeFormat (DST-agnostic).
- `ops.cron_job_intent` seeded with the 2 ai-phil-owned jobnames; 6 Philgood-OS-owned rows flag ERROR intent_missing in `ops.cron_schedule_audit` (intentional — drives cross-repo follow-up).
- CLAUDE.md close-out §3 now includes `SELECT * FROM ops.cron_schedule_audit WHERE severity = 'ERROR'`.

**Live verification:**
- [paste smoke-test evidence captured in Task 6]

**Pending human action (carry-forward from Task 1 + 2, still open):**
- [ ] Hume EVI manual push of `SECURITY_BOUNDARY_BLOCK` to 3 configs.
- [ ] Live GHL-webhook injection-gate smoke test.

**Cross-repo follow-up filed (NOT this PR):**
- [ ] Philgood OS — migrate 4 cron rows off plaintext secrets + seed 6 intent rows. Triggers + monitoring SQL in `_system/cross-repo-followups.md`.

**Blocked:** nothing.

**Next up (Phase 0 Task 4 per architecture.md):** voice source-of-truth consolidation + nightly Hume EVI sync.

---

## What shipped (commits on `main` in `github.com/philgoodvibe/ai-phil`)
[list the 4 task commits from this session]

---

## Acceptance criteria (from spec)
[check off all DoD items from design §10]

---

## Decisions

- **App-layer DST gate chosen over fixed-UTC window** because fixed-UTC drifts by 1 hour every DST boundary, defeating the robustness goal.
- **Philgood OS rows intentionally not seeded** — cross-repo boundary respected; ERROR flags drive the follow-up.
- **Single migration, not split** — the reschedule + view + intent table land atomically; rollback is symmetric.

---

## Observability
- `ai-followup-gated` signal-type is new in `public.agent_signals`; expected volume = ~16 rows/weekday (outside-window ticks).
- `ops.cron_schedule_audit` serves as the ongoing drift detector.
```

- [ ] **Step 3: Commit the _ROADMAP update** (vault files aren't in repo git; skip if that's the case. Only commit if the vault is unexpectedly inside the repo path — it is not, per AGENTS.md.)

---

## Task 10: Push + final verification

- [ ] **Step 1: Check local branch state**

```bash
cd "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Ai Phil"
git status --short
git log origin/main..HEAD --oneline
```

Expected: clean working tree; commits from Tasks 1, 2, 3, 7 listed (Task 4/5/6 are Supabase side, no git change; Task 8/9 vault side).

- [ ] **Step 2: Pause for Phillip's explicit push approval**

Per CLAUDE.md close-out §1: "Push decision is explicit every close-out." Do NOT push without approval. Show Phillip the commit list and ask.

- [ ] **Step 3: On approval, push**

```bash
git push origin main
```

Expected: push succeeds; Vercel may pick it up and redeploy (no user-visible impact — all Task 3 changes are in edge-function + migrations + docs).

- [ ] **Step 4: Final audit sweep**

Run via Supabase MCP:
```sql
SELECT count(*) AS ai_phil_errors
FROM ops.cron_schedule_audit
WHERE severity = 'ERROR' AND owner_repo = 'ai-phil';
```

Expected: **0**.

```sql
SELECT jobname, audit_code
FROM ops.cron_schedule_audit
WHERE severity = 'ERROR';
```

Expected: only Philgood-OS-owned jobnames present; ai-phil rows absent from the ERROR set.

---

## Self-review scratchpad

- [x] Spec §3.1 (chosen DST strategy) → Tasks 1 + 2 + 3 (cover helper, wiring, reschedule)
- [x] Spec §3.2 (audit infra) → Task 3 migration body
- [x] Spec §3.3 (seed intent) → Task 3 migration body
- [x] Spec §3.4 (CLAUDE.md close-out) → Task 7
- [x] Spec §4 (file inventory) → File Structure header
- [x] Spec §6 (error handling) → Task 2 gate + Task 3 helper fail-closed
- [x] Spec §7 (cross-repo follow-ups) → Task 8
- [x] Spec §8.1 (unit tests, 9 cases) → Task 1 tests
- [x] Spec §8.2 (migration integration) → Task 4
- [x] Spec §8.3 (edge-function smoke) → Task 6
- [x] Spec §8.4 (security advisors) → Task 4 Step 5
- [x] Spec §10 (definition of done) → Task 9 summary acceptance criteria
- [x] Method signatures consistent: `isWithinBusinessHours(now?: Date): boolean` matches in tests, helper, and handler
- [x] No placeholders, TBDs, or "add appropriate error handling"
