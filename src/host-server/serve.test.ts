import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostProtocolError } from '../host-protocol/codec.js';
import { HostJwtError, type HostJwtVerifier } from './jwt.js';
import type { HostHealth, HostNetworkPeer } from './listener.js';
import { createHostAuthenticator, startHostNetworkServer, type HostNetworkServer } from './serve.js';

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

  it('refuses a connection that brings no JWT before checking anything', async () => {
    let checked = false;
    const authenticate = createHostAuthenticator(server, verifier(async () => { checked = true; return { subject: 'person-1', expiresAt: 1 }; }));
    await expect(authenticate(undefined)).rejects.toMatchObject({ kodaxCode: 'unauthorized', reason: 'unsupported_auth_scheme' });
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
    health: async () => HEALTH,
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

interface ClientSocket {
  send(data: string): void;
  close(): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  on(event: 'close', listener: (code: number) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}
const { WebSocket } = createRequire(import.meta.url)('ws') as {
  WebSocket: new (url: string, options: { headers?: Record<string, string> }) => ClientSocket;
};

const HEALTH: HostHealth = { state: 'ready', canStop: true, blockers: [], lastActivityAt: 0 };

describe('a listening Host that reads host.json again when it changes', () => {
  let configHome: string;
  let jwks: Server;
  let jwksUrl: string;
  /** While set, the identity provider holds its key-set answers until it settles. */
  let holdJwks: Promise<void> | undefined;
  let key: KeyObject;
  let network: HostNetworkServer | undefined;
  const sockets: ClientSocket[] = [];

  beforeEach(async () => {
    configHome = mkdtempSync(path.join(tmpdir(), 'kodax-host-reload-'));
    mkdirSync(path.join(configHome, 'integrations'), { recursive: true });
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    key = pair.privateKey;
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1' };
    holdJwks = undefined;
    jwks = createServer((_request, response) => {
      void (holdJwks ?? Promise.resolve()).then(() => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] })));
    });
    await new Promise<void>(resolve => jwks.listen(0, '127.0.0.1', resolve));
    jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`;
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await network?.close();
    network = undefined;
    await new Promise<void>(resolve => jwks.close(() => resolve()));
    rmSync(configHome, { recursive: true, force: true });
  });

  const jwt = (audience = 'host-1') => ({ issuer: 'https://idp.example.test', audience, jwksUrl });
  function writeConfig(server: Record<string, unknown>): void {
    writeFileSync(path.join(configHome, 'integrations', 'host.json'), JSON.stringify({
      version: 1, server: { listen: { hostname: '127.0.0.1', port: 0 }, jwt: jwt(), ...server },
    }));
  }
  function token(sub: string, audience = 'host-1'): string {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', kid: 'k1' })}.${encode({ iss: 'https://idp.example.test', aud: audience, sub, exp: Math.floor(Date.now() / 1000) + 300 })}`;
    return `${input}.${createSign('sha256').update(input).sign(key).toString('base64url')}`;
  }

  /** Each peer reads its first frame as a JWT, answers with the role or the refusal, and echoes the rest. */
  async function start(): Promise<HostNetworkServer> {
    const started = await startHostNetworkServer({
      configHome,
      maxFrameBytes: 64 * 1024,
      health: async () => HEALTH,
      createPeer: (transport, connection): HostNetworkPeer => {
        let admitted = false;
        return {
          receive(frame) {
            if (admitted) return transport.send(`echo:${frame}`);
            connection.authenticate({ scheme: 'jwt', token: frame }).then((credential) => {
              admitted = true;
              transport.send(`ok:${credential.role}`);
            }, (error: HostProtocolError) => transport.send(`refused:${error.reason ?? error.kodaxCode}`));
          },
          close() {},
          admitted: () => admitted,
        };
      },
    });
    if (started === undefined) throw new Error('Expected the Host to listen.');
    network = started;
    return started;
  }

  /** `cookie` is a paired device's; its first frame is then ignored. */
  async function connect(sub: string, origin?: string, audience?: string, cookie?: string) {
    const headers = { ...(origin !== undefined ? { origin } : {}), ...(cookie !== undefined ? { cookie } : {}) };
    const socket = new WebSocket(`ws://127.0.0.1:${network!.port!}/v2`, { headers });
    sockets.push(socket);
    const messages: string[] = [];
    let closedWith: number | undefined;
    socket.on('message', data => messages.push(data.toString('utf8')));
    socket.on('close', (code) => { closedWith = code; });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    socket.send(token(sub, audience));
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    return { messages, socket, closedWith: () => closedWith };
  }

  /** Pairs a browser on `origin` through `POST /pair`, and answers with the Cookie header it sends from then on. */
  async function pairBrowser(origin: string): Promise<string> {
    const { code } = network!.devices.pair({ requestId: origin, name: 'Phone' });
    const response = await fetch(`http://127.0.0.1:${network!.port!}/pair`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    });
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  }

  it('keeps the devices paired with it in the home', async () => {
    writeConfig({ owner: 'person-1', pairing: true });
    const { devices } = await start();
    devices.redeem(devices.pair({ requestId: 'r1', name: 'Phone' }).code, 'https://laptop.example.test');
    expect(existsSync(path.join(configHome, 'runtime', 'devices.json'))).toBe(true);
  });

  it('pairs a browser on a Host without a JWT check, and admits it as user from the origin it paired from only', async () => {
    writeConfig({ jwt: undefined, pairing: true });
    await start();
    const cookie = await pairBrowser('https://laptop.example.test');

    const phone = await connect('ignored', 'https://laptop.example.test', undefined, cookie);
    expect(phone.messages[0]).toBe('ok:user');
    await expect(connect('ignored', 'https://evil.example.test', undefined, cookie)).rejects.toThrow();
    // Without a device cookie there is nothing else to admit it by.
    await expect(connect('person-1').then(client => client.messages[0])).resolves.toBe('refused:subject_not_admitted');
  });

  it('hangs up with revoked on paired browsers when pairing is turned off, and pairs no more', async () => {
    writeConfig({ owner: 'person-1', pairing: true });
    await start();
    const phone = await connect('ignored', 'https://laptop.example.test', undefined, await pairBrowser('https://laptop.example.test'));
    const owner = await connect('person-1');

    writeConfig({ owner: 'person-1' });
    await vi.waitFor(() => expect(phone.closedWith()).toBe(4403), { timeout: 5_000 });
    expect(owner.closedWith()).toBeUndefined();
    const refused = await fetch(`http://127.0.0.1:${network!.port!}/pair`, {
      method: 'POST', headers: { origin: 'https://laptop.example.test' }, body: JSON.stringify({ code: 'any' }),
    });
    expect(refused.status).toBe(404);
  });

  it('hangs up with revoked on a paired browser the moment its owner revokes it, and refuses its cookie from then on', async () => {
    writeConfig({ owner: 'person-1', pairing: true });
    await start();
    const cookie = await pairBrowser('https://laptop.example.test');
    const phone = await connect('ignored', 'https://laptop.example.test', undefined, cookie);
    const [device] = network!.devices.list();

    expect(network!.devices.revoke(device!.id)).toBe(true);
    await vi.waitFor(() => expect(phone.closedWith()).toBe(4403), { timeout: 5_000 });
    await expect(connect('ignored', 'https://laptop.example.test', undefined, cookie)).rejects.toThrow();
  });

  it('issues no pairing code while pairing is off, but still lists and revokes devices', async () => {
    writeConfig({ owner: 'person-1' });
    const { devices } = await start();
    expect(() => devices.pair({ requestId: 'r1', name: 'Phone' })).toThrow(expect.objectContaining({
      kodaxCode: 'invalid_state', reason: 'pairing_off',
    }));
    expect(devices.list()).toEqual([]);
    expect(devices.revoke('dev_000000000000')).toBe(false);
  });

  it('serves the web pages in its web root on the same port', async () => {
    const webRoot = path.join(configHome, 'web');
    mkdirSync(webRoot);
    writeFileSync(path.join(webRoot, 'index.html'), '<title>KodaX</title>');
    writeConfig({ owner: 'person-1', webRoot });
    await start();
    expect(await (await fetch(`http://127.0.0.1:${network!.port!}/`)).text()).toBe('<title>KodaX</title>');
  });

  it('hangs up with revoked on a subject no longer admitted, and keeps the others', async () => {
    writeConfig({ owner: 'person-1', services: ['backend-1', 'backend-2'] });
    await start();
    const owner = await connect('person-1');
    const removed = await connect('backend-1');
    expect([owner.messages[0], removed.messages[0]]).toEqual(['ok:user', 'ok:service']);

    writeConfig({ owner: 'person-1', services: ['backend-2'] });
    await vi.waitFor(() => expect(removed.closedWith()).toBe(4403), { timeout: 5_000 });
    expect(owner.closedWith()).toBeUndefined();
    await expect(connect('backend-1').then(client => client.messages[0])).resolves.toBe('refused:subject_not_admitted');
  });

  it('hangs up with credential on every connection when the JWT check changes, so clients fetch tokens it accepts', async () => {
    writeConfig({ owner: 'person-1' });
    await start();
    const owner = await connect('person-1');
    writeConfig({ owner: 'person-1', jwt: jwt('host-2') });
    await vi.waitFor(() => expect(owner.closedWith()).toBe(4401), { timeout: 5_000 });
    await expect(connect('person-1', undefined, 'host-2').then(client => client.messages[0])).resolves.toBe('ok:user');
  });

  it('hangs up with revoked on a browser whose origin is no longer allowed, and refuses it from then on', async () => {
    writeConfig({ owner: 'person-1', allowedOrigins: ['https://a.example.test', 'https://b.example.test'] });
    await start();
    const a = await connect('person-1', 'https://a.example.test');
    const b = await connect('person-1', 'https://b.example.test');
    const cli = await connect('person-1');
    writeConfig({ owner: 'person-1', allowedOrigins: ['https://b.example.test'] });
    await vi.waitFor(() => expect(a.closedWith()).toBe(4403), { timeout: 5_000 });
    expect([b.closedWith(), cli.closedWith()]).toEqual([undefined, undefined]);
    await expect(connect('person-1', 'https://a.example.test')).rejects.toThrow();
  });

  it('checks a credential again under the new file when the file changed while the check was running', async () => {
    writeConfig({ owner: 'person-1', services: ['backend-1'] });
    await start();
    let release!: () => void;
    holdJwks = new Promise<void>((resolve) => { release = resolve; });
    const socket = new WebSocket(`ws://127.0.0.1:${network!.port!}/v2`, {});
    sockets.push(socket);
    const messages: string[] = [];
    socket.on('message', data => messages.push(data.toString('utf8')));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    socket.send(token('backend-1'));
    const before = network!.status().revision;
    writeConfig({ owner: 'person-1' });
    await vi.waitFor(() => expect(network!.status().revision).not.toBe(before), { timeout: 5_000 });
    release();
    await vi.waitFor(() => expect(messages).toEqual(['refused:subject_not_admitted']));
  });

  it('keeps the config in force when an edit is not valid, and says so in its status', async () => {
    writeConfig({ owner: 'person-1' });
    await start();
    const owner = await connect('person-1');
    writeConfig({ owner: 'person-1', services: ['person-1'] });
    await vi.waitFor(() => expect(network!.status().diagnostic?.code).toBe('invalid-config'), { timeout: 5_000 });
    expect(network!.status()).toMatchObject({ domain: 'host', watching: true });
    owner.socket.send('still here');
    await vi.waitFor(() => expect(owner.messages).toContain('echo:still here'));
  });

  it('warns that a new listen address waits for a restart, and still applies the admission change', async () => {
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink(diagnostic => diagnostics.push(diagnostic));
    try {
      writeConfig({ owner: 'person-1', services: ['backend-1'] });
      await start();
      const backend = await connect('backend-1');
      writeFileSync(path.join(configHome, 'integrations', 'host.json'), JSON.stringify({
        version: 1, server: { listen: { hostname: '127.0.0.1', port: 1 }, jwt: jwt(), owner: 'person-1' },
      }));
      await vi.waitFor(() => expect(backend.closedWith()).toBe(4403), { timeout: 5_000 });
      expect(diagnostics).toContainEqual(expect.objectContaining({ level: 'warn', detail: { fields: ['listen'] } }));
    } finally {
      restore();
    }
  });
});
