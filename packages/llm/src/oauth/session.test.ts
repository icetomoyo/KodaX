import { describe, expect, it, vi } from 'vitest';
import { openOAuthSession, OAuthCredentialError, type OAuthSessionRecord, type OAuthSessionStore } from './session.js';

function memoryStore(initial: OAuthSessionRecord): OAuthSessionStore {
  let record: OAuthSessionRecord | undefined = structuredClone(initial);
  let tail: Promise<unknown> = Promise.resolve();
  return {
    transact(id, operation) {
      const next = tail.then(async () => {
        expect(id).toBe(initial.id);
        const update = await operation(structuredClone(record));
        record = structuredClone(update.record);
        return update.result;
      });
      tail = next.catch(() => undefined); // A failed test transaction must not poison the queue.
      return next;
    },
  };
}
const record: OAuthSessionRecord = {
  id: 'registration-a', service: 'openai-chatgpt', clientId: 'issued-client', accountId: 'verified-sub',
  credentials: { accessToken: 'old-access', refreshToken: 'rotating-refresh', expiresAt: 1000 },
};

describe('host-owned OAuth session', () => {
  it('serializes refresh and persists rotated credentials before supplying request tokens', async () => {
    const store = memoryStore(record);
    const refresh = vi.fn(async () => ({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600_000 }));
    const session = await openOAuthSession({ id: record.id, store, driver: { refresh } });
    expect(await Promise.all([session.acquire(), session.acquire()])).toEqual(['new-access', 'new-access']);
    expect(refresh).toHaveBeenCalledTimes(1);
    const restored = await openOAuthSession({ id: record.id, store, driver: { refresh } });
    expect(await restored.acquire()).toBe('new-access');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('fences a delayed refresh on logout and cannot resurrect the registration on Host restore', async () => {
    let release!: (value: { accessToken: string; refreshToken: string; expiresAt: number }) => void;
    const refreshing = new Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>(resolve => { release = resolve; });
    const refresh = vi.fn(() => refreshing);
    const revoke = vi.fn(async () => { throw new Error('upstream-private-secret'); });
    const store = memoryStore(record);
    const session = await openOAuthSession({ id: record.id, store, driver: { refresh, revoke } });
    const fence = vi.fn(async () => undefined);
    session.onInvalidate(fence);
    const acquire = session.acquire();
    const rejected = expect(acquire).rejects.toMatchObject({ code: 'session_revoked' });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const logout = session.revoke();
    expect(fence).toHaveBeenCalledOnce();
    release({ accessToken: 'late', refreshToken: 'late-refresh', expiresAt: Date.now() + 3600_000 });
    await rejected;
    expect(await logout).toEqual({ remote: 'failed', leaseRevocationFailures: 0 });
    expect(session.revoke()).toBe(logout);
    const restored = await openOAuthSession({ id: record.id, store, driver: { refresh } });
    await expect(restored.acquire()).rejects.toMatchObject({ code: 'reauthentication_required' });
  });
  it('cancels one waiting request without losing a refresh shared with another request', async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const refresh = vi.fn(async () => { await barrier; return { accessToken: 'new', expiresAt: Date.now() + 3600_000 }; });
    const session = await openOAuthSession({ id: record.id, store: memoryStore(record), driver: { refresh } });
    const abort = new AbortController();
    const cancelled = session.acquire(abort.signal);
    const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const other = session.acquire();
    abort.abort();
    await rejection;
    release();
    expect(await other).toBe('new');
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('never supplies a credential when durable commit fails and sanitizes storage errors', async () => {
    const working = memoryStore(record);
    let fail = false;
    const store: OAuthSessionStore = { transact: (id, operation) => working.transact(id, async current => {
      const result = await operation(current);
      if (fail) throw new Error('secret-token-in-storage-error');
      return result;
    }) };
    const session = await openOAuthSession({ id: record.id, store, driver: { refresh: async () => ({ accessToken: 'new', expiresAt: Date.now() + 3600_000 }) } });
    fail = true;
    await expect(session.acquire()).rejects.toMatchObject({ code: 'storage_failed', message: 'OAuth credential storage failed.' });
  });
  it.each(['refresh_failed', 'reauthentication_required'] as const)('persists a rotated GitHub OAuth token even when the later Copilot exchange fails: %s', async code => {
    const store = memoryStore({ ...record, service: 'github-copilot' });
    const refresh = vi.fn(async () => ({ accessToken: 'rotated-github', refreshToken: 'rotated-refresh', expiresAt: Date.now() + 3600_000 }));
    const exchangeResource = vi.fn(async (current: OAuthSessionRecord) => {
      expect(current.credentials?.accessToken).toBe('rotated-github');
      if (exchangeResource.mock.calls.length === 1) throw new OAuthCredentialError(code);
      return { accessToken: 'copilot-inference', expiresAt: Date.now() + 1800_000 };
    });
    const session = await openOAuthSession({ id: record.id, store, driver: { refresh, exchangeResource } });
    await expect(session.acquire()).rejects.toMatchObject({ code });
    expect(await session.acquire()).toBe('copilot-inference');
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('persists invalid_grant as local sign-out and reports lease revocation failures', async () => {
    const store = memoryStore(record);
    const refresh = vi.fn(async () => { throw new OAuthCredentialError('reauthentication_required'); });
    const session = await openOAuthSession({ id: record.id, store, driver: { refresh } });
    await expect(session.acquire()).rejects.toMatchObject({ code: 'reauthentication_required' });
    await expect(session.acquire()).rejects.toMatchObject({ code: 'reauthentication_required' });
    expect(refresh).toHaveBeenCalledOnce();
    session.onInvalidate(async () => { throw new Error('Host disconnected'); });
    expect(await session.revoke()).toEqual({ remote: 'unsupported', leaseRevocationFailures: 1 });
  });
  it('supports a non-expiring GitHub OAuth grant while refreshing its expiring Copilot token', async () => {
    const store = memoryStore({ ...record, service: 'github-copilot', credentials: { accessToken: 'github-non-expiring' } });
    const refresh = vi.fn(async () => { throw new Error('Non-expiring GitHub grants must not be refreshed'); });
    const exchangeResource = vi.fn(async () => ({ accessToken: 'copilot-token', expiresAt: Date.now() + 1800_000 }));
    const session = await openOAuthSession({ id: record.id, store, driver: { refresh, exchangeResource } });
    expect(await session.acquire()).toBe('copilot-token');
    expect(await session.acquire()).toBe('copilot-token');
    expect(exchangeResource).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });
  it('revokes every local binding opened for the same secure-store registration', async () => {
    const store = memoryStore(record);
    const driver = { refresh: vi.fn(async () => ({ accessToken: 'new', expiresAt: Date.now() + 3600_000 })) };
    const first = await openOAuthSession({ id: record.id, store, driver });
    const second = await openOAuthSession({ id: record.id, store, driver });
    const fence = vi.fn(async () => undefined);
    first.onInvalidate(fence);
    await second.revoke();
    expect(fence).toHaveBeenCalledOnce();
    await expect(first.acquire()).rejects.toMatchObject({ code: 'session_revoked' });
  });
  it('can retry local sign-out after a temporary secure-store commit failure', async () => {
    const backing = memoryStore(record);
    let failing = false;
    const store: OAuthSessionStore = { transact: (id, operation) => backing.transact(id, async current => {
      const result = await operation(current);
      if (failing) throw new Error('temporary keychain failure');
      return result;
    }) };
    const driver = { refresh: async () => ({ accessToken: 'unused', expiresAt: Date.now() + 3600_000 }) };
    const session = await openOAuthSession({ id: record.id, store, driver });
    failing = true;
    await expect(session.revoke()).rejects.toMatchObject({ code: 'storage_failed' });
    failing = false;
    expect(await session.revoke()).toMatchObject({ remote: 'unsupported' });
    const restored = await openOAuthSession({ id: record.id, store, driver });
    await expect(restored.acquire()).rejects.toMatchObject({ code: 'reauthentication_required' });
  });
  it('respects earliest refresh time without sending expired tokens or discarding a deferred grant', async () => {
    const now = Date.now();
    const store = memoryStore({ ...record, credentials: { ...record.credentials!, expiresAt: now - 1, earliestRefreshAt: now + 60_000 } });
    const refresh = vi.fn(async () => ({ accessToken: 'unused', expiresAt: now + 3600_000 }));
    const session = await openOAuthSession({ id: record.id, store, driver: { refresh } });
    await expect(session.acquire()).rejects.toMatchObject({ code: 'refresh_failed' });
    expect(refresh).not.toHaveBeenCalled();
    await store.transact(record.id, async current => {
      expect(current?.credentials?.refreshToken).toBe('rotating-refresh');
      return { record: current && { ...current, credentials: { ...current.credentials!, earliestRefreshAt: now - 1 } }, result: undefined };
    });
    expect(await session.acquire()).toBe('unused');
  });
});
