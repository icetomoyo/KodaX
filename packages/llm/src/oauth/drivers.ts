import { getOAuthEndpoints } from './endpoints.js';
import { OAuthCredentialError, type OAuthRefreshDriver, type OAuthService, type OAuthSessionRecord, type OAuthTokens } from './session.js';

type Json = Record<string, unknown>;
async function requestJson(fetcher: typeof fetch, url: string, init: RequestInit, reauthStatuses: readonly number[] = [401]): Promise<Json> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error' });
    const value: unknown = await response.json();
    const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
    if (body.error === 'invalid_grant' || reauthStatuses.includes(response.status)) throw new OAuthCredentialError('reauthentication_required');
    if (!response.ok || body.error) throw new OAuthCredentialError('refresh_failed');
    return body;
  } catch (error) {
    throw error instanceof OAuthCredentialError ? error : new OAuthCredentialError('refresh_failed');
  }
}
function parseTokens(body: Json, previous: OAuthTokens, service: OAuthService): OAuthTokens {
  if (typeof body.access_token !== 'string' || !body.access_token || typeof body.expires_in !== 'number'
    || !Number.isFinite(body.expires_in) || body.expires_in <= 0
    || (body.token_type !== undefined && String(body.token_type).toLowerCase() !== 'bearer')) {
    throw new OAuthCredentialError('refresh_failed');
  }
  const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : previous.scopes;
  if (service === 'openai-chatgpt' && !scopes?.includes('chatgpt.tokens.use.direct')) throw new OAuthCredentialError('reauthentication_required');
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : previous.refreshToken;
  if (service === 'openai-chatgpt' && (!body.refresh_token || !refreshToken)) throw new OAuthCredentialError('refresh_failed');
  return { accessToken: body.access_token, refreshToken, expiresAt: Date.now() + body.expires_in * 1000, scopes,
    ...(typeof body.earliest_refresh_at === 'number' && Number.isFinite(body.earliest_refresh_at)
      ? { earliestRefreshAt: body.earliest_refresh_at * 1000 } : {}) };
}

/** Uses the host's own OAuth client/registration; never borrows another application's client ID. */
export function createOAuthRefreshDriver(service: OAuthService, options: { fetch?: typeof fetch } = {}): OAuthRefreshDriver {
  const fetcher: typeof fetch = (...args) => (options.fetch ?? globalThis.fetch)(...args);
  const requireRecord = (record: OAuthSessionRecord) => {
    if (record.service !== service || !record.clientId || !record.credentials) throw new OAuthCredentialError('invalid_session');
    return record.credentials;
  };
  return {
    async refresh(record, signal) {
      const previous = requireRecord(record);
      if (service === 'openrouter' || service === 'meta') throw new OAuthCredentialError('reauthentication_required');
      if (!previous.refreshToken) throw new OAuthCredentialError('reauthentication_required');
      const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: record.clientId, refresh_token: previous.refreshToken });
      const endpoints = getOAuthEndpoints(service, record.issuer);
      if (endpoints.audience) body.set('resource', endpoints.audience);
      const url = endpoints.token;
      const json = endpoints.jsonToken === true;
      return parseTokens(await requestJson(fetcher, url, { method: 'POST', headers: { accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) },
        body: json ? JSON.stringify(Object.fromEntries(body)) : body, signal }), previous, service);
    },
    ...(service === 'github-copilot' ? {
      async exchangeResource(record: OAuthSessionRecord, signal: AbortSignal): Promise<OAuthTokens> {
        const tokens = requireRecord(record);
        const body = await requestJson(fetcher, getOAuthEndpoints(service).resourceExchange!, {
          headers: { authorization: `token ${tokens.accessToken}`, accept: 'application/json', 'user-agent': 'KodaX' }, signal,
        });
        if (typeof body.token !== 'string' || !body.token || typeof body.expires_at !== 'number'
          || !Number.isFinite(body.expires_at) || body.expires_at * 1000 <= Date.now()) throw new OAuthCredentialError('refresh_failed');
        return { accessToken: body.token, expiresAt: body.expires_at * 1000 };
      },
    } : service === 'meta' ? {
      async exchangeResource(record: OAuthSessionRecord, signal: AbortSignal): Promise<OAuthTokens> {
        const identity = requireRecord(record);
        const body = await requestJson(fetcher, getOAuthEndpoints(service).resourceExchange!, { method: 'POST', signal,
          headers: { authorization: `Bearer ${identity.accessToken}`, 'x-api-version': '1.0.0', 'content-type': 'application/json' }, body: '{}' }, [401, 403]);
        if (typeof body.api_key !== 'string' || !body.api_key.trim() || /[\r\n]/.test(body.api_key)) throw new OAuthCredentialError('refresh_failed');
        // The endpoint does not document an expiry: use once and re-mint next request.
        return { accessToken: body.api_key };
      },
    } : service === 'openai-chatgpt' || service === 'openai-codex' || service === 'xai' ? {
      async revoke(record: OAuthSessionRecord, signal: AbortSignal): Promise<void> {
        try {
          const tokens = requireRecord(record);
          const token = tokens.refreshToken ?? (service === 'xai' ? tokens.accessToken : undefined);
          if (!token) throw new OAuthCredentialError('reauthentication_required');
          const profile = getOAuthEndpoints(service);
          const discovery = profile.revocation ? { revocation_endpoint: profile.revocation }
            : await requestJson(fetcher, profile.discovery!, { signal });
          if (typeof discovery.revocation_endpoint !== 'string') throw new OAuthCredentialError('refresh_failed');
          const endpoint = new URL(discovery.revocation_endpoint);
          if (endpoint.origin !== new URL(profile.token).origin || endpoint.username || endpoint.password || endpoint.hash) throw new OAuthCredentialError('refresh_failed');
          const response = await fetcher(endpoint.href, { method: 'POST', redirect: 'error', signal,
            body: new URLSearchParams({ token, token_type_hint: tokens.refreshToken ? 'refresh_token' : 'access_token', client_id: record.clientId }) });
          if (!response.ok) throw new OAuthCredentialError('refresh_failed');
        } catch (error) {
          throw error instanceof OAuthCredentialError ? error : new OAuthCredentialError('refresh_failed');
        }
      },
    } : {}),
  };
}
