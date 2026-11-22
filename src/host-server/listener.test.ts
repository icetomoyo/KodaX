import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { connect as connectTcp } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostCloseReason } from '../host-protocol/close.js';
import {
  startHostNetworkListener,
  type HostHealth,
  type HostNetworkListener,
  type HostNetworkListenerOptions,
  type HostNetworkPeer,
} from './listener.js';

interface ClientSocket {
  send(data: string | Buffer): void;
  close(): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
  on(event: 'unexpected-response', listener: (request: unknown, response: IncomingMessage) => void): void;
  on(event: 'upgrade', listener: (response: IncomingMessage) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}
const { WebSocket } = createRequire(import.meta.url)('ws') as {
  WebSocket: new (url: string, options?: { headers?: Record<string, string> }) => ClientSocket;
};

interface TestPeer {
  readonly received: string[];
  readonly origin: string | undefined;
  readonly device: string | undefined;
  ready: boolean;
  closed: boolean;
  toldDraining: boolean;
  send(frame: string): void;
  disconnect(reason: HostCloseReason): void;
}

const listeners: HostNetworkListener[] = [];
const sockets: ClientSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const listener of listeners.splice(0)) await listener.close();
});

const READY: HostHealth = { state: 'ready', canStop: true, blockers: [], lastActivityAt: 1_800_000_000_000 };

/** A listener on a loopback port whose peers echo what they receive, and the peers it made. */
async function listen(options: Partial<HostNetworkListenerOptions> = {}) {
  const peers: TestPeer[] = [];
  const listener = await startHostNetworkListener({
    listen: { hostname: '127.0.0.1', port: 0 },
    allowsOrigin: origin => origin === 'https://app.example.test',
    maxFrameBytes: 1024 * 1024,
    idleTimeoutMs: 60_000,
    health: async () => READY,
    createPeer: (transport, request) => {
      const peer: TestPeer & HostNetworkPeer = {
        received: [],
        origin: request.origin,
        device: request.device,
        ready: false,
        closed: false,
        toldDraining: false,
        send: transport.send,
        disconnect: transport.disconnect,
        receive(frame) {
          peer.received.push(frame);
          transport.send(`echo:${frame}`);
        },
        close() { peer.closed = true; },
        draining() { peer.toldDraining = true; },
        admitted: () => peer.ready,
      };
      peers.push(peer);
      return peer;
    },
    ...options,
  });
  listeners.push(listener);
  return { listener, peers, url: `ws://127.0.0.1:${listener.port!}/v2`, base: `http://127.0.0.1:${listener.port!}` };
}

/** Opens a client, or rejects with the HTTP status the listener refused it with. */
function connect(url: string, origin?: string, cookie?: string) {
  const headers = { ...(origin !== undefined ? { origin } : {}), ...(cookie !== undefined ? { cookie } : {}) };
  const socket = new WebSocket(url, { headers });
  sockets.push(socket);
  const messages: string[] = [];
  let setCookie: string[] | undefined;
  socket.on('message', data => messages.push(data.toString('utf8')));
  socket.on('upgrade', (response) => { setCookie = response.headers['set-cookie']; });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('unexpected-response', (_request, response) => reject(Object.assign(new Error('refused'), { status: response.statusCode })));
    socket.on('error', reject);
  });
  return { socket, messages, closed, opened, setCookie: () => setCookie };
}

describe('startHostNetworkListener', () => {
  it('carries text frames both ways on the v2 path', async () => {
    const { url, peers } = await listen();
    const client = connect(url);
    await client.opened;
    client.socket.send('{"hello":1}');
    await vi.waitFor(() => expect(client.messages).toEqual(['echo:{"hello":1}']));
    expect(peers[0]!.received).toEqual(['{"hello":1}']);
  });

  it('answers 404 on any other path', async () => {
    const { listener } = await listen();
    await expect(connect(`ws://127.0.0.1:${listener.port!}/other`).opened).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a browser origin it was not told to allow, and admits an allowed one or a client that sends none', async () => {
    const { url, peers } = await listen();
    await expect(connect(url, 'https://evil.example.test').opened).rejects.toMatchObject({ status: 403 });
    await expect(connect(url, 'https://app.example.test').opened).resolves.toBeUndefined();
    await expect(connect(url).opened).resolves.toBeUndefined();
    // The peer learns the origin, so a later change to the allowed list can find its connections.
    expect(peers.map(peer => peer.origin)).toEqual(['https://app.example.test', undefined]);
  });

  it('admits a browser that brings a device cookie from the origin it paired from, and sends the cookie back', async () => {
    const PHONE = 'https://phone.example.test';
    const { url, peers } = await listen({
      admitsDevice: ({ origin, cookie }) => (origin === PHONE && cookie === 'theme=dark; kodax_device=good'
        ? { device: 'dev_1', setCookie: 'kodax_device=good; Max-Age=60' }
        : undefined),
    });
    const phone = connect(url, PHONE, 'theme=dark; kodax_device=good');
    await phone.opened;
    expect(phone.setCookie()).toEqual(['kodax_device=good; Max-Age=60']);
    // A cookie the Host does not take is no reason to let in an origin it does not allow.
    await expect(connect(url, PHONE, 'kodax_device=bad').opened).rejects.toMatchObject({ status: 403 });
    const app = connect(url, 'https://app.example.test', 'kodax_device=bad');
    await app.opened;
    expect(app.setCookie()).toBeUndefined();
    expect(peers.map(peer => [peer.origin, peer.device])).toEqual([[PHONE, 'dev_1'], ['https://app.example.test', undefined]]);
  });

  it('hands other HTTP requests to the web pages, after /healthz', async () => {
    const { base } = await listen({ serveHttp: (_request, response) => response.writeHead(200).end('page') });
    expect(await (await fetch(`${base}/index.html`)).text()).toBe('page');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual(READY);
  });

  it('refuses new connections while too many have not finished the handshake', async () => {
    const { url, peers } = await listen({ maxPendingHandshakes: 2 });
    await connect(url).opened;
    await connect(url).opened;
    await expect(connect(url).opened).rejects.toMatchObject({ status: 503 });
    peers[0]!.ready = true;
    await expect(connect(url).opened).resolves.toBeUndefined();
  });

  it.each([
    ['credential', 4401], ['revoked', 4403], ['replaced', 4409], ['overloaded', 4429], ['unavailable', 4503], ['protocol', 4400],
  ] as const)('closes with the code that tells the client what to do when the peer hangs up for %s', async (reason, code) => {
    const { url, peers } = await listen();
    const client = connect(url);
    await client.opened;
    peers[0]!.send('last answer');
    peers[0]!.disconnect(reason);
    await expect(client.closed).resolves.toEqual({ code, reason });
    // What the peer sent before hanging up still arrives.
    expect(client.messages).toEqual(['last answer']);
    await vi.waitFor(() => expect(peers[0]!.closed).toBe(true));
  });

  it('hangs up on a client it has not heard from within the idle timeout, and keeps one that pings', async () => {
    const { url } = await listen({ idleTimeoutMs: 150 });
    const quiet = connect(url);
    const pinging = connect(url);
    await Promise.all([quiet.opened, pinging.opened]);
    const timer = setInterval(() => pinging.socket.send('ping'), 40);
    try {
      await expect(quiet.closed).resolves.toMatchObject({ code: 4408 });
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(pinging.messages.length).toBeGreaterThan(3);
    } finally {
      clearInterval(timer);
    }
    let pingingClosed = false;
    void pinging.closed.then(() => { pingingClosed = true; });
    await Promise.resolve();
    expect(pingingClosed).toBe(false);
  });

  it('treats a binary frame as a protocol error', async () => {
    const { url } = await listen();
    const client = connect(url);
    await client.opened;
    client.socket.send(Buffer.from([1, 2, 3]));
    await expect(client.closed).resolves.toMatchObject({ code: 4400 });
  });

  it('drops a client that stopped reading once more is queued for it than the Host holds', async () => {
    const { listener, peers } = await listen({ maxOutboundBytes: 1024 });
    // A client that opens the socket and then reads nothing more, so what the Host sends piles up.
    const raw = connectTcp(listener.port!, '127.0.0.1');
    raw.write(['GET /v2 HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
    raw.on('error', () => undefined);
    raw.pause();
    try {
      await vi.waitFor(() => expect(peers).toHaveLength(1));
      for (let sent = 0; sent < 256 && !peers[0]!.closed; sent += 1) {
        peers[0]!.send('x'.repeat(1024 * 1024));
        await new Promise(resolve => setImmediate(resolve));
      }
      await vi.waitFor(() => expect(peers[0]!.closed).toBe(true));
    } finally {
      raw.destroy();
    }
  });

  it('closes the peer when the client goes away', async () => {
    const { url, peers } = await listen();
    const client = connect(url);
    await client.opened;
    client.socket.close();
    await vi.waitFor(() => expect(peers[0]!.closed).toBe(true));
  });

  it('serves the health the Host reports at /healthz, 200 only when ready', async () => {
    let health: HostHealth = { ...READY, state: 'starting' };
    const { base } = await listen({ health: async () => health });
    const starting = await fetch(`${base}/healthz`);
    expect(starting.status).toBe(503);
    await expect(starting.json()).resolves.toEqual(health);
    health = { ...READY, canStop: false, blockers: ['active_runs'] };
    const ready = await fetch(`${base}/healthz`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual(health);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(404);
  });

  it('answers /healthz with 503 when the Host cannot say how it is', async () => {
    const { base } = await listen({ health: async () => { throw new Error('preflight failed'); } });
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
  });

  it('tells connected peers the Host is draining, refuses new sockets, and reports draining', async () => {
    const { listener, url, peers, base } = await listen();
    const client = connect(url);
    await client.opened;
    listener.drain();
    expect(peers[0]!.toldDraining).toBe(true);
    await expect(connect(url).opened).rejects.toMatchObject({ status: 503 });
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(503);
    await expect(health.json()).resolves.toMatchObject({ state: 'draining' });
    // Draining keeps the connections it has, so their Runs can still report how they ended.
    client.socket.send('still here');
    await vi.waitFor(() => expect(client.messages).toEqual(['echo:still here']));
  });

  it('tells every client the Host is unavailable when it stops, and accepts no more', async () => {
    const { listener, url } = await listen();
    const client = connect(url);
    await client.opened;
    await listener.close();
    await expect(client.closed).resolves.toMatchObject({ code: 4503 });
    await expect(connect(url).opened).rejects.toThrow();
  });
});
