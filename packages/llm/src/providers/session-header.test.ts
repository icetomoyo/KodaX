import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider, createCloudProviderConfig, runWithProviderCredential, runWithScopedConfig,
  serializeCloudCredential } from '../index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

type Route = 'openai' | 'anthropic' | 'responses' | 'mistral' | 'pi-messages' | 'gemini' | 'bedrock';
const routes: readonly Route[] = ['openai', 'anthropic', 'responses', 'mistral', 'pi-messages', 'gemini', 'bedrock'];

function reply(route: Route): Response {
  if (route === 'pi-messages') return new Response('data: {"type":"start"}\n\ndata: {"type":"done","reason":"stop"}\n\n');
  if (route === 'anthropic') return Response.json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  if (route === 'gemini') return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
  if (route === 'bedrock') return Response.json({ output: { message: { role: 'assistant', content: [] } }, stopReason: 'end_turn' });
  if (route === 'responses') return Response.json({ id: 'r', status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }] });
  return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
}

async function sentHeaders(route: Route, run: (call: () => Promise<unknown>) => Promise<unknown>, headers?: Record<string, string>): Promise<Headers> {
  const config = route === 'gemini' ? createCloudProviderConfig({ name: 'session', service: 'gemini', model: 'fixture' })
    : route === 'bedrock' ? createCloudProviderConfig({ name: 'session', service: 'bedrock', model: 'fixture', region: 'us-east-1' })
    : { name: 'session', model: 'fixture', protocol: route === 'responses' ? 'openai' as const : route,
      ...(route === 'responses' ? { api: 'responses' as const } : {}), apiKeyEnv: 'SESSION_HEADER_KEY', baseUrl: 'https://session.example/v1' };
  const provider = createCustomProvider({ ...config, maxOutputTokens: 100 });
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply(route));
  const token = config.cloud ? serializeCloudCredential(config.name, route === 'gemini' ? { type: 'api-key', key: 'fixture' }
    : { type: 'aws', accessKeyId: 'test-access', secretAccessKey: 'test-secret' }) : 'fixture';
  await run(() => runWithProviderCredential(config.name, token, () => provider.complete([], [], '', undefined,
    { fetch: wire, ...(headers ? { headers } : {}) })));
  expect(wire).toHaveBeenCalled();
  return new Headers(wire.mock.calls[0]?.[1]?.headers);
}

it.each(routes)('sends the run session id as X-Session-Id on %s', async route => {
  const headers = await sentHeaders(route, call => runWithScopedConfig({ sessionId: '019a7f3e-55aa-7c1d-8e2f-0123456789ab' }, call));
  expect(headers.get('x-session-id')).toBe('019a7f3e-55aa-7c1d-8e2f-0123456789ab');
  if (route === 'bedrock') expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256/);
});

it.each(routes)('sends no session header on %s outside a session run', async route => {
  const headers = await sentHeaders(route, call => call());
  expect(headers.has('x-session-id')).toBe(false);
});

it('keeps a caller-supplied X-Session-Id instead of replacing it', async () => {
  const headers = await sentHeaders('openai', call => runWithScopedConfig({ sessionId: 'run-session-id' }, call), { 'X-Session-Id': 'host-chosen' });
  expect(headers.get('x-session-id')).toBe('host-chosen');
});

it.each(['bad\r\nInjected: yes', 'bad id', 'b'.repeat(129), '', 'ünïcode'])('omits an unsafe session id %j without failing the request', async sessionId => {
  const headers = await sentHeaders('openai', call => runWithScopedConfig({ sessionId }, call));
  expect(headers.has('x-session-id')).toBe(false);
  expect(headers.has('injected')).toBe(false);
});
