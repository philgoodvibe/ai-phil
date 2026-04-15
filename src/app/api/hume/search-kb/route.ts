import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side proxy: forwards search_knowledge_base tool calls
 * from the AI Phil voice widget to the Supabase edge function.
 *
 * Why a proxy? The Supabase edge function requires HUME_TOOL_SECRET
 * which must NEVER be exposed to the browser.
 *
 * Auth: callable by both authenticated members and the public
 * Discovery page (light rate limit applies to the latter).
 */

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "https://ylppltmwueasbdexepip.supabase.co";

// Light rate limit per IP for unauth callers (Discovery page)
const PUBLIC_RATE_LIMIT_PER_MIN = 30;
const ipBuckets = new Map<string, { count: number; resetAt: number }>();

function checkPublicRateLimit(ip: string): boolean {
  const now = Date.now();
  const MIN = 60 * 1000;
  const bucket = ipBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    ipBuckets.set(ip, { count: 1, resetAt: now + MIN });
    return true;
  }
  if (bucket.count >= PUBLIC_RATE_LIMIT_PER_MIN) return false;
  bucket.count++;
  return true;
}

export async function POST(request: NextRequest) {
  try {
    const HUME_TOOL_SECRET = process.env.HUME_TOOL_SECRET;
    if (!HUME_TOOL_SECRET) {
      return NextResponse.json(
        { error: "HUME_TOOL_SECRET not configured" },
        { status: 500 }
      );
    }

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";

    if (!checkPublicRateLimit(ip)) {
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429 }
      );
    }

    const body = await request.json();
    const { query, source_type, match_count, match_threshold } = body;

    if (!query || typeof query !== "string") {
      return NextResponse.json(
        { error: "query string is required" },
        { status: 400 }
      );
    }

    const response = await fetch(`${SUPABASE_URL}/functions/v1/search-knowledge-base`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tool-secret": HUME_TOOL_SECRET,
      },
      body: JSON.stringify({
        query,
        source_type,
        match_count,
        match_threshold,
      }),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (e) {
    console.error("hume/search-kb error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
