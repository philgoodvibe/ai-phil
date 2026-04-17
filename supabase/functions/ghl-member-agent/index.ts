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

// Stub handler — replaced in Task 11
Deno.serve(async (_req: Request) => {
  return new Response('ghl-member-agent scaffold', { status: 200 });
});
