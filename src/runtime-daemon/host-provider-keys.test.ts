import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getProvider } from '@kodax-ai/llm';
import { createHostProviderKeys, useHostStoredProviderKeys } from './host-provider-keys.js';

const folders: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function configPath(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-host-provider-keys-'));
  folders.push(folder);
  const file = path.join(folder, 'config.json');
  await writeFile(file, '{}');
  return file;
}

function noEnvironment(): Readonly<Record<string, string | undefined>> {
  return {};
}

it('saves a key the Host then uses, and never answers with the key', async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  const file = await configPath();
  const keys = createHostProviderKeys(file, noEnvironment);
  cleanups.push(useHostStoredProviderKeys(file));
  const before = await keys.get('openai');
  expect(before).toMatchObject({ provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY', stored: false, source: 'missing' });
  expect(getProvider('openai').isConfigured()).toBe(false);

  const saved = await keys.set('openai', 'sk-host-secret', before.revision);
  expect(saved).toMatchObject({ stored: true, source: 'file' });
  expect(JSON.stringify(saved)).not.toContain('sk-host-secret');
  expect(getProvider('openai').isConfigured()).toBe(true);

  const removed = await keys.remove('openai', saved.revision);
  expect(removed).toMatchObject({ stored: false, source: 'missing' });
  expect(getProvider('openai').isConfigured()).toBe(false);
});

it('reports the environment as the source while it holds a key, because the Host uses it first', async () => {
  const file = await configPath();
  const keys = createHostProviderKeys(file, () => ({ OPENAI_API_KEY: 'from-env' }));
  const saved = await keys.set('openai', 'sk-stored');
  expect(saved).toMatchObject({ stored: true, source: 'environment' });
});

it('refuses a change made against an older state, but answers a resent change that already holds', async () => {
  const file = await configPath();
  const keys = createHostProviderKeys(file, noEnvironment);
  const first = await keys.get('openai');
  await keys.set('openai', 'sk-one', first.revision);
  await expect(keys.set('openai', 'sk-other', first.revision)).rejects.toMatchObject({ kodaxCode: 'conflict' });
  await expect(keys.set('openai', 'sk-one', first.revision)).resolves.toMatchObject({ stored: true });
  const current = await keys.get('openai');
  await keys.remove('openai', current.revision);
  await expect(keys.remove('openai', current.revision)).resolves.toMatchObject({ stored: false });
});

it('names what it cannot do: an unknown provider, and one that signs in another way', async () => {
  const file = await configPath();
  const keys = createHostProviderKeys(file, noEnvironment);
  await expect(keys.get('no-such-provider')).rejects.toMatchObject({ kodaxCode: 'not_found' });
  await expect(keys.set('gemini-cli', 'sk-x')).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
});

it('leaves the saved keys unused when the key file cannot be read, and says so once', async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  const file = await configPath();
  await writeFile(path.join(path.dirname(file), 'auth.json'), '{"version":2,');
  const warn = vi.fn();
  cleanups.push(useHostStoredProviderKeys(file, warn));
  expect(getProvider('openai').isConfigured()).toBe(false);
  expect(getProvider('openai').isConfigured()).toBe(false);
  expect(warn).toHaveBeenCalledTimes(1);
});
