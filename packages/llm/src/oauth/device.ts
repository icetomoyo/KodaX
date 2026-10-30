import { OAuthCredentialError } from './session.js';
import { loginTokens, oauthJson, type OAuthLoginInput, type OAuthLoginResult } from './authorization.js';
import { getOAuthEndpoints, requireOAuthEndpoint } from './endpoints.js';

export interface OAuthDeviceAuthorization {
  readonly userCode: string; readonly verificationUri: string; readonly verificationUriComplete?: string; readonly expiresAt: number;
  poll(signal?: AbortSignal): Promise<OAuthLoginResult>;
  close(): void;
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('OAuth device authorization aborted.', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** RFC 8628 polling; the registered host owns consent UI, identity validation and secure commit. */
export async function beginDeviceAuthorization(input: Omit<OAuthLoginInput, 'redirectUri'>): Promise<OAuthDeviceAuthorization> {
  input = { ...input, scopes: [...input.scopes] };
  input.signal?.throwIfAborted();
  if (!input.clientId?.trim()) throw new OAuthCredentialError('invalid_session');
  const endpoints = getOAuthEndpoints(input.service, input.issuer);
  if (!endpoints.device) throw new OAuthCredentialError('invalid_session');
  const fetcher: typeof fetch = (...args) => (input.fetch ?? globalThis.fetch)(...args);
  const fields = new URLSearchParams({ client_id: input.clientId });
  if (input.scopes.length && input.service !== 'kimi-coding' && input.service !== 'meta') fields.set('scope', input.scopes.join(' '));
  const start = await oauthJson(fetcher, endpoints.device, { method: 'POST', body: fields, signal: input.signal, headers: { accept: 'application/json' } });
  const body = start.body;
  if (start.status < 200 || start.status >= 300 || body.error || typeof body.device_code !== 'string' || !body.device_code
    || typeof body.user_code !== 'string' || !body.user_code || typeof body.verification_uri !== 'string'
    || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0
    || (body.interval !== undefined && (typeof body.interval !== 'number' || !Number.isFinite(body.interval) || body.interval <= 0))) throw new OAuthCredentialError('refresh_failed');
  const deviceCode = body.device_code;
  const expiresAt = Date.now() + body.expires_in * 1000;
  if (!Number.isFinite(expiresAt)) throw new OAuthCredentialError('refresh_failed');
  let interval = typeof body.interval === 'number' ? body.interval * 1000 : 5000;
  const controller = new AbortController();
  let used = false;
  return { userCode: body.user_code, verificationUri: requireOAuthEndpoint(body.verification_uri).href,
    ...(typeof body.verification_uri_complete === 'string' ? { verificationUriComplete: requireOAuthEndpoint(body.verification_uri_complete).href } : {}), expiresAt,
    close() { used = true; controller.abort(); }, async poll(signal) {
      if (used) throw new OAuthCredentialError('invalid_session');
      used = true;
      const active = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(input.signal ? [input.signal] : [])]);
      while (Date.now() < expiresAt) {
        await wait(Math.min(interval, expiresAt - Date.now()), active);
        if (Date.now() >= expiresAt) break;
        const result = await oauthJson(fetcher, endpoints.token, { method: 'POST', signal: active, headers: { accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: input.clientId!, device_code: deviceCode }) });
        active.throwIfAborted();
        if (result.body.error === 'authorization_pending') continue;
        if (result.body.error === 'slow_down') {
          const requested = result.body.interval;
          if (requested !== undefined && (typeof requested !== 'number' || !Number.isFinite(requested * 1000) || requested <= 0)) throw new OAuthCredentialError('refresh_failed');
          interval = Math.max(interval + 5000, typeof requested === 'number' ? requested * 1000 : 0);
          continue;
        }
        if (result.status < 200 || result.status >= 300 || result.body.error) throw new OAuthCredentialError('reauthentication_required');
        return loginTokens(result.body, input.service);
      }
      throw new OAuthCredentialError('reauthentication_required');
    } };
}
