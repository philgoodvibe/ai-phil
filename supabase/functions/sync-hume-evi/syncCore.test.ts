import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { runSync, type SyncDeps, type RegistryRow, type BundleOut } from './syncCore.ts';
import { SHARED_BEGIN, SHARED_END } from './markers.ts';

function buildRegistry(): RegistryRow[] {
  return [
    { slug: 'discovery',      hume_config_id: 'c-d', hume_prompt_id: 'p-d', carries_addendum: true,  bundle_variant: 'voice' },
    { slug: 'new-member',     hume_config_id: 'c-n', hume_prompt_id: 'p-n', carries_addendum: false, bundle_variant: 'full' },
    { slug: 'implementation', hume_config_id: 'c-i', hume_prompt_id: 'p-i', carries_addendum: false, bundle_variant: 'full' },
  ];
}

function wrap(preamble: string, body: string, hash: string, begin: string, end: string): string {
  return `${preamble}\n${begin} v=${hash} -->\n${body}\n${end}\n(tail)`;
}

function baseDeps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  const bundleByVariant: Record<string, BundleOut> = {
    full:  { text: 'NEW_BUNDLE_FULL',  hash: 'h-full-new',  blockNames: ['SECURITY_BOUNDARY_BLOCK'] },
    voice: { text: 'NEW_BUNDLE_VOICE', hash: 'h-voice-new', blockNames: ['SECURITY_VOICE_BLOCK'] },
  };
  const addendumByVariant: Record<string, BundleOut> = {
    full:  { text: 'NEW_ADDENDUM_FULL',  hash: 'h-add-full-new',  blockNames: ['BRANDED_ACRONYM_EXPANSION_BLOCK'] },
    voice: { text: 'NEW_ADDENDUM_VOICE', hash: 'h-add-voice-new', blockNames: ['BRANDED_ACRONYM_VOICE_BLOCK'] },
  };
  const lastBundleByVariant: Record<string, string | null> = { full: 'h-full-old', voice: 'h-voice-old' };
  const lastAddendumByVariant: Record<string, string | null> = { full: 'h-add-full-old', voice: 'h-add-voice-old' };
  const savedBundle: Record<string, string> = {};
  const savedAddendum: Record<string, string> = {};

  const defaults: SyncDeps = {
    buildBundle: async (variant) => bundleByVariant[variant],
    buildAddendum: async (variant) => addendumByVariant[variant],
    loadRegistry: async () => buildRegistry(),
    loadLastBundleHash: async (variant) => lastBundleByVariant[variant],
    loadLastAddendumHash: async (variant) => lastAddendumByVariant[variant],
    saveLastBundleHash: async (variant, h) => { savedBundle[variant] = h; },
    saveLastAddendumHash: async (variant, h) => { savedAddendum[variant] = h; },
    hume: {
      getPromptLatest: async (pid: string) => ({
        id: pid, version: 1,
        text: wrap('pre', 'OLD_BODY', 'h-old', SHARED_BEGIN, SHARED_END),
      }),
      postPromptVersion: async () => 2,
      getConfigLatest: async (cid: string) => ({
        id: cid, version: 5, promptId: cid.replace('c-','p-'), promptVersion: 1,
        raw: { id: cid, version: 5, prompt: { id: cid.replace('c-','p-'), version: 1 }, voice: { name: 'Philip' } },
      }),
      postConfigVersion: async () => 6,
    },
    updateRegistryRow: async () => {},
    trigger: 'test',
    log: () => {},
  };
  return { ...defaults, ...overrides };
}

Deno.test('noop when all variant bundle+addendum hashes unchanged', async () => {
  const deps = baseDeps({
    loadLastBundleHash: async (variant) => variant === 'full' ? 'h-full-new' : 'h-voice-new',
    loadLastAddendumHash: async (variant) => variant === 'full' ? 'h-add-full-new' : 'h-add-voice-new',
  });
  const result = await runSync(deps);
  assertEquals(result.status, 'noop');
  assertEquals(result.configsChecked, 0);
  assertEquals(result.configsUpdated, 0);
});

Deno.test('happy path — bundle changed, all 3 configs update', async () => {
  const deps = baseDeps();
  const result = await runSync(deps);
  assertEquals(result.status, 'ok');
  assertEquals(result.configsChecked, 3);
  assertEquals(result.configsUpdated, 3);
  assertEquals(result.configsFailed, 0);
  assertEquals(result.humeVersions.length, 3);
  for (const v of result.humeVersions) {
    assertEquals(v.prompt_version, 2);
    assertEquals(v.config_version, 6);
    assert(!v.error);
  }
});

Deno.test('partial failure — one config errors, other two succeed', async () => {
  let calls = 0;
  const deps = baseDeps({
    hume: {
      ...baseDeps().hume,
      postPromptVersion: async () => {
        calls++;
        if (calls === 2) throw new Error('hume-500');
        return 2;
      },
    },
  });
  const result = await runSync(deps);
  assertEquals(result.status, 'partial');
  assertEquals(result.configsUpdated, 2);
  assertEquals(result.configsFailed, 1);
  const failed = result.humeVersions.find((v) => v.error);
  assert(failed, 'one entry should carry an error');
});

Deno.test('first-run bootstrap — markers absent, added without loss of tail content', async () => {
  const deps = baseDeps({
    hume: {
      ...baseDeps().hume,
      getPromptLatest: async (pid: string) => ({
        id: pid, version: 1,
        text: 'Human-curated Hume prompt with no markers yet.\n\nVoice rules: keep it short.',
      }),
      postPromptVersion: async (_pid: string, text: string) => {
        assert(text.includes('Human-curated Hume prompt with no markers yet'));
        assert(text.includes('Voice rules: keep it short'));
        assert(text.includes(SHARED_BEGIN));
        assert(text.includes(SHARED_END));
        assert(
          text.includes('NEW_BUNDLE_VOICE') || text.includes('NEW_BUNDLE_FULL'),
          'bootstrap should splice SOME bundle body (variant depends on which row being tested)',
        );
        return 2;
      },
    },
  });
  const result = await runSync(deps);
  assertEquals(result.status, 'ok');
});

Deno.test('Discovery addendum is posted only for slug=discovery', async () => {
  let addendumPromptCalls = 0;
  const deps = baseDeps({
    hume: {
      ...baseDeps().hume,
      postPromptVersion: async (_pid: string, text: string) => {
        if (text.includes('NEW_ADDENDUM_VOICE')) addendumPromptCalls++;
        return 2;
      },
    },
  });
  await runSync(deps);
  assertEquals(addendumPromptCalls, 1);
});

Deno.test('voice variant change syncs only the Discovery row', async () => {
  const deps = baseDeps({
    loadLastBundleHash: async (variant) => variant === 'full' ? 'h-full-new' : 'h-voice-OLD',
    loadLastAddendumHash: async (variant) => variant === 'full' ? 'h-add-full-new' : 'h-add-voice-OLD',
  });
  const result = await runSync(deps);
  assertEquals(result.status, 'ok');
  assertEquals(result.configsUpdated, 1);
  assertEquals(result.configsFailed, 0);
  assertEquals(result.humeVersions.length, 1);
  assertEquals(result.humeVersions[0].slug, 'discovery');
});

Deno.test('full variant change syncs only the new-member + implementation rows', async () => {
  const deps = baseDeps({
    loadLastBundleHash: async (variant) => variant === 'full' ? 'h-full-OLD' : 'h-voice-new',
    loadLastAddendumHash: async (variant) => variant === 'full' ? 'h-add-full-OLD' : 'h-add-voice-new',
  });
  const result = await runSync(deps);
  assertEquals(result.status, 'ok');
  assertEquals(result.configsUpdated, 2);
  const slugs = result.humeVersions.map(v => v.slug).sort();
  assertEquals(slugs, ['implementation', 'new-member']);
});

Deno.test('voice row receives voice bundle text in the spliced prompt', async () => {
  let seenForDiscovery = '';
  const deps = baseDeps({
    hume: {
      ...baseDeps().hume,
      postPromptVersion: async (pid: string, text: string) => {
        if (pid === 'p-d') seenForDiscovery = text;
        return 2;
      },
    },
  });
  await runSync(deps);
  assert(seenForDiscovery.includes('NEW_BUNDLE_VOICE'), 'Discovery prompt should contain voice bundle text');
  assert(seenForDiscovery.includes('NEW_ADDENDUM_VOICE'), 'Discovery prompt should contain voice addendum text');
  assert(!seenForDiscovery.includes('NEW_BUNDLE_FULL'), 'Discovery prompt must NOT contain full bundle text');
});

Deno.test('full rows receive full bundle text, never voice text', async () => {
  const seenByPid: Record<string, string> = {};
  const deps = baseDeps({
    hume: {
      ...baseDeps().hume,
      postPromptVersion: async (pid: string, text: string) => {
        seenByPid[pid] = text;
        return 2;
      },
    },
  });
  await runSync(deps);
  for (const pid of ['p-n', 'p-i']) {
    assert(seenByPid[pid]?.includes('NEW_BUNDLE_FULL'), `${pid} should contain full bundle text`);
    assert(!seenByPid[pid]?.includes('NEW_BUNDLE_VOICE'), `${pid} must NOT contain voice bundle text`);
  }
});
