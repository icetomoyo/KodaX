import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { RunnerToolResult } from '@kodax-ai/agent';

export interface ScriptCellLimits {
  readonly timeoutMs: number;
  readonly memoryBytes: number;
  readonly maxCalls: number;
  readonly maxTransferBytes: number;
}
export interface ScriptReceipt {
  readonly id: number;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly result: RunnerToolResult;
}
export interface ScriptCellResult {
  readonly status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  readonly value?: unknown;
  readonly error?: string;
  readonly receipts: readonly ScriptReceipt[];
  readonly hadToolErrors: boolean;
}
export interface ScriptCellInput {
  readonly code: string;
  readonly toolNames: readonly string[];
  readonly limits: ScriptCellLimits;
  readonly signal?: AbortSignal;
  /** Host-owned checked dispatcher. Must settle only after the leaf and its cancellation cleanup settle. */
  readonly invoke: (name: string, input: Record<string, unknown>, signal: AbortSignal, id: number) => Promise<RunnerToolResult>;
  /** Required host boundaries, awaited before effects and before the guest can continue. */
  readonly onCall?: (call: Omit<ScriptReceipt, 'result'>) => Promise<void>;
  readonly onReceipt?: (receipt: ScriptReceipt) => Promise<void>;
}

export function validateScriptCell(code: string, limits: ScriptCellLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Script limits must be positive safe integers.');
  }
  if (Buffer.byteLength(code) > limits.maxTransferBytes) throw new Error('Script source exceeds the transfer limit.');
}

/** Internal VM primitive; the host owns Session persistence and Run activation. */
export async function runScriptCell(input: ScriptCellInput): Promise<ScriptCellResult> {
  validateScriptCell(input.code, input.limits);
  const receipts: ScriptReceipt[] = [];
  if (input.signal?.aborted) return { status: 'cancelled', receipts, hadToolErrors: false };
  const require = createRequire(import.meta.url);
  const sourceMode = import.meta.url.endsWith('.ts');
  // Load a real module: transpilers may add closure helpers, making function.toString unsafe to relocate.
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    (async () => {
      const entry = workerData.loaderUrl
        ? await (await import(workerData.loaderUrl)).tsImport(workerData.workerUrl, workerData.workerUrl)
        : await import(workerData.workerUrl);
      await entry.scriptWorkerMain();
    })().catch(error => { throw error; });`, {
    eval: true, env: { TSX_DISABLE_CACHE: '1' }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 },
    workerData: { ...input.limits, code: input.code, toolNames: input.toolNames,
      workerUrl: resolveScriptWorkerUrl().href,
      loaderUrl: sourceMode ? pathToFileURL(require.resolve('tsx/esm/api')).href : undefined },
  });
  const controller = new AbortController();
  const allowed = new Set(input.toolNames);
  let tail = Promise.resolve();
  let calls = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let finish!: (result: Omit<ScriptCellResult, 'receipts' | 'hadToolErrors'>) => void;
  const onAbort = (): void => finish({ status: 'cancelled', error: 'Script cancelled; inspect settled receipts before retrying.' });
  const outcome = new Promise<Omit<ScriptCellResult, 'receipts' | 'hadToolErrors'>>(resolve => {
    finish = result => {
      if (stopped) return;
      stopped = true;
      if (result.status !== 'completed') controller.abort();
      resolve(result);
    };
    timer = setTimeout(() => finish({ status: 'timed_out', error: 'Script deadline exceeded; inspect settled receipts before retrying.' }), input.limits.timeoutMs);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    worker.on('error', error => finish({ status: 'failed', error: error.message }));
    worker.on('exit', code => finish({ status: 'failed', error: `Script worker exited before completion (${code}).` }));
    worker.on('message', (message: { kind: string; id: number; name: string; input: string; value?: unknown; error?: string }) => {
      if (stopped) return;
      if (message.kind === 'done') { finish({ status: 'completed', value: message.value }); return; }
      if (message.kind === 'failed') { finish({ status: 'failed', error: message.error }); return; }
      if (message.kind !== 'call') { finish({ status: 'failed', error: 'Invalid Script worker message.' }); return; }
      if (++calls > input.limits.maxCalls) { finish({ status: 'failed', error: 'Script tool-call limit exceeded.' }); return; }
      // Phase C deliberately serializes leaves, including Promise.all: no new write ordering policy.
      tail = tail.then(async () => {
        if (controller.signal.aborted) return;
        let parameters: Record<string, unknown> = {};
        let result: RunnerToolResult | undefined;
        try {
          if (!allowed.has(message.name)) throw new Error(`Tool ${message.name} is outside this Script cell.`);
          if (Buffer.byteLength(message.input) > input.limits.maxTransferBytes) throw new Error('Script tool input exceeds the transfer limit.');
          const parsed: unknown = JSON.parse(message.input);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool input must be a JSON object.');
          parameters = parsed as Record<string, unknown>;
        } catch (error) { result = { content: `[Tool Error] ${String(error)}`, isError: true }; }
        if (!result) {
          await input.onCall?.({ id: message.id, name: message.name, input: parameters });
          if (controller.signal.aborted) return;
          try { result = await input.invoke(message.name, parameters, controller.signal, message.id); }
          catch (error) { result = { content: `[Tool Error] ${String(error)}`, isError: true }; }
        }
        receipts.push({ id: message.id, name: message.name, input: parameters, result });
        const encoded = encodeScriptResult(result);
        await input.onReceipt?.(receipts.at(-1)!);
        if (Buffer.byteLength(encoded) > input.limits.maxTransferBytes) {
          finish({ status: 'failed', error: 'Tool result exceeds the Script transfer limit; full result retained in host receipts.' });
        } else if (!stopped) worker.postMessage({ id: message.id, result: encoded });
      }).catch(error => finish({ status: 'failed', error: String(error) }));
    });
  });
  try {
    const result = await outcome;
    await worker.terminate();
    // Never report cancellation complete while a host tool can still mutate files.
    await tail;
    return { ...result, receipts, hadToolErrors: receipts.some(receipt => receipt.result.isError === true) };
  } finally {
    clearTimeout(timer!); input.signal?.removeEventListener('abort', onAbort);
  }
}

/** Same sidecar layout as existing isolated workers; no ambient module lookup in a bundle. */
export function resolveScriptWorkerUrl(moduleUrl = import.meta.url): URL {
  if (moduleUrl.endsWith('.ts')) return new URL('./worker.ts', moduleUrl);
  if (process.env.KODAX_BUNDLED === 'true') return pathToFileURL(join(dirname(process.execPath), 'script-worker.cjs'));
  const directory = dirname(fileURLToPath(moduleUrl));
  if (basename(directory) === 'script') return new URL('./worker.js', moduleUrl);
  return pathToFileURL(join(basename(directory) === 'chunks' ? dirname(directory) : directory, 'script-worker.cjs'));
}

/** Do not let JSON silently erase process-local metadata or turn non-finite numbers into null. */
function encodeScriptResult(result: RunnerToolResult): string {
  const ancestors = new Set<object>();
  function check(value: unknown): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) return;
    if (typeof value !== 'object' || ancestors.has(value)
      || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || Object.getOwnPropertySymbols(value).length > 0) throw new Error('Script tool results must be acyclic JSON DTOs.');
    ancestors.add(value);
    for (const child of Object.values(value)) check(child);
    ancestors.delete(value);
  }
  check(result);
  return JSON.stringify(result);
}
