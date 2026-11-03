import { afterEach, expect, it, vi } from 'vitest';
import { calculateCostWithCacheLifetimes, createCustomProvider, runWithProviderRequestObserver, type ProviderRequestObservation } from '../index.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it.each(['chat', 'responses'].flatMap(api => ['measured', 'missing', 'malformed', 'partial'].map(mode => ({ api, mode }))))(
  'retains Kimi $api cache writes with $mode lifetime evidence', async ({ api, mode }) => {
  vi.stubEnv('CACHE_USAGE_KEY', 'offline');
  const usage = api === 'chat'
    ? { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
        prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 300 } }
    : { input_tokens: 1000, output_tokens: 100, total_tokens: 1100,
        input_tokens_details: { cached_tokens: 400, cache_write_tokens: 300 } };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(api === 'chat'
    ? { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage }
    : { status: 'completed', output: [], usage }, { headers: mode === 'missing' ? {} : {
      'Msh-Usage-Cache-Write-Tokens-5m': mode === 'malformed' ? '-1' : '200',
      'Msh-Usage-Cache-Write-Tokens-1h': mode === 'partial' ? '50' : '100',
    } })));
  const provider = createCustomProvider({ name: 'cache-usage', model: 'fixture', protocol: 'openai',
    ...(api === 'responses' ? { api: 'responses' as const } : {}),
    baseUrl: 'https://cache.example/v1', apiKeyEnv: 'CACHE_USAGE_KEY', maxOutputTokens: 100 });
  const facts: ProviderRequestObservation[] = [];
  const result = await runWithProviderRequestObserver(fact => facts.push(fact), () => provider.complete([], [], ''));
  const expected = mode === 'measured' ? { '5m': 200, '1h': 100 } : { unknown: 300 };
  expect(result.usage).toMatchObject({ inputTokens: 1000, cachedReadTokens: 400,
    cachedWriteTokens: 300, cachedWriteTokensByTtl: expected });
  expect(facts.find(fact => fact.wireObservation === 'observed' && fact.state === 'succeeded')?.usage?.cachedWriteTokensByTtl).toEqual(expected);
  const cost = calculateCostWithCacheLifetimes({ inputPer1M: 1, outputPer1M: 2, cacheReadPer1M: 0.1,
    cacheWritePer1MByTtl: { '5m': 1.25, '1h': 2 } }, 1000, 100, 400, 300, result.usage?.cachedWriteTokensByTtl);
  if (mode === 'measured') expect(cost).toBeCloseTo(0.00099);
  else expect(cost).toBeNull();
});
it.each(['anthropic', 'responses'] as const)('preserves native %s cache-write lifetimes through the result and physical observation', async route => {
  vi.stubEnv('CACHE_USAGE_KEY', 'fixture');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(route === 'anthropic'
    ? { content: [], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 4000, cache_creation_input_tokens: 7000,
      cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 4000 } } }
    : { status: 'completed', output: [], usage: { input_tokens: 12000, output_tokens: 0, total_tokens: 12000, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000,
      cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 } } } })));
  const provider = createCustomProvider({ name: 'cache-usage', model: 'fixture', protocol: route === 'anthropic' ? 'anthropic' : 'openai',
    ...(route === 'responses' ? { api: 'responses' as const } : {}), baseUrl: 'https://cache.example/v1', apiKeyEnv: 'CACHE_USAGE_KEY', maxOutputTokens: 100 });
  const facts: ProviderRequestObservation[] = [];
  const result = await runWithProviderRequestObserver(fact => facts.push(fact), () => provider.complete([], [], ''));
  const expected = route === 'anthropic' ? { '5m': 3000, '1h': 4000 } : { '30m': 3000, '12h': 4000 };
  expect(result.usage).toMatchObject({ inputTokens: 12000, cachedReadTokens: 4000, cachedWriteTokens: 7000, cachedWriteTokensByTtl: expected });
  expect(facts.find(fact => fact.wireObservation === 'observed' && fact.state === 'succeeded')?.usage?.cachedWriteTokensByTtl).toEqual(expected);
});

it('keeps incomplete cache-write lifetime partitions unknown rather than pricing their remainder as short TTL', () => {
  expect(calculateCostWithCacheLifetimes({ inputPer1M: 1, outputPer1M: 2, cacheWritePer1M: 1.25,
    cacheWritePer1MByTtl: { '30m': 1.25 } }, 7000, 0, 0, 7000, { '30m': 3000 })).toBeNull();
});
