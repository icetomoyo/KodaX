import { serializeCloudCredential, validateCustomProviderConfig, type KodaXCloudCredential, type KodaXCustomProviderConfig } from '@kodax-ai/llm';
import type { RuntimeCredentialService, RuntimeScopedCredentialRequest } from './client-host-authorization.js';
import { bindRequestCredentials, type RuntimeRequestCredentialBinding } from './request-credential-binding.js';

export type RuntimeCloudCredentialBinding = RuntimeRequestCredentialBinding;
/** Trusted host may resolve ADC, Workload Identity, AWS profiles/STS or Entra using its own SDK provider. */
export async function bindCloudCredentials(input: {
  credentials: RuntimeCredentialService; provider: KodaXCustomProviderConfig;
  resolve(request: RuntimeScopedCredentialRequest, signal: AbortSignal): Promise<KodaXCloudCredential>;
}): Promise<RuntimeCloudCredentialBinding> {
  validateCustomProviderConfig(input.provider);
  if (!input.provider.cloud) throw new Error('Cloud binding requires native cloud connection metadata.');
  const cloud = { ...input.provider.cloud };
  const name = input.provider.name;
  return bindRequestCredentials({ credentials: input.credentials, provider: name, async acquire(request, signal) {
    try {
      const credential = await input.resolve(request, signal);
      signal.throwIfAborted();
      if ((cloud.service === 'gemini' && credential.type !== 'api-key')
        || (cloud.service === 'bedrock' && credential.type === 'api-key')
        || (cloud.service !== 'bedrock' && credential.type === 'aws')
        || (cloud.service === 'vertex' && credential.type === 'bearer' && !cloud.project)) throw new Error('Cloud credential does not match the native route.');
      return serializeCloudCredential(name, credential);
    } catch { throw new Error('Cloud credential broker acquisition failed.'); }
  } });
}
