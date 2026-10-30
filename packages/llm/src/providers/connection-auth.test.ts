import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import { createOAuthProviderConfig } from '../oauth/provider-config.js';
import { runWithProviderCredential } from '../provider-credential-context.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['anthropic', 'openai'] as const)('sends only Cloudflare gateway authorization over %s', async protocol => {
  vi.stubEnv('TEST_GATEWAY_KEY', 'selected-gateway-key');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-token');
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{"error":{"message":"fixture"}}', { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  const provider = createCustomProvider({ name: 'gateway-test', protocol, authentication: 'cloudflare-gateway',
    baseUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway/provider', apiKeyEnv: 'TEST_GATEWAY_KEY', model: 'chosen', verifyStrategy: 'minimal-message' });
  await expect(provider.complete([], [], '', undefined, { singleAttempt: true, maxOutputTokensOverride: 16 })).rejects.toThrow('fixture');
  const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
  expect(headers.get('cf-aig-authorization')).toBe('Bearer selected-gateway-key');
  expect(headers.has('authorization')).toBe(false);
  expect(headers.has('x-api-key')).toBe(false);
});
it.each(['anthropic-messages', 'chat-completions', 'responses'] as const)('adds Copilot initiator metadata for %s without widening auth', async api => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ error: { message: 'fixture' } }, { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  const config = createOAuthProviderConfig({ service: 'github-copilot', name: `copilot-${api}`, model: 'chosen', api });
  await expect(runWithProviderCredential(config.name, 'inference-token', () => createCustomProvider(config).complete([{ role: 'user', content: 'task' }], [], '', undefined,
    { singleAttempt: true, maxOutputTokensOverride: 16 }))).rejects.toThrow('fixture');
  const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
  expect(headers.get('authorization')).toBe('Bearer inference-token');
  expect(headers.get('x-initiator')).toBe('user');
  expect(headers.get('openai-intent')).toBe('conversation-edits');
  expect(headers.has('x-api-key')).toBe(false);
});
