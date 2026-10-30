import { afterEach, expect, it, vi } from 'vitest';
import { createCloudProviderConfig, createCustomProvider, createProviderCredentialLeaseScope, credentialConnectionFingerprint, getProvider, runWithProviderCredentialLeaseScope, withProviderRequestCredential } from './index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('canonicalizes cloud routes while isolating Vertex projects and Bedrock regions', () => {
  const base = { provider: 'native', api: 'google-generate-content', baseUrl: 'https://google.example/' };
  for (const cloud of [{ service: 'gemini' as const }, { service: 'azure' as const }, { service: 'vertex' as const, project: 'one', location: 'global' }, { service: 'bedrock' as const, region: 'us-east-1' }]) {
    expect(credentialConnectionFingerprint({ ...base, cloud })).toBe(credentialConnectionFingerprint({ ...base, baseUrl: 'https://google.example', cloud }));
  }
  expect(credentialConnectionFingerprint({ ...base, cloud: { service: 'vertex', project: 'one', location: 'global' } })).not.toBe(credentialConnectionFingerprint({ ...base, cloud: { service: 'vertex', project: 'two', location: 'global' } }));
  expect(credentialConnectionFingerprint({ ...base, cloud: { service: 'bedrock', region: 'us-east-1' } })).not.toBe(credentialConnectionFingerprint({ ...base, cloud: { service: 'bedrock', region: 'us-west-2' } }));
});
it('distinguishes Google native API-key policy from an explicitly selected bearer policy', () => {
  const config = createCloudProviderConfig({ name: 'google-auth', service: 'gemini', model: 'fixture' });
  expect(createCustomProvider(config).getCredentialConnectionFingerprint()).not.toBe(createCustomProvider({ ...config, authentication: 'bearer' }).getCredentialConnectionFingerprint());
});
it('binds credentials to provider/API/effective endpoint/authentication without tying them to model or budget', () => {
  const config = { name: 'route', protocol: 'openai' as const, model: 'one', baseUrl: 'https://route.example/v1', apiKeyEnv: 'KEY' };
  const fingerprint = createCustomProvider(config).getCredentialConnectionFingerprint();
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(createCustomProvider({ ...config, model: 'two', maxOutputTokens: 9999 }).getCredentialConnectionFingerprint()).toBe(fingerprint);
  for (const change of [{ name: 'other' }, { baseUrl: 'https://other.example/v1' }, { api: 'responses' as const }, { authentication: 'cloudflare-gateway' as const }]) {
    expect(createCustomProvider({ ...config, ...change }).getCredentialConnectionFingerprint()).not.toBe(fingerprint);
  }
});
it('provides the actual adapter connection proof with a lazy native credential request', async () => {
  const provider = createCustomProvider({ name: 'proof', protocol: 'openai', api: 'responses', model: 'fixture', baseUrl: 'https://proof.example/v1', apiKeyEnv: 'UNUSED' });
  const acquire = vi.fn(async (_provider: string, _purpose: string, _signal: AbortSignal, _attribution: unknown, proof?: string) => {
    expect(proof).toBe(provider.getCredentialConnectionFingerprint()); return 'fixture';
  });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'completed', output: [] })));
  const scope = createProviderCredentialLeaseScope({ allowedProviders: [provider.name], acquire });
  try { await runWithProviderCredentialLeaseScope(scope, () => provider.complete([], [], '')); } finally { scope.close(); }
  expect(acquire).toHaveBeenCalledOnce();
});
it('keeps a declared endpoint authoritative over SDK ambient defaults', async () => {
  vi.stubEnv('CONNECTION_KEY', 'same-fixture-key'); vi.stubEnv('OPENAI_BASE_URL', 'https://first.example/v1');
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ status: 'completed', output: [] })); vi.stubGlobal('fetch', wire);
  const provider = createCustomProvider({ name: 'effective-route', protocol: 'openai', api: 'responses', model: 'fixture', baseUrl: 'https://configured.example/v1', apiKeyEnv: 'CONNECTION_KEY' });
  // A declared endpoint stays authoritative over SDK ambient defaults.
  const first = provider.getCredentialConnectionFingerprint(); await provider.complete([], [], '');
  vi.stubEnv('OPENAI_BASE_URL', 'https://second.example/v1'); await provider.complete([], [], '');
  expect(provider.getCredentialConnectionFingerprint()).toBe(first);
  expect(wire.mock.calls.map(([url]) => String(url))).toEqual(['https://configured.example/v1/responses', 'https://configured.example/v1/responses']);
});
it('refreshes an unbound SDK target and its proof when the base URL changes with the same key', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'same-key'); vi.stubEnv('OPENAI_BASE_URL', 'https://first.example/v1');
  const wire = vi.fn(async (_url: string | URL | Request) => Response.json({ id: 'one', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); vi.stubGlobal('fetch', wire);
  const provider = getProvider('openai'), first = provider.getCredentialConnectionFingerprint();
  await provider.complete([], [], ''); vi.stubEnv('OPENAI_BASE_URL', 'https://second.example/v1'); await provider.complete([], [], '');
  expect(provider.getCredentialConnectionFingerprint()).not.toBe(first);
  expect(wire.mock.calls.map(([url]) => String(url))).toEqual(['https://first.example/v1/chat/completions', 'https://second.example/v1/chat/completions']);
});
it('rejects nested adapters sharing an alias but targeting another connection', async () => {
  const first = createCustomProvider({ name: 'same', protocol: 'openai', model: 'm', baseUrl: 'https://one.example/v1', apiKeyEnv: 'KEY' });
  const other = createCustomProvider({ name: 'same', protocol: 'openai', model: 'm', baseUrl: 'https://two.example/v1', apiKeyEnv: 'KEY' });
  const wire = vi.fn(); vi.stubGlobal('fetch', wire);
  const scope = createProviderCredentialLeaseScope({ allowedProviders: ['same'], acquire: async () => 'secret' });
  try { await expect(runWithProviderCredentialLeaseScope(scope, () => withProviderRequestCredential(first, 'primary', undefined, () => other.complete([], [], '')))).rejects.toThrow(/connection/); }
  finally { scope.close(); }
  expect(wire).not.toHaveBeenCalled();
});
it('isolates SDK organization/project identity and rebuilds headers with an unchanged key and endpoint', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'same-key'); vi.stubEnv('OPENAI_ORG_ID', 'org-a'); vi.stubEnv('OPENAI_PROJECT_ID', 'project-a');
  const wire = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] })); vi.stubGlobal('fetch', wire);
  const provider = getProvider('openai'), scope = provider.getReasoningLearningScope(); await provider.complete([], [], '');
  vi.stubEnv('OPENAI_PROJECT_ID', 'project-b'); await provider.complete([], [], '');
  expect(provider.getReasoningLearningScope()).not.toBe(scope);
  expect(wire.mock.calls.map(([, init]) => new Headers(init?.headers).get('openai-project'))).toEqual(['project-a', 'project-b']);
});
it('refreshes the Anthropic SDK route together with its proof and generation source', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'same-key'); vi.stubEnv('ANTHROPIC_BASE_URL', 'https://first.example');
  const wire = vi.fn(async (_url: unknown) => Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })); vi.stubGlobal('fetch', wire);
  const provider = getProvider('anthropic'), first = provider.getCredentialConnectionFingerprint(); await provider.complete([], [], '', false, { maxOutputTokensOverride: 1024 });
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://second.example'); await provider.complete([], [], '', false, { maxOutputTokensOverride: 1024 });
  expect(provider.getCredentialConnectionFingerprint()).not.toBe(first);
  expect(wire.mock.calls.map(([url]) => String(url))).toEqual(['https://first.example/v1/messages', 'https://second.example/v1/messages']);
});
