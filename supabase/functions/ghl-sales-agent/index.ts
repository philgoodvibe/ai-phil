import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildSystemPrompt, containsBannedWord, type VoiceContext } from '../_shared/salesVoice.ts';
import { fetchRapport, extractRapport, storeRapport, mergeRapportFacts } from '../_shared/rapport.ts';
import { fetchCachedGoogleDoc } from '../_shared/kbCache.ts';

// ---------------------------------------------------------------------------
// Constants (non-secret — safe to hardcode)
// ---------------------------------------------------------------------------
const GHL_LOCATION_ID = 'ARMyDGKPbnem0Brkxpko';
const PRODUCTS_PRICING_DOC_ID = '1pxqva2WAmeUKJ5nvWSdyiw33iMQrTV4DebXzBhyjXSE';
const EVENTS_DOC_ID = '1Me-1NIW76SjjkV6WCVLOfXkuw_O36BCUE3sGdDkjBF8';
const CHECKOUT_URL = 'https://aiaimastermind.com';
const MEMBER_TAG = '⭕️aiai-member-active✅';
const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

// GHL numeric -> string message types (from ghl-message-receiver)
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
type Intent = 'sales' | 'event' | 'support' | 'unknown';
type Channel = 'sms' | 'email' | 'phone';

interface GhlContact {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  phone?: string;
  email?: string;
  tags?: string[];
}

interface GhlMessage {
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
// Webhook body extractors (verbatim from ghl-message-receiver)
// ---------------------------------------------------------------------------
function extractMessageBody(body: Record<string, unknown>): string | null {
  if (body.message && typeof body.message === 'object' && (body.message as Record<string, unknown>).body) {
    return String((body.message as Record<string, unknown>).body);
  }
  if (body.message_body && typeof body.message_body === 'string') return body.message_body;
  if (body.message && typeof body.message === 'string') return body.message;
  if (body.last_message && typeof body.last_message === 'string') return body.last_message;
  return null;
}

// Returns null when message type is genuinely absent from the webhook
// (caller must not override an explicitly-typed channel in that case)
function extractMessageType(body: Record<string, unknown>): string | null {
  if (body.message && typeof body.message === 'object' && (body.message as Record<string, unknown>).type) {
    const t = (body.message as Record<string, unknown>).type as number;
    return GHL_MESSAGE_TYPES[t] || String(t);
  }
  if (body.message_type && typeof body.message_type === 'string') return body.message_type;
  if (body.type && typeof body.type === 'string') return body.type;
  return null; // truly absent — do not override an already-known channel
}

function normalizeChannel(messageType: string): Channel {
  const t = messageType.toLowerCase();
  if (t === 'email') return 'email';
  if (t === 'calls' || t === 'phone') return 'phone';
  return 'sms';
}

function extractContactId(body: Record<string, unknown>): string | null {
  if (body.contact_id && typeof body.contact_id === 'string') return body.contact_id;
  if (body.contactId && typeof body.contactId === 'string') return body.contactId;
  if (body.contact && typeof body.contact === 'object' && (body.contact as Record<string, unknown>).id) {
    return String((body.contact as Record<string, unknown>).id);
  }
  return null;
}

function extractConversationId(body: Record<string, unknown>): string | null {
  if (body.conversation_id && typeof body.conversation_id === 'string') return body.conversation_id;
  if (body.conversationId && typeof body.conversationId === 'string') return body.conversationId;
  if (body.conversation && typeof body.conversation === 'object' && (body.conversation as Record<string, unknown>).id) {
    return String((body.conversation as Record<string, unknown>).id);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Non-fatal agent_signals writer
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
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: GHL_API_VERSION,
      },
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
    // Prefer email-type conversations: when the webhook doesn't tell us the channel (rawMessageType=null),
    // we need to infer it from the conversation type. Email conversations have type containing 'EMAIL'.
    // Preferring them over recency ensures email inbounds get routed back as email.
    const emailConvo = convos.find(c => (c.type ?? '').toUpperCase().includes('EMAIL'));
    const nonPhoneConvo = convos.find(c => !phoneTypes.has(c.type ?? ''));
    const chosen = emailConvo ?? nonPhoneConvo ?? convos[0] ?? null;
    if (!chosen) return null;

    // Infer channel from the conversation's TYPE first (most reliable), then lastMessageType
    const ct = (chosen.type ?? '').toUpperCase();
    const lmt = (chosen.lastMessageType ?? '').toUpperCase();
    const suggestedChannel: Channel | null =
      ct.includes('EMAIL') || lmt.includes('EMAIL') ? 'email' :
      (phoneTypes.has(ct) || lmt.includes('CALL') || lmt.includes('IVR') || lmt.includes('PHONE')) ? 'phone' :
      'sms';

    console.log(`[ghl] resolved conversationId ${chosen.id} (lastMessageType: ${chosen.lastMessageType}, suggestedChannel: ${suggestedChannel})`);
    return { id: chosen.id, suggestedChannel };
  } catch (err) {
    console.error('[ghl] conversation lookup threw:', err);
    return null;
  }
}

// Read conversation history from our own ops table (fallback when GHL returns nothing)
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
    // Reverse so oldest-first (matches GHL convention)
    return (data ?? []).reverse().map(row => ({
      direction: (row.role === 'assistant' ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
      body: row.message as string,
    }));
  } catch (err) {
    console.error('[local-history] threw:', err);
    return [];
  }
}

// Strip markdown formatting — SMS doesn't render it, shows raw asterisks
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '$1')   // **bold**
    .replace(/\*(.+?)\*/gs, '$1')        // *italic*
    .replace(/__(.+?)__/gs, '$1')        // __bold__
    .replace(/_(.+?)_/gs, '$1')          // _italic_
    .replace(/`{1,3}[^`]*`{1,3}/g, '')  // `code` / ```blocks```
    .replace(/#{1,6}\s+/g, '')           // # headers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [link](url) → link text
    .replace(/^\s*[-*+]\s+/gm, '• ')    // bullet lists → •
    .replace(/\n{3,}/g, '\n\n')          // collapse extra blank lines
    .trim();
}

async function fetchGhlConversationHistory(conversationId: string): Promise<GhlMessage[]> {
  const apiKey = Deno.env.get('GHL_API_KEY');
  if (!apiKey) return [];
  try {
    const res = await fetch(
      `${GHL_API_BASE}/conversations/${conversationId}/messages?limit=20`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Version: GHL_API_VERSION,
        },
      }
    );
    if (!res.ok) {
      console.error(`[ghl] history fetch ${res.status}: ${await res.text()}`);
      return [];
    }
    const data = await res.json() as { messages?: { messages?: GhlMessage[] } };
    const msgs = data.messages?.messages ?? [];
    // API returns newest-first; reverse to chronological
    return [...msgs].reverse();
  } catch (err) {
    console.error('[ghl] history fetch threw:', err);
    return [];
  }
}

async function sendGhlReply(
  contactId: string,
  replyText: string,
  channel: Channel
): Promise<boolean> {
  if (channel === 'phone') {
    console.log('[ghl] skipping reply for phone/calls channel — no auto-reply supported');
    return false;
  }
  const apiKey = Deno.env.get('GHL_API_KEY');
  if (!apiKey) {
    console.error('[ghl] cannot send reply — GHL_API_KEY missing');
    return false;
  }
  const ghlType = channel === 'email' ? 'Email' : 'SMS';

  // Email requires `html` + `subject`; SMS uses `message` (plain text)
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
    : {
        type: ghlType,
        contactId,
        message: replyText,
      };

  try {
    const res = await fetch(
      `${GHL_API_BASE}/conversations/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Version: GHL_API_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );
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
async function classifyIntent(messageBody: string, tags: string[]): Promise<Intent> {
  const system = 'You are a message router. Reply with exactly one word only: sales, event, support, or unknown. No punctuation, no explanation.';
  const user = `Classify this inbound message intent.

Contact tags: ${tags.join(', ') || 'none'}
Message: "${messageBody}"

sales = interested in joining the membership or program
event = asking about a specific webinar, challenge, or promo event
support = logistical question unrelated to joining or an event
unknown = cannot determine

Reply with one word:`;

  try {
    const raw = await callClaude('claude-haiku-4-5-20251001', 10, system, user);
    const cleaned = raw.toLowerCase().replace(/[^a-z]/g, '');
    if (cleaned === 'sales' || cleaned === 'event' || cleaned === 'support' || cleaned === 'unknown') {
      return cleaned;
    }
    console.error(`[classify] invalid output "${raw}" — defaulting to unknown`);
    return 'unknown';
  } catch (err) {
    console.error('[classify] threw:', err);
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
function formatHistory(history: GhlMessage[]): string {
  if (!history.length) return '(no prior messages)';
  return history
    .filter((m) => typeof m.body === 'string' && m.body.trim().length > 0)
    .map((m) => {
      const speaker = m.direction === 'outbound' ? 'AI' : 'PROSPECT';
      return `${speaker}: ${m.body}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Google Chat alert (non-fatal)
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
  const locationId: string | null =
    (body.location && typeof body.location === 'object' && (body.location as Record<string, unknown>).id)
      ? String((body.location as Record<string, unknown>).id)
      : body.location_id ? String(body.location_id) : null;

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
  // null means webhook did not include a message type — don't override an explicitly-typed channel
  const rawMessageType = extractMessageType(body);
  const messageType = rawMessageType ?? 'SMS'; // for logging only
  let channel = rawMessageType ? normalizeChannel(rawMessageType) : 'sms';

  if (!contactId || !messageBody) {
    console.error('[extract] missing required fields', { contactId, conversationId, hasMessage: !!messageBody });
    return new Response(
      JSON.stringify({ error: 'Missing required fields', contactId, conversationId, hasMessage: !!messageBody }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // GHL workflow webhooks often omit conversationId — look it up if missing
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
    // Only use lookup's channel hint when the webhook gave us NO message type.
    // If rawMessageType is set (e.g. 'Email'), we trust it — do not clobber with lookup.
    if (!rawMessageType && lookup.suggestedChannel && lookup.suggestedChannel !== 'phone') {
      console.log(`[extract] channel override: ${channel} → ${lookup.suggestedChannel} (from conversation lastMessageType)`);
      channel = lookup.suggestedChannel;
    } else if (rawMessageType) {
      console.log(`[extract] keeping webhook channel: ${channel} (rawMessageType=${rawMessageType})`);
    }
  }

  try {
    // Step 3+4 in parallel: Fetch contact and conversation history simultaneously
    const [contactResult, historyResult] = await Promise.allSettled([
      fetchGhlContact(contactId),
      fetchGhlConversationHistory(conversationId),
    ]);

    const contact = contactResult.status === 'fulfilled' ? contactResult.value : null;
    const tags = contact?.tags ?? [];

    if (tags.some(t => t.includes('aiai-member-active'))) {
      await writeAgentSignal({
        source_agent: 'ghl-sales-agent',
        target_agent: 'richie-cc2',
        signal_type: 'member-contact-received',
        status: 'delivered',
        channel: 'open',
        priority: 3,
        payload: {
          contact_id: contactId,
          conversation_id: conversationId,
          channel,
          message_preview: messageBody.substring(0, 200),
          note: 'Member detected — Phase 2 routing deferred',
        },
      });
      return new Response(
        JSON.stringify({ ok: true, skipped: 'member' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const safeContact: GhlContact = contact ?? { id: contactId, tags: [] };
    const firstName = safeContact.firstName ?? '';
    const lastName = safeContact.lastName ?? '';
    const phone = safeContact.phone ?? '';

    // History from parallel fetch (historyResult already settled)
    let history: GhlMessage[] = [];
    if (historyResult.status === 'fulfilled') {
      history = historyResult.value;
    } else {
      console.error('[history] parallel fetch failed:', historyResult.reason);
    }
    // GHL history can be empty on first contact or if conversation ID changed.
    // Fall back to our own ops table which stores every message regardless of channel/conversation.
    if (!history.length) {
      console.log('[history] GHL returned empty — falling back to local conversation memory');
      history = await fetchLocalHistory(contactId);
      console.log(`[history] local memory returned ${history.length} messages`);
    }
    const historyStr = formatHistory(history);

    // Step 5: Fetch KB docs in parallel (graceful fallback)
    const [productsRes, eventsRes] = await Promise.allSettled([
      fetchCachedGoogleDoc(supabase, PRODUCTS_PRICING_DOC_ID, '(Products & pricing knowledge base temporarily unavailable.)'),
      fetchCachedGoogleDoc(supabase, EVENTS_DOC_ID, '(Events knowledge base temporarily unavailable.)'),
    ]);
    const productsKb = productsRes.status === 'fulfilled'
      ? productsRes.value
      : '(Products & pricing knowledge base temporarily unavailable.)';
    const eventsKb = eventsRes.status === 'fulfilled'
      ? eventsRes.value
      : '(Events knowledge base temporarily unavailable.)';

    // Step 6: Classify intent
    const intent: Intent = await classifyIntent(messageBody, tags);

    // Step 7: Generate reply — unified through _shared/salesVoice
    let replyText = '';
    let modelUsed = '';

    // Fetch rapport before composing prompt
    const rapport = await fetchRapport(supabase, contactId);

    let voiceContext: VoiceContext;
    if (intent === 'sales')        { voiceContext = 'sales-live'; modelUsed = 'claude-sonnet-4-6'; }
    else if (intent === 'event')   { voiceContext = 'event';      modelUsed = 'claude-sonnet-4-6'; }
    else if (intent === 'support') { voiceContext = 'support';    modelUsed = 'claude-haiku-4-5-20251001'; }
    else                           { voiceContext = 'unknown';    modelUsed = 'claude-haiku-4-5-20251001'; }

    const extras = `Products context:\n${productsKb}\n\nEvents context:\n${eventsKb}\n\nContact: ${firstName} ${lastName}, channel=${channel}`;
    const systemPrompt = buildSystemPrompt(voiceContext, rapport, historyStr, extras);

    try {
      replyText = await callClaude(modelUsed, intent === 'support' ? 200 : 300, systemPrompt, messageBody);
    } catch (err) {
      console.error('[generate] Claude failed:', err);
      replyText = `Hi ${firstName || 'there'}, I'm Ai Phil, the AI assistant for AiAi Mastermind. I'm here to help with questions about the membership, events, or how AI can help your business. What's on your mind?`;
      modelUsed = 'fallback';
    }

    // Banned-word guardrail: one retry with correction, then send anyway
    if (containsBannedWord(replyText)) {
      console.warn('[guardrail] banned word detected in first draft, retrying');
      try {
        const retryPrompt = systemPrompt + '\n\nCRITICAL CORRECTION: Your previous draft contained a banned phrase from the BANNED_WORDS list. Rewrite without any banned vocabulary. Use Phillip\'s direct operator voice: specific numbers, real agency size/carrier/geography references, short sentences, no coach-speak.';
        const retried = await callClaude(modelUsed, intent === 'support' ? 200 : 300, retryPrompt, messageBody);
        if (!containsBannedWord(retried)) {
          replyText = retried;
        } else {
          console.error('[guardrail] banned word still present after retry, sending anyway, flagging for review');
          await writeAgentSignal({
            source_agent: 'ghl-sales-agent',
            target_agent: 'richie-cc2',
            signal_type: 'banned-word-after-retry',
            status: 'flagged',
            channel: 'open',
            priority: 2,
            payload: { contact_id: contactId, reply_preview: replyText.substring(0, 300) },
          });
        }
      } catch (err) {
        console.error('[guardrail] retry threw, sending original:', err);
      }
    }

    // Strip markdown and enforce length cap for SMS
    if (channel === 'sms') {
      replyText = stripMarkdown(replyText);
      if (replyText.length > 480) {
        replyText = replyText.substring(0, 477) + '...';
      }
    }

    // Step 8: Send reply via GHL BEFORE any DB writes
    const sendOk = await sendGhlReply(contactId, replyText, channel);

    // Step 9: Log conversation memory (both rows)
    try {
      const { error } = await supabase.schema('ops').from('ai_inbox_conversation_memory').insert([
        {
          contact_id: contactId,
          conversation_id: conversationId,
          channel,
          role: 'user',
          message: messageBody,
          intent,
          stage: 'qualifying',
        },
        {
          contact_id: contactId,
          conversation_id: conversationId,
          channel,
          role: 'assistant',
          message: replyText,
          intent,
          stage: 'qualifying',
        },
      ]);
      if (error) console.error('[memory] insert error:', error.message);
    } catch (err) {
      console.error('[memory] insert threw:', err);
    }

    // Step 9b: Post-conversation F.O.R.M. extraction (non-fatal)
    try {
      const currentRapport = await fetchRapport(supabase, contactId);
      const newFacts = await extractRapport(
        { userMessage: messageBody, assistantReply: replyText, conversationId: conversationId ?? undefined },
        currentRapport,
        Deno.env.get('ANTHROPIC_API_KEY') ?? '',
      );
      if (Object.values(newFacts).some((arr) => arr.length > 0)) {
        const merged = mergeRapportFacts(currentRapport, newFacts);
        await storeRapport(supabase, contactId, merged);
      }
    } catch (err) {
      console.error('[rapport] extract threw (non-fatal):', err);
    }

    // Step 10: Checkout URL in reply → upsert follow-up queue (ignore duplicates)
    if (replyText.includes(CHECKOUT_URL) && (channel === 'sms' || channel === 'email')) {
      try {
        const { error } = await supabase.schema('ops').from('ai_inbox_followup_queue').upsert(
          {
            contact_id: contactId,
            conversation_id: conversationId,
            channel,
            first_name: firstName || null,
            follow_up_number: 1,
            next_send_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          },
          { onConflict: 'contact_id,conversation_id', ignoreDuplicates: true }
        );
        if (error) console.error('[followup] upsert error:', error.message);
      } catch (err) {
        console.error('[followup] upsert threw:', err);
      }
    }

    // Step 11: Unknown intent — Google Chat alert + open_tickets
    if (intent === 'unknown') {
      const contactName = `${firstName} ${lastName}`.trim();
      const alertText = `AI Phil unknown-intent inbound
Contact: ${contactName || contactId} (${phone || 'no phone'})
Channel: ${channel}
Message: ${messageBody.substring(0, 500)}
Conversation: ${conversationId}`;
      await postGoogleChatAlert(alertText);

      try {
        const { error } = await supabase.schema('ops').from('open_tickets').insert({
          sync_source: 'ghl-sales-agent',
          channel: `ghl-${channel}`,
          contact_name: contactName || null,
          contact_phone: phone || null,
          raw_message_snippet: messageBody.substring(0, 500),
          category: 'unknown-intent',
          conversation_id: conversationId,
          status: 'Open',
        });
        if (error) console.error('[open_tickets] insert error:', error.message);
      } catch (err) {
        console.error('[open_tickets] insert threw:', err);
      }
    }

    // Step 12: Audit signal
    await writeAgentSignal({
      source_agent: 'ghl-sales-agent',
      target_agent: 'richie-cc2',
      signal_type: sendOk ? 'ai-sales-reply-sent' : 'ai-sales-error',
      status: sendOk ? 'delivered' : 'failed',
      channel: 'open',
      priority: sendOk ? 3 : 1,
      payload: {
        contact_id: contactId,
        conversation_id: conversationId,
        channel,
        intent,
        model: modelUsed,
        message_preview: messageBody.substring(0, 200),
        reply_preview: replyText.substring(0, 200),
        send_ok: sendOk,
      },
    });

    return new Response(
      JSON.stringify({ ok: true, intent, sent: sendOk }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[fatal] handler threw:', err);
    const msg = err instanceof Error ? err.message : String(err);
    await writeAgentSignal({
      source_agent: 'ghl-sales-agent',
      target_agent: 'richie-cc2',
      signal_type: 'ai-sales-error',
      status: 'failed',
      channel: 'open',
      priority: 1,
      payload: {
        contact_id: contactId,
        conversation_id: conversationId,
        channel,
        error: msg,
      },
    });
    return new Response(
      JSON.stringify({ error: 'Internal error', detail: msg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
