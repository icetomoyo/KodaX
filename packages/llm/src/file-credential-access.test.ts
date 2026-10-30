import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFileProviderCredentialStore } from './auth-file.js';
import { createFileProviderCredentialAccess } from './file-credential-access.js';
import { createCloudProviderConfig, createCustomProvider, createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope } from './index.js';
import { deserializeCloudCredential } from './cloud/credentials.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('uses a saved key after rebuilding both store and provider without changing process environment', async () => {
  vi.stubEnv('OPENAI_ORG_ID', 'unapproved-org'); vi.stubEnv('OPENAI_PROJECT_ID', 'unapproved-project');
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-file-access-'));
  const config = { name: 'saved', protocol: 'openai' as const, api: 'responses' as const, baseUrl: 'https://saved.example/v1', model: 'fixture', apiKeyEnv: 'UNSET_SAVED_KEY', credentialSource: 'broker' as const };
  const binding = { profile: 'default', provider: config.name, connectionFingerprint: createCustomProvider(config).getCredentialConnectionFingerprint() };
  const file = path.join(folder, 'auth.json'), environmentBefore = process.env.UNSET_SAVED_KEY;
  try {
    await createFileProviderCredentialStore(file).setApiKey(binding, 'saved-fixture-key');
    const store = createFileProviderCredentialStore(file), access = createFileProviderCredentialAccess({ store, bindings: [binding] });
    const wire = vi.fn(async (_url: unknown, init?: RequestInit) => { const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer saved-fixture-key'); expect(headers.has('openai-organization')).toBe(false); expect(headers.has('openai-project')).toBe(false);
      return Response.json({ status: 'completed', output: [] }); }); vi.stubGlobal('fetch', wire);
    const scope = createProviderCredentialLeaseScope(access);
    try { await runWithProviderCredentialLeaseScope(scope, () => createCustomProvider(config).complete([], [], '')); }
    finally { scope.close(); }
    expect(wire).toHaveBeenCalledOnce(); expect(process.env.UNSET_SAVED_KEY).toBe(environmentBefore);
    await expect(access.acquire('saved', 'primary', new AbortController().signal, undefined, 'b'.repeat(64))).rejects.toThrow(/connection/);
    await store.removeApiKey(binding);
    await expect(access.acquire('saved', 'primary', new AbortController().signal, undefined, binding.connectionFingerprint)).rejects.toThrow(/unavailable/);
  } finally { vi.unstubAllGlobals(); await rm(folder, { recursive: true, force: true }); }
});
it('lowers all four explicitly approved native cloud key formats and rejects cancelled or malformed access', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-file-format-'));
  try {
    const store = createFileProviderCredentialStore(path.join(folder, 'auth.json'));
    const binding = { profile: 'default', provider: 'native', connectionFingerprint: 'a'.repeat(64) };
    await store.setApiKey(binding, 'fixture');
    for (const cloud of ['gemini', 'vertex', 'azure', 'bedrock'] as const) {
      const access = createFileProviderCredentialAccess({ store, bindings: [{ ...binding, cloud }] });
      expect(deserializeCloudCredential('native', await access.acquire('native', 'primary', new AbortController().signal, undefined, binding.connectionFingerprint)))
        .toEqual(cloud === 'bedrock' ? { type: 'bearer', token: 'fixture' } : { type: 'api-key', key: 'fixture' });
      const aborted = AbortSignal.abort(); await expect(access.acquire('native', 'primary', aborted, undefined, binding.connectionFingerprint)).rejects.toThrow();
    }
    expect(() => createFileProviderCredentialAccess({ store, bindings: [binding, binding] })).toThrow(/bindings/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it.each(['gemini', 'azure'] as const)('uses a saved %s native API key through the typed cloud broker', async service => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-file-cloud-'));
  const config = createCloudProviderConfig(service === 'azure' ? { name: 'native-saved', service, model: 'fixture', endpoint: 'https://azure.example' } : { name: 'native-saved', service, model: 'fixture' });
  const provider = createCustomProvider(config), binding = { profile: 'default', provider: provider.name, connectionFingerprint: provider.getCredentialConnectionFingerprint() };
  try {
    const store = createFileProviderCredentialStore(path.join(folder, 'auth.json')); await store.setApiKey(binding, 'native-fixture');
    const scope = createProviderCredentialLeaseScope(createFileProviderCredentialAccess({ store, bindings: [{ ...binding, cloud: service }] }));
    const wire = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get(service === 'azure' ? 'api-key' : 'x-goog-api-key')).toBe('native-fixture');
      return Response.json(service === 'azure' ? { status: 'completed', output: [] } : { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
    }); vi.stubGlobal('fetch', wire);
    try { await runWithProviderCredentialLeaseScope(scope, () => provider.complete([], [], '')); } finally { scope.close(); }
    expect(wire).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); await rm(folder, { recursive: true, force: true }); }
});
