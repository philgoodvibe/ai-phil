# ghl-member-agent — Design Spec

**Date:** 2026-04-16  
**Status:** Approved — ready for implementation plan  
**Approved by:** Phillip Ngo  
**Builder:** Claude Code  
**Vault reference:** `30-products/AI-Inbox.md §8`, `80-processes/AI-Inbox-Build-Plan-2026-04-16.md Phase 3`

---

## Context

The `ghl-sales-agent` (v9, live) handles all inbound GHL SMS + Email from **non-members**. When a contact has the `⭕️aiai-member-active✅` tag, the sales agent skips and logs `member-contact-received` — but no reply is sent. This function fills that gap.

The member agent is one spoke of the Ai Phil omnichannel architecture:

```
Phone (inbound GHL calls) → Ai Phil Voice (Hume EVI + Twilio) [future]
SMS/Email (prospects)     → ghl-sales-agent [live]
SMS/Email (members)       → ghl-member-agent [this build]

Shared brain: ops.ai_inbox_conversation_memory
  All three write to the same table.
  When a member texts then calls, Ai Phil Voice has the full thread.
```

True north: Ai Phil is an extension of Phillip across every touchpoint — phone, text, email, portal. The member agent is the text/email layer of that vision.

---

## What it replaces

The original AI-Inbox spec (§8) called for GHL Conversation AI (Agent Studio) for member support. That approach is superseded by a Supabase edge function (`ghl-member-agent`) — same pattern as `ghl-sales-agent`. Benefits: full observability, shared memory table, consistent deployment, easier to extend with tool access later.

---

## Architecture

### GHL Workflows (team builds — same pattern as E1/E2, inverted tag filter)

| Workflow | Trigger | Tag filter | Custom Data |
|---|---|---|---|
| `🔥MBR E1 - AI Inbox — SMS Member Support` | Customer Replied | Reply Channel = SMS **AND HAS** `⭕️aiai-member-active✅` | `message_type = SMS` |
| `🔥MBR E2 - AI Inbox — Email Member Support` | Customer Replied | Reply Channel = Email **AND HAS** `⭕️aiai-member-active✅` | `message_type = Email` |

Both POST to: `https://ylppltmwueasbdexepip.supabase.co/functions/v1/ghl-member-agent`

### Edge Function Flow

```
1.  Validate body.location.id = ARMyDGKPbnem0Brkxpko
2.  Extract: contactId, channel (from message_type), messageBody
3.  Fetch GHL contact → firstName, tags, ⭕️Agency Role custom field
4.  Safety: confirm member tag present (failsafe — drop non-members)
5.  ESCALATION PRE-CHECK (keyword scan, no Claude call):
      if message matches escalation keywords → jump to step 10
6.  Fetch conversation history (ops.ai_inbox_conversation_memory, last 20 turns)
7.  Fetch KB docs in parallel:
      - Member Support KB (primary)
      - Products & Pricing
      - Events
8.  Claude Haiku: classify intent
      → onboarding | content | event | coaching | support | escalate
9.  Generate reply:
      onboarding/content/event/support → Claude Haiku (KB-grounded)
      coaching → hardcoded redirect (no Claude call)
      escalate → skip generation, go to step 10
10. ESCALATION FLOW (if triggered):
      a. Send acknowledgment to contact
      b. GHL tag: 👷needs-human-support
      c. GHL contact note (timestamp, reason, channel, role)
      d. Google Chat webhook → real-time Keyssa alert
11. Send reply via GHL API (email: html+subject+signature; SMS: plain text)
12. Log both turns to ops.ai_inbox_conversation_memory (intent: 'member_support')
13. Write to public.agent_signals (audit trail)
```

---

## Intent Categories

| Intent | What it covers | Response |
|---|---|---|
| `onboarding` | Login, Google Workspace setup, mastery.aiaimastermind.com access, password reset | Claude Haiku, KB-grounded |
| `content` | Workshop replays (IMM/SCMM/ATOM), module navigation, portal, recordings | Claude Haiku, KB-grounded |
| `event` | Event links, times, schedules, replay availability — member version | Claude Haiku, KB-grounded |
| `coaching` | Strategy/advice questions ("should I run X ads?") | Hardcoded: redirect to Thursday Mastermind Call or Extra Care Breakout |
| `support` | Weekly call schedule, benefits overview, DFY Setup vs DFY Package distinction | Claude Haiku, KB-grounded |
| `escalate` | Cancel, billing, refund, DFY full-service inquiry, frustrated, can't resolve, role-gated topic | Escalation flow |

---

## Escalation Triggers

### Keyword pre-check (fast path — before Claude)

Triggers on any of:
- `cancel`, `cancellation`, `leaving`, `quit`
- `refund`, `billing`, `charge`, `payment`, `invoice`
- `dispute`, `contract`, `legal`, `lawyer`, `lawsuit`
- `MAX package`, `MAYA package`, `ATOM package`, `done for you`, `full service`
- `locked out` (if can't resolve via standard answer)
- Frustration signals: `unacceptable`, `ridiculous`, `this is a scam`, `waste of money`

### Claude classification (nuanced escalation)

Intent classifier returns `escalate` when:
- Member is clearly upset beyond keyword matching
- Question requires human judgment (account-specific issues, billing disputes)
- Three-turn loop with no resolution (detected via history)

### Escalation Actions (all simultaneous)

1. **Contact receives:** *"Hi [Name], I want to make sure you get the right help on this. I've flagged your message for our team and someone will reach out shortly."*
2. **GHL tag:** `👷needs-human-support`
3. **GHL contact note:** `"👷 Member escalation — [timestamp]: [last message preview]. Channel: [sms/email]. Agency role: [role]."`
4. **Google Chat webhook:** `"🚨 Member needs human — [Name] ([role]) via [channel]: [message preview]"`

---

## Agency Role Gating

Read from GHL contact custom field `⭕️Agency Role`. Injected into system prompt.

| Role | Behavior |
|---|---|
| Agency Owner | Full access — all questions answered |
| Agency Manager | Billing/cancellation questions → escalate ("Billing changes are managed by your account owner.") |
| Team Member | Billing + team management questions → escalate |
| (blank / unknown) | Treat as Team Member (most restrictive) |

---

## Knowledge Base Documents

| Doc | Google Doc ID | Purpose |
|---|---|---|
| **Member Support KB** | `1h-qNxCg-UxNxg9nB4sW6ZPJkRnd-b3DFFFCVLTwLjFc` | Primary — canonical member answers, login help, portal nav, replay locations |
| Products & Pricing | `1pxqva2WAmeUKJ5nvWSdyiw33iMQrTV4DebXzBhyjXSE` | Benefits overview, DFY Setup vs DFY Package distinction |
| Events | `1Me-1NIW76SjjkV6WCVLOfXkuw_O36BCUE3sGdDkjBF8` | Active event info |

All fetched live per request via public export URL. No new secrets required.

---

## System Prompt Structure (member agent)

```
IDENTITY: You are Ai Phil — the AI assistant for AiAi Mastermind.
You are NOT Phillip himself. Never claim to be a real person.

ROLE: Member support. You help active members navigate the community,
find content, and get answers. You do NOT pitch or sell.

RULES:
- Never guess. If you don't know, escalate.
- Never discuss billing, cancellations, refunds, or legal matters.
- Never promise features, timelines, or commitments not in the KB.
- Coaching/strategy questions → redirect to Thursday call or Extra Care.
- Always use "Hi [Name]", never "Hey".
- SMS: plain text, under 160 chars. Email: short paragraphs + signature.

AGENCY ROLE: [role — injected per contact]
[role-specific restriction injected here]

MEMBER SUPPORT KB:
[fetched live]

PRODUCTS & PRICING:
[fetched live]

ACTIVE EVENTS:
[fetched live]

CONVERSATION HISTORY:
[last 20 turns from ops.ai_inbox_conversation_memory]
```

---

## Differences from `ghl-sales-agent`

| | `ghl-sales-agent` | `ghl-member-agent` |
|---|---|---|
| Audience | Prospects (no member tag) | Active members only |
| Tag filter | Does NOT have member tag | HAS member tag |
| Primary KB | Products + Events | Member Support KB + Products + Events |
| Intent routing | sales/event/support/unknown | onboarding/content/event/coaching/support/escalate |
| Agency role | Ignored | Read + gated |
| Escalation | unknown → Google Chat | keyword/AI → tag + note + real-time Keyssa alert |
| Coaching path | N/A | Hardcoded redirect, no Claude call |
| Follow-up queue | Yes (checkout link → 24/48/72hr) | No |
| Model | Sonnet (sales/event), Haiku (support) | Haiku throughout |
| Memory table | Same: `ops.ai_inbox_conversation_memory` | Same — shared with voice agent |

---

## Env Vars Required

All already set on the Supabase project — no new secrets:

| Var | Value |
|---|---|
| `SUPABASE_URL` | Already set |
| `SUPABASE_SERVICE_ROLE_KEY` | Already set |
| `GHL_API_KEY` | Already set |
| `ANTHROPIC_API_KEY` | Already set |
| `GOOGLE_CHAT_WEBHOOK_URL` | Already set |

New constant (hardcoded, not secret):
- `GHL_LOCATION_ID = ARMyDGKPbnem0Brkxpko`
- `MEMBER_SUPPORT_DOC_ID = 1h-qNxCg-UxNxg9nB4sW6ZPJkRnd-b3DFFFCVLTwLjFc`
- `PRODUCTS_PRICING_DOC_ID = 1pxqva2WAmeUKJ5nvWSdyiw33iMQrTV4DebXzBhyjXSE`
- `EVENTS_DOC_ID = 1Me-1NIW76SjjkV6WCVLOfXkuw_O36BCUE3sGdDkjBF8`

---

## URL & Brand Name Handling

### Text / Email channels
Use the URL as-is: `https://aiaimastermind.com`

### Voice channel (Ai Phil Voice — future)
The URL must be spelled out letter by letter so it sounds right when spoken:
> **"A - I - A - I - Mastermind dot com"**

❌ Never: "AyAy Mastermind" (sounds like a pirate expression)  
✅ Always: "A I A I Mastermind dot com" (four distinct letters, then Mastermind dot com)

This applies to every place Ai Phil Voice says the site name or URL — sign-up prompt, follow-up, any mention. This pronunciation rule should be in the Hume EVI system prompt and any voice-channel prompt.

---

## Future Integration: Ai Phil Voice

When Ai Phil Voice (Hume EVI + Twilio inbound GHL calls) is built:
- It reads from the **same** `ops.ai_inbox_conversation_memory` table
- A member who texted in gets recognized when they call — full thread available
- Ai Phil Voice has tool access to send SMS/email follow-ups from calls
- The member agent's `intent: 'member_support'` rows are visible cross-channel
- **Pronunciation rule:** always say "A I A I Mastermind dot com" — never "AyAy"

No schema changes needed — the shared memory architecture is already in place.

---

## Success Criteria

- [ ] Inbound SMS from active member triggers `ghl-member-agent` (not `ghl-sales-agent`)
- [ ] Claude correctly identifies intent and grounds answer in Member Support KB
- [ ] Agency role restriction applied (Manager can't get billing info)
- [ ] Escalation keyword triggers tag + note + Google Chat + acknowledgment (no AI reply)
- [ ] Coaching question returns redirect to Thursday call (not a made-up strategy answer)
- [ ] `ops.ai_inbox_conversation_memory` receives both user + assistant rows with `intent: 'member_support'`
- [ ] Email replies include Ai Phil signature block
- [ ] `agent_signals` row written on every inbound
