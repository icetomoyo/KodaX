import { serializeCloudCredential, serializeProviderCredentialGrant, type KodaXCloudCredentialResolution, type KodaXCloudCredential } from '@kodax-ai/llm';

/** No ambient account inference. Older broker clients keep their original cloud carrier. */
export function cloudRequestCredential(provider: string, resolved: KodaXCloudCredentialResolution, version?: 1): {
  credential: KodaXCloudCredential; serialize(): string;
} {
  const wrapped = 'credential' in resolved;
  const credential = wrapped ? resolved.credential : resolved;
  const identity = wrapped ? resolved.replayIdentity : undefined;
  if (identity !== undefined && !/^[a-f0-9]{64}$/.test(identity)) throw new Error('Cloud replay identity must be a verified principal fingerprint.');
  return { credential, serialize() {
    const carrier = serializeCloudCredential(provider, credential);
    return version === 1 && identity ? serializeProviderCredentialGrant({ provider, credential: carrier, identity }) : carrier;
  } };
}
