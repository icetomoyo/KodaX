import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

import { connectHostRpc, type HostRpcClient, type HostRpcDial, type HostRpcLinkEvents } from './client.js';
import { HOST_PROTOCOL, HOST_PROTOCOL_REVISION, HostProtocolError, hostRpcNotification, hostRpcSuccess } from './codec.js';
import { createHostConnection, type HostAdmission } from './connection.js';
import { HOST_CLOSE_CODES, type HostLinkClose } from './close.js';
import { HOST_METHODS, hostParams, hostResult, type HostLimits, type HostMethodRegistry } from './methods.js';

const METHODS: HostMethodRegistry = {
  ...HOST_METHODS,
  echo: { primitive: 'query', plane: 'data', params: hostParams({ text: z.string() }), result: hostResult({ text: z.string() }) },
};

const IDENTITY = {
  client: { name: 'test', version: '1.0.0', instanceId: 'instance-1' },
  auth: { scheme: 'ipc' as const, token: 'secret' },
};

interface Loopback {
  readonly dial: HostRpcDial;
  /** Frames the client sent, decoded. */
  readonly sent: Array<Record<string, unknown>>;
  /** Delivers a frame to the client as if the Host sent it. */
  push(message: unknown): void;
  /** Ends the link from the Host side, with the close the transport saw. */
  drop(close?: HostLinkClose): void;
}

/** A client wired straight to a real Host connection, with no socket between them. */
function loopback(
  call: HostAdmission['call'] = async (_method, params) => ({ text: String(params.text) }),
  limits: HostLimits = { maxFrameBytes: 1024 },
): Loopback {
  const sent: Array<Record<string, unknown>> = [];
  let events: HostRpcLinkEvents | undefined;
  let ended = false;
  const end = (close?: HostLinkClose): void => {
    if (ended) return;
    ended = true;
    connection.close();
    events?.end(close);
  };
  const connection = createHostConnection({
    methods: METHODS,
    send: (frame) => { queueMicrotask(() => { if (!ended) events?.frame(frame); }); },
    disconnect: () => queueMicrotask(() => end()),
    onInternalError: () => undefined,
    admit: async ({ auth }) => {
      if (auth?.token !== 'secret') throw new HostProtocolError('unauthorized', 'The credential is not valid.');
      return {
        role: 'owner', subject: 'person', host: { id: 'runtime_1', version: '0.0.0-test' },
        features: [], locks: [], limits, call, close: () => undefined,
      };
    },
  });
  cleanup.push(end);
  return {
    sent,
    dial: async (linkEvents) => {
      events = linkEvents;
      return {
        send: (frame) => {
          sent.push(JSON.parse(frame) as Record<string, unknown>);
          queueMicrotask(() => { if (!ended) connection.receive(frame); });
        },
        close: () => end(),
      };
    },
    push: (message) => events?.frame(JSON.stringify(message)),
    drop: end,
  };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const task of cleanup.splice(0)) task();
  vi.useRealTimers();
});

async function connected(link: Loopback): Promise<HostRpcClient> {
  const client = await connectHostRpc(link.dial, IDENTITY);
  cleanup.push(() => client.close());
  return client;
}

describe('host rpc client', () => {
  it('shakes hands and exposes what the Host granted', async () => {
    const link = loopback();
    const client = await connected(link);

    expect(link.sent[0]).toMatchObject({
      method: 'initialize',
      params: { protocol: HOST_PROTOCOL, revision: HOST_PROTOCOL_REVISION, ...IDENTITY },
    });
    expect(client.handshake).toMatchObject({
      protocol: HOST_PROTOCOL,
      revision: HOST_PROTOCOL_REVISION,
      role: 'owner',
      host: { id: 'runtime_1' },
      methods: expect.arrayContaining(['ping', 'echo']),
    });
  });

  it('fails to connect with the error the Host gave and closes the link', async () => {
    const link = loopback();
    const failure = await connectHostRpc(link.dial, { ...IDENTITY, auth: { scheme: 'ipc', token: 'wrong' } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostProtocolError);
    expect(failure).toMatchObject({ kodaxCode: 'unauthorized' });
  });

  it('refuses a Host that answers in another protocol', async () => {
    const dial: HostRpcDial = async (events) => ({
      send: (frame) => {
        const { id } = JSON.parse(frame) as { id: number };
        queueMicrotask(() => events.frame(JSON.stringify(hostRpcSuccess(id, { protocol: 'kodax/3', revision: 1 }))));
      },
      close: () => undefined,
    });
    await expect(connectHostRpc(dial, IDENTITY)).rejects.toMatchObject({ kodaxCode: 'invalid_state', reason: 'protocol_mismatch' });
  });

  it('refuses at once a Host that answers the handshake in v1', async () => {
    const dial: HostRpcDial = async (events) => ({
      send: () => queueMicrotask(() => events.frame(JSON.stringify({ id: 1, error: { code: 'invalid_request', message: 'v1' } }))),
      close: () => undefined,
    });
    await expect(connectHostRpc(dial, IDENTITY)).rejects.toMatchObject({
      kodaxCode: 'invalid_state', reason: 'protocol_mismatch', retryable: false,
    });
  });

  it('gives up on a Host that never answers the handshake', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const dial: HostRpcDial = async () => ({ send: () => undefined, close });
    const attempt = connectHostRpc(dial, IDENTITY).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await attempt).toMatchObject({ kodaxCode: 'timeout', retryable: true });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports a Host it cannot reach with the one error type and keeps the cause', async () => {
    const cause = Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });
    const failure = await connectHostRpc(async () => { throw cause; }, IDENTITY).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostProtocolError);
    expect(failure).toMatchObject({ kodaxCode: 'unavailable', reason: 'connect_failed', retryable: true, cause });
  });

  it('reports a Host that hangs up during the handshake as unreachable, not as an unknown outcome', async () => {
    const dial: HostRpcDial = async (events) => ({
      send: () => queueMicrotask(() => events.end()),
      close: () => undefined,
    });
    await expect(connectHostRpc(dial, IDENTITY)).rejects.toMatchObject({
      kodaxCode: 'unavailable', reason: 'connection_closed', retryable: true,
    });
  });

  it('refuses to connect, for good, when the Host closes the link during the handshake and asks not to come back', async () => {
    const dial: HostRpcDial = async (events) => ({
      send: () => queueMicrotask(() => events.end({ code: HOST_CLOSE_CODES.revoked, reason: 'origin_not_allowed' })),
      close: () => undefined,
    });
    await expect(connectHostRpc(dial, IDENTITY)).rejects.toMatchObject({
      kodaxCode: 'unauthorized', reason: 'origin_not_allowed', retryable: false,
    });
  });

  it('keeps what the Host said when it closed the link, and nothing when this side closed it', async () => {
    const dropped = await connected(loopback());
    expect(dropped.ended).toBeUndefined();
    const link = loopback();
    const client = await connected(link);
    link.drop({ code: HOST_CLOSE_CODES.overloaded, reason: 'overloaded' });
    await client.closed;
    expect(client.ended).toMatchObject({ action: 'back_off', error: { kodaxCode: 'overloaded' } });
    dropped.close();
    await dropped.closed;
    expect(dropped.ended).toBeUndefined();
  });

  it('pings a Host that hangs up on silence, only while this side has said nothing', async () => {
    vi.useFakeTimers();
    const link = loopback(undefined, { maxFrameBytes: 1024, idleTimeoutMs: 3_000 });
    const client = await connected(link);
    const pings = (): number => link.sent.filter(frame => frame.method === 'ping').length;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    await client.request('echo', { text: 'a' });
    await vi.advanceTimersByTimeAsync(500);
    expect(pings()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings()).toBe(2);
    client.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pings()).toBe(2);
  });

  it('does not ping a Host without an idle limit', async () => {
    vi.useFakeTimers();
    const link = loopback();
    await connected(link);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.sent.filter(frame => frame.method === 'ping')).toHaveLength(0);
  });

  it('answers a request from the Host, which it cannot serve yet', async () => {
    const link = loopback();
    await connected(link);
    link.push({ jsonrpc: '2.0', id: 'h1', method: 'tool.invoke', params: {} });
    expect(link.sent[1]).toMatchObject({ id: 'h1', error: { data: { kodaxCode: 'method_not_found' } } });
  });

  it('refuses to send a request larger than the Host accepts', async () => {
    const link = loopback();
    const client = await connected(link);
    await expect(client.request('echo', { text: 'x'.repeat(2000) })).rejects.toMatchObject({
      kodaxCode: 'limit_exceeded', reason: 'frame_too_large',
    });
    await expect(client.request('echo', { text: '汉'.repeat(400) })).rejects.toMatchObject({ kodaxCode: 'limit_exceeded' });
    expect(link.sent).toHaveLength(1);
    await expect(client.request('echo', { text: 'x'.repeat(900) })).resolves.toEqual({ text: 'x'.repeat(900) });
  });

  it('pairs each answer with its request', async () => {
    const client = await connected(loopback());
    const [a, b, pong] = await Promise.all([
      client.request('echo', { text: 'a' }),
      client.request('echo', { text: 'b' }),
      client.request('ping'),
    ]);
    expect([a, b, pong]).toEqual([{ text: 'a' }, { text: 'b' }, {}]);
  });

  it('rejects with the one error type, rebuilt from the failure', async () => {
    const client = await connected(loopback(async () => {
      throw new HostProtocolError('overloaded', 'Busy.', { retryAfterMs: 250 });
    }));
    const failure = await client.request('echo', { text: 'a' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostProtocolError);
    expect(failure).toMatchObject({ kodaxCode: 'overloaded', message: 'Busy.', retryable: true, retryAfterMs: 250 });
  });

  it('asks the Host to cancel a request whose signal aborts and waits for the outcome', async () => {
    const link = loopback((_method, _params, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new HostProtocolError('cancelled', 'Cancelled by the client.')));
    }));
    const client = await connected(link);
    const controller = new AbortController();
    const pending = client.request('echo', { text: 'a' }, { signal: controller.signal });
    await vi.waitFor(() => expect(link.sent).toHaveLength(2));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kodaxCode: 'cancelled' });
    expect(link.sent[2]).toEqual(hostRpcNotification('request.cancel', { id: link.sent[1]!.id as number }));
  });

  it('does not send a request whose signal is already aborted', async () => {
    const link = loopback();
    const client = await connected(link);
    await expect(client.request('echo', { text: 'a' }, { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ kodaxCode: 'cancelled' });
    expect(link.sent).toHaveLength(1);
  });

  it('delivers notifications to every listener until it unsubscribes', async () => {
    const link = loopback();
    const client = await connected(link);
    const seen: Array<[string, unknown]> = [];
    const stop = client.onNotification((method, params) => { seen.push([method, params]); });
    link.push(hostRpcNotification('view.patch', { seq: 1 }));
    stop();
    link.push(hostRpcNotification('view.patch', { seq: 2 }));
    expect(seen).toEqual([['view.patch', { seq: 1 }]]);
  });

  it('keeps going when a listener throws or the Host sends something unreadable', async () => {
    const link = loopback();
    const onError = vi.fn();
    const client = await connectHostRpc(link.dial, { ...IDENTITY, onError });
    cleanup.push(() => client.close());
    const seen: string[] = [];
    client.onNotification(() => { throw new Error('listener bug'); });
    client.onNotification((method) => { seen.push(method); });
    link.push([]);
    link.push(hostRpcNotification('view.patch', { seq: 1 }));
    expect(seen).toEqual(['view.patch']);
    expect(onError).toHaveBeenCalledTimes(2);
    await expect(client.request('ping')).resolves.toEqual({});
  });

  it('reports work lost with the link as an unknown outcome and later calls as unavailable', async () => {
    const link = loopback(() => new Promise(() => undefined));
    const client = await connected(link);
    const pending = client.request('echo', { text: 'a' }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(link.sent).toHaveLength(2));
    link.drop();

    expect(await pending).toMatchObject({ kodaxCode: 'unknown_outcome', reason: 'connection_closed' });
    await client.closed;
    await expect(client.request('ping')).rejects.toMatchObject({
      kodaxCode: 'unavailable', reason: 'connection_closed', retryable: true,
    });
  });

  it('closes the link once and settles what was waiting', async () => {
    const link = loopback(() => new Promise(() => undefined));
    const client = await connected(link);
    const pending = client.request('echo', { text: 'a' }).catch((error: unknown) => error);
    client.close();
    client.close();
    expect(await pending).toMatchObject({ kodaxCode: 'unknown_outcome' });
    await expect(client.closed).resolves.toBeUndefined();
  });
});
