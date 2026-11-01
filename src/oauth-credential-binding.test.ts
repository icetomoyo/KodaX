import { describe, expect, it, vi } from 'vitest';
import { bindOAuthCredentials } from './oauth-credential-binding.js';
import type { OAuthCredentialSession } from '@kodax-ai/llm';
import type { RuntimeCredentialService, RuntimeScopedCredentialBroker } from './client-host-authorization.js';

describe('OAuth scoped credential binding', () => {
  it('serves negotiated credential recovery through the public SDK binding', async () => {
    let broker!: RuntimeScopedCredentialBroker;
    const recover = vi.fn(async (_fingerprint: string) => undefined);
    const credentials = { registerScoped: async (_input: unknown, callback: RuntimeScopedCredentialBroker) => {
      broker = callback; return { id: 'lease', providers: ['subscription'], brokerVersion: 2 as const };
    }, revoke: async () => true } as unknown as RuntimeCredentialService;
    const session: OAuthCredentialSession = { id: 'registration', service: 'openai-chatgpt', accountId: 'account',
      replayIdentity: 'a'.repeat(64), acquire: async () => 'inference-token', recoverRejectedCredential: recover,
      onInvalidate: () => () => undefined, revoke: async () => ({ remote: 'unsupported', leaseRevocationFailures: 0 }) };
    const binding = await bindOAuthCredentials({ credentials, provider: { name: 'subscription', oauth: session.service }, session });
    try {
      const token = await broker({ requestId: 'r', leaseId: 'lease', provider: 'subscription', sessionId: 's',
        target: { kind: 'run', runId: 'run' }, purpose: 'primary', credentialContextVersion: 1, rejectedCredentialFingerprint: 'b'.repeat(64) });
      expect(token).toMatch(/^kodax-provider-grant-v1:/);
      expect(recover).toHaveBeenCalledWith('b'.repeat(64), expect.any(AbortSignal));
    } finally { await binding.close(); }
  });
  it('revokes the old lease before switching accounts and fences delayed credentials', async () => {
    const brokers = new Map<string, RuntimeScopedCredentialBroker>();
    const revoke = vi.fn(async () => true);
    const credentials = { registerScoped: vi.fn(async (_input, broker: RuntimeScopedCredentialBroker) => {
      const id = `lease-${brokers.size}`; brokers.set(id, broker); return { id, providers: ['subscription'], brokerVersion: 2 as const };
    }), revoke } as unknown as RuntimeCredentialService;
    let release!: (token: string) => void;
    const waiting = new Promise<string>(resolve => { release = resolve; });
    const session = (accountId: string, acquire: () => Promise<string>): OAuthCredentialSession => ({
      id: accountId, service: 'openai-chatgpt', accountId, acquire, onInvalidate: () => () => undefined,
      revoke: async () => ({ remote: 'unsupported', leaseRevocationFailures: 0 }),
    });
    const first = await bindOAuthCredentials({ credentials, provider: { name: 'subscription', oauth: 'openai-chatgpt' }, session: session('account-a', () => waiting) });
    const request = { requestId: 'r', leaseId: first.credential.leaseId, provider: 'subscription', sessionId: 'session',
      target: { kind: 'run' as const, runId: 'run' }, purpose: 'primary' as const };
    const delayed = brokers.get('lease-0')!(request);
    const rejected = expect(delayed).rejects.toThrow(/inactive|aborted/i);
    const second = await first.switchAccount(session('account-b', async () => 'account-b-token'));
    release('account-a-token');
    await rejected;
    expect(revoke).toHaveBeenCalledWith('lease-0');
    expect(await brokers.get('lease-1')!({ ...request, leaseId: second.credential.leaseId })).toBe('account-b-token');
    await second.close();
  });
  it('revokes authority granted after logout races with registration', async () => {
    let release!: (lease: { id: string; providers: string[]; brokerVersion: 2 }) => void;
    const pending = new Promise<{ id: string; providers: string[]; brokerVersion: 2 }>(resolve => { release = resolve; });
    let invalidate!: () => Promise<void>;
    const unsubscribe = vi.fn();
    const revoke = vi.fn(async () => true);
    const session: OAuthCredentialSession = { id: 'a', accountId: 'a', service: 'openai-chatgpt', acquire: async () => 'unused',
      onInvalidate(listener) { invalidate = listener; return unsubscribe; }, revoke: async () => ({ remote: 'unsupported', leaseRevocationFailures: 0 }) };
    const credentials = { registerScoped: async () => pending, revoke } as unknown as RuntimeCredentialService;
    const binding = bindOAuthCredentials({ credentials, provider: { name: 'subscription', oauth: 'openai-chatgpt' }, session });
    const rejected = expect(binding).rejects.toThrow(/inactive/);
    const closing = invalidate();
    release({ id: 'late-lease', providers: ['subscription'], brokerVersion: 2 });
    await closing;
    await rejected;
    expect(revoke).toHaveBeenCalledExactlyOnceWith('late-lease');
    expect(unsubscribe).toHaveBeenCalled();
  });
  it('cleans up failed registration, rejects mismatched sessions and permits retrying lease revocation', async () => {
    const unsubscribe = vi.fn();
    const session: OAuthCredentialSession = { id: 'a', accountId: 'a', service: 'openai-chatgpt', acquire: async () => 'unused',
      onInvalidate: () => unsubscribe, revoke: async () => ({ remote: 'unsupported', leaseRevocationFailures: 0 }) };
    const registerScoped = vi.fn(async () => { throw new Error('Host disconnected'); });
    const revoke = vi.fn(async () => true);
    const credentials = { registerScoped, revoke } as unknown as RuntimeCredentialService;
    await expect(bindOAuthCredentials({ credentials, provider: { name: 'subscription', oauth: 'openai-codex' }, session })).rejects.toThrow(/matching/);
    expect(registerScoped).not.toHaveBeenCalled();
    await expect(bindOAuthCredentials({ credentials, provider: { name: 'subscription', oauth: 'openai-chatgpt' }, session })).rejects.toThrow(/disconnected/);
    expect(unsubscribe).toHaveBeenCalledOnce();
    const working = { registerScoped: async () => ({ id: 'lease', providers: ['subscription'], brokerVersion: 2 as const }), revoke } as unknown as RuntimeCredentialService;
    const binding = await bindOAuthCredentials({ credentials: working, provider: { name: 'subscription', oauth: 'openai-chatgpt' }, session });
    revoke.mockRejectedValueOnce(new Error('Host temporarily unavailable'));
    await expect(binding.close()).rejects.toThrow(/unavailable/);
    await binding.close();
    await binding.close();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
