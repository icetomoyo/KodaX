import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import { registerCustomProviders } from './custom-registry.js';
import { resolveWireEffort } from '../wire-effort.js';
import { resolveReasoningEffort } from '../reasoning.js';
import type { KodaXCustomProviderConfig } from '../types.js';

const config: KodaXCustomProviderConfig = {
  name: 'unknown-reasoning', protocol: 'openai', model: 'unknown-model',
  baseUrl: 'https://reasoning.test/v1', apiKeyEnv: 'TEST_REASONING_KEY',
};

function mockWire(reply?: (body: Record<string, unknown>) => Response) {
  vi.stubEnv('TEST_REASONING_KEY', 'test-key');
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push(body);
    return reply?.(body) ?? completed(body);
  }));
  return requests;
}

function completed(body: Record<string, unknown>, reasoning: Record<string, unknown> = {}) {
  const message = { content: 'ok', ...reasoning };
  return body.stream
    ? new Response(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
    : Response.json({ choices: [{ message, finish_reason: 'stop' }] });
}

afterEach(() => {
  registerCustomProviders([]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('custom OpenAI reasoning negotiation', () => {
  it.each(['stream', 'complete'] as const)('%s parses reasoning and preserves structured details for same-model replay', async method => {
    const details = [
      { type: 'reasoning.text', text: 'Consider the input.', id: 'r1', index: 0, signature: 'sig', format: 'anthropic-claude-v1' },
      { type: 'reasoning.encrypted', data: 'opaque', id: 'r2', index: 1, format: 'openai-responses-v1' },
    ];
    const requests = mockWire(body => completed(body, { reasoning: 'Consider the input.', reasoning_details: details }));
    const provider = createCustomProvider(config);
    const onThinkingDelta = vi.fn();
    const result = await provider[method]([], [], '', undefined, { onThinkingDelta });
    expect(result.thinkingBlocks).toEqual([expect.objectContaining({ thinking: 'Consider the input.' })]);
    expect(onThinkingDelta.mock.calls.flat().join('')).toBe('Consider the input.');
    const history = JSON.parse(JSON.stringify(result.thinkingBlocks));
    await provider.complete([{ role: 'assistant', content: history }], [], '');
    const assistant = (requests.at(-1)?.messages as Record<string, unknown>[]).find(message => message.role === 'assistant');
    expect(assistant?.reasoning_details).toEqual(details);
    expect(assistant?.reasoning).toBe('Consider the input.');
    await provider.complete([{ role: 'assistant', content: history }], [], '', undefined, { modelOverride: 'another-model' });
    const switched = (requests.at(-1)?.messages as Record<string, unknown>[]).find(message => message.role === 'assistant');
    expect(switched?.reasoning_details).toBeUndefined();
  });

  it('merges streamed text/summary fragments and retains encrypted-only reasoning', async () => {
    const chunks = [
      { type: 'reasoning.summary', summary: 'First ', id: 's', index: 0 },
      { type: 'reasoning.summary', summary: 'second.', index: 0 },
      { type: 'reasoning.summary', summary: ' Third.', id: 's', index: 1 },
      { type: 'reasoning.encrypted', data: 'opaque', id: 'e', index: 2 },
    ];
    const requests = mockWire(body => body.stream ? new Response(chunks.map(detail =>
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [detail] }, finish_reason: null }] })}\n\n`,
    ).join('') + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }) : completed(body, { reasoning_details: [chunks[3]] }));
    const provider = createCustomProvider(config);
    const streamed = await provider.stream([], [], '');
    expect(streamed.thinkingBlocks[0]).toMatchObject({ thinking: 'First second. Third.' });
    await provider.complete([{ role: 'assistant', content: streamed.thinkingBlocks }], [], '');
    const assistant = (requests.at(-1)?.messages as Record<string, unknown>[]).find(message => message.role === 'assistant');
    expect(assistant?.reasoning_details).toEqual([{ ...chunks[0], summary: 'First second.' }, chunks[2], chunks[3]]);
    const encrypted = await provider.complete([], [], '');
    expect(encrypted.thinkingBlocks).toHaveLength(1);
    await provider.complete([{ role: 'assistant', content: encrypted.thinkingBlocks }], [], '');
    const replay = (requests.at(-1)?.messages as Record<string, unknown>[]).find(message => message.role === 'assistant');
    expect(replay?.reasoning_details).toEqual([chunks[3]]);
  });

  it.each(['stream', 'complete'] as const)('%s preserves independent reasoning detail blocks and their signatures', async method => {
    const details = [
      { type: 'reasoning.text', text: 'First.', signature: 'sig-one', format: 'format-one' },
      { type: 'reasoning.text', text: 'Second.', signature: 'sig-two', format: 'format-two' },
      { type: 'reasoning.text', text: 'Third.' },
      { type: 'reasoning.text', text: 'Fourth.' },
    ];
    const requests = mockWire(body => completed(body, { reasoning_details: details }));
    const provider = createCustomProvider(config);
    const result = await provider[method]([], [], '');
    expect(result.thinkingBlocks[0]).toMatchObject({ thinking: 'First.Second.Third.Fourth.' });
    await provider.complete([{ role: 'assistant', content: JSON.parse(JSON.stringify(result.thinkingBlocks)) }], [], '');
    const assistant = (requests.at(-1)?.messages as Record<string, unknown>[]).find(message => message.role === 'assistant');
    expect(assistant?.reasoning_details).toEqual(details);
  });

  it.each(['xhigh', 'high', 'medium', 'low'])("starts explicit %s at the selected rung and only lowers it", async effort => {
    const requests = mockWire(body => body.reasoning_effort === effort
      ? Response.json({ error: { message: 'Invalid reasoning_effort value' } }, { status: 400 }) : completed(body));
    await createCustomProvider(config).complete([], [], '', { effort });
    const next: Record<string, string> = { xhigh: 'high', high: 'medium', medium: 'low', low: 'minimal' };
    expect(requests.map(body => body.reasoning_effort)).toEqual([effort, next[effort]]);
  });

  it('records single-attempt rejections without retrying and uses them on the next call', async () => {
    const requests = mockWire(body => body.reasoning_effort === 'max'
      ? Response.json({ error: { message: 'Invalid reasoning_effort value' } }, { status: 400 }) : completed(body));
    const provider = createCustomProvider(config);
    const onReasoningEffortRejected = vi.fn();
    await expect(provider.complete([], [], '', { effort: 'max' }, { singleAttempt: true, onReasoningEffortRejected })).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(onReasoningEffortRejected).toHaveBeenCalledOnce();
    await provider.complete([], [], '', { effort: 'max' });
    expect(requests.map(body => body.reasoning_effort)).toEqual(['max', 'xhigh']);
  });
  it.each(['stream', 'complete'] as const)('%s sends explicit strengths and none without a declared profile', async method => {
    const requests = mockWire();
    const provider = createCustomProvider(config);
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const result = await provider[method]([], [], '', { effort });
      expect(requests.at(-1)?.reasoning_effort).toBe(effort);
      expect(result.reasoningResolution).toMatchObject({ requestedEffort: effort, sentEffort: effort, verified: false });
    }
  });

  it.each(['stream', 'complete'] as const)('%s lowers max one rung at a time and remembers only rejections', async method => {
    const requests = mockWire(body => ['max', 'xhigh'].includes(String(body.reasoning_effort))
      ? Response.json({ error: { message: "Unsupported value for reasoning_effort. Supported values: 'low', 'high'." } }, { status: 400 })
      : completed(body));
    const provider = createCustomProvider(config);
    const onReasoningEffortRejected = vi.fn();
    const first = await provider[method]([], [], '', { effort: 'max' }, { onReasoningEffortRejected });
    expect(requests.map(body => body.reasoning_effort)).toEqual(['max', 'xhigh', 'high']);
    expect(onReasoningEffortRejected.mock.calls.map(([event]) => event.effort)).toEqual(['max', 'xhigh']);
    expect(first.reasoningResolution).toMatchObject({ requestedEffort: 'max', sentEffort: 'high', verified: false,
      fallbacks: [{ effort: 'max', reason: 'unsupported-effort' }, { effort: 'xhigh', reason: 'unsupported-effort' }] });
    const second = await provider[method]([], [], '', { effort: 'max' });
    expect(requests.map(body => body.reasoning_effort)).toEqual(['max', 'xhigh', 'high', 'high']);
    expect(second.reasoningResolution?.fallbacks.map(item => item.reason)).toEqual(['cached-rejection', 'cached-rejection']);
    // An accepted request without visible thinking provides no further capability evidence.
    expect(second.thinkingBlocks).toEqual([]);
    expect(second.reasoningResolution?.verified).toBe(false);
  });

  it('tries none then the lowest available reasoning level when disable is rejected', async () => {
    const requests = mockWire(body => ['none', 'minimal'].includes(String(body.reasoning_effort))
      ? Response.json({ error: { message: 'Invalid reasoning_effort value' } }, { status: 422 }) : completed(body));
    const provider = createCustomProvider(config);
    await provider.complete([], [], '', { effort: 'none' });
    await provider.complete([], [], '', { effort: 'none' });
    expect(requests.map(body => body.reasoning_effort)).toEqual(['none', 'minimal', 'low', 'low']);
  });

  it.each([
    ['deepseek-v4-pro-openai', 'high'],
    ['deepseek-v4-flash-openai', 'low'],
    ['zai-glm-5.2', 'high'],
  ] as const)('%s never falls back to a disabled alias after rejecting %s', async (reasoningPreset, effort) => {
    const requests = mockWire(body => body.reasoning_effort === effort
      ? Response.json({ error: { message: 'Invalid reasoning_effort value' } }, { status: 400 }) : completed(body));
    await createCustomProvider({ ...config, reasoningPreset }).complete([], [], '', { effort });
    expect(requests.map(body => body.reasoning_effort)).toEqual([effort, undefined]);
    expect(requests[0]?.thinking).toEqual({ type: 'enabled' });
    expect(requests[1]?.thinking).toBeUndefined();
  });

  it.each(['stream', 'complete'] as const)('%s retains the original rejection reason across rate-limit retries', async method => {
    let rateLimits = 0;
    const requests = mockWire(body => {
      if (body.reasoning_effort === 'max') {
        return Response.json({ error: { message: 'Invalid reasoning_effort value' } }, { status: 400 });
      }
      if (rateLimits++ < 3) {
        return Response.json({ error: { message: 'Rate limit exceeded' } }, {
          status: 429, headers: { 'retry-after': '0.001' },
        });
      }
      return completed(body);
    });
    const provider = createCustomProvider(config);
    const onReasoningEffortRejected = vi.fn();
    const onReasoningResolved = vi.fn();
    const first = await provider[method]([], [], '', { effort: 'max' }, { onReasoningEffortRejected, onReasoningResolved });
    expect(first.reasoningResolution?.fallbacks).toEqual([{ effort: 'max', reason: 'unsupported-effort' }]);
    expect(onReasoningEffortRejected).toHaveBeenCalledOnce();
    expect(onReasoningResolved).toHaveBeenCalledExactlyOnceWith(first.reasoningResolution);
    const second = await provider[method]([], [], '', { effort: 'max' });
    expect(second.reasoningResolution?.fallbacks).toEqual([{ effort: 'max', reason: 'cached-rejection' }]);
    expect(requests.filter(body => body.reasoning_effort === 'max')).toHaveLength(1);
  });

  it('prefers a declared default and maps an unsupported disable to the lowest declared effort', async () => {
    const requests = mockWire();
    const provider = createCustomProvider({ ...config, reasoning: { efforts: ['low', 'medium', 'high'], default: 'medium' } });
    await provider.complete([], [], '');
    await provider.complete([], [], '', { effort: 'none' });
    expect(requests.map(body => body.reasoning_effort)).toEqual(['medium', 'low']);
    expect(requests.every(body => body.thinking === undefined)).toBe(true);
  });

  it('omits control only after a hard parameter rejection, remembers it, and reports it once', async () => {
    const requests = mockWire(body => body.reasoning_effort === undefined ? completed(body)
      : Response.json({ error: { message: "Unknown parameter: 'reasoning_effort'" } }, { status: 400 }));
    const provider = createCustomProvider(config);
    const onReasoningEffortRejected = vi.fn();
    for (let i = 0; i < 2; i++) await provider.complete([], [], '', undefined, { onReasoningEffortRejected });
    expect(requests.map(body => body.reasoning_effort)).toEqual(['max', undefined, undefined]);
    expect(onReasoningEffortRejected).toHaveBeenCalledExactlyOnceWith({ provider: config.name, model: config.model, effort: '*' });
  });

  it.each([
    [400, 'Unknown parameter: temperature'],
    [400, 'Invalid messages: reasoning_content is required'],
    [401, 'Unsupported reasoning_effort'],
  ])('does not downgrade on unrelated rejection %s / %s', async (status, message) => {
    const requests = mockWire(() => Response.json({ error: { message } }, { status }));
    const onReasoningEffortRejected = vi.fn();
    await expect(createCustomProvider(config).complete([], [], '', { effort: 'max' }, { onReasoningEffortRejected })).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(onReasoningEffortRejected).not.toHaveBeenCalled();
  });

  it('honors explicitly disabled capability and host-persisted rejections', async () => {
    const requests = mockWire();
    await createCustomProvider({ ...config, reasoning: 'none' }).complete([], [], '');
    await createCustomProvider(config).complete([], [], '', { effort: 'max' }, { rejectedReasoningEfforts: ['max', 'xhigh'] });
    expect(requests.map(body => body.reasoning_effort)).toEqual([undefined, 'high']);
  });

  it('uses nested reasoning.effort when the profile selects that wire dialect', async () => {
    const requests = mockWire();
    const provider = createCustomProvider({ ...config, reasoningProfile: { effortStrategy: 'openai-responses-effort' } });
    await provider.complete([], [], '', { effort: 'none' });
    await provider.stream([], [], '', { effort: 'max' });
    expect(requests.map(body => body.reasoning)).toEqual([{ effort: 'none' }, { effort: 'max' }]);
    expect(requests.every(body => body.reasoning_effort === undefined)).toBe(true);
  });

  it('treats an empty reasoning request as auto', async () => {
    const requests = mockWire();
    await createCustomProvider(config).complete([], [], '', {});
    expect(requests[0]?.reasoning_effort).toBe('max');
  });
  it('defaults unknown capability to auto/max in the resolver and actual request', async () => {
    const requests = mockWire();
    registerCustomProviders([config]);
    expect(resolveWireEffort({ provider: config.name })).toMatchObject({
      configuredEffort: 'auto', effort: 'max',
    });
    expect(resolveReasoningEffort({ capability: createCustomProvider(config).getReasoningProfile() }))
      .toMatchObject({ configuredEffort: 'auto', effectiveEffort: 'max' });
    await createCustomProvider(config).complete([{ role: 'user', content: 'hello' }], [], '');
    expect(requests[0]?.reasoning_effort).toBe('max');
    expect(requests[0]?.thinking).toBeUndefined();
  });
});
