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
  return ESCALATION_KEYWORDS.some(kw => lower.includes(kw));
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

// Stub handler — replaced in Task 11
Deno.serve(async (_req: Request) => {
  return new Response('ghl-member-agent scaffold', { status: 200 });
});
