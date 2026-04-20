import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { runSync, type SyncDeps, type RegistryRow } from './syncCore.ts';
import { SHARED_BEGIN, SHARED_END } from './markers.ts';

function buildRegistry(): RegistryRow[] {
  return [
    { slug: 'discovery',      hume_config_id: 'c-d', hume_prompt_id: 'p-d', carries_addendum: true },
    { slug: 'new-member',     hume_config_id: 'c-n', hume_prompt_id: 'p-n', carries_addendum: false },
    { slug: 'implementation', hume_config_id: 'c-i', hume_prompt_id: 'p-i', carries_addendum: false },
  ];
}

function wrap(preamble: string, body: string, hash: string, begin: string, end: string): string {
  return `${preamble}\n${begin} v=${hash} -->\n${body}\n${end}\n(tail)`;
}

function baseDeps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  const defaults: SyncDeps = {
    buildBundle: async () => ({ text: 'NEW_BUNDLE', hash: 'h-new', blockNames: ['SECURITY_BOUNDARY_BLOCK'] }),
    buildAddendum: async () => ({ text: 'NEW_ADDENDUM', hash: 'h-add', blockNames: ['BRANDED_ACRONYM_EXPANSION_BLOCK'] }),
    loadRegistry: async () => buildRegistry(),
    loadLastBundleHash: async () => 'h-old',
    loadLastAddendumHash: async () => 'h-add-old',
    saveLastBundleHash: async () => {},
    saveLastAddendumHash: async () => {},
    hume: {
      getPromptLatest: async (pid: string) => ({ id: pid, version: 1, text: wrap('pre', 'OLD_BODY', 'h-old', SHARED_BEGIN, SHARED_END) }),
      postPromptVersion: async () => 2,
      getConfigLatest: async (cid: string) => ({ id: cid, version: 5, promptId: cid.replace('c-','p-'), promptVersion: 1, raw: { id: cid, version: 5, prompt: { id: cid.replace('c-','p-'), version: 1 }, voice: { name: 'Philip' } } }),
      postConfigVersion: async () => 6,
    },
    updateRegistryRow: async () => {},
    trigger: 'test',
    log: () => {},
  };
  return { ...defaults, ...overrides };
}

Deno.test('noop when bundle+addendum hashes unchanged', async () => {
  const deps = baseDeps({
    loadLastBundleHash: async () => 'h-new',     // matches current
    loadLastAddendumHash: async () => 'h-add',   // matches current
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
        assert(text.includes('NEW_BUNDLE'));
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
        if (text.includes('NEW_ADDENDUM')) addendumPromptCalls++;
        return 2;
      },
    },
  });
  await runSync(deps);
  // Addendum body ends up in exactly one config's prompt text (discovery).
  assertEquals(addendumPromptCalls, 1);
});
