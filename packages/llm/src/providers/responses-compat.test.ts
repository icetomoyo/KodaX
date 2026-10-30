import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import type { KodaXMessage } from '../types.js';
import { runWithProviderCredential } from '../provider-credential-context.js';
import { runWithScopedConfig } from '../run-scoped-config.js';

const config = { name: 'compat', protocol: 'openai' as const, api: 'responses' as const,
  model: 'first', baseUrl: 'https://compat.test/v1', apiKeyEnv: 'COMPAT_KEY' };
function transport() {
  vi.stubEnv('COMPAT_KEY', 'fixture-key');
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ id: 'response', status: 'completed', output: [] });
  });
  return requests;
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('pairs interrupted imported calls before new turns, drops orphan receipts and preserves foreign readable reasoning', async () => {
  const requests = transport();
  const messages: KodaXMessage[] = [
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Useful prior reasoning', signature: 'foreign-signature' },
      { type: 'tool_use', id: 'old', name: 'removed_tool', input: { old: true } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'unrelated' }, { type: 'text', text: 'Continue' }] },
  ];
  const original = structuredClone(messages);
  await createCustomProvider(config).complete(messages, [], '');
  expect(requests[0]?.input).toEqual([
    { role: 'assistant', content: '<prior_reasoning>\nUseful prior reasoning\n</prior_reasoning>' },
    { type: 'function_call', call_id: 'old', name: 'removed_tool', arguments: '{"old":true}' },
    { type: 'function_call_output', call_id: 'old', output: expect.stringContaining('interrupted') },
    { role: 'user', content: 'Continue' },
  ]);
  expect(messages).toEqual(original);
});

it('reuses only identity-scoped persisted effort evidence across provider instances', async () => {
  transport();
  const efforts: unknown[] = [];
  const learned = new Map<string, string[]>();
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { reasoning?: { effort?: string } };
    efforts.push(request.reasoning?.effort);
    return request.reasoning?.effort === 'high'
      ? Response.json({ error: { message: "Unsupported value for reasoning.effort: 'high'" } }, { status: 400 })
      : Response.json({ id: 'response', status: 'completed', output: [] });
  });
  const options = {
    resolveRejectedReasoningEfforts: (scope: string) => learned.get(scope) ?? [],
    onReasoningEffortRejected: (event: { effort: string; cacheScope?: string }) => {
      expect(event.cacheScope).toMatch(/^[a-f0-9]{64}$/);
      learned.set(event.cacheScope!, [event.effort]);
    },
  };
  const invoke = (modelOverride?: string) => createCustomProvider(config).complete([], [], '', { effort: 'high' }, { ...options, modelOverride });
  await invoke();
  await invoke();
  expect(efforts).toEqual(['high', 'medium', 'medium']);
  await runWithProviderCredential('compat', 'other-identity', () => invoke());
  await invoke('second');
  expect(efforts).toEqual(['high', 'medium', 'medium', 'high', 'medium', 'high', 'medium']);
  expect(learned.size).toBe(3);
  await createCustomProvider({ ...config, baseUrl: 'https://other.test/v1' }).complete([], [], '', { effort: 'high' }, options);
  await createCustomProvider({ ...config, reasoning: { efforts: ['low', 'high'], default: 'low' } }).complete([], [], '', { effort: 'high' }, options);
  expect(learned.size).toBe(5);
});

it('uses current schemas and cache controls after tool removal, redefinition and a model switch', async () => {
  const requests = transport();
  const provider = createCustomProvider({ ...config, promptCacheAffinity: true });
  const tool = { name: 'read', description: 'old', input_schema: { type: 'object', properties: { path: { type: 'string' } } } };
  await provider.complete([], [tool], '', undefined, { forcedToolName: 'read', promptCacheKey: 'session' });
  const history: KodaXMessage[] = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'read', input: { path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'old result' }] }];
  await runWithScopedConfig({ disablePromptCache: true }, () => provider.complete(history,
    [{ ...tool, name: 'write', description: 'new' }], '', false, { modelOverride: 'second', promptCacheKey: 'session' }));
  await provider.complete(history, [{ ...tool, input_schema: { type: 'object', required: ['uri'], properties: { uri: { type: 'string' } } } }], '', undefined,
    { promptCacheKey: 'session' });
  expect(requests[0]).toMatchObject({ prompt_cache_key: 'session', tool_choice: { name: 'read' } });
  expect(requests[1]).toMatchObject({ model: 'second', tools: [{ name: 'write', description: 'new' }], input: [
    { type: 'function_call', name: 'read' }, { type: 'function_call_output', output: 'old result' },
  ] });
  expect(requests[1]).not.toHaveProperty('prompt_cache_key');
  expect(requests[1]).not.toHaveProperty('tool_choice');
  expect(requests[2]).toMatchObject({ prompt_cache_key: 'session', tools: [{ name: 'read', parameters: { required: ['uri'] } }] });
  expect(requests[2]).not.toHaveProperty('tool_choice');
});

it('rejects unfinished reasoning in an otherwise completed response', async () => {
  transport();
  vi.stubGlobal('fetch', async () => Response.json({ id: 'response', status: 'completed', output: [
    { type: 'reasoning', id: 'r', status: 'in_progress', summary: [] },
    { type: 'function_call', call_id: 'c', name: 'write', arguments: '{}', status: 'completed' },
  ] }));
  await expect(createCustomProvider(config).complete([], [], '')).rejects.toThrow(/unfinished reasoning/i);
});

it('rejects a stale forced tool before contacting the service', async () => {
  const requests = transport();
  await expect(createCustomProvider(config).complete([], [], '', undefined, { forcedToolName: 'removed' }))
    .rejects.toThrow(/forced tool/i);
  expect(requests).toHaveLength(0);
});

it('negotiates declared effort rungs and never treats successful acceptance as verified capability', async () => {
  transport();
  const sent: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { reasoning?: { effort?: string } };
    sent.push(request.reasoning?.effort);
    return request.reasoning?.effort === 'high'
      ? Response.json({ error: { message: "Unsupported value for reasoning.effort: 'high'" } }, { status: 422 })
      : Response.json({ id: 'response', status: 'completed', output: [] });
  });
  const provider = createCustomProvider({ ...config, reasoning: { efforts: ['off', 'low', 'high'], default: 'high' } });
  const result = await provider.complete([], [], '', { effort: 'high' });
  expect(sent).toEqual(['high', 'low']);
  expect(result.reasoningResolution).toMatchObject({ sentEffort: 'low', verified: false });
  await provider.complete([], [], '', false);
  expect(sent.at(-1)).toBe('none');
});

it('replays Anthropic reasoning only at its original model and endpoint', async () => {
  const requests = transport();
  const provider = createCustomProvider({ ...config, api: undefined, protocol: 'anthropic', strictThinkingSignature: true, maxOutputTokens: 4096 });
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ content: [{ type: 'thinking', thinking: 'plan', signature: 'sealed' },
      { type: 'redacted_thinking', data: 'secret' }], stop_reason: 'end_turn' });
  });
  const result = await provider.complete([{ role: 'user', content: 'hi' }], [], '');
  const history: KodaXMessage[] = [{ role: 'assistant', content: result.thinkingBlocks }];
  await provider.complete(history, [], '');
  expect(requests[1]?.messages).toMatchObject([{ content: [
    { type: 'thinking', signature: 'sealed' }, { type: 'redacted_thinking', data: 'secret' },
  ] }]);
  await provider.complete(history, [], '', undefined, { modelOverride: 'second' });
  expect(JSON.stringify(requests[2])).not.toMatch(/sealed|secret/);
  expect(JSON.stringify(requests[2])).toContain('prior_reasoning');
});
