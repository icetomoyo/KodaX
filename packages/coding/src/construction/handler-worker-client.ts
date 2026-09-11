import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { KodaXToolExecutionContext } from '../types.js';
import type { ToolResult } from '../tools/types.js';
import { CapabilityDeniedError, type Capabilities } from './types.js';
import { createCtxProxy, type CreateCtxProxyOptions } from './ctx-proxy.js';
import {
  serializeHandlerWorkerError,
  type HandlerWorkerBootstrap,
  type HandlerWorkerError,
  type HandlerWorkerResponse,
} from './handler-worker-protocol.js';

interface WorkerInvocation {
  readonly id: number;
  readonly proxy: { readonly tools: Record<string, (input?: unknown) => Promise<ToolResult>> };
  readonly resolve: (value: ToolResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbortListener?: () => void;
}

interface HandlerWorkerState {
  readonly worker: Worker;
  readonly ready: Promise<void>;
  invocation?: WorkerInvocation;
}

interface HandlerWorkerEntry {
  readonly key: string;
  readonly moduleUrl: string;
  readonly label: string;
  readonly capabilities: Capabilities;
  readonly timeoutMs: number;
  readonly ctxProxyOptions?: CreateCtxProxyOptions;
  state?: HandlerWorkerState;
  disposed: boolean;
  tail: Promise<void>;
}

const entries = new Map<string, HandlerWorkerEntry>();
let nextInvocationId = 0;

export async function prepareConstructedHandlerWorker(input: {
  readonly key: string;
  readonly moduleUrl: string;
  readonly label: string;
  readonly capabilities: Capabilities;
  readonly timeoutMs: number;
  readonly ctxProxyOptions?: CreateCtxProxyOptions;
}): Promise<(toolInput: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>> {
  await disposeConstructedHandlerWorker(input.key);
  const entry: HandlerWorkerEntry = {
    ...input,
    disposed: false,
    tail: Promise.resolve(),
  };
  entries.set(input.key, entry);
  try {
    await getWorkerState(entry).ready;
  } catch (error: unknown) {
    await disposeConstructedHandlerWorker(input.key);
    throw error;
  }
  return (toolInput, ctx) => enqueueInvocation(entry, toolInput, ctx);
}

export async function disposeConstructedHandlerWorker(key: string): Promise<void> {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  entry.disposed = true;
  const state = entry.state;
  entry.state = undefined;
  if (!state) return;
  rejectInvocation(state, new Error(`Constructed handler '${entry.label}' was disposed.`));
  await state.worker.terminate();
}

export async function shutdownConstructedHandlerWorkersForTest(): Promise<void> {
  await Promise.all([...entries.keys()].map(disposeConstructedHandlerWorker));
}

function enqueueInvocation(
  entry: HandlerWorkerEntry,
  input: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolResult> {
  const run = entry.tail.then(() => invoke(entry, input, ctx));
  entry.tail = run.then(() => undefined, () => undefined);
  return run;
}

async function invoke(
  entry: HandlerWorkerEntry,
  input: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolResult> {
  assertHandlerWorkerEntryActive(entry);
  const state = getWorkerState(entry);
  await state.ready;
  assertHandlerWorkerEntryActive(entry);
  state.worker.ref();
  const proxy = createCtxProxy(ctx, entry.capabilities, entry.ctxProxyOptions) as {
    readonly tools: Record<string, (input?: unknown) => Promise<ToolResult>>;
  };
  const invocationId = ++nextInvocationId;
  return new Promise<ToolResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      void terminateTimedOutInvocation(entry, state, invocationId);
    }, entry.timeoutMs);
    const abortSignal = readAbortSignal(ctx);
    const forwardAbort = (): void => {
      postWorkerMessage(state.worker, { kind: 'abort', invocationId });
    };
    if (abortSignal && !abortSignal.aborted) {
      abortSignal.addEventListener('abort', forwardAbort, { once: true });
    }
    state.invocation = {
      id: invocationId,
      proxy,
      resolve,
      reject,
      timer,
      ...(abortSignal ? {
        removeAbortListener: () => abortSignal.removeEventListener('abort', forwardAbort),
      } : {}),
    };
    try {
      state.worker.postMessage({
        kind: 'invoke',
        invocationId,
        input,
        context: cloneWorkerContext(ctx),
      });
      if (abortSignal?.aborted) forwardAbort();
    } catch (error: unknown) {
      state.invocation?.removeAbortListener?.();
      state.invocation = undefined;
      clearTimeout(timer);
      state.worker.unref();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function getWorkerState(entry: HandlerWorkerEntry): HandlerWorkerState {
  assertHandlerWorkerEntryActive(entry);
  if (entry.state) return entry.state;
  const workerUrl = resolveHandlerWorkerUrl();
  const worker = new Worker(workerUrl, {
    workerData: {
      moduleUrl: entry.moduleUrl,
      label: entry.label,
    } satisfies HandlerWorkerBootstrap,
    execArgv: workerUrl.href.endsWith('.ts') ? ['--import', 'tsx'] : [],
  });
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const state: HandlerWorkerState = {
    worker,
    ready: new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    }),
  };
  entry.state = state;
  worker.on('message', (message: HandlerWorkerResponse) => {
    if (message.kind === 'ready') {
      worker.unref();
      resolveReady();
    } else if (message.kind === 'bootstrap_error') {
      rejectReady(errorFromWorker(message.error));
    } else if (message.kind === 'tool_call') {
      void dispatchToolCall(state, message);
    } else if (message.kind === 'result') {
      settleInvocation(state, message.invocationId, message.result, message.error);
    }
  });
  worker.on('error', (error) => {
    rejectReady(error);
    failWorker(entry, state, error);
  });
  worker.on('exit', (code) => {
    const error = new Error(`Constructed handler Worker exited with code ${code}.`);
    rejectReady(error);
    failWorker(entry, state, error);
  });
  return state;
}

function assertHandlerWorkerEntryActive(entry: HandlerWorkerEntry): void {
  if (!entry.disposed) return;
  throw new Error(`Constructed handler '${entry.label}' was disposed.`);
}

async function dispatchToolCall(
  state: HandlerWorkerState,
  message: Extract<HandlerWorkerResponse, { kind: 'tool_call' }>,
): Promise<void> {
  const invocation = state.invocation;
  if (!invocation || invocation.id !== message.invocationId) return;
  try {
    const tool = invocation.proxy.tools[message.toolName];
    const result = await tool(message.input);
    postWorkerMessage(state.worker, { kind: 'tool_result', callId: message.callId, result });
  } catch (error: unknown) {
    postWorkerMessage(state.worker, {
      kind: 'tool_result',
      callId: message.callId,
      error: serializeHandlerWorkerError(error),
    });
  }
}

function settleInvocation(
  state: HandlerWorkerState,
  invocationId: number,
  result: ToolResult | undefined,
  error: HandlerWorkerError | undefined,
): void {
  const invocation = state.invocation;
  if (!invocation || invocation.id !== invocationId) return;
  state.invocation = undefined;
  clearTimeout(invocation.timer);
  invocation.removeAbortListener?.();
  state.worker.unref();
  if (error) invocation.reject(errorFromWorker(error));
  else invocation.resolve(result ?? '');
}

async function terminateTimedOutInvocation(
  entry: HandlerWorkerEntry,
  state: HandlerWorkerState,
  invocationId: number,
): Promise<void> {
  const invocation = state.invocation;
  if (!invocation || invocation.id !== invocationId) return;
  state.invocation = undefined;
  invocation.removeAbortListener?.();
  if (entry.state === state) entry.state = undefined;
  try {
    await state.worker.terminate();
  } finally {
    invocation.reject(new Error(
      `Constructed handler '${entry.label}' timed out after ${entry.timeoutMs}ms and its Worker was terminated.`,
    ));
  }
}

function rejectInvocation(state: HandlerWorkerState, error: Error): void {
  const invocation = state.invocation;
  if (!invocation) return;
  state.invocation = undefined;
  clearTimeout(invocation.timer);
  invocation.removeAbortListener?.();
  invocation.reject(error);
}

function failWorker(entry: HandlerWorkerEntry, state: HandlerWorkerState, error: Error): void {
  if (entry.state === state) entry.state = undefined;
  rejectInvocation(state, error);
}

function cloneWorkerContext(ctx: unknown): Record<string, unknown> {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (typeof value === 'function' || key === 'abortSignal' || key === 'extensionRuntime') continue;
    try {
      result[key] = structuredClone(value);
    } catch {
      // Non-cloneable host bindings stay in the parent; tool calls use reverse RPC.
    }
  }
  return result;
}

function readAbortSignal(ctx: unknown): AbortSignal | undefined {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx) || !('abortSignal' in ctx)) return undefined;
  const signal = (ctx as { readonly abortSignal?: unknown }).abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function errorFromWorker(input: HandlerWorkerError): Error {
  const error = new Error(input.message);
  error.name = input.name;
  if (input.stack) error.stack = input.stack;
  if (input.code !== undefined) Object.assign(error, { code: input.code });
  if (input.name === 'CapabilityDeniedError') {
    Object.setPrototypeOf(error, CapabilityDeniedError.prototype);
  }
  return error;
}

function postWorkerMessage(worker: Worker, message: unknown): void {
  try {
    worker.postMessage(message);
  } catch {
    // The timeout/exit path already owns settlement for the active invocation.
  }
}

export function resolveHandlerWorkerUrl(options: {
  readonly moduleUrl?: string;
  readonly bundled?: boolean;
  readonly executablePath?: string;
} = {}): URL {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  if (moduleUrl.endsWith('.ts')) {
    const compiled = new URL('../../dist/construction/handler-worker.js', moduleUrl);
    if (existsSync(fileURLToPath(compiled))) return compiled;
    return new URL('./handler-worker.ts', moduleUrl);
  }
  if ((options.bundled ?? process.env.KODAX_BUNDLED === 'true')) {
    return pathToFileURL(join(
      dirname(options.executablePath ?? process.execPath),
      'constructed-handler-worker.js',
    ));
  }
  const currentDir = dirname(fileURLToPath(moduleUrl));
  if (basename(currentDir) === 'chunks') {
    return pathToFileURL(join(dirname(currentDir), 'constructed-handler-worker.js'));
  }
  if (basename(currentDir) === 'construction') {
    return new URL('./handler-worker.js', moduleUrl);
  }
  return pathToFileURL(join(currentDir, 'constructed-handler-worker.js'));
}
