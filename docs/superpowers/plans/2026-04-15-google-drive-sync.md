# Google Drive → KB Auto-Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken n8n Google Drive Watcher with a Supabase scheduled edge function that syncs changed docs to `kb_documents` every 30 minutes, with a secret-protected manual trigger endpoint.

**Architecture:** A new `sync-knowledge-base` Supabase edge function polls Google Drive for files modified since `last_synced_at`, skips unchanged docs via content-hash dedup stored in `sync_state`, calls the existing `ingest-document` function for changed docs, and records every run in `sync_runs` for observability. A Next.js route at `/api/admin/sync-docs` invokes the function on demand.

**Tech Stack:** Deno (Supabase edge function), Google Drive API v3, Web Crypto API (RSA-SHA256 JWT), Supabase pg_cron + pg_net, Next.js 14 App Router

---

## Live Infrastructure (read before touching anything)

- Supabase project: `ylppltmwueasbdexepip`
- Drive folder to watch: `1WvYoladPakRleEscONNFXVgHv3-hjbEE`
- `source_path` convention already in `kb_documents`: `gdoc:{fileId}`
- `ingest-document` auth: `x-tool-secret` header matching `HUME_TOOL_SECRET` secret
- Auto-available env vars in all edge functions: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
- `HUME_TOOL_SECRET` and `OPENAI_API_KEY` already set as Supabase secrets (used by `ingest-document`)

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `supabase/config.toml` | Create | Links CLI to the project ref |
| `supabase/migrations/20260415000000_sync_state.sql` | Create | `sync_state` key-value table + seed row |
| `supabase/migrations/20260415000001_sync_runs.sql` | Create | `sync_runs` observability table |
| `supabase/migrations/20260415000002_sync_cron.sql` | Create | pg_cron schedule (reads key from Vault) |
| `supabase/functions/sync-knowledge-base/index.ts` | Create | Main sync edge function |
| `src/app/api/admin/sync-docs/route.ts` | Create | Manual trigger Next.js route |

---

## Task 1: Initialize Supabase Directory + Write Migrations

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/migrations/20260415000000_sync_state.sql`
- Create: `supabase/migrations/20260415000001_sync_runs.sql`
- Create: `supabase/migrations/20260415000002_sync_cron.sql`

- [ ] **Step 1: Create `supabase/config.toml`**

```toml
[api]
enabled = true

[db]
port = 54322

[studio]
enabled = true

[auth]
enabled = true

# Links this local directory to the remote project
project_id = "ylppltmwueasbdexepip"
```

- [ ] **Step 2: Write sync_state migration**

Create `supabase/migrations/20260415000000_sync_state.sql`:

```sql
-- sync_state: general key-value store for sync bookmarks and doc content hashes
CREATE TABLE public.sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: service-role only (same pattern as kb_documents)
ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;

-- Seed: sentinel date so first run picks up all existing docs
INSERT INTO public.sync_state (key, value)
VALUES ('ai_phil_docs_last_synced', '2024-01-01T00:00:00Z')
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 3: Write sync_runs migration**

Create `supabase/migrations/20260415000001_sync_runs.sql`:

```sql
-- sync_runs: one row per sync execution; provides observability
CREATE TABLE public.sync_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  trigger        TEXT NOT NULL CHECK (trigger IN ('cron', 'manual')),
  files_seen     INT NOT NULL DEFAULT 0,
  files_synced   INT NOT NULL DEFAULT 0,
  files_skipped  INT NOT NULL DEFAULT 0,
  files_errored  INT NOT NULL DEFAULT 0,
  error_details  JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_ms    INT
);

-- RLS: service-role only
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;

-- Index for fast "show me recent runs" queries
CREATE INDEX sync_runs_started_at_idx ON public.sync_runs (started_at DESC);
```

- [ ] **Step 4: Write pg_cron migration**

Create `supabase/migrations/20260415000002_sync_cron.sql`:

```sql
-- Schedules sync-knowledge-base every 30 minutes via pg_cron + pg_net.
-- Requires: vault.decrypted_secrets entry named 'service_role_key' (one-time manual setup).
-- To verify vault entry exists: SELECT name FROM vault.decrypted_secrets WHERE name = 'service_role_key';
-- To create it if missing: SELECT vault.create_secret('<SERVICE_ROLE_KEY_VALUE>', 'service_role_key');
SELECT cron.schedule(
  'sync-ai-phil-docs',
  '*/30 * * * *',
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

- [ ] **Step 5: Apply the two table migrations via Supabase MCP**

Apply `sync_state` migration:
```sql
-- paste contents of 20260415000000_sync_state.sql into Supabase MCP apply_migration
```

Apply `sync_runs` migration:
```sql
-- paste contents of 20260415000001_sync_runs.sql into Supabase MCP apply_migration
```

Do NOT apply the cron migration yet — it requires the Vault entry to exist first (Task 6).

- [ ] **Step 6: Verify tables exist**

Run in Supabase SQL Editor or MCP:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('sync_state', 'sync_runs');
```

Expected: 2 rows.

```sql
SELECT key, value FROM sync_state;
```

Expected: `('ai_phil_docs_last_synced', '2024-01-01T00:00:00Z')`

- [ ] **Step 7: Commit**

```bash
git add supabase/
git commit -m "feat: add sync_state, sync_runs tables and pg_cron migration"
```

---

## Task 2: Write `sync-knowledge-base` Edge Function

**Files:**
- Create: `supabase/functions/sync-knowledge-base/index.ts`

This function is the core of the feature. It is written in Deno TypeScript and deployed to Supabase.

- [ ] **Step 1: Create the file**

Create `supabase/functions/sync-knowledge-base/index.ts` with the full implementation:

```typescript
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Config ────────────────────────────────────────────────────────────────

const FOLDER_ID = "1WvYoladPakRleEscONNFXVgHv3-hjbEE";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HUME_TOOL_SECRET = Deno.env.get("HUME_TOOL_SECRET")!;
const GOOGLE_SA_KEY = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY")!);

// ─── Helpers ────────────────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64Url(input: string | ArrayBuffer): string {
  const str =
    typeof input === "string"
      ? input
      : String.fromCharCode(...new Uint8Array(input));
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 1,
  delayMs = 250,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (retries === 0) throw e;
    await new Promise((r) => setTimeout(r, delayMs));
    return withRetry(fn, retries - 1, delayMs * 4);
  }
}

// ─── Google Auth ─────────────────────────────────────────────────────────────

async function getGoogleAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: GOOGLE_SA_KEY.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const signingInput =
    `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;

  // Parse PKCS8 PEM key
  const pemContents = GOOGLE_SA_KEY.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");
  const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  const jwt = `${signingInput}.${toBase64Url(signature)}`;

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    throw new Error(`Google auth failed (${tokenResp.status}): ${err}`);
  }

  const { access_token } = await tokenResp.json();
  return access_token;
}

// ─── Drive API ───────────────────────────────────────────────────────────────

interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
  mimeType: string;
}

async function listModifiedFiles(
  accessToken: string,
  since: string,
): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: `'${FOLDER_ID}' in parents and modifiedTime > '${since}' and trashed = false and mimeType = 'application/vnd.google-apps.document'`,
    fields: "files(id,name,modifiedTime,mimeType)",
    orderBy: "modifiedTime asc",
    pageSize: "100",
  });

  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Drive list failed (${resp.status}): ${err}`);
  }

  const data = await resp.json();
  return (data.files as DriveFile[]) || [];
}

async function exportFileAsText(
  accessToken: string,
  fileId: string,
): Promise<string> {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Drive export failed for ${fileId} (${resp.status}): ${err}`);
  }

  return resp.text();
}

// ─── Run Tracking ────────────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof createClient>;

interface RunStats {
  filesSeen: number;
  filesSynced: number;
  filesSkipped: number;
  filesErrored: number;
  errorDetails: Array<{ file_id: string; title: string; error: string }>;
  startedAt: number;
}

async function openRun(
  supabase: SupabaseClient,
  trigger: string,
): Promise<string | undefined> {
  const { data } = await supabase
    .from("sync_runs")
    .insert({ trigger, started_at: new Date().toISOString() })
    .select("id")
    .single();
  return data?.id;
}

async function closeRun(
  supabase: SupabaseClient,
  runId: string | undefined,
  stats: RunStats,
): Promise<void> {
  if (!runId) return;
  await supabase
    .from("sync_runs")
    .update({
      completed_at: new Date().toISOString(),
      files_seen: stats.filesSeen,
      files_synced: stats.filesSynced,
      files_skipped: stats.filesSkipped,
      files_errored: stats.filesErrored,
      error_details: stats.errorDetails,
      duration_ms: Date.now() - stats.startedAt,
    })
    .eq("id", runId);
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const startedAt = Date.now();
  const body = req.method === "POST"
    ? await req.json().catch(() => ({}))
    : {};
  const trigger: string = body.trigger ?? "cron";

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const runId = await openRun(supabase, trigger);

  const stats: RunStats = {
    filesSeen: 0,
    filesSynced: 0,
    filesSkipped: 0,
    filesErrored: 0,
    errorDetails: [],
    startedAt,
  };

  const fileResults: Array<{ id: string; title: string; status: string }> = [];

  try {
    // 1. Read last_synced_at
    const { data: stateRow } = await supabase
      .from("sync_state")
      .select("value")
      .eq("key", "ai_phil_docs_last_synced")
      .single();
    const lastSynced = stateRow?.value ?? "2024-01-01T00:00:00Z";

    // 2. Authenticate with Google Drive
    const accessToken = await getGoogleAccessToken();

    // 3. List files modified since last sync
    const files = await listModifiedFiles(accessToken, lastSynced);
    stats.filesSeen = files.length;

    if (files.length === 0) {
      await closeRun(supabase, runId, stats);
      return Response.json({ synced: 0, skipped: 0, errors: 0, files: [] });
    }

    // Timestamp pivot: use max(modifiedTime) from Drive's own clock (race-proof)
    let latestModifiedTime = lastSynced;

    for (const file of files) {
      // Abort if approaching Supabase's 150s wall-clock limit
      if (Date.now() - startedAt > 120_000) {
        console.warn("[sync-kb] Approaching wall-clock limit — aborting remaining files");
        stats.filesErrored++;
        stats.errorDetails.push({
          file_id: file.id,
          title: file.name,
          error: "Aborted: wall-clock limit reached",
        });
        fileResults.push({ id: file.id, title: file.name, status: "error" });
        continue;
      }

      try {
        // Export content (retry once on transient failures)
        const content = await withRetry(
          () => exportFileAsText(accessToken, file.id),
        );

        // Content-hash dedup — stored in sync_state as doc_hash:gdoc:{fileId}
        const docHash = await sha256(content);
        const hashKey = `doc_hash:gdoc:${file.id}`;

        const { data: hashRow } = await supabase
          .from("sync_state")
          .select("value")
          .eq("key", hashKey)
          .maybeSingle();

        if (hashRow?.value === docHash) {
          stats.filesSkipped++;
          fileResults.push({ id: file.id, title: file.name, status: "skipped" });
          if (file.modifiedTime > latestModifiedTime) {
            latestModifiedTime = file.modifiedTime;
          }
          continue;
        }

        // Content changed — call ingest-document
        const ingestResp = await withRetry(() =>
          fetch(`${SUPABASE_URL}/functions/v1/ingest-document`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-tool-secret": HUME_TOOL_SECRET,
            },
            body: JSON.stringify({
              title: file.name,
              content,
              source_path: `gdoc:${file.id}`,
              source_type: "google_doc",
              source_url: `https://docs.google.com/document/d/${file.id}`,
              metadata: {
                gdoc_id: file.id,
                synced_at: new Date().toISOString(),
              },
            }),
          })
        );

        if (!ingestResp.ok) {
          const err = await ingestResp.text();
          throw new Error(`ingest-document failed (${ingestResp.status}): ${err}`);
        }

        // Store new content hash
        await supabase.from("sync_state").upsert({
          key: hashKey,
          value: docHash,
          updated_at: new Date().toISOString(),
        });

        stats.filesSynced++;
        fileResults.push({ id: file.id, title: file.name, status: "synced" });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error(`[sync-kb] Error on ${file.id} (${file.name}):`, errMsg);
        stats.filesErrored++;
        stats.errorDetails.push({ file_id: file.id, title: file.name, error: errMsg });
        fileResults.push({ id: file.id, title: file.name, status: "error" });
      }

      // Advance timestamp regardless of outcome (prevent retry storm on bad files)
      if (file.modifiedTime > latestModifiedTime) {
        latestModifiedTime = file.modifiedTime;
      }
    }

    // 5. Advance timestamp pivot to max(modifiedTime) from this batch
    await supabase.from("sync_state").upsert({
      key: "ai_phil_docs_last_synced",
      value: latestModifiedTime,
      updated_at: new Date().toISOString(),
    });

    await closeRun(supabase, runId, stats);

    return Response.json({
      synced: stats.filesSynced,
      skipped: stats.filesSkipped,
      errors: stats.filesErrored,
      files: fileResults,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[sync-kb] Fatal:", errMsg);
    stats.filesErrored++;
    stats.errorDetails.push({ file_id: "N/A", title: "N/A", error: errMsg });
    await closeRun(supabase, runId, stats);
    return Response.json({ error: errMsg }, { status: 500 });
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/sync-knowledge-base/index.ts
git commit -m "feat: add sync-knowledge-base edge function"
```

---

## Task 3: Write `/api/admin/sync-docs` Next.js Route

**Files:**
- Create: `src/app/api/admin/sync-docs/route.ts`

- [ ] **Step 1: Create the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-sync-secret");
  if (!secret || secret !== process.env.SYNC_ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { error: "Supabase env vars not configured" },
      { status: 500 },
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data, error } = await supabase.functions.invoke(
    "sync-knowledge-base",
    { body: { trigger: "manual" } },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/admin/sync-docs/route.ts
git commit -m "feat: add /api/admin/sync-docs manual trigger route"
```

---

## Task 4: GCP Service Account Setup (Manual — Do Before Deploying)

This task has no code. Complete all steps before Task 5.

- [ ] **Step 1: Create the service account**

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Select project `aiai-n8n-integration`
3. Navigate to: IAM & Admin → Service Accounts → **+ Create Service Account**
4. Name: `ai-phil-drive-reader`
5. Description: `Read-only access to AI Phil Google Docs folder for KB sync`
6. Click **Create and Continue**
7. Skip the "Grant access" step (no IAM roles needed — Drive access is folder-level)
8. Click **Done**

- [ ] **Step 2: Create and download a JSON key**

1. Click the new `ai-phil-drive-reader` service account
2. Go to the **Keys** tab → **Add Key** → **Create new key** → **JSON**
3. Download the file — it looks like:
   ```json
   {
     "type": "service_account",
     "project_id": "aiai-n8n-integration",
     "private_key_id": "...",
     "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
     "client_email": "ai-phil-drive-reader@aiai-n8n-integration.iam.gserviceaccount.com",
     ...
   }
   ```
4. Note the `client_email` value — you need it in the next step

- [ ] **Step 3: Share the Drive folder with the service account**

1. Open Google Drive
2. Navigate to the `Ai Phil Google Docs` folder (folder ID `1WvYoladPakRleEscONNFXVgHv3-hjbEE`)
3. Right-click → **Share**
4. Paste the `client_email` from Step 2
5. Set permission to **Viewer**
6. Click **Send** (uncheck "Notify people")

- [ ] **Step 4: Store the JSON key in Supabase secrets**

In the Supabase dashboard for project `ylppltmwueasbdexepip`:
1. Go to: Edge Functions → Manage secrets
2. Add secret:
   - Name: `GOOGLE_SERVICE_ACCOUNT_KEY`
   - Value: paste the **entire JSON key file contents** (single line or multi-line both work)

- [ ] **Step 5: Store service role key in Supabase Vault (for pg_cron)**

Run in the Supabase SQL Editor:
```sql
-- Paste the actual service role key value from Supabase dashboard → Settings → API
SELECT vault.create_secret('<YOUR_SERVICE_ROLE_KEY_HERE>', 'service_role_key');
```

Verify:
```sql
SELECT name FROM vault.decrypted_secrets WHERE name = 'service_role_key';
```

Expected: 1 row named `service_role_key`.

---

## Task 5: Deploy Edge Function + Add Vercel Env Var

- [ ] **Step 1: Install Supabase CLI if not already installed**

```bash
brew install supabase/tap/supabase
```

Verify:
```bash
supabase --version
```

Expected: prints a version number.

- [ ] **Step 2: Deploy the edge function**

```bash
cd "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Ai Phil"
supabase functions deploy sync-knowledge-base --project-ref ylppltmwueasbdexepip --no-verify-jwt
```

Expected output: `Deployed Function sync-knowledge-base on project ylppltmwueasbdexepip`

- [ ] **Step 3: Add `SYNC_ADMIN_SECRET` to Vercel**

1. Go to [vercel.com/philgoodvibes-projects/ai-phil](https://vercel.com/philgoodvibes-projects/ai-phil) → Settings → Environment Variables
2. Add variable:
   - Name: `SYNC_ADMIN_SECRET`
   - Value: generate a strong secret — run `openssl rand -hex 32` in terminal
   - Environment: Production + Preview + Development
3. Also add `SUPABASE_SERVICE_ROLE_KEY` if it isn't already set (check Settings → Env Vars)

- [ ] **Step 4: Add `SYNC_ADMIN_SECRET` to local `.env.local`**

```bash
# Append to .env.local (create file if it doesn't exist)
echo "SYNC_ADMIN_SECRET=<the same value you put in Vercel>" >> .env.local
```

---

## Task 6: Smoke Test — Verify End-to-End

- [ ] **Step 1: Invoke the function directly and verify it starts**

```bash
supabase functions invoke sync-knowledge-base \
  --project-ref ylppltmwueasbdexepip \
  --body '{"trigger":"manual"}'
```

Expected (if Google auth isn't set up yet): `{"error":"Google auth failed..."}` — this is fine at this stage.

Expected (if fully set up): `{"synced":N,"skipped":N,"errors":0,"files":[...]}`

- [ ] **Step 2: Verify a sync_runs row was written**

Run in Supabase SQL Editor:
```sql
SELECT trigger, files_seen, files_synced, files_skipped, files_errored, duration_ms
FROM sync_runs
ORDER BY started_at DESC
LIMIT 5;
```

Expected: at least 1 row, `trigger = 'manual'`, `completed_at IS NOT NULL`.

- [ ] **Step 3: Test the manual trigger API route**

Start the dev server:
```bash
npm run dev
```

In a new terminal:
```bash
curl -s -X POST http://localhost:3000/api/admin/sync-docs \
  -H "x-sync-secret: $(grep SYNC_ADMIN_SECRET .env.local | cut -d= -f2)" \
  -H "Content-Type: application/json" | jq .
```

Expected: `{"synced":N,"skipped":N,"errors":0,"files":[...]}`

Wrong secret test (should fail):
```bash
curl -s -X POST http://localhost:3000/api/admin/sync-docs \
  -H "x-sync-secret: wrongsecret" | jq .
```

Expected: `{"error":"Unauthorized"}` with HTTP 401.

- [ ] **Step 4: Edit a real doc and verify sync picks it up**

1. Open any doc in `60-content/Ai Phil Google Docs/` on Google Drive
2. Add a recognizable test phrase to the end, e.g.: `SYNC TEST 2026-04-15`
3. Run the manual trigger again:
   ```bash
   curl -s -X POST http://localhost:3000/api/admin/sync-docs \
     -H "x-sync-secret: $(grep SYNC_ADMIN_SECRET .env.local | cut -d= -f2)" \
     -H "Content-Type: application/json" | jq .
   ```
4. Verify the doc showed as `"status":"synced"` in the response
5. Verify the KB updated:
   ```sql
   SELECT content FROM kb_documents
   WHERE source_type = 'google_doc'
   ORDER BY updated_at DESC
   LIMIT 3;
   ```
   Expected: one or more rows containing `SYNC TEST 2026-04-15`

6. Remove the test phrase from the doc and run manual trigger again to clean up

- [ ] **Step 5: Verify dedup works**

Run the manual trigger twice in a row without editing any docs:

```bash
# First call
curl -s -X POST http://localhost:3000/api/admin/sync-docs \
  -H "x-sync-secret: $(grep SYNC_ADMIN_SECRET .env.local | cut -d= -f2)" | jq .

# Second call (immediately)
curl -s -X POST http://localhost:3000/api/admin/sync-docs \
  -H "x-sync-secret: $(grep SYNC_ADMIN_SECRET .env.local | cut -d= -f2)" | jq .
```

Expected on second call: `{"synced":0,"skipped":N,"errors":0,...}` — all files skipped, no OpenAI calls made.

---

## Task 7: Apply pg_cron Migration + Disable n8n

- [ ] **Step 1: Verify Vault entry exists**

```sql
SELECT name FROM vault.decrypted_secrets WHERE name = 'service_role_key';
```

Expected: 1 row. If missing, run the vault setup from Task 4 Step 5 first.

- [ ] **Step 2: Apply the cron migration**

Run the contents of `supabase/migrations/20260415000002_sync_cron.sql` in the Supabase SQL Editor.

Verify the job was registered:
```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'sync-ai-phil-docs';
```

Expected: 1 row, `active = true`, `schedule = '*/30 * * * *'`

- [ ] **Step 3: Disable the broken n8n watcher**

1. Log in to n8n at `https://n8n.srv1588772.hstgr.cloud`
2. Find the "Google Drive Watcher" workflow
3. Click the toggle to **Deactivate** it
4. Confirm it shows as inactive

- [ ] **Step 4: Deploy production build and verify**

```bash
git push origin main
```

Wait for Vercel to finish deploying, then test the production manual trigger:

```bash
curl -s -X POST https://ai-phil.vercel.app/api/admin/sync-docs \
  -H "x-sync-secret: <SYNC_ADMIN_SECRET>" \
  -H "Content-Type: application/json" | jq .
```

Expected: same structure as local test.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: ship Google Drive → KB auto-sync (P1 complete)

- sync-knowledge-base edge function: polls Drive every 30min
- Content-hash dedup: skips unchanged docs, no wasted embeddings  
- sync_runs table: full observability on every execution
- /api/admin/sync-docs: secret-protected manual trigger
- n8n Google Drive Watcher disabled

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Post-Ship: Update the Vault

Per `AGENTS.md` and `80-processes/Agent-Coordination.md`, after shipping:

1. Update `60-content/ai-phil/_ROADMAP.md` — move P1 from Priorities → Shipped with date `2026-04-15`
2. Write a session summary to `50-meetings/` (3-5 lines: what shipped, any decisions made)
3. Optionally: write `70-decisions/DR-2026-04-15-DRIVE-SYNC-EDGE-FUNCTION.md` (replaces n8n, reasons documented in design spec)
