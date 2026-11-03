import { expect, it } from 'vitest';
import { cloudRequestCredential } from './cloud-request-credential.js';
import { deserializeCloudCredential } from '../packages/llm/src/cloud/credentials.js';
import { deserializeProviderCredentialGrant } from '../packages/llm/src/credential-grant.js';

it('negotiates a verified cloud principal without changing legacy carriers or guessing ambient identity', () => {
  const identity = 'a'.repeat(64), credential = { type: 'bearer' as const, token: 'rotating-fixture-token' };
  const legacy = cloudRequestCredential('vertex', { credential, replayIdentity: identity }).serialize();
  expect(deserializeCloudCredential('vertex', legacy)).toEqual(credential);
  const grant = deserializeProviderCredentialGrant('vertex', cloudRequestCredential('vertex', { credential, replayIdentity: identity }, 1).serialize());
  expect(grant.identity).toBe(identity); expect(deserializeCloudCredential('vertex', grant.credential)).toEqual(credential);
  expect(cloudRequestCredential('vertex', credential, 1).serialize()).toBe(legacy);
  expect(() => cloudRequestCredential('vertex', { credential, replayIdentity: 'unverified-subject' }, 1)).toThrow(/verified/);
});
