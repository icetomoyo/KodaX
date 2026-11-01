import { describe, expect, it, vi } from 'vitest';
import { bindCloudCredentials } from './cloud-credential-binding.js';
import { createCloudProviderConfig } from '@kodax-ai/llm';
import type { RuntimeCredentialService, RuntimeScopedCredentialBroker } from './client-host-authorization.js';

describe('cloud credentials use the existing scoped broker', () => {
  it('refreshes per request and fences late credentials after account revocation', async () => {
    let broker!: RuntimeScopedCredentialBroker;
    const revoke = vi.fn(async () => true);
    const credentials = { registerScoped: async (_input: unknown, callback: RuntimeScopedCredentialBroker) => {
      broker = callback; return { id: 'lease', providers: ['vertex-test'], brokerVersion: 2 as const };
    }, revoke } as unknown as RuntimeCredentialService;
    const provider = createCloudProviderConfig({ service: 'vertex', name: 'vertex-test', model: 'chosen', project: 'project', location: 'global' });
    const resolve = vi.fn(async () => ({ type: 'bearer' as const, token: `token-${resolve.mock.calls.length}`, expiresAt: Date.now() + 3600_000 }));
    const binding = await bindCloudCredentials({ credentials, provider, resolve });
    const request = { requestId: 'request', leaseId: 'lease', provider: provider.name, sessionId: 'session',
      target: { kind: 'run' as const, runId: 'run' }, purpose: 'primary' as const };
    const first = await broker(request), second = await broker({ ...request, requestId: 'next' });
    expect(first).not.toBe(second);
    expect(resolve).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    await binding.close();
    await expect(broker(request)).rejects.toThrow(/inactive/);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('lease');
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it('fences an in-flight host source and sanitizes credential-provider failures', async () => {
    let broker!: RuntimeScopedCredentialBroker;
    const credentials = { registerScoped: async (_input: unknown, callback: RuntimeScopedCredentialBroker) => {
      broker = callback; return { id: 'lease', providers: ['vertex-test'], brokerVersion: 2 as const };
    }, revoke: async () => true } as unknown as RuntimeCredentialService;
    const provider = createCloudProviderConfig({ service: 'vertex', name: 'vertex-test', model: 'chosen', project: 'project', location: 'global' });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let signal: AbortSignal | undefined;
    const binding = await bindCloudCredentials({ credentials, provider, async resolve(_request, requestSignal) {
      signal = requestSignal; await barrier; return { type: 'bearer', token: 'late-private-token' };
    } });
    const request = { requestId: 'request', leaseId: 'lease', provider: provider.name, sessionId: 'session', target: { kind: 'run' as const, runId: 'run' }, purpose: 'primary' as const };
    const pending = broker(request);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await binding.close(); expect(signal?.aborted).toBe(true); release(); await rejected;
    const failed = await bindCloudCredentials({ credentials, provider, async resolve() { throw new Error('private-host-account-secret'); } });
    await expect(broker(request)).rejects.toThrow('Cloud credential broker acquisition failed.'); await failed.close();
  });
  it('rejects the wrong credential kind before any material is supplied', async () => {
    let broker!: RuntimeScopedCredentialBroker;
    const credentials = { registerScoped: async (_input: unknown, callback: RuntimeScopedCredentialBroker) => {
      broker = callback; return { id: 'lease', providers: ['google-test'], brokerVersion: 2 as const };
    }, revoke: async () => true } as unknown as RuntimeCredentialService;
    const provider = createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' });
    const binding = await bindCloudCredentials({ credentials, provider, resolve: async () => ({ type: 'aws', accessKeyId: 'private', secretAccessKey: 'private' }) });
    await expect(broker({ requestId: 'request', leaseId: 'lease', provider: provider.name, sessionId: 'session', target: { kind: 'run', runId: 'run' }, purpose: 'primary' }))
      .rejects.toThrow('Cloud credential broker acquisition failed.'); await binding.close();
  });
});
