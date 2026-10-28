import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getModelCapabilities, getProvider, getProviderModels, resetBuiltinProviderCache } from './registry.js';

beforeEach(() => resetBuiltinProviderCache());

afterEach(() => {
  resetBuiltinProviderCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function captureRequests(rejectForced = false) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(url), body });
    const headers = { 'content-type': 'application/json' };
    if (rejectForced && body.tool_choice) {
      return new Response(JSON.stringify({ type: 'error', error: {
        type: 'BadRequest', code: 'InvalidParameter',
        message: 'The tool_choice parameter does not support being set to required or object in thinking mode',
      } }), { status: 400, headers });
    }
    if (body.stream) {
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 } }), { headers });
  });
  return requests;
}

describe('Ark Coding documented model catalog (2026-10-28)', () => {
  it.each([
    ['deepseek-v4.1-flash', 1_024_000],
    ['deepseek-v4.1-flash-economy', 1_049_000],
  ] as const)('exposes %s with Ark capacity and adaptive effort', (model, contextWindow) => {
    expect(getProviderModels('ark-coding')).toContain(model);
    expect(getModelCapabilities('ark-coding', model)).toMatchObject({
      contextWindow,
      maxOutputTokens: 384_000,
      reasoningCapability: 'native-effort',
      reasoningProfile: {
        reasoningPreset: 'deepseek-v4-anthropic',
        thinkingStrategy: 'anthropic-adaptive',
        defaultEffort: 'high',
        effortAliases: { minimal: 'low', medium: 'high', xhigh: 'high', ultra: 'max' },
        supportsDisabledThinking: true,
      },
    });
  });

  it('uses adaptive thinking for Ark V4.1 effort instead of the direct-provider enabled shape', async () => {
    vi.stubEnv('ARK_CODING_API_KEY', 'ark-test-key');
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: 'deepseek-v4.1-flash', max_tokens: 1_024,
        thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
      });
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    await getProvider('ark-coding').complete(
      [{ role: 'user', content: 'hello' }], [], '',
      { enabled: true, effort: 'low' },
      { modelOverride: 'deepseek-v4.1-flash', maxOutputTokensOverride: 1_024 },
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['glm-5.3-flash', 128_000],
    ['kimi-k3.1-pro', 128_000],
    ['kimi-k3', 128_000],
    ['kimi-k2.8-preview', 1_024_000],
  ] as const)('exposes %s with gateway-specific limits', (model, maxOutputTokens) => {
    expect(getProviderModels('ark-coding')).toContain(model);
    expect(getModelCapabilities('ark-coding', model)).toMatchObject({
      contextWindow: 1_024_000, maxOutputTokens,
    });
  });

  it.each(['deepseek-v4-pro', 'deepseek-v4-flash'])('updates the documented output ceiling for %s', (model) => {
    expect(getModelCapabilities('ark-coding', model)?.maxOutputTokens).toBe(384_000);
  });

  it.each(['deepseek-v4.1-flash', 'deepseek-v4.1-flash-economy'])('maps every user effort on %s in stream and complete', async (model) => {
    vi.stubEnv('ARK_CODING_API_KEY', 'ark-test-key');
    const requests = captureRequests();
    const provider = getProvider('ark-coding');
    for (const [effort, expected] of [
      ['low', 'low'], ['medium', 'high'], ['high', 'high'], ['xhigh', 'high'],
      ['max', 'max'], ['auto', 'high'], ['off', undefined], ['minimal', 'low'],
    ] as const) {
      for (const method of ['stream', 'complete'] as const) {
        await provider[method]([{ role: 'user', content: 'hello' }], [], '', { effort },
          { modelOverride: model, maxOutputTokensOverride: 1_024 });
        const request = requests.at(-1)!;
        expect(request.url).toContain('https://ark.cn-beijing.volces.com/api/coding/');
        expect(request.body).toMatchObject({ model, max_tokens: 1_024,
          thinking: { type: effort === 'off' ? 'disabled' : 'adaptive' } });
        if (expected) expect(request.body.output_config).toEqual({ effort: expected });
        else expect(request.body).not.toHaveProperty('output_config');
      }
    }
  });

  it('rejects K3.1 off without dispatch and keeps K3/K2.8 off available', async () => {
    vi.stubEnv('ARK_CODING_API_KEY', 'ark-test-key');
    const requests = captureRequests();
    const provider = getProvider('ark-coding');
    await expect(provider.stream([{ role: 'user', content: 'hello' }], [], '', { effort: 'off' },
      { modelOverride: 'kimi-k3.1-pro', maxOutputTokensOverride: 1_024 }))
      .rejects.toThrow('does not support reasoning effort "none"');
    expect(requests).toHaveLength(0);
    for (const model of ['kimi-k3', 'kimi-k2.8-preview']) {
      await provider.stream([{ role: 'user', content: 'hello' }], [], '', { effort: 'off' },
        { modelOverride: model, maxOutputTokensOverride: 1_024 });
      expect(requests.at(-1)?.body.thinking).toEqual({ type: 'disabled' });
    }
  });

  it('recovers from the Ark K3.1 forced-tool rejection while preserving thinking', async () => {
    vi.stubEnv('ARK_CODING_API_KEY', 'ark-test-key');
    const requests = captureRequests(true);
    const result = await getProvider('ark-coding').stream([{ role: 'user', content: 'hello' }], [{
      name: 'read', description: 'Read a file.', input_schema: { type: 'object', properties: {} },
    }], '', { effort: 'low' }, {
      modelOverride: 'kimi-k3.1-pro', maxOutputTokensOverride: 1_024, forcedToolName: 'read',
    });
    expect(result.textBlocks).toEqual([{ type: 'text', text: 'OK' }]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.tool_choice).toEqual({ type: 'tool', name: 'read' });
    expect(requests[1]?.body).not.toHaveProperty('tool_choice');
    for (const { body } of requests) expect(body).toMatchObject({
      thinking: { type: 'enabled' }, output_config: { effort: 'low' },
    });
  });
});
