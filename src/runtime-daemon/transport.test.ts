import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRuntimeDaemonErrorResponse,
  createRuntimeDaemonNotification,
  createRuntimeDaemonRequest,
  createRuntimeDaemonSuccessResponse,
  isRuntimeDaemonRequest,
  type RuntimeDaemonFrame,
  type RuntimeDaemonNotification,
  type RuntimeDaemonRequest,
  type RuntimeDaemonWireMethod,
} from './protocol.js';
import {
  createRuntimeDaemonFrameParser,
  createRuntimeDaemonSocketServer,
  createRuntimeDaemonSocketClientTransport,
  defaultRuntimeDaemonEndpoint,
  isRuntimeDaemonTransportError,
  type RuntimeDaemonEndpoint,
} from './transport.js';

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  const tasks = cleanupTasks.splice(0);
  await Promise.allSettled(tasks.map((task) => task()));
});

describe('runtime daemon transport', () => {
  it('returns stable profile-scoped default endpoints', () => {
    const endpoint = defaultRuntimeDaemonEndpoint('default');

    expect(endpoint.kind).toBe(process.platform === 'win32' ? 'pipe' : 'unix');
    expect(endpoint.path).toContain('kodax-runtime-');
    expect(endpoint.path).toContain('default');
  });

  it('scopes default endpoints by home directory when provided', () => {
    const first = defaultRuntimeDaemonEndpoint('default', path.join(os.tmpdir(), 'kodax-home-a'));
    const second = defaultRuntimeDaemonEndpoint('default', path.join(os.tmpdir(), 'kodax-home-b'));
    const firstAgain = defaultRuntimeDaemonEndpoint('default', path.join(os.tmpdir(), 'kodax-home-a'));

    expect(first.path).toContain('kodax-runtime-');
    expect(first.path).toContain('default-');
    expect(first.path).toBe(firstAgain.path);
    expect(first.path).not.toBe(second.path);
  });

  it('parses split and coalesced daemon frames', () => {
    const frames: RuntimeDaemonFrame[] = [];
    const parser = createRuntimeDaemonFrameParser((frame) => frames.push(frame));
    const request = JSON.stringify(createRuntimeDaemonRequest('req-1', 'ping'));
    const notification = JSON.stringify(createRuntimeDaemonNotification('runtime.warning', {
      message: 'bounded warning',
    }));

    parser.push(request.slice(0, 8));
    parser.push(`${request.slice(8)}\n${notification}\n`);

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ kind: 'request', id: 'req-1', method: 'ping' });
    expect(frames[1]).toMatchObject({ kind: 'notification', method: 'runtime.warning' });
  });

  it('preserves UTF-8 characters split across Buffer chunks', () => {
    const frames: RuntimeDaemonFrame[] = [];
    const parser = createRuntimeDaemonFrameParser((frame) => frames.push(frame));
    const encoded = Buffer.from(JSON.stringify(createRuntimeDaemonRequest('req-utf8', 'session.create', {
      title: '中文会话',
    })) + '\n', 'utf8');
    const splitAt = encoded.indexOf(Buffer.from('中', 'utf8')) + 1;

    parser.push(encoded.subarray(0, splitAt));
    parser.push(encoded.subarray(splitAt));

    expect(frames[0]).toMatchObject({
      kind: 'request',
      params: { title: '中文会话' },
    });
  });

  it('rejects frames whose UTF-8 payload exceeds the configured bound', () => {
    const parser = createRuntimeDaemonFrameParser(() => undefined, {
      maxFrameBytes: 32,
    });

    expect(() => parser.push('中'.repeat(11))).toThrow(
      'Runtime daemon frame exceeds the 32-byte limit.',
    );
    try {
      parser.push('x');
    } catch (error: unknown) {
      expect(isRuntimeDaemonTransportError(error)).toBe(true);
      if (isRuntimeDaemonTransportError(error)) {
        expect(error).toMatchObject({ code: 'invalid_frame' });
      }
    }
  });

  it('sends requests, resolves responses, and fans out notifications', async () => {
    const endpoint = await makeTestEndpoint();
    const requests: RuntimeDaemonRequest<RuntimeDaemonWireMethod>[] = [];
    const server = await listen(endpoint, (socket) => {
      const parser = createRuntimeDaemonFrameParser((frame) => {
        if (!isRuntimeDaemonRequest(frame)) return;
        requests.push(frame);
        socket.write(`${JSON.stringify(createRuntimeDaemonSuccessResponse(frame.id, {
          ok: true,
          method: frame.method,
        }))}\n`);
        socket.write(`${JSON.stringify(createRuntimeDaemonNotification('event', {
          subscriptionId: 'sub-1',
          event: { type: 'run.completed' },
        }))}\n`);
      });
      socket.on('data', (chunk) => parser.push(chunk));
    });
    cleanupTasks.push(() => closeServer(server));

    const transport = await createRuntimeDaemonSocketClientTransport(endpoint);
    cleanupTasks.push(async () => {
      await transport.close?.();
    });
    const notifications: RuntimeDaemonNotification[] = [];
    const subscription = transport.subscribe((notification) => {
      notifications.push(notification);
    });

    const result = await transport.request('ping', { hello: 'daemon' });
    await waitFor(() => notifications.length === 1);
    subscription.close();

    expect(result).toEqual({ ok: true, method: 'ping' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toEqual({ hello: 'daemon' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ method: 'event' });
  });

  it('removes cancelled request ids while still handling a bounded late result', async () => {
    const endpoint = await makeTestEndpoint();
    let requestId: string | undefined;
    const cancelledRequestIds: string[] = [];
    let accepted: net.Socket | undefined;
    const server = await listen(endpoint, (socket) => {
      accepted = socket;
      const parser = createRuntimeDaemonFrameParser((frame) => {
        if (!isRuntimeDaemonRequest(frame)) return;
        if (frame.method === 'initialize') {
          socket.write(`${JSON.stringify(createRuntimeDaemonSuccessResponse(
            frame.id,
            {
              identity: {},
              capabilities: {
                runLifecycleControl: {
                  version: 2,
                  structuredStopReceipt: true,
                  protocolCancellation: true,
                  responseAcknowledgement: true,
                },
              },
            },
          ))}\n`);
          return;
        }
        if (frame.method === 'request.ack') {
          socket.write(`${JSON.stringify(createRuntimeDaemonSuccessResponse(
            frame.id,
            { ok: true },
          ))}\n`);
          return;
        }
        if (frame.method === 'request.cancel') {
          const params = frame.params as { requestId?: unknown };
          if (typeof params.requestId === 'string') {
            cancelledRequestIds.push(params.requestId);
          }
          socket.write(`${JSON.stringify(createRuntimeDaemonSuccessResponse(
            frame.id,
            { ok: true },
          ))}\n`);
          return;
        }
        requestId = frame.id;
      });
      socket.on('data', (chunk) => parser.push(chunk));
    });
    cleanupTasks.push(() => closeServer(server));
    const transport = await createRuntimeDaemonSocketClientTransport(endpoint);
    cleanupTasks.push(async () => {
      await transport.close?.();
    });
    await transport.request('initialize', {});
    const controller = new AbortController();
    const lateResults: unknown[] = [];
    const pending = transport.request(
      'daemon.status',
      undefined,
      {
        signal: controller.signal,
        onLateResult: (value: unknown) => lateResults.push(value),
      },
    );
    await waitFor(() => requestId !== undefined && accepted !== undefined);

    const cancelled = Object.assign(new Error('cancelled by test'), {
      code: 'read_cancelled',
    });
    controller.abort(cancelled);
    await expect(pending).rejects.toBe(cancelled);
    await waitFor(() => cancelledRequestIds.length === 1);
    expect(cancelledRequestIds).toEqual([requestId]);
    accepted!.write(`${JSON.stringify(createRuntimeDaemonSuccessResponse(
      requestId!,
      { status: 'late' },
    ))}\n`);
    await waitFor(() => lateResults.length === 1);

    expect(lateResults).toEqual([{ status: 'late' }]);

    requestId = undefined;
    const expiredController = new AbortController();
    const expiredPending = transport.request(
      'daemon.status',
      undefined,
      {
        signal: expiredController.signal,
        onLateResult: (value: unknown) => lateResults.push(value),
      },
    );
    await waitFor(() => requestId !== undefined);
    const expiredRequestId = requestId!;
    const cancellationsBeforeExpiry = cancelledRequestIds.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expiredController.abort(cancelled);
      await expect(expiredPending).rejects.toBe(cancelled);
      await vi.advanceTimersByTimeAsync(30_001);
    } finally {
      vi.useRealTimers();
    }
    accepted!.write(`${JSON.stringify(createRuntimeDaemonSuccessResponse(
      expiredRequestId,
      { status: 'expired-late' },
    ))}\n`);
    await waitFor(
      () => cancelledRequestIds.length >= cancellationsBeforeExpiry + 2,
    );

    expect(lateResults).toEqual([{ status: 'late' }]);
    expect(
      cancelledRequestIds.filter((id) => id === expiredRequestId),
    ).toHaveLength(2);
  });

  it('rejects daemon error responses and pending requests when closed', async () => {
    const endpoint = await makeTestEndpoint();
    const server = await listen(endpoint, (socket) => {
      const parser = createRuntimeDaemonFrameParser((frame) => {
        if (!isRuntimeDaemonRequest(frame)) return;
        if (frame.method === 'daemon.logs') {
          socket.write(`${JSON.stringify(createRuntimeDaemonErrorResponse({
            code: 'internal_error',
            message: 'log stream failed',
          }, frame.id))}\n`);
        }
      });
      socket.on('data', (chunk) => parser.push(chunk));
    });
    cleanupTasks.push(() => closeServer(server));

    const transport = await createRuntimeDaemonSocketClientTransport(endpoint);

    await expect(transport.request('daemon.logs')).rejects.toThrow('log stream failed');
    const pending = transport.request('daemon.status');
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'RuntimeDaemonDisconnectError',
      code: 'client_closed',
      reconnectable: false,
      connectionId: expect.stringMatching(/^connection_/),
    });
    await transport.close?.();
    await rejected;
  });

  it('notifies clients immediately when the daemon connection closes', async () => {
    const endpoint = await makeTestEndpoint();
    let accepted: net.Socket | undefined;
    const server = await listen(endpoint, (socket) => {
      accepted = socket;
    });
    cleanupTasks.push(() => closeServer(server));
    const transport = await createRuntimeDaemonSocketClientTransport(endpoint);
    cleanupTasks.push(async () => {
      await transport.close?.();
    });
    const states: Array<{ readonly state: string; readonly reason?: string }> = [];
    const subscription = transport.subscribeLifecycle?.((state) => states.push(state));

    await waitFor(() => accepted !== undefined);
    accepted?.destroy();
    await waitFor(() => states.some((state) => state.state === 'disconnected'));

    expect(states[0]).toMatchObject({ state: 'connected' });
    expect(states.at(-1)).toMatchObject({
      state: 'disconnected',
      code: 'protocol_closed',
      reconnectable: true,
      connectionId: expect.stringMatching(/^connection_/),
    });
    subscription?.close();
  });

  it('hosts per-connection dispatchers without leaking notifications across clients', async () => {
    const endpoint = await makeTestEndpoint();
    const server = await createRuntimeDaemonSocketServer({
      endpoint,
      createDispatcher: (notify) => ({
        async handle(request) {
          if (request.method === 'ping') {
            notify(createRuntimeDaemonNotification('runtime.warning', {
              requestId: request.id,
            }));
            return createRuntimeDaemonSuccessResponse(request.id, { ok: true });
          }
          return createRuntimeDaemonErrorResponse({
            code: 'method_not_found',
            message: 'unsupported test method',
          }, request.id);
        },
        close() {},
      }),
    });
    cleanupTasks.push(() => server.close());

    const first = await createRuntimeDaemonSocketClientTransport(endpoint);
    const second = await createRuntimeDaemonSocketClientTransport(endpoint);
    cleanupTasks.push(async () => {
      await first.close?.();
      await second.close?.();
    });
    const firstNotifications: RuntimeDaemonNotification[] = [];
    const secondNotifications: RuntimeDaemonNotification[] = [];
    first.subscribe((notification) => firstNotifications.push(notification));
    second.subscribe((notification) => secondNotifications.push(notification));

    await expect(first.request('ping')).resolves.toEqual({ ok: true });
    await waitFor(() => firstNotifications.length === 1);

    expect(firstNotifications[0]).toMatchObject({ method: 'runtime.warning' });
    expect(secondNotifications).toEqual([]);
  });

  it('returns invalid_frame and disconnects oversized socket clients', async () => {
    const endpoint = await makeTestEndpoint();
    const server = await createRuntimeDaemonSocketServer({
      endpoint,
      maxFrameBytes: 64,
      createDispatcher: () => ({
        async handle(request) {
          return createRuntimeDaemonSuccessResponse(request.id, { ok: true });
        },
        close() {},
      }),
    });
    cleanupTasks.push(() => server.close());
    const socket = await connectSocket(endpoint);
    const response = collectSocketText(socket);

    socket.write('x'.repeat(65));

    await expect(response).resolves.toContain('invalid_frame');
    expect(socket.destroyed).toBe(true);
  });

  it('rejects pending requests when a daemon sends an oversized frame', async () => {
    const endpoint = await makeTestEndpoint();
    const server = await listen(endpoint, (socket) => {
      socket.once('data', () => {
        socket.write('x'.repeat(257));
      });
    });
    cleanupTasks.push(() => closeServer(server));
    const transport = await createRuntimeDaemonSocketClientTransport(endpoint, {
      maxFrameBytes: 256,
    });
    cleanupTasks.push(async () => {
      await transport.close?.();
    });

    await expect(transport.request('ping')).rejects.toMatchObject({
      name: 'RuntimeDaemonDisconnectError',
      code: 'invalid_frame',
      reconnectable: true,
      connectionId: expect.stringMatching(/^connection_/),
    });
  });

  it('rejects an oversized outbound request before writing it to the socket', async () => {
    const endpoint = await makeTestEndpoint();
    let receivedBytes = 0;
    const server = await listen(endpoint, (socket) => {
      socket.on('data', (chunk) => {
        receivedBytes += chunk.length;
      });
    });
    cleanupTasks.push(() => closeServer(server));
    const transport = await createRuntimeDaemonSocketClientTransport(endpoint, {
      maxFrameBytes: 96,
    });
    cleanupTasks.push(async () => {
      await transport.close?.();
    });

    await expect(transport.request('session.create', {
      title: 'x'.repeat(256),
    })).rejects.toMatchObject({
      code: 'invalid_frame',
      data: expect.objectContaining({ maxFrameBytes: 96 }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(receivedBytes).toBe(0);
  });

  it('fails non-serializable request and response payloads without leaking requests', async () => {
    const endpoint = await makeTestEndpoint();
    const cyclicResult: Record<string, unknown> = {};
    cyclicResult.self = cyclicResult;
    const server = await createRuntimeDaemonSocketServer({
      endpoint,
      createDispatcher: () => ({
        async handle(request) {
          return createRuntimeDaemonSuccessResponse(request.id, cyclicResult);
        },
        close() {},
      }),
    });
    cleanupTasks.push(() => server.close());
    const transport = await createRuntimeDaemonSocketClientTransport(endpoint);
    cleanupTasks.push(async () => {
      await transport.close?.();
    });
    const cyclicParams: Record<string, unknown> = {};
    cyclicParams.self = cyclicParams;

    await expect(transport.request('ping', cyclicParams)).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(transport.request('ping')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('refuses to overwrite a non-socket Unix endpoint path', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-endpoint-'));
    cleanupTasks.push(() => fs.rm(directory, { recursive: true, force: true }));
    const endpoint: RuntimeDaemonEndpoint = {
      kind: 'unix',
      path: path.join(directory, 'daemon.sock'),
    };
    await fs.writeFile(endpoint.path, 'not a socket', 'utf8');

    await expect(createRuntimeDaemonSocketServer({
      endpoint,
      createDispatcher: () => ({
        async handle(request) {
          return createRuntimeDaemonSuccessResponse(request.id, { ok: true });
        },
        close() {},
      }),
    })).rejects.toThrow('Runtime daemon Unix endpoint exists and is not a socket');
    await expect(fs.readFile(endpoint.path, 'utf8')).resolves.toBe('not a socket');
  });
});

async function makeTestEndpoint(): Promise<RuntimeDaemonEndpoint> {
  if (process.platform === 'win32') {
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\kodax-runtime-test-${randomUUID()}`,
    };
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-test-'));
  cleanupTasks.push(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    kind: 'unix',
    path: path.join(directory, 'daemon.sock'),
  };
}

function listen(
  endpoint: RuntimeDaemonEndpoint,
  onConnection: (socket: net.Socket) => void,
): Promise<net.Server> {
  const server = net.createServer(onConnection);
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint.path);
  });
}

function connectSocket(endpoint: RuntimeDaemonEndpoint): Promise<net.Socket> {
  const socket = net.createConnection(endpoint.path);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function collectSocketText(socket: net.Socket): Promise<string> {
  socket.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk;
    });
    socket.once('close', () => resolve(text));
    socket.once('error', reject);
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for daemon transport condition.');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}
