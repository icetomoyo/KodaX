import { describe, expect, it } from 'vitest';
import { serializeCloudCredential, deserializeCloudCredential, type KodaXCloudCredential } from './credentials.js';
import { createProviderCredentialLeaseScope, getScopedCloudCredential, getScopedProviderCredential, runWithProviderCredential,
  runWithProviderCredentialLeaseScope, withProviderRequestCredential, redactScopedProviderCredential } from '../provider-credential-context.js';

describe('structured cloud credentials through the existing string broker', () => {
  it('unwraps only the authorized request and redacts each AWS secret from errors and diagnostics', async () => {
    const credential = { type: 'aws' as const, accessKeyId: 'test-access', secretAccessKey: 'test-secret', sessionToken: 'test-session' };
    const envelope = serializeCloudCredential('bedrock', credential);
    const scope = createProviderCredentialLeaseScope({ allowedProviders: ['bedrock'], acquire: async () => envelope });
    try {
      await expect(runWithProviderCredentialLeaseScope(scope, () => withProviderRequestCredential('bedrock', 'primary', undefined, () => {
        expect(getScopedCloudCredential('bedrock')).toEqual(credential);
        expect(getScopedProviderCredential('bedrock')).toBeUndefined();
        expect(getScopedCloudCredential('other')).toBeUndefined();
        expect(redactScopedProviderCredential({ token: 'test-secret/test-session', key: 'test-access', envelope }))
          .toEqual({ token: '[REDACTED_CREDENTIAL]/[REDACTED_CREDENTIAL]', key: '[REDACTED_CREDENTIAL]', envelope: '[REDACTED_CREDENTIAL]' });
        throw new Error('test-secret test-access test-session');
      }))).rejects.toThrow('[REDACTED_CREDENTIAL] [REDACTED_CREDENTIAL] [REDACTED_CREDENTIAL]');
      expect(getScopedCloudCredential('bedrock')).toBeUndefined();
    } finally { scope.close(); }
  });
  it('redacts overlapping secrets without leaving suffixes in nested errors or keys', async () => {
    const envelope = serializeCloudCredential('bedrock', { type: 'aws', accessKeyId: 'key', secretAccessKey: 'key-secret', sessionToken: 'key-secret-session' });
    const scope = createProviderCredentialLeaseScope({ allowedProviders: ['bedrock'], acquire: async () => envelope });
    try {
      await expect(runWithProviderCredentialLeaseScope(scope, () => withProviderRequestCredential('bedrock', 'primary', undefined, () => {
        const error = new Error('key-secret-session key-secret key', { cause: new DOMException('key-secret', 'AbortError') });
        throw error;
      }))).rejects.toMatchObject({ message: '[REDACTED_CREDENTIAL] [REDACTED_CREDENTIAL] [REDACTED_CREDENTIAL]', cause: { message: '[REDACTED_CREDENTIAL]' } });
    } finally { scope.close(); }
  });
  it.each([
    { type: 'bearer', token: 'token', expiresAt: 1 },
    { type: 'api-key', key: '' }, { type: 'bearer', token: 'bad\r\nheader' },
    { type: 'aws', accessKeyId: 'access' }, { type: 'unknown', token: 'private' },
  ])('rejects malformed or expired credentials without exposing material: %#', async value => {
    expect(() => serializeCloudCredential('provider', value as unknown as KodaXCloudCredential)).toThrow('Invalid or expired cloud request credential.');
  });
  it('binds the carrier to its exact provider and never accepts malformed envelopes', () => {
    const value = serializeCloudCredential('vertex', { type: 'bearer', token: 'token' });
    expect(() => deserializeCloudCredential('bedrock', value)).toThrow();
    for (const carrier of ['plain-key', 'kodax-cloud-v1:bad', 'kodax-cloud-v1:' + Buffer.from('null').toString('base64url')]) expect(() => deserializeCloudCredential('vertex', carrier)).toThrow();
    expect(() => serializeCloudCredential('', { type: 'api-key', key: 'key' })).toThrow();
  });
  it('redacts cloud material for both standalone exact operations and nested request consumers', async () => {
    const value = serializeCloudCredential('cloud', { type: 'api-key', key: 'fixture-secret' });
    await expect(runWithProviderCredential('cloud', value, async () => { throw new Error('invalid fixture-secret'); })).rejects.toThrow('invalid [REDACTED_CREDENTIAL]');
    await runWithProviderCredential('cloud', value, async () => {
      await expect(withProviderRequestCredential('cloud', 'primary', undefined, () => { throw new Error('invalid fixture-secret'); })).rejects.toThrow('invalid [REDACTED_CREDENTIAL]');
    });
  });
});
