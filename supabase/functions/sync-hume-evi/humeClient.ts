// humeClient.ts — typed wrapper over the hume-admin edge function proxy.
// Centralizes request shape and response parsing for the sync function.

export interface HumeProxyResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

export interface HumeProxyRequest {
  method: 'GET' | 'POST';
  path: string;
  payload?: unknown;
}

export type HumeProxyFetch = (req: HumeProxyRequest) => Promise<HumeProxyResponse>;

export interface HumePrompt {
  id: string;
  version: number;
  text: string;
}

export interface HumeConfig {
  id: string;
  version: number;
  promptId: string;
  promptVersion: number;
  raw: Record<string, unknown>;   // full current config body, for carry-over on new version
}

export class HumeClient {
  constructor(private readonly proxyFetch: HumeProxyFetch) {}

  async getPromptLatest(promptId: string): Promise<HumePrompt> {
    // Hume returns prompts as a paged list (newest-first). page_size=1 fetches
    // only the latest version.
    const r = await this.proxyFetch({
      method: 'GET',
      path: `/v0/evi/prompts/${promptId}?page_size=1&page_number=0`,
    });
    if (!r.ok) throw new Error(`Hume GET prompt ${promptId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const paged = r.body as { prompts_page?: Array<Record<string, unknown>> };
    const latest = paged.prompts_page?.[0];
    if (!latest) {
      throw new Error(`Hume GET prompt ${promptId} returned empty prompts_page: ${JSON.stringify(r.body)}`);
    }
    const version = latest.version;
    const text = latest.text;
    if (typeof version !== 'number' || typeof text !== 'string') {
      throw new Error(`Hume GET prompt ${promptId} latest version missing text/version: ${JSON.stringify(latest)}`);
    }
    return { id: promptId, version, text };
  }

  async postPromptVersion(promptId: string, text: string, versionDescription: string): Promise<number> {
    const r = await this.proxyFetch({
      method: 'POST',
      path: `/v0/evi/prompts/${promptId}`,
      payload: { text, versionDescription },
    });
    if (!r.ok) throw new Error(`Hume POST prompt ${promptId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const v = (r.body as { version?: number }).version;
    if (typeof v !== 'number') {
      throw new Error(`Hume POST prompt ${promptId} returned no version: ${JSON.stringify(r.body)}`);
    }
    return v;
  }

  async getConfigLatest(configId: string): Promise<HumeConfig> {
    // Hume returns configs as a paged list (newest-first). page_size=1 fetches
    // only the latest version; we discard older versions we don't need.
    const r = await this.proxyFetch({
      method: 'GET',
      path: `/v0/evi/configs/${configId}?page_size=1&page_number=0`,
    });
    if (!r.ok) throw new Error(`Hume GET config ${configId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const paged = r.body as { configs_page?: Array<Record<string, unknown>> };
    const latest = paged.configs_page?.[0];
    if (!latest) {
      throw new Error(`Hume GET config ${configId} returned empty configs_page: ${JSON.stringify(r.body)}`);
    }
    const version = latest.version;
    const prompt = latest.prompt as { id?: string; version?: number } | undefined;
    if (typeof version !== 'number' || !prompt?.id || typeof prompt.version !== 'number') {
      throw new Error(`Hume GET config ${configId} latest version missing prompt reference: ${JSON.stringify(latest)}`);
    }
    return {
      id: configId,
      version,
      promptId: prompt.id,
      promptVersion: prompt.version,
      raw: latest,
    };
  }

  async postConfigVersion(
    configId: string,
    currentConfigBody: Record<string, unknown>,
    newPromptRef: { id: string; version: number },
    versionDescription: string,
  ): Promise<number> {
    // Strip server-managed fields before carrying over. The new version gets
    // its own version_description; the old one describes the PRIOR version.
    const {
      id: _id,
      version: _version,
      created_on: _co,
      modified_on: _mo,
      version_description: _vd,
      ...carryOver
    } = currentConfigBody;
    void _id; void _version; void _co; void _mo; void _vd;
    const payload = { ...carryOver, prompt: newPromptRef, version_description: versionDescription };
    const r = await this.proxyFetch({ method: 'POST', path: `/v0/evi/configs/${configId}`, payload });
    if (!r.ok) throw new Error(`Hume POST config ${configId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const v = (r.body as { version?: number }).version;
    if (typeof v !== 'number') {
      throw new Error(`Hume POST config ${configId} returned no version: ${JSON.stringify(r.body)}`);
    }
    return v;
  }
}
