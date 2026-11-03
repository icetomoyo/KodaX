import { randomUUID } from 'node:crypto';
import type { RunnerToolContext } from '@kodax-ai/agent';
import type { ScriptCellResult, ScriptCellScope, ScriptReceipt } from './cell.js';

export type ScriptObservation = Omit<ScriptCellResult, 'status'> & {
  readonly status: ScriptCellResult['status'] | 'running' | 'cancelling';
  readonly cleanupComplete: boolean;
  readonly cursor: number;
};
type CellEvent = { readonly receipt: ScriptReceipt } | { readonly output: string } | { readonly call: Omit<ScriptReceipt, 'result'> };
interface Cell {
  readonly id: string;
  readonly controller: AbortController;
  readonly events: CellEvent[];
  readonly promise: Promise<ScriptCellResult>;
  readonly yieldPromise: Promise<void>;
  result?: ScriptCellResult;
  failure?: unknown;
  finished: boolean;
}
export type ScriptModelRun = (code: string, caller: RunnerToolContext, scope: ScriptCellScope) => Promise<ScriptCellResult>;

/** One Run, one active cell. Completed evidence belongs to canonical Session records. */
export function createScriptModelSession(run: ScriptModelRun) {
  const storedValues = new Map<string, string>();
  let current: Cell | undefined;
  let caller: RunnerToolContext | undefined;
  let closed = false;
  function update(context: RunnerToolContext): void { caller = context; }
  async function observe(cell: Cell, cursor: number, waitMs?: number, initial = false): Promise<ScriptObservation> {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > cell.events.length) throw new Error('Invalid Script observation cursor.');
    if (waitMs !== undefined && (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000)) throw new Error('yield_time_ms must be an integer from 0 to 60000.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([cell.promise, ...(initial ? [cell.yieldPromise] : []), ...(waitMs === undefined ? [] : [new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })])]);
    } finally { if (timer) clearTimeout(timer); }
    if (cell.failure) throw cell.failure;
    const events = cell.events.slice(cursor);
    const result = cell.result;
    const settled = new Set(cell.events.flatMap(event => 'receipt' in event ? [event.receipt.id] : []));
    const pending = new Map(cell.events.flatMap(event => 'call' in event && !settled.has(event.call.id) ? [[event.call.id, event.call] as const] : []));
    const pendingCalls = [...pending.values()].map(call => ({ ...call, status: cell.finished ? 'unknown' as const : 'pending' as const }));
    return { ...result, cellId: cell.id, status: result?.status ?? (cell.controller.signal.aborted ? 'cancelling' : 'running'),
      cleanupComplete: cell.finished, cursor: cell.events.length,
      receipts: events.flatMap(event => 'receipt' in event ? [event.receipt] : []),
      outputs: events.flatMap(event => 'output' in event ? [event.output] : []),
      ...(pendingCalls.length ? { pendingCalls } : {}),
      hadToolErrors: result?.hadToolErrors ?? cell.events.some(event => 'receipt' in event && event.receipt.result.isError === true) };
  }
  return {
    update,
    get active() { return current !== undefined && !current.finished; },
    async start(code: string, context: RunnerToolContext, waitMs?: number): Promise<ScriptCellResult | ScriptObservation> {
      if (closed) throw new Error('Script Run scope is closed.');
      if (current && !current.finished) throw new Error('A Script cell is still running; use script_wait before starting another.');
      if (waitMs !== undefined && (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000)) throw new Error('yield_time_ms must be an integer from 0 to 60000.');
      update(context);
      const id = randomUUID();
      const controller = new AbortController();
      const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, controller.signal]) : controller.signal;
      let yielded = false;
      let releaseYield!: () => void;
      const yieldPromise = new Promise<void>(resolve => { releaseYield = resolve; });
      const events: CellEvent[] = [];
      const liveContext: RunnerToolContext = { ...context, abortSignal: signal,
        get transcript() { return caller?.transcript ?? context.transcript; } };
      const promise = Promise.resolve().then(() => run(code, liveContext, { cellId: id, storedValues,
        onCall: call => { events.push({ call }); },
        onReceipt: receipt => { events.push({ receipt }); }, onOutput: output => { events.push({ output }); },
        onYield: () => { yielded = true; releaseYield(); } }));
      const cell: Cell = { id, controller, events, promise, yieldPromise, finished: false };
      current = cell;
      void promise.then(result => { cell.result = result; cell.finished = true; }, error => { cell.failure = error; cell.finished = true; closed = true; });
      const observation = await observe(cell, 0, waitMs, true);
      // Preserve the synchronous API representation unless observation was requested.
      return waitMs === undefined && !yielded && cell.result ? cell.result : observation;
    },
    async wait(id: string, context: RunnerToolContext, cursor = 0, waitMs = 10_000, cancel = false): Promise<ScriptObservation> {
      update(context);
      if (!current || current.id !== id) throw new Error('Script cell is not active or most recently completed in this Run; read durable receipts instead.');
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > current.events.length || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) throw new Error('Invalid Script observation cursor or yield_time_ms.');
      if (cancel) current.controller.abort('User requested Script cancellation');
      return observe(current, cursor, waitMs);
    },
    async beforeNative(context: RunnerToolContext): Promise<void> {
      update(context);
      if (!current || current.finished) return;
      const signal = context.abortSignal;
      signal?.throwIfAborted();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal?.reason ?? new Error('Cancelled')); });
      signal?.addEventListener('abort', abort, { once: true });
      try { await Promise.race([current.promise, cancelled]); }
      finally { signal?.removeEventListener('abort', abort); }
    },
    async close(): Promise<void> {
      closed = true;
      const unfinished = current !== undefined && !current.finished;
      current?.controller.abort('Parent Run ended');
      try { await current?.promise; }
      finally { storedValues.clear(); }
      if (unfinished && !caller?.abortSignal?.aborted) throw new Error('Run ended with an unfinished Script cell; cancelled and drained it. Inspect durable receipts before continuing.');
    },
  };
}
