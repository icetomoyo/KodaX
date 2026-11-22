import { generateKeyPairSync, createSign, sign as signRaw, createHmac, constants, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHostJwtVerifier, HostJwtError } from './jwt.js';

const ISSUER = 'https://idp.example.test/realm';
const AUDIENCE = 'kodax-host-1';
const NOW = 1_800_000_000_000;

interface TestKey {
  readonly kid: string;
  readonly alg: string;
  readonly privateKey: KeyObject;
  readonly jwk: Record<string, unknown>;
}

function rsaKey(kid: string, alg = 'RS256'): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, alg, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig' } };
}

function ecKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, alg: 'ES256', privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid } };
}

function edKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { kid, alg: 'EdDSA', privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid } };
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const input = `${encode({ alg: key.alg, kid: key.kid, typ: 'JWT', ...header })}.${encode(claims)}`;
  let signature: Buffer;
  if (key.alg === 'EdDSA') signature = signRaw(null, Buffer.from(input), key.privateKey);
  else if (key.alg === 'ES256') signature = signRaw('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  else if (key.alg === 'PS256') {
    signature = signRaw('sha256', Buffer.from(input), {
      key: key.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    });
  } else signature = createSign('sha256').update(input).sign(key.privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

/** What Keycloak or Entra issue by default: no `typ: at+jwt`, no `jti`, no `client_id`. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: ISSUER, aud: AUDIENCE, sub: 'user-42', exp: NOW / 1000 + 300, ...overrides };
}

let jwks: { keys: Record<string, unknown>[] } = { keys: [] };
let jwksStatus = 200;
let jwksRequests = 0;
let server: Server;
let jwksUrl: string;

beforeEach(async () => {
  jwks = { keys: [] };
  jwksStatus = 200;
  jwksRequests = 0;
  server = createServer((_request, response) => {
    jwksRequests += 1;
    response.writeHead(jwksStatus, { 'content-type': 'application/json' });
    response.end(JSON.stringify(jwks));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function verifier(now: () => number = () => NOW) {
  return createHostJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUrl }, { now });
}

describe('createHostJwtVerifier', () => {
  it.each([['RS256', () => rsaKey('r1')], ['PS256', () => rsaKey('p1', 'PS256')], ['ES256', () => ecKey('e1')], ['EdDSA', () => edKey('d1')]])(
    'accepts a %s token that carries only iss, aud, exp and sub', async (_alg, make) => {
      const key = make();
      jwks.keys.push(key.alg === 'PS256' ? { ...key.jwk, alg: 'PS256' } : key.jwk);
      await expect(verifier().verify(token(key, claims()))).resolves.toEqual({ subject: 'user-42', expiresAt: NOW + 300_000 });
    });

  it('accepts an audience list that names this Host', async () => {
    const key = rsaKey('r1');
    jwks.keys.push(key.jwk);
    await expect(verifier().verify(token(key, claims({ aud: ['other', AUDIENCE] })))).resolves.toMatchObject({ subject: 'user-42' });
  });

  it.each([
    ['another issuer', { iss: 'https://evil.example.test' }],
    ['another audience', { aud: 'other-host' }],
    ['no subject', { sub: undefined }],
    ['an empty subject', { sub: '' }],
    ['no expiry', { exp: undefined }],
    ['an expiry past the tolerance', { exp: NOW / 1000 - 31 }],
    ['a not-before still ahead', { nbf: NOW / 1000 + 120 }],
  ])('refuses a token with %s', async (_label, overrides) => {
    const key = rsaKey('r1');
    jwks.keys.push(key.jwk);
    await expect(verifier().verify(token(key, claims(overrides)))).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('accepts a token that expired within the clock tolerance', async () => {
    const key = rsaKey('r1');
    jwks.keys.push(key.jwk);
    await expect(verifier().verify(token(key, claims({ exp: NOW / 1000 - 10 })))).resolves.toMatchObject({ subject: 'user-42' });
  });

  it('refuses a token signed by a key the issuer did not publish', async () => {
    const published = rsaKey('r1');
    const forged = { ...rsaKey('r1'), jwk: published.jwk };
    jwks.keys.push(published.jwk);
    await expect(verifier().verify(token(forged, claims()))).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('refuses a symmetric or unsigned token, whatever key it names', async () => {
    const key = rsaKey('r1');
    jwks.keys.push(key.jwk);
    const input = `${encode({ alg: 'HS256', kid: 'r1' })}.${encode(claims())}`;
    // The classic confusion: an HMAC keyed with the public key's text.
    const hmac = createHmac('sha256', JSON.stringify(key.jwk)).update(input).digest('base64url');
    await expect(verifier().verify(`${input}.${hmac}`)).rejects.toMatchObject({ kind: 'invalid' });
    await expect(verifier().verify(`${encode({ alg: 'none' })}.${encode(claims())}.`)).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('refuses a token whose algorithm does not fit the key', async () => {
    const key = rsaKey('r1');
    jwks.keys.push({ ...key.jwk, alg: 'RS512' });
    await expect(verifier().verify(token(key, claims()))).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('refuses a token with a critical header it does not understand', async () => {
    const key = rsaKey('r1');
    jwks.keys.push(key.jwk);
    await expect(verifier().verify(token(key, claims(), { crit: ['exp'] }))).rejects.toMatchObject({ kind: 'invalid' });
  });

  it.each(['', 'a.b', 'a.b.c.d', '!!.??.**'])('refuses %j, which is not a JWS', async (value) => {
    await expect(verifier().verify(value)).rejects.toBeInstanceOf(HostJwtError);
  });

  it('says the check is unavailable, not that the token is bad, while the key set cannot be read', async () => {
    const key = rsaKey('r1');
    jwks.keys.push(key.jwk);
    jwksStatus = 503;
    await expect(verifier().verify(token(key, claims()))).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('reads the key set again when a token names a key it has not seen, so a rotated key works', async () => {
    const first = rsaKey('r1');
    jwks.keys.push(first.jwk);
    const check = verifier();
    await check.verify(token(first, claims()));
    const rotated = rsaKey('r2');
    jwks.keys.push(rotated.jwk);
    await expect(check.verify(token(rotated, claims()))).resolves.toMatchObject({ subject: 'user-42' });
    expect(jwksRequests).toBe(2);
  });

  it('does not read the key set for every token that names an unknown key', async () => {
    const key = rsaKey('r1');
    jwks.keys.push(key.jwk);
    const check = verifier();
    await check.verify(token(key, claims()));
    const stranger = rsaKey('nobody');
    await expect(check.verify(token(stranger, claims()))).rejects.toMatchObject({ kind: 'invalid' });
    await expect(check.verify(token(stranger, claims()))).rejects.toMatchObject({ kind: 'invalid' });
    expect(jwksRequests).toBe(2);
  });

  it('keeps the keys it has when a later read of the key set fails', async () => {
    const key = rsaKey('r1');
    jwks.keys.push(key.jwk);
    let now = NOW;
    const check = verifier(() => now);
    await check.verify(token(key, claims()));
    jwksStatus = 500;
    now += 60 * 60_000;
    await expect(check.verify(token(key, claims({ exp: now / 1000 + 300 })))).resolves.toMatchObject({ subject: 'user-42' });
  });
});

describe('createHostJwtVerifier configuration', () => {
  it('refuses a key set served over plain HTTP from anywhere but loopback', () => {
    expect(() => createHostJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUrl: 'http://idp.internal/jwks' }))
      .toThrow(/HTTPS/u);
  });
});
