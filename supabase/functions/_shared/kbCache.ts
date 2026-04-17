/**
 * kbCache.ts — 30-minute read-through cache for public Google Doc fetches.
 *
 * Backed by ops.kb_doc_cache (doc_id PK, content, fetched_at).
 * Best-effort: cache flakiness never breaks the reply flow. On any DB error
 * we log and fall through to a direct fetch. On fetch failure we return the
 * caller-supplied fallback string WITHOUT writing it to the cache (writing
 * the fallback would poison future reads).
 */

export const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Structural type for the Supabase client. Same pattern as rapport.ts — a
 * minimal shape so tests can inject stubs without pulling the real SDK.
 * The real client returned by createClient(...) from @supabase/supabase-js
 * satisfies this shape.
 *
 * Callers pass `supabase.schema('ops').from('kb_doc_cache')` via the client;
 * this type only guarantees `.schema(...)` is callable.
 */
// deno-lint-ignore no-explicit-any
export type SupabaseLike = any;

/**
 * Pure TTL check. Returns true iff `fetchedAtIso` parses to a timestamp
 * strictly less than `CACHE_TTL_MS` ago relative to `nowMs`. Malformed
 * dates, empty strings, and the exactly-at-TTL boundary all return false.
 */
export function isCacheFresh(fetchedAtIso: string, nowMs: number = Date.now()): boolean {
  const fetchedMs = Date.parse(fetchedAtIso);
  if (Number.isNaN(fetchedMs)) return false;
  return nowMs - fetchedMs < CACHE_TTL_MS;
}

/**
 * Fetch a public Google Doc as plain text. Returns `fallback` on network
 * error or non-2xx response. Exported for tests and callers who want to
 * bypass the cache entirely.
 */
export async function fetchGoogleDocUncached(docId: string, fallback: string): Promise<string> {
  try {
    const res = await fetch(`https://docs.google.com/document/d/${docId}/export?format=txt`);
    if (!res.ok) {
      console.error(`[gdoc] fetch ${docId} ${res.status}`);
      return fallback;
    }
    const text = await res.text();
    return text.trim() || fallback;
  } catch (err) {
    console.error(`[gdoc] fetch ${docId} threw:`, err);
    return fallback;
  }
}

/**
 * Read-through cache: return cached content if fresh; otherwise fetch,
 * upsert on success, and return. Never throws — all DB errors are logged
 * and the uncached fetch result is returned.
 */
export async function fetchCachedGoogleDoc(
  supabase: SupabaseLike,
  docId: string,
  fallback: string,
): Promise<string> {
  // 1. Cache lookup
  try {
    const { data, error } = await supabase
      .schema('ops')
      .from('kb_doc_cache')
      .select('content, fetched_at')
      .eq('doc_id', docId)
      .maybeSingle();

    if (error) {
      console.error(`[kbCache] select ${docId} error:`, error);
    } else if (data && isCacheFresh(data.fetched_at)) {
      return data.content as string;
    }
  } catch (err) {
    console.error(`[kbCache] select ${docId} threw:`, err);
  }

  // 2. Miss or stale: fetch fresh
  const fresh = await fetchGoogleDocUncached(docId, fallback);

  // 3. Only cache real fetched content — never cache the fallback.
  if (fresh !== fallback) {
    try {
      const { error } = await supabase
        .schema('ops')
        .from('kb_doc_cache')
        .upsert({
          doc_id: docId,
          content: fresh,
          fetched_at: new Date().toISOString(),
        });
      if (error) {
        console.error(`[kbCache] upsert ${docId} error:`, error);
      }
    } catch (err) {
      console.error(`[kbCache] upsert ${docId} threw:`, err);
    }
  }

  return fresh;
}
