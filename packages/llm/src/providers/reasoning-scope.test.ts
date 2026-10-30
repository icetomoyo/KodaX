import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider, createCloudProviderConfig, runWithProviderCredential, serializeCloudCredential,
  type KodaXCustomProviderConfig, type KodaXReasoningProfile } from '../index.js';

afterEach(() => vi.unstubAllGlobals());
it.each(['openai', 'anthropic', 'mistral', 'gemini', 'bedrock'] as const)('partitions %s hard-rejection learning by acquired identity and ignores legacy cache through the scoped resolver', async route => {
  const rejected = new Set<string>();
  const wire = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : Buffer.from(init?.body as Uint8Array).toString());
    const headers = new Headers(init?.headers);
    const key = headers.get('authorization') ?? headers.get('x-api-key') ?? headers.get('x-goog-api-key') ?? '';
    const control = body.reasoning_effort ?? body.output_config?.effort ?? body.generationConfig?.thinkingConfig?.thinkingLevel ?? body.additionalModelRequestFields?.reasoning_effort;
    if (control && !rejected.has(key)) { rejected.add(key); return Response.json(route === 'bedrock' ? { __type: 'ValidationException', message: "reasoning effort 'high' is not supported" } : { error: { message: "reasoning effort 'high' is not supported" } }, { status: 400 }); }
    return Response.json(route === 'anthropic' ? { content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 0 } }
      : route === 'gemini' ? { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
      : route === 'bedrock' ? { output: { message: { role: 'assistant', content: [] } }, stopReason: 'end_turn' }
      : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  });
  vi.stubGlobal('fetch', wire);
  const config: KodaXCustomProviderConfig = route === 'gemini' ? createCloudProviderConfig({ service: 'gemini', name: 'scope', model: 'fixture' })
    : route === 'bedrock' ? createCloudProviderConfig({ service: 'bedrock', name: 'scope', model: 'fixture', region: 'us-east-1' })
    : { name: 'scope', protocol: route, model: 'fixture', apiKeyEnv: 'UNUSED_SCOPE_KEY', baseUrl: 'https://scope.example/v1' };
  const profile: KodaXReasoningProfile = { effortStrategy: route === 'anthropic' ? 'anthropic-output-effort' : route === 'gemini' ? 'google-thinking-level'
    : route === 'bedrock' ? 'bedrock-openai-effort' : 'openai-chat-effort', supportedEfforts: [{ value: 'high' }] };
  const provider = createCustomProvider({ ...config, maxOutputTokens: 100, reasoningProfile: profile });
  const scopes: string[] = [];
  const options = { resolveRejectedReasoningEfforts: (scope: string) => { scopes.push(scope); return []; }, onReasoningEffortRejected: vi.fn() };
  const run = (key: string) => runWithProviderCredential(config.name, config.cloud ? serializeCloudCredential(config.name,
    route === 'gemini' ? { type: 'api-key', key } : { type: 'bearer', token: key }) : key,
    () => provider.complete([], [], '', { effort: 'high' }, options));
  const first = await run('account-a'); await run('account-a'); await run('account-b');
  expect(first.reasoningResolution).toMatchObject({ requestedEffort: 'high', verified: false });
  expect(first.reasoningResolution?.sentEffort).toBeUndefined();
  expect(first.reasoningResolution?.fallbacks).toContainEqual({ effort: 'high', reason: 'unsupported-effort' });
  expect(wire).toHaveBeenCalledTimes(5);
  expect(scopes.length).toBeGreaterThanOrEqual(3); expect(scopes[0]).toBe(scopes[1]); expect(scopes.at(-1)).not.toBe(scopes[0]);
  const events = options.onReasoningEffortRejected.mock.calls.map(call => call[0] as { cacheScope?: string });
  expect(events).toHaveLength(2); expect(events.every(event => /^[a-f0-9]{64}$/.test(event.cacheScope ?? ''))).toBe(true);
});
