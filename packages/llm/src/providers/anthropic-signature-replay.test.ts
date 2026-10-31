import { afterEach, expect, it, vi } from 'vitest';
import { getProvider, resetBuiltinProviderCache } from './registry.js';

afterEach(() => {
  resetBuiltinProviderCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(['stream', 'complete'] as const)('captures streamed signatures and replays them through %s', async (method) => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture-key');
  const requests: Array<Record<string, unknown>> = [];
  const thinking = [
    { type: 'thinking', thinking: 'Read the file.', signature: 'start-first-second' },
    { type: 'thinking', thinking: '', signature: 'opaque-only' },
  ];
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'start-' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Read the file.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'first' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '-second' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'opaque-' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'only' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'read-1', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (body.stream) {
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  });
  const provider = getProvider('anthropic');
  const tools = [{ name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }];
  const onThinkingDelta = vi.fn();
  const onThinkingEnd = vi.fn();
  const result = await provider.stream([{ role: 'user', content: 'Read a.txt' }], tools, '', { effort: 'high' }, {
    maxOutputTokensOverride: 4096, onThinkingDelta, onThinkingEnd,
  });
  expect(result.thinkingBlocks).toMatchObject(thinking);
  expect(result.thinkingBlocks[0]?.source).toMatchObject({ provider: 'anthropic', api: 'anthropic-messages', model: provider.getModel() });
  expect(onThinkingDelta.mock.calls).toEqual([['Read the file.']]);
  expect(onThinkingEnd.mock.calls).toEqual([['Read the file.']]);
  await provider[method]([
    { role: 'user', content: 'Read a.txt' },
    { role: 'assistant', content: [...result.thinkingBlocks, ...result.toolBlocks] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'contents' }] },
  ], tools, '', { effort: 'high' }, { maxOutputTokensOverride: 4096 });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.messages).toMatchObject([
    { role: 'user' },
    { role: 'assistant', content: [...thinking, { type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'contents' }] },
  ]);
});
