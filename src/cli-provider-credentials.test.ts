import { afterEach, expect, it, vi } from 'vitest';
import { createCloudProviderConfig, serializeCloudCredential } from '@kodax-ai/llm';
import type { KodaXClientHostAuthorization, RuntimeCredentialService, RuntimeScopedCredentialBroker } from './client-host-authorization.js';
import { createCliProviderCredentials } from './cli-provider-credentials.js';

afterEach(() => vi.unstubAllEnvs());
it('connects configured native/env routes and preserves bridge-owned auth without granting unknown sources', async () => {
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
  const services = { credentials, identity: { runtimeId: 'host' } } as unknown as Parameters<KodaXClientHostAuthorization>[1];
  try {
    await authorizer.authorizeExecution({ kind: 'provider_probe', input: { provider: native.name, efforts: [] } }, services);
    expect(allowed).toEqual(expect.arrayContaining(['codex-cli', 'gemini-cli', 'custom-cli', native.name])); expect(allowed).not.toContain('unlinked-oauth');
    const request = { requestId: 'r', leaseId: 'lease', provider: 'custom-cli', sessionId: 's', target: { kind: 'run' as const, runId: 'run' }, purpose: 'primary' as const };
    expect(await broker(request)).toBe('custom-first'); vi.stubEnv('CUSTOM_CLI_KEY', 'custom-next'); expect(await broker(request)).toBe('custom-next');
    native.apiKeyEnv = 'MUTATED';
    expect(await broker({ ...request, provider: native.name })).toBe(serializeCloudCredential(native.name, { type: 'api-key', key: 'cloud-key' }));
    await expect(broker({ ...request, provider: 'codex-cli' })).rejects.toThrow(/owns authentication/);
    await expect(broker({ ...request, provider: 'unknown' })).rejects.toThrow(/inactive/);
  } finally { await authorizer.close(); }
});
