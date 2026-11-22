import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOST_CLOSE_CODES } from './close.js';
import { HostProtocolError } from './codec.js';
import { createHostConnection, type HostAdmission } from './connection.js';
import { HOST_METHODS } from './methods.js';
import { connectKodaXHost, openHostWebSocket } from './remote-host.js';

interface ServerSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  on(event: 'close', listener: () => void): void;
}
interface Server {
  address(): AddressInfo;
  on(event: 'connection', listener: (socket: ServerSocket, request: { url?: string }) => void): void;
  close(callback: () => void): void;
  clients: Set<ServerSocket>;
}
const { WebSocketServer } = createRequire(import.meta.url)('ws') as {
  WebSocketServer: new (options: { port: number; host: string }, ready: () => void) => Server;
};

const client = { name: 'remote-test', version: '1.0.0', instanceId: 'remote-client-1' };

interface FakeHostOptions {
  /** How long each credential is good for. Without it the credential does not expire. */
  readonly lifetimeMs?: number;
  /** Runs on each new socket; may close it at once. */
  readonly onSocket?: (socket: ServerSocket) => void;
}

/** A v2 Host on a loopback WebSocket that admits any token and records what it was sent. */
async function fakeHost(options: FakeHostOptions = {}) {
  const tokens: string[] = [];
  const renewals: string[] = [];
  const paths: string[] = [];
  const server = await new Promise<Server>((resolve) => {
    const created: Server = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => resolve(created));
  });
  servers.push(server);
  const expiresAt = (): number | undefined => (options.lifetimeMs === undefined ? undefined : Date.now() + options.lifetimeMs);
  server.on('connection', (socket, request) => {
    paths.push(request.url ?? '');
    options.onSocket?.(socket);
    const call: HostAdmission['call'] = async (method, params) => {
      if (method !== 'auth.renew') return {};
      renewals.push(String(params.token));
      const next = expiresAt();
      return next === undefined ? {} : { expiresAt: next };
    };
    const connection = createHostConnection({
      methods: HOST_METHODS,
      send: frame => socket.send(frame),
      disconnect: () => socket.close(),
      onInternalError: () => undefined,
      admit: async ({ auth }) => {
        if (auth !== undefined) tokens.push(auth.token);
        const next = expiresAt();
        return {
          role: 'user', subject: 'person', host: { id: 'runtime_1', version: '0.0.0-test' },
          features: [], locks: [], limits: { maxFrameBytes: 64 * 1024, idleTimeoutMs: 60_000 },
          ...(next !== undefined ? { expiresAt: next } : {}), call, close: () => undefined,
        };
      },
    });
    socket.on('message', data => connection.receive(data.toString('utf8')));
    socket.on('close', () => connection.close());
  });
  const { port } = server.address();
  return { tokens, renewals, paths, server, origin: `http://127.0.0.1:${port}` };
}

const servers: Server[] = [];
const cleanup: Array<() => void> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0)) task();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    for (const socket of server.clients) socket.close();
    server.close(() => resolve());
  })));
});

/** Each call gives the next token, so a test can tell which connection used which. */
function tokenSource() {
  let issued = 0;
  return vi.fn(() => `token-${++issued}`);
}

describe('a client that reaches a Host over its network port', () => {
  it('opens the v2 path of an http address and proves itself with the credential it is given', async () => {
    const host = await fakeHost();
    const remote = await connectKodaXHost({ url: host.origin, client, credential: tokenSource() });
    cleanup.push(() => remote.close());

    await expect(remote.call('ping')).resolves.toEqual({});
    expect(remote.handshake).toMatchObject({ role: 'user', limits: { idleTimeoutMs: 60_000 } });
    expect(host.paths).toEqual(['/v2']);
    expect(host.tokens).toEqual(['token-1']);
  });

  it('connects without a credential when the transport carries it, as a paired browser does', async () => {
    const host = await fakeHost();
    const remote = await connectKodaXHost({ url: `${host.origin.replace('http', 'ws')}/v2`, client });
    cleanup.push(() => remote.close());
    await expect(remote.call('ping')).resolves.toEqual({});
    expect(host.tokens).toEqual([]);
  });

  it('gets a new credential for the connection that follows an expired one', async () => {
    const host = await fakeHost();
    const credential = tokenSource();
    const remote = await connectKodaXHost({ url: host.origin, client, credential });
    cleanup.push(() => remote.close());
    for (const socket of host.server.clients) socket.close(HOST_CLOSE_CODES.credential, 'credential');

    await vi.waitFor(() => expect(host.tokens).toEqual(['token-1', 'token-2']));
    await expect(remote.call('ping')).resolves.toEqual({});
  });

  it('renews the credential before the Host would end the connection for it', async () => {
    const host = await fakeHost({ lifetimeMs: 500 });
    const remote = await connectKodaXHost({ url: host.origin, client, credential: tokenSource() });
    cleanup.push(() => remote.close());

    // The first renewal comes at most 400 ms in; the next follows the expiry the renewal returned.
    await vi.waitFor(() => expect(host.renewals).toEqual(['token-2', 'token-3']), { timeout: 2_000 });
    expect(host.tokens).toEqual(['token-1']);
  });

  it('gives up for good on a Host that turns it away, and says why', async () => {
    const host = await fakeHost({ onSocket: socket => socket.close(HOST_CLOSE_CODES.revoked, 'origin_not_allowed') });
    await expect(connectKodaXHost({ url: host.origin, client })).rejects.toMatchObject({
      kodaxCode: 'unauthorized', reason: 'origin_not_allowed', retryable: false,
    });
  });

  it('reports a Host it cannot reach, or a credential it could not get, as worth trying again', async () => {
    const host = await fakeHost();
    const { origin } = host;
    await new Promise<void>(resolve => host.server.close(() => resolve()));
    servers.splice(servers.indexOf(host.server), 1);
    await expect(openHostWebSocket({ url: origin, client })(new AbortController().signal)).rejects.toMatchObject({
      kodaxCode: 'unavailable', reason: 'connect_failed', retryable: true,
    });

    const live = await fakeHost();
    const cause = new Error('identity provider down');
    const failure = await openHostWebSocket({ url: live.origin, client, credential: () => Promise.reject(cause) })(new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostProtocolError);
    expect(failure).toMatchObject({ kodaxCode: 'unavailable', reason: 'credential_unavailable', retryable: true, cause });
  });

  it('refuses an address that is not http or ws', () => {
    expect(() => openHostWebSocket({ url: 'ftp://host', client })).toThrow(/http/);
  });
});
