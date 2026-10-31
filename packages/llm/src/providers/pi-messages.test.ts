import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import type { KodaXCustomProviderConfig } from '../types.js';
import { runWithScopedConfig } from '../run-scoped-config.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const config: KodaXCustomProviderConfig = { name: 'messages-test', protocol: 'pi-messages',
  baseUrl: 'https://gateway.example/v1', apiKeyEnv: 'TEST_MESSAGES_KEY', model: 'chosen' };
const tool = { name: 'read', description: 'read', input_schema: { type: 'object' as const, properties: {} } };
const events = [{ type: 'start' }, { type: 'thinking_start', contentIndex: 0 },
  { type: 'thinking_delta', contentIndex: 0, delta: 'plan' }, { type: 'thinking_end', contentIndex: 0, content: 'plan' },
  { type: 'toolcall_start', contentIndex: 1, id: 'call-1', toolName: 'read' },
  { type: 'toolcall_delta', contentIndex: 1, delta: '{}' },
  { type: 'toolcall_end', contentIndex: 1, toolCall: { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} } },
  { type: 'done', reason: 'toolUse', usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } } }];
it('projects native Pi Messages context, consumes a strict SSE terminal and pairs tool results', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
  vi.stubGlobal('fetch', fetch);
  const provider = createCustomProvider(config);
  const first = await provider.complete([{ role: 'user', content: 'task' }], [tool], 'system');
  expect(first.contentBlocks?.map(b => b.type)).toEqual(['thinking', 'tool_use']);
  expect(first.toolBlocks[0]).toMatchObject({ id: 'call-1', name: 'read', input: {} });
  expect(provider.supportsNonStreamingFallback()).toBe(false);
  await provider.stream([{ role: 'assistant', content: first.contentBlocks! },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] }], [], 'system');
  expect(fetch.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/messages');
  const body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
  expect(body.context.messages[0]).toMatchObject({ role: 'system', content: 'system', toolsAdded: [] });
  expect(body.context.messages[1].content).toMatchObject([{ type: 'thinking', thinking: 'plan' }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }]);
  expect(body.context.messages[2]).toMatchObject({ role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'ok' }] });
  expect(body.options.maxTokens).toBeGreaterThan(0);
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer fake-key');
});
it('projects legacy assistant history without inventing Pi usage, signatures or provider metadata', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('data: {"type":"start"}\n\ndata: {"type":"done","reason":"stop"}\n\n'));
  vi.stubGlobal('fetch', fetch);
  await createCustomProvider(config).complete([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'old plan', signature: 'foreign-signature' },
    { type: 'tool_use', id: 'old-call', name: 'read', input: { path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-call', content: 'old result' }] }], [], '');
  const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  expect(body.context.messages.slice(1).every((m: { role: string }) => m.role === 'user')).toBe(true);
  expect(JSON.stringify(body)).toContain('old result');
  expect(JSON.stringify(body)).toContain('old plan');
  expect(JSON.stringify(body)).not.toContain('foreign-signature');
  expect(JSON.stringify(body)).not.toContain('"usage"');
});
it.each([
  ['missing start', [{ type: 'done', reason: 'stop' }]],
  ['duplicate start', [{ type: 'start' }, { type: 'start' }]],
  ['huge index', [{ type: 'start' }, { type: 'text_start', contentIndex: 1_000_000 }]],
  ['prototype index', [{ type: 'start' }, { type: 'text_start', contentIndex: '__proto__' }]],
  ['missing block end', [{ type: 'start' }, { type: 'text_start', contentIndex: 0 }, { type: 'done', reason: 'stop' }]],
  ['missing terminal', [{ type: 'start' }]],
  ['truncation', [{ type: 'start' }, { type: 'done', reason: 'length' }]],
  ['content after terminal', [{ type: 'start' }, { type: 'done', reason: 'stop' }, { type: 'text_start', contentIndex: 0 }]],
  ['upstream error', [{ type: 'start' }, { type: 'error', reason: 'error', errorMessage: 'fixture upstream error' }]],
] as const)('rejects %s without returning partial tools', async (_label, values) => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const fetch = vi.fn(async () => new Response(values.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
  vi.stubGlobal('fetch', fetch);
  await expect(createCustomProvider(config).stream([], [tool], '', undefined, { singleAttempt: true })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('rejects a final tool snapshot that reports invalid arguments', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const values: unknown[] = structuredClone(events);
  values[6] = { type: 'toolcall_end', contentIndex: 1, toolCall: { type: 'toolCall', id: 'call-1', name: 'read', arguments: {}, argumentsError: 'invalid JSON' } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(values.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))));
  await expect(createCustomProvider(config).stream([], [tool], '', undefined, { singleAttempt: true })).rejects.toThrow(/final tool arguments/);
});
it('sends explicit cacheRetention none when the current run disables caching', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('data: {"type":"start"}\n\ndata: {"type":"done","reason":"stop"}\n\n'));
  vi.stubGlobal('fetch', fetch);
  await runWithScopedConfig({ disablePromptCache: true }, () => createCustomProvider({ ...config, promptCacheAffinity: true }).complete([], [], '', undefined, { promptCacheKey: 'session-key' }));
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).options).toMatchObject({ cacheRetention: 'none' });
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).options.sessionId).toBeUndefined();
});
it('uses authoritative Pi end snapshots while keeping partial deltas non-executable', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const values = [{ type: 'start' }, { type: 'text_start', contentIndex: 0 }, { type: 'text_delta', contentIndex: 0, delta: 'draft' },
    { type: 'text_end', contentIndex: 0, content: 'final' }, { type: 'toolcall_start', contentIndex: 1, id: 'call', toolName: 'read' },
    { type: 'toolcall_delta', contentIndex: 1, delta: '{"path":' },
    { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'call', name: 'read', arguments: { path: 'authoritative' } } }, { type: 'done', reason: 'toolUse' }];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(values.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))));
  const result = await createCustomProvider(config).stream([], [tool], '', undefined, { singleAttempt: true });
  expect(result.textBlocks[0]?.text).toBe('final');
  expect(result.toolBlocks[0]?.input).toEqual({ path: 'authoritative' });
});
it('rejects non-string tool identities even when the final snapshot repeats them', async () => {
  vi.stubEnv(config.apiKeyEnv, 'fake-key');
  const values = [{ type: 'start' }, { type: 'toolcall_start', contentIndex: 0, id: 123, toolName: 456 },
    { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 123, name: 456, arguments: {} } }, { type: 'done', reason: 'toolUse' }];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(values.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))));
  await expect(createCustomProvider(config).stream([], [tool], '', undefined, { singleAttempt: true })).rejects.toThrow();
});
