import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";

/**
 * Issues a short-lived Hume EVI access token to the browser AND
 * returns the appropriate config_id based on the caller's context.
 *
 * Auth modes:
 *  - Authenticated portal user → New Member or Implementation Coach config
 *  - Unauthenticated (Discovery page) → Discovery Guide config (rate limited)
 */

// Hume's OAuth2 client_credentials endpoint
const HUME_TOKEN_URL = "https://api.hume.ai/oauth2-cc/token";

// In-memory rate limit for unauth Discovery requests (per IP)
// In production move to KV/Redis; sufficient for MVP traffic.
// Generous in dev to support iteration; configurable via env.
const DISCOVERY_RATE_LIMIT = Number(
  process.env.HUME_DISCOVERY_RATE_LIMIT ||
    (process.env.NODE_ENV === "production" ? 20 : 200)
);
const ipBuckets = new Map<string, { count: number; resetAt: number }>();

function checkDiscoveryRateLimit(ip: string): boolean {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const bucket = ipBuckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    ipBuckets.set(ip, { count: 1, resetAt: now + HOUR });
    return true;
  }
  if (bucket.count >= DISCOVERY_RATE_LIMIT) return false;
  bucket.count++;
  return true;
}

async function fetchHumeAccessToken(apiKey: string, secretKey: string): Promise<string> {
  const credentials = Buffer.from(`${apiKey}:${secretKey}`).toString("base64");
  const response = await fetch(HUME_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Hume token error (${response.status}): ${err}`);
  }

  const data = await response.json();
  return data.access_token;
}

export async function POST(request: NextRequest) {
  try {
    const HUME_API_KEY = process.env.HUME_API_KEY;
    const HUME_SECRET_KEY = process.env.HUME_SECRET_KEY;

    const CONFIG_NEW_MEMBER = process.env.HUME_EVI_CONFIG_NEW_MEMBER;
    const CONFIG_IMPLEMENTATION = process.env.HUME_EVI_CONFIG_IMPLEMENTATION;
    const CONFIG_DISCOVERY = process.env.HUME_EVI_CONFIG_DISCOVERY;

    if (!HUME_API_KEY || !HUME_SECRET_KEY) {
      return NextResponse.json(
        { error: "Hume credentials not configured" },
        { status: 500 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const requestedContext = body.context as
      | "member"
      | "discovery"
      | "implementation"
      | "new-member"
      | undefined;

    // Public contexts (no auth required, rate-limited per IP). These let the
    // widget be embedded on any site — course pages, marketing, Kajabi, etc.
    const PUBLIC_CONTEXTS = new Set(["discovery", "implementation", "new-member"]);

    let configId: string | undefined;
    let contextType: "new-member" | "implementation" | "discovery";

    if (requestedContext && PUBLIC_CONTEXTS.has(requestedContext)) {
      // Public flow — rate limit by IP
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
        request.headers.get("x-real-ip") ||
        "unknown";

      if (!checkDiscoveryRateLimit(ip)) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Try again in an hour." },
          { status: 429 }
        );
      }

      if (requestedContext === "implementation") {
        configId = CONFIG_IMPLEMENTATION;
        contextType = "implementation";
      } else if (requestedContext === "new-member") {
        configId = CONFIG_NEW_MEMBER;
        contextType = "new-member";
      } else {
        configId = CONFIG_DISCOVERY;
        contextType = "discovery";
      }
    } else {
      // Member context — require Supabase auth
      const supabase = await createServerSupabaseClient();
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        return NextResponse.json(
          { error: "Authentication required for member context" },
          { status: 401 }
        );
      }

      // Optional override for testing: ?persona=new-member or implementation
      // (only honored for authenticated members; discovery is rate-limited separately)
      const personaOverride = request.nextUrl.searchParams.get("persona");
      if (personaOverride === "new-member") {
        configId = CONFIG_NEW_MEMBER;
        contextType = "new-member";
      } else if (personaOverride === "implementation") {
        configId = CONFIG_IMPLEMENTATION;
        contextType = "implementation";
      } else {
        // Look up profile to determine onboarding status
        const { data: person } = await supabase
          .from("people")
          .select("id, onboarding_completed")
          .eq("auth_user_id", user.id)
          .maybeSingle();

        // Not onboarded yet → New Member Guide; done → Implementation Coach
        if (person?.onboarding_completed) {
          configId = CONFIG_IMPLEMENTATION;
          contextType = "implementation";
        } else {
          configId = CONFIG_NEW_MEMBER;
          contextType = "new-member";
        }
      }
    }

    if (!configId) {
      return NextResponse.json(
        { error: `Config ID not configured for context: ${contextType!}` },
        { status: 500 }
      );
    }

    const accessToken = await fetchHumeAccessToken(HUME_API_KEY, HUME_SECRET_KEY);

    return NextResponse.json({
      accessToken,
      configId,
      context: contextType!,
    });
  } catch (e) {
    console.error("hume/access-token error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
