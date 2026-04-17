import { assertEquals, assert } from '@std/assert';
import {
  extractMessageBody,
  extractMessageType,
  extractContactId,
  extractLocationId,
  normalizeChannel,
  hasMemberTag,
  matchesEscalationKeyword,
  readAgencyRole,
  roleBlocksBilling,
  parseIntent,
  formatHistory,
} from './index.ts';

Deno.test('extractMessageBody — reads nested message.body', () => {
  const body = { message: { body: 'hello' } };
  assertEquals(extractMessageBody(body), 'hello');
});

Deno.test('extractMessageBody — reads flat message_body', () => {
  assertEquals(extractMessageBody({ message_body: 'flat' }), 'flat');
});

Deno.test('extractMessageBody — returns null when missing', () => {
  assertEquals(extractMessageBody({}), null);
});

Deno.test('extractMessageType — numeric 1 → Email', () => {
  assertEquals(extractMessageType({ message: { type: 1 } }), 'Email');
});

Deno.test('extractMessageType — numeric 2 → SMS', () => {
  assertEquals(extractMessageType({ message: { type: 2 } }), 'SMS');
});

Deno.test('extractMessageType — returns null when absent', () => {
  assertEquals(extractMessageType({}), null);
});

Deno.test('extractMessageType — reads GHL Custom Data message_type', () => {
  assertEquals(extractMessageType({ message_type: 'Email' }), 'Email');
});

Deno.test('normalizeChannel — Email → email', () => {
  assertEquals(normalizeChannel('Email'), 'email');
});

Deno.test('normalizeChannel — SMS → sms', () => {
  assertEquals(normalizeChannel('SMS'), 'sms');
});

Deno.test('normalizeChannel — Calls → phone', () => {
  assertEquals(normalizeChannel('Calls'), 'phone');
});

Deno.test('extractContactId — reads contactId camelCase', () => {
  assertEquals(extractContactId({ contactId: 'abc123' }), 'abc123');
});

Deno.test('extractContactId — reads nested contact.id', () => {
  assertEquals(extractContactId({ contact: { id: 'xyz789' } }), 'xyz789');
});

Deno.test('extractLocationId — reads nested location.id', () => {
  assertEquals(extractLocationId({ location: { id: 'loc1' } }), 'loc1');
});

Deno.test('hasMemberTag — matches full decorated tag', () => {
  assert(hasMemberTag(['⭕️aiai-member-active✅']));
});

Deno.test('hasMemberTag — matches plain substring', () => {
  assert(hasMemberTag(['aiai-member-active']));
});

Deno.test('hasMemberTag — false when absent', () => {
  assertEquals(hasMemberTag(['random-tag']), false);
});

Deno.test('hasMemberTag — false when undefined', () => {
  assertEquals(hasMemberTag(undefined), false);
});

Deno.test('matchesEscalationKeyword — cancel', () => {
  assert(matchesEscalationKeyword('I want to cancel my membership'));
});

Deno.test('matchesEscalationKeyword — refund', () => {
  assert(matchesEscalationKeyword('Can I get a refund please?'));
});

Deno.test('matchesEscalationKeyword — billing', () => {
  assert(matchesEscalationKeyword('Question about my billing'));
});

Deno.test('matchesEscalationKeyword — MAX package', () => {
  assert(matchesEscalationKeyword('Interested in the MAX package'));
});

Deno.test('matchesEscalationKeyword — MAYA package', () => {
  assert(matchesEscalationKeyword('Can you tell me about the MAYA package?'));
});

Deno.test('matchesEscalationKeyword — done for you', () => {
  assert(matchesEscalationKeyword('Do you offer done for you services?'));
});

Deno.test('matchesEscalationKeyword — frustration: unacceptable', () => {
  assert(matchesEscalationKeyword('This is unacceptable!'));
});

Deno.test('matchesEscalationKeyword — frustration: scam', () => {
  assert(matchesEscalationKeyword('This feels like a scam'));
});

Deno.test('matchesEscalationKeyword — false for benign message', () => {
  assertEquals(matchesEscalationKeyword('How do I find the workshop replay?'), false);
});

Deno.test('matchesEscalationKeyword — false for empty', () => {
  assertEquals(matchesEscalationKeyword(''), false);
});

Deno.test('matchesEscalationKeyword — case insensitive', () => {
  assert(matchesEscalationKeyword('CANCEL my subscription now'));
});

Deno.test('matchesEscalationKeyword — does not false-positive on substrings', () => {
  // "chargebacks" contains "charge" — we want that to match (it IS billing)
  // but "uncancellable" shouldn't hit "cancel"? Actually it should — safer to escalate
  // This test documents the intended behavior: substring match is acceptable.
  assert(matchesEscalationKeyword('this is a chargeback situation'));
});

Deno.test('readAgencyRole — owner variants', () => {
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'Agency Owner' }]), 'owner');
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'owner' }]), 'owner');
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'OWNER' }]), 'owner');
});

Deno.test('readAgencyRole — manager', () => {
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'Agency Manager' }]), 'manager');
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'manager' }]), 'manager');
});

Deno.test('readAgencyRole — team member', () => {
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'Team Member' }]), 'team_member');
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: 'team' }]), 'team_member');
});

Deno.test('readAgencyRole — blank → unknown', () => {
  assertEquals(readAgencyRole([{ name: '⭕️Agency Role', value: '' }]), 'unknown');
});

Deno.test('readAgencyRole — missing field → unknown', () => {
  assertEquals(readAgencyRole([]), 'unknown');
  assertEquals(readAgencyRole(undefined), 'unknown');
});

Deno.test('readAgencyRole — matches by name substring', () => {
  assertEquals(readAgencyRole([{ key: 'agency_role', value: 'Agency Owner' }]), 'owner');
});

Deno.test('roleBlocksBilling — owner allowed', () => {
  assertEquals(roleBlocksBilling('owner'), false);
});

Deno.test('roleBlocksBilling — manager blocked', () => {
  assertEquals(roleBlocksBilling('manager'), true);
});

Deno.test('roleBlocksBilling — team_member blocked', () => {
  assertEquals(roleBlocksBilling('team_member'), true);
});

Deno.test('roleBlocksBilling — unknown blocked (most restrictive default)', () => {
  assertEquals(roleBlocksBilling('unknown'), true);
});

Deno.test('parseIntent — valid onboarding', () => {
  assertEquals(parseIntent('onboarding'), 'onboarding');
});

Deno.test('parseIntent — valid content', () => {
  assertEquals(parseIntent('content'), 'content');
});

Deno.test('parseIntent — valid event', () => {
  assertEquals(parseIntent('event'), 'event');
});

Deno.test('parseIntent — valid coaching', () => {
  assertEquals(parseIntent('coaching'), 'coaching');
});

Deno.test('parseIntent — valid support', () => {
  assertEquals(parseIntent('support'), 'support');
});

Deno.test('parseIntent — valid escalate', () => {
  assertEquals(parseIntent('escalate'), 'escalate');
});

Deno.test('parseIntent — strips punctuation', () => {
  assertEquals(parseIntent('support.'), 'support');
  assertEquals(parseIntent('  onboarding  '), 'onboarding');
  assertEquals(parseIntent('"event"'), 'event');
});

Deno.test('parseIntent — case insensitive', () => {
  assertEquals(parseIntent('SUPPORT'), 'support');
  assertEquals(parseIntent('Coaching'), 'coaching');
});

Deno.test('parseIntent — unknown defaults to support', () => {
  assertEquals(parseIntent('garbage'), 'support');
  assertEquals(parseIntent(''), 'support');
});

Deno.test('formatHistory — empty returns marker', () => {
  assertEquals(formatHistory([]), '(no prior messages)');
});

Deno.test('formatHistory — formats MEMBER/AI', () => {
  const out = formatHistory([
    { direction: 'inbound', body: 'hi' },
    { direction: 'outbound', body: 'hello' },
  ]);
  assertEquals(out, 'MEMBER: hi\nAI: hello');
});

Deno.test('formatHistory — skips empty bodies', () => {
  const out = formatHistory([
    { direction: 'inbound', body: '' },
    { direction: 'outbound', body: 'only this' },
  ]);
  assertEquals(out, 'AI: only this');
});
