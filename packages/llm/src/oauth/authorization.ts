import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuthCredentialError, type OAuthService, type OAuthTokens } from './session.js';
import { getOAuthEndpoints, parseOAuthUrl, requireOAuthEndpoint, type OAuthEndpoints } from './endpoints.js';

export interface OAuthLoginResult { readonly tokens: OAuthTokens; readonly idToken?: string }
export interface OAuthAuthorization {
  readonly authorizationUrl: string; readonly nonce: string;
  /** Tokens are not a validated identity. Trusted Host must verify identity before committing a session. */
  exchange(callbackUrl: string, signal?: AbortSignal): Promise<OAuthLoginResult>;
  close(): void;
}
export interface OAuthLoginInput {
  service: OAuthService; clientId?: string; redirectUri: string; scopes: readonly string[]; issuer?: string;
  fetch?: typeof fetch; signal?: AbortSignal;
}
export async function oauthJson(fetcher: typeof fetch, url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error' });
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OAuthCredentialError('refresh_failed');
    return { status: response.status, body: value as Record<string, unknown> };
  } catch (error) { if (init.signal?.aborted) throw new DOMException('OAuth authorization aborted.', 'AbortError'); throw error instanceof OAuthCredentialError ? error : new OAuthCredentialError('refresh_failed'); }
}
export function loginTokens(body: Record<string, unknown>, service: OAuthService): OAuthLoginResult {
  const token = service === 'openrouter' ? body.key : body.access_token;
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)
    || (body.token_type !== undefined && String(body.token_type).toLowerCase() !== 'bearer')) throw new OAuthCredentialError('refresh_failed');
  const seconds = body.expires_in;
  if (service !== 'openrouter' && service !== 'meta' && service !== 'github-copilot' && (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)) throw new OAuthCredentialError('refresh_failed');
  const expiresAt = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : undefined;
  if (expiresAt !== undefined && !Number.isFinite(expiresAt)) throw new OAuthCredentialError('refresh_failed');
  if (service === 'kimi-coding' && (typeof body.refresh_token !== 'string' || !body.refresh_token)) throw new OAuthCredentialError('refresh_failed');
  return { tokens: { accessToken: token, ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(typeof body.refresh_token === 'string' && body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.scope === 'string' ? { scopes: body.scope.split(service === 'github-copilot' ? /[,\s]+/ : /\s+/).filter(Boolean) } : {}) },
    ...(typeof body.id_token === 'string' ? { idToken: body.id_token } : {}) };
}
async function authorizationEndpoints(input: OAuthLoginInput, fetcher: typeof fetch): Promise<OAuthEndpoints & { authorization: string }> {
  const endpoints = getOAuthEndpoints(input.service, input.issuer);
  if (endpoints.discovery) {
    const discovery = await oauthJson(fetcher, endpoints.discovery, { signal: input.signal });
    const value = input.service === 'radius' ? discovery.body.authorizationEndpoint : discovery.body.authorization_endpoint;
    if (discovery.status !== 200 || typeof value !== 'string') throw new OAuthCredentialError('invalid_session');
    const authorization = requireOAuthEndpoint(value);
    if (input.service !== 'radius' && authorization.origin !== new URL(endpoints.token).origin) throw new OAuthCredentialError('invalid_session');
    return { ...endpoints, authorization: authorization.href };
  }
  if (!endpoints.authorization) throw new OAuthCredentialError('invalid_session');
  return { ...endpoints, authorization: endpoints.authorization };
}
/** Host-owned registered clients only. The library never borrows another application's identity. */
export async function beginOAuthAuthorization(input: OAuthLoginInput): Promise<OAuthAuthorization> {
  input = { ...input, scopes: [...input.scopes] };
  input.signal?.throwIfAborted();
  const redirect = parseOAuthUrl(input.redirectUri);
  if (redirect.username || redirect.password || redirect.search || redirect.hash || (redirect.protocol !== 'https:'
    && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)))) throw new OAuthCredentialError('invalid_session');
  if (input.service !== 'openrouter' && !input.clientId?.trim()) throw new OAuthCredentialError('invalid_session');
  const fetcher: typeof fetch = (...args) => (input.fetch ?? globalThis.fetch)(...args);
  const endpoints = await authorizationEndpoints(input, fetcher);
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const url = new URL(endpoints.authorization);
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256'); url.searchParams.set('state', state);
  url.searchParams.set(input.service === 'openrouter' ? 'callback_url' : 'redirect_uri', redirect.href);
  if (input.clientId) url.searchParams.set('client_id', input.clientId);
  if (input.service !== 'openrouter') url.searchParams.set('response_type', 'code');
  if (input.scopes.length) url.searchParams.set('scope', input.scopes.join(' '));
  if (input.scopes.includes('openid')) url.searchParams.set('nonce', nonce);
  if (endpoints.audience) url.searchParams.set('resource', endpoints.audience);
  let used = false;
  const controller = new AbortController();
  return { authorizationUrl: url.href, nonce, close() { used = true; controller.abort(); }, async exchange(callbackUrl, signal) {
    const active = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : []), ...(signal ? [signal] : [])]);
    active.throwIfAborted();
    if (used) throw new OAuthCredentialError('invalid_session');
    const callback = parseOAuthUrl(callbackUrl);
    const received = callback.searchParams.get('state') ?? '';
    const validState = /^[A-Za-z0-9_-]{43}$/.test(received) && timingSafeEqual(Buffer.from(received), Buffer.from(state));
    if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || !validState || callback.searchParams.getAll('state').length !== 1
      || callback.searchParams.getAll('code').length !== 1 || callback.searchParams.has('error') || !callback.searchParams.get('code')) throw new OAuthCredentialError('invalid_session');
    used = true;
    const code = callback.searchParams.get('code')!;
    const fields: Record<string, string> = input.service === 'openrouter' ? { code, code_verifier: verifier, code_challenge_method: 'S256' }
      : { grant_type: 'authorization_code', client_id: input.clientId!, code, code_verifier: verifier, redirect_uri: redirect.href,
        ...(input.service === 'anthropic' ? { state } : {}), ...(endpoints.audience ? { resource: endpoints.audience } : {}) };
    const json = endpoints.jsonToken === true;
    const result = await oauthJson(fetcher, endpoints.token, { method: 'POST', signal: active,
      headers: { accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(fields) : new URLSearchParams(fields) });
    if (result.status < 200 || result.status >= 300 || result.body.error) throw new OAuthCredentialError('reauthentication_required');
    active.throwIfAborted();
    return loginTokens(result.body, input.service);
  } };
}
