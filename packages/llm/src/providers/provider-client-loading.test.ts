import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KodaXProviderConfig } from '../types.js';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';

const CONFIG: KodaXProviderConfig = {
  apiKeyEnv: 'TEST_API_KEY',
  model: 'test-model',
  supportsThinking: false,
  contextWindow: 128_000,
};

class TestAnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'test-anthropic-client-loading';
  protected readonly config = CONFIG;
  buildCount = 0;

  constructor(private readonly builder: () => Promise<Anthropic>) {
    super();
  }

  protected override buildClient(): Promise<Anthropic> {
    this.buildCount += 1;
    return this.builder();
  }

  loadClient(): Promise<Anthropic> {
    return this.getClient();
  }

  markConnectionStale(): void {
    this.onStaleConnection();
  }
}

class TestOpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'test-openai-client-loading';
  protected readonly config = CONFIG;
  buildCount = 0;

  constructor(private readonly builder: () => Promise<OpenAI>) {
    super();
  }

  protected override buildClient(): Promise<OpenAI> {
    this.buildCount += 1;
    return this.builder();
  }

  loadClient(): Promise<OpenAI> {
    return this.getClient();
  }
}

class GatewayAnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'test-anthropic-gateway';
  protected readonly config: KodaXProviderConfig = {
    ...CONFIG,
    baseUrl: 'https://gateway.example.test/anthropic',
  };

  loadClient(): Promise<Anthropic> {
    return this.getClient();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('provider client loading', () => {
  it('keeps one Anthropic replacement build when stale errors overlap', async () => {
    const oldClient = {} as Anthropic;
    const replacementClient = {} as Anthropic;
    let resolveReplacement: ((client: Anthropic) => void) | undefined;
    const replacement = new Promise<Anthropic>((resolve) => {
      resolveReplacement = resolve;
    });
    let buildIndex = 0;
    const provider = new TestAnthropicProvider(() => {
      buildIndex += 1;
      return buildIndex === 1 ? Promise.resolve(oldClient) : replacement;
    });

    expect(await provider.loadClient()).toBe(oldClient);
    provider.markConnectionStale();
    const firstReplacementLoad = provider.loadClient();
    provider.markConnectionStale();
    const secondReplacementLoad = provider.loadClient();

    expect(provider.buildCount).toBe(2);
    resolveReplacement?.(replacementClient);
    await expect(firstReplacementLoad).resolves.toBe(replacementClient);
    await expect(secondReplacementLoad).resolves.toBe(replacementClient);
  });

  it('coalesces concurrent OpenAI client initialization', async () => {
    const client = {} as OpenAI;
    let resolveClient: ((value: OpenAI) => void) | undefined;
    const pendingClient = new Promise<OpenAI>((resolve) => {
      resolveClient = resolve;
    });
    const provider = new TestOpenAIProvider(() => pendingClient);

    const firstLoad = provider.loadClient();
    const secondLoad = provider.loadClient();

    expect(provider.buildCount).toBe(1);
    resolveClient?.(client);
    await expect(firstLoad).resolves.toBe(client);
    await expect(secondLoad).resolves.toBe(client);
    await expect(provider.loadClient()).resolves.toBe(client);
    expect(provider.buildCount).toBe(1);
  });

  it('retries Anthropic client initialization after a rejection', async () => {
    const client = {} as Anthropic;
    let shouldReject = true;
    const provider = new TestAnthropicProvider(() => {
      if (shouldReject) {
        shouldReject = false;
        return Promise.reject(new Error('first load failed'));
      }
      return Promise.resolve(client);
    });

    await expect(provider.loadClient()).rejects.toThrow('first load failed');
    await expect(provider.loadClient()).resolves.toBe(client);
    expect(provider.buildCount).toBe(2);
  });

  it('retries OpenAI client initialization after a rejection', async () => {
    const client = {} as OpenAI;
    let shouldReject = true;
    const provider = new TestOpenAIProvider(() => {
      if (shouldReject) {
        shouldReject = false;
        return Promise.reject(new Error('first load failed'));
      }
      return Promise.resolve(client);
    });

    await expect(provider.loadClient()).rejects.toThrow('first load failed');
    await expect(provider.loadClient()).resolves.toBe(client);
    expect(provider.buildCount).toBe(2);
  });

  it('sends only the configured key to an Anthropic-compatible gateway', async () => {
    vi.stubEnv('TEST_API_KEY', 'configured-provider-key');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'inherited-anthropic-token');
    const requests: Headers[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      requests.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ data: [], has_more: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = await new GatewayAnthropicProvider().loadClient();
    await client.models.list();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.get('x-api-key')).toBe('configured-provider-key');
    expect(requests[0]?.get('authorization')).toBeNull();
  });
});
