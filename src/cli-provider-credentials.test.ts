import { afterEach, expect, it, vi } from 'vitest';
import { createCloudProviderConfig, serializeCloudCredential } from '@kodax-ai/llm';
import type { KodaXClientHostAuthorization, RuntimeCredentialService, RuntimeScopedCredentialBroker } from './client-host-authorization.js';
import { createCliProviderCredentials } from './cli-provider-credentials.js';
import { createCustomProvider, createFileProviderCredentialStore } from '@kodax-ai/llm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

afterEach(() => vi.unstubAllEnvs());
it('uses saved keys before env, rereads updates and never falls back from corrupt storage or a different destination', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-cli-key-source-'));
  const config = { name: 'saved-cli', protocol: 'openai' as const, baseUrl: 'https://saved.example/v1', model: 'fixture', apiKeyEnv: 'CLI_FALLBACK_KEY' };
  vi.stubEnv('CLI_FALLBACK_KEY', 'env-fixture');
  let broker!: RuntimeScopedCredentialBroker;
  const credentials = { registerScoped: async (_input: unknown, callback: RuntimeScopedCredentialBroker) => { broker = callback; return { id: 'lease', providers: ['saved-cli'], brokerVersion: 2 as const }; }, revoke: async () => true };
  const authorizer = await createCliProviderCredentials({ customProviders: [config] }, { configPath: path.join(folder, 'config.json') });
  try {
    await authorizer.authorizeExecution({ kind: 'provider_probe', input: { provider: config.name, efforts: [] } }, { credentials, identity: { runtimeId: 'host', profile: 'default' } } as unknown as Parameters<KodaXClientHostAuthorization>[1]);
    const proof = createCustomProvider(config).getCredentialConnectionFingerprint(), binding = { profile: 'default', provider: config.name, connectionFingerprint: proof };
    const request = { requestId: 'r', leaseId: 'lease', provider: config.name, sessionId: 's', target: { kind: 'run' as const, runId: 'run' }, purpose: 'primary' as const, connectionFingerprint: proof };
    expect(await broker(request)).toBe('env-fixture');
    const store = createFileProviderCredentialStore(path.join(folder, 'auth.json')); await store.setApiKey(binding, 'saved-one'); expect(await broker(request)).toBe('saved-one');
    await store.setApiKey(binding, 'saved-two'); expect(await broker(request)).toBe('saved-two');
    await expect(broker({ ...request, connectionFingerprint: 'b'.repeat(64) })).rejects.toThrow(/connection/);
    await store.removeApiKey(binding); expect(await broker(request)).toBe('env-fixture');
    await writeFile(path.join(folder, 'auth.json'), '{broken'); await expect(broker(request)).rejects.toThrow(/storage/);
  } finally { await authorizer.close(); await rm(folder, { recursive: true, force: true }); }
});
it('connects configured native/env routes and preserves bridge-owned auth without granting unknown sources', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-cli-native-source-')); vi.stubEnv('KODAX_HOME', folder);
  vi.stubEnv('CUSTOM_CLI_KEY', 'custom-first'); vi.stubEnv('CLOUD_CLI_KEY', 'cloud-key');
  const native = { ...createCloudProviderConfig({ name: 'native-cli', model: 'fixture', service: 'gemini' }), apiKeyEnv: 'CLOUD_CLI_KEY' };
  const authorizer = await createCliProviderCredentials({ customProviders: [native,
    { name: 'custom-cli', model: 'fixture', protocol: 'openai', baseUrl: 'https://custom.example/v1', apiKeyEnv: 'CUSTOM_CLI_KEY' },
    { name: 'unlinked-oauth', model: 'fixture', protocol: 'openai', api: 'responses', oauth: 'openai-chatgpt', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'UNUSED' },
  ] });
  let broker!: RuntimeScopedCredentialBroker; let allowed: readonly string[] = [];
  const credentials = { registerScoped: async (input: Parameters<RuntimeCredentialService['registerScoped']>[0], callback: RuntimeScopedCredentialBroker) => {
    allowed = input.providers; broker = callback; return { id: 'lease', providers: allowed, brokerVersion: 2 as const };
  }, revoke: async () => true };
  const services = { credentials, identity: { runtimeId: 'host', profile: 'default' } } as unknown as Parameters<KodaXClientHostAuthorization>[1];
  try {
    await authorizer.authorizeExecution({ kind: 'provider_probe', input: { provider: native.name, efforts: [] } }, services);
    expect(allowed).toEqual(expect.arrayContaining(['codex-cli', 'gemini-cli', 'custom-cli', native.name])); expect(allowed).not.toContain('unlinked-oauth');
    const request = { requestId: 'r', leaseId: 'lease', provider: 'custom-cli', sessionId: 's', target: { kind: 'run' as const, runId: 'run' }, purpose: 'primary' as const, connectionFingerprint: '' };
    request.connectionFingerprint = createCustomProvider({ name: 'custom-cli', model: 'fixture', protocol: 'openai', baseUrl: 'https://custom.example/v1', apiKeyEnv: 'CUSTOM_CLI_KEY' }).getCredentialConnectionFingerprint();
    expect(await broker(request)).toBe('custom-first'); vi.stubEnv('CUSTOM_CLI_KEY', 'custom-next'); expect(await broker(request)).toBe('custom-next');
    native.apiKeyEnv = 'MUTATED';
    expect(await broker({ ...request, provider: native.name, connectionFingerprint: createCustomProvider(native).getCredentialConnectionFingerprint() })).toBe(serializeCloudCredential(native.name, { type: 'api-key', key: 'cloud-key' }));
    await expect(broker({ ...request, provider: 'codex-cli' })).rejects.toThrow(/owns authentication/);
    await expect(broker({ ...request, provider: 'unknown' })).rejects.toThrow(/inactive/);
  } finally { await authorizer.close(); await rm(folder, { recursive: true, force: true }); }
});
