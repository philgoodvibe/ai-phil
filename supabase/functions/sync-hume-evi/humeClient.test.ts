import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { HumeClient, type HumeProxyFetch } from './humeClient.ts';

function mockFetch(responses: Array<{ status: number; ok: boolean; body: unknown }>): {
  calls: Array<{ method: string; path: string; payload?: unknown }>;
  fetch: HumeProxyFetch;
} {
  const calls: Array<{ method: string; path: string; payload?: unknown }> = [];
  let i = 0;
  const fetch: HumeProxyFetch = async ({ method, path, payload }) => {
    calls.push({ method, path, payload });
    const r = responses[i++] ?? { status: 500, ok: false, body: { error: 'no mock' } };
    return r;
  };
  return { calls, fetch };
}

Deno.test('getPromptLatest calls GET /v0/evi/prompts/{id}', async () => {
  const { calls, fetch } = mockFetch([
    { status: 200, ok: true, body: { prompts_page: [{ id: 'p1', version: 3, text: 'hello' }] } },
  ]);
  const c = new HumeClient(fetch);
  const r = await c.getPromptLatest('p1');
  assertEquals(calls[0].method, 'GET');
  assertEquals(calls[0].path, '/v0/evi/prompts/p1?page_size=1&page_number=0');
  assertEquals(r.text, 'hello');
  assertEquals(r.version, 3);
});

Deno.test('postPromptVersion calls POST /v0/evi/prompts/{id} with text+desc', async () => {
  const { calls, fetch } = mockFetch([
    { status: 200, ok: true, body: { id: 'p1', version: 4 } },
  ]);
  const c = new HumeClient(fetch);
  const v = await c.postPromptVersion('p1', 'new text', 'security block bumped');
  assertEquals(calls[0].method, 'POST');
  assertEquals(calls[0].path, '/v0/evi/prompts/p1');
  assertEquals((calls[0].payload as { text: string }).text, 'new text');
  assertEquals(v, 4);
});

Deno.test('getConfigLatest parses prompt reference', async () => {
  const { calls, fetch } = mockFetch([
    { status: 200, ok: true, body: { configs_page: [{ id: 'c1', version: 7, prompt: { id: 'p1', version: 3 } }] } },
  ]);
  const c = new HumeClient(fetch);
  const r = await c.getConfigLatest('c1');
  assertEquals(calls[0].path, '/v0/evi/configs/c1?page_size=1&page_number=0');
  assertEquals(r.version, 7);
  assertEquals(r.promptId, 'p1');
  assertEquals(r.promptVersion, 3);
});

Deno.test('postConfigVersion includes prompt pointer + carry-over + strips server-managed', async () => {
  const { calls, fetch } = mockFetch([
    { status: 200, ok: true, body: { id: 'c1', version: 8 } },
  ]);
  const c = new HumeClient(fetch);
  const current = {
    id: 'c1',
    version: 7,
    prompt: { id: 'p1', version: 3 },
    voice: { name: 'Philip' },
    created_on: 123,
    modified_on: 456,
    version_description: 'old desc',
  };
  const v = await c.postConfigVersion('c1', current, { id: 'p1', version: 4 }, 'new desc');
  assertEquals(calls[0].method, 'POST');
  assertEquals(calls[0].path, '/v0/evi/configs/c1');
  const payload = calls[0].payload as Record<string, unknown>;
  assertEquals(payload.prompt, { id: 'p1', version: 4 });
  assertEquals(payload.voice, { name: 'Philip' }); // carried over
  assertEquals(payload.version_description, 'new desc');
  assert(!('created_on' in payload));
  assert(!('modified_on' in payload));
  assertEquals(v, 8);
});

Deno.test('any non-ok response throws a readable error', async () => {
  const { fetch } = mockFetch([{ status: 422, ok: false, body: { error: 'bad' } }]);
  const c = new HumeClient(fetch);
  let msg = '';
  try { await c.getPromptLatest('p1'); } catch (e) { msg = (e as Error).message; }
  assert(msg.includes('422'));
  assert(msg.toLowerCase().includes('error') || msg.toLowerCase().includes('bad'));
});
