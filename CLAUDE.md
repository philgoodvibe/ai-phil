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

## TypeScript conventions

- **Strict mode** — `tsc --noEmit` must pass before any commit. Run `npm run typecheck`.
- No `any`. Use proper types or `unknown` with a type guard.
- React components in `.tsx`, pure logic in `.ts`.
- Use `cn()` from `src/lib/cn.ts` for conditional Tailwind classes.
- Server components by default in `app/`; add `"use client"` only when needed (event handlers, hooks, Hume SDK).
- API routes live in `src/app/api/`. Keep them thin — logic in lib files if it grows.

## Supabase conventions

- DB columns are `snake_case`. TypeScript interfaces mirror that (don't camelCase on the TS side unless through a transform layer).
- Supabase project: `ylppltmwueasbdexepip`
- For server-side queries use `supabase-server.ts`; for client-side use the Supabase client from `@supabase/ssr`.
- **No schema migrations without Phillip's review.** Draft the SQL and pause.

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
