# CLAUDE.md — ai-phil

## 🔴 READ AT BOOT — Standing Orders + Architecture (before anything else)

Every session reads these three docs in order before touching the task. If the task doesn't move one of the 3 KPIs, name that first and ask whether to cut, defer, or rescope — do not execute low-value work silently.

1. **`80-processes/Working-With-Phillip.md`** (Standing Orders, RED-tier) — intake protocol, pushback standard, decision-lock respect, recommendation format (A/B/C/D + "Recommend X because Y" first line). Drive: https://drive.google.com/file/d/1Lsbx1KR1fFAj308qB_gLAfdszJ_JxueY/view
2. **`_system/architecture.md`** — True North (95% autonomous by 2026-05-31), 3 KPIs (Phillip hrs/wk ≤5, median first-response <30s, silent-agent count =0), 5 Non-Negotiables, 4-step build order. Drive: https://drive.google.com/file/d/1FrLGjuQz400cORLlwU0qisz9ZdJoOba3/view
3. **`10-company/Positioning-V1-LOCKED.md`** + **`70-decisions/` DRs** — positioning + §8 never-use list + locked decisions that cannot be silently contradicted.

**Default posture:** Treat Phillip's proposals as CANDIDATES, run a 2–4 option survey with his proposal labeled explicitly, return "Recommend X because Y" + options + one unblocking question. Skip the survey (and say which exception applied) when: he says "lock it/go/just do it," it's time-critical, it's consistent with a locked DR or Non-Negotiable, or survey cost > execution cost.

**`_shared/salesVoice.ts` is the ONLY voice source (Non-Negotiable #1).** Every AI Phil surface reads it at boot; Hume EVI prompts sync from it (Step 1 deliverable).

---

**Read `AGENTS.md` next.** This file adds behavioral rules for Claude Code sessions. `AGENTS.md` covers orientation, ownership, vault links, and deployment. This file covers conventions and guardrails.

---

## ⚠️ LIVE-SYNC WARNING — Read before touching anything

The Google Drive folder `60-content/Ai Phil Google Docs/` (Drive ID: `1WvYoladPakRleEscONNFXVgHv3-hjbEE`) is **directly wired to Phil's production brain**. Every document placed in that folder is automatically embedded into `kb_documents` within 30 minutes.

**Never add documents to this folder for any other project** (Lea, NAVI, SAGE, GHL bots, etc.). Wrong docs = Phil gives wrong answers to real users.

If contamination occurs:
```sql
DELETE FROM kb_documents WHERE source_path IN ('gdoc:{id}');
DELETE FROM sync_state WHERE key IN ('doc_hash:gdoc:{id}');
```

---

## Before starting significant work

1. Read `AGENTS.md` (repo root) — orientation, vault links, current phase
2. Read `vault/60-content/ai-phil/_ROADMAP.md` — live priorities
3. Read relevant `vault/70-decisions/DR-*.md` — don't re-debate settled choices

---

## ⚠️ BEFORE ANY IMPLEMENTATION — non-negotiable

This rule exists because skipping it on 2026-04-15/16 cost ~3 hours of unproductive iteration building n8n workflows on unverified GHL webhook format assumptions. The superpowers skills prevent exactly that failure mode. Use them.

**Before writing any edge function, migration, workflow, config, or new code — follow in order:**

1. `Skill("superpowers:brainstorming")` — check project context (read relevant existing code FIRST, especially neighboring edge functions like `supabase/functions/ghl-message-receiver/` or `sync-knowledge-base/` that show the canonical patterns), propose 2-3 approaches with trade-offs, get Phillip's explicit approval on a design
2. `Skill("superpowers:writing-plans")` — produce a bite-sized implementation plan; save to `vault/80-processes/` or equivalent
3. `Skill("superpowers:subagent-driven-development")` — execute the plan one task at a time with spec-compliance review and code-quality review between tasks

**Never skip step 1 because "this feels simple."** Simple things are where skipped brainstorming costs the most. The 2026-04-15/16 n8n detour happened because the real GHL webhook format was sitting in `ghl-message-receiver/index.ts` waiting to be read, and we built on assumed format instead.

**If a session starts mid-stream (compacted, resumed, handed off):** check whether a prior plan doc exists (look in `vault/80-processes/` for `*-Build-Plan-*.md`). If yes, follow `superpowers:executing-plans` or `superpowers:subagent-driven-development` to continue. If no, fall back to step 1.

---

## TypeScript conventions

- **Strict mode** — `tsc --noEmit` must pass before any commit. Run `npm run typecheck`.
- No `any`. Use proper types or `unknown` with a type guard.
- React components in `.tsx`, pure logic in `.ts`.
- Use `cn()` from `src/lib/cn.ts` for conditional Tailwind classes.
- Server components by default in `app/`; add `"use client"` only when needed (event handlers, hooks, Hume SDK).
- API routes live in `src/app/api/`. Keep them thin — logic in lib files if it grows.

## Supabase conventions

- DB columns are `snake_case`. TypeScript interfaces mirror that (don't camelCase on the TS side unless through a transform layer).
- Supabase project: `ylppltmwueasbdexepip` (shared with SAGE/aiai-mastermind-app-v2)
- For server-side queries use `supabase-server.ts`; for client-side use the Supabase client from `@supabase/ssr`.
- **No schema migrations without Phillip's review.** Draft the SQL and pause.
- **After any schema migration session:** run `get_advisors('security')` via Supabase MCP and fix any ERRORs before closing. This is a standing rule — a 2-day gap cost us 3 publicly exposed tables in April 2026.
- **RLS is mandatory** on every public-schema table exposed to PostgREST. `service_role` bypasses RLS automatically; anon/authenticated do not.
- **Never hardcode API keys, JWTs, or webhook URLs** in DB functions or source files. Use Supabase vault secrets or env vars. (Lesson: hardcoded anon JWT found in a DB trigger function, 2026-04-15.)
- AI Phil tables in this project: `kb_documents` (knowledge base), `ai_phil_prospects` (discovery leads), `sync_state`, `sync_runs`. All accessed via service_role key server-side — RLS on these tables is intentional and must not be disabled.

## Hume EVI conventions

- There are 3 EVI configs: Discovery, New Member, Implementation Coach.
- **Do not edit live EVI system prompts without approval.** Changes affect all active conversations immediately.
- Tool secrets (`HUME_TOOL_SECRET`) stay server-side. Never expose them to the widget or embed script.

---

## Things that require approval before touching

| Area | Why |
|---|---|
| Supabase schema migrations | Affect shared production DB |
| Hume EVI config prompts | Live conversation impact |
| `public/ai-phil-embed.js` embed contract | External sites depend on `data-context`, `data-mode`, URL params |
| Brand colors / avatar image | Brand consistency |
| Any paid service tier change | Cost |

---

## After shipping

Per `80-processes/Agent-Coordination.md`:
1. Update `vault/60-content/ai-phil/_ROADMAP.md` — move item to Shipped with date
2. If major technical decision: write `vault/70-decisions/DR-YYYYMMDD-*.md`
3. Write 3-5 line session summary to `vault/50-meetings/`

---

## ⚠️ SESSION CLOSE-OUT PROTOCOL — run every time, no exceptions

Each numbered item below exists because it was once skipped and cost real hours or caused a production problem. Run in order.

### 1. Code + git reconciliation
- `git status` — working tree clean? Runtime dirs (`.claude/`, `supabase/.temp/`, `node_modules/`) should be gitignored, not untracked.
- `git log origin/main..HEAD` — how many commits ahead? Decision at close-out is always explicit: either push, or write the reason in the session summary.
- **Deployed-but-uncommitted check (critical):** for every Supabase edge function touched this session, run `get_edge_function` and diff against the local committed source. If they differ, the commit is stale. *(This is the bug that cost us v7→v9 of `ghl-sales-agent` shipping to prod without landing in git for days.)*
- Commit messages are descriptive and end with `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`.

### 2. Tests + typecheck
- Full test suite green (`deno test` for edge functions, `npm run typecheck` for Next.js).
- If a new edge function shipped: at least 3 HTTP smoke tests against the deployed URL (bad auth/location, missing fields, wrong method).
- **End-to-end check, not just unit:** if a prompt-building function takes new parameters, verify the parameters actually flow through from the handler. Unit tests of `formatHistory()` don't catch that it's never called.

### 3. Security (mandatory if schema touched, strongly recommended otherwise)
- `get_advisors('security')` via Supabase MCP. Fix every ERROR before close; note every WARN in the session summary.
- `SELECT * FROM ops.cron_schedule_audit WHERE severity = 'ERROR';` via Supabase MCP. Zero rows required for any ai-phil-owned jobname. Philgood-OS-owned rows will show ERROR until their matching intent records are filed from their home repo — note the row count in the session summary; do not edit Philgood OS cron rows from ai-phil.
- Grep touched SQL/source for hardcoded secrets: `eyJ` (JWT prefix), `sk_live`, `sk_test`, webhook URL literals.
- RLS on every new public-schema table.

### 4. Vault docs
- `vault/60-content/ai-phil/_ROADMAP.md`: shipped item moved with date + summary; struck-through known-issue rows updated.
- `vault/50-meetings/YYYY-MM-DD-<topic>.md`: session summary with a **"Pick up here"** block at the top (what's live / what's pending human / what's blocked / what's next).
- `vault/70-decisions/DR-YYYYMMDD-*.md`: only if a real architectural decision was made.
- **Ai Phil capability wiki** (`vault/60-content/ai-phil/AI-Phil-Brain.md` or companion): update if a new touchpoint/agent/tool shipped.
- **Live-sync folder check:** new Google Docs are NOT in the KB auto-sync folder (Drive ID `1WvYoladPakRleEscONNFXVgHv3-hjbEE`) unless intentional.

### 5. Persistent memory (across sessions)
- Add or update relevant file in `~/.claude/projects/<project>/memory/`.
- Update `MEMORY.md` index with any new file.
- Any new class of mistake → **update this CLAUDE.md with a guardrail in the table below.** That's the only way it doesn't happen again.

### 6. External state reconciliation
- Supabase edge function version logged in the session summary.
- GHL workflow Google Doc updated if a workflow changed.
- All new shared-drive URLs surfaced in roadmap or summary so they're findable.

### 7. Next-session prompt
- Write a starter prompt that names: the current live state, what's pending human action, the next priority from the roadmap, and any "read these first" docs. Save it at the top of the session summary or as a standalone artifact.

---

## Mistakes-we've-already-made guardrails

Each row is a real past bug. Don't relearn these.

| Past mistake | Guardrail |
|---|---|
| 3 hours lost building on unverified GHL webhook format (Apr 15-16) | Read neighboring production code BEFORE writing any new integration. `ghl-sales-agent`, `ghl-message-receiver`, `sync-knowledge-base` are the canonical patterns. |
| Hardcoded anon JWT in a DB trigger (Apr 15) | No secrets in SQL or source — vault secrets or env vars only. Grep every SQL file for `eyJ` before committing. |
| 3 publicly exposed tables for 2 days | `get_advisors('security')` is mandatory after every migration. |
| v7→v9 of `ghl-sales-agent` shipped to prod but not committed to git until days later | Every MCP `deploy_edge_function` call is immediately followed by `git add`+`git commit` of the same content. Never deploy from uncommitted working-tree state. |
| Email payload sent `message` when GHL required `html`+`subject` | Verify real API contracts from live response or docs before first send. Don't assume by symmetry with SMS. |
| "I'm Phillip Ngo" identity bug | Read every system prompt as an end-user would. If the prompt says "speaking as Phillip," the AI will literally claim to be Phillip. |
| "I have no memory" lie (support prompt missing `historyStr`) | End-to-end integration test before ship. Verify parameters flow through, not just that helpers return the right shape. |
| Silent subagent refactor (lazy-init in Task 3, 2026-04-16) | Verify subagent-reported file changes via `git diff`. "DONE" is not the same as a clean scoped change. |
| Working tree left dirty across sessions | Start every session with `git status`; end every session clean. Runtime dirs in `.gitignore` once. |
| Sessions shipped but never pushed to origin | Push decision is explicit every close-out. |
| "This is too simple to brainstorm" | The brainstorming skill is non-negotiable. Simple projects are where unexamined assumptions cause the most wasted work. |
| pg_cron schedule in Pacific hours (Apr 17) | pg_cron on Supabase runs in **UTC**, not the project timezone. A cron `0 9-17 * * 1-5` fires 9am-5pm UTC = 2am-10am Pacific, not business hours. Always convert target local hours to UTC when writing cron schedules. For US Pacific business hours: `0 16-0 * * 1-5` (PDT) or `0 17-1 * * 1-5` (PST). |
| MCP `contacts_remove-tags` is broken (Apr 17) | The `mcp__prod-ghl-mcp__contacts_remove-tags` tool returns 422 "tags must be an array" for any input (even valid ASCII). Use `contacts_update-contact` with `body_tags` to replace the full tag set instead (read current tags first, compute keep-set, write). `contacts_add-tags` works fine. See `memory/reference_ghl_mcp_gotchas.md`. |
| Multi-file edge function deploys with `_shared/` imports (UPDATED 2026-04-20 — varies per function) | When deploying via Supabase MCP `deploy_edge_function` with shared modules, the correct `name:` field for shared files depends on the function and is not universally predictable. Two verified patterns observed so far: (a) `ghl-sales-agent` v13 + `ghl-member-agent` v4 deployed 2026-04-19 using `name: "_shared/salesVoice.ts"` (no `../` prefix) and worked; (b) `ghl-sales-followup` v5 deployed 2026-04-20 required `name: "../_shared/salesVoice.ts"` (WITH `../` prefix) to resolve the bundler — plain `_shared/...` returned "Module not found". **Always verify per function: try the plain `_shared/...` name first, then fall back to `../_shared/...` if the bundler errors with "Module not found".** In both patterns the import inside the source file stays `from '../_shared/<file>.ts'` — only the deploy-tool `name:` differs. Never deploy without running `get_edge_function` immediately afterward to diff against local and confirm byte parity (Phase 0 Task 3 surfaced a subagent that silently condensed file contents to fit a tool call — the exact drift class the v7→v9 guardrail forbids). |
| Email inbound replied via SMS (Apr 17 — Sharon Godfrey Google Ads test) — webhook omitted `message_type` but included `conversationId`, so channel defaulted to `'sms'` and email inbounds got text replies. Plus: `ghl-member-agent` had the identical bug. | Channel extraction must ALWAYS consult conversation `lastMessageType` when `rawMessageType` is null, not only when `conversationId` is also missing. Fallback further: email-only contact (email present, phone absent) → email channel. Both gaps closed via exported pure `resolveChannel(rawMessageType, conversationLookupChannel, contact)` helper in `ghl-sales-agent/index.ts` and `ghl-member-agent/index.ts` (intentionally duplicated — agents are self-contained). Shipped 2026-04-17 as sales-agent v12 + member-agent v2. |
| Unmerged duplicate contact silently sales-pitched an existing member (Apr 17, Sharon Godfrey) — member emailed from a secondary unmerged address, system had no way to recognize membership. | Non-tagged contact writing in member-sounding language (references my membership, member portal, "in the program," "hey phil" by name, past workshop attendance) → polite "I don't recognize this email, flagging to human" boilerplate + Google Chat alert + `open_tickets` row. `detectMemberClaim()` in `_shared/salesVoice.ts`; gate in `ghl-sales-agent` before intent classification. Patterns are deliberately narrow (require program-scope anchor or membership-only artifact) to avoid false-flagging prospect inquiries. |
| "AI Phil replied as an agency" (Apr 17 — earlier Sharon Godfrey draft promised "I'll audit your campaigns and send you a breakdown") | AIAI Mastermind is a coaching program, not an agency. Never promise account audits, done-for-you work, or Phil's time outside weekly call + workshops. Encoded as `AGENCY_BOUNDARIES_BLOCK` in `_shared/salesVoice.ts`, automatically appended to every VoiceContext output and mirrored into `ghl-member-agent` system prompts via the same block. When declining agency work, use the canonical phrasings: "we don't audit or manage member accounts," "that's a great one to bring to the next weekly call," "Phil can walk through that framework live with the whole group." |
| Prompt-injection / data-exfiltration risk on every AI Phil surface (Apr 19 — non-negotiable #2 shipped) | `SECURITY_BOUNDARY_BLOCK` in `_shared/salesVoice.ts` is injected first-position in every `buildSystemPrompt` output. `detectInjectionAttempt` (7 labeled regex patterns) runs in ghl-sales-agent + ghl-member-agent handlers **before** `detectMemberClaim`/intent classifier. On match: row into `ops.injection_attempts`, canned refusal via `SECURITY_REFUSAL_PRIMARY`, 200 `{gated: 'injection-attempt'}`, no intent / no LLM / no per-attempt alert (leaks detection timing). Rolling 3-in-24h rollup: one `writeAgentSignal` + one Google Chat alert at the 3rd attempt only. **Never cite the rules in a refusal**; never acknowledge the attack pattern. ghl-sales-agent v13 + ghl-member-agent v4 shipped 2026-04-19. Hume EVI manual push (3 configs) tracked as open checkbox until Task 4 ships nightly sync. |
| Hume EVI configs drift from `SECURITY_BOUNDARY_BLOCK` (Apr 19, pending automation) | Until Task 4 (voice source-of-truth consolidation + nightly Hume sync) ships, any edit to `SECURITY_BOUNDARY_BLOCK` in `_shared/salesVoice.ts` MUST be followed by a manual paste into Discovery / New Member / Implementation Coach Hume EVI system prompts via https://app.hume.ai dashboard. Tracked as an explicit open-checkbox at every session close-out. Non-negotiable #2 is not fully shipped without the Hume push. |
| Silent CHECK-constraint violation → 4 days of lost inserts (Apr 16-20) — `ghl-member-agent` wrote `intent='member_support'` + `stage=<memberIntent>` into `ops.ai_inbox_conversation_memory`; both violated sales-funnel-only CHECKs. The insert was wrapped in `try { ... } catch (err) { console.error('[memory] insert error:', err) }` and the handler returned 200 — no caller signal of failure, no metric, no alert. Every single member-agent insert was dropped silently from ship-day (v1, 2026-04-16) until fix (v5, 2026-04-20). | Every DB write wrapped in try/catch that "logs-but-swallows" is a latent silent-data-loss bug. When adding such a pattern, ALSO add: (a) schema-level CHECK/FK verification test (seed a row with every valid enum value the handler can produce; assert insert succeeds), or (b) alerting on non-zero `error` return from the Supabase client. Extra for taxonomy changes: add `COMMENT ON COLUMN` statements to the migration documenting the per-surface vocabulary + disambiguation rule so downstream analytics can't conflate overlapping values (e.g., `stage='member'` filter first, then aggregate by `intent`). Widening migration: `supabase/migrations/20260420000000_broaden_ai_inbox_memory_checks.sql`. |
| Retiring a signal-bus audit target in one repo requires companion edit in another (Apr 20) — ai-phil retargeted `target_agent: 'richie-cc2'` → `'quimby'` in 3 GHL edge functions, but `signal-dispatch` v12 (Leo CC2 / Philgood OS source) still tries HTTP dispatch to `archies-mac-mini.tail51ba6f.ts.net` for any named target not in its `POLL_ONLY_AGENTS` set. Result: one cosmetic DNS-error row per inbound in `public.agent_signals` dispatch-log. Audit row itself lands cleanly. | File cross-repo follow-ups in THREE places so the TODO fires where the work happens, not where it was written: (1) ai-phil `vault/60-content/ai-phil/_ROADMAP.md` "Cross-repo follow-ups" section, (2) canonical accretion doc `vault/_system/cross-repo-followups.md`, (3) next push of `vault/_system/leo-cc2-architecture-ping.md`. Include expedite triggers (e.g., "> 100 DNS errors/day OR calendar reaches DATE") so the noise can't become invisible background. |
| pg_cron schedule authored in local time without app-layer DST gate (Apr 17, fixed Apr 20) | `ghl-sales-followup-hourly` shipped as `0 9-17 * * 1-5` expecting Pacific business hours but pg_cron runs UTC, so the job fired 2a-10a PDT / 1a-9a PST Mon-Fri. Fix pattern: cron fires every hour Mon-Fri UTC (`0 * * * 1-5`), edge function calls `isWithinBusinessHours()` using `Intl.DateTimeFormat` with `timeZone: 'America/Los_Angeles'`. Seed `ops.cron_job_intent` with `dst_strategy = 'app-layer'`. The `ops.cron_schedule_audit` view catches any future hour-bounded schedule that isn't paired with app-layer DST. Added to close-out §3. |

---

## Key paths

| What | Where |
|---|---|
| Widget UI | `src/components/ai-phil-widget.tsx` |
| Embed iframe target | `src/app/embed/ai-phil/page.tsx` |
| Hume API proxies | `src/app/api/hume/` |
| Embed loader script | `public/ai-phil-embed.js` |
| Drive sync edge fn | `supabase/functions/sync-knowledge-base/` |
| Manual sync trigger | `src/app/api/admin/sync-docs/route.ts` |
| DB migrations | `supabase/migrations/` |
| Eval + scripts | `scripts/` |
