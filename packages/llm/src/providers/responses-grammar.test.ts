import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider, type KodaXToolDefinition } from '../index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('normalizes completed raw grammar input and replays paired custom calls after dynamic tool removal', async () => {
  vi.stubEnv('GRAMMAR_KEY', 'fixture');
  let first = true;
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const output = first ? [{ type: 'custom_tool_call', id: 'ct', call_id: 'call', name: 'query', input: 'SELECT 1;', status: 'completed' }] : [];
    first = false; return Response.json({ status: 'completed', output });
  });
  vi.stubGlobal('fetch', fetcher);
  const provider = createCustomProvider({ name: 'grammar', protocol: 'openai', api: 'responses', model: 'fixture', baseUrl: 'https://grammar.example/v1', apiKeyEnv: 'GRAMMAR_KEY', toolCapabilities: { grammar: ['regex'] } });
  const tool: KodaXToolDefinition = { name: 'query', description: 'Query', grammar: { syntax: 'regex', definition: 'SELECT [0-9]+;' },
    input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } };
  const result = await provider.complete([], [tool], '', undefined, { forcedToolName: 'query' });
  expect(result.toolBlocks[0]).toMatchObject({ type: 'tool_use', name: 'query', input: { sql: 'SELECT 1;' } });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.tools).toEqual([{ type: 'custom', name: 'query', description: 'Query', format: { type: 'grammar', syntax: 'regex', definition: 'SELECT [0-9]+;' } }]);
  expect(body.tool_choice).toEqual({ type: 'custom', name: 'query' });
  await provider.complete([{ role: 'assistant', content: result.contentBlocks! }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'row' }] }], [], '');
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).input).toEqual([
    { type: 'custom_tool_call', call_id: 'call', name: 'query', input: 'SELECT 1;' }, { type: 'custom_tool_call_output', call_id: 'call', output: 'row' },
  ]);
});

it('rejects ambiguous custom-tool names before sending a request', async () => {
  vi.stubEnv('GRAMMAR_KEY', 'fixture'); const fetcher = vi.fn(async () => Response.json({ status: 'completed', output: [] })); vi.stubGlobal('fetch', fetcher);
  const provider = createCustomProvider({ name: 'grammar', protocol: 'openai', api: 'responses', model: 'fixture', baseUrl: 'https://grammar.example/v1', apiKeyEnv: 'GRAMMAR_KEY', toolCapabilities: { grammar: ['regex'] } });
  const tool: KodaXToolDefinition = { name: 'query', description: 'Query', grammar: { syntax: 'regex', definition: 'SELECT [0-9]+;' },
    input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } };
  await expect(provider.complete([], [tool, { ...tool, input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }], '')).rejects.toThrow(/unique/);
  expect(fetcher).not.toHaveBeenCalled();
});

it('keeps raw custom-tool deltas non-executable until a complete terminal', async () => {
  vi.stubEnv('GRAMMAR_KEY', 'fixture');
  const events = [{ type: 'response.output_item.added', item: { type: 'custom_tool_call', id: 'item', call_id: 'call', name: 'query' } },
    { type: 'response.custom_tool_call_input.delta', item_id: 'item', delta: 'SELECT ' },
    { type: 'response.custom_tool_call_input.delta', item_id: 'item', delta: '2;' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'custom_tool_call', id: 'item', call_id: 'call', name: 'query', input: 'SELECT 2;' }] } }];
  const fetcher = vi.fn(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'));
  vi.stubGlobal('fetch', fetcher);
  const provider = createCustomProvider({ name: 'grammar', protocol: 'openai', api: 'responses', model: 'fixture', baseUrl: 'https://grammar.example/v1', apiKeyEnv: 'GRAMMAR_KEY', toolCapabilities: { grammar: ['regex'] } });
  const tool: KodaXToolDefinition = { name: 'query', description: 'Query', grammar: { syntax: 'regex', definition: 'SELECT [0-9]+;' },
    input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } };
  const delta = vi.fn();
  const result = await provider.stream([], [tool], '', undefined, { onToolInputDelta: delta, singleAttempt: true });
  expect(delta.mock.calls).toEqual([['query', 'SELECT ', { toolId: 'call', format: 'text', inputProperty: 'sql' }], ['query', '2;', { toolId: 'call', format: 'text', inputProperty: 'sql' }]]);
  expect(result.toolBlocks[0]?.input).toEqual({ sql: 'SELECT 2;' });
  fetcher.mockImplementation(async () => new Response(events.slice(0, 3).map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
  await expect(provider.stream([], [tool], '', undefined, { singleAttempt: true })).rejects.toThrow(/without a terminal/);
});
