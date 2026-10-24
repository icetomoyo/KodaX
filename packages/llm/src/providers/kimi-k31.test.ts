import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KodaXReasoningRequest } from '../types.js';
import { getModelCapabilities, getProvider } from './registry.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function captureRequests(protocol: 'anthropic' | 'openai'): Record<string, unknown>[] {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (!body.stream) {
      const response = protocol === 'anthropic'
        ? { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
        : { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] };
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
    }
    const events = protocol === 'anthropic'
      ? [
          { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]
      : [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }];
    return new Response(events.map(event =>
      `${'type' in event ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`,
    ).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  return requests;
}

describe('Kimi K3.1 provider contracts', () => {
  it('exposes Kimi Code K3.1 and sends native Anthropic output effort', async () => {
    vi.stubEnv('KIMI_CODE_API_KEY', 'test-code-key');
    const requests = captureRequests('anthropic');
    const provider = getProvider('kimi-code');

    for (const model of ['k3.1-pro', 'k3.1-pro-highspeed']) {
      expect(provider.getAvailableModels()).toContain(model);
      expect(getModelCapabilities('kimi-code', model)).toMatchObject({
        contextWindow: 1_048_576,
        reasoningCapability: 'native-effort',
        reasoningProfile: {
          defaultEffort: 'max',
          supportsDisabledThinking: false,
          localRejectEfforts: ['none'],
        },
      });
      const result = await provider.stream(
        [{ role: 'user', content: 'hello' }], [], '',
        { enabled: true, effort: 'low' }, { modelOverride: model },
      );
      expect(result.textBlocks).toEqual([{ type: 'text', text: 'OK' }]);
      expect(requests.at(-1)).toMatchObject({ model, output_config: { effort: 'low' } });
      expect(requests.at(-1)).toHaveProperty('thinking', { type: 'enabled' });
      expect(requests.at(-1)).not.toHaveProperty('reasoning_effort');
    }
  });

  it('exposes public K3.1 and sends top-level effort without a thinking toggle', async () => {
    vi.stubEnv('KIMI_API_KEY', 'test-public-key');
    const requests = captureRequests('openai');
    const provider = getProvider('kimi');

    for (const model of ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed']) {
      expect(provider.getAvailableModels()).toContain(model);
      expect(getModelCapabilities('kimi', model)).toMatchObject({
        contextWindow: 1_048_576,
        maxOutputTokens: 131_072,
        reasoningProfile: { defaultEffort: 'max', supportsDisabledThinking: false },
      });
      const result = await provider.stream(
        [{ role: 'user', content: 'hello' }], [], '',
        { enabled: true, effort: 'low' }, { modelOverride: model },
      );
      expect(result.textBlocks).toEqual([{ type: 'text', text: 'OK' }]);
      expect(requests.at(-1)).toMatchObject({ model, reasoning_effort: 'low', max_completion_tokens: 131_072 });
      expect(requests.at(-1)).not.toHaveProperty('thinking');
      expect(requests.at(-1)).not.toHaveProperty('temperature');
      expect(requests.at(-1)).not.toHaveProperty('max_tokens');
    }
  });

  const routes = [
    { name: 'kimi-code', env: 'KIMI_CODE_API_KEY', model: 'k3.1-pro', protocol: 'anthropic' },
    { name: 'kimi', env: 'KIMI_API_KEY', model: 'kimi-k3.1-pro', protocol: 'openai' },
  ] as const;

  it.each(routes)('$name uses max by default and maps supported effort aliases in stream and complete', async (route) => {
    vi.stubEnv(route.env, 'test-key');
    const requests = captureRequests(route.protocol);
    const provider = getProvider(route.name);
    const cases: [KodaXReasoningRequest | undefined, string][] = [
      [undefined, 'max'],
      [{ enabled: true, effort: 'low' }, 'low'],
      [{ enabled: true, effort: 'auto' }, 'max'],
      [{ enabled: true, effort: 'medium' }, 'high'],
      [{ enabled: true, effort: 'high' }, 'high'],
      [{ enabled: true, effort: 'xhigh' }, 'max'],
      [{ enabled: true, effort: 'max' }, 'max'],
      [{ enabled: true, effort: 'ultra' }, 'max'],
      [{ enabled: true, effort: 'minimal' }, 'low'],
    ];
    for (const [reasoning, effort] of cases) {
      for (const method of ['stream', 'complete'] as const) {
        const result = await provider[method](
          [{ role: 'user', content: 'hello' }], [], '', reasoning,
          { modelOverride: route.model, maxOutputTokensOverride: 1_024 },
        );
        expect(result.textBlocks).toEqual([{ type: 'text', text: 'OK' }]);
        const wire = requests.at(-1);
        expect(wire).toMatchObject(route.protocol === 'anthropic'
          ? { output_config: { effort }, max_tokens: 1_024 }
          : { reasoning_effort: effort, max_completion_tokens: 1_024 });
        if (route.protocol === 'anthropic') {
          expect(wire).toHaveProperty('thinking', { type: 'enabled' });
        } else {
          expect(wire).not.toHaveProperty('thinking');
        }
      }
    }
  });

  it.each(routes)('$name rejects explicit thinking-off before sending a request', async (route) => {
    vi.stubEnv(route.env, 'test-key');
    const requests = captureRequests(route.protocol);
    const provider = getProvider(route.name);
    for (const effort of ['none', 'off']) {
      for (const method of ['stream', 'complete'] as const) {
        await expect(provider[method](
          [{ role: 'user', content: 'hello' }], [], '',
          { enabled: false, effort }, { modelOverride: route.model },
        )).rejects.toThrow('does not support reasoning effort "none"');
      }
    }
    expect(requests).toHaveLength(0);
  });
});
