import { expect, it } from 'vitest';
import { createProviderOperationConnection, listProviderPresets } from '../index.js';

it('makes classifier-only and image/deferred factory routes reachable without replacing chat aliases', () => {
  expect(createProviderOperationConnection('typesafe', { name: 'decider', model: 'jev-test', api: 'typesafe-system-one' })).toMatchObject({
    baseUrl: 'https://api.typesafe.ai/v1', apiKeyEnv: 'TYPESAFE_API_KEY', api: 'typesafe-system-one' });
  expect(createProviderOperationConnection('openrouter', { name: 'images', model: 'image-test', api: 'openrouter-images', dialect: 'images' })).toMatchObject({
    baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' });
  expect(createProviderOperationConnection('openrouter', { name: 'decider', model: 'jev-test', api: 'typesafe-system-one' }).dialect).toBe('openrouter-system-one');
  expect(createProviderOperationConnection('openai', { name: 'jobs', model: 'job-test', api: 'openai-background-responses', accountScope: 'registration-1' })).toMatchObject({
    apiKeyEnv: 'OPENAI_API_KEY', accountScope: 'registration-1' });
  expect(listProviderPresets()).toHaveLength(42);
  expect(() => createProviderOperationConnection('openai-codex', { name: 'jobs', model: 'job-test', api: 'openai-background-responses', accountScope: 'account' })).toThrow();
});
