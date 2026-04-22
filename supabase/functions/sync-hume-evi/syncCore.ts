// syncCore.ts — dependency-injected orchestration for the Hume EVI sync.
// All I/O (Hume, Supabase, sync_state) arrives via the SyncDeps interface so
// tests can drive every code path without a network or a database.
//
// Variant-awareness (2026-04-21): rows in ops.hume_config_registry carry a
// bundle_variant ('full' | 'voice'). Each variant renders its own bundle +
// addendum and tracks its own last-synced hash. Rows sync only when their
// variant's hash changes — preventing a voice-only edit from re-posting the
// full-variant configs (New Member + Implementation Coach) to Hume and vice
// versa.

import {
  SHARED_BEGIN,
  SHARED_END,
  ADDENDUM_BEGIN,
  ADDENDUM_END,
  spliceMarkerRegion,
} from './markers.ts';
import type { HumePrompt, HumeConfig } from './humeClient.ts';

export type BundleVariant = 'full' | 'voice';

export interface RegistryRow {
  slug: 'discovery' | 'new-member' | 'implementation';
  hume_config_id: string;
  hume_prompt_id: string;
  carries_addendum: boolean;
  bundle_variant: BundleVariant;
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
  buildBundle: (variant: BundleVariant) => Promise<BundleOut>;
  buildAddendum: (variant: BundleVariant) => Promise<BundleOut>;
  loadRegistry: () => Promise<RegistryRow[]>;
  loadLastBundleHash: (variant: BundleVariant) => Promise<string | null>;
  loadLastAddendumHash: (variant: BundleVariant) => Promise<string | null>;
  saveLastBundleHash: (variant: BundleVariant, hash: string) => Promise<void>;
  saveLastAddendumHash: (variant: BundleVariant, hash: string) => Promise<void>;
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
  let registry: RegistryRow[];
  try {
    registry = await deps.loadRegistry();
  } catch (err) {
    return emptyResult('error', `loadRegistry failed: ${(err as Error).message}`);
  }

  if (registry.length === 0) {
    return emptyResult('error', 'registry is empty — seed ops.hume_config_registry before syncing');
  }

  // Compute bundle + addendum for every variant the registry references.
  const variants: BundleVariant[] = Array.from(new Set(registry.map(r => r.bundle_variant)));
  const bundleByVariant = new Map<BundleVariant, BundleOut>();
  const addendumByVariant = new Map<BundleVariant, BundleOut>();
  const bundleChangedByVariant = new Map<BundleVariant, boolean>();
  const addendumChangedByVariant = new Map<BundleVariant, boolean>();

  for (const v of variants) {
    const bundle = await deps.buildBundle(v);
    const addendum = await deps.buildAddendum(v);
    bundleByVariant.set(v, bundle);
    addendumByVariant.set(v, addendum);
    const lastBundleHash = await deps.loadLastBundleHash(v);
    const lastAddendumHash = await deps.loadLastAddendumHash(v);
    bundleChangedByVariant.set(v, lastBundleHash !== bundle.hash);
    addendumChangedByVariant.set(v, lastAddendumHash !== addendum.hash);
  }

  const anyBundleChanged = Array.from(bundleChangedByVariant.values()).some(Boolean);
  const anyAddendumChanged = Array.from(addendumChangedByVariant.values()).some(Boolean);

  // Pick a representative bundle/addendum for the audit log. Prefer 'full'
  // (preserves pre-variant behavior for dashboards); fall back to first variant.
  const auditVariant: BundleVariant = bundleByVariant.has('full') ? 'full' : [...variants].sort()[0];
  const auditBundle = bundleByVariant.get(auditVariant)!;
  const auditAddendum = addendumByVariant.get(auditVariant)!;

  if (!anyBundleChanged && !anyAddendumChanged) {
    deps.log('noop: all variant hashes unchanged', { variants });
    return {
      status: 'noop',
      bundleHash: auditBundle.hash,
      addendumHash: auditAddendum.hash,
      bundleChanged: false,
      configsChecked: 0,
      configsUpdated: 0,
      configsFailed: 0,
      humeVersions: [],
    };
  }

  // Only sync rows whose variant has a change.
  const rowsToSync = registry.filter(row => {
    const bundleChanged = bundleChangedByVariant.get(row.bundle_variant) ?? false;
    const addendumChanged = addendumChangedByVariant.get(row.bundle_variant) ?? false;
    return bundleChanged || (row.carries_addendum && addendumChanged);
  });

  const entries: SyncVersionEntry[] = [];
  await Promise.all(
    rowsToSync.map(async (row) => {
      try {
        const bundle = bundleByVariant.get(row.bundle_variant)!;
        const addendum = addendumByVariant.get(row.bundle_variant)!;
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
  if (configsFailed === 0 && configsUpdated > 0) status = 'ok';
  else if (configsUpdated === 0 && configsFailed > 0) status = 'error';
  else if (configsUpdated > 0 && configsFailed > 0) status = 'partial';
  else status = 'noop';

  // Advance per-variant hashes only where at least one ROW OF THAT VARIANT succeeded.
  // Bundle and addendum hashes are saved independently: bundle saves if any
  // row of the variant succeeded; addendum saves only if at least one succeeded
  // row of the variant actually carries the addendum (otherwise no addendum was
  // posted and advancing the hash would cause the next sync to falsely skip).
  if (configsUpdated > 0) {
    const succeededSlugs = new Set(
      entries.filter(e => !e.error).map(e => e.slug),
    );
    for (const v of variants) {
      const rowsForVariant = registry.filter(r => r.bundle_variant === v);
      const bundleRowSucceeded = rowsForVariant.some(r => succeededSlugs.has(r.slug));
      const addendumRowSucceeded = rowsForVariant.some(
        r => r.carries_addendum && succeededSlugs.has(r.slug),
      );

      if (bundleRowSucceeded && bundleChangedByVariant.get(v)) {
        await deps.saveLastBundleHash(v, bundleByVariant.get(v)!.hash);
      }
      if (addendumRowSucceeded && addendumChangedByVariant.get(v)) {
        await deps.saveLastAddendumHash(v, addendumByVariant.get(v)!.hash);
      }
    }
  }

  return {
    status,
    bundleHash: auditBundle.hash,
    addendumHash: auditAddendum.hash,
    bundleChanged: anyBundleChanged,
    configsChecked: registry.length,
    configsUpdated,
    configsFailed,
    humeVersions: entries,
  };
}

function emptyResult(status: SyncResult['status'], error: string): SyncResult {
  return {
    status,
    bundleHash: '',
    addendumHash: '',
    bundleChanged: false,
    configsChecked: 0,
    configsUpdated: 0,
    configsFailed: 0,
    humeVersions: [],
    error,
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

  const desc = `salesVoice sync ${deps.trigger} (${row.bundle_variant}): bundle=${bundle.hash.slice(0, 12)}${row.carries_addendum ? ` addendum=${addendum.hash.slice(0, 12)}` : ''}`;
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
