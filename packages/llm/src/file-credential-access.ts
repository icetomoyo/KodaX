import type { FileProviderCredentialStore, ProviderCredentialFileBinding } from './auth-file.js';
import type { ProviderCredentialLeaseAccess } from './provider-credential-context.js';
import { serializeCloudCredential } from './cloud/credentials.js';
import type { KodaXCloudConnection } from './types.js';

export type FileProviderCredentialAccessBinding = ProviderCredentialFileBinding & { readonly cloud?: KodaXCloudConnection['service'] };

/** Trusted SDK/Main adapter. The file is read afresh for each approved physical request. */
export function createFileProviderCredentialAccess(input: {
  readonly store: FileProviderCredentialStore;
  readonly bindings: readonly FileProviderCredentialAccessBinding[];
}): ProviderCredentialLeaseAccess {
  const bindings = new Map(input.bindings.map(binding => [binding.provider, { ...binding }]));
  if (!bindings.size || bindings.size !== input.bindings.length || [...bindings.values()].some(binding =>
    !binding.provider.trim() || !binding.profile.trim() || !/^[a-f0-9]{64}$/.test(binding.connectionFingerprint)
    || (binding.cloud !== undefined && !['gemini', 'vertex', 'azure', 'bedrock'].includes(binding.cloud)))) throw new Error('Invalid approved credential bindings.');
  return { allowedProviders: [...bindings.keys()], async acquire(provider, _purpose, signal, _attribution, connectionFingerprint) {
    signal.throwIfAborted();
    const binding = bindings.get(provider);
    if (!binding || binding.connectionFingerprint !== connectionFingerprint) throw new Error('Provider credential connection is not approved.');
    const { cloud, ...fileBinding } = binding;
    const credential = await input.store.readApiKey(fileBinding); signal.throwIfAborted();
    if (!credential) throw new Error('Stored provider credential is unavailable.');
    return cloud ? serializeCloudCredential(provider, cloud === 'bedrock' ? { type: 'bearer', token: credential.key } : { type: 'api-key', key: credential.key }) : credential.key;
  } };
}
