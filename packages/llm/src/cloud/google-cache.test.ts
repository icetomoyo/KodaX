import { afterEach, expect, it, vi } from 'vitest';
import { createCloudProviderConfig, createGoogleCacheConnection, createGoogleCache, getGoogleCache, listGoogleCaches, updateGoogleCache, deleteGoogleCache,
  createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope, serializeCloudCredential, createCustomProvider } from '../index.js';

afterEach(() => vi.unstubAllGlobals());
it.each(['gemini', 'vertex'] as const)('uses native %s cache resource paths with fresh authority on every lifecycle operation', async service => {
  const config = service === 'gemini' ? createCloudProviderConfig({ service, name: 'cache', model: 'fixture' })
    : createCloudProviderConfig({ service, name: 'cache', model: 'fixture', project: 'project-a', location: 'us-central1' });
  const connection = createGoogleCacheConnection(config, 'registration/account-a');
  const name = service === 'gemini' ? 'cachedContents/cache-1' : 'projects/project-a/locations/us-central1/cachedContents/cache-1';
  const resource = { name, model: service === 'gemini' ? 'models/fixture' : 'projects/project-a/locations/us-central1/publishers/google/models/fixture', expireTime: '2030-01-01T00:00:00Z' };
  const wire = vi.fn(async (url: string | URL | Request, init?: RequestInit) => Response.json(init?.method === 'DELETE' ? {}
    : init?.method === 'GET' && !String(url).includes('/cache-1') ? { cachedContents: [resource], nextPageToken: 'next' } : resource)); vi.stubGlobal('fetch', wire);
  let grants = 0;
  const scope = createProviderCredentialLeaseScope({ allowedProviders: [config.name], acquire: async () => serializeCloudCredential(config.name,
    service === 'gemini' ? { type: 'api-key', key: `grant-${++grants}` } : { type: 'bearer', token: `grant-${++grants}` }) });
  await runWithProviderCredentialLeaseScope(scope, async () => {
    const created = await createGoogleCache(connection, { messages: [{ role: 'user', content: 'stable' }], system: 'system', ttlSeconds: 600 });
    const restored = JSON.parse(JSON.stringify(created));
    expect(created.name).toBe(name); expect(created.expiresAt).toBe(Date.parse(resource.expireTime));
    expect((await getGoogleCache(connection, restored)).name).toBe(name);
    expect((await listGoogleCaches(connection, { pageSize: 10 })).nextPageToken).toBe('next');
    expect((await updateGoogleCache(connection, restored, { ttlSeconds: 1200 })).name).toBe(name);
    await deleteGoogleCache(connection, restored);
    await expect(getGoogleCache({ ...connection, accountScope: 'another' }, restored)).rejects.toThrow(/scope/);
    await expect(getGoogleCache(connection, { ...restored, name: 'https://foreign.example/key' })).rejects.toThrow(/resource/);
  });
  expect(grants).toBe(5); expect(wire).toHaveBeenCalledTimes(5);
  const root = service === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/cachedContents'
    : 'https://us-central1-aiplatform.googleapis.com/v1/projects/project-a/locations/us-central1/cachedContents';
  expect(wire.mock.calls[0]?.[0]).toBe(root); expect(wire.mock.calls[1]?.[0]).toBe(`${root}/cache-1`);
  expect(wire.mock.calls[3]?.[0]).toBe(`${root}/cache-1?updateMask=ttl`);
  expect(new Headers(wire.mock.calls[4]?.[1]?.headers).get(service === 'gemini' ? 'x-goog-api-key' : 'authorization')).toContain('grant-5');
  expect(JSON.stringify(connection)).not.toContain('grant-'); scope.close();
});

it('keeps strict and forced tool policy in the immutable cache and checks it on reuse', async () => {
  const config = { ...createCloudProviderConfig({ service: 'gemini', name: 'cache', model: 'fixture' }), toolCapabilities: { strict: true } };
  const connection = createGoogleCacheConnection(config, 'account-a');
  const wire = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => Response.json(String(url).endsWith('/cachedContents')
    ? { name: 'cachedContents/cache-1', model: 'models/fixture', expireTime: '2030-01-01T00:00:00Z' }
    : { candidates: [{ finishReason: 'STOP' }] })); vi.stubGlobal('fetch', wire);
  const scope = createProviderCredentialLeaseScope({ allowedProviders: [config.name], acquire: async () => serializeCloudCredential(config.name, { type: 'api-key', key: 'fixture' }) });
  await runWithProviderCredentialLeaseScope(scope, async () => {
    const tools = [{ name: 'read', description: 'Read', strict: 'require' as const, input_schema: { type: 'object' as const, properties: {} } }];
    const ref = await createGoogleCache(connection, { messages: [{ role: 'user', content: 'prefix' }], tools, forcedToolName: 'read' });
    expect(JSON.parse(String(wire.mock.calls[0]?.[1]?.body)).toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['read'] });
    await createCustomProvider(config).complete([], tools, '', undefined, { forcedToolName: 'read', cachedContent: { reference: ref, accountScope: 'account-a' } });
    expect(JSON.parse(String(wire.mock.calls[1]?.[1]?.body))).not.toHaveProperty('toolConfig');
    await expect(createCustomProvider(config).complete([], tools, '', undefined, { cachedContent: { reference: ref, accountScope: 'account-a' } })).rejects.toThrow(/tool policy/);
  });
  expect(wire).toHaveBeenCalledTimes(2); scope.close();
});

it('reuses an authorized cache without duplicating its system/tools and rejects expired or changed declarations', async () => {
  const config = createCloudProviderConfig({ service: 'gemini', name: 'cache', model: 'fixture' });
  const connection = createGoogleCacheConnection(config, 'account-a');
  const wire = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => Response.json(String(url).endsWith('/cachedContents')
    ? { name: 'cachedContents/cache-1', model: 'models/fixture', expireTime: '2030-01-01T00:00:00Z' }
    : { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })); vi.stubGlobal('fetch', wire);
  const scope = createProviderCredentialLeaseScope({ allowedProviders: [config.name], acquire: async () => serializeCloudCredential(config.name, { type: 'api-key', key: 'fixture' }) });
  await runWithProviderCredentialLeaseScope(scope, async () => {
    const tools = [{ name: 'read', description: 'Read', input_schema: { type: 'object' as const, properties: {} } }];
    const ref = await createGoogleCache(connection, { messages: [{ role: 'user', content: 'prefix' }], system: 'system', tools });
    const provider = createCustomProvider(config), options = { cachedContent: { reference: ref, accountScope: 'account-a' } };
    await provider.complete([{ role: 'user', content: 'tail' }], tools, 'system', undefined, options);
    const body = JSON.parse(String(wire.mock.calls[1]?.[1]?.body));
    expect(body.cachedContent).toBe(ref.name); expect(body).not.toHaveProperty('systemInstruction'); expect(body).not.toHaveProperty('tools');
    await expect(provider.complete([], tools, 'changed', undefined, options)).rejects.toThrow(/declaration changed/);
    await expect(provider.complete([], tools, 'system', undefined, { cachedContent: { reference: { ...ref, expiresAt: 1 }, accountScope: 'account-a' } })).rejects.toThrow(/expired/);
    await expect(provider.complete([], tools, 'system', undefined, { ...options, cacheRetention: 'none' })).rejects.toThrow(/disabled/);
  });
  expect(wire).toHaveBeenCalledTimes(2); scope.close();
});

it('inherits model-specific cache tool declarations and wire identity', () => {
  const config = { ...createCloudProviderConfig({ service: 'gemini', name: 'cache', model: 'alias' }),
    models: [{ id: 'alias', wireModel: 'actual-model', toolCapabilities: { strict: true } }] };
  const connection = createGoogleCacheConnection(config, 'account-a');
  expect(connection.model).toBe('actual-model'); expect(connection.toolCapabilities).toEqual({ strict: true });
  config.models[0]!.toolCapabilities.strict = false;
  expect(connection.toolCapabilities?.strict).toBe(true);
});
