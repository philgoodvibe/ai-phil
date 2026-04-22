// =============================================================================
// rapport.ts — F.O.R.M. rapport memory helpers for every AI Phil agent
// =============================================================================
//
// Canonical source of truth for F.O.R.M. extraction semantics:
//   /01_Knowledge Base/AIAI-Vault/60-content/ai-phil/AI-Phil-Voice-Philosophy.md
//   (see §10 "Rapport memory" in particular)
//
// This module owns the shape of rapport facts and the four operations every
// agent needs to run across a conversation turn:
//
//   1. fetchRapport   — read ops.contact_rapport.facts for a contact
//   2. formatRapportBlock — render the facts as a system-prompt block
//   3. extractRapport — call Haiku on the latest turn to pull NEW facts
//   4. mergeRapportFacts  — append-only merge with exact-match dedup
//   5. storeRapport   — upsert the merged facts back to the DB
//
// Core rule from voice doc §10 (non-negotiable):
//   - Extraction is CONSERVATIVE. Only facts the prospect explicitly stated.
//     No inference. No "might be." Bad rapport data is worse than no rapport data.
//   - Storage is APPEND-ONLY. Timeline matters. "Lucy passed away" is a
//     different fact from "got a new puppy Lucy" — both live in the memory.
//
// STYLE RULE: prompts built here must never contain em dashes (voice doc §2).
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single F.O.R.M. fact extracted from a conversation turn.
 * Shape matches voice doc §10 and the `ops.contact_rapport.facts` table.
 */
export interface Fact {
  /** Short snake_case key, e.g. "dog_name", "agency_size", "carrier". */
  key: string;
  /** Human-readable value, e.g. "Lucy", "3 producers", "State Farm". */
  value: string;
  /** Conversation identifier the fact was extracted from. */
  source_conv: string;
  /** ISO-8601 timestamp of extraction. */
  extracted_at: string;
}

/**
 * F.O.R.M. rapport facts bucketed by pillar (voice doc §4, §10).
 * Append-only in storage; never silently overwritten.
 */
export interface RapportFacts {
  family: Fact[];
  occupation: Fact[];
  recreation: Fact[];
  money: Fact[];
}

/**
 * Factory for a fresh empty RapportFacts shape. Never share a mutable singleton
 * across call sites — a caller who pushes into one pillar would corrupt every
 * future caller using the "empty" reference.
 */
export function emptyRapport(): RapportFacts {
  return { family: [], occupation: [], recreation: [], money: [] };
}

/** Deep-frozen empty constant for code paths that return truly immutable data. */
export const EMPTY_RAPPORT: RapportFacts = Object.freeze({
  family: Object.freeze([]) as readonly Fact[],
  occupation: Object.freeze([]) as readonly Fact[],
  recreation: Object.freeze([]) as readonly Fact[],
  money: Object.freeze([]) as readonly Fact[],
}) as unknown as RapportFacts;

/**
 * Structural type for the Supabase client. We use a minimal shape so tests
 * can inject stubs without pulling the real SDK. The real client returned by
 * `createClient(...)` from `@supabase/supabase-js` satisfies this shape.
 *
 * Callers pass `supabase.schema('ops').from('contact_rapport')` via the
 * client; this type only guarantees `.schema(...)` is callable.
 */
// deno-lint-ignore no-explicit-any
export type SupabaseLike = any;

// ---------------------------------------------------------------------------
// ExtractResult — discriminated union returned by extractRapport
// ---------------------------------------------------------------------------

export type ExtractStatus =
  | 'ok'
  | 'empty'
  | 'http_error'
  | 'parse_error'
  | 'no_api_key'
  | 'threw'
  | 'skipped_no_user_content';

/**
 * `skipped_no_user_content` is included for exhaustive-switch coverage in
 * call sites that narrow on `ExtractResult.status`. `extractRapport` itself
 * never emits it — the skip decision lives in the caller (see
 * `shouldSkipExtractor` in ghl-member-agent), which records the audit row
 * directly without invoking Haiku. Present here so the helper switches in
 * ghl-sales-agent / ghl-sales-followup / ghl-member-agent can be exhaustive.
 * `parse_error` covers both "empty content block" and malformed-JSON paths;
 * the `error` field distinguishes them at runtime.
 */
export type ExtractResult =
  | { status: 'ok'; facts: RapportFacts; latencyMs: number }
  | { status: 'empty'; facts: RapportFacts; latencyMs: number }
  | { status: 'http_error'; error: string; httpStatus: number; latencyMs: number }
  | { status: 'parse_error'; error: string; rawSnippet: string; latencyMs: number }
  | { status: 'no_api_key'; latencyMs: 0 }
  | { status: 'threw'; error: string; latencyMs: number }
  | { status: 'skipped_no_user_content'; latencyMs: 0 };

// ---------------------------------------------------------------------------
// formatRapportBlock — pure. System-prompt block renderer.
// ---------------------------------------------------------------------------

const EMPTY_BLOCK =
  '(no rapport facts captured yet. Listen and extract naturally through F.O.R.M. questions.)';

/**
 * Render the rapport facts as a human-readable block to inject into system
 * prompts. Header + four pillars with key/value bullets.
 *
 * If every pillar is empty, returns the canonical empty-state string exactly
 * (tests and callers rely on the exact wording).
 */
export function formatRapportBlock(facts: RapportFacts): string {
  const allEmpty =
    facts.family.length === 0 &&
    facts.occupation.length === 0 &&
    facts.recreation.length === 0 &&
    facts.money.length === 0;

  if (allEmpty) return EMPTY_BLOCK;

  const lines: string[] = [
    'WHAT WE KNOW ABOUT THIS PERSON (reference naturally, never read back like a list):',
    '',
  ];

  const pushPillar = (label: string, pillar: Fact[]) => {
    if (pillar.length === 0) return;
    lines.push(`${label}:`);
    for (const f of pillar) {
      lines.push(`- ${f.key}: ${f.value}`);
    }
    lines.push('');
  };

  pushPillar('Family', facts.family);
  pushPillar('Occupation', facts.occupation);
  pushPillar('Recreation', facts.recreation);
  pushPillar('Money', facts.money);

  // Trim trailing empty line for cleanliness.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// mergeRapportFacts — pure, append-only with exact-match dedup
// ---------------------------------------------------------------------------

/**
 * Merge incoming facts into existing facts. Append-only:
 *   - Different value for the same key IS preserved (timeline matters).
 *   - Exact duplicates (same key + value + source_conv + extracted_at) dropped.
 *
 * Never mutates inputs.
 */
export function mergeRapportFacts(
  existing: RapportFacts,
  incoming: RapportFacts,
): RapportFacts {
  return {
    family: mergePillar(existing.family, incoming.family),
    occupation: mergePillar(existing.occupation, incoming.occupation),
    recreation: mergePillar(existing.recreation, incoming.recreation),
    money: mergePillar(existing.money, incoming.money),
  };
}

function mergePillar(existing: Fact[], incoming: Fact[]): Fact[] {
  const seen = new Set<string>();
  const merged: Fact[] = [];
  const add = (f: Fact) => {
    const sig = `${f.key}\u0000${f.value}\u0000${f.source_conv}\u0000${f.extracted_at}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    merged.push(f);
  };
  for (const f of existing) add(f);
  for (const f of incoming) add(f);
  return merged;
}

// ---------------------------------------------------------------------------
// fetchRapport — read ops.contact_rapport.facts
// ---------------------------------------------------------------------------

/**
 * Read rapport facts for a contact. Returns EMPTY_RAPPORT when the row
 * doesn't exist or facts column is null/empty.
 *
 * Never throws for "no row"; logs and returns empty for query errors so
 * callers can proceed with a cold conversation rather than 500ing.
 */
export async function fetchRapport(
  supabase: SupabaseLike,
  contactId: string,
): Promise<RapportFacts> {
  try {
    const { data, error } = await supabase
      .schema('ops')
      .from('contact_rapport')
      .select('facts')
      .eq('contact_id', contactId)
      .maybeSingle();

    if (error) {
      console.error('[rapport] fetch error:', error.message ?? error);
      return { ...EMPTY_RAPPORT, family: [], occupation: [], recreation: [], money: [] };
    }

    const raw = (data as { facts?: unknown } | null)?.facts;
    return normalizeRapportShape(raw);
  } catch (err) {
    console.error('[rapport] fetch threw:', err);
    return { family: [], occupation: [], recreation: [], money: [] };
  }
}

/**
 * Defensively coerce an unknown JSON payload from the DB into a RapportFacts
 * shape. Missing / wrong-typed pillars become empty arrays. Non-object inputs
 * yield a fully empty RapportFacts.
 */
function normalizeRapportShape(raw: unknown): RapportFacts {
  if (!raw || typeof raw !== 'object') {
    return { family: [], occupation: [], recreation: [], money: [] };
  }
  const obj = raw as Record<string, unknown>;
  return {
    family: coerceFactArray(obj.family),
    occupation: coerceFactArray(obj.occupation),
    recreation: coerceFactArray(obj.recreation),
    money: coerceFactArray(obj.money),
  };
}

function coerceFactArray(raw: unknown): Fact[] {
  if (!Array.isArray(raw)) return [];
  const out: Fact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.key === 'string' &&
      typeof rec.value === 'string' &&
      typeof rec.source_conv === 'string' &&
      typeof rec.extracted_at === 'string'
    ) {
      out.push({
        key: rec.key,
        value: rec.value,
        source_conv: rec.source_conv,
        extracted_at: rec.extracted_at,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// extractRapport — Haiku pulls NEW F.O.R.M. facts from the latest turn
// ---------------------------------------------------------------------------

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/**
 * System prompt enforcing voice doc §10 extraction conservatism.
 * "Only record facts the prospect explicitly stated. No inference."
 * No em dashes (voice doc §2). JSON-only output.
 */
const EXTRACT_SYSTEM_PROMPT = `You extract F.O.R.M. facts (Family, Occupation, Recreation, Money) about the prospect from a single conversation turn.

HARD RULES:
1. ONLY record facts the PROSPECT explicitly stated. Never infer.
2. If they said "my daughter plays soccer", record key="daughter_plays" value="soccer". Do NOT record "likely has at least one child under 18" because that is inference.
3. If the prospect did not explicitly state something, leave that category's array empty.
4. Do NOT re-record facts already in EXISTING_FACTS (you will see them listed for reference).
5. Output ONLY valid JSON in this exact shape: { "family": [...], "occupation": [...], "recreation": [...], "money": [...] }. No prose before or after. No code fences.
6. Each Fact entry must be: { "key": "<snake_case>", "value": "<short quote or paraphrase>", "source_conv": "<conv_id_from_context>", "extracted_at": "<ISO8601 UTC>" }
7. Never use em dashes in values. Use periods, commas, or line breaks.

Four pillars and what goes in each:
- Family: spouse, kids, pets, parents, family milestones, losses.
- Occupation: carrier, size (PIF, producers, premium), lines of business, geography, tenure, stated bottleneck.
- Recreation: sports watched or played, travel, hobbies, community, entertainment.
- Money: revenue goals, stated cost pain, growth trajectory.

If nothing new is stated, return { "family": [], "occupation": [], "recreation": [], "money": [] }.`;

/**
 * Call Haiku to extract any NEW F.O.R.M. facts from a single conversation
 * turn (user message + assistant reply). Best effort: on any error or
 * malformed JSON, returns EMPTY_RAPPORT rather than throwing.
 *
 * The caller supplies `existingFacts` (for dedup awareness in the prompt)
 * and the `anthropicApiKey` (read from Deno.env upstream; we don't read env
 * here so tests stay offline).
 */
export async function extractRapport(
  conversationTurn: {
    userMessage: string;
    assistantReply: string;
    conversationId?: string;
  },
  existingFacts: RapportFacts,
  anthropicApiKey: string,
): Promise<ExtractResult> {
  if (!anthropicApiKey) {
    console.error('[rapport] extractRapport called without anthropicApiKey');
    return { status: 'no_api_key', latencyMs: 0 };
  }

  const convId = conversationTurn.conversationId ?? 'unknown';
  const nowIso = new Date().toISOString();

  const existingSummary = summarizeExistingFacts(existingFacts);

  const userMessage = `CONVERSATION TURN

PROSPECT said:
${conversationTurn.userMessage}

AI replied:
${conversationTurn.assistantReply}

CONTEXT
- conv_id for source_conv field: ${convId}
- extracted_at to use in every fact: ${nowIso}

EXISTING_FACTS (do NOT re-record anything that matches one of these):
${existingSummary}

Return ONLY the JSON object. No prose. No code fences.`;

  const startedAt = Date.now();
  try {
    const res = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 500,
        system: EXTRACT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`[rapport] Haiku extract ${res.status}:`, body);
      return { status: 'http_error', error: body, httpStatus: res.status, latencyMs };
    }

    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = data.content?.[0]?.text?.trim();
    if (!text) {
      console.error('[rapport] Haiku extract returned empty content');
      return {
        status: 'parse_error',
        error: 'empty content block',
        rawSnippet: JSON.stringify(data).slice(0, 200),
        latencyMs,
      };
    }

    const cleaned = stripCodeFences(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[rapport] Haiku extract produced malformed JSON:', msg, cleaned.slice(0, 200));
      return {
        status: 'parse_error',
        error: msg,
        rawSnippet: cleaned.slice(0, 200),
        latencyMs,
      };
    }

    const facts = normalizeRapportShape(parsed);
    const hasAny =
      facts.family.length > 0 ||
      facts.occupation.length > 0 ||
      facts.recreation.length > 0 ||
      facts.money.length > 0;

    return hasAny
      ? { status: 'ok', facts, latencyMs }
      : { status: 'empty', facts, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[rapport] Haiku extract threw:', msg);
    return { status: 'threw', error: msg, latencyMs };
  }
}

function summarizeExistingFacts(facts: RapportFacts): string {
  const bits: string[] = [];
  const add = (label: string, pillar: Fact[]) => {
    for (const f of pillar) bits.push(`  ${label}.${f.key} = ${f.value}`);
  };
  add('family', facts.family);
  add('occupation', facts.occupation);
  add('recreation', facts.recreation);
  add('money', facts.money);
  return bits.length > 0 ? bits.join('\n') : '  (none on file)';
}

function stripCodeFences(s: string): string {
  // Haiku occasionally wraps JSON in ```json ... ``` despite instructions.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const m = s.match(fence);
  return m ? m[1].trim() : s;
}

// ---------------------------------------------------------------------------
// storeRapport — upsert merged facts back to ops.contact_rapport
// ---------------------------------------------------------------------------

/**
 * Upsert the full merged facts into `ops.contact_rapport` keyed by
 * `contact_id`. Idempotent. Also writes `fact_count` and
 * `last_extracted_at` so downstream monitoring can see freshness.
 */
export async function storeRapport(
  supabase: SupabaseLike,
  contactId: string,
  merged: RapportFacts,
): Promise<void> {
  const factCount =
    merged.family.length +
    merged.occupation.length +
    merged.recreation.length +
    merged.money.length;

  const nowIso = new Date().toISOString();

  try {
    const { error } = await supabase
      .schema('ops')
      .from('contact_rapport')
      .upsert(
        {
          contact_id: contactId,
          facts: merged,
          fact_count: factCount,
          last_extracted_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: 'contact_id' },
      );
    if (error) {
      console.error('[rapport] store error:', error.message ?? error);
    }
  } catch (err) {
    console.error('[rapport] store threw:', err);
  }
}

// ---------------------------------------------------------------------------
// recordExtraction — one audit row per extractor invocation
// ---------------------------------------------------------------------------

export interface ExtractionAuditRow {
  contactId: string;
  conversationId?: string | null;
  surface: 'ghl-sales-agent' | 'ghl-sales-followup' | 'ghl-member-agent';
  status: ExtractStatus;
  factsAdded?: number;
  factsTotalAfter?: number;
  latencyMs?: number;
  errorSnippet?: string;
}

const SNIPPET_CAP = 200;

/**
 * Insert one row into ops.rapport_extractions. Strictly additive: own
 * try/catch, own DB-error swallow. A bug in this helper must never surface
 * to the user-facing reply. errorSnippet is truncated to 200 chars.
 */
export async function recordExtraction(
  supabase: SupabaseLike,
  row: ExtractionAuditRow,
): Promise<void> {
  try {
    const { error } = await supabase
      .schema('ops')
      .from('rapport_extractions')
      .insert({
        contact_id: row.contactId,
        conversation_id: row.conversationId ?? null,
        surface: row.surface,
        haiku_status: row.status,
        facts_added: row.factsAdded ?? 0,
        facts_total_after: row.factsTotalAfter ?? 0,
        latency_ms: row.latencyMs ?? null,
        error_snippet: row.errorSnippet
          ? row.errorSnippet.slice(0, SNIPPET_CAP)
          : null,
      });
    if (error) {
      console.error('[rapport] audit insert error:', (error as { message?: string }).message ?? error);
    }
  } catch (err) {
    console.error('[rapport] audit insert threw:', err);
  }
}
