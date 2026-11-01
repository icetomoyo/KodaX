import { expect, it } from 'vitest';
import { deserializeProviderCredentialGrant, serializeProviderCredentialGrant } from './credential-grant.js';

const prefix = 'kodax-provider-grant-v1:';
const encoded = (value: unknown) => prefix + Buffer.from(JSON.stringify(value)).toString('base64url');
it('roundtrips only trusted fields and keeps legacy strings unchanged', () => {
  const grant = { provider: 'openai', credential: 'selected-fixture', identity: 'a'.repeat(64), recoverable: true };
  expect(deserializeProviderCredentialGrant('openai', serializeProviderCredentialGrant(grant))).toEqual(grant);
  expect(deserializeProviderCredentialGrant('openai', 'legacy-fixture')).toEqual({ provider: 'openai', credential: 'legacy-fixture' });
  expect(deserializeProviderCredentialGrant('openai', encoded({ ...grant, recoverable: false, extra: 'not authority' }))).toEqual({ ...grant, recoverable: undefined });
});
it.each([null, [], { provider: 'another', credential: 'selected-fixture' },
  { provider: 'openai', credential: '' }, { provider: 'openai', credential: 'private\r\nheader' },
  { provider: 'openai', credential: prefix + 'nested' },
  { provider: 'openai', credential: 'selected-fixture', identity: 'unverified' },
  { provider: 'openai', credential: 'selected-fixture', recoverable: 'true' },
])('rejects malformed or foreign grants with a static diagnostic: %j', value => {
  expect(() => deserializeProviderCredentialGrant('openai', encoded(value))).toThrow(/^Invalid provider credential grant\.$/);
});
it('bounds decoding and never emits parser excerpts containing credential bytes', () => {
  for (const carrier of [prefix + Buffer.from('{"credential":"private-partial').toString('base64url'), prefix + 'a'.repeat(1024 * 1024)]) {
    expect(() => deserializeProviderCredentialGrant('openai', carrier)).toThrow(/^Invalid provider credential grant\.$/);
  }
  expect(() => serializeProviderCredentialGrant({ provider: ' ', credential: 'private' })).toThrow(/^Invalid provider credential grant\.$/);
});
