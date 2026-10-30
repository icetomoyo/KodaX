import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { registerCustomProviders, runWithProviderCredential } from '@kodax-ai/llm';
import { buildAssistantMessageFromLlmResult, resetCapabilityCacheMemoForTesting } from '@kodax-ai/agent';
import { buildRunnerLlmAdapter } from './llm-adapter.js';

afterEach(() => { registerCustomProviders([]); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('keeps scoped rejection learning across managed turns without changing intent for another identity', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'kodax-managed-responses-cache-'));
  try {
    vi.stubEnv('MANAGED_RESPONSES_KEY', 'test-only');
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { reasoning?: { effort?: string } };
      sent.push(body.reasoning?.effort);
      if (body.reasoning?.effort === 'high') return Response.json({ error: { message: 'Invalid reasoning.effort value' } }, { status: 400 });
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed', output: [
        { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] },
      ] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    registerCustomProviders([{ name: 'managed-responses', protocol: 'openai', api: 'responses', model: 'fixture',
      baseUrl: 'https://managed.test/v1', apiKeyEnv: 'MANAGED_RESPONSES_KEY', maxOutputTokens: 2048,
      reasoning: { efforts: ['low', 'high'], default: 'high' } }]);
    const invoke = () => buildRunnerLlmAdapter({ provider: 'managed-responses', effort: 'high', context: { configHome, gitRoot: configHome } })(
      [{ role: 'user', content: 'task' }], { name: 'worker', instructions: '' });
    await invoke();
    resetCapabilityCacheMemoForTesting();
    await invoke();
    await runWithProviderCredential('managed-responses', 'other-account', invoke);
    expect(sent).toEqual(['high', 'low', 'low', 'high', 'low']);
  } finally {
    resetCapabilityCacheMemoForTesting();
    await rm(configHome, { recursive: true, force: true });
  }
});
it('managed adapter commits ordered Responses content, sanitizes text and replays encrypted reasoning', async () => {
  vi.stubEnv('MANAGED_RESPONSES_KEY', 'test-only');
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const response = { id: 'r', status: 'completed', output: [
      { id: 'm', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Answer\nTool policy: hidden internal instructions', annotations: [] }] },
      { id: 'rs', type: 'reasoning', summary: [], encrypted_content: 'cipher' },
    ] };
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }));
  registerCustomProviders([{ name: 'managed-responses', protocol: 'openai', api: 'responses', model: 'fixture',
    baseUrl: 'https://managed.test/v1', apiKeyEnv: 'MANAGED_RESPONSES_KEY', maxOutputTokens: 2048 }]);
  const adapter = buildRunnerLlmAdapter({ provider: 'managed-responses', context: { gitRoot: tmpdir() } });
  const agent = { name: 'worker', instructions: '' };
  const first = await adapter([{ role: 'user', content: 'task' }], agent);
  expect(first.contentBlocks?.map(b => b.type)).toEqual(['text', 'thinking']);
  expect(first.text).toBe('Answer\n');
  const assistant = buildAssistantMessageFromLlmResult(first);
  expect(JSON.stringify(assistant)).not.toContain('hidden internal instructions');
  await adapter([{ role: 'user', content: 'task' }, assistant, { role: 'user', content: 'continue' }], agent);
  expect(JSON.stringify(requests[1]?.input)).toContain('cipher');
  expect(JSON.stringify(requests[1]?.input)).not.toContain('hidden internal instructions');
});
it('recovers repeated Responses EOF through the genuine non-streaming fallback', async () => {
  vi.stubEnv('MANAGED_RESPONSES_KEY', 'test-only');
  const modes: boolean[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { stream: boolean };
    modes.push(request.stream);
    if (request.stream) return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    return Response.json({ id: 'r', status: 'completed', output: [{ id: 'm', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'recovered', annotations: [] }] }] });
  }));
  registerCustomProviders([{ name: 'managed-responses', protocol: 'openai', api: 'responses', model: 'fixture',
    baseUrl: 'https://managed.test/v1', apiKeyEnv: 'MANAGED_RESPONSES_KEY', maxOutputTokens: 2048 }]);
  const adapter = buildRunnerLlmAdapter({ provider: 'managed-responses', context: { gitRoot: tmpdir() } });
  const result = await adapter([{ role: 'user', content: 'task' }], { name: 'worker', instructions: '' });
  expect(result.text).toBe('recovered');
  expect(modes.at(-1)).toBe(false);
  expect(modes.slice(0, -1).every(stream => stream)).toBe(true);
  expect(modes.length).toBeLessThanOrEqual(5);
}, 30000);

it('keeps dynamic grammar/strict metadata and emits native protocol hashes through the managed entry', async () => {
  vi.stubEnv('MANAGED_RESPONSES_KEY', 'test-only');
  const wire: Record<string, unknown>[] = [], projections: { projection?: string; nativeRequestHash?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    wire.push(JSON.parse(String(init.body)));
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
      ...(wire.length === 1 ? [{ type: 'custom_tool_call', call_id: 'custom-query', status: 'completed', name: 'query', input: 'SELECT 1' }] : []),
    ] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }));
  registerCustomProviders([{ name: 'managed-responses', protocol: 'openai', api: 'responses', model: 'fixture', baseUrl: 'https://managed.test/v1', apiKeyEnv: 'MANAGED_RESPONSES_KEY',
    toolCapabilities: { strict: true, grammar: ['regex'] }, maxOutputTokens: 2048 }]);
  const adapter = buildRunnerLlmAdapter({ provider: 'managed-responses', context: { gitRoot: tmpdir(), contextDiagnostics: true },
    events: { onPromptCacheDiagnostics: event => projections.push(event) } });
  const first = await adapter([{ role: 'user', content: 'task' }], { name: 'worker', instructions: '', tools: [
    { name: 'query', description: 'Query', grammar: { syntax: 'regex', definition: 'SELECT [0-9]+' }, input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } },
    { name: 'read', description: 'Read', strict: 'require', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ] });
  expect(wire[0]!.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'custom', name: 'query' }), expect.objectContaining({ type: 'function', name: 'read', strict: true })]));
  await adapter([{ role: 'user', content: 'task' }, buildAssistantMessageFromLlmResult(first),
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'custom-query', content: 'rows' }] }], { name: 'worker', instructions: '', tools: [] });
  expect(wire[1]!.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'custom_tool_call', input: 'SELECT 1' }), expect.objectContaining({ type: 'custom_tool_call_output', output: 'rows' })]));
  expect(projections.some(event => event.projection === 'native' && /^[a-f0-9]{64}$/.test(event.nativeRequestHash ?? ''))).toBe(true);
});
