import { afterEach, expect, it, vi } from 'vitest';
import { createOAuthProviderConfig } from '../oauth/provider-config.js';
import { createCustomProvider } from './custom-provider.js';
import { runWithProviderCredential } from '../provider-credential-context.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['openai-chatgpt', 'openai-codex', 'github-copilot', 'anthropic', 'openrouter', 'kimi-coding', 'meta', 'xai', 'radius'] as const)
  ('preserves an explicit unsupported credential probe for %s with zero network requests', async service => {
    const fetch = vi.fn(async () => { throw new Error('unexpected credential probe'); });
    vi.stubGlobal('fetch', fetch);
    const config = { ...createOAuthProviderConfig({ service, name: `no-probe-${service}`, model: 'chosen' }), verifyStrategy: 'unsupported' as const };
    const result = await runWithProviderCredential(config.name, 'scoped-test-token', () => createCustomProvider(config).verifyCredential());
    expect(result).toMatchObject({ ok: false, error: 'unsupported' });
    expect(fetch).not.toHaveBeenCalled();
  });
it.each(['meta', 'xai'] as const)('drops encrypted Responses history when %s account credentials change', async service => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ status: 'completed', output: [
    { type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: 'readable' }], encrypted_content: 'first-account-cipher' },
  ] }));
  vi.stubGlobal('fetch', fetch);
  const config = createOAuthProviderConfig({ service, name: `scoped-${service}`, model: 'chosen' });
  const provider = createCustomProvider(config);
  const first = await runWithProviderCredential(config.name, 'account-one', () => provider.complete([], [], ''));
  await runWithProviderCredential(config.name, 'account-two', () => provider.complete([{ role: 'assistant', content: first.contentBlocks! }], [], ''));
  const body = String(fetch.mock.calls[1]?.[1]?.body);
  expect(body).not.toContain('first-account-cipher');
  expect(body).toContain('readable');
});
it('keeps readable Anthropic history while dropping a different account signature', async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ id: 'msg', type: 'message', role: 'assistant', model: 'chosen',
    content: [{ type: 'thinking', thinking: 'readable', signature: 'account-one-signature' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } }));
  vi.stubGlobal('fetch', fetch);
  const config = createOAuthProviderConfig({ service: 'anthropic', name: 'scoped-anthropic', model: 'chosen' });
  const provider = createCustomProvider(config);
  const first = await runWithProviderCredential(config.name, 'account-one', () => provider.complete([], [], '', undefined, { maxOutputTokensOverride: 16 }));
  await runWithProviderCredential(config.name, 'account-two', () => provider.complete([{ role: 'assistant', content: first.contentBlocks ?? first.thinkingBlocks }], [], '', undefined, { maxOutputTokensOverride: 16 }));
  expect(String(fetch.mock.calls[1]?.[1]?.body)).not.toContain('account-one-signature');
  expect(String(fetch.mock.calls[1]?.[1]?.body)).toContain('readable');
});
