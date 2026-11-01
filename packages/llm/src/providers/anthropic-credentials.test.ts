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

it('binds the actual scoped destination and prevents ambient headers from replacing selected credentials', async () => {
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ambient-fixture.invalid');
  vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'x-api-key: wrong-account\nAuthorization: Bearer wrong-bearer');
  let observed: Request | undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    observed = new Request(input, init);
    return Response.json({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' });
  });
  const provider = getProvider('anthropic');
  const ambientFingerprint = provider.getCredentialConnectionFingerprint();
  let scopedFingerprint: string | undefined;
  await runWithProviderCredential('anthropic', 'selected-fixture-key', () => provider.complete([{ role: 'user', content: 'hello' }], [], '', undefined, {
    maxOutputTokensOverride: 16, env: { ANTHROPIC_BASE_URL: 'https://scoped-fixture.invalid' },
    onPayload: () => { scopedFingerprint = provider.getCredentialConnectionFingerprint(); },
  }));
  expect(new URL(observed!.url).origin).toBe('https://scoped-fixture.invalid');
  expect(scopedFingerprint).not.toBe(ambientFingerprint);
  expect(observed!.headers.get('x-api-key')).toBe('selected-fixture-key');
  expect(observed!.headers.has('authorization')).toBe(false);
});
