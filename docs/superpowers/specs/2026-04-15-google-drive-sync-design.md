# Design: Google Drive → AI Phil Knowledge Base Auto-Sync

**Date:** 2026-04-15  
**Status:** Approved, ready for implementation  
**Replaces:** n8n "Google Drive Watcher" workflow (broken — binary data extraction bug in Code node)  
**Roadmap item:** P1 — Fix n8n Google Drive auto-sync

---

## Problem

Every content edit to the AI Phil Google Docs (folder `1WvYoladPakRleEscONNFXVgHv3-hjbEE`) requires manually re-running the bootstrap script. The n8n workflow that was supposed to automate this has a binary data extraction bug in its Code node that has not been worth debugging.

## Goal

Edit any doc in `60-content/Ai Phil Google Docs/` → within 30 minutes (or immediately on demand) it's live in Phil's answers with no human intervention.

---

## Approach: Supabase Scheduled Edge Function + Manual Trigger

Chosen over:
- **Debugging n8n** — opaque bug, n8n adds ongoing operational overhead
- **Vercel Cron + Next.js route** — Vercel free tier limits, 10s function timeout risk on multi-doc syncs
- **Google Drive Push Notifications** — requires webhook channel management + expiry renewal

---

## Architecture

```
pg_cron (every 30 minutes)
  → sync-knowledge-base  [Supabase edge function]
      1. Insert row into sync_runs (started_at, trigger='cron')
      2. Read last_synced_at from sync_state
      3. Drive API v3: list files in folder modified after last_synced_at
      4. For each changed file:
           a. Export content as text/plain via Drive files.export
           b. Call ingest-document edge function (handles chunking + embeddings)
              — ingest-document checks content_hash; skips if unchanged
           c. Log result to sync_runs
      5. new_synced = max(file.modifiedTime) across all files processed,
         or last_synced if no files changed  ← race-proof, uses Drive's own clock
      6. Update sync_state and close sync_runs row (completed_at, duration_ms)
      7. Return { synced, skipped, errors, files: [...] }

Manual trigger (on-demand)
  → POST /api/admin/sync-docs  [Next.js route in ai-phil repo]
      Header: x-sync-secret: <SYNC_ADMIN_SECRET>
      → supabase.functions.invoke('sync-knowledge-base', { trigger: 'manual' })
      → returns sync summary
```

---

## Components

### 1. Migration: `sync_state` table

```sql
CREATE TABLE public.sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed: picks up all files on first run
INSERT INTO public.sync_state (key, value)
VALUES ('ai_phil_docs_last_synced', '2024-01-01T00:00:00Z');
```

RLS: service-role only (same pattern as `kb_documents`).

### 2. Migration: `sync_runs` table

Observability row written at start of every sync, closed at end. Makes silent failures visible.

```sql
CREATE TABLE public.sync_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  trigger        TEXT NOT NULL,           -- 'cron' | 'manual'
  files_seen     INT NOT NULL DEFAULT 0,
  files_synced   INT NOT NULL DEFAULT 0,
  files_skipped  INT NOT NULL DEFAULT 0,  -- hash unchanged, no re-embed
  files_errored  INT NOT NULL DEFAULT 0,
  error_details  JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_ms    INT
);
```

Query `SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 10` for health at a glance.

### 3. Migration: pg_cron schedule

Committed to version control. Contains no secrets — the service role key is read from
`vault.decrypted_secrets` at runtime. Requires a `service_role_key` entry in Supabase Vault
(one-time setup step documented below).

```sql
-- Requires: pg_net and pg_cron extensions enabled (both on by default in Supabase)
-- Requires: vault.decrypted_secrets entry named 'service_role_key'
SELECT cron.schedule(
  'sync-ai-phil-docs',
  '*/30 * * * *',  -- every 30 minutes
  $$
    SELECT net.http_post(
      url     := 'https://ylppltmwueasbdexepip.supabase.co/functions/v1/sync-knowledge-base',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
          FROM   vault.decrypted_secrets
          WHERE  name = 'service_role_key'
        )
      ),
      body    := '{"trigger":"cron"}'::jsonb
    ) AS request_id;
  $$
);
```

### 4. `sync-knowledge-base` edge function

**Location:** `supabase/functions/sync-knowledge-base/index.ts`

**Responsibilities:**
- Authenticate with Google Drive via service account JWT. Scope: `https://www.googleapis.com/auth/drive.readonly`
- List files in folder `1WvYoladPakRleEscONNFXVgHv3-hjbEE` with `modifiedTime > last_synced_at`
- Export each file as `text/plain` via `files.export`
- Call `ingest-document` per file with `{ doc_id, title, content, source_type: 'google_doc' }`
  - `ingest-document` is responsible for content-hash dedup (see below)
- Timestamp pivot (race-proof): `new_synced = max(file.modifiedTime for file in files) || last_synced`
- On transient failures (HTTP 429/503 from OpenAI inside ingest-document): one exponential-backoff retry (250ms → 1s → give up)
- Log duration and status to `sync_runs`
- Hard limit: if total wall-clock > 120s, abort remaining files and mark them as errors

**Google auth:** Service account JWT minted from `GOOGLE_SERVICE_ACCOUNT_KEY` Supabase secret.

### 5. `ingest-document` edge function — content-hash dedup (modification to existing function)

Before deleting and re-inserting chunks, compute `SHA-256(content)` and compare against
`kb_documents.content_hash` for the same `source_path`. If identical: return `{ status: 'skipped' }`.
If different (or no existing row): proceed with chunking + re-embedding as today.

This is an edit to the existing `ingest-document` function. The `kb_documents` table already stores
`content_hash` (verify schema; add column if missing).

### 6. `/api/admin/sync-docs` Next.js route

**Location:** `src/app/api/admin/sync-docs/route.ts`

**Auth:** `x-sync-secret` header must match `SYNC_ADMIN_SECRET` env var. Returns 401 otherwise.

**Behavior:** Calls `supabase.functions.invoke('sync-knowledge-base', { body: { trigger: 'manual' } })`
and proxies the JSON response.

---

## Google Cloud Setup (one-time, manual)

The existing GCP project `aiai-n8n-integration` is reused. The OAuth web client credential
(`aiai n2n Client Secret JSON from Google Cloud.json`) is **not** used — that's for n8n's
browser-based OAuth flow and a different credential type.

Steps:
1. GCP Console → `aiai-n8n-integration` → IAM & Admin → Service Accounts → Create service account
   name: `ai-phil-drive-reader`
2. No GCP project IAM roles needed (Drive access is granted at folder level, not project level)
3. Create + download JSON key for the service account
4. Share Drive folder `1WvYoladPakRleEscONNFXVgHv3-hjbEE` with the service account email — **Viewer** role
5. Store JSON key as Supabase secret: `GOOGLE_SERVICE_ACCOUNT_KEY`
6. Store the project's service role key in Supabase Vault:
   Supabase Dashboard → Vault → New secret → name: `service_role_key`, value: `<service_role_key>`

---

## Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Supabase secret | JSON key for Drive API auth |
| `SYNC_ADMIN_SECRET` | Vercel env var + Supabase secret | Protects the manual trigger endpoint |
| `SUPABASE_SERVICE_ROLE_KEY` | Already exists | Used by edge function to write sync_state + call ingest-document |
| `service_role_key` | Supabase Vault | Read by pg_cron at runtime to auth the HTTP call |

---

## Error Handling

- **Single file failure:** Log `{ file_id, title, error }` to `sync_runs.error_details`, increment `files_errored`, continue
- **Drive API auth failure:** Abort immediately, close `sync_runs` row with error, return 500
- **ingest-document 429/503:** One retry with exponential backoff (250ms → 1s). If still failing, count as error
- **sync_state update failure:** Log warning; next run will re-process files (their `modifiedTime` unchanged)
- **Wall-clock > 120s:** Abort remaining files, log as errors — stays well within Supabase's 150s limit

---

## What Is Not in Scope (v1)

- **Deletions:** Removed docs stay in `kb_documents`. Handle manually via bootstrap reset if needed.
- **New files:** Handled automatically — creation time is `modifiedTime`, picked up on next sync.
- **Multi-folder support:** Folder access is **positive-list only** — if a new Drive folder is added later, the service account email must be explicitly shared with it. This is intentional (explicit access).

---

## Definition of Done

- Edit any doc in `60-content/Ai Phil Google Docs/` → within 30 minutes it appears in Phil's answers
- Unedited docs produce `files_skipped` entries (no wasted embedding calls)
- `POST /api/admin/sync-docs` with correct secret → immediate sync, returns file-by-file summary
- A single broken doc does not stop other docs from syncing
- `sync_runs` table shows every run with timing and outcome
- n8n "Google Drive Watcher" workflow is **disabled** in the n8n UI (not just broken — disabled)

---

## Operational Notes

- **Service account key rotation:** Rotate `GOOGLE_SERVICE_ACCOUNT_KEY` annually, or immediately if anyone with GCP project access departs
- **Folder access is positive-list:** Adding a new Drive folder to the content set requires sharing it with the service account email — this is a feature, not a limitation
- **n8n disposition:** Disable the broken watcher in the n8n UI. "Harmless broken" still accumulates noise in n8n logs. 30 seconds to disable.
- **Monitoring:** Query `SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 10` to verify health. Consider adding a Supabase alert or Discord webhook if `files_errored > 0`.

---

## Files Touched

**New:**
- `supabase/functions/sync-knowledge-base/index.ts`
- `supabase/migrations/YYYYMMDD_sync_state.sql`
- `supabase/migrations/YYYYMMDD_sync_runs.sql`
- `supabase/migrations/YYYYMMDD_sync_cron.sql`
- `src/app/api/admin/sync-docs/route.ts`

**Modified:**
- `supabase/functions/ingest-document/index.ts` — add content-hash dedup before re-embedding

**Not touched:**
- `kb_documents` table schema (unless `content_hash` column is missing — verify first)
- Any widget or API route code
