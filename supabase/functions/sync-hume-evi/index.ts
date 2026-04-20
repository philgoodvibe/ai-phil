import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  buildHumeSharedBundle,
  buildHumeDiscoveryAddendum,
} from '../_shared/salesVoice.ts';
import { HumeClient, type HumeProxyFetch, type HumeProxyResponse } from './humeClient.ts';
import { runSync, type RegistryRow } from './syncCore.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const HUME_TOOL_SECRET = Deno.env.get('HUME_TOOL_SECRET')!;
const HUME_ADMIN_URL = `${SUPABASE_URL}/functions/v1/hume-admin`;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

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

  let body: { trigger?: 'cron' | 'admin' | 'test' };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const trigger = body.trigger ?? 'admin';

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
      trigger,
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
    const result = await runSync({
      buildBundle: buildHumeSharedBundle,
      buildAddendum: buildHumeDiscoveryAddendum,
      loadRegistry: async () => {
        const { data, error } = await supabase
          .schema('ops')
          .from('hume_config_registry')
          .select('slug, hume_config_id, hume_prompt_id, carries_addendum');
        if (error) throw new Error(`registry load: ${error.message}`);
        return (data ?? []) as RegistryRow[];
      },
      // sync_state is in the public schema (see migration 20260415000000_sync_state.sql)
      loadLastBundleHash: async () => loadSyncState('hume_evi_last_bundle_hash'),
      // Addendum hash is keyed per-slug because future configs could each carry
      // their own addendum. Today only 'discovery' carries_addendum=true, so
      // this is the only key. If more configs become carries_addendum=true,
      // replace this with a per-slug key inside updateRegistryRow.
      loadLastAddendumHash: async () => loadSyncState('hume_evi_last_addendum_hash:discovery'),
      saveLastBundleHash: (h) => saveSyncState('hume_evi_last_bundle_hash', h),
      saveLastAddendumHash: (h) => saveSyncState('hume_evi_last_addendum_hash:discovery', h),
      updateRegistryRow: async (slug, patch) => {
        const { error } = await supabase
          .schema('ops')
          .from('hume_config_registry')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('slug', slug);
        if (error) throw new Error(`registry update ${slug}: ${error.message}`);
      },
      hume: humeClient,
      trigger,
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
