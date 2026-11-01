import { expect, it, vi } from 'vitest';
import { acquireOAuthRequestCredential } from './oauth-request-credential.js';
import { deserializeProviderCredentialGrant } from '../packages/llm/src/credential-grant.js';
import type { RuntimeScopedCredentialRequest } from './client-host-authorization.js';

const request: RuntimeScopedCredentialRequest = { requestId: 'request', leaseId: 'lease', provider: 'fixture', sessionId: 'session',
  target: { kind: 'run', runId: 'run' }, purpose: 'primary' };
it('keeps old brokers plain and negotiates stable identity only on the v1 request', async () => {
  const session = { acquire: vi.fn(async () => 'fixture-token'), replayIdentity: 'a'.repeat(64) };
  const signal = new AbortController().signal;
  expect(await acquireOAuthRequestCredential(session, request, signal)).toBe('fixture-token');
  expect(deserializeProviderCredentialGrant('fixture', await acquireOAuthRequestCredential(session,
    { ...request, credentialContextVersion: 1 }, signal))).toEqual({ provider: 'fixture', credential: 'fixture-token', identity: session.replayIdentity });
});
it('requires negotiation and the exact rejected generation before reacquiring the same session', async () => {
  const order: string[] = [];
  const acquire = vi.fn(async () => { order.push('acquire'); return 'refreshed-fixture'; });
  const recoverRejectedCredential = vi.fn(async (fingerprint: string) => { order.push(fingerprint); });
  const session = { acquire, recoverRejectedCredential };
  const signal = new AbortController().signal, rejectedCredentialFingerprint = 'b'.repeat(64);
  for (const bad of [{ ...request, rejectedCredentialFingerprint }, { ...request, credentialContextVersion: 1 as const, rejectedCredentialFingerprint: 'unverified' }]) {
    await expect(acquireOAuthRequestCredential(session, bad, signal)).rejects.toThrow(/negotiated/);
  }
  await expect(acquireOAuthRequestCredential({ acquire }, { ...request, credentialContextVersion: 1, rejectedCredentialFingerprint }, signal)).rejects.toThrow(/negotiated/);
  expect(acquire).not.toHaveBeenCalled();
  const result = await acquireOAuthRequestCredential(session, { ...request, credentialContextVersion: 1, rejectedCredentialFingerprint }, signal);
  expect(order).toEqual([rejectedCredentialFingerprint, 'acquire']);
  expect(deserializeProviderCredentialGrant('fixture', result)).toMatchObject({ credential: 'refreshed-fixture', recoverable: true });
});
