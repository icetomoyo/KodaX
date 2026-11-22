import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostProtocolError } from '../host-protocol/codec.js';
import { HostJwtError, type HostJwtVerifier } from './jwt.js';
import { createHostAuthenticator, startHostNetworkServer } from './serve.js';

const verifier = (result: () => Promise<{ subject: string; expiresAt: number }>): HostJwtVerifier => ({ verify: result });
const signed = (subject: string) => verifier(async () => ({ subject, expiresAt: 1_800_000_000_000 }));
const server = { owner: 'person-1', services: ['backend-1'] };

describe('createHostAuthenticator', () => {
  it('admits the owner as user and a listed backend as service, until the token expires', async () => {
    await expect(createHostAuthenticator(server, signed('person-1'))({ scheme: 'jwt', token: 't' }))
      .resolves.toEqual({ role: 'user', subject: 'person-1', expiresAt: 1_800_000_000_000 });
    await expect(createHostAuthenticator(server, signed('backend-1'))({ scheme: 'jwt', token: 't' }))
      .resolves.toEqual({ role: 'service', subject: 'backend-1', expiresAt: 1_800_000_000_000 });
  });

  it('refuses a good token whose subject the Host does not admit', async () => {
    await expect(createHostAuthenticator(server, signed('stranger'))({ scheme: 'jwt', token: 't' }))
      .rejects.toMatchObject({ kodaxCode: 'unauthorized', reason: 'subject_not_admitted' });
  });

  it('refuses a credential that is not a JWT before checking anything', async () => {
    let checked = false;
    const authenticate = createHostAuthenticator(server, verifier(async () => { checked = true; return { subject: 'person-1', expiresAt: 1 }; }));
    await expect(authenticate({ scheme: 'pairing', token: 't' })).rejects.toMatchObject({ kodaxCode: 'unauthorized', reason: 'unsupported_auth_scheme' });
    expect(checked).toBe(false);
  });

  it('tells a bad token apart from a check the Host cannot make right now', async () => {
    await expect(createHostAuthenticator(server, verifier(async () => { throw new HostJwtError('invalid', 'bad signature'); }))({ scheme: 'jwt', token: 't' }))
      .rejects.toMatchObject({ kodaxCode: 'unauthorized', reason: 'invalid_credential' });
    const unavailable = createHostAuthenticator(server, verifier(async () => { throw new HostJwtError('unavailable', 'JWKS down'); }));
    await expect(unavailable({ scheme: 'jwt', token: 't' })).rejects.toMatchObject({ kodaxCode: 'unavailable', retryable: true });
  });

  it('lets an unexpected failure through rather than calling it a bad token', async () => {
    const broken = createHostAuthenticator(server, verifier(async () => { throw new TypeError('bug'); }));
    const failure = await broken({ scheme: 'jwt', token: 't' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(HostProtocolError);
  });
});

describe('startHostNetworkServer', () => {
  let configHome: string;
  beforeEach(() => {
    configHome = mkdtempSync(path.join(tmpdir(), 'kodax-host-serve-'));
    mkdirSync(path.join(configHome, 'integrations'), { recursive: true });
  });
  afterEach(() => rmSync(configHome, { recursive: true, force: true }));

  const start = () => startHostNetworkServer({
    configHome,
    maxFrameBytes: 1024,
    createPeer: () => { throw new Error('no client connects in these tests'); },
  });

  it('starts nothing when there is no host.json, or it names no listen address', async () => {
    await expect(start()).resolves.toBeUndefined();
    writeFileSync(path.join(configHome, 'integrations', 'host.json'), JSON.stringify({ version: 1, server: {} }));
    await expect(start()).resolves.toBeUndefined();
  });

  it('refuses to start on a host.json it does not understand', async () => {
    writeFileSync(path.join(configHome, 'integrations', 'host.json'), JSON.stringify({ version: 1, server: { listen: { port: 1 } } }));
    await expect(start()).rejects.toThrow(/host\.server\.listen/);
  });
});
