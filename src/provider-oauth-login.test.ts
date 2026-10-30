import { expect, it, vi } from 'vitest';
import { loginProviderOAuth } from './provider-oauth-login.js';
import type { OAuthSessionRecord, OAuthSessionStore } from '@kodax-ai/llm';

it('runs browser PKCE and commits a new isolated grant only after successful callback exchange', async () => {
  let record: OAuthSessionRecord | undefined; const commits = vi.fn();
  const store: OAuthSessionStore = { async transact(_id, operation) { const update = await operation(record); record = update.record; commits(); return update.result; } };
  const fetcher = vi.fn(async () => Response.json({ key: 'openrouter-grant-fixture' }));
  const result = await loginProviderOAuth({ service: 'openrouter', clientId: 'issued-or-pkce-grant', scopes: [], store, redirectUri: 'http://127.0.0.1:1455/callback',
    fetch: fetcher, browser: async ({ authorizationUrl }) => { expect(commits).not.toHaveBeenCalled(); const state = new URL(authorizationUrl).searchParams.get('state'); return `http://127.0.0.1:1455/callback?code=fixture&state=${state}`; } });
  expect(record?.id).toBe(result.registrationId); expect(record?.identityKind).toBe('grant'); expect(record?.accountId).toMatch(/^grant:/);
  expect(await result.session.acquire()).toBe('openrouter-grant-fixture');
  expect(JSON.stringify({ registrationId: result.registrationId, accountId: result.accountId })).not.toContain('openrouter-grant-fixture');
});
it('rejects invalid callback/identity and never persists rejected token material', async () => {
  const transact = vi.fn();
  await expect(loginProviderOAuth({ service: 'openrouter', clientId: 'issued', scopes: [], store: { transact }, redirectUri: 'http://127.0.0.1:1455/callback',
    fetch: async () => Response.json({ key: 'rejected-secret' }), browser: async () => 'http://127.0.0.1:1455/callback?code=fixture&state=wrong' })).rejects.toThrow();
  expect(transact).not.toHaveBeenCalled();
});

it('completes device login without a fabricated subject and exchanges a separate Copilot resource token', async () => {
  let record: OAuthSessionRecord | undefined;
  const store: OAuthSessionStore = { async transact(_id, operation) { const update = await operation(record); record = update.record; return update.result; } };
  const fetcher = vi.fn(async (url: string | URL | Request) => Response.json(String(url).includes('device/code')
    ? { device_code: 'device-fixture', user_code: 'VISIBLE-CODE', verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 0.001 }
    : String(url).includes('copilot_internal') ? { token: 'resource-only', expires_at: Math.floor(Date.now() / 1000) + 3600 }
    : { access_token: 'identity-only', token_type: 'bearer' }));
  const display = vi.fn(async () => undefined);
  const login = await loginProviderOAuth({ service: 'github-copilot', clientId: 'issued', scopes: ['read:user'], store, device: display, fetch: fetcher });
  expect(display).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'VISIBLE-CODE' }));
  expect(await login.session.acquire()).toBe('resource-only'); expect(record?.credentials?.accessToken).toBe('identity-only');
  expect(record?.resource?.accessToken).toBe('resource-only'); expect(login.identityKind).toBe('grant');
});

it('does not publish a grant when trusted identity validation rejects it', async () => {
  const transact = vi.fn();
  await expect(loginProviderOAuth({ service: 'openrouter', clientId: 'issued', scopes: [], store: { transact }, redirectUri: 'http://127.0.0.1:1455/callback',
    fetch: async () => Response.json({ key: 'rejected-identity-fixture' }), verifyIdentity: async () => { throw new Error('unverified identity'); },
    browser: async step => `http://127.0.0.1:1455/callback?code=fixture&state=${new URL(step.authorizationUrl).searchParams.get('state')}` })).rejects.toThrow(/unverified/);
  expect(transact).not.toHaveBeenCalled();
});

it('requires explicit client registration, flow and registered browser callback before obtaining tokens', async () => {
  const transact = vi.fn(), fetcher = vi.fn();
  const base = { service: 'openrouter' as const, clientId: 'issued', scopes: [], store: { transact }, fetch: fetcher };
  await expect(loginProviderOAuth(base)).rejects.toThrow(/invalid session/);
  await expect(loginProviderOAuth({ ...base, clientId: '', device: async () => undefined })).rejects.toThrow(/invalid session/);
  await expect(loginProviderOAuth({ ...base, browser: async () => 'invalid' })).rejects.toThrow(/invalid session/);
  expect(fetcher).not.toHaveBeenCalled(); expect(transact).not.toHaveBeenCalled();
});

it('does not publish or activate a new grant when cancellation arrives during durable commit', async () => {
  const controller = new AbortController(); let record: OAuthSessionRecord | undefined, commits = 0;
  const store: OAuthSessionStore = { async transact(_id, operation) { const update = await operation(record); record = update.record; if (++commits === 1) controller.abort(new Error('cancelled-during-commit')); return update.result; } };
  await expect(loginProviderOAuth({ service: 'openrouter', clientId: 'issued', scopes: [], store, redirectUri: 'http://127.0.0.1:1455/callback', signal: controller.signal,
    fetch: async () => Response.json({ key: 'unpublished-fixture' }), browser: async step => `http://127.0.0.1:1455/callback?code=fixture&state=${new URL(step.authorizationUrl).searchParams.get('state')}` })).rejects.toThrow(/cancelled-during-commit/);
  expect(record?.credentials).toBeUndefined();
});
