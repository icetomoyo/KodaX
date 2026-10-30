import { afterEach, expect, it, vi } from 'vitest';
import { beginDeviceAuthorization } from './device.js';

afterEach(() => { vi.useRealTimers(); });
it('uses a larger server slow_down interval as the minimum subsequent polling delay', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => {
    if (fetch.mock.calls.length === 1) return Response.json({ device_code: 'private', user_code: 'PUBLIC', verification_uri: 'https://github.com/login/device', expires_in: 120, interval: 1 });
    if (fetch.mock.calls.length === 2) return Response.json({ error: 'slow_down', interval: 20 });
    return Response.json({ access_token: 'grant' });
  });
  const device = await beginDeviceAuthorization({ service: 'github-copilot', clientId: 'own', scopes: ['read:user'], fetch });
  const pending = device.poll(); await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(19_999); expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect((await pending).tokens.accessToken).toBe('grant');
});
it('polls a registered Kimi device grant with pending/slow_down and keeps device secrets private', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (fetch.mock.calls.length === 1) return Response.json({ device_code: 'private-device', user_code: 'PUBLIC-CODE', verification_uri: 'https://auth.kimi.com/activate', expires_in: 120, interval: 1 });
    if (fetch.mock.calls.length === 2) return Response.json({ error: 'authorization_pending' }, { status: 400 });
    if (fetch.mock.calls.length === 3) return Response.json({ error: 'slow_down' }, { status: 400 });
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer' });
  });
  const device = await beginDeviceAuthorization({ service: 'kimi-coding', clientId: 'host-registration', scopes: ['offline_access'], fetch });
  expect(device.userCode).toBe('PUBLIC-CODE');
  expect(JSON.stringify(device)).not.toContain('private-device');
  const pending = device.poll();
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5999);
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect((await pending).tokens).toMatchObject({ accessToken: 'access', refreshToken: 'refresh' });
  expect(fetch.mock.calls[0]?.[0]).toBe('https://auth.kimi.com/api/oauth/device_authorization');
  expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)))).toEqual({ client_id: 'host-registration' });
  expect(fetch.mock.calls[1]?.[0]).toBe('https://auth.kimi.com/api/oauth/token');
  expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[1]?.[1]?.body)))).toEqual({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'private-device', client_id: 'host-registration' });
});
it('returns the Meta identity access token for host validation without inventing its lifetime', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => fetch.mock.calls.length === 1
    ? Response.json({ device_code: 'private', user_code: 'META-CODE', verification_uri: 'https://auth.meta.com/activate', expires_in: 60, interval: 1 })
    : Response.json({ access_token: 'identity-access-token' }));
  const device = await beginDeviceAuthorization({ service: 'meta', clientId: 'host-registration', scopes: [], fetch });
  const pending = device.poll();
  await vi.advanceTimersByTimeAsync(1000);
  expect((await pending).tokens).toEqual({ accessToken: 'identity-access-token' });
});
it.each([
  ['github-copilot', 'https://github.com/login/device/code', 'https://github.com/login/oauth/access_token'],
  ['meta', 'https://auth.meta.com/oidc/device/authorization/', 'https://auth.meta.com/oidc/device/token/'],
  ['xai', 'https://auth.x.ai/oauth2/device/code', 'https://auth.x.ai/oauth2/token'],
  ['radius', 'https://radius.pi.dev/v1/oauth/device', 'https://radius.pi.dev/v1/oauth/token'],
] as const)('uses the %s device profile with the host client', async (service, deviceEndpoint, tokenEndpoint) => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => fetch.mock.calls.length === 1
    ? Response.json({ device_code: 'private-device', user_code: 'PUBLIC', verification_uri: 'https://auth.example/activate', verification_uri_complete: 'https://auth.example/activate?code=PUBLIC', expires_in: 60, interval: 1 })
    : Response.json({ access_token: 'grant', refresh_token: 'rotate', ...(service !== 'github-copilot' && service !== 'meta' ? { expires_in: 3600 } : {}), scope: 'read:user,user:email' }));
  const device = await beginDeviceAuthorization({ service, clientId: 'own-client', scopes: ['requested-scope'], fetch });
  expect(device.verificationUriComplete).toBe('https://auth.example/activate?code=PUBLIC');
  const pending = device.poll(); await vi.advanceTimersByTimeAsync(1000);
  const result = await pending;
  expect(result.tokens.accessToken).toBe('grant');
  if (service === 'github-copilot') expect(result.tokens.scopes).toEqual(['read:user', 'user:email']);
  expect(fetch.mock.calls[0]?.[0]).toBe(deviceEndpoint);
  expect(fetch.mock.calls[1]?.[0]).toBe(tokenEndpoint);
  expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body))))
    .toEqual(service === 'meta' ? { client_id: 'own-client' } : { client_id: 'own-client', scope: 'requested-scope' });
  await expect(device.poll()).rejects.toMatchObject({ code: 'invalid_session' });
});
it.each([
  { device_code: '', user_code: 'PUBLIC', verification_uri: 'https://auth.example', expires_in: 60 },
  { device_code: 'private', verification_uri: 'https://auth.example', expires_in: 60 },
  { device_code: 'private', user_code: 'PUBLIC', verification_uri: 'https://auth.example', expires_in: -1 },
  { device_code: 'private', user_code: 'PUBLIC', verification_uri: 'https://auth.example', expires_in: 60, interval: 0 },
  { device_code: 'private', user_code: 'PUBLIC', verification_uri: 'http://remote.example', expires_in: 60 },
])('rejects invalid device authorization metadata: %j', async reply => {
  const fetch = vi.fn(async () => Response.json(reply));
  await expect(beginDeviceAuthorization({ service: 'xai', clientId: 'own', scopes: [], fetch })).rejects.toThrow(/OAuth credential/);
});
it.each(['access_denied', 'authorization_denied', 'expired_token', 'unknown-private-error'])('ends polling on %s without exposing upstream error text', async error => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => fetch.mock.calls.length === 1
    ? Response.json({ device_code: 'private', user_code: 'PUBLIC', verification_uri: 'https://auth.example', expires_in: 60, interval: 1 })
    : Response.json({ error, error_description: 'private-error' }, { status: 400 }));
  const device = await beginDeviceAuthorization({ service: 'xai', clientId: 'own', scopes: [], fetch });
  const checked = expect(device.poll()).rejects.toMatchObject({ code: 'reauthentication_required' });
  await vi.advanceTimersByTimeAsync(1000); await checked;
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('expires before a slow first interval without sending an already-expired device code', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => Response.json({ device_code: 'private', user_code: 'PUBLIC', verification_uri: 'https://auth.example', expires_in: 1 }));
  const device = await beginDeviceAuthorization({ service: 'xai', clientId: 'own', scopes: [], fetch });
  const checked = expect(device.poll()).rejects.toMatchObject({ code: 'reauthentication_required' });
  await vi.advanceTimersByTimeAsync(1000); await checked;
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('cancels the wait and does not poll after the host closes authorization', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => Response.json({ device_code: 'private', user_code: 'PUBLIC', verification_uri: 'https://auth.example', expires_in: 60 }));
  const device = await beginDeviceAuthorization({ service: 'xai', clientId: 'own', scopes: [], fetch });
  const checked = expect(device.poll()).rejects.toMatchObject({ name: 'AbortError' });
  device.close(); await checked; await vi.advanceTimersByTimeAsync(60_000);
  expect(fetch).toHaveBeenCalledTimes(1);
});
