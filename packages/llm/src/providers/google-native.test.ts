import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import { createCloudProviderConfig } from '../cloud/provider-config.js';
import { serializeCloudCredential } from '../cloud/credentials.js';
import { runWithProviderCredential, createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope, withProviderRequestCredential } from '../provider-credential-context.js';
import { runWithProviderRequestObserver, type ProviderRequestObservation } from '../provider-request-observation.js';
import { fileURLToPath } from 'node:url';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const tool = { name: 'read', description: 'read file', input_schema: { type: 'object' as const, properties: { path: { type: 'string' } } } };
const parts = [{ text: 'plan', thought: true, thoughtSignature: 'thinking-signature' }, { text: 'before' },
  { functionCall: { id: 'wire-call', name: 'read', args: { path: 'a' } }, thoughtSignature: 'tool-signature' },
  { text: '', thoughtSignature: 'empty-signature' }];
const result = { candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, thoughtsTokenCount: 5, totalTokenCount: 33, cachedContentTokenCount: 10 } };
it('uses an explicitly selected gateway bearer key without Gemini header fallback', async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }));
  vi.stubGlobal('fetch', fetch);
  const config = { ...createCloudProviderConfig({ service: 'gemini', name: 'gateway-google', model: 'chosen' }), authentication: 'bearer' as const,
    baseUrl: 'https://opencode.ai/inference/google/v1beta' };
  await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'gateway-key' }), () => createCustomProvider(config).complete([], [], ''));
  const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
  expect(headers.get('authorization')).toBe('Bearer gateway-key');
  expect(headers.has('x-goog-api-key')).toBe(false);
});
describe('native Gemini and Vertex', () => {
  it('uses GenerateContent and replays ordered signed Parts and tool receipts without changing current tools', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(result));
    vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' });
    const provider = createCustomProvider(config);
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'test-key' }), async () => {
      const first = await provider.complete([{ role: 'user', content: 'task' }], [tool], 'system');
      expect(first.stopReason).toBe('tool_use');
      expect(first.contentBlocks?.map(b => b.type)).toEqual(['thinking', 'text', 'tool_use', 'text']);
      expect(first.toolBlocks[0]).toMatchObject({ id: 'wire-call', name: 'read', input: { path: 'a' } });
      expect(first.usage).toEqual({ inputTokens: 20, outputTokens: 13, thoughtTokens: 5, cachedReadTokens: 10, totalTokens: 33 });
      await provider.complete([{ role: 'assistant', content: first.contentBlocks! },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'wire-call', content: 'ok' }] }], [], 'system');
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/chosen:generateContent');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-goog-api-key')).toBe('test-key');
    const replay = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(replay.contents).toEqual([{ role: 'model', parts }, { role: 'user', parts: [{ functionResponse: { id: 'wire-call', name: 'read', response: { output: 'ok' } } }] }]);
    expect(replay.tools).toBeUndefined();
  });
  it('reads split SSE through the final signature and usage chunk before returning tools', async () => {
    const events = [
      { candidates: [{ content: { parts: parts.slice(0, 2) } }] },
      { candidates: [{ content: { parts: parts.slice(2) }, finishReason: 'STOP' }] },
      { usageMetadata: result.usageMetadata },
    ];
    const wire = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < wire.length; i += 7) controller.enqueue(wire.slice(i, i + 7));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' });
    const onTextDelta = vi.fn(), onThinkingDelta = vi.fn(), onToolInputDelta = vi.fn();
    const response = await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'test-key' }),
      () => createCustomProvider(config).stream([], [tool], '', undefined, { onTextDelta, onThinkingDelta, onToolInputDelta }));
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://generativelanguage.googleapis.com/v1beta/models/chosen:streamGenerateContent?alt=sse');
    expect(response.contentBlocks).toHaveLength(4);
    expect(response.usage?.totalTokens).toBe(33);
    expect(onTextDelta).toHaveBeenCalledWith('before');
    expect(onThinkingDelta).toHaveBeenCalledWith('plan');
    expect(onToolInputDelta).toHaveBeenCalledWith('read', '{"path":"a"}', { toolId: 'wire-call' });
  });
  it.each([
    [{ service: 'vertex' as const, project: 'project-a', location: 'global' }, 'https://aiplatform.googleapis.com/v1/projects/project-a/locations/global/publishers/google/models/chosen:generateContent', 'bearer'],
    [{ service: 'vertex' as const, project: 'project-a', location: 'us-central1' }, 'https://us-central1-aiplatform.googleapis.com/v1/projects/project-a/locations/us-central1/publishers/google/models/chosen:generateContent', 'bearer'],
    [{ service: 'vertex' as const }, 'https://aiplatform.googleapis.com/v1/publishers/google/models/chosen:generateContent', 'api-key'],
  ] as const)('selects the declared Vertex route without ADC for %j', async (route, url, mode) => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(result));
    vi.stubGlobal('fetch', fetch); vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', 'must-not-read'); vi.stubEnv('GEMINI_API_KEY', 'must-not-use');
    const config = createCloudProviderConfig({ ...route, name: 'vertex-test', model: 'chosen' });
    const credential = mode === 'bearer' ? { type: 'bearer' as const, token: 'cloud-token' } : { type: 'api-key' as const, key: 'express-key' };
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, credential), () => createCustomProvider(config).complete([], [], ''));
    expect(fetch.mock.calls[0]?.[0]).toBe(url);
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe(mode === 'bearer' ? 'Bearer cloud-token' : null);
    expect(headers.get('x-goog-api-key')).toBe(mode === 'api-key' ? 'express-key' : null);
    await expect(createCustomProvider(config).complete([], [], '')).rejects.toThrow(/broker/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['MAX_TOKENS', 'SAFETY', 'MALFORMED_FUNCTION_CALL', 'CONTINUATION', undefined])('rejects non-completed stream %s and records failed partial usage', async finishReason => {
    const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify({ ...result, candidates: [{ ...result.candidates[0], finishReason }] })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' });
    const scope = createProviderCredentialLeaseScope({ allowedProviders: [config.name], acquire: async () => serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }) });
    const facts: ProviderRequestObservation[] = [];
    try {
      await expect(runWithProviderCredentialLeaseScope(scope, () => runWithProviderRequestObserver(f => facts.push(f), () =>
        withProviderRequestCredential(config.name, 'primary', undefined, signal => createCustomProvider(config).stream([], [], '', undefined, { singleAttempt: true }, signal)))))
        .rejects.toThrow(/did not complete/);
      expect(facts.find(f => f.boundary === 'physical_attempt' && f.state === 'failed')).toMatchObject({ partialUsage: { totalTokens: 33 } });
    } finally { scope.close(); }
  });
  it.each([{ args: null }, { args: [] }, { partialArgs: [{}] }, { args: {}, willContinue: true }, { name: 1, args: {} }, { id: 1, args: {} }])('rejects incomplete or invalid function payload %j', async call => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...result, candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'read', ...call } }] } }] })));
    const config = createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' });
    await expect(runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }), () => createCustomProvider(config).complete([], [], '')))
      .rejects.toThrow(/unfinished function call/);
  });
  it('downgrades foreign or edited tool turns without sending a fake signature', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(result)); vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' });
    const provider = createCustomProvider(config);
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }), async () => {
      const first = await provider.complete([], [tool], '');
      const messages = [{ role: 'assistant' as const, content: first.contentBlocks! }, { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'wire-call', content: 'ok' }] }];
      await provider.complete(messages, [], '', undefined, { modelOverride: 'other' });
      first.toolBlocks[0]!.input = { path: 'changed' };
      await provider.complete(messages, [], '');
    });
    for (const index of [1, 2]) {
      const body = String(fetch.mock.calls[index]?.[1]?.body);
      expect(body).not.toContain('tool-signature'); expect(body).not.toContain('functionResponse'); expect(body).not.toContain('skip_thought');
      expect(body).toContain('prior_tool_call'); expect(body).toContain('prior_tool_result');
    }
  });
  it('rebuilds current tools, budgets, ephemeral suffixes and declared thinking controls on every call', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] })); vi.stubGlobal('fetch', fetch);
    const config = { ...createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' }), maxOutputTokens: 1000, outputTokenLimit: 2000,
      reasoning: { efforts: ['low', 'high'], default: 'low' } };
    const provider = createCustomProvider(config);
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }), async () => {
      await provider.complete([], [tool], 'system', undefined, { forcedToolName: 'read', maxOutputTokensOverride: 4000, ephemeralSuffix: { content: 'last' } });
      await provider.complete([], [{ ...tool, description: 'changed' }], '', { effort: 'high' });
      await provider.complete([], [], '');
      await expect(provider.complete([], [], '', undefined, { forcedToolName: 'read' })).rejects.toThrow(/absent/);
    });
    const bodies = fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(bodies[0]).toMatchObject({ generationConfig: { maxOutputTokens: 2000, thinkingConfig: { thinkingLevel: 'LOW' } }, toolConfig: { functionCallingConfig: { allowedFunctionNames: ['read'] } }, contents: [{ parts: [{ text: 'last' }] }] });
    expect(bodies[1]).toMatchObject({ generationConfig: { maxOutputTokens: 1000, thinkingConfig: { thinkingLevel: 'HIGH' } }, tools: [{ functionDeclarations: [{ description: 'changed' }] }] });
    expect(bodies[2].tools).toBeUndefined();
  });
  it.each([true, false])('serializes images only with declared image input: %s', async imageInput => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ candidates: [{ finishReason: 'STOP' }] })); vi.stubGlobal('fetch', fetch);
    const config = { ...createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' }), imageInput };
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }), () => createCustomProvider(config).complete([
      { role: 'user', content: [{ type: 'image', path: fileURLToPath(new URL('../../../../tests/fixtures/images/valid-png.png', import.meta.url)) }] },
    ], [], ''));
    const body = String(fetch.mock.calls[0]?.[1]?.body);
    expect(body.includes('inlineData')).toBe(imageInput);
    expect(body).not.toContain('fixtures');
  });
  it('preserves HTTP status and Retry-After when an overloaded gateway returns plain text', async () => {
    let count = 0;
    const fetch = vi.fn(async () => ++count === 1 ? new Response('temporary gateway overload', { status: 503, headers: { 'retry-after-ms': '1' } })
      : Response.json({ candidates: [{ finishReason: 'STOP' }] })); vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' });
    const onRetryAfter = vi.fn();
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }), () => createCustomProvider(config).complete([], [], '', undefined, { onRetryAfter }));
    expect(fetch).toHaveBeenCalledTimes(2); expect(onRetryAfter).toHaveBeenCalledWith(expect.objectContaining({ waitMs: 1, source: 'retry-after-ms' }));
  });
  it('honors budget caps, disabled defaults and the isDefault declaration', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ candidates: [{ finishReason: 'STOP' }] })); vi.stubGlobal('fetch', fetch);
    const config = { ...createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' }), maxOutputTokens: 20000, thinkingBudgetCap: 1024 };
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }), async () => {
      await createCustomProvider({ ...config, reasoningProfile: { effortStrategy: 'provider-budget', defaultEffort: 'high', budgetByEffort: { high: 8000 } } }).complete([], [], '');
      await createCustomProvider({ ...config, reasoningProfile: { effortStrategy: 'provider-budget', defaultEffort: 'none', supportsDisabledThinking: true } }).complete([], [], '');
      await createCustomProvider({ ...config, reasoningProfile: { effortStrategy: 'google-thinking-level', supportedEfforts: [{ value: 'low', isDefault: true }] } }).complete([], [], '');
    });
    const bodies = fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(bodies[0].generationConfig.thinkingConfig).toMatchObject({ thinkingBudget: 1024 });
    expect(bodies[1].generationConfig.thinkingConfig).toMatchObject({ thinkingBudget: 0 });
    expect(bodies[2].generationConfig.thinkingConfig).toMatchObject({ thinkingLevel: 'LOW' });
  });
  it('respects an explicit unsupported credential verification strategy without a billable request', async () => {
    const fetch = vi.fn(async () => Response.json({ candidates: [{ finishReason: 'STOP' }] })); vi.stubGlobal('fetch', fetch);
    const config = { ...createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' }), verifyStrategy: 'unsupported' as const };
    const result = await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }), () => createCustomProvider(config).verifyCredential());
    expect(result).toMatchObject({ ok: false, error: 'unsupported' }); expect(fetch).not.toHaveBeenCalled();
  });
  it('reports configured authority separately from a live credential probe', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hi' }] } }] })); vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' });
    const provider = createCustomProvider(config);
    expect(provider.isConfigured()).toBe(false); expect(provider.supportsNonStreamingFallback()).toBe(true); expect(provider.supportsEphemeralSuffix()).toBe(true); expect(provider.usesPromptCacheAffinity()).toBe(false);
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }), async () => {
      expect(provider.isConfigured()).toBe(true); expect(await provider.verifyCredential()).toMatchObject({ ok: true });
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ generationConfig: { maxOutputTokens: 16 } });
  });
  it('handles multiline UTF-8 SSE, comments and DONE without inventing a terminal response', async () => {
    const data = JSON.stringify({ candidates: [{ content: { parts: [{ text: '你好🌍' }] }, finishReason: 'STOP' }] }, null, 2).split('\n').map(line => `data: ${line}`).join('\r\n');
    const wire = new TextEncoder().encode(`: keepalive\r\n\r\ndata: [DONE]\r\n\r\n${data}`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < wire.length; i += 2) controller.enqueue(wire.slice(i, i + 2)); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } })));
    const config = createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' });
    const value = await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }), () => createCustomProvider(config).stream([], [], ''));
    expect(value.textBlocks.map(b => b.text)).toEqual(['你好🌍']);
  });
  it.each([{ error: { message: 'stream failure' } }, { promptFeedback: { blockReason: 'SAFETY' } },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] } }] }])('rejects unsupported or failed stream payload %#', async value => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${JSON.stringify(value)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })));
    const config = createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' });
    await expect(runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }),
      () => createCustomProvider(config).stream([], [], '', undefined, { singleAttempt: true }))).rejects.toThrow();
  });
  it('does not return tools when a complete-response callback cancels the request', async () => {
    const abort = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(result)));
    const config = createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' });
    await expect(runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }),
      () => createCustomProvider(config).complete([], [], '', undefined, { onTextDelta: () => abort.abort(new DOMException('cancelled', 'AbortError')) }, abort.signal)))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
  it('keeps native error receipts and missing-image placeholders, and rejects duplicate history IDs', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(result)); vi.stubGlobal('fetch', fetch);
    const config = { ...createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' }), imageInput: true };
    const provider = createCustomProvider(config);
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }), async () => {
      const first = await provider.complete([], [], '');
      await provider.complete([{ role: 'assistant', content: first.contentBlocks! }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'wire-call', is_error: true,
        content: [{ type: 'text', text: 'failed' }, { type: 'image', path: 'C:/not-present-kodax-t08-image.png' }] }] }], [], '');
      await expect(provider.complete([{ role: 'assistant', content: [first.toolBlocks[0]!, first.toolBlocks[0]!] }], [], '')).rejects.toThrow(/duplicate/);
    });
    const body = String(fetch.mock.calls[1]?.[1]?.body);
    expect(body).toContain('"error":"failed"'); expect(body).toContain('Historical image unavailable'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('surfaces native thinking rejection without silently applying legacy parameter fallback', async () => {
    let count = 0;
    const fetch = vi.fn(async () => ++count === 1 ? Response.json({ error: { message: "Unsupported parameter: 'thinking'." } }, { status: 400 })
      : Response.json({ candidates: [{ finishReason: 'STOP' }] })); vi.stubGlobal('fetch', fetch);
    const config = { ...createCloudProviderConfig({ service: 'gemini', name: 'google-test', model: 'chosen' }), reasoning: { efforts: ['high'], default: 'high' } };
    await expect(runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'api-key', key: 'key' }), () => createCustomProvider(config).complete([], [], '')))
      .rejects.toThrow(/Unsupported parameter/);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
