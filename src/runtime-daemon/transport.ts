import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';

import type { RuntimeSubscription } from '../sdk-runtime.js';
import type {
  RuntimeDaemonClientTransport,
  RuntimeDaemonDisconnectCode,
  RuntimeDaemonTransportLifecycleState,
} from './client.js';
import {
  createRuntimeDaemonErrorResponse,
  createRuntimeDaemonRequest,
  isRuntimeDaemonErrorResponse,
  isRuntimeDaemonRequest,
  isRuntimeDaemonNotification,
  isRuntimeDaemonSuccessResponse,
  isRuntimeDaemonMutationMethod,
  parseRuntimeDaemonFrame,
  type RuntimeDaemonFrame,
  type RuntimeDaemonNotification,
  type RuntimeDaemonErrorCode,
} from './protocol.js';
import type { RuntimeDaemonDispatcher } from './server.js';
import { normalizeRuntimeDaemonProfile } from './state.js';

export interface RuntimeDaemonEndpoint {
  readonly kind: 'pipe' | 'unix';
  readonly path: string;
}

export interface RuntimeDaemonFrameParser {
  push(chunk: Buffer | string): void;
  flush(): void;
}

export interface RuntimeDaemonFrameParserOptions {
  readonly maxFrameBytes?: number;
}

export interface RuntimeDaemonSocketServerOptions {
  readonly endpoint: RuntimeDaemonEndpoint;
  readonly maxFrameBytes?: number;
  readonly createDispatcher: (
    notify: (notification: RuntimeDaemonNotification) => void,
    disconnect: () => void,
  ) => RuntimeDaemonDispatcher;
}

export interface RuntimeDaemonSocketServer {
  readonly endpoint: RuntimeDaemonEndpoint;
  connectionCount(): number;
  unref(): void;
  close(): Promise<void>;
}

export interface RuntimeDaemonSocketClientTransportOptions {
  readonly connectTimeoutMs?: number;
  readonly maxFrameBytes?: number;
}

export const RUNTIME_DAEMON_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const RUNTIME_DAEMON_LATE_RESULT_RETENTION_MS = 30_000;

export class RuntimeDaemonTransportError extends Error {
  constructor(
    message: string,
    readonly code: RuntimeDaemonErrorCode,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RuntimeDaemonTransportError';
  }
}

export function isRuntimeDaemonTransportError(
  error: unknown,
): error is RuntimeDaemonTransportError {
  return error instanceof RuntimeDaemonTransportError;
}

/** Pending RPC failure enriched with the same facts published by the lifecycle stream. */
export class RuntimeDaemonDisconnectError extends Error {
  constructor(
    message: string,
    readonly code: RuntimeDaemonDisconnectCode,
    readonly connectionId: string,
    readonly reconnectable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeDaemonDisconnectError';
  }
}

export function isRuntimeDaemonDisconnectError(
  error: unknown,
): error is RuntimeDaemonDisconnectError {
  return error instanceof RuntimeDaemonDisconnectError;
}

export function defaultRuntimeDaemonEndpoint(
  profile = 'default',
  homeDir?: string,
): RuntimeDaemonEndpoint {
  const normalized = normalizeRuntimeDaemonProfile(profile);
  const scopedProfile = homeDir === undefined
    ? normalized
    : `${normalized}-${shortPathHash(path.resolve(homeDir))}`;
  if (process.platform === 'win32') {
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\kodax-runtime-${scopedProfile}`,
    };
  }
  return {
    kind: 'unix',
    path: path.join(
      os.tmpdir(),
      `kodax-runtime-${process.getuid?.() ?? 'user'}-${scopedProfile}.sock`,
    ),
  };
}

function shortPathHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function createRuntimeDaemonFrameParser(
  onFrame: (frame: RuntimeDaemonFrame) => void,
  options: RuntimeDaemonFrameParserOptions = {},
): RuntimeDaemonFrameParser {
  let buffer = '';
  let bufferBytes = 0;
  let decoder = new StringDecoder('utf8');
  const maxFrameBytes = options.maxFrameBytes ?? RUNTIME_DAEMON_MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new Error('Runtime daemon maxFrameBytes must be a positive safe integer.');
  }
  const consumeLine = (line: string): void => {
    assertFrameSize(line, maxFrameBytes);
    if (!line.trim()) return;
    onFrame(parseRuntimeDaemonFrame(line));
  };
  const append = (text: string): void => {
    buffer += text;
    bufferBytes += Buffer.byteLength(text, 'utf8');
  };
  return {
    push(chunk) {
      if (typeof chunk === 'string') {
        append(decoder.end());
        decoder = new StringDecoder('utf8');
        append(chunk);
      } else {
        append(decoder.write(chunk));
      }
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        const consumed = buffer.slice(0, newline + 1);
        buffer = buffer.slice(newline + 1);
        bufferBytes -= Buffer.byteLength(consumed, 'utf8');
        consumeLine(line);
      }
      assertFrameByteSize(bufferBytes, maxFrameBytes);
    },
    flush() {
      append(decoder.end());
      decoder = new StringDecoder('utf8');
      const tail = buffer.trim();
      buffer = '';
      bufferBytes = 0;
      if (tail.length > 0) consumeLine(tail);
    },
  };
}

export async function createRuntimeDaemonSocketClientTransport(
  endpoint: RuntimeDaemonEndpoint,
  options: RuntimeDaemonSocketClientTransportOptions = {},
): Promise<RuntimeDaemonClientTransport> {
  const socket = net.createConnection(endpoint.path);
  socket.setEncoding('utf8');
  const socketClosed = new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
  });

  await waitForConnect(socket, options.connectTimeoutMs);

  const maxFrameBytes = options.maxFrameBytes ?? RUNTIME_DAEMON_MAX_FRAME_BYTES;
  let closed = false;
  let journalEpoch: string | undefined;
  const clientInstanceId = `transport_${randomUUID().replace(/-/g, '')}`;
  const clientInstanceSecret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const connectionId = `connection_${randomUUID().replace(/-/g, '')}`;
  const listeners = new Set<(notification: RuntimeDaemonNotification) => void>();
  const lifecycleListeners = new Set<Parameters<NonNullable<
    RuntimeDaemonClientTransport['subscribeLifecycle']
  >>[0]>();
  let lifecycleState: RuntimeDaemonTransportLifecycleState = {
    state: 'connected' as const,
    connectionId,
    reconnectable: false,
  };
  let disconnectError: RuntimeDaemonDisconnectError | undefined;
  const disconnect = (
    code: RuntimeDaemonDisconnectCode,
    reason: string,
    reconnectable: boolean,
    cause?: Error,
  ): RuntimeDaemonDisconnectError => {
    if (disconnectError !== undefined) return disconnectError;
    disconnectError = new RuntimeDaemonDisconnectError(
      reason,
      code,
      connectionId,
      reconnectable,
      cause === undefined ? undefined : { cause },
    );
    lifecycleState = {
      state: 'disconnected',
      connectionId,
      code,
      reason,
      reconnectable,
    };
    for (const listener of lifecycleListeners) {
      try {
        listener(lifecycleState);
      } catch {
        emitKodaXDiagnostic({
          source: 'runtime.daemon.transport',
          level: 'warn',
          message: 'Runtime transport lifecycle listener failed.',
        });
      }
    }
    return disconnectError;
  };
  const pending = new Map<string, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly cleanup: () => void;
  }>();
  const lateResults = new Map<string, {
    readonly deliver: (value: unknown) => void;
    readonly expiry: ReturnType<typeof setTimeout>;
  }>();
  const removeLateResult = (id: string): ((value: unknown) => void) | undefined => {
    const retained = lateResults.get(id);
    if (retained === undefined) return undefined;
    lateResults.delete(id);
    clearTimeout(retained.expiry);
    return retained.deliver;
  };
  const clearLateResults = (): void => {
    for (const retained of lateResults.values()) {
      clearTimeout(retained.expiry);
    }
    lateResults.clear();
  };
  let supportsRequestLifecycle = false;
  const sendRequestLifecycleFrame = (
    method: 'request.cancel' | 'request.ack',
    requestId: string,
  ): void => {
    if (!supportsRequestLifecycle || closed || socket.destroyed) return;
    const prefix = method === 'request.ack' ? 'ack' : 'cancel';
    const controlFrame = createRuntimeDaemonRequest(
      `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      method,
      { requestId },
    );
    socket.write(`${JSON.stringify(controlFrame)}\n`);
  };
  const parser = createRuntimeDaemonFrameParser((frame) => {
    if (isRuntimeDaemonSuccessResponse(frame)) {
      const item = pending.get(frame.id);
      if (item) {
        pending.delete(frame.id);
        item.cleanup();
        if (runtimeDaemonSupportsRequestLifecycle(frame.result)) {
          supportsRequestLifecycle = true;
        }
        sendRequestLifecycleFrame('request.ack', frame.id);
        item.resolve(frame.result);
        return;
      }
      const deliverLateResult = removeLateResult(frame.id);
      if (frame.id.startsWith('req_')) {
        sendRequestLifecycleFrame('request.cancel', frame.id);
      }
      if (deliverLateResult === undefined) return;
      try {
        deliverLateResult(frame.result);
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: 'runtime.daemon.transport',
          level: 'warn',
          message: 'Runtime daemon late-result handler failed.',
          detail: error,
        });
      }
      return;
    }
    if (isRuntimeDaemonErrorResponse(frame)) {
      if (!frame.id) return;
      const item = pending.get(frame.id);
      if (item) {
        pending.delete(frame.id);
        item.cleanup();
        item.reject(new RuntimeDaemonTransportError(
          frame.error.message,
          frame.error.code,
          frame.error.data,
        ));
        return;
      }
      removeLateResult(frame.id);
      return;
    }
    if (isRuntimeDaemonNotification(frame)) {
      for (const listener of listeners) {
        try {
          listener(frame);
        } catch {
          emitKodaXDiagnostic({
            source: 'runtime.daemon.transport',
            level: 'warn',
            message: 'Runtime transport notification listener failed.',
          });
        }
      }
    }
  }, { maxFrameBytes: options.maxFrameBytes });

  socket.on('data', (chunk) => {
    try {
      parser.push(chunk);
    } catch (error: unknown) {
      closed = true;
      const normalized = normalizeTransportError(error);
      const disconnected = disconnect(
        'invalid_frame',
        normalized.message,
        true,
        normalized,
      );
      rejectPending(pending, disconnected);
      clearLateResults();
      socket.destroy(normalized);
    }
  });
  socket.on('close', () => {
    closed = true;
    const error = disconnect(
      'protocol_closed',
      'Runtime daemon transport closed.',
      true,
    );
    rejectPending(pending, error);
    clearLateResults();
  });
  socket.on('error', (error) => {
    closed = true;
    const disconnected = disconnect('transport_error', error.message, true, error);
    rejectPending(pending, disconnected);
    clearLateResults();
  });

  return {
    request(method, params, operation, control) {
      if (closed) {
        return Promise.reject(disconnectError ?? new RuntimeDaemonDisconnectError(
          'Runtime daemon transport is closed.',
          'protocol_closed',
          connectionId,
          true,
        ));
      }
      const id = `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const requestParams = method === 'initialize' || method === 'runtime.initialize'
        ? withDurableOperationCapability(params, clientInstanceId, clientInstanceSecret)
        : params;
      const requestOperation = operation ?? (
        journalEpoch !== undefined && isRuntimeDaemonMutationMethod(method)
          ? {
              operationId: `op_${randomUUID().replace(/-/g, '')}`,
              journalEpoch,
            }
          : undefined
      );
      const frame = createRuntimeDaemonRequest(id, method, requestParams, requestOperation);
      let encoded: string;
      try {
        encoded = JSON.stringify(frame);
        assertFrameSize(encoded, maxFrameBytes);
      } catch (error: unknown) {
        if (isRuntimeDaemonTransportError(error)) return Promise.reject(error);
        return Promise.reject(new RuntimeDaemonTransportError(
          `Runtime daemon request params are not JSON-serializable: ${normalizeTransportError(error).message}`,
          'invalid_params',
        ));
      }
      let abort: (() => void) | undefined;
      let sent = false;
      const cleanup = (): void => {
        if (abort !== undefined) {
          control?.signal?.removeEventListener('abort', abort);
        }
      };
      const result = new Promise<unknown>((resolve, reject) => {
        const item = { resolve, reject, cleanup };
        pending.set(id, item);
        if (control?.signal !== undefined) {
          abort = () => {
            if (pending.get(id) !== item) return;
            pending.delete(id);
            cleanup();
            if (sent && !socket.destroyed) {
              sendRequestLifecycleFrame('request.cancel', id);
            }
            if (control.onLateResult !== undefined) {
              const expiry = setTimeout(() => {
                lateResults.delete(id);
              }, RUNTIME_DAEMON_LATE_RESULT_RETENTION_MS);
              expiry.unref?.();
              lateResults.set(id, {
                deliver: control.onLateResult,
                expiry,
              });
            }
            reject(normalizeTransportAbortReason(control.signal?.reason));
          };
          control.signal.addEventListener('abort', abort, { once: true });
          if (control.signal.aborted) abort();
        }
      });
      if (control?.signal?.aborted) return result;
      socket.write(`${encoded}\n`);
      sent = true;
      return result.then((value) => {
        if (method === 'initialize' || method === 'runtime.initialize') {
          const initialized = asRecord(value);
          if (typeof initialized?.journalEpoch === 'string') {
            journalEpoch = initialized.journalEpoch;
          }
        }
        return value;
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      const subscription: RuntimeSubscription = {
        close() {
          listeners.delete(listener);
        },
      };
      return subscription;
    },
    subscribeLifecycle(listener) {
      lifecycleListeners.add(listener);
      listener(lifecycleState);
      return {
        close() {
          lifecycleListeners.delete(listener);
        },
      };
    },
    async close() {
      let flushError: Error | undefined;
      if (!closed) {
        closed = true;
        const error = disconnect(
          'client_closed',
          'Runtime daemon transport closed by client.',
          false,
        );
        try {
          parser.flush();
        } catch (error: unknown) {
          flushError = normalizeTransportError(error);
        }
        socket.end();
        socket.destroy();
        rejectPending(pending, error);
        clearLateResults();
      }
      await socketClosed;
      lifecycleListeners.clear();
      if (flushError !== undefined) throw flushError;
    },
  };
}

function withDurableOperationCapability(
  value: unknown,
  instanceId: string,
  instanceSecret: string,
): Record<string, unknown> {
  const params = asRecord(value) ?? {};
  const capabilities = asRecord(params.capabilities) ?? {};
  const clientInfo = asRecord(params.clientInfo) ?? { name: 'kodax-transport' };
  return {
    ...params,
    capabilities: { ...capabilities, operationDeduplication: true },
    clientInfo: {
      ...clientInfo,
      instanceId: typeof clientInfo.instanceId === 'string'
        ? clientInfo.instanceId
        : instanceId,
      instanceSecret: typeof clientInfo.instanceSecret === 'string'
        ? clientInfo.instanceSecret
        : instanceSecret,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function runtimeDaemonSupportsRequestLifecycle(value: unknown): boolean {
  const initialized = asRecord(value);
  const capabilities = asRecord(initialized?.capabilities);
  const lifecycle = asRecord(capabilities?.runLifecycleControl);
  return Number.isSafeInteger(lifecycle?.version)
    && Number(lifecycle?.version) >= 1
    && lifecycle.structuredStopReceipt === true
    && lifecycle.protocolCancellation === true
    && lifecycle.responseAcknowledgement === true;
}

export async function createRuntimeDaemonSocketServer(
  options: RuntimeDaemonSocketServerOptions,
): Promise<RuntimeDaemonSocketServer> {
  await prepareUnixSocketEndpoint(options.endpoint);

  const server = net.createServer();
  const sockets = new Set<net.Socket>();
  const dispatchers = new Set<RuntimeDaemonDispatcher>();
  let closed = false;

  server.on('connection', (socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let rejectedFrame = false;

    const send = (frame: RuntimeDaemonFrame): void => {
      if (socket.destroyed) return;
      let encoded: string;
      try {
        encoded = JSON.stringify(frame);
      } catch (error: unknown) {
        const fallback = createRuntimeDaemonErrorResponse({
          code: 'internal_error',
          message: `Runtime daemon response is not JSON-serializable: ${normalizeTransportError(error).message}`,
        }, frame.kind === 'response' || frame.kind === 'error' ? frame.id : undefined);
        encoded = JSON.stringify(fallback);
      }
      socket.write(`${encoded}\n`);
    };
    const dispatcher = options.createDispatcher(
      (notification) => send(notification),
      () => socket.destroy(),
    );
    dispatchers.add(dispatcher);
    const parser = createRuntimeDaemonFrameParser((frame) => {
      if (isRuntimeDaemonRequest(frame)) {
        void dispatcher.handle(frame).then(send, (error: unknown) => {
          send(createRuntimeDaemonErrorResponse({
            code: 'internal_error',
            message: normalizeTransportError(error).message,
          }));
        });
        return;
      }
      if (isRuntimeDaemonErrorResponse(frame)) {
        send(frame);
        return;
      }
      send(createRuntimeDaemonErrorResponse({
        code: 'invalid_request',
        message: 'Runtime daemon server expects request frames from clients.',
      }));
    }, { maxFrameBytes: options.maxFrameBytes });

    const rejectInvalidFrame = (error: unknown): void => {
      if (rejectedFrame) return;
      rejectedFrame = true;
      const normalized = normalizeTransportError(error);
      send(createRuntimeDaemonErrorResponse({
        code: 'invalid_frame',
        message: normalized.message,
        ...(isRuntimeDaemonTransportError(normalized) && normalized.data !== undefined
          ? { data: normalized.data }
          : {}),
      }));
      socket.end();
    };
    socket.on('data', (chunk) => {
      if (rejectedFrame) return;
      try {
        parser.push(chunk);
      } catch (error: unknown) {
        rejectInvalidFrame(error);
      }
    });
    socket.on('end', () => {
      try {
        parser.flush();
      } catch (error: unknown) {
        rejectInvalidFrame(error);
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
      dispatchers.delete(dispatcher);
      dispatcher.close();
    });
    socket.on('error', () => {
      socket.destroy();
    });
  });

  await waitForListen(server, options.endpoint.path);
  if (options.endpoint.kind === 'unix') {
    try {
      await fs.chmod(options.endpoint.path, 0o600);
    } catch (error: unknown) {
      await closeNetServer(server);
      throw error;
    }
  }

  return {
    endpoint: options.endpoint,
    connectionCount() {
      return sockets.size;
    },
    unref() {
      server.unref();
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const dispatcher of dispatchers) {
        dispatcher.close();
      }
      dispatchers.clear();
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await closeNetServer(server);
    },
  };
}

function assertFrameSize(frame: string, maxFrameBytes: number): void {
  assertFrameByteSize(Buffer.byteLength(frame, 'utf8'), maxFrameBytes);
}

function assertFrameByteSize(actualBytes: number, maxFrameBytes: number): void {
  if (actualBytes <= maxFrameBytes) return;
  throw new RuntimeDaemonTransportError(
    `Runtime daemon frame exceeds the ${maxFrameBytes}-byte limit.`,
    'invalid_frame',
    { actualBytes, maxFrameBytes },
  );
}

function waitForConnect(socket: net.Socket, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error('Timed out connecting to runtime daemon.'));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function waitForListen(server: net.Server, endpointPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(endpointPath);
  });
}

async function prepareUnixSocketEndpoint(endpoint: RuntimeDaemonEndpoint): Promise<void> {
  if (endpoint.kind !== 'unix') return;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(endpoint.path);
  } catch (error: unknown) {
    if (isNodeFileError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isSocket()) {
    throw new Error(`Runtime daemon Unix endpoint exists and is not a socket: ${endpoint.path}`);
  }
  if (await unixSocketAcceptsConnections(endpoint.path)) {
    throw new Error(`Runtime daemon Unix endpoint is already accepting connections: ${endpoint.path}`);
  }
  try {
    await fs.unlink(endpoint.path);
  } catch (error: unknown) {
    if (!isNodeFileError(error) || error.code !== 'ENOENT') throw error;
  }
}

function unixSocketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`Timed out probing runtime daemon Unix endpoint: ${socketPath}`));
    }, 250);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const onConnect = (): void => {
      cleanup();
      socket.end();
      socket.destroy();
      resolve(true);
    };
    const onError = (error: Error): void => {
      cleanup();
      socket.destroy();
      if (isNodeFileError(error) && (error.code === 'ECONNREFUSED' || error.code === 'ENOENT')) {
        resolve(false);
        return;
      }
      reject(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function closeNetServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function rejectPending(
  pending: Map<string, {
    readonly reject: (error: Error) => void;
    readonly cleanup: () => void;
  }>,
  error: Error,
): void {
  for (const item of pending.values()) {
    item.cleanup();
    item.reject(error);
  }
  pending.clear();
}

function normalizeTransportAbortReason(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('Runtime daemon request cancelled.');
}

function normalizeTransportError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNodeFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
