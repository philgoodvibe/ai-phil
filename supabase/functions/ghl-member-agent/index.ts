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

// Stub handler — replaced in Task 10
Deno.serve(async (_req: Request) => {
  return new Response('ghl-member-agent scaffold', { status: 200 });
});
