import { afterEach, expect, it, vi } from 'vitest';
import { registerCustomProviders } from '@kodax-ai/llm';
import { runSubstrate } from './run-substrate.js';

afterEach(() => { registerCustomProviders([]); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('coding loop retains native order and executes a completed Responses tool exactly once', async () => {
  vi.stubEnv('SUBSTRATE_RESPONSES_KEY', 'test-only');
  const requests: Record<string, unknown>[] = [];
  const text = (id: string, value: string) => ({ id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }] });
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const output = requests.length === 1 ? [text('m1', 'before'),
      { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'cipher' },
      { type: 'function_call', id: 'fc', call_id: 'c1', name: 'read', arguments: '{"path":"fixture.txt"}', status: 'completed' }, text('m2', 'after')]
      : [text('m3', 'done')];
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }));
  registerCustomProviders([{ name: 'substrate-responses', protocol: 'openai', api: 'responses', model: 'fixture',
    apiKeyEnv: 'SUBSTRATE_RESPONSES_KEY', baseUrl: 'https://substrate.test/v1', maxOutputTokens: 2048 }]);
  const executed = vi.fn(async () => 'fixture content');
  const result = await runSubstrate({ provider: 'substrate-responses', maxIter: 2, reasoningMode: 'off',
    context: { systemPromptOverride: 'sys', preflightMode: 'off' }, events: { beforeToolExecute: executed } }, 'Read the fixture.');
  expect(result.success).toBe(true);
  expect(executed).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(2);
  const input = requests[1]!.input as { type?: string; role?: string; content?: unknown }[];
  const first = input.findIndex(item => item.role === 'assistant' && item.content === 'before');
  expect(input.slice(first, first + 4)).toMatchObject([
    { role: 'assistant', content: 'before' }, { type: 'reasoning', encrypted_content: 'cipher' },
    { type: 'function_call', call_id: 'c1' }, { role: 'assistant', content: 'after' },
  ]);
  expect(input.some(item => item.type === 'function_call_output')).toBe(true);
}, 30000);
