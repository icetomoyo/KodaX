import { OAuthCredentialError, type OAuthRefreshDriver, type OAuthService, type OAuthSessionRecord, type OAuthTokens } from './session.js';

type Json = Record<string, unknown>;
async function requestJson(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Json> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error' });
    const value: unknown = await response.json();
    const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
    if (body.error === 'invalid_grant' || response.status === 401) throw new OAuthCredentialError('reauthentication_required');
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
      if (!previous.refreshToken) throw new OAuthCredentialError('reauthentication_required');
      const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: record.clientId, refresh_token: previous.refreshToken });
      if (service === 'openai-chatgpt') body.set('resource', 'https://api.openai.com/v1');
      const url = service === 'github-copilot' ? 'https://github.com/login/oauth/access_token'
        : service === 'openai-chatgpt' ? 'https://auth.openai.com/api/accounts/oauth/token' : 'https://auth.openai.com/oauth/token';
      return parseTokens(await requestJson(fetcher, url, { method: 'POST', headers: { accept: 'application/json' }, body, signal }), previous, service);
    },
    ...(service === 'github-copilot' ? {
      async exchangeResource(record: OAuthSessionRecord, signal: AbortSignal): Promise<OAuthTokens> {
        const tokens = requireRecord(record);
        const body = await requestJson(fetcher, 'https://api.github.com/copilot_internal/v2/token', {
          headers: { authorization: `token ${tokens.accessToken}`, accept: 'application/json', 'user-agent': 'KodaX' }, signal,
        });
        if (typeof body.token !== 'string' || !body.token || typeof body.expires_at !== 'number'
          || !Number.isFinite(body.expires_at) || body.expires_at * 1000 <= Date.now()) throw new OAuthCredentialError('refresh_failed');
        return { accessToken: body.token, expiresAt: body.expires_at * 1000 };
      },
    } : {
      async revoke(record: OAuthSessionRecord, signal: AbortSignal): Promise<void> {
        try {
          const tokens = requireRecord(record);
          if (!tokens.refreshToken) throw new OAuthCredentialError('reauthentication_required');
          const discovery = await requestJson(fetcher, 'https://auth.openai.com/.well-known/openid-configuration', { signal });
          if (typeof discovery.revocation_endpoint !== 'string') throw new OAuthCredentialError('refresh_failed');
          const endpoint = new URL(discovery.revocation_endpoint);
          if (endpoint.origin !== 'https://auth.openai.com' || endpoint.username || endpoint.password || endpoint.hash) throw new OAuthCredentialError('refresh_failed');
          const response = await fetcher(endpoint.href, { method: 'POST', redirect: 'error', signal,
            body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: 'refresh_token', client_id: record.clientId }) });
          if (!response.ok) throw new OAuthCredentialError('refresh_failed');
        } catch (error) {
          throw error instanceof OAuthCredentialError ? error : new OAuthCredentialError('refresh_failed');
        }
      },
    }),
  };
}
