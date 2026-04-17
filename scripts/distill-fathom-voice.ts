// distill-fathom-voice.ts
// -------------------------------------------------------------------------
// Mines Phillip Ngo's Fathom meeting transcripts into structured voice
// artifacts (top phrases, recurring objections, peer case studies,
// accidental banned words) that feed the canonical
// `AI-Phil-Voice-Philosophy.md` doc.
//
// Run (small batch):
//   cd scripts
//   deno task distill -- --limit 10
//
// Run (full corpus) — don't do this until Task 7:
//   deno task distill
//
// Pure functions are unit-tested in `distill-fathom-voice.test.ts`.
// Haiku-backed classification lives in async helpers that only run in main.
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

export type BannedWordHit = {
  word: string;
  count: number;
  example: string;
};

export type ObjectionFinding = {
  objection: string;
  phillip_response_pattern: string;
  example_count: number;
};

export type PeerCaseStudy = {
  description: string;
  example_count: number;
};

export type VoiceArtifacts = {
  generated_at: string;
  transcripts_scanned: number;
  phillip_utterance_count: number;
  top_phrases: PhraseCount[];
  recurring_objections: ObjectionFinding[];
  peer_case_studies: PeerCaseStudy[];
  accidental_banned_words: BannedWordHit[];
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
// response pattern (rough heuristic — Haiku confirms/refines downstream).
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
// tells a story about an agency — we pluck those passages for Haiku to
// summarize.
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

export function detectBannedWords(
  utterances: Utterance[],
  phillipOnly = true,
): BannedWordHit[] {
  const pool = phillipOnly ? utterances.filter(isPhillipUtterance) : utterances;
  const hits: Record<string, { count: number; example: string }> = {};

  for (const u of pool) {
    const lower = u.text.toLowerCase();
    for (const w of BANNED_WORDS) {
      // Word-boundary-ish match: check as substring preceded/followed by
      // a non-letter (or start/end). Good enough — banned words are
      // distinctive enough that false positives are negligible.
      const re = new RegExp(`(^|[^a-z])${escapeRegex(w)}([^a-z]|$)`, "i");
      if (re.test(lower)) {
        if (!hits[w]) hits[w] = { count: 0, example: u.text };
        hits[w].count += 1;
      }
    }
  }

  const out: BannedWordHit[] = [];
  for (const [word, { count, example }] of Object.entries(hits)) {
    out.push({ word, count, example });
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

type ObjectionPassage = {
  prospect_utterance: string;
  phillip_response: string;
};

function collectObjectionPassages(utterances: Utterance[]): ObjectionPassage[] {
  const passages: ObjectionPassage[] = [];
  for (let i = 0; i < utterances.length - 1; i++) {
    const u = utterances[i];
    if (isPhillipUtterance(u)) continue;
    const lower = u.text.toLowerCase();
    if (!OBJECTION_MARKERS.some((m) => lower.includes(m))) continue;

    // Find Phillip's next utterance within the following 3 slots.
    for (let j = i + 1; j < Math.min(i + 4, utterances.length); j++) {
      if (isPhillipUtterance(utterances[j])) {
        passages.push({
          prospect_utterance: u.text,
          phillip_response: utterances[j].text,
        });
        break;
      }
    }
  }
  return passages;
}

function collectPeerPassages(utterances: Utterance[]): string[] {
  const out: string[] = [];
  for (const u of utterances) {
    if (!isPhillipUtterance(u)) continue;
    for (const re of PEER_MARKERS) {
      if (re.test(u.text)) {
        out.push(u.text);
        break;
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------------
// Haiku integration — kept intentionally small. The heuristic work above
// already narrows the input ~100x. Haiku's only job is to cluster and name
// the patterns.
// -------------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const HAIKU_MODEL = "claude-haiku-4-5";

type HaikuResponse = {
  content?: Array<{ type: string; text?: string }>;
};

async function callHaiku(
  apiKey: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Haiku call failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as HaikuResponse;
  return json.content?.find((c) => c.type === "text")?.text ?? "";
}

async function clusterObjections(
  apiKey: string,
  passages: ObjectionPassage[],
  maxOut = 20,
): Promise<ObjectionFinding[]> {
  if (passages.length === 0) return [];

  // Batch of 10 passages per call to stay well inside context.
  const batchSize = 10;
  const raw: string[] = [];
  const totalBatches = Math.ceil(passages.length / batchSize);
  for (let i = 0; i < passages.length; i += batchSize) {
    const batch = passages.slice(i, i + batchSize);
    const batchIdx = Math.floor(i / batchSize);
    const passageCount = batch.length;
    console.log(
      `[haiku-objection] batch ${batchIdx + 1}/${totalBatches} (${passageCount} passages) → sending...`,
    );
    const user = batch
      .map(
        (p, idx) =>
          `#${i + idx + 1}\nPROSPECT: ${p.prospect_utterance}\nPHILLIP: ${p.phillip_response}`,
      )
      .join("\n\n");
    const system =
      "You extract prospect objections and Phillip's response patterns from sales-call passages. " +
      "For each passage, write one short line: `OBJECTION: ... | RESPONSE: ...`. " +
      "Use Phillip's exact framing where possible. Do not add commentary.";
    try {
      const txt = await callHaiku(apiKey, system, user);
      raw.push(txt);
      console.log(`[haiku-objection] batch ${batchIdx + 1}/${totalBatches} ok`);
    } catch (err) {
      console.warn(`[warn] haiku objection batch ${i}: ${(err as Error).message}`);
    }
    // Simple cap: stop once we have enough raw lines.
    if (raw.join("\n").split("\n").length > maxOut * 4) break;
  }

  // Cluster pass: ask Haiku to dedupe into up to `maxOut` findings.
  const joined = raw.join("\n").slice(0, 12000);
  const clusterSystem =
    `You cluster objection/response lines into up to ${maxOut} distinct findings. ` +
    `Return JSON: [{"objection":"...","phillip_response_pattern":"...","example_count":N}, ...]. ` +
    `No prose, just JSON.`;
  try {
    const txt = await callHaiku(apiKey, clusterSystem, joined);
    const match = txt.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]) as ObjectionFinding[];
  } catch (err) {
    console.warn(`[warn] haiku objection cluster: ${(err as Error).message}`);
    return [];
  }
}

async function clusterPeerStudies(
  apiKey: string,
  passages: string[],
  maxOut = 10,
): Promise<PeerCaseStudy[]> {
  if (passages.length === 0) return [];

  const batchSize = 10;
  const raw: string[] = [];
  const totalBatches = Math.ceil(passages.length / batchSize);
  for (let i = 0; i < passages.length; i += batchSize) {
    const batch = passages.slice(i, i + batchSize);
    const batchIdx = Math.floor(i / batchSize);
    const passageCount = batch.length;
    console.log(
      `[haiku-peer-study] batch ${batchIdx + 1}/${totalBatches} (${passageCount} passages) → sending...`,
    );
    const user = batch.map((p, idx) => `#${i + idx + 1}\n${p}`).join("\n\n");
    const system =
      "You extract peer case-study fragments from Phillip's sales-call utterances. " +
      "For each passage, write one short line describing the peer agency " +
      "(size, location, numbers, outcome). If no case study is present, skip.";
    try {
      const txt = await callHaiku(apiKey, system, user);
      raw.push(txt);
      console.log(`[haiku-peer-study] batch ${batchIdx + 1}/${totalBatches} ok`);
    } catch (err) {
      console.warn(`[warn] haiku peer batch ${i}: ${(err as Error).message}`);
    }
    if (raw.join("\n").split("\n").length > maxOut * 4) break;
  }

  const joined = raw.join("\n").slice(0, 12000);
  const clusterSystem =
    `You cluster case-study lines into up to ${maxOut} distinct peer stories. ` +
    `Return JSON: [{"description":"...","example_count":N}, ...]. No prose, just JSON.`;
  try {
    const txt = await callHaiku(apiKey, clusterSystem, joined);
    const match = txt.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]) as PeerCaseStudy[];
  } catch (err) {
    console.warn(`[warn] haiku peer cluster: ${(err as Error).message}`);
    return [];
  }
}

// =========================================================================
// Output writers
// =========================================================================

export function renderArtifactMd(a: VoiceArtifacts): string {
  const lines: string[] = [];
  lines.push(`# Fathom Voice Artifacts`);
  lines.push("");
  lines.push(`_Generated: ${a.generated_at}_`);
  lines.push(`_Transcripts scanned: ${a.transcripts_scanned}_`);
  lines.push(`_Phillip utterances: ${a.phillip_utterance_count}_`);
  lines.push("");

  lines.push(`## 1. Top Phrases (Phillip only, 3- to 7-grams)`);
  lines.push("");
  lines.push(`| Rank | Count | Phrase |`);
  lines.push(`| --- | --- | --- |`);
  a.top_phrases.forEach((p, i) => {
    lines.push(`| ${i + 1} | ${p.count} | ${p.phrase} |`);
  });
  lines.push("");

  lines.push(`## 2. Recurring Objections + Phillip's Response Patterns`);
  lines.push("");
  if (a.recurring_objections.length === 0) {
    lines.push(`_No objections clustered this run._`);
  } else {
    for (const o of a.recurring_objections) {
      lines.push(`- **${o.objection}** (n=${o.example_count})`);
      lines.push(`  - Response: ${o.phillip_response_pattern}`);
    }
  }
  lines.push("");

  lines.push(`## 3. Peer Case Studies`);
  lines.push("");
  if (a.peer_case_studies.length === 0) {
    lines.push(`_No peer case studies clustered this run._`);
  } else {
    for (const c of a.peer_case_studies) {
      lines.push(`- ${c.description} (n=${c.example_count})`);
    }
  }
  lines.push("");

  lines.push(`## 4. Accidental Banned Words (Phillip self-use)`);
  lines.push("");
  if (a.accidental_banned_words.length === 0) {
    lines.push(`_No banned-word self-use detected this run._`);
  } else {
    lines.push(`| Word | Count | Example |`);
    lines.push(`| --- | --- | --- |`);
    for (const b of a.accidental_banned_words) {
      const ex = b.example.length > 160 ? b.example.slice(0, 157) + "…" : b.example;
      lines.push(`| ${b.word} | ${b.count} | ${ex.replace(/\|/g, "\\|")} |`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

async function writeArtifactMd(path: string, a: VoiceArtifacts): Promise<void> {
  await Deno.writeTextFile(path, renderArtifactMd(a));
}

async function writeArtifactJson(path: string, a: VoiceArtifacts): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(a, null, 2));
}

// =========================================================================
// Main
// =========================================================================

const CORPUS_DIR =
  "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Fathom MCP/raw/";

const OUT_MD =
  "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/Shared drives/AiAi Mastermind/01_Knowledge Base/AIAI-Vault/60-content/ai-phil/fathom-voice-artifacts.md";
const OUT_JSON =
  "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/Shared drives/AiAi Mastermind/01_Knowledge Base/AIAI-Vault/60-content/ai-phil/fathom-voice-artifacts.json";

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
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required.");
    Deno.exit(1);
  }

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
  let objectionPassages: ObjectionPassage[] = [];
  let peerPassages: string[] = [];
  let processed = 0;

  for (const path of scanned) {
    const t = await parseTranscript(path);
    processed++;
    if (!t) continue;
    allUtterances.push(...t.transcript);
    objectionPassages = objectionPassages.concat(collectObjectionPassages(t.transcript));
    peerPassages = peerPassages.concat(collectPeerPassages(t.transcript));
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

  const banned = detectBannedWords(allUtterances, true);
  console.log(`[info] accidental banned words (${banned.length})`);

  // Cap Haiku input sizes. Heuristic already narrowed these; this caps spend.
  const objSample = objectionPassages.slice(0, 50);
  const peerSample = peerPassages.slice(0, 30);

  console.log(`[info] calling Haiku for objections (${objSample.length} passages)`);
  const objections = await clusterObjections(apiKey, objSample, 20);
  console.log(`[info] calling Haiku for peer case studies (${peerSample.length} passages)`);
  const peers = await clusterPeerStudies(apiKey, peerSample, 10);

  const artifacts: VoiceArtifacts = {
    generated_at: new Date().toISOString(),
    transcripts_scanned: processed,
    phillip_utterance_count: phillipCount,
    top_phrases: top,
    recurring_objections: objections,
    peer_case_studies: peers,
    accidental_banned_words: banned,
  };

  await writeArtifactJson(OUT_JSON, artifacts);
  await writeArtifactMd(OUT_MD, artifacts);
  console.log(`[info] wrote ${OUT_MD}`);
  console.log(`[info] wrote ${OUT_JSON}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    Deno.exit(1);
  });
}
