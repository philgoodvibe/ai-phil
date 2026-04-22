import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { followupAuditArgsFromResult } from './index.ts';

Deno.test('followupAuditArgsFromResult: surface is always ghl-sales-followup', () => {
  const args = followupAuditArgsFromResult(
    'c1', 'conv1', 3,
    { status: 'empty', facts: { family: [], occupation: [], recreation: [], money: [] }, latencyMs: 77 },
  );
  assertEquals(args.surface, 'ghl-sales-followup');
  assertEquals(args.status, 'empty');
  assertEquals(args.factsTotalAfter, 3);
  assertEquals(args.latencyMs, 77);
});

Deno.test('followupAuditArgsFromResult: threw branch captures errorSnippet', () => {
  const args = followupAuditArgsFromResult(
    'c1', null, 0,
    { status: 'threw', error: 'boom', latencyMs: 12 },
  );
  assertEquals(args.status, 'threw');
  assertEquals(args.errorSnippet, 'boom');
});
