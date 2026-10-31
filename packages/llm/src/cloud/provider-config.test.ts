import { describe, expect, it } from 'vitest';
import { createCloudProviderConfig } from './provider-config.js';
import { validateCustomProviderConfig } from '../providers/custom-provider.js';
import type { KodaXCustomProviderConfig } from '../types.js';

describe('public native cloud connection metadata', () => {
  it('rejects nested credential material before setup can persist it', () => {
    const config = createCloudProviderConfig({ service: 'gemini', name: 'cloud', model: 'chosen' });
    expect(() => validateCustomProviderConfig({ ...config, cloud: { service: 'gemini', apiKey: 'must-not-persist' } } as unknown as KodaXCustomProviderConfig)).toThrow(/metadata/);
  });
  it.each(['http://resource.openai.azure.com', 'https://user:secret@resource.openai.azure.com', 'https://resource.openai.azure.com/?api-key=secret', 'https://resource.openai.azure.com/other'])('rejects invalid Azure resource metadata %s', endpoint => {
    expect(() => createCloudProviderConfig({ service: 'azure', endpoint, name: 'cloud', model: 'chosen' })).toThrow();
  });
  it('accepts an explicit Azure v1 endpoint and China Bedrock region without changing old API selectors', () => {
    expect(createCloudProviderConfig({ service: 'azure', endpoint: 'https://resource.services.ai.azure.com/openai/v1/', name: 'cloud', model: 'deployment' }))
      .toMatchObject({ protocol: 'openai', api: 'responses', baseUrl: 'https://resource.services.ai.azure.com/openai/v1' });
    expect(createCloudProviderConfig({ service: 'bedrock', region: 'cn-north-1', name: 'cloud', model: 'chosen' }).baseUrl).toBe('https://bedrock-runtime.cn-north-1.amazonaws.com.cn');
    expect(() => validateCustomProviderConfig({ ...createCloudProviderConfig({ service: 'gemini', name: 'cloud', model: 'chosen' }), protocol: 'openai' })).toThrow(/match/);
    expect(() => createCloudProviderConfig({ service: 'vertex', name: 'cloud', model: 'chosen', project: 'project' })).toThrow(/both/);
  });
});
