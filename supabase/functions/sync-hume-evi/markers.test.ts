import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { spliceMarkerRegion, SHARED_BEGIN, SHARED_END, makeMarkerBlock } from './markers.ts';

Deno.test('spliceMarkerRegion replaces an existing region in-place', () => {
  const prompt = `preamble\n\n${SHARED_BEGIN} v=old\nOLD BODY\n${SHARED_END}\n\ntail content`;
  const out = spliceMarkerRegion(prompt, { begin: SHARED_BEGIN, end: SHARED_END }, 'NEW BODY', 'abc123');
  assert(out.includes('NEW BODY'));
  assert(!out.includes('OLD BODY'));
  assert(out.includes('v=abc123'));
  // preamble and tail preserved
  assert(out.startsWith('preamble'));
  assert(out.endsWith('tail content'));
});

Deno.test('spliceMarkerRegion prepends markers when absent (first-run)', () => {
  const prompt = 'just some human-curated prompt content';
  const out = spliceMarkerRegion(prompt, { begin: SHARED_BEGIN, end: SHARED_END }, 'FRESH BODY', 'hashX');
  assert(out.startsWith(`${SHARED_BEGIN} v=hashX`));
  assert(out.includes('FRESH BODY'));
  assert(out.includes(SHARED_END));
  // Original content preserved below the markers
  assert(out.includes('just some human-curated prompt content'));
});

Deno.test('spliceMarkerRegion throws on malformed region (begin without end)', () => {
  const prompt = `${SHARED_BEGIN} v=x\nstuck open\n\n(no end marker)`;
  let threw = false;
  try { spliceMarkerRegion(prompt, { begin: SHARED_BEGIN, end: SHARED_END }, 'BODY', 'h'); }
  catch { threw = true; }
  assert(threw, 'malformed region must throw, not silently do nothing');
});

Deno.test('spliceMarkerRegion is idempotent with unchanged body', () => {
  const prompt = `${SHARED_BEGIN} v=h1\nBODY\n${SHARED_END}\nafter`;
  const once = spliceMarkerRegion(prompt, { begin: SHARED_BEGIN, end: SHARED_END }, 'BODY', 'h1');
  const twice = spliceMarkerRegion(once, { begin: SHARED_BEGIN, end: SHARED_END }, 'BODY', 'h1');
  assertEquals(once, twice);
});

Deno.test('makeMarkerBlock builds a valid region', () => {
  const block = makeMarkerBlock(SHARED_BEGIN, SHARED_END, 'inner', 'hashY');
  assert(block.includes(`${SHARED_BEGIN} v=hashY`));
  assert(block.includes('inner'));
  assert(block.includes(SHARED_END));
});
