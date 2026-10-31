import { expect, it } from 'vitest';
import { createProviderConnection, listProviderPresets } from './provider-presets.js';
import { createCustomProvider } from './providers/custom-provider.js';

it('lists the 42 source provider identities without replacing existing aliases', () => {
  const ids = listProviderPresets().map(entry => entry.id);
  expect(ids).toHaveLength(42);
  expect(new Set(ids).size).toBe(42);
  expect(ids).toEqual(expect.arrayContaining(['anthropic', 'openai', 'amazon-bedrock', 'google-vertex', 'radius', 'typesafe', 'qwen-token-plan-cn']));
  const connection = createProviderConnection('qwen-token-plan', { name: 'international-qwen', model: 'chosen' });
  expect(connection).toMatchObject({ name: 'international-qwen', protocol: 'openai', api: 'chat-completions', apiKeyEnv: 'QWEN_TOKEN_PLAN_API_KEY',
    baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' });
  expect(createCustomProvider(connection).name).toBe('international-qwen');
});
it('requires an explicit API for a multi-protocol gateway and an explicit endpoint for deployment routes', () => {
  expect(() => createProviderConnection('openrouter', { name: 'router', model: 'chosen' })).toThrow(/API/i);
  expect(createProviderConnection('openrouter', { name: 'router', model: 'chosen', apiId: 'anthropic-messages' })).toMatchObject({ protocol: 'anthropic', baseUrl: 'https://openrouter.ai/api' });
  expect(() => createProviderConnection('cloudflare-ai-gateway', { name: 'cf', model: 'chosen', apiId: 'openai-responses' })).toThrow(/endpoint/i);
  expect(() => createProviderConnection('typesafe', { name: 'classifier', model: 'chosen' })).toThrow(/classif/i);
});
it('keeps explicit OpenCode Google endpoints and selects its documented bearer API-key header', () => {
  expect(() => createProviderConnection('opencode', { name: 'zen', model: 'chosen', apiId: 'google-generative-ai' })).toThrow(/endpoint/i);
  expect(createProviderConnection('opencode', { name: 'zen', model: 'chosen', apiId: 'google-generative-ai', baseUrl: 'https://opencode.ai/inference/google/v1beta' }))
    .toMatchObject({ protocol: 'google', authentication: 'bearer', apiKeyEnv: 'OPENCODE_API_KEY', baseUrl: 'https://opencode.ai/inference/google/v1beta' });
  expect(createProviderConnection('openrouter', { name: 'router', model: 'chosen', apiId: 'anthropic-messages' })).toHaveProperty('authentication', 'bearer');
});
