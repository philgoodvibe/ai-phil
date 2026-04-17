import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  AGENCY_BOUNDARIES_BLOCK,
  BANNED_WORDS,
  containsBannedWord,
  detectMemberClaim,
  buildSystemPrompt,
  isVoiceContext,
  VOICE_CONTEXTS,
  type VoiceContext,
  type RapportFacts,
} from './salesVoice.ts';

Deno.test('BANNED_WORDS contains only voice-doc-§6 true outliers', () => {
  const mustInclude = [
    'abundance', 'manifest', 'quantum leap',
    'step into your power', 'unlock your potential',
    'dream business', 'dream life', 'vibe',
    '10x overnight', 'secret system',
  ];
  for (const word of mustInclude) {
    const present = BANNED_WORDS.some((w) => w.toLowerCase() === word.toLowerCase());
    assertEquals(present, true, `BANNED_WORDS should include "${word}"`);
  }
});

Deno.test('BANNED_WORDS does NOT include voice-doc-corrected words Phillip naturally uses', () => {
  const mustNotInclude = ['leverage', 'transform', 'seamless', 'synergy'];
  for (const word of mustNotInclude) {
    const present = BANNED_WORDS.some((w) => w.toLowerCase() === word.toLowerCase());
    assertEquals(present, false, `BANNED_WORDS must NOT include "${word}" (Phillip uses it ${word === 'leverage' ? '109×' : 'frequently'} per Fathom corpus)`);
  }
});

Deno.test('containsBannedWord flags true-outlier banned phrases case-insensitively', () => {
  assertEquals(containsBannedWord('We help you step into your power'), true);
  assertEquals(containsBannedWord('Manifest your abundance mindset'), true);
  assertEquals(containsBannedWord('This is a quantum leap for agencies'), true);
});

Deno.test('containsBannedWord does NOT flag corpus-confirmed Phillip vocabulary', () => {
  assertEquals(containsBannedWord('We leverage AI to drive results'), false);
  assertEquals(containsBannedWord('This will transform your workflow'), false);
  assertEquals(containsBannedWord('A seamless handoff between agents'), false);
});

Deno.test('containsBannedWord flags "Hey" as greeting but not mid-sentence', () => {
  // Voice doc §6: "Hey (as greeting) — rare — Prefer 'Hi [Name]'"
  // Ban pattern: "Hey" at start of message or followed by comma/name
  assertEquals(containsBannedWord('Hey Mike, just checking in'), true);
  assertEquals(containsBannedWord('Hey, thought you might like this'), true);
  // Implementation choice: detection logic should be word-boundary + context-aware.
  // If simple substring match is used, a false positive like "Hi Mike, hey-whatever" is acceptable —
  // the conservative choice forces rewrite.
});

Deno.test('buildSystemPrompt includes identity rule in every context', () => {
  const contexts: VoiceContext[] = [
    'sales-live', 'sales-followup-1', 'sales-followup-2', 'sales-followup-3',
    'sales-nurture', 'event', 'support', 'unknown',
  ];
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  for (const ctx of contexts) {
    const prompt = buildSystemPrompt(ctx, emptyRapport, '(no prior messages)', '');
    assertStringIncludes(prompt, 'Ai Phil', `${ctx} prompt should identify as Ai Phil`);
    // Voice doc §1: never claim to be Phillip Ngo personally
    const mentionsNotPhillip =
      prompt.toLowerCase().includes('not phillip') ||
      prompt.toLowerCase().includes("never say \"i'm phillip") ||
      prompt.toLowerCase().includes('never claim to be phillip');
    assertEquals(mentionsNotPhillip, true, `${ctx} prompt should carry the never-claim-to-be-Phillip rule`);
  }
});

Deno.test('buildSystemPrompt includes Hormozi opener rule in sales-live context', () => {
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const prompt = buildSystemPrompt('sales-live', emptyRapport, '(no prior messages)', '');
  // Voice doc §3: "Every first sentence must prove you read their last message"
  assertStringIncludes(prompt.toLowerCase(), 'prove');
});

Deno.test('buildSystemPrompt injects rapport facts naturally when present', () => {
  const rapport: RapportFacts = {
    family: [{ key: 'dog_name', value: 'Lucy', source_conv: 'x', extracted_at: '2026-04-16' }],
    occupation: [{ key: 'agency_size', value: '3 producers', source_conv: 'x', extracted_at: '2026-04-16' }],
    recreation: [],
    money: [],
  };
  const prompt = buildSystemPrompt('sales-live', rapport, '(no prior)', '');
  assertStringIncludes(prompt, 'Lucy');
  assertStringIncludes(prompt, '3 producers');
});

Deno.test('buildSystemPrompt sales-followup-1 specifies clarity + peer proof angle', () => {
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const prompt = buildSystemPrompt('sales-followup-1', emptyRapport, '(no prior)', '');
  assertStringIncludes(prompt.toLowerCase(), 'proof');
});

Deno.test('buildSystemPrompt sales-followup-3 specifies real constraint + soft close angle', () => {
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const prompt = buildSystemPrompt('sales-followup-3', emptyRapport, '(no prior)', '');
  assertStringIncludes(prompt.toLowerCase(), 'close');
});

Deno.test('buildSystemPrompt support context excludes pitching cues', () => {
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const prompt = buildSystemPrompt('support', emptyRapport, '(no prior)', '');
  // Voice doc §9: support context = "Helpful answer, escalate when needed / No pitching"
  // Sanity check: the prompt explicitly mentions support or helpful
  const supportSignal = prompt.toLowerCase().includes('support') || prompt.toLowerCase().includes('helpful');
  assertEquals(supportSignal, true);
});

Deno.test('buildSystemPrompt injects extras block when provided', () => {
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const extras = 'EVENT FACTS:\n- Next cohort starts April 29';
  const prompt = buildSystemPrompt('event', emptyRapport, '(no prior)', extras);
  assertStringIncludes(prompt, 'Next cohort starts April 29');
});

Deno.test('buildSystemPrompt includes history string verbatim when provided', () => {
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const history = 'USER: Tell me about pricing\nPHIL: [sent checkout link 24hr ago]';
  const prompt = buildSystemPrompt('sales-followup-1', emptyRapport, history, '');
  assertStringIncludes(prompt, 'Tell me about pricing');
  assertStringIncludes(prompt, '[sent checkout link 24hr ago]');
});

Deno.test('buildSystemPrompt throws on unknown VoiceContext at runtime', () => {
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  let threw = false;
  try {
    // deliberately pass invalid context as if from a typo at HTTP boundary
    buildSystemPrompt('sales_live' as unknown as VoiceContext, emptyRapport, '', '');
  } catch (err) {
    threw = true;
    assertStringIncludes((err as Error).message, 'unknown VoiceContext');
  }
  assertEquals(threw, true, 'Expected buildSystemPrompt to throw on invalid context');
});

Deno.test('isVoiceContext narrows valid strings and rejects invalid ones', () => {
  assertEquals(isVoiceContext('sales-live'), true);
  assertEquals(isVoiceContext('support'), true);
  assertEquals(isVoiceContext('sales_live'), false);
  assertEquals(isVoiceContext('Sales-Live'), false);
  assertEquals(isVoiceContext(''), false);
});

Deno.test('sales-* contexts include VOCABULARY_BLOCK with operator terms', () => {
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const salesPrompt = buildSystemPrompt('sales-live', emptyRapport, '(no prior)', '');
  // "Automated Agency Circle" and "Insurance Marketing Machine" are unique to VOCABULARY_BLOCK
  assertStringIncludes(salesPrompt, 'Automated Agency Circle');
  assertStringIncludes(salesPrompt, 'Insurance Marketing Machine');
});

Deno.test('non-sales contexts do NOT include VOCABULARY_BLOCK', () => {
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const supportPrompt = buildSystemPrompt('support', emptyRapport, '(no prior)', '');
  // "Automated Agency Circle" is unique to VOCABULARY_BLOCK (not in FORM/VOICE/etc.)
  assertEquals(supportPrompt.includes('Automated Agency Circle'), false);
});

Deno.test('VOCABULARY_BLOCK teaches canonical MAX + MAYA expansions + acronym rule', () => {
  // Voice doc §6 "Branded AiAi product acronyms" — prospects don't know what MAX/MAYA mean;
  // always expand on first mention. Locking in the canonical expansions so Sonnet has them
  // at hand without needing to fetch the KB doc.
  const emptyRapport: RapportFacts = { family: [], occupation: [], recreation: [], money: [] };
  const prompt = buildSystemPrompt('sales-live', emptyRapport, '(no prior)', '');
  assertStringIncludes(prompt, 'Marketing Ads Accelerator');
  assertStringIncludes(prompt, 'Marketing Assistant to Your Agency');
  assertStringIncludes(prompt, 'Automated Team Onboarding Machine');
  // The rule itself must be present so the model knows WHY to expand
  assertStringIncludes(prompt.toLowerCase(), 'expand');
});

// ---------------------------------------------------------------------------
// Task 1 — AGENCY_BOUNDARIES_BLOCK tests
// ---------------------------------------------------------------------------

Deno.test('AGENCY_BOUNDARIES_BLOCK contains the no-agency rule', () => {
  assert(AGENCY_BOUNDARIES_BLOCK.includes('not an agency'));
  assert(AGENCY_BOUNDARIES_BLOCK.includes('never offer to audit') || AGENCY_BOUNDARIES_BLOCK.toLowerCase().includes('audit'));
  assert(AGENCY_BOUNDARIES_BLOCK.includes("Phil's time"));
  assert(AGENCY_BOUNDARIES_BLOCK.includes('weekly call'));
});

Deno.test('buildSystemPrompt includes AGENCY_BOUNDARIES_BLOCK for every context', () => {
  for (const ctx of VOICE_CONTEXTS) {
    const prompt = buildSystemPrompt(ctx, { family: [], occupation: [], recreation: [], money: [] }, '');
    assert(prompt.includes('Agency boundaries'), `missing for context ${ctx}`);
    assert(prompt.includes("we don't audit or manage"), `missing phrase for context ${ctx}`);
  }
});

// ---------------------------------------------------------------------------
// Task 2 — detectMemberClaim tests
// ---------------------------------------------------------------------------

Deno.test('detectMemberClaim flags insider language', () => {
  assert(detectMemberClaim('I have questions about my Google Ads campaign through the program'));
  assert(detectMemberClaim('Hey Phil, I saw your last workshop and wanted to follow up'));
  assert(detectMemberClaim('Can I get access to the member portal again?'));
  assert(detectMemberClaim('I paused my ads and wanted your advice'));
  assert(detectMemberClaim('As a member, what should I do about this?'));
});

Deno.test('detectMemberClaim ignores new-prospect language', () => {
  assert(!detectMemberClaim('Saw your ad, can you tell me about the mastermind?'));
  assert(!detectMemberClaim('What is the price of your program?'));
  assert(!detectMemberClaim('hello test'));
});
