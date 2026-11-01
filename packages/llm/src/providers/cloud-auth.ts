import { credentialFingerprint } from '../credential-fingerprint.js';
import { getScopedCloudCredential, getScopedProviderReplayIdentity, hasScopedProviderCredentialAuthority } from '../provider-credential-context.js';
import type { KodaXCloudCredential } from '../cloud/credentials.js';
import { requestIdentity } from './request-extensions.js';

export function requireCloudCredential(provider: string): KodaXCloudCredential {
  const credential = getScopedCloudCredential(provider);
  if (!credential) throw new Error('Cloud provider requires an explicit request credential broker.');
  return credential;
}
export function isCloudConfigured(provider: string): boolean { return hasScopedProviderCredentialAuthority(provider) === true; }
export function cloudCredentialScope(provider: string): string {
  const identity = getScopedProviderReplayIdentity(provider);
  if (identity) return credentialFingerprint(['trusted-registration', identity], requestIdentity());
  const credential = getScopedCloudCredential(provider);
  return credential ? credentialFingerprint(credential, requestIdentity()) : 'unavailable';
}
