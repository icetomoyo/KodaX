import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getCostRate } from '../cost-rates.js';
import type { KodaXMessage } from '../types.js';
import { getModelCapabilities, getProvider, getProviderModels, resetBuiltinProviderCache } from './registry.js';

beforeEach(() => resetBuiltinProviderCache());
afterEach(() => {
  resetBuiltinProviderCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([
  ['minimax-coding', 'MINIMAX_CODING_API_KEY', 'MiniMax-M3.1-Flash'],
  ['mimo-coding', 'MIMO_CODING_API_KEY', 'mimo-v2.6-pro'],
  ['mimo-coding', 'MIMO_CODING_API_KEY', 'mimo-v2.6-flash'],
  ['mimo', 'MIMO_API_KEY', 'mimo-v2.6-pro'],
  ['mimo', 'MIMO_API_KEY', 'mimo-v2.6-flash'],
])('%s keeps historical thinking and signatures (%s, %s)', async (provider, keyEnv, model) => {
  vi.stubEnv(keyEnv, 'test-key');
  const requests = captureRequests();
  const messages: KodaXMessage[] = [{ role: 'user', content: 'Read two files.' }];
  for (const id of ['first', 'second']) {
    messages.push({ role: 'assistant', content: [
      { type: 'thinking', thinking: `Read ${id}.`, signature: `signature-${id}` },
      { type: 'tool_use', id, name: 'read', input: { path: `${id}.txt` } },
    ] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `${id} contents` }] });
  }
  messages.push({ role: 'assistant', content: 'Both files read.' }, { role: 'user', content: 'Compare them.' });
  for (const method of ['stream', 'complete'] as const) {
    await getProvider(provider)[method](messages, [{ name: 'read', description: 'Read a file.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } } }], '', { effort: 'high' },
      { modelOverride: model, maxOutputTokensOverride: 1_024 });
    const wire = requests.at(-1)?.body.messages as Array<{ role: string; content: unknown }>;
    for (const index of [1, 3]) expect(wire[index]).toEqual(messages[index]);
    expect(wire[2]).toEqual(messages[2]);
    expect(wire[4]).toEqual(messages[4]);
  }
});

it('serializes images for the new Coding routes and the existing public MiMo mirror', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-coding-plan-image-'));
  const imagePath = path.join(directory, 'pixel.png');
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAAAuCAYAAACvdRKFAAAAhUlEQVR4Ae3BQQGAMADEsO6kIG5q8QQy+mlynvt+JJKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiH7i7gKvb5ZrbwAAAABJRU5ErkJggg==';
  await writeFile(imagePath, Buffer.from(data, 'base64'));
  try {
    const requests = captureRequests();
    for (const [provider, keyEnv, model] of [
      ['minimax-coding', 'MINIMAX_CODING_API_KEY', 'MiniMax-M3.1-Flash'],
      ['mimo-coding', 'MIMO_CODING_API_KEY', 'mimo-v2.6-pro'],
      ['mimo-coding', 'MIMO_CODING_API_KEY', 'mimo-v2.6-flash'],
      ['mimo', 'MIMO_API_KEY', 'mimo-v2.6-pro'],
      ['mimo', 'MIMO_API_KEY', 'mimo-v2.6-flash'],
    ]) {
      vi.stubEnv(keyEnv, 'test-key');
      for (const method of ['stream', 'complete'] as const) {
        await getProvider(provider)[method]([{ role: 'user', content: [
          { type: 'text', text: 'Describe the image.' }, { type: 'image', path: imagePath, mediaType: 'image/png' },
        ] }], [], '', { effort: 'high' }, { modelOverride: model, maxOutputTokensOverride: 1_024 });
        expect(requests.at(-1)?.body.messages).toMatchObject([{ role: 'user', content: [
          { type: 'text', text: 'Describe the image.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        ] }]);
      }
    }
  } finally {
    await unlink(imagePath);
    await rmdir(directory);
  }
});

function captureRequests() {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(url), body });
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
      usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  });
  return requests;
}

describe('MiMo V2.6 documented coding and public routes (2026-10-28)', () => {
  it.each(['mimo-coding', 'mimo'])('%s replaces retired V2.5 names and publishes exact limits', (provider) => {
    expect(getProvider(provider).getModel()).toBe('mimo-v2.6-pro');
    expect(getProviderModels(provider)).toEqual(['mimo-v2.6-pro', 'mimo-v2.6-flash']);
    for (const model of ['mimo-v2.6-pro', 'mimo-v2.6-flash']) {
      expect(getModelCapabilities(provider, model)).toMatchObject({
        contextWindow: 1_048_576, maxOutputTokens: 131_072, reasoningCapability: 'native-toggle',
        reasoningProfile: { effortStrategy: 'provider-toggle', supportsDisabledThinking: true },
      });
      expect(getCostRate(provider, model)).toBeDefined();
    }
  });

  it.each([
    ['mimo-coding', 'mimo-v2.6-pro', 'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages'],
    ['mimo-coding', 'mimo-v2.6-flash', 'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages'],
    ['mimo', 'mimo-v2.6-pro', 'https://api.xiaomimimo.com/anthropic/v1/messages'],
    ['mimo', 'mimo-v2.6-flash', 'https://api.xiaomimimo.com/anthropic/v1/messages'],
  ])('%s/%s maps all seven UI efforts without inventing native effort levels', async (provider, model, url) => {
    vi.stubEnv(provider === 'mimo' ? 'MIMO_API_KEY' : 'MIMO_CODING_API_KEY', 'test-key');
    const requests = captureRequests();
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'auto', 'off', 'minimal']) {
      for (const method of ['stream', 'complete'] as const) {
        await getProvider(provider)[method]([{ role: 'user', content: 'hello' }], [], '', { effort },
          { modelOverride: model, maxOutputTokensOverride: 1_024 });
        const request = requests.at(-1)!;
        expect(request.url).toBe(url);
        expect(request.body).toMatchObject({ model, max_tokens: 1_024,
          thinking: { type: ['off', 'minimal'].includes(effort) ? 'disabled' : 'enabled' } });
        expect(request.body).not.toHaveProperty('output_config');
        expect(request.body).not.toHaveProperty('reasoning_effort');
        expect(request.body.thinking).not.toHaveProperty('budget_tokens');
      }
    }
  });
});

describe('MiniMax M3.1 Flash documented M Plan route (2026-10-28)', () => {
  it('selects the canonical model with native effort and the documented hard limits', () => {
    expect(getProvider('minimax-coding').getModel()).toBe('MiniMax-M3.1-Flash');
    expect(getModelCapabilities('minimax-coding', 'MiniMax-M3.1-Flash')).toMatchObject({
      contextWindow: 1_000_000, maxOutputTokens: 524_288, reasoningCapability: 'native-effort',
      reasoningProfile: { effortStrategy: 'anthropic-output-effort', defaultEffort: 'max',
        supportsReasoningEffort: true, supportsDisabledThinking: false, localRejectEfforts: ['none'] },
    });
    expect(getCostRate('minimax-coding', 'MiniMax-M3.1-Flash')).toBeDefined();
  });

  it('preserves historical MiniMax profiles and output budgets independently of the new default', () => {
    for (const [model, contextWindow, preset] of [
      ['MiniMax-M3', 1_000_000, 'minimax-m3'],
      ['MiniMax-M2.7', 204_800, 'minimax-m2-always'],
      ['MiniMax-M2.7-highspeed', 204_800, 'minimax-m2-always'],
    ] as const) {
      expect(getProviderModels('minimax-coding')).toContain(model);
      expect(getModelCapabilities('minimax-coding', model)).toMatchObject({
        contextWindow, maxOutputTokens: 32_000, reasoningProfile: { reasoningPreset: preset },
      });
    }
  });

  it('maps all supported efforts in stream and complete; auto preserves the server default', async () => {
    vi.stubEnv('MINIMAX_CODING_API_KEY', 'test-key');
    const requests = captureRequests();
    for (const [effort, expected] of [
      ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'],
      ['max', 'max'], ['auto', undefined], ['minimal', 'low'],
    ] as const) {
      for (const method of ['stream', 'complete'] as const) {
        await getProvider('minimax-coding')[method]([{ role: 'user', content: 'hello' }], [], '', { effort },
          { maxOutputTokensOverride: 1_024 });
        const request = requests.at(-1)!;
        expect(request.url).toBe('https://api.minimax.cn/anthropic/v1/messages');
        expect(request.body).toMatchObject({ model: 'MiniMax-M3.1-Flash', thinking: { type: 'adaptive' } });
        if (expected) expect(request.body.output_config).toEqual({ effort: expected });
        else expect(request.body).not.toHaveProperty('output_config');
      }
    }
  });

  it('rejects explicit off before dispatch while omitted reasoning keeps thinking on', async () => {
    vi.stubEnv('MINIMAX_CODING_API_KEY', 'test-key');
    const requests = captureRequests();
    for (const method of ['stream', 'complete'] as const) {
      await expect(getProvider('minimax-coding')[method]([{ role: 'user', content: 'hello' }], [], '',
        { effort: 'off' }, { maxOutputTokensOverride: 1_024 }))
        .rejects.toThrow('does not support reasoning effort "none"');
    }
    expect(requests).toHaveLength(0);
    await getProvider('minimax-coding').complete([{ role: 'user', content: 'hello' }], [], '', undefined,
      { maxOutputTokensOverride: 1_024 });
    expect(requests[0]?.body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'max' } });
  });
});
