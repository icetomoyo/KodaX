import { expect, it, vi } from 'vitest';
import { createCloudProviderConfig } from '@kodax-ai/llm';
import { createNativeCloudCredentialResolver } from './native-cloud-credentials.js';

const token = vi.fn(async () => 'google-token');
const aws = vi.fn(async () => ({ accessKeyId: 'access', secretAccessKey: 'secret', sessionToken: 'session' }));
const entra = vi.fn(async () => ({ token: 'entra-token', expiresOnTimestamp: Date.now() + 60000 }));
vi.mock('google-auth-library', () => ({ GoogleAuth: class { getAccessToken = token; } }));
vi.mock('@aws-sdk/credential-provider-node', () => ({ defaultProvider: () => aws }));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class { getToken = entra; } }));
it.each(['gemini', 'vertex', 'azure', 'bedrock'] as const)('resolves %s credentials only in the trusted Main and reads exact keys afresh', async service => {
  const provider = createCloudProviderConfig({ name: 'cloud', model: 'fixture', ...(service === 'vertex' ? { service, project: 'p', location: 'global' }
    : service === 'bedrock' ? { service, region: 'us-east-1' } : service === 'azure' ? { service, endpoint: 'https://fixture.openai.azure.com' } : { service }) });
  provider.apiKeyEnv = 'EXACT_CLOUD_KEY';
  const environment: Record<string, string | undefined> = { EXACT_CLOUD_KEY: 'first' };
  const resolve = createNativeCloudCredentialResolver(provider, () => environment);
  const first = await resolve(new AbortController().signal);
  expect(first).toEqual(service === 'bedrock' ? { type: 'bearer', token: 'first' } : { type: 'api-key', key: 'first' });
  environment.EXACT_CLOUD_KEY = 'second'; expect(JSON.stringify(await resolve(new AbortController().signal))).toContain('second');
  delete environment.EXACT_CLOUD_KEY;
  if (service === 'gemini') await expect(resolve(new AbortController().signal)).rejects.toThrow(/credential/i);
  else expect((await resolve(new AbortController().signal)).type).toBe(service === 'bedrock' ? 'aws' : 'bearer');
  const cancelled = new AbortController(); cancelled.abort(); await expect(resolve(cancelled.signal)).rejects.toThrow();
});
