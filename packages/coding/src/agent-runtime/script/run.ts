import { randomUUID } from 'node:crypto';
import { collectGuardrails, createAgent } from '@kodax-ai/agent';
import type { KodaXJsonValue, KodaXOptions, KodaXResult } from '../../types.js';
import { withHostInvocation, type HostInvocation } from '../host-invocation.js';
import { createExtensionRuntimeSessionController } from '../middleware/extension-queue.js';
import { snapshotRuntimeSessionState } from '../runtime-session-state.js';
import { createScriptPilot } from './pilot.js';
import { validateScriptCell, type ScriptCellLimits, type ScriptCellResult } from './cell.js';

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
    const cellId = randomUUID();
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
      onCall: call => persist('call.started', JSON.parse(JSON.stringify(call)) as KodaXJsonValue),
      // cell validates JSON DTOs before this boundary; canonical calls, recovery and artifacts stay intact.
      onReceipt: receipt => persist('call.settled', JSON.parse(JSON.stringify(receipt)) as KodaXJsonValue),
    });
    await persist('cell.settled', { status: scriptCell.status, hadToolErrors: scriptCell.hadToolErrors,
      ...(scriptCell.error ? { error: scriptCell.error } : {}),
      ...(scriptCell.value !== undefined ? { value: scriptCell.value as KodaXJsonValue } : {}), spentBudget: budget.spentBudget });
    return scriptCell;
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
