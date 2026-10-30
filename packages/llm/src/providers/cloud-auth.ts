import { createHash } from 'node:crypto';
import { getScopedCloudCredential, hasScopedProviderCredentialAuthority } from '../provider-credential-context.js';
import type { KodaXCloudCredential } from '../cloud/credentials.js';

export function requireCloudCredential(provider: string): KodaXCloudCredential {
  const credential = getScopedCloudCredential(provider);
  if (!credential) throw new Error('Cloud provider requires an explicit request credential broker.');
  return credential;
}
export function isCloudConfigured(provider: string): boolean { return hasScopedProviderCredentialAuthority(provider) === true; }
export function cloudCredentialScope(provider: string): string {
  const credential = getScopedCloudCredential(provider);
  return credential ? createHash('sha256').update(JSON.stringify(credential)).digest('hex') : 'unavailable';
}
