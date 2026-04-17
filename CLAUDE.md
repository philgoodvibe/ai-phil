# CLAUDE.md — ai-phil

**Read `AGENTS.md` first.** This file adds behavioral rules for Claude Code sessions. `AGENTS.md` covers orientation, ownership, vault links, and deployment. This file covers conventions and guardrails.

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
