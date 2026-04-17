import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isCacheFresh, CACHE_TTL_MS } from './kbCache.ts';

Deno.test('isCacheFresh returns true within TTL', () => {
  const now = Date.now();
  const fetched = new Date(now - 10 * 60 * 1000).toISOString();
  assertEquals(isCacheFresh(fetched, now), true);
});

Deno.test('isCacheFresh returns false past TTL', () => {
  const now = Date.now();
  const fetched = new Date(now - 40 * 60 * 1000).toISOString();
  assertEquals(isCacheFresh(fetched, now), false);
});

Deno.test('CACHE_TTL_MS is 30 minutes', () => {
  assertEquals(CACHE_TTL_MS, 30 * 60 * 1000);
});

Deno.test('isCacheFresh treats exactly-TTL boundary as stale', () => {
  const now = Date.now();
  const fetched = new Date(now - CACHE_TTL_MS).toISOString();
  // At exactly the TTL, the cache is stale (strictly-less-than policy)
  assertEquals(isCacheFresh(fetched, now), false);
});

Deno.test('isCacheFresh treats malformed ISO date as stale', () => {
  const now = Date.now();
  assertEquals(isCacheFresh('not-a-date', now), false);
  assertEquals(isCacheFresh('', now), false);
});
