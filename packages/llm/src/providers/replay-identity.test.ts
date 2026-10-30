import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider, runWithProviderCredential } from '../index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['anthropic', 'responses', 'chat'] as const)('keeps %s opaque replay within the acquired credential identity and preserves readable history', async route => {
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(route === 'anthropic'
    ? { content: [{ type: 'thinking', thinking: 'readable', signature: 'opaque-identity-a' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    : route === 'responses' ? { status: 'completed', output: [{ type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'readable' }], encrypted_content: 'opaque-identity-a' }] }
    : { choices: [{ message: { content: 'ok', reasoning_details: [{ type: 'reasoning.text', text: 'readable' }, { type: 'reasoning.encrypted', data: 'opaque-identity-a' }] }, finish_reason: 'stop' }] }));
  vi.stubGlobal('fetch', wire);
  const provider = createCustomProvider({ name: 'replay', protocol: route === 'anthropic' ? 'anthropic' : 'openai',
    ...(route === 'responses' ? { api: 'responses' as const } : {}), model: 'fixture', maxOutputTokens: 100,
    supportsThinking: true, replayReasoningContent: true, apiKeyEnv: 'UNUSED', baseUrl: 'https://replay.example/v1' });
  const first = await runWithProviderCredential(provider.name, 'account-a', () => provider.complete([], [], ''));
  const messages = [{ role: 'assistant' as const, content: first.contentBlocks ?? [...first.thinkingBlocks, ...first.textBlocks] }, { role: 'user' as const, content: 'next' }];
  await runWithProviderCredential(provider.name, 'account-a', () => provider.complete(messages, [], ''));
  await runWithProviderCredential(provider.name, 'account-b', () => provider.complete(messages, [], ''));
  expect(String(wire.mock.calls[1]?.[1]?.body)).toContain('opaque-identity-a');
  expect(String(wire.mock.calls[2]?.[1]?.body)).not.toContain('opaque-identity-a');
  expect(String(wire.mock.calls[2]?.[1]?.body)).toContain('readable');
});

it.each(['anthropic', 'responses', 'chat'] as const)('refreshes memoized %s credentials when the legacy environment key changes', async route => {
  vi.stubEnv('ROTATING_REPLAY_KEY', 'account-a');
  const wire = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers); const key = headers.get('x-api-key') ?? headers.get('authorization')!;
    const opaque = key.includes('account-a') ? 'opaque-account-a' : 'opaque-account-b';
    return Response.json(route === 'anthropic' ? { content: [{ type: 'thinking', thinking: 'readable', signature: opaque }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
      : route === 'responses' ? { status: 'completed', output: [{ type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: 'readable' }], encrypted_content: opaque }] }
      : { choices: [{ message: { content: 'ok', reasoning_details: [{ type: 'reasoning.text', text: 'readable' }, { type: 'reasoning.encrypted', data: opaque }] }, finish_reason: 'stop' }] });
  }); vi.stubGlobal('fetch', wire);
  const config = { name: 'rotating', protocol: route === 'anthropic' ? 'anthropic' as const : 'openai' as const, ...(route === 'responses' ? { api: 'responses' as const } : {}),
    model: 'fixture', maxOutputTokens: 100, supportsThinking: true, replayReasoningContent: true, apiKeyEnv: 'ROTATING_REPLAY_KEY', baseUrl: 'https://rotating.example/v1' };
  const provider = createCustomProvider(config); const first = await provider.complete([], [], '');
  vi.stubEnv('ROTATING_REPLAY_KEY', 'account-b');
  const second = await provider.complete([{ role: 'assistant', content: first.contentBlocks ?? first.thinkingBlocks }, { role: 'user', content: 'next' }], [], '');
  const header = new Headers(wire.mock.calls[1]?.[1]?.headers);
  expect(header.get('x-api-key') ?? header.get('authorization')).toContain('account-b');
  expect(String(wire.mock.calls[1]?.[1]?.body)).not.toContain('opaque-account-a');
  await createCustomProvider(config).complete([{ role: 'assistant', content: second.contentBlocks ?? second.thinkingBlocks }, { role: 'user', content: 'next' }], [], '');
  expect(String(wire.mock.calls[2]?.[1]?.body)).not.toContain('opaque-account-a');
  expect(String(wire.mock.calls[2]?.[1]?.body)).toContain('opaque-account-b');
});
