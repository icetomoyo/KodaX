import { afterEach, expect, it, vi } from 'vitest';
import { createProviderConnection, createCustomProvider, createCloudProviderConfig, runWithProviderCredential, serializeCloudCredential, runWithScopedConfig } from '../index.js';
import { applyCachePolicy } from './cache-policy.js';

it('does not treat cache-named tool arguments or JSON schema properties as protocol markers', () => {
  const literal = { cache_control: { value: 'business data' }, cachePoint: 'customer field', prompt_cache_breakpoint: false };
  const payload = { tools: [{ name: 'fixture', input_schema: { type: 'object', properties: literal } }],
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'fixture', input: literal }] },
      { role: 'user', content: [{ type: 'text', text: 'new', cache_control: { type: 'ephemeral' } }] }] };
  const cleaned = applyCachePolicy(payload, { dialect: 'anthropic', maxCheckpoints: 1 }, 'none', false, 'fixture');
  expect(cleaned.tools[0]!.input_schema.properties).toEqual(literal);
  expect(cleaned.messages[0]!.content[0]).toHaveProperty('input', literal);
  expect(cleaned.messages[1]!.content[0]).not.toHaveProperty('cache_control');
  expect(() => applyCachePolicy(payload, { dialect: 'anthropic', maxCheckpoints: 1 }, 'short', false, 'fixture')).not.toThrow();
  cleaned.tools[0]!.input_schema.properties.cache_control.value = 'changed request';
  expect(literal.cache_control.value).toBe('business data');
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('rejects a cache dialect declared for another native API before creating a connection', () => {
  expect(() => createCustomProvider({ name: 'bad-cache', protocol: 'anthropic', model: 'm', baseUrl: 'https://cache.example/v1', apiKeyEnv: 'UNUSED',
    cacheCapabilities: { dialect: 'openai-options', longTtl: '12h' } })).toThrow(/cache dialect/);
});
it('uses only declared Responses retention dialects and keeps global cache-off authoritative', async () => {
  vi.stubEnv('CACHE_KEY', 'fixture');
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ status: 'completed', output: [] })); vi.stubGlobal('fetch', wire);
  const provider = createCustomProvider({ name: 'cache', protocol: 'openai', api: 'responses', model: 'new', apiKeyEnv: 'CACHE_KEY', baseUrl: 'https://cache.example/v1',
    cacheCapabilities: { dialect: 'openai-options', longTtl: '12h' }, models: [{ id: 'older', cacheCapabilities: { dialect: 'openai-retention', longTtl: '24h' } }] });
  await provider.complete([], [], '', undefined, { cacheRetention: 'long' });
  expect(JSON.parse(String(wire.mock.calls[0]?.[1]?.body)).prompt_cache_options).toEqual({ mode: 'implicit', ttl: '12h' });
  await provider.complete([], [], '', undefined, { cacheRetention: 'long', modelOverride: 'older' });
  expect(JSON.parse(String(wire.mock.calls[1]?.[1]?.body)).prompt_cache_retention).toBe('24h');
  await runWithScopedConfig({ disablePromptCache: true }, () => provider.complete([], [], '', undefined, { cacheRetention: 'long', promptCacheKey: 'forbidden-affinity' }));
  const disabled = JSON.parse(String(wire.mock.calls[2]?.[1]?.body));
  expect(disabled.prompt_cache_options).toEqual({ mode: 'explicit' }); expect(disabled).not.toHaveProperty('prompt_cache_key');
});

it('lowers explicit Responses text boundaries only for the declared options dialect and removes them when disabled', async () => {
  vi.stubEnv('CACHE_KEY', 'fixture');
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ status: 'completed', output: [] })); vi.stubGlobal('fetch', wire);
  const provider = createCustomProvider({ name: 'cache', protocol: 'openai', api: 'responses', model: 'new', apiKeyEnv: 'CACHE_KEY', baseUrl: 'https://cache.example/v1', cacheCapabilities: { dialect: 'openai-options', longTtl: '12h' } });
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'stable' }, { type: 'cache-boundary' as const }, { type: 'text' as const, text: 'changing' }] }];
  const before = structuredClone(messages);
  await provider.complete(messages, [], '', undefined, { cacheRetention: 'long' });
  const body = JSON.parse(String(wire.mock.calls[0]?.[1]?.body));
  expect(body.prompt_cache_options.mode).toBe('explicit');
  expect(body.input[0].content[0]).toEqual({ type: 'input_text', text: 'stable', prompt_cache_breakpoint: { mode: 'explicit' } });
  expect(body.input[1].content).toBe('changing');
  await provider.complete(messages, [], '', undefined, { cacheRetention: 'none' });
  expect(String(wire.mock.calls[1]?.[1]?.body)).not.toContain('prompt_cache_breakpoint'); expect(messages).toEqual(before);
});

it('adds declared Bedrock system/tool/message checkpoints and enforces their total limit before signing', async () => {
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ output: { message: { role: 'assistant', content: [] } }, stopReason: 'end_turn' })); vi.stubGlobal('fetch', wire);
  const config = createCloudProviderConfig({ name: 'cache', service: 'bedrock', model: 'fixture', region: 'us-east-1' });
  const capabilities = { dialect: 'bedrock' as const, longTtl: '1h' as const, locations: ['system', 'tools', 'messages'] as const, maxCheckpoints: 3 };
  const tool = { name: 'read', description: 'Read', input_schema: { type: 'object' as const, properties: {} } };
  const token = serializeCloudCredential(config.name, { type: 'bearer', token: 'fixture' });
  const provider = createCustomProvider({ ...config, cacheCapabilities: capabilities });
  await runWithProviderCredential(config.name, token, () => provider.complete([{ role: 'user', content: 'task' }], [tool], 'system', undefined, { cacheRetention: 'long' }));
  const body = JSON.parse(String(wire.mock.calls[0]?.[1]?.body));
  expect(body.system.at(-1).cachePoint).toEqual({ type: 'default', ttl: '1h' });
  expect(body.toolConfig.tools.at(-1).cachePoint.ttl).toBe('1h');
  expect(body.messages.at(-1).content.at(-1).cachePoint.ttl).toBe('1h');
  await expect(runWithProviderCredential(config.name, token, () => createCustomProvider({ ...config, cacheCapabilities: { ...capabilities, maxCheckpoints: 2 } })
    .complete([{ role: 'user', content: 'task' }], [tool], 'system', undefined, { cacheRetention: 'long' }))).rejects.toThrow(/checkpoint limit/);
  expect(wire).toHaveBeenCalledOnce();
});

it('applies declared Anthropic long TTL and tool restrictions without changing legacy default cache behavior', async () => {
  vi.stubEnv('CACHE_KEY', 'fixture');
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 0 } })); vi.stubGlobal('fetch', wire);
  const config = { name: 'cache', protocol: 'anthropic' as const, model: 'fixture', maxOutputTokens: 100, apiKeyEnv: 'CACHE_KEY', baseUrl: 'https://cache.example/v1' };
  const tool = { name: 'read', description: 'Read', input_schema: { type: 'object' as const, properties: {} } };
  const provider = createCustomProvider({ ...config, cacheCapabilities: { dialect: 'anthropic', longTtl: '1h', locations: ['system', 'messages'] } });
  await provider.complete([{ role: 'user', content: 'task' }], [tool], 'system', undefined, { cacheRetention: 'long' });
  const body = JSON.parse(String(wire.mock.calls[0]?.[1]?.body));
  expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' }); expect(body.tools[0]).not.toHaveProperty('cache_control');
  expect(body.messages[0].content[0].cache_control.ttl).toBe('1h');
  await provider.complete([{ role: 'user', content: 'task' }], [tool], 'system', undefined, { cacheRetention: 'none' });
  expect(String(wire.mock.calls[1]?.[1]?.body)).not.toContain('cache_control');
  await expect(createCustomProvider(config).complete([], [], '', undefined, { cacheRetention: 'long' })).rejects.toThrow(/declared/);
});

it.each(['anthropic-messages', 'openai-completions'] as const)('uses Fireworks %s header affinity and declared short-cache restrictions', async apiId => {
  vi.stubEnv('FIREWORKS_API_KEY', 'fixture');
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(apiId === 'anthropic-messages'
    ? { content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }
    : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })); vi.stubGlobal('fetch', wire);
  const provider = createCustomProvider(createProviderConnection('fireworks', { name: 'fireworks', model: 'fixture', apiId, maxOutputTokens: 100 }));
  const tool = { name: 'read', description: 'Read', input_schema: { type: 'object' as const, properties: {} } };
  await provider.complete([{ role: 'user', content: 'task' }], [tool], 'system', undefined, { promptCacheKey: 'session-fixture' });
  const body = JSON.parse(String(wire.mock.calls[0]?.[1]?.body));
  expect(new Headers(wire.mock.calls[0]?.[1]?.headers).get('x-session-affinity')).toBe('session-fixture');
  expect(body).not.toHaveProperty('prompt_cache_key'); expect(body.metadata?.user_id).toBeUndefined();
  expect(body.tools[0]).not.toHaveProperty('cache_control');
  await provider.complete([], [], '', undefined, { promptCacheKey: 'session-fixture', cacheRetention: 'none' });
  expect(new Headers(wire.mock.calls[1]?.[1]?.headers).has('x-session-affinity')).toBe(false);
  await expect(provider.complete([], [], '', undefined, { cacheRetention: 'long' })).rejects.toThrow(/declared/);
  expect(wire).toHaveBeenCalledTimes(2);
});

it('removes Mistral header affinity as well as its body key for cache-off', async () => {
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  const provider = createCustomProvider({ name: 'mistral-cache', protocol: 'mistral', model: 'fixture', baseUrl: 'https://mistral.example/v1', apiKeyEnv: 'UNUSED', promptCacheAffinity: true });
  await runWithProviderCredential(provider.name, 'fixture', () => provider.complete([], [], '', undefined, { fetch: wire, promptCacheKey: 'stable', cacheRetention: 'none' }));
  expect(new Headers(wire.mock.calls[0]?.[1]?.headers).has('x-affinity')).toBe(false);
  expect(JSON.parse(String(wire.mock.calls[0]?.[1]?.body))).not.toHaveProperty('prompt_cache_key');
});
