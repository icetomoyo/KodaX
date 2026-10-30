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
    const invoke = () => buildRunnerLlmAdapter({ provider: 'managed-responses', effort: 'high', context: { configHome, gitRoot: configHome, preflightMode: 'off' } })(
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
  const adapter = buildRunnerLlmAdapter({ provider: 'managed-responses', context: { gitRoot: tmpdir(), preflightMode: 'off' } });
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
  const adapter = buildRunnerLlmAdapter({ provider: 'managed-responses', context: { gitRoot: tmpdir(), preflightMode: 'off' } });
  const result = await adapter([{ role: 'user', content: 'task' }], { name: 'worker', instructions: '' });
  expect(result.text).toBe('recovered');
  expect(modes.at(-1)).toBe(false);
  expect(modes.slice(0, -1).every(stream => stream)).toBe(true);
  expect(modes.length).toBeLessThanOrEqual(5);
}, 30000);
