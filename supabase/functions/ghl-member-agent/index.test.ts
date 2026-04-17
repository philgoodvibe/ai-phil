import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveChannel, memberSupportPrompt } from './index.ts';

Deno.test('member-agent resolveChannel: webhook rawMessageType wins', () => {
  const out = resolveChannel({
    rawMessageType: 'Email',
    conversationLookupChannel: 'sms',
    contact: { email: 'a@b.com', phone: '+1234' },
  });
  assertEquals(out.channel, 'email');
  assertEquals(out.source, 'webhook');
});

Deno.test('member-agent resolveChannel: null rawMessageType → conversation lookup (Fix A)', () => {
  const out = resolveChannel({
    rawMessageType: null,
    conversationLookupChannel: 'email',
    contact: { email: 'a@b.com', phone: '+1234' },
  });
  assertEquals(out.channel, 'email');
  assertEquals(out.source, 'conversation-lookup');
});

Deno.test('member-agent resolveChannel: null + null + email-only → email (Fix B)', () => {
  const out = resolveChannel({
    rawMessageType: null,
    conversationLookupChannel: null,
    contact: { email: 'a@b.com', phone: '' },
  });
  assertEquals(out.channel, 'email');
  assertEquals(out.source, 'contact-shape');
});

Deno.test('member-agent resolveChannel: null + null + phone-only → sms default', () => {
  const out = resolveChannel({
    rawMessageType: null,
    conversationLookupChannel: null,
    contact: { email: '', phone: '+1234' },
  });
  assertEquals(out.channel, 'sms');
  assertEquals(out.source, 'default');
});

Deno.test('member-agent resolveChannel: lookup=phone + email-present → email (phone never auto-replies)', () => {
  const out = resolveChannel({
    rawMessageType: null,
    conversationLookupChannel: 'phone',
    contact: { email: 'a@b.com', phone: '+1234' },
  });
  assertEquals(out.channel, 'email');
  assertEquals(out.source, 'contact-shape');
});

Deno.test('member-agent resolveChannel: null + null + both empty → sms default', () => {
  const out = resolveChannel({
    rawMessageType: null,
    conversationLookupChannel: null,
    contact: { email: '', phone: '' },
  });
  assertEquals(out.channel, 'sms');
  assertEquals(out.source, 'default');
});

// ---------------------------------------------------------------------------
// AGENCY_BOUNDARIES_BLOCK injection tests
// ---------------------------------------------------------------------------

const AGENCY_BOUNDARY_SENTINELS = [
  'Agency boundaries',
  "we don't audit or manage",
] as const;

const INTENTS_THAT_USE_MEMBER_SUPPORT_PROMPT = [
  'onboarding',
  'content',
  'event',
  'support',
] as const;

for (const intent of INTENTS_THAT_USE_MEMBER_SUPPORT_PROMPT) {
  Deno.test(`member-agent system prompt (intent=${intent}) includes AGENCY_BOUNDARIES_BLOCK`, () => {
    const prompt = memberSupportPrompt(
      intent as 'onboarding' | 'content' | 'event' | 'support',
      /* memberKb */ 'stub-kb',
      /* productsKb */ 'stub-products',
      /* eventsKb */ 'stub-events',
      /* firstName */ 'TestMember',
      /* role */ 'owner',
      /* channel */ 'sms',
      /* historyStr */ '(no prior messages)',
    );
    for (const sentinel of AGENCY_BOUNDARY_SENTINELS) {
      assert(
        prompt.includes(sentinel),
        `Expected prompt for intent="${intent}" to contain "${sentinel}" but it did not.\nPrompt snippet (last 500 chars):\n${prompt.slice(-500)}`,
      );
    }
  });
}
