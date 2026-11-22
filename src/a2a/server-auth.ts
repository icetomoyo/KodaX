import { createPublicKey, type JsonWebKey } from 'node:crypto';

import * as oauth from 'oauth4webapi';

import type { A2AOAuth2JwtAuthenticationConfig } from './config.js';
import { A2AError } from './errors.js';
import { decodeUtf8, safeA2AFetch } from './safe-fetch.js';
import {
  isExactOAuthLoopbackHostname,
  parseOAuthEndpointUrl,
  parseOAuthIssuerIdentifier,
  parseOAuthScopeList,
  parseOAuthScopeValue,
  requireNonEmptyString,
} from './security.js';
import type { A2AAuthentication, A2ANetworkPolicy } from './types.js';

const JWT_SIGNING_ALGORITHMS = [
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
];

class OAuthJwksUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'OAuthJwksUnavailableError';
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPublicJwk(value: Readonly<Record<string, unknown>>): void {
  for (const field of ['kid', 'alg', 'use'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new OAuthJwksUnavailableError(`OAuth JWKS key field ${field} must be a string.`);
    }
  }
  if (value.key_ops !== undefined
    && (!Array.isArray(value.key_ops) || !value.key_ops.every((operation) => typeof operation === 'string'))) {
    throw new OAuthJwksUnavailableError('OAuth JWKS key_ops must be an array of strings.');
  }
  if (typeof value.kty !== 'string' || value.kty.length === 0) {
    throw new OAuthJwksUnavailableError('OAuth JWKS key kty must be a non-empty string.');
  }
  if (!['RSA', 'EC', 'OKP'].includes(value.kty)) return;
  try {
    createPublicKey({ key: value as JsonWebKey, format: 'jwk' });
  } catch (cause) {
    throw new OAuthJwksUnavailableError('OAuth JWKS endpoint returned an invalid public key.', cause);
  }
}

/** Checks a JWKS endpoint's answer and returns its keys. The v2 Host's token check reads keys through it too. */
export function readJwksResponse(response: Response, body: Uint8Array): readonly Readonly<Record<string, unknown>>[] {
  if (response.status !== 200) {
    throw new OAuthJwksUnavailableError('OAuth JWKS endpoint returned an unexpected status.');
  }
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json' && mediaType !== 'application/jwk-set+json') {
    throw new OAuthJwksUnavailableError('OAuth JWKS endpoint returned an unsupported media type.');
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(body)) as unknown;
  } catch (cause) {
    throw new OAuthJwksUnavailableError('OAuth JWKS endpoint returned malformed JSON.', cause);
  }
  if (!isRecord(value) || !Array.isArray(value.keys) || !value.keys.every(isRecord)) {
    throw new OAuthJwksUnavailableError('OAuth JWKS endpoint returned an invalid key set.');
  }
  for (const key of value.keys) assertPublicJwk(key);
  return value.keys;
}

function isJwksUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current instanceof OAuthJwksUnavailableError) return true;
    seen.add(current);
    if (typeof current !== 'object' || !('cause' in current)) return false;
    current = current.cause;
  }
  return false;
}

function jwksNetworkPolicy(url: URL): A2ANetworkPolicy {
  return {
    allowedOrigins: [url.origin],
    allowPrivateAddresses: isExactOAuthLoopbackHostname(url.hostname),
    requestTimeoutMs: 10_000,
    maxResponseBytes: 1_048_576,
    maxRedirects: 0,
  };
}

function boundedOAuthFetch(
  policy: A2ANetworkPolicy,
  fetchImpl?: typeof globalThis.fetch,
): (url: string, options: RequestInit) => Promise<Response> {
  return async (url, options) => {
    try {
      const result = await safeA2AFetch(new URL(url), {
        ...options,
        redirect: 'manual',
      }, policy, fetchImpl);
      readJwksResponse(result.response, result.body);
      return new Response(result.body, {
        status: result.response.status,
        statusText: result.response.statusText,
        headers: result.response.headers,
      });
    } catch (error) {
      if (error instanceof OAuthJwksUnavailableError) throw error;
      throw new OAuthJwksUnavailableError('OAuth JWKS endpoint is unavailable.', error);
    }
  };
}

function scopesFromClaim(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (typeof value !== 'string') throw new Error('OAuth access-token scope claim must be a string.');
  return parseOAuthScopeValue(value, 'OAuth access-token scope claim');
}

export function createOAuth2JwtA2AAuthentication(
  config: A2AOAuth2JwtAuthenticationConfig,
  fetchImpl?: typeof globalThis.fetch,
): A2AAuthentication {
  if (config.type !== 'oauth2-jwt') throw new Error('A2A authentication.type must be oauth2-jwt.');
  const scheme = requireNonEmptyString(config.scheme, 'A2A authentication.scheme');
  const audience = requireNonEmptyString(config.audience, 'A2A authentication.audience');
  const requiredScopes = parseOAuthScopeList(
    config.requiredScopes,
    'A2A authentication.requiredScopes',
  );
  const issuer = parseOAuthIssuerIdentifier(config.issuer, 'OAuth issuer');
  const jwksUrl = parseOAuthEndpointUrl(config.jwksUrl, 'OAuth JWKS endpoint');
  const tokenUrl = parseOAuthEndpointUrl(config.tokenUrl, 'OAuth token endpoint');
  const metadataUrl = config.metadataUrl === undefined
    ? undefined
    : parseOAuthEndpointUrl(config.metadataUrl, 'OAuth metadata endpoint');
  const authorizationServer: oauth.AuthorizationServer = {
    issuer,
    jwks_uri: jwksUrl.href,
  };
  const cache: oauth.JWKSCacheInput = {};
  const customFetch = boundedOAuthFetch(jwksNetworkPolicy(jwksUrl), fetchImpl);
  const scopeDescriptions = Object.fromEntries(requiredScopes.map((scope) => [
    scope,
    'Required to invoke this Agent.',
  ]));

  return {
    securityRealm: `oauth2-jwt:${issuer}`,
    securitySchemes: {
      [scheme]: {
        oauth2SecurityScheme: {
          flows: {
            clientCredentials: {
              tokenUrl: tokenUrl.href,
              scopes: scopeDescriptions,
            },
          },
          ...(metadataUrl ? { oauth2MetadataUrl: metadataUrl.href } : {}),
        },
      },
    },
    securityRequirements: [{
      schemes: { [scheme]: { list: requiredScopes } },
    }],
    async authenticate(request) {
      const authorization = request.headers.get('authorization');
      if (!authorization) return null;
      let claims: oauth.JWTAccessTokenClaims;
      let scopes: readonly string[];
      try {
        claims = await oauth.validateJwtAccessToken(
          authorizationServer,
          request,
          audience,
          {
            signingAlgorithms: JWT_SIGNING_ALGORITHMS,
            [oauth.jwksCache]: cache,
            [oauth.customFetch]: customFetch,
            ...(jwksUrl.protocol === 'http:' && isExactOAuthLoopbackHostname(jwksUrl.hostname)
              ? { [oauth.allowInsecureRequests]: true } : {}),
          },
        );
        const rawScope: unknown = claims.scope;
        scopes = scopesFromClaim(rawScope);
      } catch (error) {
        if (isJwksUnavailable(error)) {
          throw new A2AError(-32603, 'OAuth token verification is temporarily unavailable.', 503);
        }
        throw new A2AError(-32600, 'Invalid OAuth access token.', 401, undefined, {
          'www-authenticate': 'Bearer error="invalid_token"',
        });
      }
      const missing = requiredScopes.filter((scope) => !scopes.includes(scope));
      if (missing.length > 0) {
        throw new A2AError(-32600, 'Insufficient OAuth scope.', 403, undefined, {
          'www-authenticate': `Bearer error="insufficient_scope", scope="${requiredScopes.join(' ')}"`,
        });
      }
      return { subject: claims.sub, scopes };
    },
  };
}
