import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { computeNextSendAt, classifyTouch, type TouchOutcome } from './cadence.ts';

Deno.test('classifyTouch maps follow_up_number to outcome type', () => {
  assertEquals(classifyTouch(1), 'fu1-clarity');
  assertEquals(classifyTouch(2), 'fu2-objection');
  assertEquals(classifyTouch(3), 'fu3-soft-close');
  assertEquals(classifyTouch(4), 'nurture');
  assertEquals(classifyTouch(9), 'nurture-final');
  assertEquals(classifyTouch(10), 'done');
});

Deno.test('computeNextSendAt FU1 just fired → +3 days from created_at', () => {
  const createdAt = new Date('2026-04-16T00:00:00Z');
  const now = new Date('2026-04-17T00:00:00Z');
  const result = computeNextSendAt(1, createdAt, now);
  assertEquals(result.action, 'advance');
  if (result.action === 'advance') {
    assertEquals(result.followUpNumber, 2);
    assertEquals(result.nextSendAt.toISOString(), '2026-04-19T00:00:00.000Z');
  }
});

Deno.test('computeNextSendAt FU2 just fired → +7 days from created_at', () => {
  const createdAt = new Date('2026-04-16T00:00:00Z');
  const now = new Date('2026-04-19T00:00:00Z');
  const result = computeNextSendAt(2, createdAt, now);
  assertEquals(result.action, 'advance');
  if (result.action === 'advance') {
    assertEquals(result.followUpNumber, 3);
    assertEquals(result.nextSendAt.toISOString(), '2026-04-23T00:00:00.000Z');
  }
});

Deno.test('computeNextSendAt FU3 just fired → nurture anchor shifts to now + 30 days', () => {
  const createdAt = new Date('2026-04-16T00:00:00Z');
  const now = new Date('2026-04-23T00:00:00Z');
  const result = computeNextSendAt(3, createdAt, now);
  assertEquals(result.action, 'advance');
  if (result.action === 'advance') {
    assertEquals(result.followUpNumber, 4);
    assertEquals(result.nextSendAt.toISOString(), '2026-05-23T00:00:00.000Z');
  }
});

Deno.test('computeNextSendAt nurture touches 4-8 → +30 days from now', () => {
  const createdAt = new Date('2026-04-16T00:00:00Z');
  const now = new Date('2026-07-01T00:00:00Z');
  const result = computeNextSendAt(5, createdAt, now);
  assertEquals(result.action, 'advance');
  if (result.action === 'advance') {
    assertEquals(result.followUpNumber, 6);
    assertEquals(result.nextSendAt.toISOString(), '2026-07-31T00:00:00.000Z');
  }
});

Deno.test('computeNextSendAt FU9 just fired → delete', () => {
  const createdAt = new Date('2026-04-16T00:00:00Z');
  const now = new Date('2026-10-01T00:00:00Z');
  const result = computeNextSendAt(9, createdAt, now);
  assertEquals(result.action, 'delete');
});
