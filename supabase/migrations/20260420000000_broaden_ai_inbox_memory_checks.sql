-- Phase 0 Task 2 — broaden ai_inbox_conversation_memory CHECK constraints.
--
-- Member-agent (shipped 2026-04-16) has been silently failing every insert
-- because its intent='member_support' and stage ∈ {onboarding,content,event,
-- coaching,support,escalate} both violate the sales-funnel-only CHECK
-- constraints originally defined for sales-agent use.
--
-- Fix: widen intent to accept the member sub-state taxonomy, widen stage to
-- accept a single literal 'member' value. Member sub-state lives in the
-- intent column. Downstream analytics MUST filter by stage=='member' first
-- before aggregating by intent to avoid conflating prospect-support with
-- member-support.

alter table ops.ai_inbox_conversation_memory
  drop constraint ai_inbox_conversation_memory_intent_check;

alter table ops.ai_inbox_conversation_memory
  add constraint ai_inbox_conversation_memory_intent_check
  check (intent = any (array[
    'sales','event','support','unknown',
    'onboarding','content','coaching','escalate'
  ]));

alter table ops.ai_inbox_conversation_memory
  drop constraint ai_inbox_conversation_memory_stage_check;

alter table ops.ai_inbox_conversation_memory
  add constraint ai_inbox_conversation_memory_stage_check
  check (stage = any (array[
    'qualifying','presenting','objection','closed','nurture',
    'member'
  ]));

comment on column ops.ai_inbox_conversation_memory.intent is
  'Per-surface intent vocabulary. Sales-agent writes one of '
  '{sales,event,support,unknown}. Member-agent writes one of '
  '{onboarding,content,event,coaching,support,escalate}. '
  'event/support overlap between both surfaces — use stage to disambiguate: '
  'stage=''member'' means the row originated from the member-agent surface.';

comment on column ops.ai_inbox_conversation_memory.stage is
  'Conversation stage. Sales-agent writes one of '
  '{qualifying,presenting,objection,closed,nurture} (the sales-funnel taxonomy). '
  'Member-agent writes the literal ''member'' — member sub-state lives in '
  'the intent column. Downstream analytics MUST filter by stage before '
  'aggregating by intent to avoid conflating prospect-support with '
  'member-support.';
