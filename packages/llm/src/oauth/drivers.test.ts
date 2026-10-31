import { describe, expect, it, vi } from 'vitest';
import { createOAuthRefreshDriver } from './drivers.js';
import type { OAuthSessionRecord } from './session.js';

const registration: OAuthSessionRecord = { id: 'id', service: 'openai-chatgpt', clientId: 'issued-to-this-host', accountId: 'verified-sub',
  credentials: { accessToken: 'old', refreshToken: 'rotate', expiresAt: 1 } };
it.each([
  ['anthropic', 'https://platform.claude.com/v1/oauth/token'], ['kimi-coding', 'https://auth.kimi.com/api/oauth/token'],
  ['xai', 'https://auth.x.ai/oauth2/token'], ['radius', 'https://radius.pi.dev/v1/oauth/token'],
] as const)('refreshes %s through its own issuer using the host registration', async (service, endpoint) => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ access_token: 'new', expires_in: 3600, token_type: 'bearer' }));
  const result = await createOAuthRefreshDriver(service, { fetch }).refresh({ ...registration, service }, new AbortController().signal);
  expect(fetch.mock.calls[0]?.[0]).toBe(endpoint);
  const wire = String(fetch.mock.calls[0]?.[1]?.body);
  const body = service === 'anthropic' ? JSON.parse(wire) : Object.fromEntries(new URLSearchParams(wire));
  expect(body).toEqual({ grant_type: 'refresh_token', client_id: 'issued-to-this-host', refresh_token: 'rotate' });
  expect(result).toMatchObject({ accessToken: 'new', refreshToken: 'rotate' });
});
it('mints a Meta resource API key using the identity bearer and no guessed expiry', async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ api_key: 'minted-resource' }));
  const driver = createOAuthRefreshDriver('meta', { fetch });
  const result = await driver.exchangeResource!({ ...registration, service: 'meta' }, new AbortController().signal);
  expect(fetch.mock.calls[0]?.[0]).toBe('https://api.meta.ai/muse-code/key');
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer old');
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({});
  expect(result).toEqual({ accessToken: 'minted-resource' });
});
it('revokes xAI through its discovered standard endpoint with the host client', async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }));
  await createOAuthRefreshDriver('xai', { fetch }).revoke!({ ...registration, service: 'xai' }, new AbortController().signal);
  expect(fetch.mock.calls[0]?.[0]).toBe('https://auth.x.ai/oauth2/revoke');
  expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)))).toEqual({ token: 'rotate', token_type_hint: 'refresh_token', client_id: 'issued-to-this-host' });
});
describe('OAuth refresh wire protocols', () => {
  it('refreshes SIWC using its issued client, resource and rotating tokens without a scope parameter', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ access_token: 'new', refresh_token: 'next', expires_in: 3600,
      scope: 'openid resource.invoke chatgpt.tokens.use.direct', earliest_refresh_at: 2_000_000_000 }));
    const driver = createOAuthRefreshDriver('openai-chatgpt', { fetch });
    const result = await driver.refresh(registration, new AbortController().signal);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://auth.openai.com/api/accounts/oauth/token');
    const params = new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body));
    expect(Object.fromEntries(params)).toEqual({ grant_type: 'refresh_token', client_id: 'issued-to-this-host', refresh_token: 'rotate', resource: 'https://api.openai.com/v1' });
    expect(result).toMatchObject({ accessToken: 'new', refreshToken: 'next', earliestRefreshAt: 2_000_000_000_000 });
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
  });
  it.each([
    ['openai-codex', 'https://auth.openai.com/oauth/token'],
    ['github-copilot', 'https://github.com/login/oauth/access_token'],
  ] as const)('uses the separate %s token endpoint', async (service, endpoint) => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ access_token: 'new', expires_in: 3600, token_type: 'bearer' }));
    const result = await createOAuthRefreshDriver(service, { fetch }).refresh({ ...registration, service }, new AbortController().signal);
    expect(fetch.mock.calls[0]?.[0]).toBe(endpoint);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('error');
    expect(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).has('resource')).toBe(false);
    expect(result.refreshToken).toBe('rotate');
  });
  it('exchanges the GitHub grant for a separately expiring Copilot bearer token', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ token: 'copilot-api', expires_at: Math.floor(Date.now() / 1000) + 1800 }));
    const driver = createOAuthRefreshDriver('github-copilot', { fetch });
    const tokens = await driver.exchangeResource!({ ...registration, service: 'github-copilot' }, new AbortController().signal);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.github.com/copilot_internal/v2/token');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('token old');
    expect(tokens.accessToken).toBe('copilot-api');
    expect(driver.revoke).toBeUndefined(); // GitHub public clients cannot revoke using an app secret they do not possess.
  });
  it.each([
    { access_token: 'new', refresh_token: 'next', expires_in: -1 },
    { access_token: 'new', refresh_token: 'next', expires_in: 3600, token_type: 'other' },
    { access_token: 'new', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' },
  ])('rejects invalid refresh responses without exposing token material', async body => {
    const fetch = vi.fn(async () => Response.json(body));
    await expect(createOAuthRefreshDriver('openai-chatgpt', { fetch }).refresh(registration, new AbortController().signal))
      .rejects.toMatchObject({ code: 'refresh_failed', message: 'OAuth credential refresh failed.' });
  });
  it.each([true, false])('reports reauthentication for invalid_grant or missing required grant: invalid_grant=%s', async invalid => {
    const fetch = vi.fn(async () => invalid ? Response.json({ error: 'invalid_grant', error_description: 'private-refresh-token' }, { status: 400 })
      : Response.json({ access_token: 'new', refresh_token: 'next', expires_in: 3600, scope: 'openid' }));
    await expect(createOAuthRefreshDriver('openai-chatgpt', { fetch }).refresh(registration, new AbortController().signal))
      .rejects.toMatchObject({ code: 'reauthentication_required' });
  });
  it('accepts an empty successful revocation response from the trusted discovery endpoint', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).includes('.well-known')
      ? Response.json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' }) : new Response(null, { status: 200 }));
    await createOAuthRefreshDriver('openai-chatgpt', { fetch }).revoke!(registration, new AbortController().signal);
    expect(fetch.mock.calls[1]?.[0]).toBe('https://auth.openai.com/oauth/revoke');
    expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[1]?.[1]?.body)))).toEqual({ token: 'rotate', token_type_hint: 'refresh_token', client_id: 'issued-to-this-host' });
  });
  it('rejects discovery redirects to another origin before sending secrets', async () => {
    const fetch = vi.fn(async () => Response.json({ revocation_endpoint: 'https://untrusted.test/revoke' }));
    await expect(createOAuthRefreshDriver('openai-chatgpt', { fetch }).revoke!(registration, new AbortController().signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('sanitizes transport exceptions and never refreshes a mismatched registration', async () => {
    const fetch = vi.fn(async () => { throw new Error('private-access-and-refresh'); });
    const driver = createOAuthRefreshDriver('openai-chatgpt', { fetch });
    await expect(driver.refresh(registration, new AbortController().signal)).rejects.toMatchObject({ code: 'refresh_failed', message: 'OAuth credential refresh failed.' });
    await expect(driver.refresh({ ...registration, service: 'openai-codex' }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_session' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('sanitizes a revocation transport failure even when the low-level driver is used directly', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('.well-known')) return Response.json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
      throw new Error('private-refresh-token');
    });
    await expect(createOAuthRefreshDriver('openai-chatgpt', { fetch }).revoke!(registration, new AbortController().signal))
      .rejects.toMatchObject({ message: 'OAuth credential refresh failed.' });
  });
});
