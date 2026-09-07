import { Worker, type ResourceLimits } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import type { RuntimeSubscription } from '../sdk-runtime.js';
import type {
  RuntimeDaemonClientTransport,
  RuntimeDaemonRequestControl,
} from '../runtime-daemon/client.js';
import {
  createRuntimeDaemonRequest,
  isRuntimeDaemonErrorResponse,
  isRuntimeDaemonNotification,
  isRuntimeDaemonSuccessResponse,
  type RuntimeDaemonNotification,
} from '../runtime-daemon/protocol.js';
import type {
  RuntimeWorkerBootstrapOptions,
  RuntimeWorkerOptions,
} from './protocol.js';

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

const WORKER_LATE_RESULT_RETENTION_MS = 30_000;

export interface RuntimeWorkerTransportHandle {
  readonly transport: RuntimeDaemonClientTransport;
  readonly threadId: number;
  terminate(): Promise<void>;
}

export function createRuntimeWorkerTransport(
  bootstrap: RuntimeWorkerBootstrapOptions,
  options: RuntimeWorkerOptions = {},
): RuntimeWorkerTransportHandle {
  const workerUrl = resolveRuntimeWorkerUrl();
  const worker = new Worker(workerUrl, {
    workerData: bootstrap,
    execArgv: workerUrl.href.endsWith('.ts') ? ['--import', 'tsx'] : [],
    ...(options.resourceLimits !== undefined
      ? { resourceLimits: options.resourceLimits as ResourceLimits }
      : {}),
  });
  const pending = new Map<string, PendingRequest>();
  const lateResults = new Map<string, {
    readonly deliver: (value: unknown) => void;
    readonly expiry: ReturnType<typeof setTimeout>;
  }>();
  const listeners = new Set<(notification: RuntimeDaemonNotification) => void>();
  let requestSequence = 0;
  let closed = false;

  const rejectPending = (error: Error): void => {
    for (const entry of pending.values()) {
      entry.cleanup();
      entry.reject(error);
    }
    pending.clear();
  };
  const clearLateResults = (): void => {
    for (const retained of lateResults.values()) clearTimeout(retained.expiry);
    lateResults.clear();
  };
  const removeLateResult = (id: string): ((value: unknown) => void) | undefined => {
    const retained = lateResults.get(id);
    if (retained === undefined) return undefined;
    lateResults.delete(id);
    clearTimeout(retained.expiry);
    return retained.deliver;
  };
  const markClosed = (error: Error): void => {
    if (closed) return;
    closed = true;
    rejectPending(error);
    clearLateResults();
    listeners.clear();
  };
  const sendRequestLifecycleFrame = (
    method: 'request.cancel' | 'request.ack',
    requestId: string,
  ): void => {
    if (closed) return;
    const prefix = method === 'request.ack' ? 'ack' : 'cancel';
    try {
      worker.postMessage(createRuntimeDaemonRequest(
        `worker_${prefix}_${++requestSequence}`,
        method,
        { requestId },
      ));
    } catch (error: unknown) {
      emitKodaXDiagnostic({
        source: 'runtime.worker.transport',
        level: 'warn',
        message: `Failed to send Worker ${method} lifecycle frame.`,
        detail: error,
      });
    }
  };

  worker.on('message', (message: unknown) => {
    if (isRuntimeDaemonNotification(message)) {
      for (const listener of listeners) listener(message);
      return;
    }
    if (!isRuntimeDaemonSuccessResponse(message) && !isRuntimeDaemonErrorResponse(message)) return;
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) {
      if (isRuntimeDaemonSuccessResponse(message)) {
        const deliver = removeLateResult(message.id);
        if (deliver !== undefined) {
          try {
            deliver(message.result);
          } catch (error: unknown) {
            emitKodaXDiagnostic({
              source: 'runtime.worker.transport',
              level: 'warn',
              message: 'Runtime Worker late-result handler failed.',
              detail: error,
            });
          }
        }
      } else {
        removeLateResult(message.id);
      }
      return;
    }
    pending.delete(message.id);
    entry.cleanup();
    if (isRuntimeDaemonSuccessResponse(message)) {
      sendRequestLifecycleFrame('request.ack', message.id);
      entry.resolve(message.result);
      return;
    }
    const error = new Error(message.error.message) as Error & { code?: string; data?: unknown };
    error.code = message.error.code;
    if (message.error.data !== undefined) error.data = message.error.data;
    entry.reject(error);
  });
  worker.on('error', (error) => markClosed(error));
  worker.on('exit', (code) => markClosed(new Error(`Runtime Worker exited with code ${code}.`)));

  const transport: RuntimeDaemonClientTransport = {
    request(method, params, control) {
      if (closed) return Promise.reject(new Error('Runtime Worker transport is closed.'));
      const id = `worker_${++requestSequence}`;
      let abort: (() => void) | undefined;
      let sent = false;
      const cleanup = (): void => {
        if (abort !== undefined) {
          control?.signal?.removeEventListener('abort', abort);
        }
      };
      const result = new Promise<unknown>((resolve, reject) => {
        const entry = { resolve, reject, cleanup };
        pending.set(id, entry);
        abort = attachWorkerRequestAbort(control, () => {
          if (pending.get(id) !== entry) return;
          pending.delete(id);
          cleanup();
          if (sent) sendRequestLifecycleFrame('request.cancel', id);
          if (control?.onLateResult !== undefined) {
            const expiry = setTimeout(() => {
              lateResults.delete(id);
            }, WORKER_LATE_RESULT_RETENTION_MS);
            expiry.unref?.();
            lateResults.set(id, {
              deliver: control.onLateResult,
              expiry,
            });
          }
          reject(normalizeWorkerAbortReason(control?.signal?.reason));
        });
      });
      if (control?.signal?.aborted) return result;
      try {
        worker.postMessage(createRuntimeDaemonRequest(id, method, params));
        sent = true;
      } catch (error: unknown) {
        const entry = pending.get(id);
        if (entry !== undefined) {
          pending.delete(id);
          entry.cleanup();
          entry.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      return result;
    },
    subscribe(listener): RuntimeSubscription {
      if (closed) return { close() {} };
      listeners.add(listener);
      return { close: () => listeners.delete(listener) };
    },
    async close() {
      if (closed) return;
      markClosed(new Error('Runtime Worker transport closed.'));
      await worker.terminate();
    },
  };

  return {
    transport,
    threadId: worker.threadId,
    async terminate() {
      if (!closed) markClosed(new Error('Runtime Worker terminated.'));
      await worker.terminate();
    },
  };
}

function attachWorkerRequestAbort(
  control: RuntimeDaemonRequestControl | undefined,
  onAbort: () => void,
): (() => void) | undefined {
  const signal = control?.signal;
  if (signal === undefined) return undefined;
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  return onAbort;
}

function normalizeWorkerAbortReason(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('Runtime Worker request cancelled.');
}

function resolveRuntimeWorkerUrl(): URL {
  if (import.meta.url.endsWith('.ts')) {
    const compiled = new URL('../../dist/runtime-worker.js', import.meta.url);
    if (existsSync(fileURLToPath(compiled))) return compiled;
    return new URL('./entry.ts', import.meta.url);
  }
  if (process.env.KODAX_BUNDLED === 'true') {
    return pathToFileURL(join(dirname(process.execPath), 'runtime-worker.js'));
  }
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const sidecarDir = basename(currentDir) === 'chunks' ? dirname(currentDir) : currentDir;
  return pathToFileURL(join(sidecarDir, 'runtime-worker.js'));
}
