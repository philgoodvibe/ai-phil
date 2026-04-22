import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  buildSystemPrompt,
  containsBannedWord,
  type VoiceContext,
} from '../_shared/salesVoice.ts';
import {
  fetchRapport,
  extractRapport,
  storeRapport,
  mergeRapportFacts,
  recordExtraction,
  type ExtractResult,
  type ExtractStatus,
} from '../_shared/rapport.ts';
import { fetchCachedGoogleDoc } from '../_shared/kbCache.ts';
import { computeNextSendAt, classifyTouch } from './cadence.ts';
import { isWithinBusinessHours } from './businessHours.ts';

// ---------------------------------------------------------------------------
// Constants (non-secret — safe to hardcode)
// ---------------------------------------------------------------------------
const GHL_LOCATION_ID = 'ARMyDGKPbnem0Brkxpko';
const PRODUCTS_PRICING_DOC_ID = '1pxqva2WAmeUKJ5nvWSdyiw33iMQrTV4DebXzBhyjXSE';
const EVENTS_DOC_ID = '1Me-1NIW76SjjkV6WCVLOfXkuw_O36BCUE3sGdDkjBF8';
const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';
const NURTURE_END_TAG = '🔚ai-nurture-ended';
const MAX_ROWS_PER_RUN = 100;
const DUP_SEND_GUARD_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Supabase client (service role — bypasses RLS)
// ---------------------------------------------------------------------------
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Channel = 'sms' | 'email';

type QueueRow = {
  contact_id: string;
  conversation_id: string;
  channel: Channel;
  first_name: string | null;
  follow_up_number: number;
  next_send_at: string;
  created_at: string;
  last_sent_at: string | null;
};

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
// GHL API helpers (adapted from ghl-sales-agent)
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
      },
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
    return (data ?? []).reverse().map((row: { role: string; message: string }) => ({
      direction: (row.role === 'assistant' ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
      body: row.message,
    }));
  } catch (err) {
    console.error('[local-history] threw:', err);
    return [];
  }
}

async function sendGhlReply(
  contactId: string,
  replyText: string,
  channel: Channel,
): Promise<boolean> {
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
      },
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

// New helper — add a tag to a GHL contact. Non-fatal.
async function addGhlTag(contactId: string, tag: string): Promise<void> {
  const apiKey = Deno.env.get('GHL_API_KEY');
  if (!apiKey) {
    console.error('[ghl] cannot add tag — GHL_API_KEY missing');
    return;
  }
  try {
    const res = await fetch(
      `${GHL_API_BASE}/contacts/${contactId}/tags`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Version: GHL_API_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tags: [tag] }),
      },
    );
    if (!res.ok) {
      console.error(`[ghl] add tag ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error('[ghl] add tag threw:', err);
  }
}

// Strip markdown formatting — SMS doesn't render it, shows raw asterisks
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '$1') // **bold**
    .replace(/\*(.+?)\*/gs, '$1') // *italic*
    .replace(/__(.+?)__/gs, '$1') // __bold__
    .replace(/_(.+?)_/gs, '$1') // _italic_
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // `code` / ```blocks```
    .replace(/#{1,6}\s+/g, '') // # headers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [link](url) → link text
    .replace(/^\s*[-*+]\s+/gm, '• ') // bullet lists → •
    .replace(/\n{3,}/g, '\n\n') // collapse extra blank lines
    .trim();
}

// ---------------------------------------------------------------------------
// Claude Anthropic API
// ---------------------------------------------------------------------------
async function callClaude(
  model: string,
  maxTokens: number,
  system: string,
  userMessage: string,
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
// History formatter (verbatim from ghl-sales-agent)
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
// processRow — the per-row flow (spec §5.7 steps 3a-k)
// ---------------------------------------------------------------------------
async function processRow(row: QueueRow): Promise<void> {
  // Step 0: Idempotency guard — skip rows that got sent in the last hour.
  if (row.last_sent_at) {
    const lastSentMs = Date.parse(row.last_sent_at);
    if (!Number.isNaN(lastSentMs) && Date.now() - lastSentMs < DUP_SEND_GUARD_MS) {
      console.log(`[processRow] skip ${row.contact_id}: last_sent_at within guard window`);
      return;
    }
  }

  // Step a: Member-tag guard. Fetch GHL contact; if member, delete queue row + log.
  const contact = await fetchGhlContact(row.contact_id);
  const tags = contact?.tags ?? [];
  if (tags.some((t) => t.includes('aiai-member-active'))) {
    console.log(`[processRow] ${row.contact_id} is member — deleting queue row`);
    await supabase
      .schema('ops')
      .from('ai_inbox_followup_queue')
      .delete()
      .eq('contact_id', row.contact_id)
      .eq('conversation_id', row.conversation_id);
    await writeAgentSignal({
      source_agent: 'ghl-sales-followup',
      target_agent: 'quimby',
      signal_type: 'member-converted-skip-followup',
      status: 'delivered',
      channel: 'open',
      priority: 3,
      payload: {
        contact_id: row.contact_id,
        conversation_id: row.conversation_id,
        follow_up_number: row.follow_up_number,
      },
    });
    return;
  }

  // Step b: Fetch history from GHL, fallback to local ops memory.
  let history: GhlMessage[] = await fetchGhlConversationHistory(row.conversation_id);
  if (!history.length) {
    console.log(`[processRow] ${row.contact_id} GHL history empty — falling back to local memory`);
    history = await fetchLocalHistory(row.contact_id);
  }
  const historyStr = formatHistory(history);

  // Step c: Fetch rapport.
  const rapport = await fetchRapport(supabase, row.contact_id);

  // Step d: Determine voice context from follow_up_number.
  let voiceContext: VoiceContext;
  if (row.follow_up_number === 1) voiceContext = 'sales-followup-1';
  else if (row.follow_up_number === 2) voiceContext = 'sales-followup-2';
  else if (row.follow_up_number === 3) voiceContext = 'sales-followup-3';
  else voiceContext = 'sales-nurture';

  // Step e: Fetch KB docs (cached) + compose prompt.
  const [productsRes, eventsRes] = await Promise.allSettled([
    fetchCachedGoogleDoc(
      supabase,
      PRODUCTS_PRICING_DOC_ID,
      '(Products & pricing knowledge base temporarily unavailable.)',
    ),
    fetchCachedGoogleDoc(
      supabase,
      EVENTS_DOC_ID,
      '(Events knowledge base temporarily unavailable.)',
    ),
  ]);
  const productsKb = productsRes.status === 'fulfilled'
    ? productsRes.value
    : '(Products & pricing knowledge base temporarily unavailable.)';
  const eventsKb = eventsRes.status === 'fulfilled'
    ? eventsRes.value
    : '(Events knowledge base temporarily unavailable.)';

  const extras =
    `Products context:\n${productsKb}\n\nEvents context:\n${eventsKb}\n\nFollowup touch: #${row.follow_up_number}, channel=${row.channel}`;
  const systemPrompt = buildSystemPrompt(voiceContext, rapport, historyStr, extras);

  // Step e.continued: Call Sonnet. Synthetic trigger — not a real inbound message.
  const triggerMessage =
    `Please draft the next followup message for this contact. Touch #${row.follow_up_number}. Follow the voice doc and the context angle directive above.`;

  let replyText = '';
  try {
    replyText = await callClaude('claude-sonnet-4-6', 300, systemPrompt, triggerMessage);
  } catch (err) {
    console.error(`[processRow] ${row.contact_id} Claude failed — skipping row (will retry next tick):`, err);
    return; // do NOT update queue row; cron will retry
  }

  // Step f: Banned-word guardrail — one retry with correction, send anyway if still bad.
  if (containsBannedWord(replyText)) {
    console.warn(`[processRow] ${row.contact_id} banned word in first draft, retrying`);
    try {
      const retryPrompt = systemPrompt +
        '\n\nCRITICAL CORRECTION: Your previous draft contained a banned phrase from the BANNED_WORDS list. Rewrite without any banned vocabulary. Use Phillip\'s direct operator voice: specific numbers, real agency size/carrier/geography references, short sentences, no coach-speak.';
      const retried = await callClaude('claude-sonnet-4-6', 300, retryPrompt, triggerMessage);
      if (!containsBannedWord(retried)) {
        replyText = retried;
      } else {
        console.error(`[processRow] ${row.contact_id} banned word still present after retry, sending anyway`);
        await writeAgentSignal({
          source_agent: 'ghl-sales-followup',
          target_agent: 'quimby',
          signal_type: 'banned-word-after-retry',
          status: 'flagged',
          channel: 'open',
          priority: 2,
          payload: {
            contact_id: row.contact_id,
            conversation_id: row.conversation_id,
            follow_up_number: row.follow_up_number,
            reply_preview: replyText.substring(0, 300),
          },
        });
      }
    } catch (err) {
      console.error(`[processRow] ${row.contact_id} guardrail retry threw, sending original:`, err);
    }
  }

  // Step g: SMS — strip markdown + 480 cap. Then send via GHL.
  if (row.channel === 'sms') {
    replyText = stripMarkdown(replyText);
    if (replyText.length > 480) {
      replyText = replyText.substring(0, 477) + '...';
    }
  }

  const sendOk = await sendGhlReply(row.contact_id, replyText, row.channel);
  if (!sendOk) {
    console.error(`[processRow] ${row.contact_id} GHL send failed — not updating queue row (will retry next tick)`);
    return;
  }

  // Step h: Write assistant row to conversation memory.
  try {
    const { error } = await supabase
      .schema('ops')
      .from('ai_inbox_conversation_memory')
      .insert({
        contact_id: row.contact_id,
        conversation_id: row.conversation_id,
        channel: row.channel,
        role: 'assistant',
        message: replyText,
        intent: 'sales',
        stage: 'qualifying',
      });
    if (error) console.error('[memory] insert error:', error.message);
  } catch (err) {
    console.error('[memory] insert threw:', err);
  }

  // Step i: Extract rapport + audit (non-fatal). Outbound touch has no user
  // turn — extractor handles empty userMessage.
  try {
    const currentRapport = await fetchRapport(supabase, row.contact_id);
    const result = await extractRapport(
      { userMessage: '', assistantReply: replyText, conversationId: row.conversation_id },
      currentRapport,
      Deno.env.get('ANTHROPIC_API_KEY') ?? '',
    );
    const existingTotal =
      currentRapport.family.length + currentRapport.occupation.length +
      currentRapport.recreation.length + currentRapport.money.length;

    let mergedTotalWhenOk: number | undefined;
    let factsAddedWhenOk: number | undefined;
    if (result.status === 'ok') {
      const merged = mergeRapportFacts(currentRapport, result.facts);
      await storeRapport(supabase, row.contact_id, merged);
      mergedTotalWhenOk = merged.family.length + merged.occupation.length +
        merged.recreation.length + merged.money.length;
      factsAddedWhenOk = result.facts.family.length + result.facts.occupation.length +
        result.facts.recreation.length + result.facts.money.length;
    }

    await recordExtraction(
      supabase,
      followupAuditArgsFromResult(
        row.contact_id, row.conversation_id ?? null,
        existingTotal, result, mergedTotalWhenOk, factsAddedWhenOk,
      ),
    );
  } catch (err) {
    console.error('[rapport] followup extract/audit threw (non-fatal):', err);
  }

  // Step j: Update or delete queue row via cadence calculator.
  const result = computeNextSendAt(
    row.follow_up_number,
    new Date(row.created_at),
    new Date(),
  );

  if (result.action === 'advance') {
    try {
      const { error } = await supabase
        .schema('ops')
        .from('ai_inbox_followup_queue')
        .update({
          follow_up_number: result.followUpNumber,
          next_send_at: result.nextSendAt.toISOString(),
          last_sent_at: new Date().toISOString(),
        })
        .eq('contact_id', row.contact_id)
        .eq('conversation_id', row.conversation_id);
      if (error) console.error('[queue] advance update error:', error.message);
    } catch (err) {
      console.error('[queue] advance update threw:', err);
    }
  } else {
    // Final nurture touch — delete queue row + tag contact
    try {
      const { error } = await supabase
        .schema('ops')
        .from('ai_inbox_followup_queue')
        .delete()
        .eq('contact_id', row.contact_id)
        .eq('conversation_id', row.conversation_id);
      if (error) console.error('[queue] delete error:', error.message);
    } catch (err) {
      console.error('[queue] delete threw:', err);
    }
    await addGhlTag(row.contact_id, NURTURE_END_TAG);
  }

  // Step k: Audit signal.
  await writeAgentSignal({
    source_agent: 'ghl-sales-followup',
    target_agent: 'quimby',
    signal_type: 'followup-sent',
    status: 'delivered',
    channel: 'open',
    priority: 3,
    payload: {
      contact_id: row.contact_id,
      conversation_id: row.conversation_id,
      channel: row.channel,
      follow_up_number: row.follow_up_number,
      touch: classifyTouch(row.follow_up_number),
      reply_preview: replyText.substring(0, 200),
    },
  });
}

// ---------------------------------------------------------------------------
// followupAuditArgsFromResult — maps ExtractResult to recordExtraction args
// surface is pinned to 'ghl-sales-followup'
// ---------------------------------------------------------------------------

export function followupAuditArgsFromResult(
  contactId: string,
  conversationId: string | null,
  existingTotal: number,
  result: ExtractResult,
  mergedTotalWhenOk?: number,
  factsAddedWhenOk?: number,
): {
  contactId: string;
  conversationId: string | null;
  surface: 'ghl-sales-followup';
  status: ExtractStatus;
  factsAdded: number;
  factsTotalAfter: number;
  latencyMs: number;
  errorSnippet?: string;
} {
  const surface = 'ghl-sales-followup' as const;
  switch (result.status) {
    case 'ok':
      return { contactId, conversationId, surface, status: 'ok',
        factsAdded: factsAddedWhenOk ?? 0,
        factsTotalAfter: mergedTotalWhenOk ?? existingTotal,
        latencyMs: result.latencyMs };
    case 'empty':
      return { contactId, conversationId, surface, status: 'empty',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs };
    case 'http_error':
      return { contactId, conversationId, surface, status: 'http_error',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
        errorSnippet: `HTTP ${result.httpStatus}: ${result.error}` };
    case 'parse_error':
      return { contactId, conversationId, surface, status: 'parse_error',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
        errorSnippet: result.error };
    case 'no_api_key':
      return { contactId, conversationId, surface, status: 'no_api_key',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: 0 };
    case 'threw':
      return { contactId, conversationId, surface, status: 'threw',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: result.latencyMs,
        errorSnippet: result.error };
    case 'skipped_no_user_content':
      return { contactId, conversationId, surface, status: 'skipped_no_user_content',
        factsAdded: 0, factsTotalAfter: existingTotal, latencyMs: 0 };
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Auth: require Bearer token (cron passes the vault-stored anon key).
  const auth = req.headers.get('authorization') ?? req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ') || auth.length < 20) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Business-hours gate (Phase 0 Task 3, 2026-04-20).
  // Cron fires every hour Mon-Fri UTC (schedule `0 * * * 1-5`); the
  // helper gates on America/Los_Angeles local time, which is DST-aware.
  // Outside the window: log + return 200 gated; no queue read, no send.
  if (!isWithinBusinessHours()) {
    await writeAgentSignal({
      source_agent: 'ghl-sales-followup',
      target_agent: 'quimby',
      signal_type: 'ai-followup-gated',
      status: 'delivered',
      channel: 'open',
      priority: 3,
      payload: { gated: 'outside-business-hours' },
    });
    return new Response(
      JSON.stringify({ ok: true, gated: 'outside-business-hours' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Query due rows.
  const { data: dueRows, error } = await supabase
    .schema('ops')
    .from('ai_inbox_followup_queue')
    .select('*')
    .lte('next_send_at', new Date().toISOString())
    .lt('follow_up_number', 10)
    .order('next_send_at', { ascending: true })
    .limit(MAX_ROWS_PER_RUN);

  if (error) {
    console.error('[queue] query error:', error.message);
    return new Response(
      JSON.stringify({ error: 'Queue query failed', detail: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const rows = (dueRows ?? []) as QueueRow[];
  if (rows.length === MAX_ROWS_PER_RUN) {
    console.warn(`[queue] hit MAX_ROWS_PER_RUN (${MAX_ROWS_PER_RUN}) — backlog possible`);
  }

  let processed = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      await processRow(row);
      processed++;
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[processRow] ${row.contact_id} threw:`, msg);
      await writeAgentSignal({
        source_agent: 'ghl-sales-followup',
        target_agent: 'quimby',
        signal_type: 'followup-error',
        status: 'failed',
        channel: 'open',
        priority: 1,
        payload: {
          contact_id: row.contact_id,
          conversation_id: row.conversation_id,
          follow_up_number: row.follow_up_number,
          error: msg,
        },
      });
    }
  }

  return new Response(
    JSON.stringify({ ok: true, processed, errors, total_due: rows.length }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});
