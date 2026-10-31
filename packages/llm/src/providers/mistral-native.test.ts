import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import type { KodaXCustomProviderConfig } from '../types.js';
import { runWithScopedConfig } from '../run-scoped-config.js';
import { fileURLToPath } from 'node:url';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const config: KodaXCustomProviderConfig = { name: 'native-mistral-test', protocol: 'mistral',
  baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'TEST_MISTRAL_KEY', model: 'selected-model' };
const tool = { name: 'read', description: 'read', input_schema: { type: 'object' as const, properties: { path: { type: 'string' } } } };
function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
it('uses native Mistral typed content and replays paired tool IDs with current schemas', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({
    choices: [{ message: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'plan' }] }, { type: 'text', text: 'before' }],
      tool_calls: [{ id: 'Abc123XYZ', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }));
  vi.stubGlobal('fetch', fetch);
  const provider = createCustomProvider(config);
  const first = await provider.complete([{ role: 'user', content: 'task' }], [tool], 'system');
  expect(first.contentBlocks?.map(b => b.type)).toEqual(['thinking', 'text', 'tool_use']);
  expect(first.toolBlocks[0]).toMatchObject({ id: 'Abc123XYZ', name: 'read', input: { path: 'a' } });
  await provider.complete([{ role: 'assistant', content: first.contentBlocks! },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Abc123XYZ', content: 'ok' }] }], [], 'system');
  expect(fetch.mock.calls[0]?.[0]).toBe('https://api.mistral.ai/v1/chat/completions');
  const body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
  expect(body.messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'plan' }] }, { type: 'text', text: 'before' }],
    tool_calls: [{ id: 'Abc123XYZ', function: { name: 'read', arguments: '{"path":"a"}' } }] });
  expect(body.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'Abc123XYZ', content: 'ok' });
  expect(body.tools).toBeUndefined();
  expect(body.stream).toBe(false);
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer fake-key');
});
it('waits for valid streamed arguments and final usage while preserving ordered thinking', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  vi.stubGlobal('fetch', vi.fn(async () => sse([
    { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ text: 'plan' }] }] } }] },
    { choices: [{ delta: { content: '', tool_calls: [{ index: 0, id: 'Abc123XYZ', function: { name: 'read', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
  ])));
  const result = await createCustomProvider(config).stream([], [tool], '', undefined, { singleAttempt: true });
  expect(result.contentBlocks?.map(b => b.type)).toEqual(['thinking', 'tool_use']);
  expect(result.toolBlocks[0]?.input).toEqual({ path: 'a' });
  expect(result.usage?.totalTokens).toBe(25);
});
it('rejects a tool renamed after its streamed argument buffer starts', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  vi.stubGlobal('fetch', vi.fn(async () => sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'Abc123XYZ', function: { name: 'read', arguments: '{' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'write', arguments: '}' } }] }, finish_reason: 'tool_calls' }] },
  ])));
  await expect(createCustomProvider(config).stream([], [tool], '', undefined, { singleAttempt: true })).rejects.toThrow(/identity|name/i);
});
it.each([
  ['missing terminal', undefined, '{}', 'Abc123XYZ'], ['length', 'length', '{}', 'Abc123XYZ'], ['model limit', 'model_length', '{}', 'Abc123XYZ'],
  ['malformed JSON', 'tool_calls', '{', 'Abc123XYZ'], ['array JSON', 'tool_calls', '[]', 'Abc123XYZ'], ['invalid ID', 'tool_calls', '{}', 'bad-id'],
] as const)('never returns executable tools after %s', async (_label, terminal, args, id) => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const fetch = vi.fn(async () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'read', arguments: args } }] }, finish_reason: terminal }] }]));
  vi.stubGlobal('fetch', fetch);
  await expect(createCustomProvider(config).stream([], [tool], '', undefined, { singleAttempt: true })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('maps foreign tool IDs consistently and gates image reads before touching unavailable files', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  vi.stubGlobal('fetch', fetch);
  await createCustomProvider(config).complete([{ role: 'assistant', content: [{ type: 'tool_use', id: 'foreign-call-id', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'foreign-call-id', content: 'ok' }, { type: 'image', path: 'does-not-exist.png' }] }], [], '');
  const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  expect(body.messages[0].tool_calls[0].id).toMatch(/^[A-Za-z0-9]{9}$/);
  expect(body.messages[1].tool_call_id).toBe(body.messages[0].tool_calls[0].id);
  expect(JSON.stringify(body)).toContain('does not support');
  expect(JSON.stringify(body)).not.toContain('data:image');
});
it.each([429, 503, 529])('keeps retry headers from a non-JSON HTTP %i gateway response', async status => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? new Response('<html>temporary upstream</html>', { status, headers: { 'retry-after-ms': '1' } })
    : Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  vi.stubGlobal('fetch', fetch);
  const onRetryAfter = vi.fn();
  expect((await createCustomProvider(config).complete([], [], '', undefined, { onRetryAfter })).textBlocks[0]?.text).toBe('ok');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(onRetryAfter).toHaveBeenCalledWith(expect.objectContaining({ waitMs: 1, source: 'retry-after-ms' }));
});
it('retries a native fetch connection reset within the same bounded request', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const fetch = vi.fn(async () => {
    if (fetch.mock.calls.length === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) });
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  });
  vi.stubGlobal('fetch', fetch);
  expect((await createCustomProvider(config).complete([], [], '')).textBlocks[0]?.text).toBe('ok');
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('honors declared none effort and disables explicit cache routing for the current request', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  vi.stubGlobal('fetch', fetch);
  const provider = createCustomProvider({ ...config, reasoning: { efforts: ['none', 'high'], default: 'high' }, promptCacheAffinity: true });
  await provider.complete([], [], '', { effort: 'none' }, { promptCacheKey: 'session-key' });
  await runWithScopedConfig({ disablePromptCache: true }, () => provider.complete([], [], '', { effort: 'high' }, { promptCacheKey: 'session-key' }));
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ reasoning_effort: 'none', prompt_cache_key: 'session-key' });
  const disabled = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
  expect(disabled.reasoning_effort).toBe('high'); expect(disabled.prompt_cache_key).toBeUndefined();
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).has('x-affinity')).toBe(false);
});
it('serializes admitted images and image tool receipts with explicit vision capability', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  vi.stubGlobal('fetch', fetch);
  const path = fileURLToPath(new URL('../../../../tests/fixtures/images/valid-png.png', import.meta.url));
  await createCustomProvider({ ...config, imageInput: true }).complete([{ role: 'user', content: [{ type: 'image', path }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'Abc123XYZ', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Abc123XYZ', content: [{ type: 'text', text: 'ok' }, { type: 'image', path }] }] }], [], '');
  const wire = JSON.stringify(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)));
  expect(wire.match(/data:image\/png;base64,iVBOR/g)).toHaveLength(2);
  expect(wire).toContain('"role":"tool"');
});
it.each([
  { content: [{ type: 'text', text: 123 }] },
  { content: null, tool_calls: [{ id: 123456789, type: 'function', function: { name: 'read', arguments: '{}' } }] },
])('rejects malformed Mistral content before publishing typed blocks: %j', async message => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message, finish_reason: 'stop' }] })));
  await expect(createCustomProvider(config).complete([], [tool], '', undefined, { singleAttempt: true })).rejects.toThrow();
});
