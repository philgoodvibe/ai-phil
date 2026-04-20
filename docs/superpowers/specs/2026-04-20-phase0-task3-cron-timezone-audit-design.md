# Phase 0 Task 3 — pg_cron Timezone Fix + Self-Enforcing Audit (Design)

**Date:** 2026-04-20
**Author:** Opus 4.7 (ai-phil repo session, continuing Phase 0)
**Precedes:** `docs/superpowers/plans/2026-04-20-phase0-task3-*.md` (implementation plan)
**Predecessor shipments:** Phase 0 Task 1 (SECURITY_BOUNDARY_BLOCK, 2026-04-19), Phase 0 Task 2 (ai_inbox_memory CHECK widening + liveness drift fix, 2026-04-20)

---

## 1. Problem

### 1.1 Immediate symptom

`cron.job` row `ghl-sales-followup-hourly` was authored in migration `20260417000004_ghl_sales_followup_cron.sql` with the comment *"at the top of each business hour (9am-5pm Mon-Fri)"* and the schedule `0 9-17 * * 1-5`. pg_cron on Supabase runs in **UTC**, not the project local time, so the job actually fires:

- **During PDT (March–November):** 02:00–10:00 local Mon–Fri — dead of night through mid-morning
- **During PST (November–March):** 01:00–09:00 local Mon–Fri — dead of night through early morning

Net effect: the follow-up queue drains at the worst possible times, and the "business hour" intent is silently violated every single day. CLAUDE.md already carries this failure class as a documented guardrail row, but the guardrail is advisory-only — it didn't prevent this job from shipping, and there is no automated check that would catch the next author making the same mistake.

### 1.2 Root failure class

This is the same failure shape Phase 0 Task 2 surfaced: a latent runtime behavior diverging from documented intent, with no self-enforcing check to surface the drift. Task 2's lesson was *"try/catch that logs-but-swallows is latent silent-data-loss — make it schema-enforced."* Task 3 extends the pattern to scheduled jobs: **cron authoring that assumes local timezone is latent-wrong-time-firing — make it audit-enforced.**

### 1.3 Scope evidence (live cron.job enumeration, 2026-04-20)

Eight active rows across two owning repos:

| jobid | jobname | schedule (UTC) | owner repo | Drift / risk |
|---|---|---|---|---|
| 1 | `email-rules-cache-sync` | `*/30 * * * *` | Philgood OS | Plaintext `sb_secret_…` in command |
| 4 | `people-sync-n2s` | `*/30 * * * *` | Philgood OS | Plaintext anon JWT (`eyJ…`) |
| 5 | `people-sync-s2n` | `*/5 * * * *` | Philgood OS | Plaintext anon JWT |
| 6 | `email-rules-s2n` | `*/30 * * * *` | Philgood OS | Plaintext anon JWT |
| 7 | `emora-inbox-sweep` | `0 */2 * * *` | Philgood OS | Clean (interval, no HTTP) |
| 8 | `donna-daily-brief` | `30 15 * * *` | Philgood OS | Hour-shaped (15:30 UTC); intent unknown |
| 9 | `sync-ai-phil-docs` | `*/30 * * * *` | **ai-phil** | Clean (vault lookup, interval) |
| 10 | `ghl-sales-followup-hourly` | `0 9-17 * * 1-5` | **ai-phil** | **Drifted — fires 2a-10a PDT / 1a-9a PST** |

### 1.4 Ownership boundary (non-negotiable)

ai-phil may edit rows **9** and **10**. Rows **1, 4, 5, 6, 7, 8** (all 6 non-ai-phil rows) belong to Philgood OS; editing them from this repo would mirror the governance violation Task 2 explicitly filed as a cross-repo follow-up. Those 6 rows are filed out as cross-repo follow-ups in §7 — the audit infrastructure this spec builds makes the debt visible but does not unilaterally fix it.

---

## 2. Objective

Eliminate the cron-timezone failure class from ai-phil, and build a self-enforcing audit that catches the same class in any future cron authoring — without reaching into Philgood OS territory.

**Not doing:**
- Not rewriting Philgood OS cron rows (cross-repo follow-up)
- Not redesigning `ghl-sales-followup` edge-function queue logic (scope creep; the followup-queue algorithm shipped with RIS Phase 1 is orthogonal)
- Not adding a CI lint (the DB-level audit view is cheaper, always-on, and lives with the data it guards)

---

## 3. Design

### 3.1 Fix the drifted cron — application-layer business-hours gate

**Rejected alternative 1 — pick a fixed UTC window:** `0 16-0 * * 1-5` (PDT-aligned) or `0 17-1 * * 1-5` (PST-aligned) each silently drift by 1 hour the other half of the year. This is the same failure class we're eliminating; just moves it from "always wrong" to "wrong half the year." Not robust.

**Rejected alternative 2 — dual cron rows toggled at DST:** Correct-firing half the year, disabled half the year. Requires humans to remember two Sundays/year. Same failure class shifted to operational memory.

**Chosen — cron fires every hour Mon–Fri UTC; edge function gates on Pacific local time at invocation:**

```
new schedule:  0 * * * 1-5           -- every hour Mon-Fri UTC; DST-agnostic
edge function: isWithinBusinessHours(new Date())
               → uses Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false, weekday: 'short' })
               → returns true when local hour ∈ [9, 17] AND local weekday ∈ {Mon…Fri}
               → false → function returns 200 { ok: true, gated: 'outside-business-hours' }
```

**Why this wins on robustness:**
- Business-hours decision lives in version-controlled, unit-testable TypeScript
- DST is handled by the platform `Intl` API — no human calendar reminders
- The helper is trivially testable at DST-boundary edge cases
- Failure mode if the edge function is misconfigured: gated rows appear in logs, queue drains deferred to next tick — no lost data, no wrong-hour sends
- Cost: ~16 extra cron invocations/weekday against an empty queue; each is a ~50ms no-op check. Cron tick cost in Supabase is effectively zero.

### 3.2 Self-enforcing audit — `ops.cron_job_intent` + `ops.cron_schedule_audit`

pg_cron does not support `COMMENT ON JOB`. To make intent declarative and auditable, introduce a sidecar metadata table plus a view that flags drift.

#### 3.2.1 `ops.cron_job_intent` (new table)

```sql
CREATE TABLE ops.cron_job_intent (
  jobname         TEXT PRIMARY KEY,
  owner_repo      TEXT NOT NULL CHECK (owner_repo IN ('ai-phil', 'philgood-os', 'shared')),
  purpose         TEXT NOT NULL,
  local_tz        TEXT,                          -- NULL iff interval-based
  local_window    TEXT NOT NULL,                 -- e.g. '9a-5p Mon-Fri PT', 'every 30m', '15:30 UTC fixed'
  dst_strategy    TEXT NOT NULL CHECK (dst_strategy IN ('app-layer', 'interval', 'fixed-utc', 'none-required')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ops.cron_job_intent ENABLE ROW LEVEL SECURITY;
-- No policies; only service_role (which bypasses RLS) can read/write.
COMMENT ON TABLE ops.cron_job_intent IS
  'Sidecar to cron.job declaring the intent behind each scheduled job. Every row in cron.job SHOULD have a matching row here; absence is flagged as ERROR by ops.cron_schedule_audit. DST strategy is explicit: app-layer means the function gates on local time; interval means every-N-minutes so timezone is irrelevant; fixed-utc means a deliberate UTC moment; none-required means purely interval-based.';
```

#### 3.2.2 `ops.cron_schedule_audit` (new view)

```sql
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
    WHEN intent_missing                                            THEN 'ERROR'
    WHEN secret_in_command                                         THEN 'ERROR'
    WHEN hour_bounded_schedule AND dst_strategy <> 'app-layer'     THEN 'WARN'
    ELSE 'OK'
  END AS severity,
  CASE
    WHEN intent_missing                                            THEN 'intent_missing'
    WHEN secret_in_command                                         THEN 'secret_in_command'
    WHEN hour_bounded_schedule AND dst_strategy <> 'app-layer'     THEN 'hour_bounded_without_app_layer_dst'
    ELSE 'ok'
  END AS audit_code
FROM job_with_intent
ORDER BY
  CASE
    WHEN intent_missing OR secret_in_command                       THEN 0
    WHEN hour_bounded_schedule AND dst_strategy <> 'app-layer'     THEN 1
    ELSE 2
  END,
  jobname;

COMMENT ON VIEW ops.cron_schedule_audit IS
  'Self-enforcing cron drift detector. Severity ERROR = must fix (no declared intent OR plaintext secret in command). Severity WARN = hour-bounded schedule without app-layer DST handling (likely authored in local time). Run at every session close-out alongside get_advisors(''security''). Fix ERROR rows before closing; document WARN rows in the session summary.';
```

**Why a view (not a CHECK constraint or trigger):** `cron.job` is owned by the `postgres` superuser and managed by the pg_cron extension; adding constraints to it would fight the extension. A view is read-only, composable, and integrates cleanly with session-close-out queries.

**Why not require a CI job or external lint:** The audit lives in the same DB as the jobs it guards. There is no deployment path for a cron job that skips the DB, so the audit is inherently complete. A CI lint would add a second source of truth that could disagree with reality — exactly the drift class we're eliminating.

### 3.3 Seed intent records for ai-phil-owned rows

```sql
INSERT INTO ops.cron_job_intent (jobname, owner_repo, purpose, local_tz, local_window, dst_strategy, notes) VALUES
(
  'sync-ai-phil-docs', 'ai-phil',
  'Every 30 min: trigger sync-knowledge-base edge function to pull Drive doc changes into kb_documents',
  NULL, 'every 30m', 'none-required',
  'Auth via vault.decrypted_secrets.supabase_anon_key. Clean — interval-based, no local-hour intent.'
),
(
  'ghl-sales-followup-hourly', 'ai-phil',
  'Every hour Mon-Fri UTC: trigger ghl-sales-followup to drain ops.ai_inbox_followup_queue. Edge function itself gates on Pacific business hours (9a-5p PT) via isWithinBusinessHours().',
  'America/Los_Angeles', '9a-5p Mon-Fri PT', 'app-layer',
  'Cron fires hourly Mon-Fri UTC regardless of local time; the business-hours gate lives in supabase/functions/ghl-sales-followup/index.ts::isWithinBusinessHours. DST-agnostic. Outside-window invocations return { ok: true, gated: ''outside-business-hours'' } 200.'
);
```

Philgood OS rows are **intentionally not seeded** — they surface as `ERROR/intent_missing` in the audit view, which is the correct signal for the cross-repo-follow-up cycle (§7).

### 3.4 Close-out protocol amendment (CLAUDE.md)

Add one line to §3 Security of the session close-out protocol:

> **Cron drift check:** `SELECT * FROM ops.cron_schedule_audit WHERE severity = 'ERROR';` — must return zero rows for ai-phil-owned jobnames before closing a session. WARN rows are noted in the session summary.

Add one row to the "Mistakes-we've-already-made guardrails" table:

> | pg_cron schedule authored in local time without app-layer DST gate (Apr 17, fixed Apr 20) | `ghl-sales-followup-hourly` shipped as `0 9-17 * * 1-5` expecting Pacific but pg_cron runs UTC; business hours fired 2a-10a local. Fix pattern: cron fires every hour Mon-Fri UTC (`0 * * * 1-5`), edge function calls `isWithinBusinessHours()` using `Intl.DateTimeFormat` with `timeZone: 'America/Los_Angeles'`. Seed `ops.cron_job_intent` with `dst_strategy = 'app-layer'`. The `ops.cron_schedule_audit` view catches any future hour-bounded schedule that isn't paired with app-layer DST. |

---

## 4. Components

### 4.1 New
- `supabase/migrations/20260420000001_cron_intent_audit_and_followup_reschedule.sql` — single migration: create `ops.cron_job_intent`, create `ops.cron_schedule_audit` view, `cron.unschedule('ghl-sales-followup-hourly')` + reschedule with `0 * * * 1-5`, seed 2 intent rows
- `supabase/functions/ghl-sales-followup/businessHours.ts` — new file exporting the pure helper
- `supabase/functions/ghl-sales-followup/businessHours.test.ts` — Deno tests (5 cases: mid-PDT, mid-PST, pre-business, post-business, weekend; plus DST boundary)

### 4.2 Modified
- `supabase/functions/ghl-sales-followup/index.ts` — import `isWithinBusinessHours`, call at top of handler before queue drain, return gated-200 if outside window
- `CLAUDE.md` — add close-out check line + guardrail table row
- `vault/60-content/ai-phil/_ROADMAP.md` — cross-repo follow-ups section: add Philgood OS cron inventory + expedite trigger
- `vault/_system/cross-repo-followups.md` — same follow-up, canonical accretion
- `vault/_system/leo-cc2-architecture-ping.md` — same follow-up appended for next push

### 4.3 Unchanged (explicit non-goals)
- `supabase/functions/ghl-sales-followup/index.ts` queue-drain logic, cadence calculator, memory insert, rapport extract
- `supabase/functions/sync-knowledge-base/*`
- All Philgood OS cron rows (1, 4, 5, 6, 7, 8)

---

## 5. Data flow

```
hourly UTC tick Mon-Fri
    │
    ▼
cron.job row 10 fires HTTP POST to ghl-sales-followup
    │
    ▼
edge function handler:
    ├─ (existing) Bearer auth check
    ├─ isWithinBusinessHours(new Date())  ← NEW gate
    │     ├─ true  → proceed to existing queue drain
    │     └─ false → return 200 { ok: true, gated: 'outside-business-hours' }
    │                  (no queue read, no Sonnet call, no GHL send)
    ▼
(existing) queue drain, per-row touch, memory insert, rapport extract, cadence advance
```

---

## 6. Error handling + observability

- **`isWithinBusinessHours` is pure + total.** Never throws. If `Intl.DateTimeFormat` were somehow unavailable, `formatToParts` returns an empty array and the helper falls through to `false` — fail-closed (gate everything) rather than fail-open (fire outside hours).
- **Gated invocations return 200** with `{ ok: true, gated: 'outside-business-hours' }`. Matches the 200-with-reason convention already used by the injection gate in the sales/member agents. No 4xx, no alert.
- **Audit signal** (existing in `ghl-sales-followup`): gated invocations emit `writeAgentSignal` with `signal_type = 'ai-followup-gated'` so Donna/Quimby can see "cron fired but we declined." Low-priority; no Google Chat alert.
- **No new failure paths introduced by the migration.** `cron.unschedule` is idempotent; the reschedule uses the same body with only the schedule string changed.

---

## 7. Cross-repo follow-ups (3-location drop per Task 2 convention)

Filed in:

1. `vault/60-content/ai-phil/_ROADMAP.md` — Cross-repo follow-ups section
2. `vault/_system/cross-repo-followups.md` — canonical accretion
3. `vault/_system/leo-cc2-architecture-ping.md` — next leo-cc2 ping push

### 7.1 Payload (identical to all three locations)

**Target repo:** Philgood OS / Leo CC2

**Task (two parts):**

1. **Rotate 4 rows off plaintext secrets** to vault-secret auth: `email-rules-cache-sync`, `people-sync-n2s`, `people-sync-s2n`, `email-rules-s2n`. All four currently hardcode either an anon JWT (`eyJ…`) or a `sb_secret_…` secret directly in `cron.command`.
2. **Seed `ops.cron_job_intent` for all 6 Philgood-OS-owned jobnames** (the four above plus `emora-inbox-sweep` (interval, clean) and `donna-daily-brief` (schedule `30 15 * * *` — confirm whether 15:30 UTC is deliberate or authored-as-local before picking `dst_strategy`)).

**Why it matters:** The ai-phil Phase 0 Task 3 work ships `ops.cron_schedule_audit` as a shared audit surface. All 6 Philgood-OS-owned rows will flag as ERROR at every ai-phil session close-out (4 × `secret_in_command` + 6 × `intent_missing`) until Philgood OS files matching intent rows and rotates the secrets to vault lookup. The audit will show this debt loudly; it won't fix itself.

**Migration pattern to adopt (from ai-phil `20260415000002_sync_cron.sql` and `20260417000004_ghl_sales_followup_cron.sql`):**

```sql
SELECT cron.schedule('<jobname>', '<schedule>', $$
  SELECT net.http_post(
    url     := '<function-url>',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_anon_key'
      )
    ),
    body    := '{...}'::jsonb
  ) AS request_id;
$$);
```

**Expedite triggers (either fires → expedite, else reconsider at the second):**
- `SELECT count(*) FROM ops.cron_schedule_audit WHERE severity = 'ERROR' AND audit_code = 'secret_in_command'` stays > 0 for > 30 calendar days from 2026-04-20
- Any compliance/security review that touches the Supabase project scope
- Calendar date reaches 2026-05-20

**Monitoring SQL (for next-action decisioning):**
```sql
SELECT jobname, audit_code, severity, schedule
FROM ops.cron_schedule_audit
WHERE severity IN ('ERROR', 'WARN') AND jobname IN (
  'email-rules-cache-sync', 'people-sync-n2s', 'people-sync-s2n',
  'email-rules-s2n', 'emora-inbox-sweep', 'donna-daily-brief'
);
```

---

## 8. Testing

### 8.1 Unit (Deno, local)

`supabase/functions/ghl-sales-followup/businessHours.test.ts`:

- `isWithinBusinessHours(new Date('2026-04-20T17:30:00Z'))` → **true** (Mon 10:30 PDT)
- `isWithinBusinessHours(new Date('2026-04-20T04:00:00Z'))` → **false** (Sun 21:00 PDT → Sun weekend rule, AND outside 9-17)
- `isWithinBusinessHours(new Date('2026-04-20T15:59:00Z'))` → **false** (Mon 08:59 PDT, before window)
- `isWithinBusinessHours(new Date('2026-04-20T16:00:00Z'))` → **true** (Mon 09:00 PDT, first tick in window)
- `isWithinBusinessHours(new Date('2026-04-20T00:59:00Z'))` → **true** (Mon 17:59 PDT, last tick in window)
- `isWithinBusinessHours(new Date('2026-04-21T01:00:00Z'))` → **false** (Mon 18:00 PDT, first tick outside window)
- `isWithinBusinessHours(new Date('2026-04-25T17:30:00Z'))` → **false** (Sat 10:30 PDT, weekend)
- DST boundary: `isWithinBusinessHours(new Date('2026-11-02T17:00:00Z'))` → **true** (Mon 09:00 PST, first Monday after fall-back)
- DST boundary: `isWithinBusinessHours(new Date('2026-11-02T16:00:00Z'))` → **false** (Mon 08:00 PST, pre-window; the same UTC moment would have been 09:00 PDT and in-window the previous Monday — DST is correctly handled)

### 8.2 Migration integration (executed against live DB, evidence captured in plan)

- `SELECT jobname, schedule FROM cron.job WHERE jobname = 'ghl-sales-followup-hourly';` → schedule is `0 * * * 1-5`
- `SELECT count(*) FROM ops.cron_schedule_audit WHERE severity = 'ERROR' AND owner_repo = 'ai-phil';` → **0**
- `SELECT count(*) FROM ops.cron_schedule_audit WHERE audit_code = 'intent_missing';` → **6** (all 6 Philgood-OS-owned rows; none are seeded from this repo)
- `SELECT count(*) FROM ops.cron_schedule_audit WHERE audit_code = 'secret_in_command';` → **4** (rows 1, 4, 5, 6)

### 8.3 Edge-function smoke (executed against deployed function)

- POST to `ghl-sales-followup` with valid auth at Mon 03:00 UTC (= Sun 20:00 PDT) → `200 { ok: true, gated: 'outside-business-hours' }`
- POST at Mon 17:30 UTC (= Mon 10:30 PDT) → existing queue-drain flow (expected `{ ok: true, drained: N }` or empty-queue response)

### 8.4 Security

- `get_advisors('security')` — zero new ERRORs
- Grep touched SQL for `eyJ|sk_live|sk_test|sb_secret` — only matches are the regex string inside the audit view definition

---

## 9. Rollback

Single reverse migration is trivial if needed:

```sql
-- Rollback for 20260420000001
SELECT cron.unschedule('ghl-sales-followup-hourly');
SELECT cron.schedule('ghl-sales-followup-hourly', '0 9-17 * * 1-5', <original body>);
DROP VIEW IF EXISTS ops.cron_schedule_audit;
DROP TABLE IF EXISTS ops.cron_job_intent;
```

Edge function rollback: redeploy the prior `ghl-sales-followup` version (v3 at time of writing) via Supabase MCP.

No data-loss risk at any rollback step. `cron_job_intent` is metadata-only. The `isWithinBusinessHours` gate is fail-closed (returns 200 gated), so even if the edge-function side rolled back but the cron side did not, the worst case is ~16 extra no-op cron invocations per day hitting the old version — still harmless.

---

## 10. Definition of done

- [ ] Migration `20260420000001_cron_intent_audit_and_followup_reschedule.sql` applied to prod Supabase (`ylppltmwueasbdexepip`)
- [ ] `cron.job` row `ghl-sales-followup-hourly` has schedule `0 * * * 1-5`
- [ ] `ops.cron_job_intent` contains 2 rows (both ai-phil-owned)
- [ ] `ops.cron_schedule_audit` returns 0 ERROR rows for `owner_repo = 'ai-phil'`
- [ ] `ops.cron_schedule_audit` returns the expected ERROR set for Philgood OS rows (serves as baseline for the cross-repo follow-up)
- [ ] `isWithinBusinessHours` unit tests green (9 cases)
- [ ] `ghl-sales-followup` deployed (v4) with the gate wired; deployed-vs-local source parity verified
- [ ] Live smoke: one 200-gated and one 200-drain response captured with timestamps
- [ ] `CLAUDE.md` updated (close-out §3 + mistakes table)
- [ ] Cross-repo follow-up filed in all 3 locations (§7)
- [ ] `get_advisors('security')` clean
- [ ] Session summary written to `vault/50-meetings/2026-04-20-phase0-task3-cron-timezone-audit.md` with "Pick up here" block
- [ ] `_ROADMAP.md` updated (Phase 0 Task 3 moved to Shipped)

---

## 11. Out of scope / future

- Extending the audit to cover `pg_net.http_request_queue` retries (if cron-triggered HTTP fails, is there observability?) — separate concern
- Applying `ops.cron_job_intent` to Philgood OS rows from this repo — governance violation
- A nightly backup / audit SIEM feed — premature until we have >20 cron jobs

---

## 12. Open questions

None. Migration intent comment (`'9am-5pm Mon-Fri'`) supplies the local window; DST handling is an architectural choice made above (app-layer).
