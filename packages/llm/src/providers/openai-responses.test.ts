import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import { runWithProviderCredential, withProviderRequestCredential } from '../provider-credential-context.js';
import { runWithProviderRequestObserver, type ProviderRequestObservation } from '../provider-request-observation.js';
import { getCustomModelCapabilities, registerCustomProviders } from './custom-registry.js';

const config = {
  name: 'responses-test', protocol: 'openai' as const, api: 'responses' as const,
  model: 'test-model', apiKeyEnv: 'RESPONSES_TEST_KEY', baseUrl: 'https://responses.test/v1',
};
const output = [
  { type: 'message', id: 'msg1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'before', annotations: [] }] },
  { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'thought' }], encrypted_content: 'opaque' },
  { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'read', arguments: '{"path":"a"}', status: 'completed' },
];
function response(items = output, status = 'completed') {
  return { id: 'resp1', object: 'response', status, model: 'test-model', output: items,
    usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28, input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 3 } } };
}
function mockTransport(stream: boolean, events?: unknown[], result = response()) {
  vi.stubEnv('RESPONSES_TEST_KEY', 'test-only');
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => stream
    ? new Response((events ?? [{ type: 'response.completed', response: result }]).map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    : Response.json(result));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function body(fetch: ReturnType<typeof mockTransport>, index = 0): Record<string, unknown> {
  return JSON.parse(String((fetch.mock.calls[index] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
}
afterEach(() => { registerCustomProviders([]); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('native Responses transport', () => {
  it.each([true, false])('preserves ordered output and scoped reasoning through stream=%s replay', async (stream) => {
    const fetch = mockTransport(stream);
    const provider = createCustomProvider(config);
    const invoke = stream ? provider.stream.bind(provider) : provider.complete.bind(provider);
    const result = await invoke([{ role: 'user', content: 'hi' }], [], 'system');
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://responses.test/v1/responses');
    expect(body(fetch)).toMatchObject({ stream, store: false, model: 'test-model', instructions: 'system' });
    expect(result.contentBlocks?.map(b => b.type)).toEqual(['text', 'thinking', 'tool_use']);
    expect(result.toolBlocks[0]).toMatchObject({ id: 'call1', name: 'read', input: { path: 'a' } });
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 8, cachedReadTokens: 12, thoughtTokens: 3 });
    await invoke([{ role: 'assistant', content: result.contentBlocks! }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'ok' }] }], [], '');
    expect(body(fetch, 1).input).toEqual([
      { role: 'assistant', content: 'before' }, output[1],
      { type: 'function_call', call_id: 'call1', name: 'read', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call1', output: 'ok' },
    ]);
    await invoke([{ role: 'assistant', content: result.contentBlocks! }], [], '', undefined, { modelOverride: 'other-model' });
    expect(JSON.stringify(body(fetch, 2))).not.toContain('opaque');
  });
  it.each(['incomplete', 'failed'])('does not return executable tools from %s responses', async (status) => {
    mockTransport(true, [{ type: `response.${status}`, response: response(output, status) }]);
    await expect(createCustomProvider(config).stream([], [], '')).rejects.toThrow();
  });
  it('rejects EOF without a terminal event', async () => {
    mockTransport(true, [{ type: 'response.output_item.done', output_index: 0, item: output[2] }]);
    await expect(createCustomProvider(config).stream([], [], '')).rejects.toThrow();
  });
  it.each(['{"path":', '[]', 'null', '42'])('rejects non-object or incomplete final arguments %s', async (args) => {
    mockTransport(false, undefined, response([{ ...output[2]!, arguments: args }]));
    await expect(createCustomProvider(config).complete([], [], '')).rejects.toThrow();
  });
  it('validates the explicit API selector', () => {
    expect(() => createCustomProvider({ ...config, protocol: 'anthropic' })).toThrow(/api/i);
    expect(() => registerCustomProviders([{ ...config, protocol: 'anthropic' }])).toThrow(/api/i);
  });
  it('normalizes inline system messages consistently with the existing cache diagnostics envelope', async () => {
    const fetch = mockTransport(false);
    await createCustomProvider(config).complete([
      { role: 'system', content: [{ type: 'text', text: '  rules  ' }, { type: 'cache-boundary' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'cache-boundary' }] },
    ], [], 'base');
    expect(body(fetch)).toMatchObject({ instructions: 'base\n\n  rules  ', input: [{ role: 'user', content: 'hi' }] });
    expect(JSON.stringify(body(fetch))).not.toContain('cache-boundary');
  });
  it('exposes the same reasoning API in runtime and keyless capability queries', () => {
    const declared = { ...config, reasoning: { efforts: ['low', 'high'] }, models: [{ id: 'other', reasoning: { efforts: ['high'] } }] };
    registerCustomProviders([declared]);
    const provider = createCustomProvider(declared);
    for (const model of ['test-model', 'other']) {
      expect(provider.getReasoningProfile(model)?.effortStrategy).toBe('openai-responses-effort');
      expect(getCustomModelCapabilities(config.name, model)?.reasoningProfile).toEqual(provider.getReasoningProfile(model));
    }
  });
  it('streams text, reasoning and tool arguments without parsing partial JSON', async () => {
    mockTransport(true, [
      { type: 'response.output_text.delta', delta: 'before' },
      { type: 'response.reasoning_summary_text.delta', delta: 'thought' },
      { type: 'response.output_item.added', item: output[2] },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '"a"}' },
      { type: 'response.completed', response: response() },
    ]);
    const onTextDelta = vi.fn(), onThinkingDelta = vi.fn(), onThinkingEnd = vi.fn(), onToolInputDelta = vi.fn();
    await createCustomProvider(config).stream([], [], '', undefined, { onTextDelta, onThinkingDelta, onThinkingEnd, onToolInputDelta });
    expect(onTextDelta).toHaveBeenCalledWith('before');
    expect(onThinkingDelta).toHaveBeenCalledWith('thought');
    expect(onThinkingEnd).toHaveBeenCalledWith('thought');
    expect(onToolInputDelta.mock.calls).toEqual([['read', '{"path":', { toolId: 'call1' }], ['read', '"a"}', { toolId: 'call1' }]]);
    expect(onToolInputDelta.mock.calls.map(call => call[1]).join('')).toBe('{"path":"a"}');
  });
  it('uses each request credential and preserves failed partial usage without executing output', async () => {
    const fetch = mockTransport(false, undefined, response(output, 'incomplete'));
    const provider = createCustomProvider(config);
    const facts: ProviderRequestObservation[] = [];
    for (const key of ['lease-a', 'lease-b']) {
      await expect(runWithProviderCredential(config.name, key, () => runWithProviderRequestObserver(f => facts.push(f), () =>
        withProviderRequestCredential(config.name, 'primary', undefined, () => provider.complete([], [], ''))))).rejects.toThrow(/incomplete/);
    }
    expect(fetch.mock.calls.map(call => new Headers(call[1]?.headers).get('authorization'))).toEqual(['Bearer lease-a', 'Bearer lease-b']);
    const terminals = facts.filter(f => f.boundary === 'physical_attempt' && f.state === 'failed');
    expect(terminals).toHaveLength(2);
    expect(terminals[0]).toMatchObject({ partialUsage: { inputTokens: 20, outputTokens: 8 } });
    expect(terminals[0]?.usage).toBeUndefined();
  });
  it('keeps SDK retries disabled for singleAttempt and does not learn from a 429', async () => {
    const fetch = mockTransport(false);
    fetch.mockImplementation(async () => Response.json({ error: { message: 'rate limited', type: 'rate_limit_error' } }, { status: 429 }));
    const onReasoningEffortRejected = vi.fn();
    await expect(createCustomProvider(config).complete([], [], '', { effort: 'high' }, { singleAttempt: true, onReasoningEffortRejected })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onReasoningEffortRejected).not.toHaveBeenCalled();
  });
  it('applies current tools, output budget, cache affinity and declared default reasoning on each request', async () => {
    const fetch = mockTransport(false);
    const provider = createCustomProvider({ ...config, promptCacheAffinity: true, maxOutputTokens: 1000, outputTokenLimit: 5000,
      reasoning: { efforts: ['off', 'low', 'high'], default: 'high' } });
    const tool = { name: 'read', description: 'old', input_schema: { type: 'object' as const, properties: { path: { type: 'string' } } } };
    await provider.complete([], [tool], '', undefined, { promptCacheKey: 'context', maxOutputTokensOverride: 9000, forcedToolName: 'read' });
    expect(body(fetch)).toMatchObject({ max_output_tokens: 5000, prompt_cache_key: 'context', reasoning: { effort: 'high' },
      tools: [{ type: 'function', name: 'read', description: 'old', strict: false }], tool_choice: { type: 'function', name: 'read' } });
    await provider.complete([], [{ ...tool, description: 'new' }], '', false);
    expect(body(fetch, 1)).toMatchObject({ max_output_tokens: 1000, reasoning: { effort: 'none' }, tools: [{ description: 'new' }] });
    await provider.complete([], [], '');
    expect(body(fetch, 2).tools).toBeUndefined();
    expect(body(fetch, 2).prompt_cache_key).toBeUndefined();
  });
  it('learns only hard effort rejection and isolates learned state across credentials', async () => {
    const fetch = mockTransport(false);
    fetch.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { reasoning?: { effort?: string } };
      return request.reasoning?.effort === 'high'
        ? Response.json({ error: { message: "Unsupported value for reasoning.effort: 'high'", param: 'reasoning.effort', type: 'invalid_request_error' } }, { status: 400 })
        : Response.json(response());
    });
    const provider = createCustomProvider(config);
    const onReasoningEffortRejected = vi.fn();
    await provider.complete([], [], '', { effort: 'high' }, { onReasoningEffortRejected });
    await provider.complete([], [], '', { effort: 'high' }, { onReasoningEffortRejected });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(onReasoningEffortRejected).toHaveBeenCalledTimes(1);
    await runWithProviderCredential(config.name, 'different-account', () => provider.complete([], [], '', { effort: 'high' }, { onReasoningEffortRejected }));
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(onReasoningEffortRejected).toHaveBeenCalledTimes(2);
  });
  it('uses the Responses endpoint for opt-in minimal credential verification', async () => {
    const fetch = mockTransport(false);
    expect(await createCustomProvider({ ...config, verifyStrategy: 'minimal-message' }).verifyCredential()).toMatchObject({ ok: true, strategy: 'minimal-message' });
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/responses');
  });
  it.each(['server_error', 'insufficient_quota', 'rate_limit_exceeded'])('retains structured %s without making partial tools executable', async code => {
    mockTransport(true, [{ type: 'response.failed', response: { ...response(output, 'failed'), error: { code, message: 'fixture failure' } } }]);
    const error = await createCustomProvider(config).stream([], [], '', undefined, { singleAttempt: true }).catch((value: unknown) => value);
    expect(error).toMatchObject({ metadata: { upstreamCode: code, stage: 'response_stream', failureCode: 'response_stream_error' } });
    if (code !== 'insufficient_quota') expect(error).not.toMatchObject({ metadata: { retryable: false } });
    else expect(error).toMatchObject({ metadata: { retryable: false } });
  });
  it('preserves legacy Chat Completions routing when api is omitted', async () => {
    const fetch = mockTransport(false);
    fetch.mockImplementation(async () => Response.json({ choices: [{ message: { role: 'assistant', content: 'legacy' }, finish_reason: 'stop' }] }));
    const { api: _api, ...legacy } = config;
    expect((await createCustomProvider(legacy).complete([], [], '')).textBlocks).toEqual([{ type: 'text', text: 'legacy' }]);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/chat/completions');
  });
});
