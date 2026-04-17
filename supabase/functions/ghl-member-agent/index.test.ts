import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveChannel } from './index.ts';

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
