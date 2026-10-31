import { OAuthCredentialError, type OAuthService } from './session.js';

export interface OAuthEndpoints {
  readonly token: string; readonly authorization?: string; readonly discovery?: string; readonly device?: string;
  readonly resourceExchange?: string; readonly revocation?: string; readonly audience?: string; readonly jsonToken?: boolean;
}
const ENDPOINTS: Readonly<Record<Exclude<OAuthService, 'radius'>, OAuthEndpoints>> = {
  'openai-chatgpt': { discovery: 'https://auth.openai.com/.well-known/openid-configuration', token: 'https://auth.openai.com/api/accounts/oauth/token', audience: 'https://api.openai.com/v1' },
  'openai-codex': { discovery: 'https://auth.openai.com/.well-known/openid-configuration', token: 'https://auth.openai.com/oauth/token' },
  'github-copilot': { device: 'https://github.com/login/device/code', token: 'https://github.com/login/oauth/access_token', resourceExchange: 'https://api.github.com/copilot_internal/v2/token' },
  anthropic: { authorization: 'https://claude.ai/oauth/authorize', token: 'https://platform.claude.com/v1/oauth/token', jsonToken: true },
  openrouter: { authorization: 'https://openrouter.ai/auth', token: 'https://openrouter.ai/api/v1/auth/keys', jsonToken: true },
  'kimi-coding': { device: 'https://auth.kimi.com/api/oauth/device_authorization', token: 'https://auth.kimi.com/api/oauth/token' },
  meta: { device: 'https://auth.meta.com/oidc/device/authorization/', token: 'https://auth.meta.com/oidc/device/token/', resourceExchange: 'https://api.meta.ai/muse-code/key' },
  xai: { authorization: 'https://auth.x.ai/oauth2/authorize', device: 'https://auth.x.ai/oauth2/device/code', token: 'https://auth.x.ai/oauth2/token', revocation: 'https://auth.x.ai/oauth2/revoke' },
};
export function parseOAuthUrl(value: string): URL {
  try { return new URL(value); } catch { throw new OAuthCredentialError('invalid_session'); }
}
export function requireOAuthEndpoint(value: string): URL {
  const url = parseOAuthUrl(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new OAuthCredentialError('invalid_session');
  return url;
}
export function getOAuthEndpoints(service: OAuthService, issuer?: string): OAuthEndpoints {
  if (service === 'radius') {
    const url = requireOAuthEndpoint(issuer ?? 'https://radius.pi.dev');
    if (url.search) throw new OAuthCredentialError('invalid_session');
    const base = url.href.replace(/\/$/, '');
    return { discovery: `${base}/v1/oauth`, token: `${base}/v1/oauth/token`, device: `${base}/v1/oauth/device` };
  }
  if (!Object.hasOwn(ENDPOINTS, service)) throw new OAuthCredentialError('invalid_session');
  return ENDPOINTS[service];
}
