import { afterEach, expect, it, vi } from 'vitest';
import { ambientProviderKey, setAmbientProviderKeySource } from './ambient-provider-key.js';
import { runWithProviderCredential } from './provider-credential-context.js';
import { getProvider, isProviderConfigured, resetBuiltinProviderCache } from './providers/registry.js';

const uninstall: Array<() => void> = [];
afterEach(() => { for (const off of uninstall.splice(0)) off(); vi.unstubAllEnvs(); resetBuiltinProviderCache(); });

it('answers the environment value first and asks the source only when the environment holds none', () => {
  const source = vi.fn(() => 'stored');
  uninstall.push(setAmbientProviderKeySource(source));
  expect(ambientProviderKey('openai', 'from-env', () => 'f')).toBe('from-env');
  expect(source).not.toHaveBeenCalled();
  expect(ambientProviderKey('openai', undefined, () => 'f')).toBe('stored');
  expect(ambientProviderKey('openai', '', () => 'f')).toBe('stored');
  expect(source).toHaveBeenCalledWith('openai', 'f');
});

it('answers the environment value alone when no source is installed', () => {
  expect(ambientProviderKey('openai', undefined, () => { throw new Error('not asked'); })).toBeUndefined();
});

it('refuses a second source, so two owners cannot both decide', () => {
  uninstall.push(setAmbientProviderKeySource(() => undefined));
  expect(() => setAmbientProviderKeySource(() => undefined)).toThrow(/already/);
});

it('does not consult the source inside a credential scope, whose own credential decides', async () => {
  const source = vi.fn(() => 'stored');
  uninstall.push(setAmbientProviderKeySource(source));
  await runWithProviderCredential('openai', 'leased', async () => {
    expect(ambientProviderKey('openai', undefined, () => 'f')).toBeUndefined();
  });
  expect(source).not.toHaveBeenCalled();
});

it('lets a built-in provider use the stored key bound to its connection when the environment has none', () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  const fingerprint = getProvider('openai').getCredentialConnectionFingerprint();
  uninstall.push(setAmbientProviderKeySource((provider, connection) => (
    provider === 'openai' && connection === fingerprint ? 'stored-openai' : undefined
  )));
  expect(isProviderConfigured('openai')).toBe(true);
  expect(getProvider('openai').isConfigured()).toBe(true);
  expect(isProviderConfigured('anthropic')).toBe(false);
});
