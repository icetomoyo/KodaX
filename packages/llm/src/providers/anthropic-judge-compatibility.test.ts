import { afterEach, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { KODAX_PROVIDERS } from './registry.js';
import type { KodaXToolDefinition } from '../types.js';
import { withProviderRequestCredential } from '../provider-credential-context.js';
import { observeProviderFetch, observeProviderOperation, runWithProviderRequestObserver, type ProviderRequestObservation } from '../provider-request-observation.js';

const report: KodaXToolDefinition = {
  name: 'report_stall_judgment', description: 'Report the judgment.',
  input_schema: { type: 'object', properties: { isStuck: { type: 'boolean' } } },
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(['stream', 'complete'] as const)('sends a compatible first Kimi judge request through %s without disabling thinking or retrying', async method => {
  vi.stubEnv('KIMI_CODE_API_KEY', 'local-test-key');
  const create = vi.fn(async (request: Anthropic.Messages.MessageCreateParams) => {
    if (request.thinking?.type === 'enabled' && request.tool_choice?.type === 'tool') {
      throw new Error("tool_choice 'specified' is incompatible with thinking enabled");
    }
    if (method === 'stream') return (async function* () {
      yield { type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 0 } } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } };
      yield { type: 'message_stop' };
    })();
    return { content: [], usage: { input_tokens: 7, output_tokens: 2 }, stop_reason: 'end_turn' };
  });
  const provider = KODAX_PROVIDERS['kimi-code']();
  Reflect.set(provider, '_client', { messages: { create } });
  await expect(provider[method]([{ role: 'user', content: 'Judge the recent progress.' }], [report], 'Judge only.', false, {
    modelOverride: 'kimi-for-coding', forcedToolName: report.name,
    maxOutputTokensOverride: 1024, singleAttempt: true,
  })).resolves.toMatchObject({ usage: { inputTokens: 7, outputTokens: 2 } });
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0]?.[0]).toMatchObject({ thinking: { type: 'enabled' }, max_tokens: 1024 });
  expect(create.mock.calls[0]?.[0].tools).toHaveLength(1);
  expect(create.mock.calls[0]?.[0].tool_choice).toBeUndefined();
});

it('retains received usage as partial when a physical stream is cancelled, without reporting a complete bill', async () => {
  vi.stubEnv('KIMI_CODE_API_KEY', 'local-test-key');
  const facts: ProviderRequestObservation[] = [];
  const controller = new AbortController();
  const fetcher = observeProviderFetch(async () => new Response(''));
  const create = vi.fn(async () => {
    await fetcher('https://fixture.invalid');
    return (async function* () {
      yield { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } };
      controller.abort();
      throw new DOMException('Request aborted', 'AbortError');
    })();
  });
  const provider = KODAX_PROVIDERS['kimi-code']();
  Reflect.set(provider, '_client', { messages: { create } });
  await expect(runWithProviderRequestObserver(f => facts.push(f), () =>
    withProviderRequestCredential(provider.name, 'sidecar', controller.signal, signal => provider.stream(
      [{ role: 'user', content: 'Judge progress.' }], [report], 'Judge only.', false,
      { modelOverride: 'kimi-for-coding', maxOutputTokensOverride: 1024, singleAttempt: true }, signal,
    )))).rejects.toMatchObject({ name: 'AbortError' });
  expect(create).toHaveBeenCalledTimes(1);
  const terminal = facts.filter(f => f.boundary === 'physical_attempt').at(-1);
  expect(terminal).toMatchObject({ state: 'cancelled', purpose: 'sidecar', partialUsage: { inputTokens: 12, outputTokens: 0, totalTokens: 12 } });
  expect(terminal?.usage).toBeUndefined();
});

it('reports a cancelled native operation without inventing a fetch when the SDK receives an aborted signal', async () => {
  vi.stubEnv('KIMI_CODE_API_KEY', 'local-test-key');
  const fetcher = vi.fn(async () => { throw new Error('Cancelled SDK request must not fetch'); });
  vi.stubGlobal('fetch', fetcher);
  const provider = KODAX_PROVIDERS['kimi-code']();
  const controller = new AbortController();
  controller.abort();
  const facts: ProviderRequestObservation[] = [];
  await expect(runWithProviderRequestObserver(f => facts.push(f), () =>
    observeProviderOperation(provider.name, 'sidecar', undefined, () => provider.stream(
      [{ role: 'user', content: 'Judge progress.' }], [report], 'Judge only.', false,
      { modelOverride: 'kimi-for-coding', forcedToolName: report.name, maxOutputTokensOverride: 1024, singleAttempt: true }, controller.signal,
    ), undefined, controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).not.toHaveBeenCalled();
  expect(facts.filter(f => f.boundary === 'physical_attempt')).toEqual([]);
  expect(facts.at(-1)).toMatchObject({ boundary: 'provider_operation', wireObservation: 'pending', state: 'cancelled', purpose: 'sidecar' });
});
