import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  formatRapportBlock,
  mergeRapportFacts,
  type RapportFacts,
  type ExtractStatus,
} from './rapport.ts';

Deno.test('formatRapportBlock returns empty block when no facts', () => {
  const facts: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const block = formatRapportBlock(facts);
  assertEquals(block, '(no rapport facts captured yet. Listen and extract naturally through F.O.R.M. questions.)');
});

Deno.test('formatRapportBlock formats all four categories', () => {
  const facts: RapportFacts = {
    family: [{ key: 'dog_name', value: 'Lucy', source_conv: 'x', extracted_at: '2026-04-16' }],
    occupation: [{ key: 'carrier', value: 'State Farm', source_conv: 'x', extracted_at: '2026-04-16' }],
    recreation: [{ key: 'team', value: 'Cowboys', source_conv: 'x', extracted_at: '2026-04-16' }],
    money: [{ key: 'goal', value: '$5M by 2028', source_conv: 'x', extracted_at: '2026-04-16' }],
  };
  const block = formatRapportBlock(facts);
  assertStringIncludes(block, 'Family');
  assertStringIncludes(block, 'Lucy');
  assertStringIncludes(block, 'Occupation');
  assertStringIncludes(block, 'State Farm');
  assertStringIncludes(block, 'Recreation');
  assertStringIncludes(block, 'Cowboys');
  assertStringIncludes(block, 'Money');
  assertStringIncludes(block, '$5M by 2028');
});

Deno.test('mergeRapportFacts appends new facts without overwriting', () => {
  const existing: RapportFacts = {
    family: [{ key: 'dog_name', value: 'Lucy', source_conv: 'x', extracted_at: '2026-04-15' }],
    occupation: [],
    recreation: [],
    money: [],
  };
  const incoming: RapportFacts = {
    family: [{ key: 'dog_name', value: 'Lucy (passed away)', source_conv: 'y', extracted_at: '2026-04-16' }],
    occupation: [{ key: 'carrier', value: 'State Farm', source_conv: 'y', extracted_at: '2026-04-16' }],
    recreation: [],
    money: [],
  };
  const merged = mergeRapportFacts(existing, incoming);
  assertEquals(merged.family.length, 2, 'dog_name is appended, not overwritten — timeline matters');
  assertEquals(merged.occupation.length, 1);
});

Deno.test('mergeRapportFacts deduplicates exact duplicates', () => {
  const existing: RapportFacts = {
    family: [{ key: 'dog_name', value: 'Lucy', source_conv: 'x', extracted_at: '2026-04-15' }],
    occupation: [],
    recreation: [],
    money: [],
  };
  const incoming: RapportFacts = {
    family: [{ key: 'dog_name', value: 'Lucy', source_conv: 'x', extracted_at: '2026-04-15' }],
    occupation: [],
    recreation: [],
    money: [],
  };
  const merged = mergeRapportFacts(existing, incoming);
  assertEquals(merged.family.length, 1, 'exact dup dropped');
});

// ---------------------------------------------------------------------------
// extractRapport return-shape tests (ExtractResult union)
// ---------------------------------------------------------------------------
import { extractRapport } from './rapport.ts';

// Shared: stub global fetch per test, restore after.
function withFetchStub(impl: (req: Request) => Promise<Response>, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    return impl(req);
  }) as typeof fetch;
  return fn().finally(() => { globalThis.fetch = original; });
}

Deno.test('extractRapport: ok branch — Haiku returns 1 fact', async () => {
  await withFetchStub(
    (_req) => Promise.resolve(new Response(JSON.stringify({
      content: [{ text: JSON.stringify({
        family: [{ key: 'dog_name', value: 'Lucy', source_conv: 'c1', extracted_at: '2026-04-21T00:00:00Z' }],
        occupation: [], recreation: [], money: [],
      }) }],
    }), { status: 200 })),
    async () => {
      const result = await extractRapport(
        { userMessage: 'my dog Lucy', assistantReply: 'nice', conversationId: 'c1' },
        { family: [], occupation: [], recreation: [], money: [] },
        'test-key',
      );
      assertEquals(result.status, 'ok');
      if (result.status === 'ok') {
        assertEquals(result.facts.family.length, 1);
        assert(result.latencyMs >= 0);
      }
    },
  );
});

Deno.test('extractRapport: empty branch — Haiku returns all-empty pillars', async () => {
  await withFetchStub(
    (_req) => Promise.resolve(new Response(JSON.stringify({
      content: [{ text: JSON.stringify({ family: [], occupation: [], recreation: [], money: [] }) }],
    }), { status: 200 })),
    async () => {
      const result = await extractRapport(
        { userMessage: 'k', assistantReply: 'got it', conversationId: 'c1' },
        { family: [], occupation: [], recreation: [], money: [] },
        'test-key',
      );
      assertEquals(result.status, 'empty');
    },
  );
});

Deno.test('extractRapport: http_error branch — 500 from Haiku', async () => {
  await withFetchStub(
    (_req) => Promise.resolve(new Response('upstream error', { status: 500 })),
    async () => {
      const result = await extractRapport(
        { userMessage: 'x', assistantReply: 'y', conversationId: 'c1' },
        { family: [], occupation: [], recreation: [], money: [] },
        'test-key',
      );
      assertEquals(result.status, 'http_error');
      if (result.status === 'http_error') {
        assertEquals(result.httpStatus, 500);
        assert(result.error.length > 0);
      }
    },
  );
});

Deno.test('extractRapport: parse_error branch — Haiku returns malformed JSON', async () => {
  await withFetchStub(
    (_req) => Promise.resolve(new Response(JSON.stringify({
      content: [{ text: 'not json {' }],
    }), { status: 200 })),
    async () => {
      const result = await extractRapport(
        { userMessage: 'x', assistantReply: 'y', conversationId: 'c1' },
        { family: [], occupation: [], recreation: [], money: [] },
        'test-key',
      );
      assertEquals(result.status, 'parse_error');
      if (result.status === 'parse_error') {
        assert(result.rawSnippet.length > 0);
      }
    },
  );
});

Deno.test('extractRapport: no_api_key branch — empty key short-circuits', async () => {
  const result = await extractRapport(
    { userMessage: 'x', assistantReply: 'y', conversationId: 'c1' },
    { family: [], occupation: [], recreation: [], money: [] },
    '',
  );
  assertEquals(result.status, 'no_api_key');
  assertEquals(result.latencyMs, 0);
});

Deno.test('extractRapport: threw branch — synchronous fetch error', async () => {
  await withFetchStub(
    (_req) => { throw new Error('network down'); },
    async () => {
      const result = await extractRapport(
        { userMessage: 'x', assistantReply: 'y', conversationId: 'c1' },
        { family: [], occupation: [], recreation: [], money: [] },
        'test-key',
      );
      assertEquals(result.status, 'threw');
      if (result.status === 'threw') {
        assert(result.error.includes('network down'));
        assert(result.latencyMs >= 0);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// recordExtraction tests
// ---------------------------------------------------------------------------
import { recordExtraction } from './rapport.ts';

Deno.test('recordExtraction: builds correct row shape', async () => {
  const inserts: unknown[] = [];
  const stub = {
    schema: (_: string) => ({
      from: (_t: string) => ({
        insert: (row: unknown) => {
          inserts.push(row);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };
  await recordExtraction(stub, {
    contactId: 'c1',
    conversationId: 'conv1',
    surface: 'ghl-sales-agent',
    status: 'ok',
    factsAdded: 2,
    factsTotalAfter: 5,
    latencyMs: 123,
  });
  assertEquals(inserts.length, 1);
  const row = inserts[0] as Record<string, unknown>;
  assertEquals(row.contact_id, 'c1');
  assertEquals(row.conversation_id, 'conv1');
  assertEquals(row.surface, 'ghl-sales-agent');
  assertEquals(row.haiku_status, 'ok');
  assertEquals(row.facts_added, 2);
  assertEquals(row.facts_total_after, 5);
  assertEquals(row.latency_ms, 123);
});

Deno.test('recordExtraction: caps errorSnippet at 200 chars', async () => {
  const inserts: unknown[] = [];
  const stub = {
    schema: (_: string) => ({
      from: (_t: string) => ({
        insert: (row: unknown) => { inserts.push(row); return Promise.resolve({ error: null }); },
      }),
    }),
  };
  const longErr = 'x'.repeat(500);
  await recordExtraction(stub, {
    contactId: 'c1', surface: 'ghl-sales-agent', status: 'threw',
    errorSnippet: longErr,
  });
  const row = inserts[0] as Record<string, unknown>;
  assertEquals((row.error_snippet as string).length, 200);
});

Deno.test('recordExtraction: swallows DB errors (non-fatal)', async () => {
  const stub = {
    schema: (_: string) => ({
      from: (_t: string) => ({
        insert: (_: unknown) => Promise.resolve({ error: { message: 'fake db err' } }),
      }),
    }),
  };
  // Must not throw.
  await recordExtraction(stub, {
    contactId: 'c1', surface: 'ghl-sales-agent', status: 'empty',
  });
});
