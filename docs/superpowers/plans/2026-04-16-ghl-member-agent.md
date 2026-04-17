# ghl-member-agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a Supabase edge function `ghl-member-agent` that handles inbound SMS + Email from active AiAi Mastermind members, with KB-grounded responses, agency-role gating, and a keyword-triggered human-escalation flow.

**Architecture:** New Deno edge function at `supabase/functions/ghl-member-agent/index.ts`, modeled directly on `ghl-sales-agent` (which ships v9 in production). Shares the `ops.ai_inbox_conversation_memory` table with the sales agent and the future Ai Phil Voice agent. Two new GHL workflows (`🔥MBR E1` SMS + `🔥MBR E2` Email) with a tag filter of `HAS ⭕️aiai-member-active✅` route to the new webhook. All new logic (escalation keyword scan, agency-role gating, 6-category intent classifier) is encapsulated in pure functions that are unit-tested with Deno's built-in test runner.

**Tech Stack:** Deno (Supabase edge runtime), TypeScript strict mode, Anthropic Claude API (Haiku throughout), GHL REST API v2021-07-28, Supabase Postgres (`ops` + `public` schemas), Google Docs public export, Google Chat incoming webhook.

**Design spec:** `docs/superpowers/specs/2026-04-16-ghl-member-agent-design.md`

---

## File Structure

| Path | Purpose |
|---|---|
| `supabase/functions/ghl-member-agent/index.ts` | New edge function — single file, mirrors `ghl-sales-agent/index.ts` structure |
| `supabase/functions/ghl-member-agent/_test.ts` | Deno tests for pure functions (keyword scan, role gating, classifier validator) |
| `supabase/functions/ghl-member-agent/deno.json` | Minimal deno config for test runs |
| `vault/80-processes/2026-04-16-GHL-Member-Agent-Workflow-Guide.md` | Markdown mirror of the Google Doc the team follows to build workflows |
| `vault/60-content/ai-phil/_ROADMAP.md` | Update: add shipped row + known-issue cleanup |
| `vault/50-meetings/2026-04-16-ghl-member-agent-shipped.md` | Session summary (created at end of plan) |

Each file has a single focused responsibility:
- `index.ts` = HTTP handler + flow orchestration (all network I/O)
- `_test.ts` = pure function tests, no network
- `deno.json` = test runner config
- Workflow guide = team handoff artifact

---

## Task 1: Scaffold function directory with constants and Supabase client

**Files:**
- Create: `supabase/functions/ghl-member-agent/index.ts`
- Create: `supabase/functions/ghl-member-agent/deno.json`

- [ ] **Step 1: Create `deno.json` for the test runner**

Create `supabase/functions/ghl-member-agent/deno.json`:

```json
{
  "tasks": {
    "test": "deno test --allow-env --allow-net _test.ts"
  },
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.0"
  }
}
```

- [ ] **Step 2: Create `index.ts` with imports, constants, Supabase client, types**

Create `supabase/functions/ghl-member-agent/index.ts`:

```typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Constants (non-secret — safe to hardcode)
// ---------------------------------------------------------------------------
const GHL_LOCATION_ID = 'ARMyDGKPbnem0Brkxpko';
const MEMBER_SUPPORT_DOC_ID = '1h-qNxCg-UxNxg9nB4sW6ZPJkRnd-b3DFFFCVLTwLjFc';
const PRODUCTS_PRICING_DOC_ID = '1pxqva2WAmeUKJ5nvWSdyiw33iMQrTV4DebXzBhyjXSE';
const EVENTS_DOC_ID = '1Me-1NIW76SjjkV6WCVLOfXkuw_O36BCUE3sGdDkjBF8';
const MEMBER_TAG_SUBSTR = 'aiai-member-active'; // substring match (emoji wrapper varies)
const ESCALATION_TAG = '👷needs-human-support';
const AGENCY_ROLE_FIELD_NAME = '⭕️Agency Role';
const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

// GHL numeric -> string message types (from ghl-sales-agent)
const GHL_MESSAGE_TYPES: Record<number, string> = {
  1: 'Email', 2: 'SMS', 3: 'WhatsApp', 4: 'GMB', 5: 'IG', 6: 'FB', 7: 'Custom',
  8: 'WebChat', 9: 'Live_Chat', 10: 'Bot', 11: 'Calls'
};

// ---------------------------------------------------------------------------
// Supabase client (service role — bypasses RLS)
// ---------------------------------------------------------------------------
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Intent =
  | 'onboarding'
  | 'content'
  | 'event'
  | 'coaching'
  | 'support'
  | 'escalate';

export type Channel = 'sms' | 'email' | 'phone';

export type AgencyRole = 'owner' | 'manager' | 'team_member' | 'unknown';

export interface GhlContact {
  id: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  tags?: string[];
  customFields?: Array<{ id?: string; key?: string; name?: string; value?: unknown }>;
}

export interface GhlMessage {
  direction?: 'inbound' | 'outbound';
  body?: string;
}

interface AgentSignalPayload {
  source_agent: string;
  target_agent: string;
  signal_type: string;
  status?: string;
  channel?: string;
  priority?: number;
  payload?: Record<string, unknown>;
}

// Stub handler — replaced in Task 10
Deno.serve(async (_req: Request) => {
  return new Response('ghl-member-agent scaffold', { status: 200 });
});
```

- [ ] **Step 3: Typecheck the scaffold**

Run: `deno check "supabase/functions/ghl-member-agent/index.ts"`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/ghl-member-agent/
git commit -m "feat(member-agent): scaffold edge function with constants and types"
```

---

## Task 2: Webhook body extractors (copy from sales agent)

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts`

- [ ] **Step 1: Append extractor functions to `index.ts`**

Insert BEFORE the `Deno.serve` stub in `index.ts`:

```typescript
// ---------------------------------------------------------------------------
// Webhook body extractors (verbatim from ghl-sales-agent)
// ---------------------------------------------------------------------------
export function extractMessageBody(body: Record<string, unknown>): string | null {
  if (body.message && typeof body.message === 'object' && (body.message as Record<string, unknown>).body) {
    return String((body.message as Record<string, unknown>).body);
  }
  if (body.message_body && typeof body.message_body === 'string') return body.message_body;
  if (body.message && typeof body.message === 'string') return body.message;
  if (body.last_message && typeof body.last_message === 'string') return body.last_message;
  return null;
}

export function extractMessageType(body: Record<string, unknown>): string | null {
  if (body.message && typeof body.message === 'object' && (body.message as Record<string, unknown>).type) {
    const t = (body.message as Record<string, unknown>).type as number;
    return GHL_MESSAGE_TYPES[t] || String(t);
  }
  if (body.message_type && typeof body.message_type === 'string') return body.message_type;
  if (body.type && typeof body.type === 'string') return body.type;
  return null;
}

export function normalizeChannel(messageType: string): Channel {
  const t = messageType.toLowerCase();
  if (t === 'email') return 'email';
  if (t === 'calls' || t === 'phone') return 'phone';
  return 'sms';
}

export function extractContactId(body: Record<string, unknown>): string | null {
  if (body.contact_id && typeof body.contact_id === 'string') return body.contact_id;
  if (body.contactId && typeof body.contactId === 'string') return body.contactId;
  if (body.contact && typeof body.contact === 'object' && (body.contact as Record<string, unknown>).id) {
    return String((body.contact as Record<string, unknown>).id);
  }
  return null;
}

export function extractConversationId(body: Record<string, unknown>): string | null {
  if (body.conversation_id && typeof body.conversation_id === 'string') return body.conversation_id;
  if (body.conversationId && typeof body.conversationId === 'string') return body.conversationId;
  if (body.conversation && typeof body.conversation === 'object' && (body.conversation as Record<string, unknown>).id) {
    return String((body.conversation as Record<string, unknown>).id);
  }
  return null;
}

export function extractLocationId(body: Record<string, unknown>): string | null {
  if (body.location && typeof body.location === 'object' && (body.location as Record<string, unknown>).id) {
    return String((body.location as Record<string, unknown>).id);
  }
  if (body.location_id && typeof body.location_id === 'string') return body.location_id;
  return null;
}

export function hasMemberTag(tags: string[] | undefined): boolean {
  if (!tags) return false;
  return tags.some(t => t.includes(MEMBER_TAG_SUBSTR));
}
```

- [ ] **Step 2: Typecheck**

Run: `deno check "supabase/functions/ghl-member-agent/index.ts"`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/ghl-member-agent/index.ts
git commit -m "feat(member-agent): webhook body extractors"
```

---

## Task 3: Write failing tests for pure helper functions

**Files:**
- Create: `supabase/functions/ghl-member-agent/_test.ts`

- [ ] **Step 1: Write the test file**

Create `supabase/functions/ghl-member-agent/_test.ts`:

```typescript
import { assertEquals, assert } from '@std/assert';
import {
  extractMessageBody,
  extractMessageType,
  extractContactId,
  extractLocationId,
  normalizeChannel,
  hasMemberTag,
} from './index.ts';

Deno.test('extractMessageBody — reads nested message.body', () => {
  const body = { message: { body: 'hello' } };
  assertEquals(extractMessageBody(body), 'hello');
});

Deno.test('extractMessageBody — reads flat message_body', () => {
  assertEquals(extractMessageBody({ message_body: 'flat' }), 'flat');
});

Deno.test('extractMessageBody — returns null when missing', () => {
  assertEquals(extractMessageBody({}), null);
});

Deno.test('extractMessageType — numeric 1 → Email', () => {
  assertEquals(extractMessageType({ message: { type: 1 } }), 'Email');
});

Deno.test('extractMessageType — numeric 2 → SMS', () => {
  assertEquals(extractMessageType({ message: { type: 2 } }), 'SMS');
});

Deno.test('extractMessageType — returns null when absent', () => {
  assertEquals(extractMessageType({}), null);
});

Deno.test('extractMessageType — reads GHL Custom Data message_type', () => {
  assertEquals(extractMessageType({ message_type: 'Email' }), 'Email');
});

Deno.test('normalizeChannel — Email → email', () => {
  assertEquals(normalizeChannel('Email'), 'email');
});

Deno.test('normalizeChannel — SMS → sms', () => {
  assertEquals(normalizeChannel('SMS'), 'sms');
});

Deno.test('normalizeChannel — Calls → phone', () => {
  assertEquals(normalizeChannel('Calls'), 'phone');
});

Deno.test('extractContactId — reads contactId camelCase', () => {
  assertEquals(extractContactId({ contactId: 'abc123' }), 'abc123');
});

Deno.test('extractContactId — reads nested contact.id', () => {
  assertEquals(extractContactId({ contact: { id: 'xyz789' } }), 'xyz789');
});

Deno.test('extractLocationId — reads nested location.id', () => {
  assertEquals(extractLocationId({ location: { id: 'loc1' } }), 'loc1');
});

Deno.test('hasMemberTag — matches full decorated tag', () => {
  assert(hasMemberTag(['⭕️aiai-member-active✅']));
});

Deno.test('hasMemberTag — matches plain substring', () => {
  assert(hasMemberTag(['aiai-member-active']));
});

Deno.test('hasMemberTag — false when absent', () => {
  assertEquals(hasMemberTag(['random-tag']), false);
});

Deno.test('hasMemberTag — false when undefined', () => {
  assertEquals(hasMemberTag(undefined), false);
});
```

- [ ] **Step 2: Run tests — should pass immediately (extractors already exist from Task 2)**

Run:
```bash
cd "supabase/functions/ghl-member-agent" && deno test --allow-env --allow-net _test.ts
```
Expected: all 17 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/ghl-member-agent/_test.ts
git commit -m "test(member-agent): pure function tests for extractors"
```

---

## Task 4: Write failing test for escalation keyword scan, then implement

**Files:**
- Modify: `supabase/functions/ghl-member-agent/_test.ts`
- Modify: `supabase/functions/ghl-member-agent/index.ts`

- [ ] **Step 1: Append failing test to `_test.ts`**

Append to `supabase/functions/ghl-member-agent/_test.ts`:

```typescript
import { matchesEscalationKeyword } from './index.ts';

Deno.test('matchesEscalationKeyword — cancel', () => {
  assert(matchesEscalationKeyword('I want to cancel my membership'));
});

Deno.test('matchesEscalationKeyword — refund', () => {
  assert(matchesEscalationKeyword('Can I get a refund please?'));
});

Deno.test('matchesEscalationKeyword — billing', () => {
  assert(matchesEscalationKeyword('Question about my billing'));
});

Deno.test('matchesEscalationKeyword — MAX package', () => {
  assert(matchesEscalationKeyword('Interested in the MAX package'));
});

Deno.test('matchesEscalationKeyword — MAYA package', () => {
  assert(matchesEscalationKeyword('Can you tell me about the MAYA package?'));
});

Deno.test('matchesEscalationKeyword — done for you', () => {
  assert(matchesEscalationKeyword('Do you offer done for you services?'));
});

Deno.test('matchesEscalationKeyword — frustration: unacceptable', () => {
  assert(matchesEscalationKeyword('This is unacceptable!'));
});

Deno.test('matchesEscalationKeyword — frustration: scam', () => {
  assert(matchesEscalationKeyword('This feels like a scam'));
});

Deno.test('matchesEscalationKeyword — false for benign message', () => {
  assertEquals(matchesEscalationKeyword('How do I find the workshop replay?'), false);
});

Deno.test('matchesEscalationKeyword — false for empty', () => {
  assertEquals(matchesEscalationKeyword(''), false);
});

Deno.test('matchesEscalationKeyword — case insensitive', () => {
  assert(matchesEscalationKeyword('CANCEL my subscription now'));
});

Deno.test('matchesEscalationKeyword — does not false-positive on substrings', () => {
  // "chargebacks" contains "charge" — we want that to match (it IS billing)
  // but "uncancellable" shouldn't hit "cancel"? Actually it should — safer to escalate
  // This test documents the intended behavior: substring match is acceptable.
  assert(matchesEscalationKeyword('this is a chargeback situation'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "supabase/functions/ghl-member-agent" && deno test --allow-env --allow-net _test.ts`
Expected: FAIL — `matchesEscalationKeyword` is not defined.

- [ ] **Step 3: Implement `matchesEscalationKeyword` in `index.ts`**

Append after the extractor functions in `index.ts`:

```typescript
// ---------------------------------------------------------------------------
// Escalation keyword pre-check (no Claude call — fast path)
// ---------------------------------------------------------------------------
const ESCALATION_KEYWORDS: readonly string[] = [
  // Cancellation / exit
  'cancel', 'cancellation', 'leaving', 'quit',
  // Billing / money
  'refund', 'billing', 'charge', 'payment', 'invoice',
  // Legal / disputes
  'dispute', 'contract', 'legal', 'lawyer', 'lawsuit',
  // Product escalation (agency-done-for-you inquiries go to humans)
  'max package', 'maya package', 'atom package', 'done for you', 'full service',
  // Blocked access (when AI can't self-serve)
  'locked out',
  // Frustration signals
  'unacceptable', 'ridiculous', 'this is a scam', 'waste of money',
];

export function matchesEscalationKeyword(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return ESCALATION_KEYWORDS.some(kw => lower.includes(kw));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "supabase/functions/ghl-member-agent" && deno test --allow-env --allow-net _test.ts`
Expected: all tests PASS (29 total).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ghl-member-agent/
git commit -m "feat(member-agent): escalation keyword pre-check with tests"
```

---

## Task 5: Write failing test for agency role reader, then implement

**Files:**
- Modify: `supabase/functions/ghl-member-agent/_test.ts`
- Modify: `supabase/functions/ghl-member-agent/index.ts`

- [ ] **Step 1: Append failing tests to `_test.ts`**

Append to `_test.ts`:

```typescript
import { readAgencyRole, roleBlocksBilling } from './index.ts';

Deno.test('readAgencyRole — owner variants', () => {
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'Agency Owner' }]), 'owner');
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'owner' }]), 'owner');
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'OWNER' }]), 'owner');
});

Deno.test('readAgencyRole — manager', () => {
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'Agency Manager' }]), 'manager');
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'manager' }]), 'manager');
});

Deno.test('readAgencyRole — team member', () => {
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'Team Member' }]), 'team_member');
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'team' }]), 'team_member');
});

Deno.test('readAgencyRole — blank → unknown', () => {
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: '' }]), 'unknown');
});

Deno.test('readAgencyRole — missing field → unknown', () => {
  assertEquals(readAgencyRole([]), 'unknown');
  assertEquals(readAgencyRole(undefined), 'unknown');
});

Deno.test('readAgencyRole — matches by name substring', () => {
  // Some GHL payloads return {key: 'agency_role'} instead of {name: '⭕️Agency Role'}
  assertEquals(readAgencyRole([{ key: 'agency_role', value: 'Agency Owner' }]), 'owner');
});

Deno.test('roleBlocksBilling — owner allowed', () => {
  assertEquals(roleBlocksBilling('owner'), false);
});

Deno.test('roleBlocksBilling — manager blocked', () => {
  assertEquals(roleBlocksBilling('manager'), true);
});

Deno.test('roleBlocksBilling — team_member blocked', () => {
  assertEquals(roleBlocksBilling('team_member'), true);
});

Deno.test('roleBlocksBilling — unknown blocked (most restrictive default)', () => {
  assertEquals(roleBlocksBilling('unknown'), true);
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd "supabase/functions/ghl-member-agent" && deno test --allow-env --allow-net _test.ts`
Expected: FAIL — `readAgencyRole` and `roleBlocksBilling` not defined.

- [ ] **Step 3: Implement in `index.ts`**

Append after `matchesEscalationKeyword` in `index.ts`:

```typescript
// ---------------------------------------------------------------------------
// Agency role reader + gating
// ---------------------------------------------------------------------------
type CustomField = { id?: string; key?: string; name?: string; value?: unknown };

export function readAgencyRole(
  fields: CustomField[] | undefined
): AgencyRole {
  if (!fields || !fields.length) return 'unknown';
  const match = fields.find(f => {
    const name = (f.name ?? '').toLowerCase();
    const key = (f.key ?? '').toLowerCase();
    return name.includes('agency role') || key.includes('agency_role') || key.includes('agencyrole');
  });
  if (!match) return 'unknown';
  const raw = String(match.value ?? '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (raw.includes('owner')) return 'owner';
  if (raw.includes('manager')) return 'manager';
  if (raw.includes('team')) return 'team_member';
  return 'unknown';
}

export function roleBlocksBilling(role: AgencyRole): boolean {
  return role !== 'owner'; // everyone except owner is blocked from billing/cancel topics
}

export function roleDescription(role: AgencyRole): string {
  switch (role) {
    case 'owner': return 'Agency Owner (full access)';
    case 'manager': return 'Agency Manager (billing changes managed by account owner)';
    case 'team_member': return 'Team Member (billing and team management managed by account owner)';
    case 'unknown': return 'Team Member (role unknown — most restrictive default applied)';
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd "supabase/functions/ghl-member-agent" && deno test --allow-env --allow-net _test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ghl-member-agent/
git commit -m "feat(member-agent): agency role reader + billing gate with tests"
```

---

## Task 6: Agent signals writer + Google Chat alert (copy from sales agent)

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts`

- [ ] **Step 1: Append non-fatal signal writer and Chat alert**

Append to `index.ts`:

```typescript
// ---------------------------------------------------------------------------
// Non-fatal agent_signals writer (public schema)
// ---------------------------------------------------------------------------
async function writeAgentSignal(sig: AgentSignalPayload): Promise<void> {
  try {
    const { error } = await supabase.from('agent_signals').insert({
      source_agent: sig.source_agent,
      target_agent: sig.target_agent,
      signal_type: sig.signal_type,
      status: sig.status ?? 'delivered',
      channel: sig.channel ?? 'open',
      priority: sig.priority ?? 5,
      payload: sig.payload ?? {},
    });
    if (error) console.error('[agent_signals] insert error:', error.message);
  } catch (err) {
    console.error('[agent_signals] write threw:', err);
  }
}

// ---------------------------------------------------------------------------
// Google Chat alert (non-fatal) — real-time Keyssa alert
// ---------------------------------------------------------------------------
async function postGoogleChatAlert(text: string): Promise<void> {
  const url = Deno.env.get('GOOGLE_CHAT_WEBHOOK_URL');
  if (!url) {
    console.error('[gchat] GOOGLE_CHAT_WEBHOOK_URL not set — skipping alert');
    return;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`[gchat] alert ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error('[gchat] alert threw:', err);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `deno check "supabase/functions/ghl-member-agent/index.ts"`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/ghl-member-agent/index.ts
git commit -m "feat(member-agent): agent_signals writer and Google Chat alert"
```

---

## Task 7: GHL API helpers (contact, conversation, history, send, add tag, add note)

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts`

- [ ] **Step 1: Append GHL helpers (contact + conversation + history + send)**

Append to `index.ts`:

```typescript
// ---------------------------------------------------------------------------
// GHL API helpers
// ---------------------------------------------------------------------------
async function fetchGhlContact(contactId: string): Promise<GhlContact | null> {
  const apiKey = Deno.env.get('GHL_API_KEY');
  if (!apiKey) {
    console.error('[ghl] GHL_API_KEY missing');
    return null;
  }
  try {
    const res = await fetch(`${GHL_API_BASE}/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Version: GHL_API_VERSION },
    });
    if (!res.ok) {
      console.error(`[ghl] contact fetch ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json() as { contact?: GhlContact };
    return data.contact ?? null;
  } catch (err) {
    console.error('[ghl] contact fetch threw:', err);
    return null;
  }
}

type ConversationLookup = { id: string; suggestedChannel: Channel | null };

async function lookupConversation(contactId: string): Promise<ConversationLookup | null> {
  const apiKey = Deno.env.get('GHL_API_KEY');
  if (!apiKey) return null;
  try {
    const params = new URLSearchParams({
      contactId,
      locationId: GHL_LOCATION_ID,
      limit: '10',
      sortBy: 'last_message_date',
      sort: 'desc',
    });
    const res = await fetch(`${GHL_API_BASE}/conversations/search?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Version: GHL_API_VERSION },
    });
    if (!res.ok) {
      console.error(`[ghl] conversation lookup ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json() as { conversations?: Array<{ id: string; type?: string; lastMessageType?: string }> };
    const convos = data.conversations ?? [];
    const phoneTypes = new Set(['TYPE_PHONE', 'TYPE_CALL', 'TYPE_IVR_CALL']);
    const emailConvo = convos.find(c => (c.type ?? '').toUpperCase().includes('EMAIL'));
    const nonPhoneConvo = convos.find(c => !phoneTypes.has(c.type ?? ''));
    const chosen = emailConvo ?? nonPhoneConvo ?? convos[0] ?? null;
    if (!chosen) return null;

    const ct = (chosen.type ?? '').toUpperCase();
    const lmt = (chosen.lastMessageType ?? '').toUpperCase();
    const suggestedChannel: Channel | null =
      ct.includes('EMAIL') || lmt.includes('EMAIL') ? 'email' :
      (phoneTypes.has(ct) || lmt.includes('CALL') || lmt.includes('IVR') || lmt.includes('PHONE')) ? 'phone' :
      'sms';

    return { id: chosen.id, suggestedChannel };
  } catch (err) {
    console.error('[ghl] conversation lookup threw:', err);
    return null;
  }
}

async function fetchGhlConversationHistory(conversationId: string): Promise<GhlMessage[]> {
  const apiKey = Deno.env.get('GHL_API_KEY');
  if (!apiKey) return [];
  try {
    const res = await fetch(
      `${GHL_API_BASE}/conversations/${conversationId}/messages?limit=20`,
      { headers: { Authorization: `Bearer ${apiKey}`, Version: GHL_API_VERSION } }
    );
    if (!res.ok) {
      console.error(`[ghl] history fetch ${res.status}: ${await res.text()}`);
      return [];
    }
    const data = await res.json() as { messages?: { messages?: GhlMessage[] } };
    const msgs = data.messages?.messages ?? [];
    return [...msgs].reverse();
  } catch (err) {
    console.error('[ghl] history fetch threw:', err);
    return [];
  }
}

async function fetchLocalHistory(contactId: string): Promise<GhlMessage[]> {
  try {
    const { data, error } = await supabase
      .schema('ops')
      .from('ai_inbox_conversation_memory')
      .select('role, message')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) {
      console.error('[local-history] read error:', error.message);
      return [];
    }
    return (data ?? []).reverse().map(row => ({
      direction: (row.role === 'assistant' ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
      body: row.message as string,
    }));
  } catch (err) {
    console.error('[local-history] threw:', err);
    return [];
  }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/\*(.+?)\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    .replace(/_(.+?)_/gs, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendGhlReply(
  contactId: string,
  replyText: string,
  channel: Channel
): Promise<boolean> {
  if (channel === 'phone') {
    console.log('[ghl] skipping reply for phone/calls channel');
    return false;
  }
  const apiKey = Deno.env.get('GHL_API_KEY');
  if (!apiKey) {
    console.error('[ghl] cannot send reply — GHL_API_KEY missing');
    return false;
  }
  const ghlType = channel === 'email' ? 'Email' : 'SMS';

  const emailSignature = [
    '<br><br>',
    '<hr style="border:none;border-top:1px solid #e0e0e0;margin:20px 0">',
    '<p style="margin:0;font-family:sans-serif;font-size:13px;color:#555">',
    '<strong>Ai Phil</strong> &nbsp;|&nbsp; AI Assistant, AiAi Mastermind<br>',
    '<em style="color:#888">This reply was generated by AI. A human teammate is always available if needed.</em>',
    '</p>',
  ].join('');

  const payload = channel === 'email'
    ? {
        type: ghlType,
        contactId,
        subject: 'Re: Your message',
        html: replyText.replace(/\n/g, '<br>') + emailSignature,
      }
    : { type: ghlType, contactId, message: replyText };

  try {
    const res = await fetch(`${GHL_API_BASE}/conversations/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: GHL_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[ghl] send reply ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[ghl] send reply threw:', err);
    return false;
  }
}
```

- [ ] **Step 2: Append tag-add and note-add helpers (new for member agent)**

Append to `index.ts`:

```typescript
// Add a tag to a contact (non-fatal — used for escalation routing)
async function addGhlTag(contactId: string, tag: string): Promise<boolean> {
  const apiKey = Deno.env.get('GHL_API_KEY');
  if (!apiKey) return false;
  try {
    const res = await fetch(`${GHL_API_BASE}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: GHL_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tags: [tag] }),
    });
    if (!res.ok) {
      console.error(`[ghl] addTag ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[ghl] addTag threw:', err);
    return false;
  }
}

// Post a contact note (non-fatal — visible to team in GHL UI)
async function addGhlContactNote(contactId: string, noteBody: string): Promise<boolean> {
  const apiKey = Deno.env.get('GHL_API_KEY');
  if (!apiKey) return false;
  try {
    const res = await fetch(`${GHL_API_BASE}/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: GHL_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: noteBody }),
    });
    if (!res.ok) {
      console.error(`[ghl] addNote ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[ghl] addNote threw:', err);
    return false;
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `deno check "supabase/functions/ghl-member-agent/index.ts"`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/ghl-member-agent/index.ts
git commit -m "feat(member-agent): GHL API helpers (contact, history, send, tag, note)"
```

---

## Task 8: Google Doc fetch + Claude API helper

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts`

- [ ] **Step 1: Append helpers**

Append to `index.ts`:

```typescript
// ---------------------------------------------------------------------------
// Google Doc fetch (public docs)
// ---------------------------------------------------------------------------
async function fetchGoogleDoc(docId: string, fallback: string): Promise<string> {
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

// ---------------------------------------------------------------------------
// Claude Anthropic API
// ---------------------------------------------------------------------------
async function callClaude(
  model: string,
  maxTokens: number,
  system: string,
  userMessage: string
): Promise<string> {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY missing');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as { content?: Array<{ text?: string }> };
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Claude returned empty content');
  return text.trim();
}
```

- [ ] **Step 2: Typecheck**

Run: `deno check "supabase/functions/ghl-member-agent/index.ts"`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/ghl-member-agent/index.ts
git commit -m "feat(member-agent): Google Doc fetch + Claude API helper"
```

---

## Task 9: Write failing test for intent classifier validator, then implement classifier

**Files:**
- Modify: `supabase/functions/ghl-member-agent/_test.ts`
- Modify: `supabase/functions/ghl-member-agent/index.ts`

- [ ] **Step 1: Append failing tests to `_test.ts`**

Append to `_test.ts`:

```typescript
import { parseIntent, formatHistory } from './index.ts';

Deno.test('parseIntent — valid onboarding', () => {
  assertEquals(parseIntent('onboarding'), 'onboarding');
});

Deno.test('parseIntent — valid content', () => {
  assertEquals(parseIntent('content'), 'content');
});

Deno.test('parseIntent — valid event', () => {
  assertEquals(parseIntent('event'), 'event');
});

Deno.test('parseIntent — valid coaching', () => {
  assertEquals(parseIntent('coaching'), 'coaching');
});

Deno.test('parseIntent — valid support', () => {
  assertEquals(parseIntent('support'), 'support');
});

Deno.test('parseIntent — valid escalate', () => {
  assertEquals(parseIntent('escalate'), 'escalate');
});

Deno.test('parseIntent — strips punctuation', () => {
  assertEquals(parseIntent('support.'), 'support');
  assertEquals(parseIntent('  onboarding  '), 'onboarding');
  assertEquals(parseIntent('"event"'), 'event');
});

Deno.test('parseIntent — case insensitive', () => {
  assertEquals(parseIntent('SUPPORT'), 'support');
  assertEquals(parseIntent('Coaching'), 'coaching');
});

Deno.test('parseIntent — unknown defaults to support', () => {
  // Per design: ambiguous messages default to support (not escalate)
  // so they get answered rather than routed to a human.
  assertEquals(parseIntent('garbage'), 'support');
  assertEquals(parseIntent(''), 'support');
});

Deno.test('formatHistory — empty returns marker', () => {
  assertEquals(formatHistory([]), '(no prior messages)');
});

Deno.test('formatHistory — formats MEMBER/AI', () => {
  const out = formatHistory([
    { direction: 'inbound', body: 'hi' },
    { direction: 'outbound', body: 'hello' },
  ]);
  assertEquals(out, 'MEMBER: hi\nAI: hello');
});

Deno.test('formatHistory — skips empty bodies', () => {
  const out = formatHistory([
    { direction: 'inbound', body: '' },
    { direction: 'outbound', body: 'only this' },
  ]);
  assertEquals(out, 'AI: only this');
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd "supabase/functions/ghl-member-agent" && deno test --allow-env --allow-net _test.ts`
Expected: FAIL — `parseIntent` and `formatHistory` not defined.

- [ ] **Step 3: Implement both functions in `index.ts`**

Append after `callClaude` in `index.ts`:

```typescript
// ---------------------------------------------------------------------------
// Intent classifier
// ---------------------------------------------------------------------------
const VALID_INTENTS: readonly Intent[] = [
  'onboarding', 'content', 'event', 'coaching', 'support', 'escalate',
];

export function parseIntent(raw: string): Intent {
  const cleaned = raw.toLowerCase().replace(/[^a-z]/g, '');
  if ((VALID_INTENTS as readonly string[]).includes(cleaned)) {
    return cleaned as Intent;
  }
  // Per design: ambiguous defaults to 'support' (answer it) rather than
  // 'escalate' (route to human). Keyword pre-check handles true escalations.
  return 'support';
}

async function classifyMemberIntent(messageBody: string, role: AgencyRole): Promise<Intent> {
  const system = 'You are a message router for a member support inbox. Reply with exactly one word only: onboarding, content, event, coaching, support, or escalate. No punctuation, no explanation.';
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

  try {
    const raw = await callClaude('claude-haiku-4-5-20251001', 10, system, user);
    return parseIntent(raw);
  } catch (err) {
    console.error('[classify] threw:', err);
    return 'support';
  }
}

// ---------------------------------------------------------------------------
// History formatter
// ---------------------------------------------------------------------------
export function formatHistory(history: GhlMessage[]): string {
  if (!history.length) return '(no prior messages)';
  return history
    .filter(m => typeof m.body === 'string' && m.body.trim().length > 0)
    .map(m => {
      const speaker = m.direction === 'outbound' ? 'AI' : 'MEMBER';
      return `${speaker}: ${m.body}`;
    })
    .join('\n');
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd "supabase/functions/ghl-member-agent" && deno test --allow-env --allow-net _test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ghl-member-agent/
git commit -m "feat(member-agent): 6-category intent classifier + history formatter"
```

---

## Task 10: System prompts for each intent

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts`

- [ ] **Step 1: Append prompt builders**

Append to `index.ts`:

```typescript
// ---------------------------------------------------------------------------
// System prompt builders (member agent — KB-grounded)
// ---------------------------------------------------------------------------
const SHARED_IDENTITY = `IDENTITY: You are Ai Phil — the AI assistant for AiAi Mastermind. You are an AI, not Phillip himself. If asked who you are, say: "I'm Ai Phil, the AI assistant for AiAi Mastermind." Never claim to be Phillip Ngo or a real person. You DO have access to the conversation history below — never tell the member you can't see prior messages.`;

const SHARED_RULES = `RULES:
- Never guess. If you don't know, say so and offer to flag it for the team.
- Never discuss billing, cancellations, refunds, or legal matters — these are escalations.
- Never promise features, timelines, or commitments not in the knowledge base.
- Always use "Hi [Name]", never "Hey".
- SMS: plain text, under 480 characters. Email: short paragraphs, 3-4 sentences each.
- Do NOT use markdown formatting (no **bold**, no *italics*, no # headers) — SMS renders raw asterisks.`;

function memberSupportPrompt(
  intent: Intent,
  memberKb: string,
  productsKb: string,
  eventsKb: string,
  firstName: string,
  role: AgencyRole,
  channel: Channel,
  historyStr: string
): string {
  const roleLine = `AGENCY ROLE: ${roleDescription(role)}`;
  const roleRestriction = roleBlocksBilling(role)
    ? `This member CANNOT self-serve billing, cancellation, or account ownership topics. If asked, respond: "Billing and account changes are managed by your agency owner — I've flagged this for our team."`
    : `This member has full access — answer billing/account questions directly if covered by the KB, otherwise flag for the team.`;

  const intentFocus: Record<Intent, string> = {
    onboarding: 'Focus on login, Google Workspace setup, mastery.aiaimastermind.com access, and getting started. Use the MEMBER SUPPORT KB as the primary source.',
    content: 'Focus on workshop replays (IMM/SCMM/ATOM), module navigation, and where to find recordings. Use the MEMBER SUPPORT KB as the primary source.',
    event: 'Focus on event schedules, links, and replay availability. Use the ACTIVE EVENTS knowledge as the primary source; fall back to MEMBER SUPPORT KB for weekly-call questions.',
    support: 'Focus on general logistics: weekly call schedule, benefits overview, DFY Setup vs DFY Package distinction, identity questions, greetings.',
    coaching: '(This intent should not reach this prompt — it is routed to a hardcoded redirect.)',
    escalate: '(This intent should not reach this prompt — it is routed to the escalation flow.)',
  };

  return `You are Ai Phil — the AI assistant for AiAi Mastermind, providing member support.

${SHARED_IDENTITY}

ROLE: Member support. You help active members navigate the community, find content, and get answers. You do NOT pitch or sell — they're already members.

${SHARED_RULES}

INTENT FOR THIS REPLY: ${intent}
${intentFocus[intent]}

${roleLine}
${roleRestriction}

MEMBER SUPPORT KB (primary):
${memberKb}

PRODUCTS & PRICING (reference only):
${productsKb}

ACTIVE EVENTS:
${eventsKb}

CONVERSATION HISTORY (oldest to newest):
${historyStr}

Respond to the member's latest message. Use "Hi ${firstName || 'there'}". Channel: ${channel}. Keep it grounded in the KB — if the answer isn't there, say so and offer to flag it.`;
}

// Hardcoded coaching redirect — no Claude call
function coachingRedirect(firstName: string): string {
  return `Hi ${firstName || 'there'}, great question — strategy and coaching-style questions are best answered live so Phillip can look at your specific situation. Bring this to the Thursday Mastermind Call, or book an Extra Care breakout for a deeper 1:1. Want me to flag it for the team to follow up?`;
}

// Escalation acknowledgment — hardcoded, no Claude call
function escalationAcknowledgment(firstName: string): string {
  return `Hi ${firstName || 'there'}, I want to make sure you get the right help on this. I've flagged your message for our team and someone will reach out shortly.`;
}
```

- [ ] **Step 2: Typecheck**

Run: `deno check "supabase/functions/ghl-member-agent/index.ts"`
Expected: no errors.

- [ ] **Step 3: Run unit tests (should still pass)**

Run: `cd "supabase/functions/ghl-member-agent" && deno test --allow-env --allow-net _test.ts`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/ghl-member-agent/index.ts
git commit -m "feat(member-agent): system prompts + coaching/escalation redirects"
```

---

## Task 11: Main handler — wire everything together

**Files:**
- Modify: `supabase/functions/ghl-member-agent/index.ts`

- [ ] **Step 1: Replace the scaffold `Deno.serve` with the full handler**

In `supabase/functions/ghl-member-agent/index.ts`, find:

```typescript
// Stub handler — replaced in Task 10
Deno.serve(async (_req: Request) => {
  return new Response('ghl-member-agent scaffold', { status: 200 });
});
```

Replace with:

```typescript
// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch (_err) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Step 1: Validate location
  const locationId = extractLocationId(body);
  if (locationId !== GHL_LOCATION_ID) {
    console.error(`[location] rejected ${locationId}`);
    return new Response(
      JSON.stringify({ error: 'Invalid location', received: locationId }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Step 2: Extract message fields
  const contactId = extractContactId(body);
  let conversationId = extractConversationId(body);
  const messageBody = extractMessageBody(body);
  const rawMessageType = extractMessageType(body);
  let channel: Channel = rawMessageType ? normalizeChannel(rawMessageType) : 'sms';

  if (!contactId || !messageBody) {
    console.error('[extract] missing required fields', { contactId, conversationId, hasMessage: !!messageBody });
    return new Response(
      JSON.stringify({ error: 'Missing required fields', contactId, conversationId, hasMessage: !!messageBody }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Resolve conversationId if absent
  if (!conversationId && contactId) {
    const lookup = await lookupConversation(contactId);
    if (!lookup) {
      console.error('[extract] could not resolve conversationId for contact', contactId);
      return new Response(
        JSON.stringify({ error: 'Could not resolve conversationId', contactId }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    conversationId = lookup.id;
    if (!rawMessageType && lookup.suggestedChannel && lookup.suggestedChannel !== 'phone') {
      channel = lookup.suggestedChannel;
    }
  }

  try {
    // Step 3: Fetch contact + history in parallel
    const [contactResult, historyResult] = await Promise.allSettled([
      fetchGhlContact(contactId),
      fetchGhlConversationHistory(conversationId!),
    ]);

    const contact = contactResult.status === 'fulfilled' ? contactResult.value : null;
    const tags = contact?.tags ?? [];
    const firstName = contact?.firstName ?? '';
    const lastName = contact?.lastName ?? '';
    const phone = contact?.phone ?? '';

    // Step 4: Safety failsafe — this function is for members only.
    // If the member tag is missing (workflow misconfiguration), drop the request.
    if (!hasMemberTag(tags)) {
      console.error('[safety] non-member hit member endpoint — dropping', { contactId });
      await writeAgentSignal({
        source_agent: 'ghl-member-agent',
        target_agent: 'richie-cc2',
        signal_type: 'non-member-at-member-endpoint',
        status: 'dropped',
        channel: 'open',
        priority: 2,
        payload: { contact_id: contactId, tags },
      });
      return new Response(
        JSON.stringify({ ok: true, skipped: 'non-member' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Read agency role
    const role: AgencyRole = readAgencyRole(contact?.customFields);

    // History with local fallback
    let history: GhlMessage[] = [];
    if (historyResult.status === 'fulfilled') history = historyResult.value;
    if (!history.length) {
      console.log('[history] GHL returned empty — falling back to local memory');
      history = await fetchLocalHistory(contactId);
    }
    const historyStr = formatHistory(history);

    // Step 5: Escalation keyword pre-check — fast path, no Claude
    const keywordEscalation = matchesEscalationKeyword(messageBody);

    // Step 6: Fetch all KB docs in parallel
    const [memberKbRes, productsRes, eventsRes] = await Promise.allSettled([
      fetchGoogleDoc(MEMBER_SUPPORT_DOC_ID, '(Member Support KB temporarily unavailable.)'),
      fetchGoogleDoc(PRODUCTS_PRICING_DOC_ID, '(Products & Pricing KB temporarily unavailable.)'),
      fetchGoogleDoc(EVENTS_DOC_ID, '(Events KB temporarily unavailable.)'),
    ]);
    const memberKb = memberKbRes.status === 'fulfilled' ? memberKbRes.value : '(Member Support KB temporarily unavailable.)';
    const productsKb = productsRes.status === 'fulfilled' ? productsRes.value : '(Products & Pricing KB temporarily unavailable.)';
    const eventsKb = eventsRes.status === 'fulfilled' ? eventsRes.value : '(Events KB temporarily unavailable.)';

    // Step 7: Intent — either forced escalate (keyword), or Claude classifier
    const intent: Intent = keywordEscalation
      ? 'escalate'
      : await classifyMemberIntent(messageBody, role);

    // Step 8: Role-gated billing auto-escalation
    // If manager/team/unknown asks about billing-adjacent topics, force escalate
    const billingLikely = /\b(bill|charge|refund|payment|invoice|subscription|plan|upgrade|downgrade)\b/i.test(messageBody);
    const finalIntent: Intent = (roleBlocksBilling(role) && billingLikely) ? 'escalate' : intent;

    // Step 9: Generate reply based on intent
    let replyText = '';
    let modelUsed = '';
    let handledAsEscalation = false;

    if (finalIntent === 'escalate') {
      replyText = escalationAcknowledgment(firstName);
      modelUsed = 'hardcoded-escalation';
      handledAsEscalation = true;
    } else if (finalIntent === 'coaching') {
      replyText = coachingRedirect(firstName);
      modelUsed = 'hardcoded-coaching';
    } else {
      // onboarding | content | event | support → Claude Haiku, KB-grounded
      modelUsed = 'claude-haiku-4-5-20251001';
      try {
        replyText = await callClaude(
          modelUsed,
          300,
          memberSupportPrompt(finalIntent, memberKb, productsKb, eventsKb, firstName, role, channel, historyStr),
          messageBody
        );
      } catch (err) {
        console.error('[generate] Claude failed:', err);
        replyText = `Hi ${firstName || 'there'}, I hit a snag pulling that up. I've flagged this for our team — someone will follow up shortly.`;
        handledAsEscalation = true; // fall into escalation flow so team sees it
      }
    }

    // Sanitize for SMS
    if (channel === 'sms') {
      replyText = stripMarkdown(replyText);
      if (replyText.length > 480) replyText = replyText.substring(0, 477) + '...';
    }

    // Step 10: Send reply
    const sendOk = await sendGhlReply(contactId, replyText, channel);

    // Step 11: Log conversation memory (both rows) with member_support intent
    try {
      const { error } = await supabase.schema('ops').from('ai_inbox_conversation_memory').insert([
        {
          contact_id: contactId,
          conversation_id: conversationId,
          channel,
          role: 'user',
          message: messageBody,
          intent: 'member_support',
          stage: finalIntent,
        },
        {
          contact_id: contactId,
          conversation_id: conversationId,
          channel,
          role: 'assistant',
          message: replyText,
          intent: 'member_support',
          stage: finalIntent,
        },
      ]);
      if (error) console.error('[memory] insert error:', error.message);
    } catch (err) {
      console.error('[memory] insert threw:', err);
    }

    // Step 12: Escalation actions (tag + note + Google Chat)
    if (handledAsEscalation) {
      const contactName = `${firstName} ${lastName}`.trim();
      const preview = messageBody.substring(0, 200);
      const noteBody = `👷 Member escalation — ${new Date().toISOString()}: ${preview}. Channel: ${channel}. Agency role: ${role}.`;
      const chatText = `🚨 Member needs human — ${contactName || contactId} (${role}) via ${channel}: ${preview}`;

      // Fire all escalation actions in parallel — none are fatal
      await Promise.allSettled([
        addGhlTag(contactId, ESCALATION_TAG),
        addGhlContactNote(contactId, noteBody),
        postGoogleChatAlert(chatText),
      ]);
    }

    // Step 13: Audit signal
    await writeAgentSignal({
      source_agent: 'ghl-member-agent',
      target_agent: 'richie-cc2',
      signal_type: sendOk ? 'ai-member-reply-sent' : 'ai-member-error',
      status: sendOk ? 'delivered' : 'failed',
      channel: 'open',
      priority: handledAsEscalation ? 2 : 4,
      payload: {
        contact_id: contactId,
        conversation_id: conversationId,
        channel,
        intent: finalIntent,
        keyword_escalation: keywordEscalation,
        role,
        model: modelUsed,
        message_preview: messageBody.substring(0, 200),
        reply_preview: replyText.substring(0, 200),
        send_ok: sendOk,
      },
    });

    return new Response(
      JSON.stringify({ ok: true, intent: finalIntent, escalated: handledAsEscalation, sent: sendOk }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[fatal] handler threw:', err);
    const msg = err instanceof Error ? err.message : String(err);
    await writeAgentSignal({
      source_agent: 'ghl-member-agent',
      target_agent: 'richie-cc2',
      signal_type: 'ai-member-error',
      status: 'failed',
      channel: 'open',
      priority: 1,
      payload: { contact_id: contactId, conversation_id: conversationId, channel, error: msg },
    });
    return new Response(
      JSON.stringify({ error: 'Internal error', detail: msg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
```

- [ ] **Step 2: Typecheck the full file**

Run: `deno check "supabase/functions/ghl-member-agent/index.ts"`
Expected: no errors.

- [ ] **Step 3: Run unit tests**

Run: `cd "supabase/functions/ghl-member-agent" && deno test --allow-env --allow-net _test.ts`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/ghl-member-agent/index.ts
git commit -m "feat(member-agent): main handler wiring 13-step flow"
```

---

## Task 12: Deploy edge function to Supabase

**Files:**
- None modified — deployment only

- [ ] **Step 1: Deploy via Supabase MCP**

Use the Supabase MCP `deploy_edge_function` tool with:
- `project_id`: `ylppltmwueasbdexepip`
- `name`: `ghl-member-agent`
- `entrypoint_path`: `index.ts`
- Files: the `index.ts` file content from `supabase/functions/ghl-member-agent/index.ts`

If deploying via CLI instead:
```bash
cd "/Users/philgoodmac/Library/CloudStorage/GoogleDrive-phillip@aiaimastermind.com/My Drive/Coding Projects/Ai Phil"
supabase functions deploy ghl-member-agent --project-ref ylppltmwueasbdexepip
```

Expected: function deployed, status ACTIVE, version 1.

- [ ] **Step 2: Verify deployment via MCP**

Use Supabase MCP `get_edge_function` for `ghl-member-agent`. Expected: status `ACTIVE`, version `1`, slug `ghl-member-agent`.

- [ ] **Step 3: Smoke test — reject bad location**

```bash
curl -i -X POST "https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-member-agent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -d '{"location":{"id":"wrong-location"},"contactId":"x","message_body":"hi","message_type":"SMS"}'
```
Expected: HTTP 403, body `{"error":"Invalid location","received":"wrong-location"}`.

- [ ] **Step 4: Smoke test — reject missing contactId**

```bash
curl -i -X POST "https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-member-agent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -d '{"location":{"id":"ARMyDGKPbnem0Brkxpko"},"message_body":"hi","message_type":"SMS"}'
```
Expected: HTTP 400, body includes `"error":"Missing required fields"`.

- [ ] **Step 5: Check Supabase logs**

Via Supabase MCP `get_logs` for `edge-function`, filter last 10 min. Expected: log entries for both smoke tests showing rejection reasons.

---

## Task 13: Write GHL workflow setup guide for the team

**Files:**
- Create: `vault/80-processes/2026-04-16-GHL-Member-Agent-Workflow-Guide.md`

- [ ] **Step 1: Create the markdown guide**

Create `vault/80-processes/2026-04-16-GHL-Member-Agent-Workflow-Guide.md`:

```markdown
---
type: process
date: 2026-04-16
tags: [ai-inbox, ghl, workflow, member-support, team-handoff]
emoji: 📋
---

# 📋 GHL Member Agent — Workflow Setup Guide

Build two GHL workflows so active members' SMS + email auto-route to the Ai Phil member agent.

**Webhook URL (both workflows):**
`https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-member-agent`

---

## Workflow 1: 🔥MBR E1 - AI Inbox — SMS Member Support

1. **Trigger:** Customer Replied
2. **Filters:**
   - Reply Channel = SMS
   - Contact HAS Tag: `⭕️aiai-member-active✅`
3. **Action: Webhook**
   - URL: `https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-member-agent`
   - Method: POST
   - Custom Data field: `message_type` = `SMS`
4. **Save & Publish**

## Workflow 2: 🔥MBR E2 - AI Inbox — Email Member Support

Same as above, but:
- Reply Channel = Email
- Custom Data `message_type` = `Email`

---

## Test checklist (after building)

- [ ] Send an SMS from a phone number attached to a contact with `⭕️aiai-member-active✅` → Ai Phil replies within ~15 sec
- [ ] Send an email reply from the same contact → Ai Phil replies with HTML + signature
- [ ] Send "I want to cancel" → Ai Phil sends acknowledgment only; contact gets `👷needs-human-support` tag; Google Chat alert posts to Keyssa
- [ ] Send "How do I find the Thursday replay?" → Ai Phil answers from Member Support KB
- [ ] Send "Should I run Meta ads?" → Ai Phil redirects to Thursday Mastermind Call
```

- [ ] **Step 2: (Optional) Mirror to Google Doc**

Per the team's preference (memory: `feedback_ghl_workflow_output.md`), mirror this markdown to a Google Doc in the vault's GHL workflow folder using `mcp__google-docs-mcp__createDocument` or an equivalent tool. Paste the URL into the markdown file header.

- [ ] **Step 3: Commit**

```bash
git add vault/80-processes/2026-04-16-GHL-Member-Agent-Workflow-Guide.md
git commit -m "docs(member-agent): team workflow setup guide"
```

---

## Task 14: Live end-to-end test

**Files:**
- None modified — testing only

- [ ] **Step 1: Confirm GHL workflows are built and published**

Ask Phillip to confirm both `🔥MBR E1` and `🔥MBR E2` are live in GHL and verify via the team.

- [ ] **Step 2: SMS test — benign question**

Send SMS from a test phone attached to a contact with `⭕️aiai-member-active✅`: "Where can I find last week's workshop replay?"
Expected within ~20 sec:
- Reply SMS from Ai Phil (under 480 chars, no markdown asterisks)
- `ops.ai_inbox_conversation_memory` has 2 new rows with `intent='member_support'`, `stage='content'` (or `support`)
- `public.agent_signals` has a new row with `source_agent='ghl-member-agent'`, `signal_type='ai-member-reply-sent'`

- [ ] **Step 3: Email test — benign question**

Reply to an email thread from same contact: "How do I access the member portal?"
Expected:
- Email reply with HTML body + Ai Phil signature block
- `ops.ai_inbox_conversation_memory` rows appear for email channel

- [ ] **Step 4: Escalation test — keyword trigger**

Send SMS: "I want to cancel my membership."
Expected:
- Reply: "Hi [Name], I want to make sure you get the right help on this. I've flagged your message for our team..."
- Contact in GHL gets `👷needs-human-support` tag
- Contact note added: `👷 Member escalation — [ISO timestamp]: I want to cancel my membership. Channel: sms. Agency role: [role].`
- Google Chat (Keyssa room) receives: `🚨 Member needs human — [Name] ([role]) via sms: I want to cancel my membership.`
- `agent_signals` row has `signal_type='ai-member-reply-sent'`, payload shows `keyword_escalation: true`, `intent: 'escalate'`

- [ ] **Step 5: Coaching test**

Send SMS: "Should I run Facebook ads or Google ads for my agency?"
Expected: reply redirects to Thursday Mastermind Call / Extra Care breakout. No Claude call (model=hardcoded-coaching).

- [ ] **Step 6: Role gating test**

For a contact with `⭕️Agency Role` = `Agency Manager` (not Owner), send: "When is my next billing charge?"
Expected: escalation flow triggered (role blocks billing), tag added, Google Chat alert fires.

- [ ] **Step 7: Non-member failsafe test**

Manually trigger the webhook with a contactId that does NOT have the member tag (curl with a real non-member contactId, location valid, message valid). Expected: HTTP 200 with `{"ok":true,"skipped":"non-member"}`, no reply sent, `agent_signals` row has `signal_type='non-member-at-member-endpoint'`.

- [ ] **Step 8: Query Supabase for audit trail**

Via Supabase MCP `execute_sql`:
```sql
SELECT created_at, signal_type, status, payload->>'intent' AS intent, payload->>'role' AS role, payload->>'keyword_escalation' AS kw
FROM agent_signals
WHERE source_agent = 'ghl-member-agent'
ORDER BY created_at DESC
LIMIT 10;
```
Expected: rows for each test above with correct intents and statuses.

---

## Task 15: Update ROADMAP and write session summary

**Files:**
- Modify: `vault/60-content/ai-phil/_ROADMAP.md`
- Create: `vault/50-meetings/2026-04-16-ghl-member-agent-shipped.md`

- [ ] **Step 1: Update ROADMAP Shipped table**

In `vault/60-content/ai-phil/_ROADMAP.md`, find the Shipped table and add as the top row:

```markdown
| 2026-04-16 | **AI Inbox — `ghl-member-agent` edge function** | Supabase edge function handles inbound SMS + Email from active members (`⭕️aiai-member-active✅` tag). 6-category intent routing (onboarding/content/event/coaching/support/escalate). Agency-role gating on billing/cancellation topics. Keyword + AI escalation → GHL tag `👷needs-human-support` + contact note + Google Chat alert to Keyssa. Shares `ops.ai_inbox_conversation_memory` with sales agent and future Ai Phil Voice. Webhook: `https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-member-agent` |
```

Also update the `updated:` frontmatter date to today.

- [ ] **Step 2: Update Known Issues**

In `vault/60-content/ai-phil/_ROADMAP.md`, find the Known Issues section and:
- Leave the `ghl-sales-followup` item in place (still pending — P2 for AI Inbox)
- Add a new line: "**AI Inbox — Ai Phil Voice not yet built** — Hume EVI + Twilio inbound for GHL calls is the next omnichannel layer. Shared memory already in place via `ops.ai_inbox_conversation_memory`."

- [ ] **Step 3: Create session summary**

Create `vault/50-meetings/2026-04-16-ghl-member-agent-shipped.md`:

```markdown
---
type: session-summary
date: 2026-04-16
tags: [ai-inbox, ghl, member-agent, shipped]
emoji: ✅
---

# ✅ ghl-member-agent — Shipped

**Session:** Claude Code, 2026-04-16

## What shipped

Supabase edge function `ghl-member-agent` (version 1, ACTIVE) — handles inbound SMS + Email from active AiAi Mastermind members. Mirrors the `ghl-sales-agent` pattern with a different audience and an escalation flow instead of a checkout-link queue.

## Key behaviors

- **Tag-gated intake:** rejects any contact without `⭕️aiai-member-active✅` (safety failsafe)
- **6-category intent routing:** onboarding, content, event, coaching, support, escalate
- **Agency-role gating:** Manager / Team Member / unknown → cannot self-serve billing or cancellation topics
- **Two escalation paths:** keyword pre-check (fast) + Claude nuanced classification
- **Escalation actions:** contact gets acknowledgment reply + `👷needs-human-support` tag + contact note + real-time Google Chat alert to Keyssa
- **Coaching redirect:** strategy questions bounce to Thursday Mastermind Call / Extra Care (hardcoded — no Claude)
- **Shared memory:** writes `intent='member_support'` rows to `ops.ai_inbox_conversation_memory` (same table as sales agent + future voice agent)

## GHL wiring

Two new workflows (team-built from `vault/80-processes/2026-04-16-GHL-Member-Agent-Workflow-Guide.md`):
- `🔥MBR E1 - AI Inbox — SMS Member Support` (HAS member tag)
- `🔥MBR E2 - AI Inbox — Email Member Support` (HAS member tag)

## Test results

(Fill in after live end-to-end test)

## What's next

- **Phase 2:** `ghl-sales-followup` (24/48/72hr follow-ups from `ops.ai_inbox_followup_queue`)
- **Parallel:** P2 eval harness (`scripts/eval-answers.ts`)
- **Next omnichannel layer:** Ai Phil Voice (Hume EVI + Twilio), shares `ops.ai_inbox_conversation_memory`. Voice must pronounce "A I A I Mastermind dot com", never "AyAy".
```

- [ ] **Step 4: Commit**

```bash
git add vault/60-content/ai-phil/_ROADMAP.md vault/50-meetings/2026-04-16-ghl-member-agent-shipped.md
git commit -m "docs: ship ghl-member-agent — roadmap + session summary"
```

---

## Final Verification

- [ ] All 15 tasks complete, all commits pushed
- [ ] Edge function `ghl-member-agent` ACTIVE on Supabase
- [ ] Both GHL workflows (`🔥MBR E1`, `🔥MBR E2`) built and published
- [ ] All 8 test scenarios in Task 14 pass
- [ ] ROADMAP updated with shipped row and known-issue note
- [ ] Session summary filed in `vault/50-meetings/`
- [ ] All Deno unit tests pass (`deno test --allow-env --allow-net _test.ts` → all green)
