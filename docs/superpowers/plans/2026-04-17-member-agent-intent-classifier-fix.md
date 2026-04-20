# Member-Agent Intent Classifier Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `ghl-member-agent` so that "can I share / where do I share?" questions from members are classified as `support` (answered by the KB) instead of `escalate` (boilerplate flag-to-human reply).

**Architecture:** The intent classifier is a private async function `classifyMemberIntent()` in `index.ts` that calls Claude Haiku with a one-word routing prompt. The `support` category definition currently omits community/sharing questions, causing Haiku to fall through to `escalate`. Fix: (1) extract the category definitions into an exported constant so they're testable, (2) add "community questions, sharing work, group Telegram" to the `support` definition, (3) add a regression test verifying the fix.

**Tech Stack:** Deno, TypeScript, deno test, Supabase MCP deploy

---

## Files Modified

| File | Change |
|---|---|
| `supabase/functions/ghl-member-agent/index.ts` | Export `CLASSIFIER_CATEGORY_DEFS` const; update `support` definition; feed const into prompt |
| `supabase/functions/ghl-member-agent/index.test.ts` | Add 3 regression tests |

---

### Task 1: Write the failing regression tests

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.test.ts`

- [ ] **Step 1: Add the three new tests at the bottom of `index.test.ts`**

These tests will fail until Task 2 exports `CLASSIFIER_CATEGORY_DEFS` and updates the `support` definition.

```typescript
// ---------------------------------------------------------------------------
// Intent classifier regression tests — Sharon Layman incident (2026-04-17)
// ---------------------------------------------------------------------------

// Test 1: Sharon's exact message must NOT match escalation keywords
// (Pure function, no Claude call needed)
Deno.test('matchesEscalationKeyword: community-sharing question is not an escalation keyword match', () => {
  const sharonMessage = "Hi!! What thoughts are members of our community having about sharing with each other all that we're creating? I've got quite a bit started so a new hire can move forward quickly.";
  assertEquals(matchesEscalationKeyword(sharonMessage), false);
});

// Test 2: The classifier prompt's 'support' definition must cover community/sharing questions.
// Regression guard: if someone removes these anchors from the prompt, this test breaks loudly.
Deno.test('CLASSIFIER_CATEGORY_DEFS: support definition covers community/sharing questions', () => {
  // Import CLASSIFIER_CATEGORY_DEFS from index.ts (exported in Task 2)
  // This string is fed directly into the Haiku classifier prompt.
  const { CLASSIFIER_CATEGORY_DEFS } = await import('./index.ts');
  const supportLine = CLASSIFIER_CATEGORY_DEFS
    .split('\n')
    .find((line: string) => line.startsWith('support'));
  assert(supportLine !== undefined, 'Expected a "support = ..." line in CLASSIFIER_CATEGORY_DEFS');
  assert(
    supportLine.includes('community') || supportLine.includes('sharing') || supportLine.includes('Telegram'),
    `Expected "support" line to mention community/sharing/Telegram but got: ${supportLine}`,
  );
});

// Test 3: parseIntent falls back to 'support' (not 'escalate') for unrecognised responses
Deno.test('parseIntent: unrecognised model output defaults to support (not escalate)', () => {
  assertEquals(parseIntent('unknown_category'), 'support');
  assertEquals(parseIntent(''), 'support');
  assertEquals(parseIntent('  escalade  '), 'support'); // close but not exact
});
```

Also add `CLASSIFIER_CATEGORY_DEFS` to the import at the top of the file (will compile after Task 2):

```typescript
import { resolveChannel, memberSupportPrompt, matchesEscalationKeyword, parseIntent, CLASSIFIER_CATEGORY_DEFS } from './index.ts';
```

- [ ] **Step 2: Run tests — verify the new ones fail (Task 2 not done yet)**

```bash
cd "supabase/functions/ghl-member-agent" && deno test --allow-env index.test.ts 2>&1 | tail -30
```

Expected: 2 new tests fail (`CLASSIFIER_CATEGORY_DEFS` not exported yet). `matchesEscalationKeyword` test may pass immediately — that's fine.

---

### Task 2: Fix the classifier prompt + export the constant

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts` (lines ~577–599)

- [ ] **Step 1: Find the current category definitions block inside `classifyMemberIntent`**

Current code (lines ~579–591):
```typescript
  const user = `Classify this inbound message from an active member.

Member role: ${role}
Message: "${messageBody}"

onboarding = login, Google Workspace setup, mastery.aiaimastermind.com access, password reset, getting started
content = workshop replays (IMM/SCMM/ATOM), module navigation, portal, where to find recordings
event = event links, times, schedules, replay availability for a specific event
coaching = strategy or advice question (e.g., "should I run X ads?", "how do I price this?", "what offer should I build?")
support = logistical question, weekly call schedule, benefits overview, DFY Setup vs DFY Package distinction, identity/greeting
escalate = clearly upset beyond keyword matches, account-specific problem requiring human judgment, or looping without resolution

Reply with one word:`;
```

- [ ] **Step 2: Extract and update — replace the block above with this (in `index.ts`, just before `classifyMemberIntent`)**

Add the exported constant immediately before the function declaration (around line 576):

```typescript
// Exported for test coverage — do not change category names without updating parseIntent + VALID_INTENTS
export const CLASSIFIER_CATEGORY_DEFS = `onboarding = login, Google Workspace setup, mastery.aiaimastermind.com access, password reset, getting started
content = workshop replays (IMM/SCMM/ATOM), module navigation, portal, where to find recordings
event = event links, times, schedules, replay availability for a specific event
coaching = strategy or advice question (e.g., "should I run X ads?", "how do I price this?", "what offer should I build?")
support = logistical question, weekly call schedule, benefits overview, DFY Setup vs DFY Package distinction, identity/greeting, community questions (sharing work-in-progress, group Telegram norms, where to post for peer feedback, asking what other members think)
escalate = clearly upset beyond keyword matches, billing/cancellation/legal issue, account-specific problem requiring human judgment, or looping without resolution`;
```

- [ ] **Step 3: Update `classifyMemberIntent` to use the extracted constant**

Replace the inline category lines in the `user` template with a reference to `CLASSIFIER_CATEGORY_DEFS`:

```typescript
async function classifyMemberIntent(messageBody: string, role: AgencyRole): Promise<Intent> {
  const system = 'You are a message router for a member support inbox. Reply with exactly one word only: onboarding, content, event, coaching, support, or escalate. No punctuation, no explanation.';
  const user = `Classify this inbound message from an active member.

Member role: ${role}
Message: "${messageBody}"

${CLASSIFIER_CATEGORY_DEFS}

Reply with one word:`;

  try {
    const raw = await callClaude('claude-haiku-4-5-20251001', 10, system, user);
    return parseIntent(raw);
  } catch (err) {
    console.error('[classify] threw:', err);
    return 'support';
  }
}
```

- [ ] **Step 4: Run tests — all three new tests must pass now**

```bash
cd "supabase/functions/ghl-member-agent" && deno test --allow-env index.test.ts 2>&1 | tail -30
```

Expected: all tests green, including the 3 new ones.

- [ ] **Step 5: Typecheck**

```bash
cd "supabase/functions/ghl-member-agent" && deno check index.ts 2>&1
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/ghl-member-agent/index.ts supabase/functions/ghl-member-agent/index.test.ts
git commit -m "fix(ghl-member-agent): classify community/sharing questions as support not escalate

Extracts CLASSIFIER_CATEGORY_DEFS as an exported constant and adds
'community questions (sharing work-in-progress, group Telegram norms, where
to post for peer feedback)' to the support category definition.

Root cause: Sharon Layman's Apr 17 inbound — \"What thoughts are members
having about sharing?\" — was routed to escalate by Haiku because the
support category had no anchor for community/sharing questions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Deploy to production + smoke test

**Files:**
- No file changes — deploy already-committed code

- [ ] **Step 1: Deploy ghl-member-agent via Supabase MCP**

Use `deploy_edge_function` with:
- `name`: `ghl-member-agent`
- `verify_jwt`: `false`
- `files`: include `index.ts` + any `_shared/*.ts` files it imports

Check what shared files member-agent imports:
```bash
grep "from '../_shared/" supabase/functions/ghl-member-agent/index.ts
```

Include each shared file in the deploy with `name: "../_shared/<filename>"`.

- [ ] **Step 2: Verify deployed version incremented**

After deploy, confirm the version number went from 2 → 3 in the MCP response.

- [ ] **Step 3: Three smoke tests against the deployed function**

Get the function URL from: `https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-member-agent`

Test A — missing auth (bad location_id):
```bash
curl -s -X POST "https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-member-agent" \
  -H "Content-Type: application/json" \
  -d '{"location_id":"WRONG","contact_id":"test","message_body":"hello"}' | jq .
```
Expected: `{"error":"Forbidden: invalid location_id",...}` (403)

Test B — valid location, missing contact (short-circuits before Claude):
```bash
curl -s -X POST "https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-member-agent" \
  -H "Content-Type: application/json" \
  -d '{"location":{"id":"ARMyDGKPbnem0Brkxpko"},"contact_id":"NONEXISTENT_ID_TEST","message_body":"test"}' | jq .
```
Expected: some 4xx or `{ok: false}` response — function processes without crashing.

Test C — confirm deployed version via list_edge_functions shows version 3.

---

## Post-deploy: KB update (manual — Phil action required)

The classifier fix ensures correct routing. To make sure the KB-grounded reply is accurate when support intent fires, also add the following to the AI Phil Brain doc (gdoc `1fYqPpSxkqX5Yi1yvTVFTX98NZmb7FbdkQ9CsoDZ5n5Q`) under a **"Community & Sharing"** section:

> Members are encouraged to share works-in-progress, ideas, and questions with the community. The primary channel for peer feedback is the **group Telegram** — post there to get input from fellow members and Phil. The community thrives on sharing, so if you've built something or have a question about best practices, drop it in Telegram.

This syncs to `kb_documents` within ~30 minutes automatically.
