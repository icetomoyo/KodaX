import { afterEach, expect, it, vi } from 'vitest';
import { createCloudProviderConfig, serializeCloudCredential, createOAuthProviderConfig } from '@kodax-ai/llm';
import type { KodaXClientHostAuthorization, RuntimeCredentialService, RuntimeScopedCredentialBroker } from './client-host-authorization.js';
import { createCliProviderCredentials, createCliProviderCredentialAccess } from './cli-provider-credentials.js';
import { createCustomProvider, createFileProviderCredentialStore } from '@kodax-ai/llm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openOAuthSession } from '@kodax-ai/llm';
import { providerOAuthStore } from './provider-oauth-store.js';

afterEach(() => vi.unstubAllEnvs());
it('keeps deferred OAuth account binding, parallel acquisition, Host replacement and revocation intact', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-cli-deferred-lifetime-'));
  const configPath = path.join(folder, 'config.json'), store = providerOAuthStore(configPath);
  const connection = { ...createOAuthProviderConfig({ service: 'openrouter', name: 'subscription', model: 'fixture' }), oauthRegistration: 'selected' };
  await store.transact('selected', async () => ({ record: { id: 'selected', service: 'openrouter', clientId: 'own-client', accountId: 'account-a', profile: 'default', credentials: { accessToken: 'selected-account-token' } }, result: undefined }));
  vi.stubEnv(connection.apiKeyEnv, 'must-never-use-ambient-account');
  const authorizer = await createCliProviderCredentials({ customProviders: [connection] }, { configPath });
  let broker!: RuntimeScopedCredentialBroker, epoch = 'host-a', leases = 0;
  const revoke = vi.fn(async () => true);
  const credentials = { registerScoped: async (_input: unknown, callback: RuntimeScopedCredentialBroker) => {
    broker = callback; return { id: `lease-${++leases}`, providers: [connection.name], brokerVersion: 2 as const };
  }, revoke };
  const services = { credentials, get identity() { return { runtimeId: epoch, profile: 'default' }; } } as unknown as Parameters<KodaXClientHostAuthorization>[1];
  const authorize = () => authorizer.authorizeExecution({ kind: 'provider_probe', input: { provider: connection.name, efforts: [] } }, services);
  try {
    await authorize();
    const request = { requestId: 'r', leaseId: 'lease-1', provider: connection.name, sessionId: 's', target: { kind: 'run' as const, runId: 'run' }, purpose: 'primary' as const,
      connectionFingerprint: createCustomProvider(connection).getCredentialConnectionFingerprint() };
    expect(await Promise.all([broker(request), broker(request)])).toEqual(['selected-account-token', 'selected-account-token']);
    const old = broker; epoch = 'host-b'; await authorize();
    await expect(old(request)).rejects.toThrow(/inactive/);
    const next = { ...request, leaseId: 'lease-2' };
    expect(await broker(next)).toBe('selected-account-token');
    const session = await openOAuthSession({ id: 'selected', store, driver: { refresh: async () => { throw new Error('No network refresh expected.'); } } });
    await session.revoke();
    await expect(broker(next)).rejects.toThrow(/inactive|revoked/);
    expect(revoke).toHaveBeenCalledWith('lease-2');
    const retained = await store.transact('selected', async record => ({ record, result: record }));
    expect(retained?.accountId).toBe('account-a');
    expect(retained?.credentials).toBeUndefined();
  } finally { await authorizer.close(); await rm(folder, { recursive: true, force: true }); }
});
it('retries failed CLI bootstrap after storage is repaired without retaining a rejected initialization', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-cli-bootstrap-retry-'));
  const authFile = path.join(folder, 'auth.json');
  await writeFile(authFile, '{broken');
  const access = createCliProviderCredentialAccess({}, { configPath: path.join(folder, 'config.json') });
  const services = { credentials: { registerScoped: async () => ({ id: 'lease', providers: [], brokerVersion: 2 as const }), revoke: async () => true },
    identity: { runtimeId: 'host', profile: 'default' } } as unknown as Parameters<KodaXClientHostAuthorization>[1];
  const request = { kind: 'provider_probe' as const, input: { provider: 'anthropic', efforts: [] } };
  try {
    await expect(access.authorizeExecution(request, services)).rejects.toThrow();
    await rm(authFile);
    await expect(access.authorizeExecution(request, services)).resolves.toHaveProperty('credential');
  } finally { await access.close(); await rm(folder, { recursive: true, force: true }); }
});
it('isolates an unavailable linked OAuth registration without falling back to its ambient key', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-cli-isolated-oauth-'));
  const healthy = { name: 'healthy', protocol: 'openai' as const, model: 'fixture', baseUrl: 'https://healthy.invalid/v1', apiKeyEnv: 'HEALTHY_FIXTURE_KEY' };
  const broken = { ...createOAuthProviderConfig({ service: 'openai-chatgpt', name: 'broken', model: 'fixture' }), oauthRegistration: 'missing-registration' };
  vi.stubEnv('HEALTHY_FIXTURE_KEY', 'healthy-key'); vi.stubEnv(broken.apiKeyEnv, 'never-use-this-account');
  let broker!: RuntimeScopedCredentialBroker;
  const credentials = { registerScoped: async (_input: unknown, callback: RuntimeScopedCredentialBroker) => {
    broker = callback; return { id: 'lease', providers: ['healthy', 'broken'], brokerVersion: 2 as const };
  }, revoke: async () => true };
  let authorizer: Awaited<ReturnType<typeof createCliProviderCredentials>> | undefined;
  try {
    authorizer = await createCliProviderCredentials({ customProviders: [healthy, broken] }, { configPath: path.join(folder, 'config.json') });
    await authorizer.authorizeExecution({ kind: 'provider_probe', input: { provider: healthy.name, efforts: [] } },
      { credentials, identity: { runtimeId: 'host', profile: 'default' } } as unknown as Parameters<KodaXClientHostAuthorization>[1]);
    const request = { requestId: 'r', leaseId: 'lease', provider: healthy.name, sessionId: 's', target: { kind: 'run' as const, runId: 'run' }, purpose: 'primary' as const,
      connectionFingerprint: createCustomProvider(healthy).getCredentialConnectionFingerprint() };
    expect(await broker(request)).toBe('healthy-key');
    await expect(broker({ ...request, provider: broken.name, connectionFingerprint: createCustomProvider(broken).getCredentialConnectionFingerprint() })).rejects.toThrow(/OAuth/);
    expect(await broker(request)).toBe('healthy-key');
  } finally { await authorizer?.close(); await rm(folder, { recursive: true, force: true }); }
});
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
