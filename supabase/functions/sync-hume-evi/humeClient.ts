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
    const r = await this.proxyFetch({ method: 'GET', path: `/v0/evi/prompts/${promptId}` });
    if (!r.ok) throw new Error(`Hume GET prompt ${promptId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const b = r.body as { id: string; version: number; text: string };
    if (!b.id || typeof b.version !== 'number' || typeof b.text !== 'string') {
      throw new Error(`Hume GET prompt ${promptId} returned unexpected shape: ${JSON.stringify(b)}`);
    }
    return { id: b.id, version: b.version, text: b.text };
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
    const r = await this.proxyFetch({ method: 'GET', path: `/v0/evi/configs/${configId}` });
    if (!r.ok) throw new Error(`Hume GET config ${configId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const b = r.body as { id: string; version: number; prompt?: { id?: string; version?: number } };
    if (!b.prompt?.id || typeof b.prompt.version !== 'number') {
      throw new Error(`Hume GET config ${configId} missing prompt reference: ${JSON.stringify(b)}`);
    }
    return {
      id: b.id,
      version: b.version,
      promptId: b.prompt.id,
      promptVersion: b.prompt.version,
      raw: b as unknown as Record<string, unknown>,
    };
  }

  async postConfigVersion(
    configId: string,
    currentConfigBody: Record<string, unknown>,
    newPromptRef: { id: string; version: number },
  ): Promise<number> {
    // Carry over everything from the current config EXCEPT id/version (Hume sets those)
    // and replace `prompt` with the new reference.
    const { id: _id, version: _version, ...carryOver } = currentConfigBody;
    void _id;
    void _version;
    const payload = { ...carryOver, prompt: newPromptRef };
    const r = await this.proxyFetch({ method: 'POST', path: `/v0/evi/configs/${configId}`, payload });
    if (!r.ok) throw new Error(`Hume POST config ${configId} failed: ${r.status} ${JSON.stringify(r.body)}`);
    const v = (r.body as { version?: number }).version;
    if (typeof v !== 'number') {
      throw new Error(`Hume POST config ${configId} returned no version: ${JSON.stringify(r.body)}`);
    }
    return v;
  }
}
