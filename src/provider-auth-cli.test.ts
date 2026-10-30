import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { configureProviderAuthCommand, readOAuthConnection, receiveOAuthCallback, providerOAuthStore } from './provider-auth-cli.js';
import { createOAuthProviderConfig } from '@kodax-ai/llm';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('accepts only the exact loopback callback and closes observation on abort', async () => {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('Expected local port');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const redirect = `http://127.0.0.1:${address.port}/callback`;
  let wrongStatus: number | undefined;
  const callback = await receiveOAuthCallback(redirect, 'https://issuer.example/authorize', AbortSignal.timeout(10000), async () => {
    wrongStatus = (await fetch(`http://127.0.0.1:${address.port}/other`)).status;
    await fetch(`${redirect}?state=fixture&code=fixture`);
  });
  expect(wrongStatus).toBe(404); expect(callback).toContain('code=fixture');
  const controller = new AbortController(); controller.abort();
  await expect(receiveOAuthCallback(redirect, 'https://issuer.example', controller.signal)).rejects.toThrow(/cancelled/);
  expect(() => receiveOAuthCallback('http://0.0.0.0:1455/callback', 'https://issuer.example', controller.signal)).toThrow(/loopback/);
});
it.skipIf(process.platform !== 'win32')('configures auth status/logout through the real CLI command and secure store', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-auth-cli-')); vi.stubEnv('KODAX_HOME', directory);
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const configPath = path.join(directory, 'config.json');
    const provider = { ...createOAuthProviderConfig({ name: 'subscription', service: 'github-copilot', model: 'fixture' }), oauthRegistration: 'registration' };
    await writeFile(configPath, JSON.stringify({ unrelated: 'preserved', customProviders: [provider] }));
    await providerOAuthStore(configPath).transact('registration', async () => ({ record: { id: 'registration', service: 'github-copilot', clientId: 'issued', accountId: 'grant-fixture', identityKind: 'grant', credentials: { accessToken: 'fixture-secret' } }, result: undefined }));
    const run = async (...args: string[]) => { const command = new Command().exitOverride(); configureProviderAuthCommand(command); await command.parseAsync(['node', 'kodax', 'auth', ...args]); };
    await run('status', 'subscription'); expect(output.mock.calls.flat().join('')).toContain('Stored grant');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => Response.json(String(url).includes('device/code')
      ? { device_code: 'device', user_code: 'VISIBLE', verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 0.001 }
      : { access_token: 'new-cli-identity-fixture', token_type: 'bearer' })));
    await run('login', 'subscription', '--device', '--client-id', 'issued', '--scope', 'read:user');
    const linked = JSON.parse(await readFile(configPath, 'utf8')).customProviders[0]; expect(linked.oauthRegistration).not.toBe('registration');
    expect(await providerOAuthStore(configPath).transact('registration', async record => ({ record, result: record?.credentials }))).toBeUndefined();
    await run('logout', 'subscription');
    const saved = JSON.parse(await readFile(configPath, 'utf8')); expect(saved.unrelated).toBe('preserved'); expect(saved.customProviders[0]).not.toHaveProperty('oauthRegistration');
    expect(JSON.stringify(saved)).not.toContain('fixture-secret');
    await run('status', 'subscription'); await run('logout', 'subscription');
    expect(output.mock.calls.flat().join('')).toContain('Login required'); expect(output.mock.calls.flat().join('')).toContain('Already logged out');
    await expect(run('login', 'subscription', '--client-id', 'issued')).rejects.toThrow(/redirect-uri/);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(saved);
    await expect(readOAuthConnection(configPath, 'unknown')).rejects.toThrow(/configured/);
    await writeFile(configPath, '{}'); await expect(readOAuthConnection(configPath, 'subscription')).rejects.toThrow(/Configure/);
  } finally { output.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});
