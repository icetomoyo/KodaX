import { afterEach, expect, it, vi } from 'vitest';
import { getProvider, resetBuiltinProviderCache } from './registry.js';

afterEach(() => { resetBuiltinProviderCache(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// Issue 449: without an explicit timeout the Anthropic SDK refuses, before any network call, a
// non-streaming request whose max_tokens implies more than 10 minutes (about 21,333 tokens). That
// broke the rejection diagnostic and the non-streaming fallback for large-output models.
it('sends a non-streaming request at the full output limit of a large-output model', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-key');
  let body: { max_tokens?: number; stream?: boolean } | undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(new Request(input, init).method === 'POST' ? init?.body : '{}')) as typeof body;
    return Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: 'fixture',
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const provider = getProvider('deepseek');
  expect(provider.getEffectiveMaxOutputTokens()).toBeGreaterThan(21_333);
  const result = await provider.complete([{ role: 'user', content: 'fixture' }], [], '', { enabled: false });
  expect(result.textBlocks.map(block => block.text).join('')).toBe('done');
  expect(body?.max_tokens).toBe(provider.getEffectiveMaxOutputTokens());
  expect(body?.stream).toBeFalsy();
});
