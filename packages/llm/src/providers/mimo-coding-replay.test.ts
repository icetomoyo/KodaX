import { afterEach, expect, it, vi } from 'vitest';
import { getModelCapabilities, getProvider, resetBuiltinProviderCache } from './registry.js';

afterEach(() => {
  resetBuiltinProviderCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(['mimo-v2.6-pro', 'mimo-v2.6-flash'])('%s streams thinking/tool fragments and replays them in a nonstreaming continuation', async (model) => {
  vi.stubEnv('MIMO_CODING_API_KEY', 'fixture-key');
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe('https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-key');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (body.stream) {
      const chunks = [
        { choices: [{ delta: { reasoning_content: 'Inspect ' }, finish_reason: null }] },
        { choices: [{ delta: { reasoning_content: 'the file.' }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } });
  });
  const provider = getProvider('mimo-coding');
  const tools = [{ name: 'read', description: 'Read file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }];
  const result = await provider.stream([{ role: 'user', content: 'read a.txt' }], tools, '', { effort: 'high' },
    { modelOverride: model, maxOutputTokensOverride: 1024 });
  expect(result.thinkingBlocks).toMatchObject([{ type: 'thinking', thinking: 'Inspect the file.' }]);
  expect(result.toolBlocks).toEqual([{ type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'a.txt' } }]);
  expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 5 });
  await provider.complete([
    { role: 'user', content: 'read a.txt' },
    { role: 'assistant', content: [...result.thinkingBlocks, ...result.toolBlocks] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'hello' }] },
  ], tools, '', { effort: 'off' }, { modelOverride: model, maxOutputTokensOverride: 1024 });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.stream).not.toBe(true);
  expect(requests[1]).toMatchObject({ model, thinking: { type: 'disabled' }, messages: [
    { role: 'system' }, { role: 'user' },
    { role: 'assistant', reasoning_content: 'Inspect the file.', tool_calls: [{ id: 'read-1', function: { arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 'read-1', content: 'hello' },
  ] });
  for (const request of requests) expect(request).not.toHaveProperty('reasoning_effort');
  expect(getModelCapabilities('mimo-coding', model)?.reasoningProfile?.supportedEfforts?.map(effort => effort.value)).toEqual(['none', 'high']);
});
