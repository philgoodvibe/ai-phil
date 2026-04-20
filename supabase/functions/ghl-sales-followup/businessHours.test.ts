import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isWithinBusinessHours } from './businessHours.ts';

// Apr 20 2026 is a Monday; PDT is active (UTC-7).
// Nov 2 2026 is a Monday; PST is active (UTC-8) — fall-back was Sun Nov 1.

Deno.test('PDT: Mon 10:30 local is within window', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-20T17:30:00Z')), true);
});

Deno.test('PDT: Mon 08:59 local is before window', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-20T15:59:00Z')), false);
});

Deno.test('PDT: Mon 09:00 local is the first in-window tick', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-20T16:00:00Z')), true);
});

Deno.test('PDT: Mon 17:59 local is still in window (hour 17 is inclusive)', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-21T00:59:00Z')), true);
});

Deno.test('PDT: Mon 18:00 local is past window', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-21T01:00:00Z')), false);
});

Deno.test('PDT: Sat 10:30 local is a weekend → false', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-25T17:30:00Z')), false);
});

Deno.test('PDT: Sun 21:00 local is a weekend → false', () => {
  assertEquals(isWithinBusinessHours(new Date('2026-04-20T04:00:00Z')), false);
});

Deno.test('PST fall-back: Mon 09:00 local is the first in-window tick', () => {
  // 2026-11-02 17:00 UTC = 09:00 PST (Mon)
  assertEquals(isWithinBusinessHours(new Date('2026-11-02T17:00:00Z')), true);
});

Deno.test('PST fall-back: Mon 08:00 local is before window', () => {
  // 2026-11-02 16:00 UTC = 08:00 PST (Mon) — the SAME UTC moment was 09:00 PDT the prior Monday
  assertEquals(isWithinBusinessHours(new Date('2026-11-02T16:00:00Z')), false);
});
