# AGENTS.md — ai-phil

**Read this file first** if you are a Claude Code session (or any AI agent) working in this repo. It exists to prevent silos — AI Phil's strategy, roadmap, and design decisions live in the AIAI-Mastermind vault, not in this codebase.

---

## 🔴 READ AT BOOT — Standing Orders + Architecture

Before acting on any Phillip-proposed tool/method/framework, read in order:

1. **Working-With-Phillip — Standing Orders** (RED tier, canonical for how every session works): https://drive.google.com/file/d/1Lsbx1KR1fFAj308qB_gLAfdszJ_JxueY/view — intake protocol (treat proposals as CANDIDATES, 2–4 option survey with his proposal labeled, "Recommend X because Y" first line), pushback standard, decision-lock, recommendation format.
2. **`_system/architecture.md`** (True North, 3 KPIs, 5 Non-Negotiables, build order): https://drive.google.com/file/d/1FrLGjuQz400cORLlwU0qisz9ZdJoOba3/view
3. **`10-company/Positioning-V1-LOCKED.md`** + **`70-decisions/`** DR folder: https://drive.google.com/drive/folders/1qvEj818sFuhAh3jSYgl68_GcPO7UpFPn

If the task doesn't move one of the 3 KPIs, name that first and ask whether to cut/defer/rescope. **`_shared/salesVoice.ts` is the ONLY voice source (NN #1) — every AI Phil surface reads it at boot; Hume EVI prompts sync from it.**

---

## What this repo is

**ai-phil** is the standalone, embeddable voice + chat coaching widget for AIAI Mastermind (Phillip Ngo's insurance agent program). It runs on Hume EVI (emotional voice AI), is backed by a Supabase pgvector knowledge base, and drops into any website with a one-line `<script>` tag.

Production host: `https://ai-phil.vercel.app`
GitHub: `github.com/philgoodvibe/ai-phil`

---

## 🧭 Before starting ANY significant work, read these vault docs

The vault is at:
```
/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/Shared drives/AiAi Mastermind/01_Knowledge Base/AIAI-Vault/
```

**Must-read before touching anything important:**

1. **`80-processes/Agent-Coordination.md`** — how agents + vault + repos coordinate (this pattern)
2. **`30-products/AI-Phil.md`** — product spec for Phil (who he serves, how)
3. **`60-content/ai-phil/_ROADMAP.md`** — live PM board (priorities, shipped, parked, known issues)
4. **`10-company/Automation-Roadmap.md`** — how Phil fits the bigger automation vision

**Read as needed:**

- `60-content/ai-phil/_MEMORY-DESIGN.md` — if working on persistent memory
- `60-content/Ai Phil Google Docs/AI Phil — Voice & Persona Guide.gdoc` — if tuning personality
- `60-content/Ai Phil Google Docs/AI Phil Brain — Master Knowledge Document.gdoc` — if debugging answer quality
- `70-decisions/DR-*.md` — past decisions (don't re-debate without new evidence)

---

## What THIS repo owns

- **Widget UI** — `src/components/ai-phil-widget.tsx` (React + framer-motion + Tailwind)
- **Embed public routes** — `src/app/embed/ai-phil/` (iframe target) and `src/app/discover/` (landing)
- **API proxies to Hume** — `src/app/api/hume/access-token/`, `search-kb/`, `book-discovery-call/`
- **Embed loader** — `public/ai-phil-embed.js` (the one-line `<script>` that injects the iframe)
- **Brand assets** — `public/ai-phil-avatar.jpg`
- **Scripts** — `scripts/*.ts` (ingestion, eval, test clients — some not yet migrated from SAGE)
- **Drive sync** — `supabase/functions/sync-knowledge-base/` (edge function), `supabase/migrations/` (sync_state, sync_runs, pg_cron schedule), `src/app/api/admin/sync-docs/` (manual trigger)
- **Deployment config** — `next.config.js` (CORS + frame-ancestors), `vercel.json` if present

## What this repo CONSUMES (shared, do NOT duplicate)

- **Supabase project `ylppltmwueasbdexepip`** — tables `kb_documents`, `ai_phil_prospects`, `sync_state`, `sync_runs` and edge functions `search-knowledge-base`, `ingest-document`, `hume-admin`, `sync-knowledge-base`
- **Hume EVI** — 3 configs (New Member / Implementation Coach / Discovery), 2 tools, 1 custom voice ("Philip Voice"). Manage via `https://app.hume.ai` or the `hume-admin` Supabase edge function.
- **Knowledge source** — Google Docs folder `60-content/Ai Phil Google Docs/` in the vault (Drive folder ID: `1WvYoladPakRleEscONNFXVgHv3-hjbEE`). Edit there, the `sync-knowledge-base` Supabase edge function syncs to `kb_documents` every 30 minutes automatically.
  - ⚠️ **LIVE SYNC — WRITES GO DIRECTLY INTO PHIL'S BRAIN.** Any Google Doc placed in this folder is automatically embedded into Phil's knowledge base within 30 minutes. Do NOT put docs for other projects (Lea, GHL bots, etc.) in this folder. Wrong docs = Phil gives wrong answers to real users.

---

## How to run locally

```bash
# in this repo
npm install
npm run dev            # → http://localhost:3000
npm run build          # production build
npm run typecheck      # tsc --noEmit
```

Env vars live in `.env.local` (not committed). Copy from Vercel → Settings → Environment Variables if you need to set them up fresh.

---

## How to deploy

Git-based. Push to `main` → Vercel auto-deploys.

```bash
git push origin main
# Vercel picks it up. Build logs at:
# https://vercel.com/philgoodvibes-projects/ai-phil
```

Production URL: `https://ai-phil.vercel.app`

---

## Quick test URLs

After starting the dev server:

| Purpose | URL |
|---|---|
| Discovery landing | http://localhost:3000/discover |
| Widget iframe (discovery) | http://localhost:3000/embed/ai-phil?context=discovery |
| Widget iframe (implementation) | http://localhost:3000/embed/ai-phil?context=implementation |
| Chat-only mode | http://localhost:3000/embed/ai-phil?context=discovery&mode=chat |
| Loader script | http://localhost:3000/ai-phil-embed.js |

Production equivalents swap `http://localhost:3000` → `https://ai-phil.vercel.app`.

---

## Current phase

**Phase 5: Post-migration feature work.** The standalone extraction is complete. Priorities (in [[_ROADMAP]] order):

1. ~~Fix n8n Google Drive auto-sync~~ — **SHIPPED 2026-04-15.** Replaced with Supabase edge function + pg_cron. See `supabase/functions/sync-knowledge-base/`.
2. Build eval harness (answer quality regression protection) ← **next up**
3. Implement persistent memory (see `_MEMORY-DESIGN.md`)
4. Add Implementation Coach tools (lookup_member_status, schedule_meeting, etc.)
5. Observability layer

---

## Responsibilities when you ship something

Per `80-processes/Agent-Coordination.md`:

1. Update `60-content/ai-phil/_ROADMAP.md` — move the item from Priorities → Shipped with a date
2. If you made a major technical decision, write a `70-decisions/DR-YYYYMMDD-*.md`
3. Write a 3-5 line session summary to `50-meetings/` (or `50-sessions/` if it exists) — title format: `🔧 Short Description` using the emoji convention in `Agent-Coordination.md §6`

Don't skip this — future sessions rely on it.

---

## Things NOT to change without approval

- Supabase schema (new migrations require human review — Phillip's call)
- Hume EVI config prompts that are already live (each change ships to all current conversations)
- Any paid service tier bump
- The embed API contract (data-context / data-mode / URL params) — external sites depend on it
- Core brand colors or the avatar image without a brand discussion

---

## Escalate to Phillip when

- You're blocked on a dependency outside the repo (GHL API credentials, Google Cloud project settings, etc.)
- You think a priority in the roadmap is wrong
- You hit a bug that affects live users (rollback first, then escalate)
- A cost pattern is changing in a meaningful way (Hume minutes, Claude tokens, Supabase compute)

---

## See also

- Vault: `/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/Shared drives/AiAi Mastermind/01_Knowledge Base/AIAI-Vault/`
- SAGE (portal that embeds this widget): `~/My Drive/Coding Projects/SAGE - Screen Aware Guided Experience/`
- Supabase dashboard: https://supabase.com/dashboard/project/ylppltmwueasbdexepip
- Hume dashboard: https://app.hume.ai
- Vercel dashboard: https://vercel.com/philgoodvibes-projects/ai-phil
