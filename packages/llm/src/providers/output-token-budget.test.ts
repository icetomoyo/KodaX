import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import { getModelCapabilities, getProvider } from './registry.js';
import { runWithScopedConfig } from '../run-scoped-config.js';
import { validateProviderCapabilitiesJson } from './provider-capabilities.types.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid service output ceiling %s', (limit) => {
  for (const fields of [{ outputTokenLimit: limit }, { models: [{ id: 'large', outputTokenLimit: limit }] }]) {
    const config = { name: 'invalid-limit', protocol: 'openai' as const, baseUrl: 'https://fixture.invalid/v1',
      apiKeyEnv: 'BUDGET_TEST_KEY', model: 'large', ...fields };
    expect(() => createCustomProvider(config)).toThrow(/outputTokenLimit/);
    expect(() => validateProviderCapabilitiesJson({ version: 1, updatedAt: '2026-10-29', providers: {
      fixture: { apiKeyEnv: 'BUDGET_TEST_KEY', model: 'large', reasoningCapability: 'none',
        capabilityProfile: 'native', verifyStrategy: 'models-list', ...fields },
    } })).toThrow(/outputTokenLimit/);
  }
});

it.each(['anthropic', 'openai'] as const)('%s keeps the default budget independent of the service limit', async (protocol) => {
  vi.stubEnv('BUDGET_TEST_KEY', 'fixture-key');
  vi.stubEnv('KODAX_MAX_OUTPUT_TOKENS', '');
  const config = {
    name: 'budget-test', protocol, baseUrl: 'https://fixture.invalid/v1', apiKeyEnv: 'BUDGET_TEST_KEY',
    model: 'large', maxOutputTokens: 4096, outputTokenLimit: 8192,
    models: [{ id: 'large', outputTokenLimit: 1_000_000 }, { id: 'small', outputTokenLimit: 2048 }],
  };
  const provider = createCustomProvider(config);
  expect(provider.getEffectiveMaxOutputTokens('large')).toBe(4096);
  expect(provider.getEffectiveMaxOutputTokens('small')).toBe(2048);
  expect(runWithScopedConfig({ maxOutputTokens: 3000 }, () => provider.getEffectiveMaxOutputTokens('small'))).toBe(2048);
  provider.setMaxOutputTokensOverride(5000);
  expect(provider.getEffectiveMaxOutputTokens('small')).toBe(2048);
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (body.stream) {
      const data = protocol === 'anthropic'
        ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        : 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return new Response(data, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(protocol === 'anthropic'
      ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
      : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    { headers: { 'content-type': 'application/json' } });
  });
  for (const method of ['stream', 'complete'] as const) {
    await provider[method]([{ role: 'user', content: 'hello' }], [], '', false,
      { modelOverride: 'small', maxOutputTokensOverride: 9000 });
    const request = requests.at(-1)!;
    expect(request[protocol === 'anthropic' ? 'max_tokens' : 'max_completion_tokens']).toBe(2048);
  }
});

it.each([
  ['minimax-coding', 'MiniMax-M3.1-Flash', 131_072, 524_288],
  ['ark-coding', 'kimi-k2.8-preview', 128_000, 1_024_000],
])('%s/%s publishes hard limits separately from default request budgets', (provider, model, budget, limit) => {
  expect(getModelCapabilities(provider, model)).toMatchObject({ maxOutputTokens: budget, outputTokenLimit: limit });
  expect(getProvider(provider).getEffectiveMaxOutputTokens(model)).toBe(budget);
});
