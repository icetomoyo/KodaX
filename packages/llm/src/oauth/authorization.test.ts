import { expect, it, vi } from 'vitest';
import { beginOAuthAuthorization } from './authorization.js';
import { createHash } from 'node:crypto';

it('uses OpenRouter PKCE, validates callback state before exchange and consumes the transaction once', async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ key: 'issued-key' }));
  const login = await beginOAuthAuthorization({ service: 'openrouter', redirectUri: 'http://127.0.0.1:32123/callback', scopes: [], fetch });
  const url = new URL(login.authorizationUrl);
  expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('callback_url')).toBe('http://127.0.0.1:32123/callback');
  expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(login.exchange('http://127.0.0.1:32123/callback?code=secret-code&state=wrong')).rejects.toThrow(/invalid session/i);
  expect(fetch).not.toHaveBeenCalled();
  const result = await login.exchange(`http://127.0.0.1:32123/callback?code=secret-code&state=${url.searchParams.get('state')}`);
  expect(result.tokens).toEqual({ accessToken: 'issued-key' });
  expect(fetch.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/auth/keys');
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ code: 'secret-code', code_challenge_method: 'S256' });
  await expect(login.exchange(`http://127.0.0.1:32123/callback?code=again&state=${url.searchParams.get('state')}`)).rejects.toThrow(/invalid session/i);
});
it('does not expose an authorization code in malformed callback errors', async () => {
  const login = await beginOAuthAuthorization({ service: 'openrouter', redirectUri: 'http://localhost:32123/callback', scopes: [] });
  await expect(login.exchange('invalid URL containing private-code')).rejects.toMatchObject({ code: 'invalid_session' });
});
it.each([
  ['anthropic', 'https://platform.claude.com/v1/oauth/token'], ['openai-chatgpt', 'https://auth.openai.com/api/accounts/oauth/token'],
  ['openai-codex', 'https://auth.openai.com/oauth/token'], ['xai', 'https://auth.x.ai/oauth2/token'], ['radius', 'https://radius.pi.dev/v1/oauth/token'],
] as const)('exchanges %s with its own registration, PKCE verifier and callback', async (service, tokenEndpoint) => {
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, id_token: 'host-must-validate' })
    : Response.json({ authorization_endpoint: 'https://auth.openai.com/oauth/authorize', authorizationEndpoint: 'https://login.gateway.example/authorize' }));
  const login = await beginOAuthAuthorization({ service, clientId: 'own-client', scopes: ['openid', 'offline_access'], redirectUri: 'http://127.0.0.1:32123/callback', fetch });
  const url = new URL(login.authorizationUrl);
  const result = await login.exchange(`http://127.0.0.1:32123/callback?code=auth-code&state=${url.searchParams.get('state')}`);
  expect(result).toMatchObject({ tokens: { accessToken: 'access', refreshToken: 'refresh' }, idToken: 'host-must-validate' });
  expect(url.searchParams.get('nonce')).toBe(login.nonce);
  const call = fetch.mock.calls.at(-1)!;
  expect(call[0]).toBe(tokenEndpoint);
  const wire = String(call[1]?.body);
  const fields = service === 'anthropic' ? JSON.parse(wire) as Record<string, string> : Object.fromEntries(new URLSearchParams(wire));
  expect(fields).toMatchObject({ grant_type: 'authorization_code', code: 'auth-code', client_id: 'own-client', redirect_uri: 'http://127.0.0.1:32123/callback' });
  expect(createHash('sha256').update(fields.code_verifier!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
});
it.each(['http://remote.example/callback', 'https://user:pass@example.test/callback', 'https://example.test/callback?secret=x', 'https://example.test/callback#fragment', 'invalid URL'])
  ('rejects an unsafe redirect without starting authorization: %s', async redirectUri => {
    const fetch = vi.fn();
    await expect(beginOAuthAuthorization({ service: 'xai', clientId: 'own', scopes: [], redirectUri, fetch })).rejects.toMatchObject({ code: 'invalid_session' });
    expect(fetch).not.toHaveBeenCalled();
  });
it.each(['wrong-origin', 'wrong-path', 'missing-code', 'duplicate-state', 'duplicate-code', 'unicode-state', 'provider-error'] as const)
  ('rejects %s before exchanging a secret', async problem => {
    const fetch = vi.fn();
    const login = await beginOAuthAuthorization({ service: 'openrouter', scopes: [], redirectUri: 'http://localhost:32123/callback', fetch });
    const state = new URL(login.authorizationUrl).searchParams.get('state')!;
    const callback = new URL(`http://localhost:32123/callback?code=private&state=${state}`);
    if (problem === 'wrong-origin') callback.port = '32124';
    if (problem === 'wrong-path') callback.pathname = '/other';
    if (problem === 'missing-code') callback.searchParams.delete('code');
    if (problem === 'duplicate-state') callback.searchParams.append('state', state);
    if (problem === 'duplicate-code') callback.searchParams.append('code', 'other');
    if (problem === 'unicode-state') callback.searchParams.set('state', '中'.repeat(43));
    if (problem === 'provider-error') callback.searchParams.set('error', 'private-error');
    await expect(login.exchange(callback.href)).rejects.toMatchObject({ code: 'invalid_session' });
    expect(fetch).not.toHaveBeenCalled();
  });
it.each([
  null, [], { access_token: '', expires_in: 1 }, { access_token: 'private\r\nheader', expires_in: 1 },
  { access_token: 'private', expires_in: -1 }, { access_token: 'private', expires_in: '3600' },
  { access_token: 'private', expires_in: 1e308 }, { access_token: 'private', expires_in: 1, token_type: 'mac' },
])('rejects malformed token replies without returning credential material: %j', async reply => {
  const fetch = vi.fn(async () => Response.json(reply));
  const login = await beginOAuthAuthorization({ service: 'xai', clientId: 'own', scopes: [], redirectUri: 'http://localhost/callback', fetch });
  const state = new URL(login.authorizationUrl).searchParams.get('state');
  await expect(login.exchange(`http://localhost/callback?code=private-code&state=${state}`)).rejects.toMatchObject({ code: 'refresh_failed' });
});
it('closes a pending token exchange and never releases a late token', async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(async () => new Promise<Response>(done => { resolve = done; }));
  const login = await beginOAuthAuthorization({ service: 'openrouter', scopes: [], redirectUri: 'http://localhost/callback', fetch });
  const state = new URL(login.authorizationUrl).searchParams.get('state');
  const pending = login.exchange(`http://localhost/callback?code=private-code&state=${state}`);
  const checked = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  login.close();
  resolve(Response.json({ key: 'late-secret' }));
  await checked;
});
