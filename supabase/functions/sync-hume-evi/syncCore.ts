// syncCore.ts — dependency-injected orchestration for the Hume EVI sync.
// All I/O (Hume, Supabase, sync_state) arrives via the SyncDeps interface so
// tests can drive every code path without a network or a database.

import {
  SHARED_BEGIN,
  SHARED_END,
  ADDENDUM_BEGIN,
  ADDENDUM_END,
  spliceMarkerRegion,
} from './markers.ts';
import type { HumePrompt, HumeConfig } from './humeClient.ts';

export interface RegistryRow {
  slug: 'discovery' | 'new-member' | 'implementation';
  hume_config_id: string;
  hume_prompt_id: string;
  carries_addendum: boolean;
}

export interface BundleOut {
  text: string;
  hash: string;
  blockNames: string[];
}

// Stripped-down HumeClient surface for injection
export interface HumeClientLite {
  getPromptLatest(promptId: string): Promise<HumePrompt>;
  postPromptVersion(promptId: string, text: string, versionDescription: string): Promise<number>;
  getConfigLatest(configId: string): Promise<HumeConfig>;
  postConfigVersion(configId: string, currentRaw: Record<string, unknown>, newPromptRef: { id: string; version: number }, versionDescription: string): Promise<number>;
}

export interface SyncDeps {
  buildBundle: () => Promise<BundleOut>;
  buildAddendum: () => Promise<BundleOut>;
  loadRegistry: () => Promise<RegistryRow[]>;
  loadLastBundleHash: () => Promise<string | null>;
  loadLastAddendumHash: () => Promise<string | null>;
  saveLastBundleHash: (hash: string) => Promise<void>;
  saveLastAddendumHash: (hash: string) => Promise<void>;
  updateRegistryRow: (slug: string, patch: { last_prompt_ver: number; last_config_ver: number; last_synced_at: string }) => Promise<void>;
  hume: HumeClientLite;
  trigger: 'cron' | 'admin' | 'test';
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface SyncVersionEntry {
  slug: string;
  prompt_version?: number;
  config_version?: number;
  error?: string;
}

export interface SyncResult {
  status: 'ok' | 'noop' | 'partial' | 'error';
  bundleHash: string;
  addendumHash: string;
  bundleChanged: boolean;
  configsChecked: number;
  configsUpdated: number;
  configsFailed: number;
  humeVersions: SyncVersionEntry[];
  error?: string;
}

export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const bundle = await deps.buildBundle();
  const addendum = await deps.buildAddendum();
  const lastBundleHash = await deps.loadLastBundleHash();
  const lastAddendumHash = await deps.loadLastAddendumHash();

  const bundleChanged = lastBundleHash !== bundle.hash;
  const addendumChanged = lastAddendumHash !== addendum.hash;

  if (!bundleChanged && !addendumChanged) {
    deps.log('noop: bundle+addendum hashes unchanged', { bundleHash: bundle.hash });
    return {
      status: 'noop',
      bundleHash: bundle.hash,
      addendumHash: addendum.hash,
      bundleChanged: false,
      configsChecked: 0,
      configsUpdated: 0,
      configsFailed: 0,
      humeVersions: [],
    };
  }

  let registry: RegistryRow[];
  try {
    registry = await deps.loadRegistry();
  } catch (err) {
    return {
      status: 'error',
      bundleHash: bundle.hash,
      addendumHash: addendum.hash,
      bundleChanged,
      configsChecked: 0,
      configsUpdated: 0,
      configsFailed: 0,
      humeVersions: [],
      error: `loadRegistry failed: ${(err as Error).message}`,
    };
  }

  if (registry.length === 0) {
    return {
      status: 'error',
      bundleHash: bundle.hash,
      addendumHash: addendum.hash,
      bundleChanged,
      configsChecked: 0,
      configsUpdated: 0,
      configsFailed: 0,
      humeVersions: [],
      error: 'registry is empty — seed ops.hume_config_registry before syncing',
    };
  }

  const entries: SyncVersionEntry[] = [];
  await Promise.all(
    registry.map(async (row) => {
      try {
        const v = await syncOneConfig(row, bundle, addendum, deps);
        entries.push({ slug: row.slug, prompt_version: v.promptVersion, config_version: v.configVersion });
        await deps.updateRegistryRow(row.slug, {
          last_prompt_ver: v.promptVersion,
          last_config_ver: v.configVersion,
          last_synced_at: new Date().toISOString(),
        });
      } catch (err) {
        entries.push({ slug: row.slug, error: (err as Error).message });
        deps.log(`config ${row.slug} failed: ${(err as Error).message}`);
      }
    }),
  );

  const configsUpdated = entries.filter((e) => !e.error).length;
  const configsFailed = entries.filter((e) => e.error).length;

  let status: SyncResult['status'];
  if (configsFailed === 0) status = 'ok';
  else if (configsUpdated === 0) status = 'error';
  else status = 'partial';

  // Only advance the hash if at least one config succeeded — prevents "we think
  // we synced but didn't" drift.
  if (configsUpdated > 0) {
    if (bundleChanged) await deps.saveLastBundleHash(bundle.hash);
    if (addendumChanged) await deps.saveLastAddendumHash(addendum.hash);
  }

  return {
    status,
    bundleHash: bundle.hash,
    addendumHash: addendum.hash,
    bundleChanged,
    configsChecked: registry.length,
    configsUpdated,
    configsFailed,
    humeVersions: entries,
  };
}

async function syncOneConfig(
  row: RegistryRow,
  bundle: BundleOut,
  addendum: BundleOut,
  deps: SyncDeps,
): Promise<{ promptVersion: number; configVersion: number }> {
  const current = await deps.hume.getPromptLatest(row.hume_prompt_id);
  let newText = spliceMarkerRegion(
    current.text,
    { begin: SHARED_BEGIN, end: SHARED_END },
    bundle.text,
    bundle.hash.slice(0, 12),
  );
  if (row.carries_addendum) {
    newText = spliceMarkerRegion(
      newText,
      { begin: ADDENDUM_BEGIN, end: ADDENDUM_END },
      addendum.text,
      addendum.hash.slice(0, 12),
    );
  }

  const desc = `salesVoice sync ${deps.trigger}: bundle=${bundle.hash.slice(0, 12)}${row.carries_addendum ? ` addendum=${addendum.hash.slice(0, 12)}` : ''}`;
  const promptVersion = await deps.hume.postPromptVersion(row.hume_prompt_id, newText, desc);

  const currentConfig = await deps.hume.getConfigLatest(row.hume_config_id);
  const configVersion = await deps.hume.postConfigVersion(
    row.hume_config_id,
    currentConfig.raw,
    { id: row.hume_prompt_id, version: promptVersion },
    desc,
  );

  return { promptVersion, configVersion };
}
