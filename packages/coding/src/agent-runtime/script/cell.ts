import { staticText } from '../../prompts/static-text.js';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';
import type { RunnerToolResult } from '@kodax-ai/agent';
import type { ToolResultData, ToolResultProjection } from '../../types.js';
import { createScriptControlBudget } from './control.js';

export interface ScriptCellLimits {
  readonly timeoutMs: number;
  readonly memoryBytes: number;
  readonly maxCalls: number;
  readonly maxTransferBytes: number;
}
export interface ScriptToolResult extends RunnerToolResult {
  readonly sourceContent?: ToolResultProjection['sourceContent'];
  readonly data?: ToolResultData;
}
export interface ScriptReceipt {
  readonly id: number;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly result: ScriptToolResult;
}
export interface ScriptCellResult {
  readonly cellId?: string;
  readonly status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  readonly value?: unknown;
  readonly error?: string;
  readonly receipts: readonly ScriptReceipt[];
  readonly hadToolErrors: boolean;
  readonly outputs?: readonly string[];
  readonly pendingCalls?: readonly (Omit<ScriptReceipt, 'result'> & { readonly status: 'pending' | 'unknown' })[];
}
/** Ephemeral Run-owned data; never serialized as a recovery checkpoint. */
export interface ScriptCellScope {
  readonly cellId?: string;
  readonly storedValues: Map<string, string>;
  readonly onReceipt?: (receipt: ScriptReceipt) => void;
  readonly onCall?: (call: Omit<ScriptReceipt, 'result'>) => void;
  readonly onOutput?: (text: string) => void;
  readonly onYield?: () => void;
}
export interface ScriptCellInput {
  readonly code: string;
  readonly toolNames: readonly string[];
  readonly limits: ScriptCellLimits;
  readonly signal?: AbortSignal;
  /** Host-owned checked dispatcher. Must settle only after the leaf and its cancellation cleanup settle. */
  readonly invoke: (name: string, input: Record<string, unknown>, signal: AbortSignal, id: number,
    admit: (parallel: boolean, canonical?: Omit<ScriptReceipt, 'result'>) => Promise<void>,
    prepare: (canonical: Omit<ScriptReceipt, 'result'>) => Promise<void>) => Promise<ScriptToolResult>;
  /** The checked dispatcher must await admit after canonical argument preparation and before execution. */
  readonly concurrentPreparation?: boolean;
  readonly storedValues?: ReadonlyMap<string, string>;
  readonly onStore?: (key: string, value: string | undefined) => void;
  readonly onOutput?: (text: string) => Promise<void>;
  readonly onYield?: () => void | Promise<void>;
  /** Required host boundaries, awaited before effects and before the guest can continue. */
  readonly onCall?: (call: Omit<ScriptReceipt, 'result'>) => Promise<void>;
  readonly onPrepared?: (call: Omit<ScriptReceipt, 'result'>) => Promise<void>;
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
  const outputs: string[] = [];
  const started: Omit<ScriptReceipt, 'result'>[] = [];
  const largeResults = new Map<number, string>();
  if (input.signal?.aborted) return { status: 'cancelled', receipts, hadToolErrors: false };
  const require = createRequire(import.meta.url);
  const sourceMode = import.meta.url.endsWith('.ts');
  // Load a real module: transpilers may add closure helpers, making function.toString unsafe to relocate.
  const worker = new Worker(staticText("t12.agent-runtime/script/cell.0"), {
    eval: true, env: { TSX_DISABLE_CACHE: '1' }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 },
    workerData: { ...input.limits, code: input.code, toolNames: input.toolNames, storedValues: [...input.storedValues ?? []],
      workerUrl: resolveScriptWorkerUrl().href,
      loaderUrl: sourceMode ? pathToFileURL(require.resolve('tsx/esm/api')).href : undefined },
  });
  const controller = new AbortController();
  const allowed = new Set(input.toolNames);
  let tail = Promise.resolve();
  let admissionTail = Promise.resolve();
  let barrier = Promise.resolve();
  let durabilityTail = Promise.resolve();
  let persistenceFailure: unknown;
  const persist = (write: () => Promise<void> | undefined): Promise<void> => {
    const pending = durabilityTail.then(write).catch(error => { persistenceFailure = error; throw error; });
    durabilityTail = pending;
    return pending;
  };
  let calls = 0;
  const chargeControl = createScriptControlBudget(input.limits);
  let yielded = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let finish!: (result: Omit<ScriptCellResult, 'receipts' | 'hadToolErrors'>) => void;
  const onAbort = (): void => finish({ status: 'cancelled', error: `Script cancelled (${String(input.signal?.reason ?? 'requested')}); inspect settled receipts before retrying.` });
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
    worker.on('message', (message: { kind: string; id: number; name: string; input: string; value?: unknown; error?: string; callId?: number; offset?: number }) => {
      if (stopped) return;
      if (message.kind === 'store' || message.kind === 'output' || message.kind === 'yield') {
        if (message.kind === 'yield' && yielded) return;
        try { chargeControl(Buffer.byteLength(message.name ?? '') + Buffer.byteLength(typeof message.value === 'string' ? message.value : '')); }
        catch (error) { finish({ status: 'failed', error: String(error) }); return; }
        if (message.kind === 'yield') yielded = true;
      }
      if (message.kind === 'result_read') {
        try {
          chargeControl(Buffer.byteLength(String(message.callId)) + Buffer.byteLength(String(message.offset)));
          const encoded = largeResults.get(message.callId!);
          if (!Number.isSafeInteger(message.callId) || !encoded || !Number.isSafeInteger(message.offset)
            || message.offset! < 0 || message.offset! > encoded.length) throw new Error('read_result requires a settled large-result reference from this cell and a valid offset.');
          const size = Math.min(16_384, Math.max(1, Math.floor((input.limits.maxTransferBytes - 256) / 6)));
          const text = encoded.slice(message.offset, message.offset! + size);
          const nextOffset = message.offset! + text.length;
          worker.postMessage({ id: message.id, result: JSON.stringify({ text, totalLength: encoded.length, status: 'settled',
            ...(nextOffset < encoded.length ? { nextOffset } : {}) }) });
        } catch (error) { finish({ status: 'failed', error: String(error) }); }
        return;
      }
      if (message.kind === 'store') {
        try { input.onStore?.(message.name, typeof message.value === 'string' ? message.value : undefined); }
        catch (error) { finish({ status: 'failed', error: String(error) }); }
        return;
      }
      if (message.kind === 'output' || message.kind === 'yield') {
        const pending = persist(async () => {
          if (message.kind === 'yield') { await input.onYield?.(); return; }
          const text = String(message.value);
          outputs.push(text);
          await input.onOutput?.(text);
        }).catch(error => finish({ status: 'failed', error: String(error) }));
        tail = Promise.all([tail, pending]).then(() => undefined);
        return;
      }
      if (message.kind === 'done') { finish({ status: 'completed', value: message.value }); return; }
      if (message.kind === 'failed') { finish({ status: 'failed', error: message.error }); return; }
      if (message.kind !== 'call') { finish({ status: 'failed', error: 'Invalid Script worker message.' }); return; }
      if (++calls > input.limits.maxCalls) { finish({ status: 'failed', error: 'Script tool-call limit exceeded.' }); return; }
      const earlier = tail;
      const earlierAdmission = admissionTail;
      let releaseAdmission!: () => void;
      admissionTail = new Promise<void>(resolve => { releaseAdmission = resolve; });
      let releaseCall!: () => void;
      const completed = new Promise<void>(resolve => { releaseCall = resolve; });
      let admitted = false;
      const prepare = async (canonical: Omit<ScriptReceipt, 'result'>): Promise<void> => {
        const previous = started.find(call => call.id === message.id);
        if (previous && (canonical.name !== previous.name || !isDeepStrictEqual(canonical.input, previous.input))) {
          const snapshot = structuredClone(canonical);
          await persist(() => input.onPrepared?.(snapshot));
          started[started.indexOf(previous)] = snapshot;
        }
      };
      const admit = async (parallel: boolean, canonical?: Omit<ScriptReceipt, 'result'>): Promise<void> => {
        if (admitted) throw new Error('Script call admission may only happen once.');
        admitted = true;
        await earlierAdmission;
        if (canonical) await prepare(canonical);
        const waiting = parallel ? barrier : earlier;
        if (!parallel) barrier = completed;
        releaseAdmission();
        await waiting;
        controller.signal.throwIfAborted();
      };
      const pending = (async () => {
        if (!input.concurrentPreparation) await admit(false);
        if (controller.signal.aborted) return;
        let parameters: Record<string, unknown> = {};
        let result: ScriptToolResult | undefined;
        try {
          if (!allowed.has(message.name)) throw new Error(`Tool ${message.name} is outside this Script cell.`);
          if (Buffer.byteLength(message.input) > input.limits.maxTransferBytes) throw new Error('Script tool input exceeds the transfer limit.');
          const parsed: unknown = JSON.parse(message.input);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool input must be a JSON object.');
          parameters = parsed as Record<string, unknown>;
        } catch (error) { result = { content: `[Tool Error] ${String(error)}`, isError: true }; }
        if (!result) {
          const requested = { id: message.id, name: message.name, input: structuredClone(parameters) };
          started.push(requested);
          await persist(() => input.onCall?.(requested));
          if (controller.signal.aborted) return;
          try { result = await input.invoke(message.name, parameters, controller.signal, message.id, admit, prepare); }
          catch (error) { result = { content: `[Tool Error] ${String(error)}`, isError: true }; }
        }
        receipts.push({ id: message.id, name: message.name, input: parameters, result });
        const encoded = encodeScriptResult(result);
        const receipt = receipts.at(-1)!;
        await persist(() => input.onReceipt?.(receipt));
        if (Buffer.byteLength(encoded) > input.limits.maxTransferBytes) {
          const reference = JSON.stringify({ result_ref: { callId: message.id, totalLength: encoded.length, format: 'json' },
            status: 'settled', isError: result.isError === true, output: 'referenced',
            warnings: 'unclassified; inspect read_result', truncation: 'unknown; inspect original', pendingEffects: 'unknown; inspect original' });
          if (Buffer.byteLength(reference) > input.limits.maxTransferBytes) {
            finish({ status: 'failed', error: 'Large-result reference exceeds the Script transfer limit; full result retained in host receipts.' });
          } else if (!stopped) {
            largeResults.set(message.id, encoded);
            worker.postMessage({ id: message.id, result: reference });
          }
        } else if (!stopped) worker.postMessage({ id: message.id, result: encoded });
      })().catch(error => finish({ status: 'failed', error: String(error) })).finally(async () => {
        // Failed preparation must release its position without admitting effects.
        await earlierAdmission;
        releaseAdmission();
        releaseCall();
      });
      tail = Promise.all([earlier, pending]).then(() => undefined);
    });
  });
  try {
    const result = await outcome;
    await worker.terminate();
    // Never report cancellation complete while a host tool can still mutate files.
    await tail;
    receipts.sort((left, right) => left.id - right.id);
    const pendingCalls = started.filter(call => !receipts.some(receipt => receipt.id === call.id)).map(call => ({ ...call, status: 'unknown' as const }));
    return { ...(persistenceFailure === undefined ? result : { status: 'failed' as const, error: String(persistenceFailure) }),
      receipts, hadToolErrors: receipts.some(receipt => receipt.result.isError === true), ...(outputs.length ? { outputs } : {}),
      ...(pendingCalls.length ? { pendingCalls } : {}) };
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
