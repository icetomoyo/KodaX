import { randomUUID } from 'node:crypto';
import { collectGuardrails, createAgent } from '@kodax-ai/agent';
import type { KodaXJsonValue, KodaXOptions, KodaXResult } from '../../types.js';
import { withHostInvocation, type HostInvocation } from '../host-invocation.js';
import { createExtensionRuntimeSessionController } from '../middleware/extension-queue.js';
import { snapshotRuntimeSessionState, type RuntimeSessionState } from '../runtime-session-state.js';
import { createScriptPilot } from './pilot.js';
import { validateScriptCell, type ScriptCellLimits, type ScriptCellResult, type ScriptCellScope } from './cell.js';

/** Internal explicit Run entry. No registry registration, public mode, or model request.
 * Storage is mandatory: an interrupted cell is evidence to inspect, never a replay queue.
 */
export function runScriptInvocation(
  original: KodaXOptions, code: string, limits: ScriptCellLimits,
  prompt = 'Execute the explicitly requested Script cell.',
): Promise<KodaXResult & { scriptCell: ScriptCellResult }> {
  if (!original.session?.storage || original.session.persistedByHost === true) {
    return Promise.reject(new Error('Script Run requires writable canonical Session storage.'));
  }
  return withHostInvocation(original, prompt, host => withScriptCells(host, limits, async runCell => {
    const scriptCell = await runCell(code);
    return { sessionId: host.sessionId, messages: host.messages, scriptCell, lastText: JSON.stringify(scriptCell),
      success: scriptCell.status === 'completed' && !scriptCell.hadToolErrors,
      interrupted: scriptCell.status === 'cancelled',
      runtimeSessionSnapshot: snapshotRuntimeSessionState(host.state, { includeUnchanged: false }) };
  }));
}

/** Internal borrowed-parent scope. Cells share host state, never VM globals or a new Run.
 * The parent must await this scope before releasing its own execution/controller bindings.
 */
export async function withScriptCells<T>(
  host: HostInvocation, limits: ScriptCellLimits,
  execute: (runCell: (code: string) => Promise<ScriptCellResult>) => Promise<T>,
  scope: ScriptCellScope = { storedValues: new Map() },
): Promise<T> {
  const { options, runId, ctx, state, messages, save } = host;
  if (!options.session?.storage || (options.session.persistedByHost === true && !options.session.storage.appendSessionRecords)) {
    throw new Error('Script Run requires writable canonical Session storage.');
  }
  validateScriptCell('', limits);
  const disposal = new AbortController();
  const signal = AbortSignal.any([disposal.signal, ...[options.abortSignal, ctx.abortSignal]
    .filter((candidate): candidate is AbortSignal => candidate !== undefined)]);
  const budget = ctx.managedWorkBudget ??= { totalBudget: limits.maxCalls, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const records = createExtensionRuntimeSessionController(state);
  let closed = false;
  let busy = false;
  let pending: Promise<ScriptCellResult> | undefined;
  const runCell = (code: string): Promise<ScriptCellResult> => {
    try {
      if (closed) throw new Error('Script parent scope is closed.');
      signal.throwIfAborted();
      if (busy) throw new Error('Script parent already has an active cell; await it before starting another.');
      validateScriptCell(code, limits);
    } catch (error) { return Promise.reject(error); }
    busy = true;
    pending = executeCell(code);
    // Observe the same promise returned to the caller, even if it abandons the cell.
    // Its error still propagates through that promise and the scope's final drain.
    void pending.then(() => { busy = false; }, () => { busy = false; });
    return pending;
  };
  async function executeCell(code: string): Promise<ScriptCellResult> {
    const cellId = scope.cellId ?? randomUUID();
    const persist = async (type: string, data: KodaXJsonValue): Promise<void> => {
      const record = records.appendSessionRecord('kodax.script', type, { runId, cellId, data });
      try {
        if (options.session?.persistedByHost === true) {
          const found = await options.session.storage!.appendSessionRecords!(host.sessionId, [record]);
          if (!found) throw new Error('Script owner Session no longer exists.');
        } else await save();
      }
      catch (error) { closed = true; throw error; }
    };
    await persist('cell.started', { code });
    const pilot = createScriptPilot({ ctx: { ...ctx, visualSource: { imageOrdinal: 0, runId, cellId, inputId: options.session?.inputId } },
      events: options.events ?? {}, runtimeSessionState: state,
      // Borrowed Runner cells retain tracking, but the parent owns review policy.
      mutationScopeReflection: host.agent === undefined,
      get activeToolNames() { return state.activeTools; },
      abortSignal: signal, toolObserver: host.toolObserver, toolGuardrails: collectGuardrails(options.guardrails).tool,
      guardrailContext: { agent: host.agent ?? createAgent({ name: 'Host Script invocation', instructions: 'Execute the explicitly requested Script cell.' }),
        messages, abortSignal: signal, permissionIntent: options.context?.permissionIntent },
    }, budget);
    const scriptCell = await pilot.run(code, limits, {
      storedValues: scope.storedValues,
      onStore: (key, value) => { if (value === undefined) scope.storedValues.delete(key); else scope.storedValues.set(key, value); },
      onOutput: async text => { await persist('cell.output', { text }); scope.onOutput?.(text); },
      onYield: async () => { await persist('cell.yielded', {}); scope.onYield?.(); },
      onCall: async call => { await persist('call.started', JSON.parse(JSON.stringify(call)) as KodaXJsonValue); scope.onCall?.(call); },
      onPrepared: async call => { await persist('call.prepared', JSON.parse(JSON.stringify(call)) as KodaXJsonValue); scope.onCall?.(call); },
      // cell validates JSON DTOs before this boundary; canonical calls, recovery and artifacts stay intact.
      onReceipt: async receipt => {
        await persist('call.settled', JSON.parse(JSON.stringify(receipt)) as KodaXJsonValue);
        scope.onReceipt?.(receipt);
      },
    });
    await persist('cell.settled', { status: scriptCell.status, hadToolErrors: scriptCell.hadToolErrors,
      ...(scriptCell.error ? { error: scriptCell.error } : {}),
      ...(scriptCell.value !== undefined ? { value: scriptCell.value as KodaXJsonValue } : {}), spentBudget: budget.spentBudget });
    return { ...scriptCell, cellId };
  }
  let parentFailed = false;
  let parentError: unknown;
  try { return await execute(runCell); }
  catch (error) { parentFailed = true; parentError = error; throw error; }
  finally {
    closed = true;
    disposal.abort();
    try { await pending; }
    catch (error) {
      if (parentFailed && error !== parentError) throw new AggregateError([parentError, error], 'Script parent and cell teardown both failed.');
      throw error;
    }
  }
}

/** Reads canonical Session evidence; no second store and no replay of unfinished calls. */
export function createScriptReceiptReader(state: RuntimeSessionState) {
  let key: string | undefined;
  let entry: { started?: KodaXJsonValue; prepared?: KodaXJsonValue; settled?: KodaXJsonValue } = {};
  let indexed = 0;
  return (cellId: string, callId: number, offset = 0) => {
    if (!Number.isSafeInteger(callId) || callId < 1 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Script receipt call_id and offset must be non-negative integers; call_id starts at 1.');
    }
    const requestedKey = `${cellId}:${callId}`;
    if (key !== requestedKey) { key = requestedKey; indexed = 0; entry = {}; }
    for (; indexed < state.extensionRecords.length; indexed++) {
      const record = state.extensionRecords[indexed]!;
      if (record.extensionId !== 'kodax.script' || !['call.started', 'call.prepared', 'call.settled'].includes(record.type)) continue;
      const envelope = record.data;
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) continue;
      const data = envelope.data;
      if (typeof envelope.cellId !== 'string' || !data || typeof data !== 'object' || Array.isArray(data) || typeof data.id !== 'number') continue;
      if (envelope.cellId !== cellId || data.id !== callId) continue;
      if (record.type === 'call.started') entry.started = data;
      else if (record.type === 'call.prepared') entry.prepared = data;
      else entry.settled = data;
    }
    if (!entry.started && !entry.settled) throw new Error('Script receipt not found in this Session.');
    const text = JSON.stringify(entry.settled ?? entry.prepared ?? entry.started);
    if (offset > text.length) throw new Error('Script receipt offset exceeds its length.');
    const page = text.slice(offset, offset + 16_384);
    const nextOffset = offset + page.length;
    return { cellId, callId, status: entry.settled ? 'settled' : 'unknown', argumentsStage: entry.settled || entry.prepared ? 'canonical' : 'requested',
      offset, totalLength: text.length, text: page,
      ...(nextOffset < text.length ? { nextOffset } : {}) };
  };
}
