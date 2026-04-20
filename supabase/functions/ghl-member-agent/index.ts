import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  AGENCY_BOUNDARIES_BLOCK,
  detectInjectionAttempt,
  SECURITY_REFUSAL_PRIMARY,
} from '../_shared/salesVoice.ts';

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
// Injection gate — pure helper for the regex detector
// ---------------------------------------------------------------------------
export interface InjectionGateResult {
  gated: boolean;
  pattern?: string;
}

/**
 * Pure wrapper around detectInjectionAttempt. Returns { gated: true, pattern }
 * on match, otherwise { gated: false }. Called by the handler BEFORE intent
 * classification to short-circuit the LLM call on prompt-injection /
 * data-exfiltration attempts. Member-agent is a higher-stakes surface
 * (verified Tier 2 users), so the gate prevents any member data (rapport,
 * course progress, resources) from being retrieved on a crafted payload.
 */
export function shouldGateInjection(messageBody: string): InjectionGateResult {
  const m = detectInjectionAttempt(messageBody);
  return m.matched ? { gated: true, pattern: m.pattern } : { gated: false };
}

// ---------------------------------------------------------------------------
// Supabase client (service role — bypasses RLS)
// Env fallbacks let `deno test` run without real credentials — the test
// suite only exercises pure functions and never hits Supabase.
// ---------------------------------------------------------------------------
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? 'http://localhost',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'test-key'
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

// ---------------------------------------------------------------------------
// stripTrailingSignature — pure helper
// ---------------------------------------------------------------------------
//
// Removes one-or-more trailing "-Ai Phil" signatures from a reply body before
// the SMS sanitizer appends the canonical signature. Necessary because Claude
// sometimes emits "-Ai Phil" inside the body when the system prompt leans on
// the signature example, producing a double-signed SMS like
// "message\n-Ai Phil\n-Ai Phil". Trailing-anchored so "Ai Phil helps you"
// in the middle of a body is preserved.

export function stripTrailingSignature(text: string): string {
  return text.replace(/(?:\s*-\s*Ai\s*Phil\s*)+$/i, '').trimEnd();
}

// ---------------------------------------------------------------------------
// resolveChannel — pure channel-resolution logic (exported for testing)
// ---------------------------------------------------------------------------
//
// Mirror of ghl-sales-agent's resolveChannel (intentionally duplicated — the
// two agents are kept self-contained so a bug in one doesn't cascade).
// Three-layer fallback:
//   1. Webhook rawMessageType (most authoritative)
//   2. Conversation lastMessageType (Fix A — covers webhooks that omit type)
//   3. Contact-shape (Fix B — email-only contact → email, even when 1 + 2 silent)
// Defaults to 'sms'. 'phone' is never selected (no auto-reply supported).

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
  'unacceptable', 'ridiculous', 'scam', 'waste of money',
];

export function matchesEscalationKeyword(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return ESCALATION_KEYWORDS.some(kw => {
    // Single-word keywords use word-boundary matching to avoid false positives
    // like "quit" matching inside "quite", or "leaving" inside "believing".
    // Multi-word phrases (contain a space) use substring match.
    if (!kw.includes(' ')) {
      return new RegExp(`\\b${kw}\\b`).test(lower);
    }
    return lower.includes(kw);
  });
}

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
  return role !== 'owner';
}

export function roleDescription(role: AgencyRole): string {
  switch (role) {
    case 'owner': return 'Agency Owner (full access)';
    case 'manager': return 'Agency Manager (billing changes managed by account owner)';
    case 'team_member': return 'Team Member (billing and team management managed by account owner)';
    case 'unknown': return 'Team Member (role unknown — most restrictive default applied)';
  }
}

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

// Exported for test coverage — do not change category names without updating parseIntent + VALID_INTENTS
export const CLASSIFIER_CATEGORY_DEFS = `onboarding = login, Google Workspace setup, mastery.aiaimastermind.com access, password reset, getting started
content = workshop replays (IMM/SCMM/ATOM), module navigation, portal, where to find recordings
event = event links, times, schedules, replay availability for a specific event
coaching = strategy or advice question (e.g., "should I run X ads?", "how do I price this?", "what offer should I build?")
support = logistical question, weekly call schedule, benefits overview, DFY Setup vs DFY Package distinction, identity/greeting, community questions (sharing work-in-progress, group Telegram norms, where to post for peer feedback, asking what other members think)
escalate = clearly upset beyond keyword matches, billing/cancellation/legal issue, account-specific problem requiring human judgment, or looping without resolution`;

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

// ---------------------------------------------------------------------------
// System prompt builders (member agent — KB-grounded)
// ---------------------------------------------------------------------------
const SHARED_IDENTITY = `IDENTITY: You are Ai Phil — the AI assistant for AiAi Mastermind. You are an AI, not Phillip himself. If asked who you are, say: "I'm Ai Phil, the AI assistant for AiAi Mastermind." Never claim to be Phillip Ngo or a real person. You DO have access to the conversation history below — never tell the member you can't see prior messages.`;

const SHARED_RULES = `RULES:
- Never guess. If you don't know, say so and offer to flag it for the team.
- Never discuss billing, cancellations, refunds, or legal matters — these are escalations.
- Never promise features, timelines, or commitments not in the knowledge base.
- Always use "Hi [Name]", never "Hey".
- SMS: plain text, under 472 characters (8 chars reserved for -Ai Phil sign-off). Email: short paragraphs, 3-4 sentences each.
- Do NOT use markdown formatting (no **bold**, no *italics*, no # headers) — SMS renders raw asterisks.`;

export function memberSupportPrompt(
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

Respond to the member's latest message. Use "Hi ${firstName || 'there'}". Channel: ${channel}. Keep it grounded in the KB — if the answer isn't there, say so and offer to flag it.

---

${AGENCY_BOUNDARIES_BLOCK}`;
}

// Hardcoded coaching redirect — no Claude call
function coachingRedirect(firstName: string): string {
  return `Hi ${firstName || 'there'}, great question — strategy and coaching-style questions are best answered live so Phillip can look at your specific situation. Bring this to the Thursday Mastermind Call, or book an Extra Care breakout for a deeper 1:1. Want me to flag it for the team to follow up?`;
}

// Escalation acknowledgment — hardcoded, no Claude call
function escalationAcknowledgment(firstName: string): string {
  return `Hi ${firstName || 'there'}, I want to make sure you get the right help on this. I've flagged your message for our team and someone will reach out shortly.`;
}

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
  // Defense-in-depth default — resolveChannel below sets the real value after
  // contact is fetched. Declared here so the fatal-catch block can reference it.
  let channel: Channel = 'sms';
  let conversationLookupChannel: Channel | null = null;

  if (!contactId || !messageBody) {
    console.error('[extract] missing required fields', { contactId, conversationId, hasMessage: !!messageBody });
    return new Response(
      JSON.stringify({ error: 'Missing required fields', contactId, conversationId, hasMessage: !!messageBody }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Resolve conversationId + capture suggestedChannel for Fix A.
  // Run whenever type is missing (rawMessageType null) OR conversationId absent —
  // this is the core of Fix A: previously lookup only ran when !conversationId,
  // so a webhook with conversationId but no message_type would skip the lookup
  // entirely and default to 'sms' even for email inbounds.
  if (!rawMessageType || !conversationId) {
    const lookup = await lookupConversation(contactId);
    if (!conversationId) {
      // conversationId is required to fetch history — hard fail if we can't resolve it
      if (!lookup) {
        console.error('[extract] could not resolve conversationId for contact', contactId);
        return new Response(
          JSON.stringify({ error: 'Could not resolve conversationId', contactId }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      conversationId = lookup.id;
    }
    if (lookup) {
      conversationLookupChannel = lookup.suggestedChannel;
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

    // Resolve the outbound channel now that we have the contact shape.
    // resolveChannel applies three-layer fallback: webhook type → conversation
    // lookup (Fix A) → contact shape (Fix B: email-only → email). 'phone' is
    // never selected (no auto-reply supported).
    channel = resolveChannel({
      rawMessageType,
      conversationLookupChannel,
      contact: { email: contact?.email, phone: contact?.phone },
    }).channel;

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

    // Step 4.5: Injection gate — mirror ghl-sales-agent. Member-agent is a
    // higher-stakes surface (verified Tier 2 users), so injection attempts
    // must short-circuit BEFORE intent classification, KB fetches, or any
    // path that could retrieve member data. Per AI-Phil-Security-Boundaries.md
    // §3: no per-attempt alerting (leaks detection timing); rollup at 3-in-24h.
    const injectionGate = shouldGateInjection(messageBody);
    if (injectionGate.gated) {
      console.log(`[injection-attempt] pattern=${injectionGate.pattern} contact=${contactId}`);

      let rollupCount = 0;
      try {
        const { count } = await supabase
          .schema('ops')
          .from('injection_attempts')
          .select('id', { count: 'exact', head: true })
          .eq('contact_id', contactId)
          .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
        rollupCount = count ?? 0;
      } catch (err) {
        console.error('[injection-attempt] rollup count query failed:', err);
      }

      try {
        const { error } = await supabase.schema('ops').from('injection_attempts').insert({
          contact_id: contactId,
          surface: 'ghl-member-agent',
          attempt_pattern: injectionGate.pattern,
          message_preview: messageBody.substring(0, 500),
          model_response: SECURITY_REFUSAL_PRIMARY,
        });
        if (error) console.error('[injection-attempt] audit insert error:', error.message);
      } catch (err) {
        console.error('[injection-attempt] audit insert threw:', err);
      }

      // Member-agent SMS rule: all SMS replies end with -Ai Phil signature.
      const refusalText = channel === 'sms'
        ? `${SECURITY_REFUSAL_PRIMARY}\n-Ai Phil`
        : SECURITY_REFUSAL_PRIMARY;
      const sendOk = await sendGhlReply(contactId, refusalText, channel);

      if (rollupCount >= 2) {
        await writeAgentSignal({
          source_agent: 'ghl-member-agent',
          target_agent: 'richie-cc2',
          signal_type: 'injection-attempt-rollup',
          status: 'delivered',
          channel: 'open',
          priority: 1,
          payload: {
            contact_id: contactId,
            attempt_count_last_24h: rollupCount + 1,
            latest_pattern: injectionGate.pattern,
            surface: 'ghl-member-agent',
          },
        });
        await postGoogleChatAlert(`AI Phil injection-attempt rollup trip-wire
Contact: ${contactId}
Attempts in last 24h: ${rollupCount + 1}
Latest pattern: ${injectionGate.pattern}
Surface: ghl-member-agent`);
      }

      return new Response(
        JSON.stringify({ ok: true, gated: 'injection-attempt', pattern: injectionGate.pattern, sent: sendOk }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Step 5: Escalation keyword pre-check — fast path, no Claude
    const keywordEscalation = matchesEscalationKeyword(messageBody);

    // Step 6: Role-gated billing pre-check (also cheap — pure regex)
    const billingLikely = /\b(bill|charge|refund|payment|invoice|subscription|plan|upgrade|downgrade)\b/i.test(messageBody);
    const forcedEscalation = keywordEscalation || (roleBlocksBilling(role) && billingLikely);

    // Step 7: Intent + KB fetch
    // When forcedEscalation is true the reply is hardcoded — skip KB fetches (saves ~200-400ms)
    // and skip the Claude classifier call. Otherwise fetch KBs in parallel WITH the classifier.
    let intent: Intent;
    let memberKb = '(Member Support KB temporarily unavailable.)';
    let productsKb = '(Products & Pricing KB temporarily unavailable.)';
    let eventsKb = '(Events KB temporarily unavailable.)';

    if (forcedEscalation) {
      intent = 'escalate';
    } else {
      const [intentResult, memberKbRes, productsRes, eventsRes] = await Promise.allSettled([
        classifyMemberIntent(messageBody, role),
        fetchGoogleDoc(MEMBER_SUPPORT_DOC_ID, memberKb),
        fetchGoogleDoc(PRODUCTS_PRICING_DOC_ID, productsKb),
        fetchGoogleDoc(EVENTS_DOC_ID, eventsKb),
      ]);
      intent = intentResult.status === 'fulfilled' ? intentResult.value : 'support';
      if (memberKbRes.status === 'fulfilled') memberKb = memberKbRes.value;
      if (productsRes.status === 'fulfilled') productsKb = productsRes.value;
      if (eventsRes.status === 'fulfilled') eventsKb = eventsRes.value;
    }

    const finalIntent: Intent = intent;

    // Step 8: Generate reply based on intent
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
        handledAsEscalation = true;
      }
    }

    // Sanitize for SMS and append signature in one pass so the total stays ≤ 480 chars
    if (channel === 'sms') {
      const SMS_SIGNATURE = '\n-Ai Phil';
      const SMS_LIMIT = 480;
      const maxBody = SMS_LIMIT - SMS_SIGNATURE.length; // 472
      replyText = stripMarkdown(replyText);
      replyText = stripTrailingSignature(replyText);
      if (replyText.length > maxBody) replyText = replyText.substring(0, maxBody - 3) + '...';
      replyText = replyText + SMS_SIGNATURE;
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
        phone_redacted: phone ? `***${phone.slice(-4)}` : null,
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
