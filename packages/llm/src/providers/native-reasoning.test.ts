import { afterEach, expect, it, vi } from 'vitest';
import { createCloudProviderConfig, createCustomProvider, runWithProviderCredential, serializeCloudCredential,
  type KodaXReasoningProfile } from '../index.js';

afterEach(() => vi.unstubAllGlobals());
it.each(['bedrock-openai-effort', 'bedrock-openai-nested-effort'] as const)('sends the declared %s dialect and reports the actual control', async strategy => {
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({
    output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn',
  }));
  vi.stubGlobal('fetch', fetcher);
  const config = createCloudProviderConfig({ service: 'bedrock', name: 'reasoning', model: 'explicit-model', region: 'us-east-1' });
  const profile: KodaXReasoningProfile = { effortStrategy: strategy, supportedEfforts: [{ value: 'low' }, { value: 'high' }], defaultEffort: 'low' };
  const provider = createCustomProvider({ ...config, reasoningProfile: profile });
  const onReasoningResolved = vi.fn();
  const result = await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'fixture' }),
    () => provider.complete([], [], '', { effort: 'high' }, { onReasoningResolved }));
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.additionalModelRequestFields).toEqual(strategy === 'bedrock-openai-effort' ? { reasoning_effort: 'high' } : { reasoning: { effort: 'high' } });
  expect(result.reasoningResolution).toMatchObject({ sentEffort: 'high', verified: false });
  expect(onReasoningResolved).toHaveBeenCalledWith(result.reasoningResolution);
});

it.each(['anthropic', 'bedrock'] as const)('lowers declared %s thinking display and prefix binding controls without adding them to disabled thinking', async route => {
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(route === 'anthropic'
    ? { content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 0 } }
    : { output: { message: { role: 'assistant', content: [] } }, stopReason: 'end_turn' })); vi.stubGlobal('fetch', wire);
  const config = route === 'bedrock' ? createCloudProviderConfig({ service: 'bedrock', name: 'display', model: 'declared', region: 'us-east-1' })
    : { name: 'display', model: 'declared', protocol: route, baseUrl: 'https://display.example/v1', apiKeyEnv: 'UNUSED' };
  const provider = createCustomProvider({ ...config, maxOutputTokens: 100, reasoningProfile: {
    effortStrategy: route === 'bedrock' ? 'bedrock-anthropic-effort' : 'anthropic-output-effort', supportedEfforts: [{ value: 'high' }, { value: 'none' }],
    defaultEffort: 'high', supportsDisabledThinking: true, disabledEfforts: ['none'], supportsThinkingDisplay: true, supportsThinkingBlockBinding: true,
  } });
  const token = route === 'bedrock' ? serializeCloudCredential(config.name, { type: 'bearer', token: 'fixture' }) : 'fixture';
  await runWithProviderCredential(config.name, token, () => provider.complete([], [], '', { effort: 'high' }, { thinkingDisplay: 'omitted' }));
  const raw = wire.mock.calls[0]?.[1]?.body;
  const first = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString());
  const fields = route === 'bedrock' ? first.additionalModelRequestFields : first;
  expect(fields.thinking).toMatchObject({ type: 'adaptive', display: 'omitted', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  if (route === 'bedrock') expect(fields.anthropic_beta).toContain('thinking-binding-controls-2026-08-01');
  else expect(new Headers(wire.mock.calls[0]?.[1]?.headers).get('anthropic-beta')).toContain('thinking-binding-controls-2026-08-01');
  await runWithProviderCredential(config.name, token, () => provider.complete([], [], '', { effort: 'none' }, { thinkingDisplay: 'omitted' }));
  const secondRaw = wire.mock.calls[1]?.[1]?.body;
  const second = JSON.parse(typeof secondRaw === 'string' ? secondRaw : Buffer.from(secondRaw as Uint8Array).toString());
  expect((route === 'bedrock' ? second.additionalModelRequestFields : second).thinking).toEqual({ type: 'disabled' });
});

it('does not report an ignored foreign reasoning strategy as sent to Bedrock', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ output: { message: { role: 'assistant', content: [] } }, stopReason: 'end_turn' })));
  const config = createCloudProviderConfig({ service: 'bedrock', name: 'reasoning', model: 'unknown', region: 'us-east-1' });
  const provider = createCustomProvider({ ...config, reasoningProfile: { effortStrategy: 'google-thinking-level', supportedEfforts: [{ value: 'high' }] } });
  const result = await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'fixture' }),
    () => provider.complete([], [], '', { effort: 'high' }));
  expect(result.reasoningResolution).toMatchObject({ requestedEffort: 'high', verified: false, fallbacks: [{ effort: 'high', reason: 'profile' }] });
  expect(result.reasoningResolution?.sentEffort).toBeUndefined();
});
