# AI Sales System v2 / Relationship Intelligence System (RIS) — Phase 1

**Date:** 2026-04-16
**Status:** Design approved by Phillip, ready to plan
**Author:** Claude Code session (sub-agent-driven)
**Related roadmap items:** P4 NORTH STAR (RIS pillar), P4a (voice doc), P4b (extend to member + Hume — Phase 2), P4c (cold outreach playbook prep)

---

## 1. Frame

AI Phil is not a sales bot, support bot, or widget. It is **one continuous Phillip Ngo personality** appearing across every touchpoint (cold outreach → sales → onboarding → member support → Implementation Coach → voice → future), sharing a single voice, a single rapport memory of every fact a prospect has ever shared, and a single sales/relationship philosophy fused with proven frameworks.

Phillip self-rates 6–7/10 at sales. The goal of this system is not to mimic him — it is to deliver **"Phillip at his 9/10 moments, consistently, every conversation, forever."**

This spec covers **Phase 1** of the RIS pillar: the sales system. It establishes the infrastructure (voice doc, rapport memory, extraction pipeline) that later phases extend to member support, Hume voice configs, and cold outreach.

## 2. Problem and motivation

Current state:
- `ghl-sales-agent` (v9, live) handles inbound SMS/email from non-member prospects. Conversation history lives in `ops.ai_inbox_conversation_memory`. System prompts include a minimal voice description but no sales framework, no F.O.R.M. rapport framework, no personalization beyond name/tags.
- `ghl-member-agent` (v1, live) handles members. Similar prompt shape, different context.
- No follow-up agent exists. When the sales agent sends the checkout URL, a single row is written to `ops.ai_inbox_followup_queue` with `next_send_at = +24hr`, but nothing consumes that queue.
- No per-contact rapport memory. If a prospect tells the sales agent their dog's name is Lucy, that fact is only discoverable by reading raw conversation history, and no future agent surfaces it.
- 759 Fathom meeting transcripts exist at `~/My Drive/Coding Projects/Fathom MCP/raw/` (a year of Phillip's actual sales voice) and are unused.
- Research from two independent sources (Claude deep-research agent + Publicity) converged: 3-touch decision sequence (24hr / 3day / 7day) followed by nurture drip, email primary, personalization beyond name is 6× more effective, insurance-operator tone required.

Gaps this spec closes:
1. No shared voice module — sales agent and future agents drift independently
2. No rapport memory — every conversation starts cold relative to the prospect's life
3. No follow-up automation — 76% of conversions that require 5+ touches are being lost
4. No F.O.R.M. framework — agents don't actively listen for or reflect relationship signals
5. Phillip's 759 transcripts of voice data are unmined

## 3. Goals and non-goals

**Goals (Phase 1):**
1. Ship `AI-Phil-Voice-Philosophy.md` in the vault as canonical voice source
2. Ship `salesVoice.ts` shared module consumed by sales agent + followup
3. Ship `ops.contact_rapport` table + extraction pipeline + retrieval
4. Ship `ghl-sales-followup` edge function (3-touch decision + nurture up to touch 9)
5. Overhaul `ghl-sales-agent` prompts to use voice + rapport
6. Mine 759 Fathom transcripts into structured voice artifact
7. Ship KB doc caching + memory table index (scaling prep)
8. Ship `Cold-Outreach-Playbook.md` first draft in vault (future-project prep)

**Non-goals (deferred to later phases):**
- Extending voice + rapport to `ghl-member-agent` (Phase 2)
- Updating Hume EVI configs (Phase 2)
- Internet research tool for local/personal context lookup (Phase 3)
- Fine-tuning Claude on Fathom corpus (not needed until 10k+/wk)
- Preferred-send-hour logic based on prospect response patterns (deferred — marginal lift)
- Multi-channel escalation in followup (email ↔ SMS switching — deferred)
- Paused-queue `paused_at` column (using `next_send_at` manipulation instead)
- Observability dashboard (P7)
- Eval harness (promoted from P2 to immediately post-ship; prerequisite for prompt iteration at scale)

## 4. Architecture overview

```
                    ┌─────────────────────────────────────────┐
                    │  AI-Phil-Voice-Philosophy.md  (vault)   │
                    │  master: identity / voice / F.O.R.M. /  │
                    │  banned + preferred vocab / frameworks  │
                    └────────────────────┬────────────────────┘
                                         │  (hand-sync, per edit)
                                         ↓
                    ┌─────────────────────────────────────────┐
                    │  supabase/functions/_shared/            │
                    │  salesVoice.ts   (TS mirror)            │
                    └──────┬───────────────────────┬──────────┘
                           │                       │
                 ┌─────────▼──────────┐  ┌─────────▼──────────┐
                 │  ghl-sales-agent   │  │ ghl-sales-followup │
                 │  (prompts updated) │  │  (new, pg-cron)    │
                 └─────────┬──────────┘  └─────────┬──────────┘
                           │                       │
                           │ reads + writes        │ reads + writes
                           ↓                       ↓
                    ┌─────────────────────────────────────────┐
                    │  Supabase ops schema:                   │
                    │  • ai_inbox_conversation_memory         │
                    │  • ai_inbox_followup_queue              │
                    │  • contact_rapport  ← NEW               │
                    └─────────────────────────────────────────┘
                                         ↑
                                         │
                    ┌─────────────────────────────────────────┐
                    │  Post-conversation F.O.R.M. extractor   │
                    │  (called at end of each sales agent +   │
                    │  followup conversation, writes rapport) │
                    └─────────────────────────────────────────┘
```

Parallel one-time batch:
```
759 Fathom transcripts → distillation script → voice artifact
(phrases, objection patterns, peer case studies, banned words used accidentally)
→ merged into AI-Phil-Voice-Philosophy.md
```

## 5. Components

### 5.1 `AI-Phil-Voice-Philosophy.md` (vault master)

**Location:** `vault/60-content/ai-phil/AI-Phil-Voice-Philosophy.md`

**Sections:**
1. **Identity** — who Ai Phil is (an AI assistant, never claims to be Phillip), identity rules per context
2. **Voice attributes** — direct, warm, real, short sentences, contractions, calm certainty, peer-level, no exclamation points
3. **Hormozi opener rule** — every first message must reference the prospect's exact last stated pain, goal, or message. If no prior history, open with a qualifying F.O.R.M. question.
4. **F.O.R.M. framework** — Family / Occupation / Recreation / Money. How to listen, how to naturally ask, how to reflect facts back in future messages without sounding like a bot reading from a database.
5. **Sales frameworks** (Phillip's philosophy + proven frameworks):
   - Ask before you pitch. Qualify first, always.
   - Frame outcome before price.
   - Handle objections with questions, not defenses.
   - Max 2 sentences before asking a question.
   - Real scarcity only (cohort dates, capacity) — never fabricated urgency.
   - Touch-angle mapping: Touch 1 = clarity + peer proof, Touch 2 = objection handling, Touch 3 = soft close with real constraint.
6. **Banned vocabulary** — transform, unlock, dream business, abundance, manifest, step into your power, 10X overnight, quantum leap, secret system, synergy, leverage (verb), seamless, robust, comprehensive, delve, Hey
7. **Preferred vocabulary** (insurance operator) — PIF, premium growth, close rate, retention ratio, production per producer, book of business, carrier mix, staff leverage, organic growth, process, implementation
8. **Proof shape requirements** — peer case study with real agency size, carrier mix, geography, documented numerical outcome. No celebrity endorsements. No vague "our students say" testimonials.
9. **Channel-specific rules:**
   - SMS: under 480 chars, no markdown, single thought
   - Email: short paragraphs (3–4 sentences), subject line pattern, signature
   - Voice (Hume, later phase): "A I A I Mastermind dot com" pronunciation, conversational pacing
   - Cold outreach (future): brevity-critical, deliverability rules, preempt skepticism
10. **Context adaptations** — same voice, different goals:
    - Sales: close-oriented, CTA = checkout link
    - Member support: helpful, no pitching, escalate when needed
    - Voice: conversational pacing, no markdown
    - Cold: brevity, deliverability
11. **Fathom-distilled artifact** (generated) — Phillip's top 200 actual phrases, top 20 recurring objections + his actual responses, 10 peer case studies with real numbers
12. **Never-lie rules** — never say "I don't have access to previous conversations" when conversation history is in context (past bug); never fabricate numbers; never invent events/dates not in KB

**Ownership:** Phillip edits the master. `salesVoice.ts` is hand-synced on each material change.

### 5.2 `salesVoice.ts` (shared TypeScript module)

**Location:** `supabase/functions/_shared/salesVoice.ts`

**Exports:**
- `BANNED_WORDS: readonly string[]` — checked in a guardrail pass after Claude returns text
- `PREFERRED_VOCAB: readonly string[]` — mentioned in system prompt as encouragement
- `IDENTITY_BLOCK: string` — reusable system prompt section
- `VOICE_BLOCK: string` — tone and sentence rules
- `FORM_FRAMEWORK_BLOCK: string` — F.O.R.M. listening + reflection instructions
- `SALES_FRAMEWORKS_BLOCK: string` — Phillip's methodology + Hormozi opener rule
- `PROOF_SHAPE_BLOCK: string`
- `buildSystemPrompt(context: VoiceContext, rapport: RapportFacts, history: string, extras?: string): string` — composes a context-appropriate system prompt

**`VoiceContext`:** `'sales-live' | 'sales-followup-1' | 'sales-followup-2' | 'sales-followup-3' | 'sales-nurture' | 'event' | 'support' | 'unknown'`

**`RapportFacts`:** see §5.3 for shape

**Guardrail:** after Claude returns text, a cheap regex check looks for banned words. If found, one retry with an explicit correction instruction. If still present on retry, the message sends anyway (log to `agent_signals` for review — don't block the outbound message).

### 5.3 `ops.contact_rapport` table

**Schema (new migration):**

```sql
CREATE TABLE ops.contact_rapport (
  contact_id      text PRIMARY KEY,
  facts           jsonb NOT NULL DEFAULT '{}'::jsonb,
  fact_count      int NOT NULL DEFAULT 0,
  last_extracted_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contact_rapport_updated_at_idx
  ON ops.contact_rapport (updated_at DESC);
```

**`facts` jsonb shape:**

```json
{
  "family": [
    { "key": "dog_name", "value": "Lucy", "source_conv": "6gnFn...", "extracted_at": "2026-04-16T..." },
    { "key": "daughter_name", "value": "Sarah", "source_conv": "6gnFn...", "extracted_at": "..." },
    { "key": "daughter_school", "value": "Spring View Middle School", "...": "..." }
  ],
  "occupation": [
    { "key": "agency_carrier", "value": "State Farm", "..." },
    { "key": "agency_size_producers", "value": 3, "..." }
  ],
  "recreation": [
    { "key": "sport_watched", "value": "football", "..." },
    { "key": "team", "value": "Cowboys", "..." }
  ],
  "money": [
    { "key": "stated_goal_premium", "value": "$5M by 2028", "..." },
    { "key": "biggest_cost", "value": "agent churn 3/yr", "..." }
  ]
}
```

**Append-only, keep-forever:** when a new fact for the same key arrives, append (don't overwrite). Timeline matters — "Lucy passed away" is different from "got a new dog Lucy." Let the AI read the timeline.

**RLS:** service-role only, consistent with other `ops` tables.

### 5.4 Post-conversation F.O.R.M. extractor

**Where it runs:** at the end of each successful `ghl-sales-agent` and `ghl-sales-followup` conversation turn (Step 9 / 10 in the sales-agent, new Step in followup), after memory + queue writes.

**Logic:**
1. Read the two new memory rows (user message + assistant reply) just written
2. Read up to 10 prior rapport facts for this contact (context for dedup)
3. Call Claude Haiku with a compact extraction prompt: "Given this conversation turn and the existing rapport facts, extract any NEW facts in F.O.R.M. categories. Return strict JSON. Do not re-extract facts already present."
4. Parse JSON response. For each new fact, append to the contact's `facts` jsonb under the right category.
5. Non-fatal: if extraction fails, log to `agent_signals` and continue. Never blocks the outbound message.

**Model:** Haiku 4.5 (cost + speed — extraction is simple, Sonnet is overkill).

**Cost estimate:** ~$0.0005 per extraction × 3 followups × 1000 prospects/wk = ~$1.50/wk. Negligible.

### 5.5 Rapport context injection

**When building any sales prompt:**
1. Read full `contact_rapport.facts` for the contact
2. Format as a compact text block under a heading "WHAT WE KNOW ABOUT THIS PERSON (reference naturally, never list back to them like a database)"
3. Inject into system prompt via `salesVoice.buildSystemPrompt()`

**Prompt instruction:** "Reference these facts naturally when relevant. Do NOT read them back like a list. Do NOT bring up every fact every time. Choose one that fits the current moment."

**Example injected block:**
```
WHAT WE KNOW ABOUT THIS PERSON:
Family: dog named Lucy; daughter Sarah at Spring View Middle School (loves her pink jacket)
Occupation: State Farm agency, 3 producers, 7 years in business
Recreation: Cowboys fan, watches football Sundays
Money: goal $5M premium by 2028; current biggest pain is agent churn (lost 3 last year)
```

### 5.6 `ghl-sales-agent` prompt overhaul

**Changes to existing file** `supabase/functions/ghl-sales-agent/index.ts`:

1. Import from `../_shared/salesVoice.ts`
2. Replace inline `salesSystemPrompt`, `eventSystemPrompt`, `supportSystemPrompt`, `unknownPrompt` bodies with calls to `buildSystemPrompt(context, rapport, history)`
3. Before Claude call, fetch rapport via new helper `fetchRapport(contactId)`
4. After successful send + memory write, call new helper `extractAndStoreRapport(contactId, userMessage, assistantReply)`
5. **NEW: pause-on-reply logic** — if an active row exists in `ai_inbox_followup_queue` for this contact, update `next_send_at = now() + INTERVAL '3 days'`. This is how live conversations auto-pause the followup sequence.
6. Guardrail pass: after Claude returns text, scan for banned words. If found, one retry with correction.

**Backward compat:** the endpoint contract (webhook body shape) does not change. GHL workflows continue to call the same URL. Zero impact on live ops beyond the prompt improvements.

### 5.7 `ghl-sales-followup` edge function (new)

**Location:** `supabase/functions/ghl-sales-followup/index.ts`

**Trigger:** pg_cron, `0 9-17 * * 1-5` (top of hour, 9am–5pm Mon–Fri). Fires `net.http_post` to the function URL (auth via vault secret, matching the `sync-knowledge-base` pattern — NO hardcoded JWTs, per CLAUDE.md guardrail).

**Handler flow:**
1. Authenticate cron caller (service-role JWT from vault secret)
2. Query `ops.ai_inbox_followup_queue WHERE next_send_at <= now()` (limit 100 as safety, log if we hit it)
3. For each due row, in sequence:
   a. Fetch GHL contact. If `aiai-member-active` tag present → they converted to member → delete queue row + log signal, skip
   b. Fetch `ops.ai_inbox_conversation_memory` (last 20 rows for this contact)
   c. Fetch `ops.contact_rapport.facts` for this contact
   d. Determine touch context from `follow_up_number`:
      - 1 → `sales-followup-1` (clarity + proof)
      - 2 → `sales-followup-2` (objection handling)
      - 3 → `sales-followup-3` (soft close)
      - 4–9 → `sales-nurture` (value drip)
   e. Call Claude Sonnet with `buildSystemPrompt()` — enforces Hormozi opener rule on every touch
   f. Guardrail scan (banned vocab)
   g. Send via GHL API (strip markdown + 480 cap for SMS, full HTML for email)
   h. Write one assistant row to `ai_inbox_conversation_memory` (no user row — this is a pure outbound trigger, not a reply to an inbound). `formatHistory` treats multiple consecutive AI rows fine (verified in existing `ghl-sales-agent` code).
   i. Extract F.O.R.M. facts from the assistant message only (may or may not yield new facts on a pure outbound — extractor is resilient to this)
   j. Update the queue row — every touch below sends a message first, then updates:
      - Touch 1 just fired: `follow_up_number = 2, next_send_at = created_at + 3 days`
      - Touch 2 just fired: `follow_up_number = 3, next_send_at = created_at + 7 days`
      - Touch 3 just fired (last decision touch): `follow_up_number = 4, next_send_at = now() + 30 days` (nurture anchor shifts from `created_at` to last send time)
      - Touches 4–8 just fired: increment `follow_up_number`, `next_send_at = now() + 30 days`
      - Touch 9 just fired (final nurture): delete queue row, add GHL tag `🔚ai-nurture-ended`. Touch 9 is the 6th and last nurture message (3 decision + 6 nurture = 9 total).
   k. Write `agent_signals` audit row
4. Return `{ ok: true, processed: N, errors: M }`

**Timing recalc:** the cadence is anchored to the **original checkout-link send time** (= queue row's `created_at`), not the last followup. So:
- After FU1 (sent ~24hr after created_at): `next_send_at = created_at + 3 days`
- After FU2 (sent ~3 days after created_at): `next_send_at = created_at + 7 days`
- After FU3 (sent ~7 days after created_at): `next_send_at = now() + 30 days` (nurture starts from last touch)

**Idempotency:** if the function crashes mid-loop, the row's `next_send_at` is unchanged → it'll be processed again on the next cron run. Edge case: if the GHL send succeeded but the DB update failed, the prospect might get a duplicate message on the next cron run. Mitigation: transaction boundary — DB update happens BEFORE the GHL send is acknowledged as fatal, and a `last_sent_at timestamp` column on the queue row prevents dual-sends within 1 hour. (Add `last_sent_at timestamptz NULL` column in the same migration.)

### 5.8 Fathom distillation script (one-time + re-runnable)

**Location:** `scripts/distill-fathom-voice.ts`

**Purpose:** mine the 759 transcripts at `~/My Drive/Coding Projects/Fathom MCP/raw/*.json` into structured voice artifacts that feed the voice doc.

**Outputs:**
1. `vault/60-content/ai-phil/fathom-voice-artifacts.md` — auto-generated section included in voice doc:
   - Top 200 phrases Phillip actually uses (frequency-ranked, filtered for substantive 3+ word phrases)
   - Top 20 recurring objections + Phillip's actual response patterns
   - 10 peer case studies mentioned in transcripts (agency size, outcome, quoted passage)
   - "Accidental banned words" — Phillip sometimes uses coach-speak; we flag these so the agent explicitly avoids them even though Phillip said them
2. `vault/60-content/ai-phil/fathom-voice-artifacts.json` — structured same content for downstream consumption

**Algorithm (high level):**
1. Parse each JSON transcript, extract Phillip's utterances (by speaker id)
2. Tokenize, count n-grams (3-gram to 7-gram), filter stopwords + names
3. For objections: use Claude Haiku to classify passages where prospect raises concern + Phillip's response (async batch, cost-controlled)
4. For case studies: regex + Claude Haiku to identify "agency X did Y got Z" patterns
5. Write both files

**Cost:** ~$5–15 for the one-time Claude batch processing across 759 transcripts. Cap with limit flag in script.

**Re-run policy:** when new Fathom transcripts accumulate (say monthly), re-run the script, regenerate artifacts, PR the updated voice doc.

### 5.9 KB doc caching

**Location:** `supabase/functions/_shared/kbCache.ts`

**Behavior:** wraps `fetchGoogleDoc(docId, fallback)`. Caches fetched content in `ops.kb_doc_cache` table with a 30-min TTL. Both sales agent and followup use this wrapper.

**Schema:**
```sql
CREATE TABLE ops.kb_doc_cache (
  doc_id          text PRIMARY KEY,
  content         text NOT NULL,
  fetched_at      timestamptz NOT NULL DEFAULT now()
);
```

Read-through: fetch from cache; if empty or older than 30 min, fetch fresh, upsert cache, return.

**Impact:** cuts Google Doc API calls from 2 per conversation to 2 per 30-min window across all conversations. At 1000 conversations/wk this is ~2000 saved API calls/wk.

### 5.10 Memory table index

**Migration:**
```sql
CREATE INDEX IF NOT EXISTS ai_inbox_memory_contact_created_idx
  ON ops.ai_inbox_conversation_memory (contact_id, created_at DESC);
```

**Rationale:** every conversation triggers a `WHERE contact_id = ? ORDER BY created_at DESC LIMIT 20` query. At 150k+ rows (3 years retention, 1000/wk), a sequential scan would become noticeable. Index is cheap and future-proofs.

### 5.11 `Cold-Outreach-Playbook.md` first draft

**Location:** `vault/60-content/ai-phil/Cold-Outreach-Playbook.md`

**Scope for Phase 1:** first-draft document only. No code. Not referenced by any running function. Sits in vault ready for a future project.

**Content:**
1. Inherits voice from `AI-Phil-Voice-Philosophy.md` (via reference)
2. Cold-specific addenda:
   - Subject line patterns (curiosity + specificity, no clickbait)
   - Preview text patterns
   - Deliverability guardrails (volume ramp, warming, CAN-SPAM, unsubscribe)
   - Proof shape for cold (peer agency name + size + result, hyper-specific)
   - Preempt objections (how did you get my email, not interested in coaching)
   - Webinar/challenge offer positioning for insurance agents
   - Web-scraping personalization signals (agency name, size hint, carrier, location, years, website)
   - Cold cadence (5–7 touches over 3–4 weeks, different from warm followup)

## 6. Data flow walkthroughs

### 6.1 First inbound from new prospect

1. GHL workflow fires webhook to `ghl-sales-agent`
2. Agent validates, extracts fields, fetches contact + conversation history in parallel
3. **NEW:** fetches empty `contact_rapport` for this contact
4. Agent calls `buildSystemPrompt('sales-live', emptyRapport, history)` — since rapport empty, system prompt instructs: "open with a qualifying F.O.R.M. question (Family / Occupation / Recreation / Money) naturally — don't interrogate"
5. Intent classified, reply generated with Sonnet
6. Guardrail scan (no banned words), reply sent via GHL
7. Memory rows written
8. **NEW:** post-conversation F.O.R.M. extractor runs on this turn (Haiku)
   - Extracted facts written to `contact_rapport.facts`
9. Signal audit row written

### 6.2 Prospect replies with rapport signals

Message: "Yeah I'm slammed — my 3-producer State Farm agency in Dallas is drowning in policy renewals. I'd love to get more time to watch the Cowboys on Sunday."

1. Same inbound flow
2. **NEW:** rapport fetch returns existing facts from prior turns (if any)
3. System prompt includes rapport context with injection rules
4. Reply generated — references the exact pain ("3-producer drowning in renewals") and optionally the recreation (Cowboys) if it fits naturally. Never both in a forced way.
5. Memory + send + extraction
6. Extractor adds new facts:
   - `occupation.agency_carrier = "State Farm"`
   - `occupation.agency_size_producers = 3`
   - `occupation.geography = "Dallas"`
   - `occupation.biggest_pain = "policy renewals overload"`
   - `recreation.sport_watched = "football (Cowboys)"`

### 6.3 Checkout URL sent → followup sequence triggers

1. Sales agent reply includes `https://aiaimastermind.com`
2. Queue row upserted: `follow_up_number=1, next_send_at = now() + 24hr`
3. **24 hours later:** pg_cron fires `ghl-sales-followup`
4. Function processes this row:
   - Contact not a member → continue
   - Fetch memory (all prior conversations)
   - Fetch rapport (rich F.O.R.M. facts accumulated)
   - Touch 1 context: Sonnet generates message that opens with reference to their stated pain, includes peer proof of a similar-size agency, ends with soft CTA back to checkout
   - Guardrail, send, memory write, rapport extraction (might yield nothing new)
   - Queue updated: `follow_up_number=2, next_send_at = created_at + 3 days`
5. Prospect replies → `ghl-sales-agent` handles → pauses queue via `next_send_at = now() + 3 days`
6. If prospect goes silent again → 3 days later queue fires FU2

### 6.4 Nurture mode (touches 4–9)

Prospect reaches Touch 3 without converting. FU3 fires with soft close. Queue advances to `follow_up_number=4, next_send_at = now() + 30 days`.

Every 30 days for 6 months, the followup function generates a **nurture message** — CTA is softer (reply, thoughts, how's that Q1 going), content is pure value (new case study, Phillip's new framework from last Thursday's workshop, relevant event invite). Opener still follows the Hormozi rule — reference the exact last thing they said months ago.

Touch 9 (the 6th and final nurture message) fires normally — Sonnet writes the last value drop, message is sent. Instead of incrementing to 10, the function deletes the queue row and adds the `🔚ai-nurture-ended` GHL tag. No future cron run will pick this contact up again unless a new GHL event re-queues them.

## 7. Error handling and failure modes

| Failure | Behavior | Recovery |
|---|---|---|
| Claude API down | Sales agent: sends fallback greeting. Followup: skips the row, logs error, retries on next cron run. | Auto-retry on next cycle. |
| GHL API down | Sales agent: returns 500. Followup: skips row with unchanged `next_send_at` → retried next cycle. | Auto. |
| Rapport extraction fails | Logged, conversation continues without new rapport facts. | Ignore; next turn will try again. |
| Guardrail finds banned word | Single retry with correction instruction. If still present, log + send anyway. | Manual review from logs. |
| Queue row has corrupt `contact_id` | GHL contact fetch returns null, skip row, log. | Manual cleanup via admin query. |
| 100+ rows due in one cron run (unlikely now) | Process first 100, log warning, remaining will be picked up next hour. | Monitor; add pagination if hit. |
| F.O.R.M. extractor writes bad JSON | Parse fails, skip extraction for that turn. | Extract attempts resume on next turn. |
| Voice doc out of sync with `salesVoice.ts` | `salesVoice.ts` is source of truth for code path. Voice doc drift doesn't break runtime, just documentation. | Manual re-sync PR. |

## 8. Testing strategy

**Deno unit tests (no Supabase calls):**
- F.O.R.M. extractor JSON parsing (happy path, malformed output, empty response)
- Rapport formatter (empty facts → sensible block, full facts → formatted block, deduping logic)
- `buildSystemPrompt()` composition for each context
- Queue cadence calculator: given `follow_up_number` and `created_at`, next `next_send_at` is correct
- Banned-word guardrail detection (true positives, avoid false positives like "leverage" in "take advantage")

**Integration tests (against real Supabase preview branch):**
- End-to-end: simulated sales reply → rapport fact appears in table
- Followup function: seed a row, trigger, verify message sent + row advanced
- Pause-on-reply: seed followup row, simulate sales-agent reply, verify `next_send_at` pushed out

**Smoke tests (against deployed function):**
- 3 HTTP smoke tests for `ghl-sales-followup` (bad auth, missing cron secret, invalid method)
- Manual: send real test message, verify rapport facts appear, verify followup fires on expected schedule

**Fathom distillation verification:**
- Run against 10-transcript subset first, review output manually
- Full run only after subset approved

**Eval harness (post-ship, promoted from P2):**
- Gold set: 30 real conversations from `ai_inbox_conversation_memory` with expected "good reply" characteristics
- Run each through updated system prompt, score for: opener references prior pain (0/1), banned words count, length, F.O.R.M. extraction accuracy

## 9. Security and compliance

- `contact_rapport` — service-role only (consistent with other `ops` tables)
- RLS enabled with no policy (service role bypasses)
- No secrets hardcoded in SQL or source — cron auth via `vault.decrypted_secrets` (pattern from `sync-knowledge-base`)
- `get_advisors('security')` mandatory after migration
- PII consideration: rapport facts ARE PII. Ensure no logging of full rapport blocks in agent_signals (truncate to counts, not content)
- CAN-SPAM: every email sent includes unsubscribe link (handled via GHL's email template, existing behavior)
- TCPA: SMS sends respect business hours (9am–5pm recipient local — MVP assumes Eastern; upgrade later with GHL timezone)

## 10. Migration plan

1. Voice doc draft (vault) — Phillip reviews and approves wording
2. Fathom distillation script — run on 10-transcript subset, approve, run full
3. Schema migration: `contact_rapport`, `kb_doc_cache`, `last_sent_at` on followup queue, memory index
   - Draft SQL, Phillip reviews, apply
   - Run `get_advisors('security')` post-apply, fix anything non-INFO
4. `salesVoice.ts` shared module
5. Extraction helper + rapport fetch helper
6. `ghl-sales-agent` prompt overhaul + rapport integration + pause-on-reply — deploy BEFORE followup goes live (sales agent is forward-compatible with an empty queue)
7. Run smoke tests against live sales agent, verify no regressions
8. `ghl-sales-followup` edge function — deploy, smoke test
9. pg_cron job registration (vault-secret auth)
10. Verify Phillip's one existing queue row (test contact) fires correctly on next cron cycle
11. `Cold-Outreach-Playbook.md` drafted in vault (no runtime impact)
12. Session close-out per CLAUDE.md (commit every edge function version, run advisors, update roadmap)

## 11. Rollback plan

- Sales agent prompt overhaul: revert to previous `index.ts` commit, redeploy
- Followup function: disable pg_cron job (keeps deployed function but stops firing). Queue rows stay in place.
- Rapport table: if extractor misbehaves, disable extractor helper (empty stub); prompts gracefully handle empty rapport
- Migrations: all additive (new tables, new columns, new index) — no destructive rollback needed

## 12. Open questions (resolve before plan)

1. **Voice doc draft iteration** — does Phillip want to draft the voice doc prose himself (with me filling in structure + frameworks), or have me draft v1 and he edits? Affects who owns the first pass.
2. **F.O.R.M. extraction conservatism** — should the extractor be (a) aggressive and write any plausible fact, or (b) conservative and only write facts that appear explicitly? Recommendation: conservative in v1 (false positives erode trust — "I thought you said your daughter went to Springview when she actually goes to Springside").
3. **Cadence anchor** — locked to `created_at` of the queue row (original checkout-link send time) vs. walking forward from last send. Recommendation: anchor to `created_at` for the 3-touch decision window so the math is predictable; walk forward for nurture.
4. **Nurture upper bound** — 9 touches over 6 months, or extend indefinitely with monthly cadence? Recommendation: 9 touches then stop + tag. A prospect who hasn't engaged in 6 months is not coming back without a new trigger event.

## 13. Success criteria

**Phase 1 ship (this spec):**
- Every sales agent reply post-overhaul passes the banned-word scan
- 95%+ of replies reference something specific from prior conversation (Hormozi rule)
- `contact_rapport` table populates for every conversation (verify via sample)
- Followup function ships, fires for the existing queue row, sends a message that references prospect's stated pain
- Voice doc is in vault, has Fathom-distilled artifacts, is the single source of truth
- Cold Outreach Playbook drafted in vault

**Pillar success (long-term, validates the architecture):**
- Phillip reads a 3-month-old conversation between a prospect and Ai Phil and cannot tell it's not him
- A prospect who moved from cold email → sales SMS → discovery voice call → member onboarding has rapport facts carried through all four touchpoints, referenced naturally each time
- Conversion rate from "received checkout link" to "enrolled" measurably improves vs current baseline (requires eval harness to measure — post-ship P2)

## 14. Related documents

- `vault/60-content/ai-phil/_ROADMAP.md` — P4 NORTH STAR pillar, P4a-c sub-items
- `vault/50-meetings/2026-04-16-ghl-member-agent-shipped.md` — previous session ship
- `supabase/functions/ghl-sales-agent/index.ts` — existing function being overhauled
- `supabase/functions/ghl-member-agent/index.ts` — reference pattern, receives voice/rapport extension in Phase 2
- Research: two independent deep-research passes (Claude agent + Publicity) converged on 3-touch / 24hr-3d-7d / email-primary / personalization-6x / insurance-operator-tone
