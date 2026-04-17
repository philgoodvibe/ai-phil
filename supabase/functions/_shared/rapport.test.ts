import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  formatRapportBlock,
  mergeRapportFacts,
  type RapportFacts,
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
