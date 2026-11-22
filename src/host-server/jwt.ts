/**
 * Checks the JWT a network client presents to the v2 Host. It asks only for
 * what the Host uses: `iss`, `aud`, `exp` and `sub`. The RFC 9068 claims A2A
 * requires (`typ: at+jwt`, `jti`, `client_id`) are not asked for, so the tokens
 * Keycloak or Entra issue by default pass. Only asymmetric signatures count.
 */
import { constants, createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

import { readJwksResponse } from '../a2a/server-auth.js';
import { safeA2AFetch } from '../a2a/safe-fetch.js';
import { parseOAuthEndpointUrl, parseOAuthIssuerIdentifier, requireNonEmptyString } from '../a2a/security.js';

export interface HostJwtConfig {
  readonly issuer: string;
  readonly audience: string;
  /** HTTPS, or HTTP to exact loopback. A private address is allowed: the platform configured it. */
  readonly jwksUrl: string;
}

export interface VerifiedHostJwt {
  readonly subject: string;
  /** `exp` in UTC milliseconds. */
  readonly expiresAt: number;
}

/** `invalid`: the token is not good. `unavailable`: the Host cannot check tokens right now. */
export class HostJwtError extends Error {
  constructor(readonly kind: 'invalid' | 'unavailable', message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'HostJwtError';
  }
}

export interface HostJwtVerifier {
  verify(token: string): Promise<VerifiedHostJwt>;
}

/** How far a token's `exp` and `nbf` may be off from this machine's clock. */
const CLOCK_TOLERANCE_MS = 30_000;
/** How long a read key set is used before it is read again. */
const JWKS_FRESH_MS = 10 * 60_000;
/** A token naming a key the Host does not have reads the set again at most this often. */
const JWKS_REFETCH_COOLDOWN_MS = 30_000;
const MIN_RSA_BITS = 2048;

interface Algorithm {
  readonly hash: string | null;
  readonly keyTypes: readonly string[];
  readonly curve?: string;
  readonly pss?: true;
  readonly p1363?: true;
}

const ALGORITHMS: Readonly<Record<string, Algorithm>> = {
  RS256: { hash: 'sha256', keyTypes: ['rsa'] },
  RS384: { hash: 'sha384', keyTypes: ['rsa'] },
  RS512: { hash: 'sha512', keyTypes: ['rsa'] },
  PS256: { hash: 'sha256', keyTypes: ['rsa', 'rsa-pss'], pss: true },
  PS384: { hash: 'sha384', keyTypes: ['rsa', 'rsa-pss'], pss: true },
  PS512: { hash: 'sha512', keyTypes: ['rsa', 'rsa-pss'], pss: true },
  ES256: { hash: 'sha256', keyTypes: ['ec'], curve: 'prime256v1', p1363: true },
  ES384: { hash: 'sha384', keyTypes: ['ec'], curve: 'secp384r1', p1363: true },
  ES512: { hash: 'sha512', keyTypes: ['ec'], curve: 'secp521r1', p1363: true },
  EdDSA: { hash: null, keyTypes: ['ed25519', 'ed448'] },
};

interface PublishedKey {
  readonly kid?: string;
  readonly alg?: string;
  readonly key: KeyObject;
}

export function createHostJwtVerifier(
  config: HostJwtConfig,
  options: { readonly now?: () => number; readonly fetch?: typeof globalThis.fetch } = {},
): HostJwtVerifier {
  const issuer = parseOAuthIssuerIdentifier(config.issuer, 'server.jwt.issuer');
  const audience = requireNonEmptyString(config.audience, 'server.jwt.audience');
  const jwksUrl = parseOAuthEndpointUrl(config.jwksUrl, 'server.jwt.jwksUrl');
  const now = options.now ?? Date.now;
  const keys = createKeySet(jwksUrl, now, options.fetch);

  return {
    async verify(token) {
      const { header, payload, signedPart, signature } = splitToken(token);
      const algorithm = typeof header.alg === 'string' && Object.hasOwn(ALGORITHMS, header.alg)
        ? ALGORITHMS[header.alg]! : undefined;
      if (algorithm === undefined) throw invalid('The token is not signed with an accepted asymmetric algorithm.');
      if (header.crit !== undefined) throw invalid('The token has critical header parameters the Host does not understand.');
      const kid = typeof header.kid === 'string' ? header.kid : undefined;
      const key = await keys.find(kid, header.alg as string, algorithm);
      if (key === undefined || !verifies(algorithm, signedPart, key, signature)) {
        throw invalid('The token signature does not verify against the issuer\'s keys.');
      }
      return checkClaims(payload, issuer, audience, now());
    },
  };
}

function createKeySet(url: URL, now: () => number, fetchImpl?: typeof globalThis.fetch) {
  let published: readonly PublishedKey[] | undefined;
  let fetchedAt = 0;
  /** When a token naming an unknown key last made the Host read the set. */
  let missReadAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | undefined;

  const read = async (): Promise<void> => {
    try {
      const { response, body } = await safeA2AFetch(url, { headers: { accept: 'application/json' } }, {
        allowedOrigins: [url.origin],
        allowPrivateAddresses: true,
        requestTimeoutMs: 10_000,
        maxResponseBytes: 1_048_576,
        maxRedirects: 0,
      }, fetchImpl);
      published = readJwksResponse(response, body).flatMap(toPublishedKey);
      fetchedAt = now();
    } catch (error: unknown) {
      // Keys already read keep working; only a Host that never read any cannot check.
      if (published === undefined) {
        throw new HostJwtError('unavailable', 'The Host cannot read the issuer\'s keys right now.', { cause: error });
      }
      // Try again soon, but not on every handshake while the issuer is down.
      fetchedAt = now() - JWKS_FRESH_MS + JWKS_REFETCH_COOLDOWN_MS;
    }
  };
  const readOnce = (): Promise<void> => {
    reading ??= read().finally(() => { reading = undefined; });
    return reading;
  };
  const pick = (kid: string | undefined, alg: string, algorithm: Algorithm): KeyObject | undefined => {
    const fits = (published ?? []).filter(entry => (entry.alg === undefined || entry.alg === alg)
      && keyFits(entry.key, algorithm) && (kid === undefined || entry.kid === kid));
    // Without a kid the choice must be unambiguous.
    return kid === undefined && fits.length !== 1 ? undefined : fits[0]?.key;
  };

  return {
    async find(kid: string | undefined, alg: string, algorithm: Algorithm): Promise<KeyObject | undefined> {
      if (published === undefined || now() - fetchedAt > JWKS_FRESH_MS) await readOnce();
      const found = pick(kid, alg, algorithm);
      if (found !== undefined || now() - missReadAt < JWKS_REFETCH_COOLDOWN_MS) return found;
      // The issuer may have rotated to a key published after the last read.
      missReadAt = now();
      await readOnce();
      return pick(kid, alg, algorithm);
    },
  };
}

function toPublishedKey(jwk: Readonly<Record<string, unknown>>): PublishedKey[] {
  if (jwk.use !== undefined && jwk.use !== 'sig') return [];
  if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes('verify')) return [];
  if (!['RSA', 'EC', 'OKP'].includes(String(jwk.kty))) return [];
  return [{
    ...(typeof jwk.kid === 'string' ? { kid: jwk.kid } : {}),
    ...(typeof jwk.alg === 'string' ? { alg: jwk.alg } : {}),
    key: createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }),
  }];
}

function keyFits(key: KeyObject, algorithm: Algorithm): boolean {
  const type = key.asymmetricKeyType ?? '';
  if (!algorithm.keyTypes.includes(type)) return false;
  const details = key.asymmetricKeyDetails ?? {};
  if (algorithm.curve !== undefined && details.namedCurve !== algorithm.curve) return false;
  return !type.startsWith('rsa') || (details.modulusLength ?? 0) >= MIN_RSA_BITS;
}

function verifies(algorithm: Algorithm, signedPart: string, key: KeyObject, signature: Buffer): boolean {
  const data = Buffer.from(signedPart);
  if (algorithm.pss) {
    return verify(algorithm.hash, data,
      { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, signature);
  }
  if (algorithm.p1363) return verify(algorithm.hash, data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  return verify(algorithm.hash, data, key, signature);
}

function splitToken(token: string): {
  readonly header: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signedPart: string;
  readonly signature: Buffer;
} {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]*$/u.test(part)) || parts[2] === '') {
    throw invalid('The token is not a signed JWT.');
  }
  return {
    header: decodeJson(parts[0]!),
    payload: decodeJson(parts[1]!),
    signedPart: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2]!, 'base64url'),
  };
}

function decodeJson(part: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
  } catch (error: unknown) {
    throw new HostJwtError('invalid', 'The token is not a signed JWT.', { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('The token is not a signed JWT.');
  return value as Readonly<Record<string, unknown>>;
}

function checkClaims(
  payload: Readonly<Record<string, unknown>>,
  issuer: string,
  audience: string,
  now: number,
): VerifiedHostJwt {
  if (payload.iss !== issuer) throw invalid('The token was issued by another issuer.');
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) throw invalid('The token is meant for another audience.');
  if (typeof payload.sub !== 'string' || payload.sub === '') throw invalid('The token names no subject.');
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw invalid('The token has no expiry.');
  const expiresAt = payload.exp * 1000;
  if (expiresAt + CLOCK_TOLERANCE_MS <= now) throw invalid('The token has expired.');
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf * 1000 - CLOCK_TOLERANCE_MS > now)) {
    throw invalid('The token is not valid yet.');
  }
  return { subject: payload.sub, expiresAt };
}

function invalid(message: string): HostJwtError {
  return new HostJwtError('invalid', message);
}
