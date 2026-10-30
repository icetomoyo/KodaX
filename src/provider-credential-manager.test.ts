import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFileProviderCredentialStore } from '@kodax-ai/llm';
import { createProviderCredentialManager, type ProviderCredentialStatus } from './provider-credential-manager.js';

afterEach(() => vi.unstubAllEnvs());
it('rejects missing or invalid expected revisions instead of turning UI updates into unconditional writes', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-key-cas-')), configPath = path.join(folder, 'config.json');
  try {
    const manager = createProviderCredentialManager({ configPath }), initial = await manager.describe('openai');
    const first = await manager.setApiKey('openai', 'first', initial), second = await manager.setApiKey('openai', 'second', first);
    for (const revision of [undefined, '', 1]) {
      const malformed = { ...first, revision } as unknown as ProviderCredentialStatus;
      await expect(manager.setApiKey('openai', 'must-not-overwrite', malformed)).rejects.toThrow(/revision/);
      await expect(manager.removeApiKey('openai', malformed)).rejects.toThrow(/revision/);
    }
    expect((await manager.describe('openai')).revision).toBe(second.revision);
    expect((await createFileProviderCredentialStore(manager.filePath).readApiKey(second.binding))?.key).toBe('second');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it('manages redacted saved/env status with exact config and credential revisions', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-key-manager-')), configPath = path.join(folder, 'config.json');
  const config = { provider: 'custom', customProviders: [{ name: 'custom', protocol: 'openai', model: 'fixture', baseUrl: 'https://custom.example/v1', apiKeyEnv: 'MANAGED_KEY' }] };
  await writeFile(configPath, JSON.stringify(config)); vi.stubEnv('MANAGED_KEY', 'environment-fixture');
  try {
    const manager = createProviderCredentialManager({ configPath });
    const initial = await manager.describe('custom'); expect(initial.source).toBe('environment'); expect(initial.stored).toBe(false);
    const saved = await manager.setApiKey('custom', 'saved-fixture', initial);
    expect(saved.source).toBe('file'); expect(saved.stored).toBe(true); expect(JSON.stringify(saved)).not.toContain('saved-fixture');
    await expect(manager.setApiKey('custom', 'stale', initial)).rejects.toThrow(/conflict/);
    const restarted = createProviderCredentialManager({ configPath }); expect((await restarted.describe('custom')).source).toBe('file');
    expect((await restarted.removeApiKey('custom', saved)).source).toBe('environment');
    expect(await readFile(configPath, 'utf8')).not.toContain('saved-fixture');
    const beforeRouteChange = await manager.describe('custom'); config.customProviders[0]!.baseUrl = 'https://other.example/v1'; await writeFile(configPath, JSON.stringify(config));
    await expect(manager.setApiKey('custom', 'wrong-destination', beforeRouteChange)).rejects.toThrow(/connection|configuration/);
    const isolated = createProviderCredentialManager({ configPath, profile: 'other' }); expect((await isolated.describe('custom')).stored).toBe(false);
    await writeFile(path.join(folder, 'auth.json'), '{broken');
    await expect(manager.describe('custom')).rejects.toThrow(/storage/);
    expect(await readFile(path.join(folder, 'auth.json'), 'utf8')).toBe('{broken');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it('uses the actual config root, keeps profiles separate and refuses Key writes for OAuth or external auth', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-key-profile-')), configPath = path.join(folder, 'config.json');
  await writeFile(configPath, JSON.stringify({ customProviders: [{ name: 'oauth', protocol: 'openai', api: 'responses', oauth: 'openai-chatgpt', model: 'fixture', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'UNUSED' }] }));
  try {
    const manager = createProviderCredentialManager({ configPath });
    await expect(manager.setApiKey('oauth', 'must-not-write', await manager.describe('oauth'))).rejects.toThrow(/OAuth/);
    await expect(manager.setApiKey('codex-cli', 'must-not-write', await manager.describe('codex-cli'))).rejects.toThrow(/external/);
    const before = await manager.describe('openai'), saved = await manager.setApiKey('openai', 'profile-one', before);
    expect(manager.filePath).toBe(path.join(folder, 'auth.json'));
    expect((await createProviderCredentialManager({ configPath, profile: 'other' }).describe('openai')).stored).toBe(false);
    expect((await createFileProviderCredentialStore(manager.filePath).readApiKey(saved.binding))?.key).toBe('profile-one');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
