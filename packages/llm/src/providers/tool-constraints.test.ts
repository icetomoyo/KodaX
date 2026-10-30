import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider, createCloudProviderConfig, runWithProviderCredential, serializeCloudCredential,
  registerCustomProviders, resolveModelCapabilities, getModelCapabilities, getProvider,
  type KodaXToolDefinition, type KodaXCustomProviderConfig } from '../index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('declares native strict support on curated Anthropic/OpenAI aliases without enabling it on legacy tools', () => {
  expect(getModelCapabilities('anthropic', 'claude-sonnet-4-6')?.toolCapabilities).toEqual({ strict: true });
  expect(getProvider('anthropic').getToolCapabilities()).toEqual({ strict: true });
  expect(getProvider('openai').getToolCapabilities()).toEqual({ strict: true });
  expect(getModelCapabilities('anthropic', 'claude-opus-4-7')?.reasoningProfile?.supportsThinkingDisplay).toBe(true);
});
it('exposes declared model tool capabilities without credentials or mutable query aliases', () => {
  registerCustomProviders([{ name: 'declared-tools', protocol: 'openai', api: 'responses', model: 'default',
    baseUrl: 'https://tools.example/v1', apiKeyEnv: 'NO_TOOL_KEY', toolCapabilities: { strict: true, grammar: ['lark'] },
    cacheCapabilities: { dialect: 'openai-options', longTtl: '12h' },
    models: [{ id: 'json-only', toolCapabilities: { strict: true, grammar: [] } }] }]);
  const defaults = resolveModelCapabilities('declared-tools', 'default');
  expect(defaults?.toolCapabilities).toEqual({ strict: true, grammar: ['lark'] });
  expect(defaults?.cacheCapabilities).toEqual({ dialect: 'openai-options', longTtl: '12h' });
  expect(resolveModelCapabilities('declared-tools', 'json-only')?.toolCapabilities).toEqual({ strict: true, grammar: [] });
  if (defaults?.toolCapabilities) defaults.toolCapabilities.strict = false;
  expect(resolveModelCapabilities('declared-tools', 'default')?.toolCapabilities?.strict).toBe(true);
  registerCustomProviders([]);
});
it('sends declared strict Responses tools without changing the caller schema or legacy defaults', async () => {
  vi.stubEnv('STRICT_KEY', 'fixture');
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ status: 'completed', output: [] })); vi.stubGlobal('fetch', fetcher);
  const provider = createCustomProvider({ name: 'strict', protocol: 'openai', api: 'responses', model: 'fixture',
    baseUrl: 'https://strict.example/v1', apiKeyEnv: 'STRICT_KEY', toolCapabilities: { strict: true } });
  const tool: KodaXToolDefinition = { name: 'read', description: 'Read', strict: 'require', input_schema: {
    type: 'object', properties: { path: { type: 'string' }, options: { type: 'object', properties: { start: { type: 'integer' } } } }, required: ['path'] } };
  const before = structuredClone(tool);
  await provider.complete([], [tool, { ...tool, name: 'legacy', strict: undefined }], '');
  const tools = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).tools;
  expect(tools[0]).toMatchObject({ strict: true, parameters: { additionalProperties: false, required: ['path', 'options'], properties: {
    options: { anyOf: [{ type: 'object', additionalProperties: false, required: ['start'], properties: { start: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } }, { type: 'null' }] },
  } } });
  expect(tools[1].strict).toBe(false); expect(tools[1].parameters).toEqual(tool.input_schema); expect(tool).toEqual(before);
});

it('drops only preferred constraints after a hard strict rejection and preserves required tools', async () => {
  vi.stubEnv('STRICT_KEY', 'fixture');
  let attempts = 0;
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ++attempts === 1
    ? Response.json({ error: { message: 'strict tool schema limits exceeded' } }, { status: 400 }) : Response.json({ status: 'completed', output: [] }));
  vi.stubGlobal('fetch', fetcher);
  const provider = createCustomProvider({ name: 'strict', protocol: 'openai', api: 'responses', model: 'fixture', baseUrl: 'https://strict.example/v1', apiKeyEnv: 'STRICT_KEY', toolCapabilities: { strict: true } });
  const tool: KodaXToolDefinition = { name: 'preferred', strict: 'prefer', description: 'Read', input_schema: { type: 'object', properties: {}, required: [] } };
  await provider.complete([], [tool, { ...tool, name: 'required', strict: 'require' }], '');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).tools.map((t: { strict: boolean }) => t.strict)).toEqual([true, true]);
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).tools.map((t: { strict: boolean }) => t.strict)).toEqual([false, true]);
});

it('rejects unknown/unsupported required constraints locally and preserves preferred original schemas', async () => {
  vi.stubEnv('STRICT_KEY', 'fixture');
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ status: 'completed', output: [] })); vi.stubGlobal('fetch', fetcher);
  const config = { name: 'strict', protocol: 'openai' as const, api: 'responses' as const, model: 'fixture', baseUrl: 'https://strict.example/v1', apiKeyEnv: 'STRICT_KEY' };
  const tool: KodaXToolDefinition = { name: 'read', description: 'Read', strict: 'require', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
  await expect(createCustomProvider(config).complete([], [tool], '')).rejects.toThrow(/does not declare strict/);
  expect(fetcher).not.toHaveBeenCalled();
  const schema = { ...tool.input_schema, additionalProperties: true };
  const provider = createCustomProvider({ ...config, toolCapabilities: { strict: true }, models: [{ id: 'legacy', toolCapabilities: { strict: false } }] });
  await expect(provider.complete([], [tool], '', undefined, { modelOverride: 'legacy' })).rejects.toThrow(/does not declare strict/);
  await expect(provider.complete([], [{ ...tool, input_schema: schema }], '')).rejects.toThrow(/additional properties/);
  expect(fetcher).not.toHaveBeenCalled();
  await provider.complete([], [{ ...tool, strict: 'prefer', input_schema: schema }], '');
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).tools[0]).toMatchObject({ strict: false, parameters: schema });
});

it('singleAttempt never multiplies a preferred-constraint hard rejection', async () => {
  vi.stubEnv('STRICT_KEY', 'fixture');
  const fetcher = vi.fn(async () => Response.json({ error: { message: 'strict tool limits exceeded' } }, { status: 400 })); vi.stubGlobal('fetch', fetcher);
  const provider = createCustomProvider({ name: 'strict', protocol: 'openai', api: 'responses', model: 'fixture', baseUrl: 'https://strict.example/v1', apiKeyEnv: 'STRICT_KEY', toolCapabilities: { strict: true } });
  await expect(provider.complete([], [{ name: 'read', description: 'Read', strict: 'prefer', input_schema: { type: 'object', properties: {} } }], '', undefined, { singleAttempt: true })).rejects.toThrow(/limits exceeded/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['anthropic', 'chat', 'mistral', 'gemini', 'bedrock', 'pi'] as const)('lowers required strict tools using the native %s protocol', async route => {
  vi.stubEnv('STRICT_KEY', 'fixture');
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => route === 'pi'
    ? new Response('data: {"type":"start"}\n\ndata: {"type":"done","reason":"stop"}\n\n')
    : Response.json(route === 'anthropic' ? { content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 0 } }
      : route === 'gemini' ? { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }
      : route === 'bedrock' ? { output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn' }
      : { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }));
  vi.stubGlobal('fetch', fetcher);
  const base = { name: 'strict', model: 'fixture', maxOutputTokens: 100, toolCapabilities: { strict: true } };
  const config: KodaXCustomProviderConfig = route === 'gemini' || route === 'bedrock'
    ? { ...createCloudProviderConfig(route === 'gemini' ? { name: base.name, model: base.model, service: 'gemini' }
      : { name: base.name, model: base.model, service: 'bedrock', region: 'us-east-1' }), ...base }
    : { ...base, protocol: route === 'anthropic' ? 'anthropic' : route === 'mistral' ? 'mistral' : route === 'pi' ? 'pi-messages' : 'openai',
      baseUrl: 'https://strict.example/v1', apiKeyEnv: 'STRICT_KEY' };
  const provider = createCustomProvider(config);
  const tool: KodaXToolDefinition = { name: 'read', description: 'Read', strict: 'require', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
  const token = config.cloud ? serializeCloudCredential(config.name, route === 'gemini' ? { type: 'api-key', key: 'fixture' } : { type: 'bearer', token: 'fixture' }) : 'fixture';
  await runWithProviderCredential('strict', token, () => provider.complete([], [tool], ''));
  const rawBody = fetcher.mock.calls[0]?.[1]?.body;
  const body = JSON.parse(typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody as Uint8Array).toString());
  if (route === 'anthropic') expect(body.tools[0].strict).toBe(true);
  else if (route === 'chat' || route === 'mistral') expect(body.tools[0].function.strict).toBe(true);
  else if (route === 'gemini') expect(body.toolConfig.functionCallingConfig.mode).toBe('VALIDATED');
  else if (route === 'bedrock') expect(body.toolConfig.tools[0].toolSpec.strict).toBe(true);
  else expect(body.context.messages[0].toolsAdded[0].constrainedSampling).toEqual({ type: 'json_schema', strict: 'require' });
});
