# AI Phil Stack — Current State (As-Is Snapshot)

> **⚠ SUPERSEDED 2026-04-18 — MERGED**
>
> This AI-Phil-session snapshot has been folded into the vault-side master:
> **`AIAI-Vault/_system/current-state-2026-04-18-vault-side.md`**
> (Google Doc mirror: *AIAI Vault & Products — Current State (As-Is Snapshot, 2026-04-18)*).
>
> The master doc now carries this doc's live-verification findings — pg_cron enumeration, timezone bug on `ghl-sales-followup-hourly`, hardcoded-secret violations on 4 pg_cron jobs, 6-day sales-agent silence, Supabase advisor warnings (`reel-assets` public bucket, leaked-password protection, RLS-no-policies), untracked reel factory B/C, and the three-way voice source-of-truth split — as §9 drift items 13–23 and §6.1a pg_cron block, each tagged `[ai-phil-session]`.
>
> **Retained here as a historical snapshot.** Any future updates to AI-Phil-stack state go in the vault-side master, not here.

**Updated:** 2026-04-18
**Author:** Opus 4.7 (Ai-Phil repo session)
**Audience:** Phillip + external AI consumers (Leo CC2, SAGE, future agents) needing to understand the AI-Phil side of the company as it actually runs today — parallel to Leo CC2's `PhilGood OS — Current State (As-Is Snapshot)` (gdoc `18pZDmKpx5uOV6ou0uAzszRQEIzTgx7svv3cOUYcuqXQ`).

This document describes what is **actually deployed, running, and producing traffic** as of 2026-04-18 — not what seat cards, CLAUDE.md, roadmaps, or plans say should exist. Where docs and reality disagree, reality wins and drift is recorded in §7.

**Evidence labels**
- `[verified]` — confirmed against Supabase MCP, edge-function API, or source this session
- `[source]` — read from committed code in the repo
- `[vault]` — stated in CLAUDE.md / vault doc, not independently verified this session
- `[drift]` — docs and reality disagree; see §7

---

## 1. System Overview

The "AI Phil Stack" is the customer-facing layer of AIAI Mastermind: the systems that talk to prospects and members on Phillip's behalf across web, SMS, email, and (soon) voice. It lives in the same Supabase project as PhilGood OS (`ylppltmwueasbdexepip`) but is a separate set of surfaces, owned from the Ai Phil repo at `Coding Projects/Ai Phil/`. `[verified]`

**Purpose:** every channel that carries "Phil's voice" to a human replies in <2 min with Phil's actual language, books calls, answers product questions, and escalates only when it must — so Phillip's human reply time drops toward zero.

**Architecture:** Next.js 15 web app (widget + embed + API routes) → Hume EVI voice configs → Supabase Edge Functions (Deno) for GHL inbound + knowledge sync + follow-up cron → shared Supabase schemas `public` (customer data) and `ops` (automation state). `[source]`

**Source-of-truth precedence for Ai Phil:** repo git history (behavior) > Supabase DB + edge functions (state) > Drive vault (doctrine). This is **inverted** from Leo CC2's stack (where vaults are canonical). In this stack, code is canonical — vault lags. `[drift-relative-to-philgood-os]`

**Sibling stacks that coexist in the same Supabase:**
- **PhilGood OS** — Leo CC2 + Donna + Alfred + Emora + Watchdog + Pachie fleet (Mac-mini daemons) writing to `public.agent_signals`, `ops.activity_log`, `ops.agent_registry`. Richie retired 2026-04-20 (`DR-2026-04-20-Richie-Retired.md`). Owned out of `Coding Projects/Philgood OS/`. `[verified]`
- **SAGE** — Next.js member portal + Chrome extension at `Coding Projects/SAGE - Screen Aware Guided Experience/`, Vercel-deployed, same Supabase, Stripe billing, auth via Supabase Auth. Last commit 2026-04-17. `[verified]`
- **Automated Reels - Phil Ai** — Remotion 4 pipeline at `Coding Projects/Automated Reels - Phil Ai/`, Claude-Code-orchestrated. Writes to Supabase storage bucket `reel-assets` and probably notifies via edge function `content-pipeline-notify` v17. Last commit 2026-04-18. `[verified]`

---

## 2. Surface Snapshot — What Ai Phil Actually Is

Ai Phil is not one agent — it is **six surfaces** sharing a voice model + knowledge base. Each has independent code, deployment, and traffic.

| Surface | Channel | Entry point | Live? | Version | 14-day traffic |
|---|---|---|---|---|---|
| Discovery web widget | Browser voice/chat | `/discover` → `/embed/ai-phil?context=discovery` | **Live** | embed.js unversioned | **0 prospects captured** `[verified drift]` |
| New-member onboarding widget | Browser voice/chat | `/embed/ai-phil?context=new-member` (authed) | Live | same widget, different Hume config | not measured |
| Implementation-coach widget | Browser voice/chat | `/embed/ai-phil?context=implementation` (authed) | Live | same widget, different Hume config | not measured |
| GHL sales-agent | SMS + email | `ghl-message-receiver` → `ghl-sales-agent` | **Live** | **v12** (deployed 2026-04-17) | 68 triage runs, 53 decisions, 9 replies sent, 12 escalations. **Last decision 2026-04-12 — no traffic in 6 days** `[verified]` |
| GHL member-agent | SMS + email | `ghl-message-receiver` → `ghl-member-agent` | **Live** | **v3** (deployed 2026-04-17) | not separately instrumented `[drift]` |
| GHL sales-followup (RIS) | Outbound SMS + email | `ghl-sales-followup` via pg_cron | Live (cron firing) | **v2** (deployed 2026-04-17) | **0 queue rows, 0 sends** `[verified]` — code live, never populated |

**Hume EVI configs (3, env-driven, not hardcoded in source):** `[source]`
- `HUME_EVI_CONFIG_DISCOVERY=7b0c4b13-f495-449a-884a-5f3e38c661c0`
- `HUME_EVI_CONFIG_NEW_MEMBER=9e13d89f-3f42-4609-8060-32d36965d73e`
- `HUME_EVI_CONFIG_IMPLEMENTATION=500e7bd2-5fc5-4bd1-90b8-e0b6d61a4eaf`

Selection logic in `src/app/api/hume/access-token/route.ts`: public contexts get rate-limited Hume tokens; member context looks up `people.onboarding_completed` to pick new-member vs. implementation config. Fallback is discovery. `[source]`

---

## 3. Edge Functions — Deployed Versions

Enumerated via Supabase MCP at 2026-04-18. Every function below is `ACTIVE`. `[verified]`

| Function | Ver | Purpose | Repo-committed? |
|---|---|---|---|
| `ghl-message-receiver` | **17** | Webhook intake from GHL, routes to sales vs. member agent by contact tag | yes |
| `ghl-sales-agent` | **12** | Intent classify → reply draft → send + log. Includes `detectMemberClaim()`, AGENCY_BOUNDARIES_BLOCK, channel A+B fix | yes |
| `ghl-member-agent` | **3** | Member-facing SMS/email; 6-category intent; -Ai Phil signature | yes |
| `ghl-sales-followup` | **2** | RIS follow-up cadence: polls `ops.ai_inbox_followup_queue`, sends next touch | yes |
| `sync-knowledge-base` | **7** | Google-Drive → `kb_documents` embedder (pg_cron every 30m) | yes |
| `search-knowledge-base` | 10 | RAG search for widget + agents | yes |
| `ingest-document` | 10 | Manual single-doc push into KB | yes |
| `hume-admin` | 5 | Admin for Hume configs | yes |
| `content-pipeline-notify` | 17 | **Reels pipeline hook** (cross-system; fired by the Reels repo) | not in this repo |
| `signal-dispatch` | 29 | **PhilGood OS signal-bus router** — not Ai Phil | no |
| `gmail-push-handler` | 27 | **Emora's Gmail intake** — not Ai Phil | no |
| `email-rules-sync`, `vip-contacts-sync`, `people-sync` | 21/14/15 | PhilGood-OS-side ops sync | no |
| `fathom-mcp`, `fathom-mcp-auth`, `fathom-auth`, `mcp-test` | 20/13/13/14 | Meeting capture MCP | no |

**Leo CC2's doc claims `gmail-push-handler v14` and `ghl-message-receiver v4`.** Current truth: v27 and v17. Those are both stale in the PhilGood OS snapshot. `[drift]`

---

## 4. Pipelines & Scheduled Jobs

Enumerated via `cron.job` at 2026-04-18. `[verified]`

| jobid | Name | Schedule (UTC) | Active | Notes |
|---|---|---|---|---|
| 1 | `email-rules-cache-sync` | `*/30 * * * *` | ✓ | **Hardcoded `sb_secret_…` token in command** (security violation, matches guardrail) `[drift]` |
| 4 | `people-sync-n2s` | `*/30 * * * *` | ✓ | **Hardcoded anon JWT in command** `[drift]` |
| 5 | `people-sync-s2n` | `*/5 * * * *` | ✓ | **Hardcoded anon JWT in command** `[drift]` |
| 6 | `email-rules-s2n` | `*/30 * * * *` | ✓ | **Hardcoded anon JWT in command** `[drift]` |
| 7 | `emora-inbox-sweep` | `0 */2 * * *` | ✓ | Writes signal to Emora — PhilGood OS |
| 8 | `donna-daily-brief` | `30 15 * * *` | ✓ | Writes signal to Donna — PhilGood OS |
| 9 | `sync-ai-phil-docs` | `*/30 * * * *` | ✓ | **Ai Phil KB refresh.** Uses `vault.decrypted_secrets` — correct pattern ✓ |
| 10 | `ghl-sales-followup-hourly` | `0 9-17 * * 1-5` | ✓ | **UTC = 2am–10am Pacific — timezone bug LIVE** `[drift]` (exactly the mistake called out in CLAUDE.md guardrails) |

**Live traffic signals (14-day window, 2026-04-18):** `[verified]`
- `ai_phil_prospects` total: **0 rows ever.** Discovery widget has captured zero leads into this table. Either the widget isn't writing here or it's never been filled.
- `kb_documents` total: **8 docs** (small)
- `sync_runs` last 24h: 48 runs, last at 2026-04-19 02:00 UTC, 0 files synced / 0 errored — healthy no-op cadence
- `ghl_convo_triage_runs` last 14d: 68; decisions: 53; replies sent: 9; escalations: 12. Latest decision **2026-04-12 23:53 UTC** — agent has been **silent 6 days**
- `ai_inbox_followup_queue`: **0 rows ever.** RIS Phase 1 code is shipped but no row has been written into the queue
- `contact_rapport`: 3 rows (minimal rapport memory built)
- `open_tickets`: 5 total, 0 with `status='open'`

---

## 5. Knowledge Stores

### 5.1 Vaults (doctrine)

| Repo / location | Path | Purpose | Writers |
|---|---|---|---|
| AIAI Shared Drive vault | `Shared drives/AiAi Mastermind/01_Knowledge Base/AIAI-Vault/` | AIAI ops, SOPs, voice, roadmap, decisions | Phillip, Claude sessions |
| Ai Phil auto-sync folder | Drive `1WvYoladPakRleEscONNFXVgHv3-hjbEE` ("Ai Phil Google Docs") | **Live-wired to `kb_documents`** — any doc here is embedded within 30 min | Phillip only (contamination hazard) `[vault warning in CLAUDE.md]` |
| `docs/superpowers/plans/` in Ai Phil repo | `docs/superpowers/plans/*.md` | Implementation plans (write-plan skill output) | Claude sessions |
| PhilGood OS vaults (5× repos) | `~/Vaults/` symlinks | Constitution, agents.md, wiki, log.md — **not Ai Phil's source of truth** | Mac-mini daemons (cross-stack) `[verified]` |

**Ai Phil does not use a local repo `vault/` directory.** The Explore audit confirmed no such folder exists in the Ai Phil repo; it lives in Shared Drive and is read by humans + Claude sessions via Drive. `[verified]`

### 5.2 Supabase tables relevant to Ai Phil `[verified]`

**public schema** (portal / customer-facing; RLS considered mandatory per CLAUDE.md):
- `kb_documents` — 8 rows (knowledge base)
- `ai_phil_prospects` — 0 rows (discovery captures) `[drift — zero usage]`
- `sync_state`, `sync_runs` — KB sync health
- `people`, `profiles`, `organizations`, `meetings`, `summaries`, `transcripts`, `action_items`, `courses/course_modules/course_progress`, `lessons`, `programs`, `sessions`, `invitees`, `business_units`, `agencies`, `faqs`, `chatbot_configs`, `external_identities`, `nav_items`, `agent_run_evals`, `ai_queries`, `step_events`, `workflow_steps`, `workflows`, `dispatch_queue` — **SAGE-owned** portal tables (shared schema, distinct stack)
- `agent_signals`, `console_*` — PhilGood OS (shared schema, distinct stack)
- `personal_relationships`, `person_organization_relationships` — SAGE CRM layer

**ops schema** (service-role only):
- `ai_inbox_followup_queue` (0 rows), `ai_inbox_conversation_memory`, `contact_rapport` (3 rows), `kb_doc_cache` — Ai Phil RIS Phase 1
- `ghl_convo_triage_runs` (68 last 14d), `ghl_convo_triage_decisions` (53 last 14d) — Ai Phil sales + member agent logs
- `open_tickets` (5 rows), `thread_state`, `email_sender_rules`, `email_rules_cache`, `inbox_triage_*`, `member_vip_contacts` — Emora + cross-stack
- `activity_log`, `agent_registry` — PhilGood OS fleet

### 5.3 Memory

- **Canonical long-term for Ai Phil:** the repo (git history) + Shared Drive vault docs
- **Auto-memory per Claude session:** `~/.claude/projects/<project-id>/memory/` (the MEMORY.md + individual files loaded at session start, as listed above this file in the session context)
- **Runtime per-conversation memory:** `ops.ai_inbox_conversation_memory` (sales + member agents); `ops.contact_rapport` (cross-conversation F.O.R.M. facts)

---

## 6. Shared Infrastructure

### 6.1 Hosting & deploy

- **Next.js app** `ai-phil` → Vercel (verify domain mapping — last URL update commit 2026-04 per SAGE repo); embed loader served as static asset `/public/ai-phil-embed.js` `[source]`
- **Edge functions** → Supabase (project `ylppltmwueasbdexepip`), deployed via MCP `deploy_edge_function` from the Ai Phil repo. Per-function versions in §3. `[verified]`
- **Hume EVI** → hosted by Hume AI; 3 config IDs live; prompts edited manually in Hume dashboard (not git-tracked) `[vault]`

### 6.2 External integrations

| Service | Purpose | Where configured |
|---|---|---|
| Hume AI | EVI voice for widget | env: `HUME_API_KEY`, `HUME_SECRET_KEY`, 3 config IDs |
| GoHighLevel (GHL) | CRM, SMS, email outbound, conversation history | env: GHL API key per location; `ARMyDGKPbnem0Brkxpko` (AIAI location, hardcoded in `ghl-sales-followup`) `[source]` |
| Google Drive API | KB auto-sync (folder `1WvYola…EE`) | edge fn `sync-knowledge-base` v7 |
| Supabase vault | decrypted_secrets for `supabase_anon_key` in pg_cron | correct pattern for jobs 9 only |
| Stripe | **SAGE-owned**, not Ai Phil | — |
| Notion | **PhilGood OS + SAGE-owned** (people-sync loop), not Ai Phil | — |

### 6.3 Secrets surface

- Next.js `.env.local` — public config; runtime secrets loaded from macOS Keychain via `scripts/load-secrets-from-keychain.sh` at dev startup `[source]`
- Supabase vault — `supabase_anon_key` stored in `vault.decrypted_secrets`; used correctly by `sync-ai-phil-docs` cron job
- **Violations:** 4 pg_cron jobs carry **hardcoded tokens in their `command` text** (anon JWT and one service-role-style secret). This is exactly the guardrail called out in CLAUDE.md ("hardcoded anon JWT in a DB trigger function, Apr 15"). It applies to PhilGood-OS-owned jobs but the secret leak is on the shared Supabase project. `[drift]`

---

## 7. Known Drift (Reality ≠ Docs)

**Highest-value section for any AI or human reading this.** The stack moved fast in April; several claims in CLAUDE.md, memories, or Leo CC2's doc don't match live state.

1. **Discovery widget has produced zero prospects.** `public.ai_phil_prospects` has 0 rows ever. Either the widget never writes there, or nobody has used the discovery flow, or captures go to GHL only. The `/discover` page and embed widget are live; no ingestion instrumentation exists. **This is the single biggest measurement gap in the stack.** `[verified]`

2. **Sales-agent has been silent 6 days.** Latest `ghl_convo_triage_decisions` row is 2026-04-12 23:53 UTC. Either no inbound GHL traffic is coming in, or the receiver is dropping it, or the classifier is silently no-op'ing. Requires inspection of `ghl-message-receiver` logs before assuming "quiet on a Monday". `[verified]`

3. **RIS Phase 1 follow-up queue is empty.** `ghl-sales-followup` v2 is deployed; `ghl-sales-followup-hourly` cron is firing every weekday; `ops.ai_inbox_followup_queue` has 0 rows. Nothing has ever been written. The producer (sales-agent post-reply → queue insert) is either not wired or fails silently. `[verified]`

4. **`ghl-sales-followup-hourly` cron is in UTC = 2am–10am Pacific.** Schedule `0 9-17 * * 1-5` is UTC; pg_cron on Supabase does not honor project TZ. Should be `0 16-0 * * 1-5` (PDT) or `0 17-1 * * 1-5` (PST). This exact bug is documented as a CLAUDE.md guardrail and is **still live**. When the queue gets its first row, the follow-up will send in the middle of the night Pacific. `[verified]`

5. **Four pg_cron jobs contain hardcoded tokens in their `command` text** (`email-rules-cache-sync`, `people-sync-n2s`, `people-sync-s2n`, `email-rules-s2n`). Two are anon JWTs, one is an `sb_secret_` token. CLAUDE.md says "No secrets in SQL or source — vault secrets or env vars only." These are live violations. Owned by PhilGood OS side but in the shared project. `[verified]`

6. **Leo CC2's doc cites stale edge-function versions** — claims `gmail-push-handler v14` and `ghl-message-receiver v4`, actually v27 and v17. Minor, but signals that PhilGood OS's "current-state" snapshot needs a refresh pass. `[verified]`

7. **`contact_rapport` has 3 rows after 14 days of live sales-agent traffic.** Either the rapport extractor post-conversation step is not firing, or only a handful of conversations met the extraction trigger. RIS Phase 1 depends on rapport memory to personalize. `[verified]`

8. **Member-agent has no separate instrumentation.** `ghl-member-agent` v3 shipped 2026-04-17 with an identity fix, SMS signature, intent classifier. There is no member-specific triage_decisions table; its traffic likely lands in the same `ghl_convo_triage_*` tables as sales-agent, undifferentiated. Cannot answer "how often did member-agent reply correctly this week" from DB alone. `[drift]`

9. **`reel-assets` Supabase storage bucket is public with broad SELECT policy** (Supabase advisor WARN). This is the output destination for the Automated Reels pipeline — the bucket lists all files. Either intentional (reels are published) or a privacy oversight — depends on whether any reel contains pre-publish material. `[verified]`

10. **Leaked-password protection is disabled on Supabase Auth.** Advisor WARN. SAGE-side concern, but shared project. `[verified]`

11. **14 tables have RLS enabled but no policies** (advisor INFO). For service-role-only ops tables this is correct-by-design, but `public.ai_phil_prospects`, `public.kb_documents`, `public.sync_runs`, `public.sync_state` are all in that list. If anon or authenticated ever needs to read any of them, the app breaks closed. Worth auditing which are intentional. `[verified]`

12. **Two untracked Remotion copies** — `aiai-reel-factory-b/` and `aiai-reel-factory-c/` — sit next to `Automated Reels - Phil Ai/` with no `.git`, no README clarity. Either working copies for A/B experiments or abandoned branches. Cannot tell from FS alone. `[verified]`

13. **Untracked plan in git status:** `docs/superpowers/plans/2026-04-17-member-agent-intent-classifier-fix.md` — suggests an in-flight fix that hasn't been executed or committed. `[verified]`

14. **Voice prompt source-of-truth is split.** Hume dashboard holds live EVI prompts; `_shared/salesVoice.ts` holds the GHL-agent voice block (`AGENCY_BOUNDARIES_BLOCK`, `VOCABULARY_BLOCK`); the Drive vault holds the Voice & Persona Guide (`gdoc 1iu3HA8Ad8e80bqHXGkixIkbQ1G75HwPZ8LEoummDQpo`). **There is no mechanism enforcing these three stay in sync.** A voice-tone change made in Hume will not propagate to SMS/email. `[drift structural]`

---

## 8. Access Summary for an External AI

If you are another Claude Code instance touching this stack (Leo CC2, SAGE, a future agent) here is the minimum you need.

**Read these first (canonical Ai Phil doctrine):**
1. `Coding Projects/Ai Phil/CLAUDE.md` — guardrails + close-out protocol + past mistakes table
2. `Coding Projects/Ai Phil/AGENTS.md` — orientation and vault links
3. This file (current-state snapshot) — what's actually deployed
4. `Coding Projects/Ai Phil/supabase/functions/_shared/salesVoice.ts` — the voice rules that ride with every GHL reply
5. `Coding Projects/Ai Phil/docs/superpowers/plans/*` — open and shipped build plans
6. Shared Drive `AIAI-Vault/60-content/ai-phil/` — brand and voice reference (read-only for agents other than Ai Phil sessions)

**Do not:**
- Add Google Docs to the Drive folder `1WvYoladPakRleEscONNFXVgHv3-hjbEE` unless they are Ai Phil knowledge content (live-wired to `kb_documents` within 30 min — wrong docs = wrong answers to real users)
- Modify live Hume EVI config prompts without explicit Phillip approval (affects active conversations immediately)
- Deploy edge functions from uncommitted working-tree state (guardrail: every `deploy_edge_function` call is followed by `git add`+`git commit` of the same content)
- Disable RLS on `public.ai_phil_prospects`, `kb_documents`, `sync_*` — they are RLS-on intentionally and agents use service-role
- Hardcode secrets in SQL, pg_cron commands, or edge-function source

**Coordinate with Phillip before:**
- Schema migrations (`supabase/migrations/`)
- Brand colors, avatar image, embed contract (`public/ai-phil-embed.js`)
- Any paid-tier change (Hume, OpenAI, HeyGen, ElevenLabs, Galaxy.ai)

---

## 9. Open Questions (to resolve with Phillip)

These are ambiguities this snapshot could not resolve — they block further consolidation planning.

1. **Where DO discovery widget captures land?** `ai_phil_prospects` is empty. Did they ever land anywhere? Are captures going straight to GHL without Supabase mirror? Or has the widget never successfully captured a lead?
2. **Is sales-agent actually quiet, or is `ghl-message-receiver` dropping traffic?** 6 days of silence on a previously-busy pipeline needs a live test (send a test SMS, watch logs).
3. **Who writes into `ai_inbox_followup_queue`?** Is the producer wired (sales-agent post-reply inserts), or is RIS Phase 1 missing its producer step?
4. **Should the 3 Hume EVI configs have prompt versioning / git-tracking?** Currently edited manually in Hume dashboard. Drift risk high.
5. **Are `aiai-reel-factory-b` and `aiai-reel-factory-c` legitimate experiments or stale leftovers?** They're sitting in Drive adjacent to the canonical reels repo.
6. **Is `reel-assets` bucket supposed to be publicly listable?** Or should it be authenticated?
7. **Is the hardcoded-secret pg_cron cleanup (jobs 1, 4, 5, 6) a Leo CC2 task or an Ai Phil task?** They're in the shared project. Ownership unclear.
8. **Should `_shared/salesVoice.ts`, Hume prompts, and Voice & Persona Guide be consolidated under one source?** Current split makes voice-tone drift inevitable.
9. **Member-agent performance visibility:** what's the plan to separate sales-agent vs. member-agent metrics? Shared `ghl_convo_triage_*` tables make a/b impossible.
10. **What's the 95%-autonomous target actually measuring?** Reply-send rate? Escalation rate? Phil-time hours? Without a metric we can't tell if we're approaching it.

---

## See Also

- **PhilGood OS current-state (parallel doc):** gdoc `18pZDmKpx5uOV6ou0uAzszRQEIzTgx7svv3cOUYcuqXQ` — Leo CC2, 2026-04-18
- **SAGE CLAUDE.md:** `Coding Projects/SAGE - Screen Aware Guided Experience/CLAUDE.md`
- **Automated Reels ROADMAP:** `Coding Projects/Automated Reels - Phil Ai/` (root ROADMAP.md)
- **Ai Phil roadmap:** Shared Drive `AIAI-Vault/60-content/ai-phil/_ROADMAP.md`
- **Ai Phil Brain (master knowledge doc, live-synced to KB):** gdoc `1fYqPpSxkqX5Yi1yvTVFTX98NZmb7FbdkQ9CsoDZ5n5Q`
- **Voice & Persona Guide (live-synced to KB):** gdoc `1iu3HA8Ad8e80bqHXGkixIkbQ1G75HwPZ8LEoummDQpo`
