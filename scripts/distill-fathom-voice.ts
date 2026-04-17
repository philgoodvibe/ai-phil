// distill-fathom-voice.ts
// -------------------------------------------------------------------------
// Mines Phillip Ngo's Fathom meeting transcripts into RAW CANDIDATES for
// voice-artifact curation.
//
// This script produces raw candidates only. Final classification + curation
// happens in a Claude Code session that consumes `fathom-candidates.json`.
//
// The script is a pure pre-processor:
//   - Top phrases (Phillip-only 3-to-7-grams, frequency-ranked)
//   - Objection-candidate passages (prospect utterance + Phillip's next reply)
//   - Case-study-candidate passages (Phillip utterances matching peer markers)
//   - Accidental banned-word hits in Phillip's own speech
//
// No LLM calls. No clustering. No markdown rendering. A human-in-the-loop
// Claude session reads `fathom-candidates.json` and produces the curated
// `fathom-voice-artifacts.md` + classified `fathom-voice-artifacts.json`.
//
// Run (small batch):
//   cd scripts
//   deno task distill -- --limit 10
//
// Run (full corpus):
//   deno task distill
//
// Pure functions are unit-tested in `distill-fathom-voice.test.ts`.
// -------------------------------------------------------------------------

// =========================================================================
// Types
// =========================================================================

export type Utterance = {
  speaker: {
    display_name: string;
    matched_calendar_invitee_email: string | null;
  };
  text: string;
  timestamp: string;
};

export type FathomTranscript = {
  title?: string;
  meeting_title?: string;
  url?: string;
  created_at?: string;
  recording_id?: number;
  transcript: Utterance[];
};

export type PhraseCount = { phrase: string; count: number };

export type BannedWordCandidate = {
  word: string;
  count: number;
  example_passage: string;
  example_source: string;
};

export type ObjectionCandidate = {
  prospect_passage: string;
  phillip_response: string;
  source_file: string;
  timestamp: string;
};

export type CaseStudyCandidate = {
  passage: string;
  source_file: string;
  timestamp: string;
};

export type FathomCandidates = {
  generated_at: string;
  transcripts_scanned: number;
  phillip_utterance_count: number;
  top_phrases: PhraseCount[];
  objection_candidates: ObjectionCandidate[];
  case_study_candidates: CaseStudyCandidate[];
  accidental_banned_words: BannedWordCandidate[];
};

// =========================================================================
// Constants
// =========================================================================

const PHILLIP_NAME = "Phillip Ngo";
const PHILLIP_EMAIL = "pha.ngo@gmail.com";

// Core English stopwords. Intentionally focused — we drop conjunctions,
// pronouns, aux verbs, and a small handful of filler words. Don't over-prune:
// many of Phillip's signature phrases contain common short words.
const STOPWORDS: Set<string> = new Set([
  "a", "an", "and", "the",
  "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "on", "at", "for", "with", "by",
  "it", "its", "that", "this", "these", "those",
  "i", "me", "my", "you", "your",
  "we", "us", "our", "they", "them", "their",
  "he", "him", "his", "she", "her",
  "do", "does", "did",
  "have", "has", "had",
  "will", "would", "could", "should", "can", "may",
  "just", "so", "yeah", "okay", "right", "like", "know", "think",
  "really", "very",
]);

// Names we've seen across Phillip's meetings. Any n-gram containing one of
// these tokens is dropped, because names are noise in a voice-signature
// extraction. If you see a new recurring participant leaking into the top
// phrases, add them here.
const NAME_TOKENS: Set<string> = new Set([
  "phillip", "philip", "phil", "ngo",
  "dc", "miranda", "keyssa",
]);

// Coach-speak Phillip himself has declared off-brand. If he uses these in
// his own utterances, we want to know — every instance is friction against
// the canonical voice.
const BANNED_WORDS: string[] = [
  "transform",
  "unlock",
  "synergy",
  "leverage",
  "seamless",
  "abundance",
  "manifest",
  "10x overnight",
  "quantum leap",
];

// Language that flags a prospect concern. If a prospect utterance contains
// one of these fragments, we capture Phillip's next utterance as the
// response pattern (rough heuristic — in-session Claude confirms/refines).
const OBJECTION_MARKERS: string[] = [
  "too expensive",
  "can't afford",
  "cant afford",
  "not sure",
  "worried",
  "concerned",
  "hesitant",
  "skeptical",
  "doesn't work",
  "doesnt work",
  "won't work",
  "wont work",
  "my team",
  "my budget",
  "not the right time",
  "need to think",
  "have to think",
];

// Peer/case-study-shaped language. These markers show up when Phillip
// tells a story about an agency — we pluck those passages as candidates.
const PEER_MARKERS: RegExp[] = [
  /\bagency\s+(?:of|with)\s+\d+\s+(?:producers?|agents?)/i,
  /\$[\d,.]+(?:\s*(?:k|m|million|mil|grand))?\s+in\s+premium/i,
  /\bagency\s+in\s+[A-Z][a-z]+/, // "agency in Chicago"
  /\b\d+\s+producers?\b/i,
];

// =========================================================================
// Pure functions (unit-tested)
// =========================================================================

export function isPhillipUtterance(u: Utterance): boolean {
  if (!u?.speaker) return false;
  if (u.speaker.display_name === PHILLIP_NAME) return true;
  if (u.speaker.matched_calendar_invitee_email === PHILLIP_EMAIL) return true;
  return false;
}

export function tokenize(text: string): string[] {
  // Lowercase, strip everything except a-z/0-9/apostrophes and whitespace,
  // then split on whitespace.
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function generateNgrams(tokens: string[], n: number): string[] {
  if (n <= 0 || tokens.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    out.push(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

function ngramIsUsable(ngram: string): boolean {
  const toks = ngram.split(" ");
  for (const t of toks) {
    if (STOPWORDS.has(t)) return false;
    if (t.length < 3) return false;
    if (NAME_TOKENS.has(t)) return false;
  }
  return true;
}

export function extractTopPhrases(
  utterances: Utterance[],
  phillipOnly: boolean,
  topN: number,
  minNgram = 3,
  maxNgram = 7,
): PhraseCount[] {
  const pool = phillipOnly ? utterances.filter(isPhillipUtterance) : utterances;
  const counts = new Map<string, number>();

  for (const u of pool) {
    const toks = tokenize(u.text);
    for (let n = minNgram; n <= maxNgram; n++) {
      const grams = generateNgrams(toks, n);
      for (const g of grams) {
        if (!ngramIsUsable(g)) continue;
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
  }

  const ranked: PhraseCount[] = [];
  for (const [phrase, count] of counts.entries()) {
    ranked.push({ phrase, count });
  }
  ranked.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    // Tie-break: prefer shorter phrases first, then alphabetical for determinism.
    if (a.phrase.length !== b.phrase.length) return a.phrase.length - b.phrase.length;
    return a.phrase < b.phrase ? -1 : 1;
  });

  return ranked.slice(0, topN);
}

export type BannedWordRawHit = {
  word: string;
  count: number;
  example_passage: string;
  example_source: string;
};

export function detectBannedWords(
  utterances: Utterance[],
  phillipOnly = true,
  sourceFile = "",
): BannedWordRawHit[] {
  const pool = phillipOnly ? utterances.filter(isPhillipUtterance) : utterances;
  const hits: Record<string, { count: number; example_passage: string; example_source: string }> = {};

  for (const u of pool) {
    const lower = u.text.toLowerCase();
    for (const w of BANNED_WORDS) {
      // Word-boundary-ish match: check as substring preceded/followed by
      // a non-letter (or start/end). Good enough — banned words are
      // distinctive enough that false positives are negligible.
      const re = new RegExp(`(^|[^a-z])${escapeRegex(w)}([^a-z]|$)`, "i");
      if (re.test(lower)) {
        if (!hits[w]) {
          hits[w] = { count: 0, example_passage: u.text, example_source: sourceFile };
        }
        hits[w].count += 1;
      }
    }
  }

  const out: BannedWordRawHit[] = [];
  for (const [word, { count, example_passage, example_source }] of Object.entries(hits)) {
    out.push({ word, count, example_passage, example_source });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =========================================================================
// Async helpers (only run from main)
// =========================================================================

async function parseTranscript(path: string): Promise<FathomTranscript | null> {
  try {
    const raw = await Deno.readTextFile(path);
    const json = JSON.parse(raw) as FathomTranscript;
    if (!Array.isArray(json.transcript)) return null;
    return json;
  } catch (err) {
    console.warn(`[warn] skip ${path}: ${(err as Error).message}`);
    return null;
  }
}

function collectObjectionPassages(
  utterances: Utterance[],
  sourceFile: string,
): ObjectionCandidate[] {
  const passages: ObjectionCandidate[] = [];
  for (let i = 0; i < utterances.length - 1; i++) {
    const u = utterances[i];
    if (isPhillipUtterance(u)) continue;
    const lower = u.text.toLowerCase();
    if (!OBJECTION_MARKERS.some((m) => lower.includes(m))) continue;

    // Find Phillip's next utterance within the following 3 slots.
    for (let j = i + 1; j < Math.min(i + 4, utterances.length); j++) {
      if (isPhillipUtterance(utterances[j])) {
        passages.push({
          prospect_passage: u.text,
          phillip_response: utterances[j].text,
          source_file: sourceFile,
          timestamp: u.timestamp,
        });
        break;
      }
    }
  }
  return passages;
}

function collectPeerPassages(
  utterances: Utterance[],
  sourceFile: string,
): CaseStudyCandidate[] {
  const out: CaseStudyCandidate[] = [];
  for (const u of utterances) {
    if (!isPhillipUtterance(u)) continue;
    for (const re of PEER_MARKERS) {
      if (re.test(u.text)) {
        out.push({
          passage: u.text,
          source_file: sourceFile,
          timestamp: u.timestamp,
        });
        break;
      }
    }
  }
  return out;
}

// =========================================================================
// Main
// =========================================================================

const CORPUS_DIR =
  "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Fathom MCP/raw/";

const OUT_CANDIDATES =
  "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/Shared drives/AiAi Mastermind/01_Knowledge Base/AIAI-Vault/60-content/ai-phil/fathom-candidates.json";

function parseLimitFlag(args: string[]): number | null {
  const idx = args.indexOf("--limit");
  if (idx < 0) return null;
  const v = args[idx + 1];
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function main() {
  const args = Deno.args;
  const limit = parseLimitFlag(args);

  const files: string[] = [];
  for await (const entry of Deno.readDir(CORPUS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".json")) {
      files.push(CORPUS_DIR + entry.name);
    }
  }
  files.sort();
  const scanned = limit ? files.slice(0, limit) : files;
  console.log(`[info] scanning ${scanned.length} transcripts (of ${files.length} total)`);

  const allUtterances: Utterance[] = [];
  let objectionPassages: ObjectionCandidate[] = [];
  let peerPassages: CaseStudyCandidate[] = [];

  // Aggregate banned-word hits across all transcripts. We keep per-word
  // counts and the first example we see.
  const bannedAgg: Record<string, { count: number; example_passage: string; example_source: string }> = {};

  let processed = 0;

  for (const path of scanned) {
    const t = await parseTranscript(path);
    processed++;
    if (!t) continue;
    allUtterances.push(...t.transcript);
    objectionPassages = objectionPassages.concat(collectObjectionPassages(t.transcript, path));
    peerPassages = peerPassages.concat(collectPeerPassages(t.transcript, path));

    const perFileBanned = detectBannedWords(t.transcript, true, path);
    for (const hit of perFileBanned) {
      if (!bannedAgg[hit.word]) {
        bannedAgg[hit.word] = {
          count: 0,
          example_passage: hit.example_passage,
          example_source: hit.example_source,
        };
      }
      bannedAgg[hit.word].count += hit.count;
    }

    if (processed % 50 === 0) {
      console.log(
        `[info] progress ${processed}/${scanned.length} (utterances=${allUtterances.length}, objections=${objectionPassages.length}, peers=${peerPassages.length})`,
      );
    }
  }

  const phillipCount = allUtterances.filter(isPhillipUtterance).length;
  console.log(`[info] total utterances=${allUtterances.length} phillip=${phillipCount}`);

  const top = extractTopPhrases(allUtterances, true, 200);
  console.log(`[info] top phrases extracted (${top.length})`);

  const banned: BannedWordCandidate[] = Object.entries(bannedAgg)
    .map(([word, v]) => ({
      word,
      count: v.count,
      example_passage: v.example_passage,
      example_source: v.example_source,
    }))
    .sort((a, b) => b.count - a.count);
  console.log(`[info] accidental banned words (${banned.length})`);

  // Cap candidate list sizes so the downstream Claude session has a
  // predictable working set.
  const objSample = objectionPassages.slice(0, 50);
  const peerSample = peerPassages.slice(0, 30);

  const candidates: FathomCandidates = {
    generated_at: new Date().toISOString(),
    transcripts_scanned: processed,
    phillip_utterance_count: phillipCount,
    top_phrases: top,
    objection_candidates: objSample,
    case_study_candidates: peerSample,
    accidental_banned_words: banned,
  };

  await Deno.writeTextFile(OUT_CANDIDATES, JSON.stringify(candidates, null, 2));
  console.log(`[info] wrote ${OUT_CANDIDATES}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    Deno.exit(1);
  });
}
