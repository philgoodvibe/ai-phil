import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  buildHumeSharedBundle,
  buildHumeDiscoveryAddendum,
  buildHumeVoiceBundle,
  buildHumeDiscoveryVoiceAddendum,
  type HumeBundle,
} from '../_shared/salesVoice.ts';
import { HumeClient, type HumeProxyFetch, type HumeProxyResponse } from './humeClient.ts';
import { runSync, type RegistryRow, type BundleVariant } from './syncCore.ts';
import {
  SHARED_BEGIN, SHARED_END,
  ADDENDUM_BEGIN, ADDENDUM_END,
  makeMarkerBlock,
} from './markers.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const HUME_TOOL_SECRET = Deno.env.get('HUME_TOOL_SECRET')!;
const HUME_ADMIN_URL = `${SUPABASE_URL}/functions/v1/hume-admin`;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

// Variant dispatch — maps bundle_variant in ops.hume_config_registry to the
// corresponding salesVoice builder. The Record<BundleVariant, ...> annotation
// forces the TypeScript compiler to require an entry for every variant in the
// BundleVariant union — adding a new variant to the union will fail to compile
// until a matching dispatch entry lands here.
const VARIANT_BUILDERS: Record<BundleVariant, {
  bundle: () => Promise<HumeBundle>;
  addendum: () => Promise<HumeBundle>;
}> = {
  full: {
    bundle: buildHumeSharedBundle,
    addendum: buildHumeDiscoveryAddendum,
  },
  voice: {
    bundle: buildHumeVoiceBundle,
    addendum: buildHumeDiscoveryVoiceAddendum,
  },
};

const humeProxyFetch: HumeProxyFetch = async ({ method, path, payload }) => {
  const res = await fetch(HUME_ADMIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tool-secret': HUME_TOOL_SECRET,
    },
    body: JSON.stringify({ method, path, payload }),
  });
  const raw = await res.json() as unknown;
  if (
    typeof raw !== 'object' || raw === null ||
    !('ok' in raw) || !('status' in raw) || !('body' in raw)
  ) {
    throw new Error(`hume-admin returned unexpected shape: ${JSON.stringify(raw)}`);
  }
  const body = raw as HumeProxyResponse;
  // hume-admin already returns { status, ok, body } — pass through
  return body;
};

const humeClient = new HumeClient(humeProxyFetch);

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Bearer auth — matches sync-knowledge-base / ghl-sales-followup pattern.
  // pg_cron supplies supabase_anon_key; admin route supplies service_role.
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ') || auth.length < 27) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { trigger?: 'cron' | 'admin' | 'test' | 'bootstrap-inspect' | 'set-wrapper'; config_ids?: string[]; slug?: string; wrapper_text?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const trigger = body.trigger ?? 'admin';

  // Set-wrapper mode — rewrite the authored wrapper section of a single Hume EVI
  // config's prompt. Accepts {slug, wrapper_text}, builds the marker regions from
  // VARIANT_BUILDERS, composes the full prompt, and POSTs as a new prompt +
  // config version. Auth stays on the existing Bearer check — no new secret needed.
  if (trigger === 'set-wrapper') {
    const slug = (body as { slug?: string }).slug ?? '';
    const wrapperText = (body as { wrapper_text?: string }).wrapper_text ?? '';

    if (!slug) {
      return new Response(JSON.stringify({ error: 'slug is required for set-wrapper' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!wrapperText) {
      return new Response(JSON.stringify({ error: 'wrapper_text is required for set-wrapper' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Load the registry row for this slug.
    const { data: rows, error: registryErr } = await supabase
      .schema('ops')
      .from('hume_config_registry')
      .select('slug, hume_config_id, hume_prompt_id, carries_addendum, bundle_variant')
      .eq('slug', slug);

    if (registryErr) {
      return new Response(JSON.stringify({ error: `registry lookup failed: ${registryErr.message}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({ error: `slug '${slug}' not found in ops.hume_config_registry` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const row = rows[0] as RegistryRow;
    const variant = row.bundle_variant as BundleVariant;

    // Build bundle + addendum for this variant.
    const bundle = await VARIANT_BUILDERS[variant].bundle();
    const addendum = await VARIANT_BUILDERS[variant].addendum();

    // Compose: wrapper_text + SHARED marker block + optional ADDENDUM marker block.
    const sharedBlock = makeMarkerBlock(SHARED_BEGIN, SHARED_END, bundle.text, bundle.hash.slice(0, 12));
    let fullText = `${wrapperText}\n\n${sharedBlock}`;
    if (row.carries_addendum) {
      const addendumBlock = makeMarkerBlock(ADDENDUM_BEGIN, ADDENDUM_END, addendum.text, addendum.hash.slice(0, 12));
      fullText = `${fullText}\n\n${addendumBlock}`;
    }

    const totalChars = fullText.length;
    const description = `set-wrapper via admin: slug=${slug}, variant=${variant}, total_chars=${totalChars}`;

    // POST new prompt version.
    const promptVersion = await humeClient.postPromptVersion(row.hume_prompt_id, fullText, description);

    // POST new config version pinned to the new prompt version.
    const currentConfig = await humeClient.getConfigLatest(row.hume_config_id);
    const configVersion = await humeClient.postConfigVersion(
      row.hume_config_id,
      currentConfig.raw,
      { id: row.hume_prompt_id, version: promptVersion },
      description,
    );

    // Write audit row.
    const { data: swRun, error: swRunErr } = await supabase
      .schema('ops')
      .from('hume_sync_runs')
      .insert({
        trigger: 'set-wrapper',
        bundle_hash: bundle.hash,
        addendum_hash: addendum.hash,
        bundle_changed: true,
        status: 'ok',
        configs_checked: 1,
        configs_updated: 1,
        configs_failed: 0,
        hume_versions: [{ slug, prompt_version: promptVersion, config_version: configVersion }],
        completed_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (swRunErr) {
      console.error('[sync-hume-evi] set-wrapper audit row insert error:', swRunErr.message);
    }

    // Update registry row with new versions.
    await supabase
      .schema('ops')
      .from('hume_config_registry')
      .update({ last_prompt_ver: promptVersion, last_config_ver: configVersion, updated_at: new Date().toISOString() })
      .eq('slug', slug);

    return new Response(
      JSON.stringify({
        run_id: swRun?.id ?? null,
        slug,
        prompt_version: promptVersion,
        config_version: configVersion,
        total_chars: totalChars,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Bootstrap-inspect mode — one-time read-only fetch of config + prompt metadata
  // for each config_id in the payload. Used by the seed migration to populate
  // ops.hume_config_registry without needing HUME_TOOL_SECRET on a developer
  // workstation (the secret stays in Supabase edge-function env — one source of
  // truth). No ops.hume_sync_runs row is written; no Hume POST is made.
  if (trigger === 'bootstrap-inspect') {
    const configIds = (body as { config_ids?: string[] }).config_ids ?? [];
    if (!Array.isArray(configIds) || configIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "config_ids array required in body for bootstrap-inspect" }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const results: Array<Record<string, unknown>> = [];
    for (const cid of configIds) {
      try {
        const cfg = await humeClient.getConfigLatest(cid);
        results.push({
          config_id: cid,
          config_version: cfg.version,
          prompt_id: cfg.promptId,
          prompt_version: cfg.promptVersion,
        });
      } catch (err) {
        results.push({ config_id: cid, error: (err as Error).message });
      }
    }
    return new Response(JSON.stringify({ mode: 'bootstrap-inspect', results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const realTrigger = trigger as 'cron' | 'admin' | 'test';

  // Invariant: we insert a "running" row BEFORE runSync so failures leave an
  // audit trail. Known limitation: if the edge-runtime isolate dies between
  // this insert and the try/catch update (OOM, timeout, unhandled rejection
  // outside the try block), the row stays 'running' permanently. Mitigation
  // deferred to a pg_cron sweeper — see vault/60-content/ai-phil/_ROADMAP.md
  // "Hume sync stale-running sweeper" follow-up. A human inspecting the audit
  // table sees stale rows obviously; at nightly cadence this is acceptable.
  const { data: runInsert, error: runInsertErr } = await supabase
    .schema('ops')
    .from('hume_sync_runs')
    .insert({
      trigger: realTrigger,
      bundle_hash: 'pending',
      bundle_changed: false,
      status: 'running',
    })
    .select('id')
    .single();

  if (runInsertErr || !runInsert) {
    console.error('[sync-hume-evi] could not insert run row:', runInsertErr);
    return new Response(JSON.stringify({ error: 'audit_insert_failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const runId: number = runInsert.id as number;

  try {
    // Per-variant sync_state keys: hume_evi_last_bundle_hash:{variant} + hume_evi_last_addendum_hash:{variant}
    const result = await runSync({
      buildBundle: (variant) => VARIANT_BUILDERS[variant].bundle(),
      buildAddendum: (variant) => VARIANT_BUILDERS[variant].addendum(),
      loadRegistry: async () => {
        const { data, error } = await supabase
          .schema('ops')
          .from('hume_config_registry')
          .select('slug, hume_config_id, hume_prompt_id, carries_addendum, bundle_variant');
        if (error) throw new Error(`registry load: ${error.message}`);
        return (data ?? []) as RegistryRow[];
      },
      loadLastBundleHash: async (variant) => loadSyncState(`hume_evi_last_bundle_hash:${variant}`),
      loadLastAddendumHash: async (variant) => loadSyncState(`hume_evi_last_addendum_hash:${variant}`),
      saveLastBundleHash: (variant, h) => saveSyncState(`hume_evi_last_bundle_hash:${variant}`, h),
      saveLastAddendumHash: (variant, h) => saveSyncState(`hume_evi_last_addendum_hash:${variant}`, h),
      updateRegistryRow: async (slug, patch) => {
        const { error } = await supabase
          .schema('ops')
          .from('hume_config_registry')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('slug', slug);
        if (error) throw new Error(`registry update ${slug}: ${error.message}`);
      },
      hume: humeClient,
      trigger: realTrigger,
      log: (m, meta) => console.log(`[sync-hume-evi] ${m}`, meta ?? ''),
    });

    await supabase
      .schema('ops')
      .from('hume_sync_runs')
      .update({
        completed_at: new Date().toISOString(),
        bundle_hash: result.bundleHash,
        addendum_hash: result.addendumHash,
        bundle_changed: result.bundleChanged,
        configs_checked: result.configsChecked,
        configs_updated: result.configsUpdated,
        configs_failed: result.configsFailed,
        hume_versions: result.humeVersions,
        error: result.error ?? null,
        status: result.status,
      })
      .eq('id', runId);

    if (result.status === 'partial' || result.status === 'error') {
      await writeAgentSignal({
        source_agent: 'sync-hume-evi',
        target_agent: 'quimby',
        signal_type: 'hume_sync_issue',
        status: result.status,
        priority: 3,
        payload: { run_id: runId, configs_failed: result.configsFailed, entries: result.humeVersions },
      });
      await postGoogleChat(
        `⚠️ Hume EVI sync ${result.status}: ${result.configsFailed}/${result.configsChecked} configs failed (run ${runId}).`,
      );
    }

    return new Response(JSON.stringify({ run_id: runId, ...result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = (err as Error).message;
    await supabase
      .schema('ops')
      .from('hume_sync_runs')
      .update({
        completed_at: new Date().toISOString(),
        status: 'error',
        error: msg,
      })
      .eq('id', runId);
    await postGoogleChat(`🚨 Hume EVI sync THREW: ${msg} (run ${runId}).`);
    return new Response(JSON.stringify({ run_id: runId, error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});

// sync_state is public schema (20260415000000_sync_state.sql) — no .schema() call needed.
async function loadSyncState(key: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('sync_state')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw new Error(`sync_state load ${key}: ${error.message}`);
  return (data?.value as string | null) ?? null;
}

async function saveSyncState(key: string, value: string): Promise<void> {
  const { error } = await supabase
    .from('sync_state')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(`sync_state save ${key}: ${error.message}`);
}

interface AgentSignalPayload {
  source_agent: string;
  target_agent: string;
  signal_type: string;
  status?: string;
  channel?: string;
  priority?: number;
  payload?: Record<string, unknown>;
}

async function writeAgentSignal(sig: AgentSignalPayload): Promise<void> {
  try {
    const { error } = await supabase.from('agent_signals').insert({
      source_agent: sig.source_agent,
      target_agent: sig.target_agent,
      signal_type: sig.signal_type,
      status: sig.status ?? 'delivered',
      channel: sig.channel ?? 'open',
      priority: sig.priority ?? 5,
      payload: sig.payload ?? {},
    });
    if (error) console.error('[agent_signals] insert error:', error.message);
  } catch (err) {
    console.error('[agent_signals] write threw:', err);
  }
}

async function postGoogleChat(text: string): Promise<void> {
  const url = Deno.env.get('GOOGLE_CHAT_WEBHOOK_URL');
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('[gchat] post threw:', err);
  }
}
