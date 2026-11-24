import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { connect as connectTcp } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostLinkClose, HostCloseReason } from '../host-protocol/close.js';
import { dialHostHttp } from '../host-protocol/http-link.js';
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
    // A browser cannot read an HTTP status, so the refusal comes as a close it can tell from a dropped network.
    const evil = connect(url, 'https://evil.example.test');
    await evil.opened;
    await expect(evil.closed).resolves.toEqual({ code: 4403, reason: 'origin_not_allowed' });
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
    await expect(connect(url, PHONE, 'kodax_device=bad').closed).resolves.toEqual({ code: 4403, reason: 'origin_not_allowed' });
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

/** A client of the listener over HTTP, through the SDK's own link. */
async function dialHttp(base: string) {
  const frames: string[] = [];
  let resolveEnded: (close: HostLinkClose | undefined) => void = () => undefined;
  const ended = new Promise<HostLinkClose | undefined>((resolve) => { resolveEnded = resolve; });
  const link = await dialHostHttp({ eventsUrl: `${base}/v2/events`, messagesUrl: `${base}/v2/messages`, openTimeoutMs: 5_000 })({
    frame: text => frames.push(text),
    end: resolveEnded,
  });
  return { link, frames, ended };
}

/** Opens a stream by hand and reads it to its end, or as far as `until` wants. */
async function openRawStream(base: string, headers: Record<string, string> = {}) {
  const answer = await fetch(`${base}/v2/events`, { method: 'POST', body: '', headers });
  const reader = answer.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  const until = async (seen: (text: string) => boolean): Promise<string> => {
    while (!seen(text)) {
      const { done, value } = await reader.read();
      if (done) break;
      text += value;
    }
    return text;
  };
  return { answer, until, cancel: () => reader.cancel() };
}

describe('the HTTP carriage, for a network that lets no WebSocket through', () => {
  it('carries frames both ways, in the order they were sent, on a stream proxies are asked not to hold back', async () => {
    const { base, peers } = await listen();
    const client = await dialHttp(base);
    for (const frame of ['{"a":1}', '{"b":2}', '{"c":3}']) client.link.send(frame);
    await vi.waitFor(() => expect(client.frames).toEqual(['echo:{"a":1}', 'echo:{"b":2}', 'echo:{"c":3}']));
    expect(peers[0]!.received).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);

    const raw = await openRawStream(base);
    expect(raw.answer.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(raw.answer.headers.get('x-accel-buffering')).toBe('no');
    expect(raw.answer.headers.get('cache-control')).toContain('no-transform');
    await raw.cancel();
  });

  it('ends the stream with the close the Host gave, and closes the peer when the client goes away', async () => {
    const { base, peers } = await listen();
    const first = await dialHttp(base);
    await vi.waitFor(() => expect(peers).toHaveLength(1));
    peers[0]!.disconnect('credential');
    await expect(first.ended).resolves.toEqual({ code: 4401, reason: 'credential' });

    const second = await dialHttp(base);
    await vi.waitFor(() => expect(peers).toHaveLength(2));
    second.link.close();
    await vi.waitFor(() => expect(peers[1]!.closed).toBe(true));
  });

  it('opens a refused browser origin only to close it with why, and answers its CORS read', async () => {
    const { base, peers } = await listen();
    const evil = await openRawStream(base, { origin: 'https://evil.example.test' });
    const text = await evil.until(() => false);
    expect(text).toMatch(/^event: open\ndata: \{"stream":"[\w-]+"\}\n\nevent: close\ndata: \{"code":4403,"reason":"origin_not_allowed"\}\n\n$/);
    expect(evil.answer.headers.get('access-control-allow-origin')).toBe('https://evil.example.test');
    expect(peers).toHaveLength(0);

    const app = await openRawStream(base, { origin: 'https://app.example.test' });
    await app.until(seen => seen.includes('event: open'));
    expect(app.answer.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    expect(app.answer.headers.get('access-control-allow-credentials')).toBe('true');
    expect(peers[0]!.origin).toBe('https://app.example.test');
    await app.cancel();
  });

  it('takes frames only for a stream it opened, from the origin that opened it', async () => {
    const { base, peers } = await listen();
    const app = await openRawStream(base, { origin: 'https://app.example.test' });
    const name = /"stream":"([\w-]+)"/.exec(await app.until(seen => seen.includes('event: open')))![1]!;
    const post = (body: string, origin?: string) => fetch(`${base}/v2/messages`, {
      method: 'POST', body, headers: origin !== undefined ? { origin } : {},
    });

    expect((await post(`${name}\n{"x":1}`, 'https://evil.example.test')).status).toBe(404);
    expect((await post(`${name}\n{"x":1}`)).status).toBe(404);
    expect((await post('not-a-stream\n{"x":1}', 'https://app.example.test')).status).toBe(404);
    expect(peers[0]!.received).toEqual([]);
    const accepted = await post(`${name}\n{"x":1}\n{"y":2}`, 'https://app.example.test');
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    expect(peers[0]!.received).toEqual(['{"x":1}', '{"y":2}']);
    await app.cancel();
  });

  it('refuses a body larger than a frame, and new streams while draining', async () => {
    const { listener, base } = await listen({ maxFrameBytes: 1024 });
    const big = await fetch(`${base}/v2/messages`, { method: 'POST', body: `name\n${'x'.repeat(4096)}` });
    expect(big.status).toBe(413);
    listener.drain();
    expect((await fetch(`${base}/v2/events`, { method: 'POST', body: '' })).status).toBe(503);
  });
});
