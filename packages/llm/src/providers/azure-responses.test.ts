import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import { createCloudProviderConfig } from '../cloud/provider-config.js';
import { serializeCloudCredential } from '../cloud/credentials.js';
import { runWithProviderCredential } from '../provider-credential-context.js';
import { createProviderConnection } from '../provider-presets.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['api-key', 'bearer'] as const)('supports explicit Azure Completions with a %s and a normalized deployment endpoint', async type => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
  vi.stubGlobal('fetch', fetch);
  const config = createProviderConnection('azure', { name: 'azure-completions', model: 'deployment', apiId: 'openai-completions', baseUrl: 'https://resource.openai.azure.com' });
  const credential = type === 'api-key' ? { type, key: 'selected-key' } : { type, token: 'selected-bearer' };
  await runWithProviderCredential(config.name, serializeCloudCredential(config.name, credential), () => createCustomProvider(config).complete([], [], '', undefined, { singleAttempt: true }));
  expect(fetch.mock.calls[0]?.[0]).toBe('https://resource.openai.azure.com/openai/v1/chat/completions');
  const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
  expect(headers.get('api-key')).toBe(type === 'api-key' ? 'selected-key' : null);
  expect(headers.get('authorization')).toBe(type === 'bearer' ? 'Bearer selected-bearer' : null);
});
describe('Azure native Responses authentication', () => {
  it.each(['api-key', 'bearer'] as const)('uses only the explicit %s request credential and deployment model', async type => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ status: 'completed', output: [] }));
    vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'azure', name: 'azure-test', model: 'deployment-a', endpoint: 'https://resource.openai.azure.com' });
    const provider = createCustomProvider(config);
    const credential = type === 'api-key' ? { type, key: 'azure-secret' } : { type, token: 'entra-token', expiresAt: Date.now() + 3600_000 };
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, credential), () => provider.complete([], [], 'system'));
    expect(fetch.mock.calls[0]?.[0]).toBe('https://resource.openai.azure.com/openai/v1/responses');
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('api-key')).toBe(type === 'api-key' ? 'azure-secret' : null);
    expect(headers.get('authorization')).toBe(type === 'bearer' ? 'Bearer entra-token' : null);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ model: 'deployment-a', stream: false, store: false });
    vi.stubEnv(config.apiKeyEnv, 'must-not-use-ambient');
    await expect(provider.complete([], [], '')).rejects.toThrow(/cloud|broker/i);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not let ambient SDK custom headers override an explicit Entra grant', async () => {
    vi.stubEnv('OPENAI_CUSTOM_HEADERS', 'Authorization: Bearer ambient-token\napi-key: ambient-key\nOpenAI-Organization: ambient-org');
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ status: 'completed', output: [] })); vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'azure', name: 'azure-test', model: 'deployment', endpoint: 'https://resource.openai.azure.com' });
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'explicit-token' }), () => createCustomProvider(config).complete([], [], ''));
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer explicit-token');
    expect(headers.get('api-key')).toBeNull(); expect(headers.get('openai-organization')).toBeNull();
  });
});
