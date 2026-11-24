import { hasProviderCredentialContext } from './provider-credential-context.js';

/** The key a process owner keeps for a provider at this connection, or `undefined`. */
export type AmbientProviderKeySource = (provider: string, connectionFingerprint: string) => string | undefined;

let installed: AmbientProviderKeySource | undefined;

/**
 * Lets the process owner (the Host) supply the keys it keeps on disk. Asked
 * only when the environment holds no key and no credential scope is active.
 * Returns the function that removes it.
 */
export function setAmbientProviderKeySource(source: AmbientProviderKeySource): () => void {
  if (installed !== undefined) throw new Error('A provider key source is already installed.');
  installed = source;
  return () => { if (installed === source) installed = undefined; };
}

/** The environment's key, else the owner's stored key for this connection. Inside a credential scope, the scope decides. */
export function ambientProviderKey(
  provider: string,
  environmentValue: string | undefined,
  connectionFingerprint: () => string,
): string | undefined {
  if (environmentValue || installed === undefined || hasProviderCredentialContext()) return environmentValue;
  return installed(provider, connectionFingerprint()) || undefined;
}
