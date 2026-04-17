import { assertEquals, assert } from '@std/assert';
import {
  extractMessageBody,
  extractMessageType,
  extractContactId,
  extractLocationId,
  normalizeChannel,
  hasMemberTag,
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
