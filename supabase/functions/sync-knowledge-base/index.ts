import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Config ────────────────────────────────────────────────────────────────

const FOLDER_ID = "1WvYoladPakRleEscONNFXVgHv3-hjbEE";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HUME_TOOL_SECRET = Deno.env.get("HUME_TOOL_SECRET")!;

function getGoogleServiceAccountKey(): Record<string, string> {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY secret is not set");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON");
  }
}

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
  const GOOGLE_SA_KEY = getGoogleServiceAccountKey();
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
    // TODO: handle nextPageToken for folders with >100 docs (not needed at current scale of ~50 max)
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
  const { data, error } = await supabase
    .from("sync_runs")
    .insert({ trigger, started_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error) console.warn("[sync-kb] Failed to open sync_runs row:", error.message);
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
        stats.filesErrored++;
        stats.errorDetails.push({
          file_id: file.id,
          title: file.name,
          error: "Aborted: wall-clock limit reached",
        });
        fileResults.push({ id: file.id, title: file.name, status: "error" });
        if (file.modifiedTime > latestModifiedTime) latestModifiedTime = file.modifiedTime;
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

      // Advance timestamp regardless of outcome.
      // NOTE: This means files that error will NOT be retried on the next cron run —
      // their modifiedTime has been consumed by the pivot. This is intentional to
      // prevent retry storms on permanently-broken files. If a file needs re-ingestion,
      // use the manual trigger after fixing the underlying issue.
      if (file.modifiedTime > latestModifiedTime) {
        latestModifiedTime = file.modifiedTime;
      }
    }

    // 4. Advance timestamp pivot to max(modifiedTime) from this batch
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
