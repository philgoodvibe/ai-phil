# Design: Google Drive → AI Phil Knowledge Base Auto-Sync

**Date:** 2026-04-15  
**Status:** Approved, ready for implementation  
**Replaces:** n8n "Google Drive Watcher" workflow (broken — binary data extraction bug in Code node)  
**Roadmap item:** P1 — Fix n8n Google Drive auto-sync

---

## Problem

Every content edit to the AI Phil Google Docs (folder `1WvYoladPakRleEscONNFXVgHv3-hjbEE`) requires manually re-running the bootstrap script. The n8n workflow that was supposed to automate this has a binary data extraction bug in its Code node that has not been worth debugging.

## Goal

Edit any doc in `60-content/Ai Phil Google Docs/` → within 4 hours (or immediately on demand) it's live in Phil's answers with no human intervention.

---

## Approach: Supabase Scheduled Edge Function + Manual Trigger

Chosen over:
- **Debugging n8n** — opaque bug, n8n adds ongoing operational overhead, user not attached to it
- **Vercel Cron + Next.js route** — Vercel free tier limits, 10s function timeout risk on multi-doc syncs
- **Google Drive Push Notifications** — requires webhook channel management + expiry renewal

---

## Architecture

```
pg_cron (every 4 hours)
  → sync-knowledge-base  [Supabase edge function]
      1. Read last_synced_at from sync_state table
      2. Drive API v3: list files in folder modified after last_synced_at
      3. For each changed file:
           a. Export content as text/plain via Drive files.export
           b. Call existing ingest-document edge function
      4. Write new last_synced_at to sync_state
      5. Return { synced: N, errors: N, files: [...] }

Manual trigger (on-demand)
  → POST /api/admin/sync-docs  [Next.js route in ai-phil repo]
      Header: x-sync-secret: <SYNC_ADMIN_SECRET>
      → supabase.functions.invoke('sync-knowledge-base')
      → returns sync summary
```

---

## Components

### 1. Supabase migration: `sync_state` table

```sql
CREATE TABLE public.sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed: on first run, pick up all files
INSERT INTO public.sync_state (key, value)
VALUES ('ai_phil_docs_last_synced', '2024-01-01T00:00:00Z');
```

RLS: service-role only (same pattern as `kb_documents`).

### 2. Supabase migration: pg_cron schedule

The schedule is registered via the Supabase dashboard SQL Editor (not committed in a migration file — the service role key must not be checked into git).

Run once in the Supabase SQL Editor after deploy:

```sql
SELECT cron.schedule(
  'sync-ai-phil-docs',
  '0 */4 * * *',   -- every 4 hours
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
      body    := '{}'::jsonb
    ) AS request_id;
  $$
);
```

### 3. `sync-knowledge-base` edge function

**Location:** `supabase/functions/sync-knowledge-base/index.ts`

**Responsibilities:**
- Authenticate with Google Drive using a service account JWT (no OAuth browser flow, no token expiry)
- List files in folder `1WvYoladPakRleEscONNFXVgHv3-hjbEE` modified after `last_synced_at`
- Export each file as `text/plain` via `files.export`
- For each file, call the existing `ingest-document` edge function with `{ doc_id, title, content, source_type: 'google_doc' }`
- If a file fails: log the error, continue (never abort the whole sync)
- On completion: update `sync_state.value` to the timestamp at the start of this run (not end — avoids missing files edited during the run)
- Return `{ synced: N, errors: N, files: [{ id, title, status }] }`

**Google auth:** Service account JWT minted from `GOOGLE_SERVICE_ACCOUNT_KEY` secret (JSON key stored in Supabase secrets). Scope: `https://www.googleapis.com/auth/drive.readonly`.

### 4. `/api/admin/sync-docs` Next.js route

**Location:** `src/app/api/admin/sync-docs/route.ts`

**Auth:** `x-sync-secret` header must match `SYNC_ADMIN_SECRET` env var. Returns 401 otherwise.

**Behavior:** Calls `supabase.functions.invoke('sync-knowledge-base')` and proxies the response. Supports both scheduled (passthrough) and manual trigger patterns.

---

## Google Cloud Setup (one-time, manual)

The existing GCP project `aiai-n8n-integration` is reused. The OAuth web client credential in Downloads is **not** used — that's for n8n's browser-based OAuth flow.

Steps:
1. GCP Console → `aiai-n8n-integration` → IAM & Admin → Service Accounts → Create service account (`ai-phil-drive-reader`)
2. No GCP project roles needed (Drive access is granted at the file/folder level, not IAM)
3. Create + download JSON key
4. Share Drive folder `1WvYoladPakRleEscONNFXVgHv3-hjbEE` with the service account email (Viewer role)
5. Store the JSON key as Supabase secret: `GOOGLE_SERVICE_ACCOUNT_KEY`

---

## Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Supabase secret | JSON key for Drive API auth |
| `SYNC_ADMIN_SECRET` | Vercel env var | Protects the manual trigger endpoint |
| `SUPABASE_SERVICE_ROLE_KEY` | Already exists | Used by edge function to update sync_state + call ingest-document |

---

## Error Handling

- **Single file failure:** Log `{ file_id, title, error }`, increment error counter, continue to next file
- **Drive API auth failure:** Return 500 immediately with error details (nothing to partially succeed)
- **ingest-document failure:** Same as single file failure — log and continue
- **sync_state update failure:** Log warning but do not retry (next scheduled run will re-process any files missed)

---

## What Is Not in Scope (v1)

- **Deletions:** If a doc is removed from the folder, its chunks remain in `kb_documents`. Acceptable — deletions are rare and can be handled manually via the existing bootstrap script reset.
- **New files added to folder:** Handled automatically — `modifiedTime` on a new file is its creation time, so it will be picked up on the next sync.
- **Retry logic:** Failed files will be retried on the next scheduled run (their `modifiedTime` won't change, so they'll be re-attempted).

---

## Definition of Done

- Edit any doc in `60-content/Ai Phil Google Docs/` → within 4 hours it appears in Phil's answers
- `POST /api/admin/sync-docs` with the correct secret → sync runs immediately, returns a file-by-file summary
- A single broken doc does not prevent other docs from syncing
- `sync_state.value` updates after every successful run
- n8n workflow can be disabled (or left alone — it's harmless broken)

---

## Files Touched

**New:**
- `supabase/functions/sync-knowledge-base/index.ts`
- `supabase/migrations/YYYYMMDD_sync_state.sql`
- `supabase/migrations/YYYYMMDD_sync_cron.sql`
- `src/app/api/admin/sync-docs/route.ts`

**Not touched:**
- `ingest-document` edge function (called as-is)
- `kb_documents` table (written to by ingest-document, not by this feature)
- Any widget or API route code
