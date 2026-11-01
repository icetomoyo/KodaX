import { afterEach, expect, it, vi } from 'vitest';
import { getProvider, resetBuiltinProviderCache } from './registry.js';
import { runWithProviderCredential } from '../provider-credential-context.js';

afterEach(() => { resetBuiltinProviderCache(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('sends only the selected native API key to the approved ambient proxy', async () => {
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'unselected-fixture-account');
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://approved-fixture.invalid');
  let observed: Request | undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    observed = new Request(input, init);
    return Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: 'fixture',
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  });
  await runWithProviderCredential('anthropic', 'selected-fixture-key', () =>
    getProvider('anthropic').complete([{ role: 'user', content: 'fixture' }], [], '', undefined, { maxOutputTokensOverride: 16 }));
  expect(new URL(observed!.url).origin).toBe('https://approved-fixture.invalid');
  expect(observed!.headers.get('x-api-key')).toBe('selected-fixture-key');
  expect(observed!.headers.has('authorization')).toBe(false);
});
