# Channel-Routing Fix + Behavioral Rule Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the email-inbound-→-SMS-outbound channel regression in both AI Phil agents AND encode two behavioral rules (no-agency-work, unknown-member-claim-flagging) in the canonical voice module + member agent prompts, in one bundled shipment.

**Architecture:** Three layered fixes in the same change:
1. **Channel fixes (A+B):** always consult conversation type when webhook omits message_type; fall back to contact-shape (email-only contact → email channel). Both `ghl-sales-agent` and `ghl-member-agent` have the identical bug.
2. **Member-claim gate (C, sales-agent only):** detect inbound from non-tagged contact that presumes membership, send polite boilerplate + flag to human, skip generation.
3. **Voice rules:** add `AGENCY_BOUNDARIES_BLOCK` to `_shared/salesVoice.ts` and mirror into `ghl-member-agent` system prompt. Rules: never promise account audits/management; never commit Phil's time outside weekly call + workshops.

**Tech Stack:** Deno edge functions (Supabase), TypeScript strict mode, `deno test` for unit tests, `mcp__af564948-397f-4b1c-a918-7415a9c419a0__deploy_edge_function` for deployment.

**File Structure:**

| File | Purpose | Change |
|---|---|---|
| `supabase/functions/_shared/salesVoice.ts` | Canonical voice block library | Add `AGENCY_BOUNDARIES_BLOCK`, wire into `buildSystemPrompt`, add `detectMemberClaim()` helper |
| `supabase/functions/_shared/salesVoice.test.ts` | Voice module tests | Add tests for new block + detector |
| `supabase/functions/ghl-sales-agent/index.ts` | Sales-agent handler | Channel Fix A + B + member-claim gate (C) + polite-boilerplate reply |
| `supabase/functions/ghl-sales-agent/index.test.ts` *(new)* | Sales-agent handler tests | Pure-function tests for channel resolution logic |
| `supabase/functions/ghl-member-agent/index.ts` | Member-agent handler | Channel Fix A + B; inject agency-boundaries into system prompt |
| `vault/60-content/ai-phil/AI-Phil-Voice-Philosophy.md` *(Drive, not repo)* | Canonical voice markdown | Add §new: Agency boundaries + Unknown-member claims (via google-docs-mcp) |
| AI Phil — Voice & Persona Guide *(gdoc `1iu3HA8Ad8e80bqHXGkixIkbQ1G75HwPZ8LEoummDQpo`)* | Human-readable voice doc | Mirror same rules |
| AI Phil Brain Master Doc *(gdoc `1fYqPpSxkqX5Yi1yvTVFTX98NZmb7FbdkQ9CsoDZ5n5Q`)* | Facts doc | Only if rules belong here (decide at task 9) |
| `CLAUDE.md` | Repo guardrails | Add "channel extraction must consult conversation type when message_type missing" row |
| `~/.claude/projects/<proj>/memory/project_ris_phase1_shipped.md` | Memory | Update with v12/v2 deploy state |

---

## Task 0: Pre-flight

**Files:** none (git + env checks only)

- [ ] **Step 0.1: Confirm clean working tree**

```bash
git -C "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Ai Phil" status --short
```
Expected: empty output (no uncommitted changes, no untracked non-ignored files).

If not clean: stop, surface to Phil, do not proceed.

- [ ] **Step 0.2: Confirm deployed versions match local commits**

```bash
# Read local salesVoice.ts head + deployed ghl-sales-agent via MCP get_edge_function
# Confirm current deployed ghl-sales-agent = v11, ghl-member-agent = v1
```
Use `mcp__af564948-397f-4b1c-a918-7415a9c419a0__list_edge_functions` — expect `ghl-sales-agent` v11 and `ghl-member-agent` v1.

If deployed > committed source: stop, run the "deployed-but-uncommitted" recovery per CLAUDE.md before touching anything.

- [ ] **Step 0.3: Cache the failing-case webhook evidence**

Skip — we are proceeding on code-evidence hypothesis (Phil approved in conversation). Record this decision in the commit message for auditability.

---

## Task 1: Add `AGENCY_BOUNDARIES_BLOCK` to salesVoice (TDD)

**Files:**
- Modify: `supabase/functions/_shared/salesVoice.ts`
- Modify: `supabase/functions/_shared/salesVoice.test.ts`

- [ ] **Step 1.1: Write failing test — block is exported and non-empty**

Add to `salesVoice.test.ts`:

```ts
import { AGENCY_BOUNDARIES_BLOCK } from './salesVoice.ts';

Deno.test('AGENCY_BOUNDARIES_BLOCK contains the no-agency rule', () => {
  assert(AGENCY_BOUNDARIES_BLOCK.includes('not an agency'));
  assert(AGENCY_BOUNDARIES_BLOCK.includes('never offer to audit'));
  assert(AGENCY_BOUNDARIES_BLOCK.includes("Phil's time"));
  assert(AGENCY_BOUNDARIES_BLOCK.includes('weekly call'));
});
```

- [ ] **Step 1.2: Run test, confirm failure**

```bash
cd "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Ai Phil"
deno test supabase/functions/_shared/salesVoice.test.ts --allow-read --no-check
```
Expected: fails at import (`AGENCY_BOUNDARIES_BLOCK` not exported).

- [ ] **Step 1.3: Add the block to salesVoice.ts**

Insert after `NEVER_LIE_BLOCK` (around line 330):

```ts
/** Agency boundaries — added 2026-04-17 after Sharon Godfrey Google Ads incident. */
export const AGENCY_BOUNDARIES_BLOCK = `# Agency boundaries

AiAi Mastermind is not an agency. You are a coach, educator, and referral point. You never execute work on behalf of members.

Never offer to:
- Audit, review, or manage a member's Google Ads, GHL, social, or other accounts
- "Pull your campaigns," "send you a breakdown," "fix your ads," or any equivalent done-for-you deliverable
- Commit Phil's personal time for 1:1 help outside the recurring weekly call or scheduled workshops

Instead, always do one or more of:
- Explain the concept, tool, or metric the member is asking about
- Point the member to the place they can self-serve (ad preview inside Google Ads, a training module, a workflow doc)
- Offer to bring the question to the next weekly call so Phil can answer it live for the whole group
- Recommend the member ask AI (Ai Phil, ChatGPT, Claude) for implementation help on the specific thing

Boundary phrasings to use when declining agency work:
- "Neither of these is a call we can make for you — we don't audit or manage member accounts."
- "That's a great one to bring to the next weekly call."
- "Phil can walk through that framework live with the whole group."`;
```

- [ ] **Step 1.4: Run test, confirm passes**

```bash
deno test supabase/functions/_shared/salesVoice.test.ts --allow-read --no-check
```
Expected: the new test passes; existing tests still pass.

- [ ] **Step 1.5: Wire block into buildSystemPrompt**

Modify `buildSystemPrompt` (around line 442):

```ts
  const blocks: string[] = [
    IDENTITY_BLOCK,
    VOICE_BLOCK,
    FORM_FRAMEWORK_BLOCK,
    PROOF_SHAPE_BLOCK,
    NEVER_LIE_BLOCK,
    AGENCY_BOUNDARIES_BLOCK, // ← new, included in every context
  ];
```

- [ ] **Step 1.6: Write test — block appears in buildSystemPrompt output for every context**

Add to `salesVoice.test.ts`:

```ts
import { VOICE_CONTEXTS, buildSystemPrompt } from './salesVoice.ts';

Deno.test('buildSystemPrompt includes AGENCY_BOUNDARIES_BLOCK for every context', () => {
  for (const ctx of VOICE_CONTEXTS) {
    const prompt = buildSystemPrompt(ctx, { family: [], occupation: [], recreation: [], money: [] }, '');
    assert(prompt.includes('Agency boundaries'), `missing for context ${ctx}`);
    assert(prompt.includes("we don't audit or manage"), `missing phrase for context ${ctx}`);
  }
});
```

- [ ] **Step 1.7: Run full suite, commit**

```bash
deno test supabase/functions/_shared/salesVoice.test.ts --allow-read --no-check
git add supabase/functions/_shared/salesVoice.ts supabase/functions/_shared/salesVoice.test.ts
git commit -m "$(cat <<'EOF'
feat(_shared/salesVoice): AGENCY_BOUNDARIES_BLOCK — no-agency + no-Phil-time rule

Added after 2026-04-17 Sharon Godfrey Google Ads incident. Encodes the rule
that Ai Phil is a coach/educator, not an agency: never audit, manage, or fix
member accounts; never commit Phil's time outside weekly call + workshops.
Included in every VoiceContext output.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `detectMemberClaim` helper to salesVoice (TDD)

**Files:**
- Modify: `supabase/functions/_shared/salesVoice.ts`
- Modify: `supabase/functions/_shared/salesVoice.test.ts`

- [ ] **Step 2.1: Write failing tests**

Add to `salesVoice.test.ts`:

```ts
import { detectMemberClaim } from './salesVoice.ts';

Deno.test('detectMemberClaim flags insider language', () => {
  // Positive cases — sender speaks as a member
  assert(detectMemberClaim('I have questions about my Google Ads campaign through the program'));
  assert(detectMemberClaim('Hey Phil, I saw your last workshop and wanted to follow up'));
  assert(detectMemberClaim('Can I get access to the member portal again?'));
  assert(detectMemberClaim('I paused my ads and wanted your advice'));
  assert(detectMemberClaim('As part of the mastermind, what should I do about this?'));
});

Deno.test('detectMemberClaim ignores new-prospect language', () => {
  // Negative cases — clear prospect inquiries
  assert(!detectMemberClaim('Saw your ad, can you tell me about the mastermind?'));
  assert(!detectMemberClaim('What is the price of your program?'));
  assert(!detectMemberClaim('I want to learn more about what you do'));
  assert(!detectMemberClaim('hello test'));
});
```

- [ ] **Step 2.2: Run test, confirm failure (import error)**

```bash
deno test supabase/functions/_shared/salesVoice.test.ts --allow-read --no-check
```

- [ ] **Step 2.3: Implement detectMemberClaim**

Add to `salesVoice.ts` (after `containsBannedWord`, around line 185):

```ts
// ---------------------------------------------------------------------------
// detectMemberClaim — lenient heuristic for "sender talks like a member"
// ---------------------------------------------------------------------------
//
// Used by ghl-sales-agent to gate non-tagged inbounds that sound like they
// come from a member (different email address, unmerged contact, etc.).
// False-flag to human is cheap; false-auto-validate (telling a prospect they
// "have access to the member portal") is expensive. Bar is deliberately low.

const MEMBER_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bmy\s+(?:google\s+ads?|campaigns?|ads?|account|team|book|agency)\b/i,
  /\bmember\s+(?:portal|resources?|area|login|dashboard)\b/i,
  /\bthe\s+(?:program|mastermind|workshop|weekly\s+call|cohort)\b/i,
  /\bmy\s+(?:membership|subscription|login|access)\b/i,
  /\bas\s+(?:a\s+)?member\b/i,
  /\bi\s+(?:joined|signed\s+up|enrolled|paid)\b/i,
  /\b(?:last|previous|recent)\s+(?:workshop|call|session|training)\b/i,
  /\bhey\s+(?:phil|phillip)\b/i,
];

export function detectMemberClaim(text: string): boolean {
  if (!text || text.trim().length < 4) return false;
  for (const re of MEMBER_CLAIM_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}
```

- [ ] **Step 2.4: Run tests, iterate until all pass**

```bash
deno test supabase/functions/_shared/salesVoice.test.ts --allow-read --no-check
```

Expected: all tests pass. If any negative case false-positives, tighten the regex (but bias conservative — prefer over-flagging over under-flagging per Phil's rule).

- [ ] **Step 2.5: Commit**

```bash
git add supabase/functions/_shared/salesVoice.ts supabase/functions/_shared/salesVoice.test.ts
git commit -m "$(cat <<'EOF'
feat(_shared/salesVoice): detectMemberClaim heuristic

Lenient pattern-match for inbound text that sounds like the sender presumes
membership (references my ads, member portal, the program, etc.). Used by
ghl-sales-agent to gate non-tagged inbounds and flag to human rather than
sales-pitch a likely member writing from an unmerged address.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Channel Fix A+B in ghl-sales-agent (TDD)

**Files:**
- Create: `supabase/functions/ghl-sales-agent/index.test.ts`
- Modify: `supabase/functions/ghl-sales-agent/index.ts`

**Approach:** extract the channel-resolution logic into a pure helper so it's testable. Current inline logic at `index.ts:477-508`.

- [ ] **Step 3.1: Write failing tests for pure helper `resolveChannel`**

Create `supabase/functions/ghl-sales-agent/index.test.ts`:

```ts
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveChannel } from './index.ts';

Deno.test('resolveChannel: webhook rawMessageType wins', () => {
  const out = resolveChannel({
    rawMessageType: 'Email',
    conversationLookupChannel: 'sms',
    contact: { email: 'a@b.com', phone: '+1234' },
  });
  assertEquals(out.channel, 'email');
  assertEquals(out.source, 'webhook');
});

Deno.test('resolveChannel: null rawMessageType → use conversation lookup', () => {
  const out = resolveChannel({
    rawMessageType: null,
    conversationLookupChannel: 'email',
    contact: { email: 'a@b.com', phone: '+1234' },
  });
  assertEquals(out.channel, 'email');
  assertEquals(out.source, 'conversation-lookup');
});

Deno.test('resolveChannel: null rawMessageType + null lookup + email-only contact → email (Fix B)', () => {
  const out = resolveChannel({
    rawMessageType: null,
    conversationLookupChannel: null,
    contact: { email: 'a@b.com', phone: '' },
  });
  assertEquals(out.channel, 'email');
  assertEquals(out.source, 'contact-shape');
});

Deno.test('resolveChannel: null rawMessageType + null lookup + phone-only contact → sms', () => {
  const out = resolveChannel({
    rawMessageType: null,
    conversationLookupChannel: null,
    contact: { email: '', phone: '+1234' },
  });
  assertEquals(out.channel, 'sms');
  assertEquals(out.source, 'default');
});

Deno.test('resolveChannel: lookup=phone is ignored (no auto-reply on phone)', () => {
  const out = resolveChannel({
    rawMessageType: null,
    conversationLookupChannel: 'phone',
    contact: { email: 'a@b.com', phone: '+1234' },
  });
  // Phone never sends an auto-reply, so we fall back to contact-shape or sms
  assertEquals(out.channel, 'email'); // email-and-phone → prefer email over sms
  assertEquals(out.source, 'contact-shape');
});
```

- [ ] **Step 3.2: Run, confirm failure**

```bash
deno test supabase/functions/ghl-sales-agent/index.test.ts --allow-read --allow-net --no-check
```
Expected: fail, `resolveChannel` not exported.

- [ ] **Step 3.3: Extract + implement `resolveChannel`**

In `supabase/functions/ghl-sales-agent/index.ts`, add after `normalizeChannel` (around line 94):

```ts
export interface ResolveChannelInput {
  rawMessageType: string | null;
  conversationLookupChannel: Channel | null;
  contact: { email?: string; phone?: string };
}
export interface ResolveChannelOutput {
  channel: Channel;
  source: 'webhook' | 'conversation-lookup' | 'contact-shape' | 'default';
}

export function resolveChannel(input: ResolveChannelInput): ResolveChannelOutput {
  // 1. Webhook message_type wins when present
  if (input.rawMessageType) {
    return { channel: normalizeChannel(input.rawMessageType), source: 'webhook' };
  }
  // 2. Conversation lookup when webhook is silent (Fix A)
  if (input.conversationLookupChannel && input.conversationLookupChannel !== 'phone') {
    return { channel: input.conversationLookupChannel, source: 'conversation-lookup' };
  }
  // 3. Contact-shape fallback: email-present + phone-absent (or lookup was phone) → email (Fix B)
  const hasEmail = !!(input.contact.email && input.contact.email.trim());
  const hasPhone = !!(input.contact.phone && input.contact.phone.trim());
  if (hasEmail && !hasPhone) {
    return { channel: 'email', source: 'contact-shape' };
  }
  // 3b. If lookup was phone (no auto-reply possible) and contact has email, prefer email
  if (input.conversationLookupChannel === 'phone' && hasEmail) {
    return { channel: 'email', source: 'contact-shape' };
  }
  // 4. Default: sms
  return { channel: 'sms', source: 'default' };
}
```

- [ ] **Step 3.4: Run tests, confirm pass**

```bash
deno test supabase/functions/ghl-sales-agent/index.test.ts --allow-read --allow-net --no-check
```

- [ ] **Step 3.5: Wire `resolveChannel` into handler**

In `index.ts`, replace lines 477-508 (the inline channel logic block) with:

```ts
  // Step 2: Extract message fields
  const contactId = extractContactId(body);
  let conversationId = extractConversationId(body);
  const messageBody = extractMessageBody(body);
  const rawMessageType = extractMessageType(body);
  const messageType = rawMessageType ?? 'SMS'; // for logging only

  if (!contactId || !messageBody) {
    console.error('[extract] missing required fields', { contactId, conversationId, hasMessage: !!messageBody });
    return new Response(
      JSON.stringify({ error: 'Missing required fields', contactId, conversationId, hasMessage: !!messageBody }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Always consult the conversation when message_type is absent — covers the
  // case where webhook includes conversationId but no type (email inbounds
  // routed through certain GHL workflows). Previously we only looked up when
  // conversationId was also missing, which left channel defaulted to 'sms'.
  let conversationLookupChannel: Channel | null = null;
  if (!rawMessageType || !conversationId) {
    const lookup = await lookupConversation(contactId);
    if (lookup) {
      if (!conversationId) conversationId = lookup.id;
      conversationLookupChannel = lookup.suggestedChannel;
    }
  }

  if (!conversationId) {
    console.error('[extract] could not resolve conversationId for contact', contactId);
    return new Response(
      JSON.stringify({ error: 'Could not resolve conversationId', contactId }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
```

Then after the contact is fetched (around line 517), compute the channel:

```ts
    const contact = contactResult.status === 'fulfilled' ? contactResult.value : null;
    const tags = contact?.tags ?? [];

    const channelResolution = resolveChannel({
      rawMessageType,
      conversationLookupChannel,
      contact: { email: contact?.email, phone: contact?.phone },
    });
    const channel: Channel = channelResolution.channel;
    console.log(`[channel] resolved=${channel} source=${channelResolution.source} rawType=${rawMessageType} lookupSuggest=${conversationLookupChannel}`);
```

All subsequent uses of `channel` (line 531, 591, 628, 636, etc.) remain unchanged — `channel` is still a `Channel`.

**Important:** also remove the now-dead `let channel = ...` at the top of the handler — single declaration now lives after contact fetch.

- [ ] **Step 3.6: Run tests again (handler compile check)**

```bash
deno test supabase/functions/ghl-sales-agent/index.test.ts --allow-read --allow-net --no-check
deno check supabase/functions/ghl-sales-agent/index.ts
```

Both must pass.

- [ ] **Step 3.7: Commit**

```bash
git add supabase/functions/ghl-sales-agent/
git commit -m "$(cat <<'EOF'
fix(ghl-sales-agent): channel routing A+B — always consult conversation when message_type missing

Two gaps closed:

A. Previously, conversation lookup only ran when conversationId was also
   missing from the webhook. Email workflows that include conversationId
   but omit message_type fell through to the 'sms' default and replied via
   SMS to an email inbound. Now we always look up the conversation when
   rawMessageType is null, regardless of conversationId presence.

B. Contact-shape fallback: if both webhook and conversation lookup are
   silent but the contact has email and no phone, flip to email. Covers
   Sharon Godfrey case — new contact from a secondary email address, no
   phone on file.

Extracted the channel-resolution into a pure `resolveChannel(...)` helper
(exported, testable). Added Deno unit tests covering the four source
branches (webhook / conversation-lookup / contact-shape / default).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Member-claim gate (Fix C) in ghl-sales-agent

**Files:**
- Modify: `supabase/functions/ghl-sales-agent/index.ts`

**Approach:** after contact is fetched and confirmed NOT a member (i.e. we're past the line-520 member-tag branch), detect member-sounding language → send polite boilerplate + flag.

- [ ] **Step 4.1: Add canned-response constant**

Near top of `index.ts` (around line 14):

```ts
const UNKNOWN_MEMBER_REPLY = `Hi there,

It sounds like you may be asking as a member of AiAi Mastermind, but I don't see this email in our member records. I've flagged this for a human teammate to review — they'll verify and get back to you.

If you meant to write from a different email, please reply from the address you're registered with and we'll route you right away.`;
```

- [ ] **Step 4.2: Wire the gate after member-tag check, before intent classification**

In the handler, after line 542 (`const safeContact: GhlContact = contact ?? ...`) and before line 575 (`const intent: Intent = ...`):

```ts
    // Member-claim gate: non-tagged contact writing like a member → polite
    // boilerplate + flag to human, don't auto-validate. Added 2026-04-17 after
    // Sharon Godfrey unmerged-contact incident.
    if (detectMemberClaim(messageBody)) {
      console.log(`[member-claim] non-tagged contact ${contactId} wrote member-sounding message, gating`);

      const sendOk = await sendGhlReply(contactId, UNKNOWN_MEMBER_REPLY, channel);

      await writeAgentSignal({
        source_agent: 'ghl-sales-agent',
        target_agent: 'richie-cc2',
        signal_type: 'unknown-member-claim',
        status: sendOk ? 'delivered' : 'failed',
        channel: 'open',
        priority: 2,
        payload: {
          contact_id: contactId,
          conversation_id: conversationId,
          channel,
          message_preview: messageBody.substring(0, 300),
          contact_email: safeContact.email,
          contact_phone: safeContact.phone,
        },
      });

      await postGoogleChatAlert(`AI Phil unknown-member claim
Contact: ${firstName} ${lastName} (${safeContact.email || 'no email'} / ${safeContact.phone || 'no phone'})
Channel: ${channel}
Message: ${messageBody.substring(0, 500)}
Conversation: ${conversationId}

Auto-reply: "${UNKNOWN_MEMBER_REPLY.substring(0, 100)}..."`);

      try {
        await supabase.schema('ops').from('open_tickets').insert({
          sync_source: 'ghl-sales-agent',
          channel: `ghl-${channel}`,
          contact_name: `${firstName} ${lastName}`.trim() || null,
          contact_phone: safeContact.phone || null,
          raw_message_snippet: messageBody.substring(0, 500),
          category: 'unknown-member-claim',
          conversation_id: conversationId,
          status: 'Open',
        });
      } catch (err) {
        console.error('[open_tickets] unknown-member-claim insert threw:', err);
      }

      return new Response(
        JSON.stringify({ ok: true, gated: 'unknown-member-claim', sent: sendOk }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
```

Also add the import at top of file:

```ts
import { buildSystemPrompt, containsBannedWord, detectMemberClaim, type VoiceContext } from '../_shared/salesVoice.ts';
```

- [ ] **Step 4.3: Typecheck**

```bash
deno check supabase/functions/ghl-sales-agent/index.ts
```

- [ ] **Step 4.4: Commit**

```bash
git add supabase/functions/ghl-sales-agent/index.ts
git commit -m "$(cat <<'EOF'
feat(ghl-sales-agent): member-claim gate — polite boilerplate + flag to human

Non-tagged contact writing like a member (references my ads, member portal,
the program, etc.) now gets a polite 'I don't recognize this email, flagging
to human' reply instead of a sales pitch. Plus agent_signals row + Google
Chat alert + open_tickets entry so a human can verify identity.

Closes the Sharon Godfrey-class failure: existing member emails from an
unmerged secondary address, system no longer sales-pitches her.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Channel Fix A+B in ghl-member-agent

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts`

**Approach:** the member-agent has the identical bug at lines 683-707. Apply the same `resolveChannel` pattern. The member-claim gate does NOT apply here (member-agent runs only for confirmed members).

- [ ] **Step 5.1: Read current member-agent channel logic**

```bash
# Already read in planning — lines 683-707 mirror sales-agent 477-508.
```

- [ ] **Step 5.2: Reuse resolveChannel via import or inline a copy?**

**Decision: inline a copy in member-agent.** Reason: `_shared/` imports for TS types are fine, but keeping the handler self-contained simplifies deploy + matches the existing member-agent style (it already duplicates `normalizeChannel`, `extractMessageType`, etc., from sales-agent by design — member-agent was written to be independent so a bug in one doesn't cascade).

Add the same `resolveChannel` helper to `ghl-member-agent/index.ts` after `normalizeChannel` (around line 100):

```ts
export interface ResolveChannelInput {
  rawMessageType: string | null;
  conversationLookupChannel: Channel | null;
  contact: { email?: string; phone?: string };
}
export interface ResolveChannelOutput {
  channel: Channel;
  source: 'webhook' | 'conversation-lookup' | 'contact-shape' | 'default';
}

export function resolveChannel(input: ResolveChannelInput): ResolveChannelOutput {
  if (input.rawMessageType) {
    return { channel: normalizeChannel(input.rawMessageType), source: 'webhook' };
  }
  if (input.conversationLookupChannel && input.conversationLookupChannel !== 'phone') {
    return { channel: input.conversationLookupChannel, source: 'conversation-lookup' };
  }
  const hasEmail = !!(input.contact.email && input.contact.email.trim());
  const hasPhone = !!(input.contact.phone && input.contact.phone.trim());
  if (hasEmail && !hasPhone) {
    return { channel: 'email', source: 'contact-shape' };
  }
  if (input.conversationLookupChannel === 'phone' && hasEmail) {
    return { channel: 'email', source: 'contact-shape' };
  }
  return { channel: 'sms', source: 'default' };
}
```

- [ ] **Step 5.3: Write failing test for member-agent resolveChannel**

Create `supabase/functions/ghl-member-agent/index.test.ts` (or append if exists). Mirror the 5 tests from Task 3.1 but importing from member-agent `./index.ts`.

- [ ] **Step 5.4: Run test, confirm pass (helper already added in 5.2)**

```bash
deno test supabase/functions/ghl-member-agent/index.test.ts --allow-read --allow-net --no-check
```

- [ ] **Step 5.5: Wire into handler (lines 683-707)**

Replace the current channel-extraction block with the same pattern as Task 3.5 — pull lookup up front when rawMessageType is null, then call `resolveChannel` after contact is fetched.

- [ ] **Step 5.6: Typecheck + test**

```bash
deno check supabase/functions/ghl-member-agent/index.ts
deno test supabase/functions/ghl-member-agent/ --allow-read --allow-net --no-check
```

- [ ] **Step 5.7: Commit**

```bash
git add supabase/functions/ghl-member-agent/
git commit -m "$(cat <<'EOF'
fix(ghl-member-agent): channel routing A+B — mirror sales-agent fix

Same bug as ghl-sales-agent: channel defaulted to 'sms' when webhook included
conversationId but not message_type, causing email inbounds to route back as
SMS. Added resolveChannel helper (A: always consult conversation when type
missing; B: email-only contact → email channel) with Deno unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Inject agency-boundaries into ghl-member-agent system prompt

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts`

- [ ] **Step 6.1: Locate member-agent system prompt builder**

```bash
# Expected: a function like buildMemberPrompt or similar, constructing the
# system string. It currently does NOT reference _shared/salesVoice.
```

- [ ] **Step 6.2: Decide scope of change**

**Decision:** import `AGENCY_BOUNDARIES_BLOCK` from `_shared/salesVoice.ts` and append it to every member-agent system prompt. The member-agent voice prompts are separate from salesVoice, but this one rule applies universally.

Add import:

```ts
import { AGENCY_BOUNDARIES_BLOCK } from '../_shared/salesVoice.ts';
```

Append the block to each system prompt builder (or the single shared one) in the member-agent. Exact line depends on code read — agent prompts builder to append `\n\n---\n\n${AGENCY_BOUNDARIES_BLOCK}`.

- [ ] **Step 6.3: Typecheck + commit**

```bash
deno check supabase/functions/ghl-member-agent/index.ts
git add supabase/functions/ghl-member-agent/index.ts
git commit -m "$(cat <<'EOF'
feat(ghl-member-agent): inject AGENCY_BOUNDARIES_BLOCK into system prompts

Mirrors the rule added to salesVoice.ts in the same shipment: AiAi Mastermind
is a coaching program, not an agency. Agents must not promise audits,
account management, or Phil's personal time outside weekly call + workshops.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Deploy both edge functions

**Files:** none (deploy via Supabase MCP)

- [ ] **Step 7.1: Deploy ghl-sales-agent v12**

Use `mcp__af564948-397f-4b1c-a918-7415a9c419a0__deploy_edge_function` with the files:
- `source/index.ts` ← local `supabase/functions/ghl-sales-agent/index.ts`
- `../_shared/salesVoice.ts` ← local `supabase/functions/_shared/salesVoice.ts`
- `../_shared/rapport.ts` ← local `supabase/functions/_shared/rapport.ts`
- `../_shared/kbCache.ts` ← local `supabase/functions/_shared/kbCache.ts`

- [ ] **Step 7.2: Deploy ghl-member-agent v2**

Same tool, with:
- `source/index.ts` ← local `ghl-member-agent/index.ts`
- `../_shared/salesVoice.ts` ← so the `AGENCY_BOUNDARIES_BLOCK` import resolves

- [ ] **Step 7.3: Verify deployed matches committed (CLAUDE.md rule)**

For each function, call `get_edge_function` and diff against local committed source. Both must match.

- [ ] **Step 7.4: Smoke test ghl-sales-agent — 3 HTTP tests**

Per CLAUDE.md "at least 3 HTTP smoke tests" rule. Against the deployed URL:
1. Wrong location → 403
2. Missing contactId/message → 400
3. Valid email-type webhook → 200, reply goes via email channel (verify in agent_signals)

- [ ] **Step 7.5: Commit deploy notes**

Record the new versions in the next session's memory file and in the commit message of the next task.

---

## Task 8: Security advisor + secrets scan

- [ ] **Step 8.1: Run security advisors**

```bash
# MCP call: get_advisors('security') — mandatory per CLAUDE.md after any deploy
```

- [ ] **Step 8.2: Grep for accidental secrets**

```bash
cd "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Ai Phil"
# Via Grep tool
```
Patterns: `eyJ`, `sk_live`, `sk_test`, `Bearer ` hardcoded. Should be zero matches in committed files touched this session.

- [ ] **Step 8.3: Fix every ERROR, note every WARN in session summary**

---

## Task 9: Mirror rules to vault + gdocs

**Files (Drive / gdoc, not repo):**
- `vault/60-content/ai-phil/AI-Phil-Voice-Philosophy.md` (canonical markdown — Drive path)
- AI Phil Voice & Persona Guide (gdoc `1iu3HA8Ad8e80bqHXGkixIkbQ1G75HwPZ8LEoummDQpo`)

- [ ] **Step 9.1: Locate AI-Phil-Voice-Philosophy.md in Drive**

```bash
# Use mcp__e7a5a7e2-beaf-4d1f-8f50-e0627b3b83a3__search_files:
#   query: title contains 'AI-Phil-Voice-Philosophy' or title contains 'Voice Philosophy'
```

If found: read and append a new section for Agency boundaries + Unknown-member claims. If not found: note in session summary that the canonical doc wasn't located and the repo salesVoice.ts is now the de-facto source.

- [ ] **Step 9.2: Update the Voice & Persona Guide gdoc**

Use `google-docs-mcp.appendMarkdown` or `applyParagraphStyle` to add a clearly-labeled section at the end:

```markdown
## 2026-04-17 addition — Agency boundaries + Unknown-member claims

[Paste full contents of AGENCY_BOUNDARIES_BLOCK + UNKNOWN-MEMBER rule]
```

- [ ] **Step 9.3: No Brain-doc edit**

Decision: the Brain doc holds **facts** (pricing, offerings, events). These two are **voice/behavior rules** — they belong in the Voice & Persona Guide only.

---

## Task 10: Update CLAUDE.md guardrail table + memory

**Files:**
- Modify: `CLAUDE.md`
- Modify: `~/.claude/projects/<proj>/memory/project_ris_phase1_shipped.md`

- [ ] **Step 10.1: Add guardrail row to CLAUDE.md**

Append to the "Mistakes-we've-already-made guardrails" table:

```
| Email inbound replied via SMS (Apr 17) — webhook omitted message_type but included conversationId, so channel defaulted to 'sms' and emailers got text replies | Channel extraction must consult the conversation's lastMessageType whenever rawMessageType is null, not only when conversationId is also missing. Also fall back to contact shape (email-only contact → email). Fixed in ghl-sales-agent v12 / ghl-member-agent v2 via shared `resolveChannel()` helper. |
| Unmerged duplicate contact silently mis-routed as prospect (Apr 17, Sharon Godfrey) | When a non-tagged contact writes in member-sounding language, reply with polite "don't recognize this email, flagging to human" boilerplate + alert, never sales-pitch. `detectMemberClaim()` in `_shared/salesVoice.ts`; gate in `ghl-sales-agent` before intent classification. |
```

- [ ] **Step 10.2: Update RIS Phase 1 memory file**

Bump versions shipped, note channel fix + rule additions, cite the new helper names.

- [ ] **Step 10.3: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE): add channel-routing + member-claim guardrails (Apr 17 session)"
```

---

## Task 11: Session close-out

Follow CLAUDE.md Session Close-out Protocol end-to-end:

- [ ] git status clean
- [ ] deployed-but-uncommitted check passes
- [ ] tests green
- [ ] `get_advisors('security')` run + errors cleared
- [ ] vault doc `_ROADMAP.md` updated
- [ ] `vault/50-meetings/2026-04-17-channel-fix-and-no-agency-rules.md` with Pick-up-here block
- [ ] memory updated
- [ ] next-session starter prompt written
- [ ] push decision logged

---

## Acceptance criteria

- Sending an email webhook to `ghl-sales-agent` with `conversationId` but no `message_type` produces an email reply (not SMS). Verified via smoke test.
- Sending an inbound from a non-member-tagged contact whose message contains "my Google Ads campaign" triggers the polite unknown-member-claim reply + Google Chat alert; does NOT run intent classifier or salesVoice generation.
- `buildSystemPrompt` output for every VoiceContext includes the phrase "we don't audit or manage."
- Both edge functions deployed and in-sync with committed source.
- CLAUDE.md has two new guardrail rows.
- Memory file reflects v12/v2 shipped state.
