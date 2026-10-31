import { expect, it, vi } from 'vitest';
import { createProviderCredentialAuthorizer } from './provider-credential-authorizer.js';
import type { RuntimeScopedCredentialBroker, KodaXClientHostAuthorization, RuntimeCredentialService } from './client-host-authorization.js';
it('does not register profile-bound authority with a different or unverified Host profile', async () => {
  const registerScoped = vi.fn();
  const authorizer = createProviderCredentialAuthorizer({ sources: [{ provider: 'profiled', kind: 'environment', apiKeyEnv: 'KEY', profile: 'work' }] });
  const request = { kind: 'provider_probe' as const, input: { provider: 'profiled', efforts: [] } };
  try {
    for (const profile of [undefined, 'default']) await expect(authorizer.authorizeExecution(request, { credentials: { registerScoped }, identity: { runtimeId: 'host', profile } } as unknown as Parameters<KodaXClientHostAuthorization>[1])).rejects.toThrow(/profile/);
    expect(registerScoped).not.toHaveBeenCalled();
  } finally { await authorizer.close(); }
});
it('rejects a linked grant belonging to another profile or Radius issuer before creating authority', () => {
  const session = { id: 'r', service: 'radius' as const, accountId: 'grant', profile: 'work', issuer: 'https://radius.example',
    acquire: vi.fn(async () => 'must-not-read'), onInvalidate: () => () => undefined,
    revoke: async () => ({ remote: 'unsupported' as const, leaseRevocationFailures: 0 }) };
  expect(() => createProviderCredentialAuthorizer({ sources: [{ provider: 'gateway', kind: 'oauth', service: 'radius', profile: 'default', issuer: session.issuer, session }] })).toThrow(/profile/);
  expect(() => createProviderCredentialAuthorizer({ sources: [{ provider: 'gateway', kind: 'oauth', service: 'radius', profile: 'work', issuer: 'https://other.example', session }] })).toThrow(/issuer/);
  const valid = createProviderCredentialAuthorizer({ sources: [{ provider: 'gateway', kind: 'oauth', service: 'radius', profile: 'work', issuer: 'https://radius.example/', session }] });
  expect(session.acquire).not.toHaveBeenCalled(); return valid.close();
});

it('requires the approved actual connection proof before reading a destination-bound secret', async () => {
  let broker!: RuntimeScopedCredentialBroker;
  const resolve = vi.fn(() => ({ APPROVED_KEY: 'bound-secret' }));
  const credentials = { registerScoped: async (_input: unknown, callback: RuntimeScopedCredentialBroker) => {
    broker = callback; return { id: 'lease', providers: ['approved'], brokerVersion: 2 as const };
  }, revoke: async () => true };
  const authorizer = createProviderCredentialAuthorizer({ sources: [{ provider: 'approved', kind: 'environment', apiKeyEnv: 'APPROVED_KEY', connectionFingerprint: 'a'.repeat(64) }], environment: resolve });
  try {
    await authorizer.authorizeExecution({ kind: 'provider_probe', input: { provider: 'approved', efforts: [] } }, { credentials, identity: { runtimeId: 'host', profile: 'default' } } as unknown as Parameters<KodaXClientHostAuthorization>[1]);
    const request = { requestId: 'r', leaseId: 'lease', provider: 'approved', sessionId: 's', target: { kind: 'run' as const, runId: 'run' }, purpose: 'primary' as const };
    for (const proof of [undefined, 'b'.repeat(64)]) await expect(broker({ ...request, ...(proof ? { connectionFingerprint: proof } : {}) })).rejects.toThrow(/connection/);
    expect(resolve).not.toHaveBeenCalled();
    expect(await broker({ ...request, connectionFingerprint: 'a'.repeat(64) })).toBe('bound-secret');
  } finally { await authorizer.close(); }
});

it('resolves approved environment names per request and rebinds stable facades after Host replacement', async () => {
  const environment: Record<string, string | undefined> = { APPROVED_KEY: 'first' };
  let broker: RuntimeScopedCredentialBroker | undefined; let epoch = 'host-a', counter = 0;
  const registerScoped = vi.fn(async (_input: Parameters<RuntimeCredentialService['registerScoped']>[0], callback: RuntimeScopedCredentialBroker) => { broker = callback; return { id: `lease-${++counter}`, providers: ['approved'], brokerVersion: 2 as const }; });
  const revoke = vi.fn(async () => true);
  const credentials = { registerScoped, revoke };
  const authorizer = createProviderCredentialAuthorizer({ sources: [{ provider: 'approved', kind: 'environment', apiKeyEnv: 'APPROVED_KEY' }], environment: () => environment });
  const services = { credentials, get identity() { return { runtimeId: epoch }; } };
  const authorize = () => authorizer.authorizeExecution({ kind: 'input', input: { sessionId: 's', inputId: 'i', text: 'task' } }, services as unknown as Parameters<KodaXClientHostAuthorization>[1]);
  const first = await authorize(); await authorize(); expect(registerScoped).toHaveBeenCalledOnce();
  const request = { requestId: 'r', leaseId: first!.credential!.leaseId, provider: 'approved', sessionId: 's', target: { kind: 'run' as const, runId: 'run' }, purpose: 'primary' as const };
  expect(await broker!(request)).toBe('first'); environment.APPROVED_KEY = 'second'; expect(await broker!(request)).toBe('second');
  await expect(broker!({ ...request, provider: 'UNAPPROVED_ENV' })).rejects.toThrow();
  const oldBroker = broker!; epoch = 'host-b'; const second = await authorize();
  expect(second!.credential!.leaseId).not.toBe(first!.credential!.leaseId); expect(registerScoped).toHaveBeenCalledTimes(2);
  await expect(oldBroker(request)).rejects.toThrow(/inactive/);
  await authorizer.close(); await expect(broker!({ ...request, leaseId: second!.credential!.leaseId })).rejects.toThrow(/inactive/);
});

it('rebinds a replacement Host after old remote cleanup fails and reports unrecovered cleanup', async () => {
  let epoch = 'old', count = 0;
  const credentials = { registerScoped: async () => ({ id: `lease-${++count}`, providers: ['approved'], brokerVersion: 2 as const }),
    revoke: vi.fn(async (id: string) => { if (id === 'lease-1') throw new Error('old Host unavailable'); return true; }) };
  const services = { credentials, get identity() { return { runtimeId: epoch }; } } as unknown as Parameters<KodaXClientHostAuthorization>[1];
  const authorizer = createProviderCredentialAuthorizer({ sources: [{ provider: 'approved', kind: 'environment', apiKeyEnv: 'APPROVED_KEY' }] });
  const request = { kind: 'provider_probe' as const, input: { provider: 'approved', efforts: ['high'] } };
  await authorizer.authorizeExecution(request, services); epoch = 'new';
  expect((await authorizer.authorizeExecution(request, services))!.credential!.leaseId).toBe('lease-2');
  await expect(authorizer.close()).rejects.toThrow(/cleanup failed/);
  expect(credentials.revoke).toHaveBeenCalledWith('lease-2');
});

it('uses the OAuth session profile when its source omits the duplicate field', async () => {
  const session = { id: 'work', service: 'openrouter' as const, accountId: 'a', profile: 'work',
    acquire: vi.fn(async () => 'fixture'), onInvalidate: () => () => undefined,
    revoke: async () => ({ remote: 'unsupported' as const, leaseRevocationFailures: 0 }) };
  const registerScoped = vi.fn();
  const authority = createProviderCredentialAuthorizer({ sources: [{ provider: 'p', kind: 'oauth', service: 'openrouter', session }] });
  await expect(authority.authorizeExecution({ kind: 'provider_probe', input: { provider: 'p', efforts: ['high'] } },
    { identity: { runtimeId: 'host', profile: 'default' }, credentials: { registerScoped } } as unknown as Parameters<KodaXClientHostAuthorization>[1])).rejects.toThrow(/profile/);
  expect(registerScoped).not.toHaveBeenCalled(); expect(session.acquire).not.toHaveBeenCalled();
});

it('requires an explicit approved issuer for a Radius grant', () => {
  const session = { id: 'r', service: 'radius' as const, issuer: 'https://a.invalid', accountId: 'a',
    acquire: async () => 'fixture', onInvalidate: () => () => undefined,
    revoke: async () => ({ remote: 'unsupported' as const, leaseRevocationFailures: 0 }) };
  expect(() => createProviderCredentialAuthorizer({ sources: [{ provider: 'p', kind: 'oauth', service: 'radius', session }] })).toThrow(/approved.*issuer/);
});

it('fences delayed OAuth acquisition and rejects future authorization after session revocation', async () => {
  let invalidate!: () => Promise<void>, release!: (token: string) => void, broker!: RuntimeScopedCredentialBroker;
  const pending = new Promise<string>(resolve => { release = resolve; });
  const session = { id: 'registration', service: 'openai-chatgpt' as const, accountId: 'account', acquire: async () => pending,
    onInvalidate(listener: () => Promise<void>) { invalidate = listener; return () => undefined; },
    revoke: async () => ({ remote: 'unsupported' as const, leaseRevocationFailures: 0 }) };
  const credentials = { registerScoped: async (_input: unknown, callback: RuntimeScopedCredentialBroker) => { broker = callback; return { id: 'lease', providers: ['subscription'], brokerVersion: 2 as const }; }, revoke: vi.fn(async () => true) };
  const services = { credentials, identity: { runtimeId: 'host', profile: 'default' } } as unknown as Parameters<KodaXClientHostAuthorization>[1];
  const authorizer = createProviderCredentialAuthorizer({ sources: [{ provider: 'subscription', kind: 'oauth', service: session.service, session }] });
  const request = { kind: 'provider_probe' as const, input: { provider: 'subscription', efforts: [] } };
  await authorizer.authorizeExecution(request, services);
  const acquisition = broker({ requestId: 'r', leaseId: 'lease', provider: 'subscription', sessionId: 's', target: { kind: 'run', runId: 'run' }, purpose: 'primary' });
  await invalidate(); release('late-token'); await expect(acquisition).rejects.toThrow(/inactive/);
  await expect(authorizer.authorizeExecution(request, services)).rejects.toThrow(/revoked/);
  await authorizer.close();
});

it('rejects malformed allowlists and fails explicitly when no approved credential or Host identity exists', async () => {
  const source = { provider: 'approved', kind: 'environment' as const, apiKeyEnv: 'APPROVED_KEY' };
  expect(() => createProviderCredentialAuthorizer({ sources: [source, source] })).toThrow(/Duplicate/);
  expect(() => createProviderCredentialAuthorizer({ sources: [{ ...source, provider: '' }] })).toThrow(/requires a provider/);
  expect(() => createProviderCredentialAuthorizer({ sources: [{ ...source, apiKeyEnv: 'not a variable' }] })).toThrow(/Invalid approved/);
  let broker!: RuntimeScopedCredentialBroker;
  const credentials = { registerScoped: async (_input: unknown, callback: RuntimeScopedCredentialBroker) => { broker = callback; return { id: 'lease', providers: ['approved'], brokerVersion: 2 as const }; }, revoke: async () => true };
  const authorizer = createProviderCredentialAuthorizer({ sources: [source], environment: () => ({}) });
  const request = { kind: 'provider_probe' as const, input: { provider: 'approved', efforts: [] } };
  const services = { credentials } as unknown as Parameters<KodaXClientHostAuthorization>[1];
  await expect(authorizer.authorizeExecution(request, services)).rejects.toThrow(/Host identity/);
  await authorizer.authorizeExecution(request, { ...services, identity: { runtimeId: 'host', profile: 'default' } });
  await expect(broker({ requestId: 'r', leaseId: 'lease', provider: 'approved', sessionId: 's', target: { kind: 'run', runId: 'run' }, purpose: 'primary' })).rejects.toThrow(/unavailable/);
  await authorizer.close();
  const unbound = createProviderCredentialAuthorizer({ sources: [] }); expect(await unbound.authorizeExecution(request, services)).toBeUndefined(); await unbound.close();
});
