import { randomUUID } from 'node:crypto';
import { collectGuardrails, createAgent } from '@kodax-ai/agent';
import type { KodaXJsonValue, KodaXOptions, KodaXResult } from '../../types.js';
import { withHostInvocation } from '../host-invocation.js';
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
  return withHostInvocation(original, prompt, async ({ options, sessionId, runId, ctx, state, messages, save }) => {
    validateScriptCell(code, limits);
    const cellId = randomUUID();
    const records = createExtensionRuntimeSessionController(state);
    const persist = async (type: string, data: KodaXJsonValue): Promise<void> => {
      records.appendSessionRecord('kodax.script', type, { runId, cellId, data });
      await save();
    };
    await persist('cell.started', { code });
    const budget = ctx.managedWorkBudget ?? { totalBudget: limits.maxCalls, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
    const pilot = createScriptPilot({ ctx, events: options.events ?? {}, runtimeSessionState: state,
      activeToolNames: state.activeTools, abortSignal: options.abortSignal, toolGuardrails: collectGuardrails(options.guardrails).tool,
      guardrailContext: { agent: createAgent({ name: 'Host Script invocation', instructions: 'Execute the explicitly requested Script cell.' }),
        messages, abortSignal: options.abortSignal, permissionIntent: options.context?.permissionIntent },
    }, budget);
    const scriptCell = await pilot.run(code, limits, {
      onCall: call => persist('call.started', JSON.parse(JSON.stringify(call)) as KodaXJsonValue),
      // cell validates JSON DTOs before this boundary; canonical calls, recovery and artifacts stay intact.
      onReceipt: receipt => persist('call.settled', JSON.parse(JSON.stringify(receipt)) as KodaXJsonValue),
    });
    await persist('cell.settled', { status: scriptCell.status, hadToolErrors: scriptCell.hadToolErrors,
      ...(scriptCell.error ? { error: scriptCell.error } : {}),
      ...(scriptCell.value !== undefined ? { value: scriptCell.value as KodaXJsonValue } : {}), spentBudget: budget.spentBudget });
    return { sessionId, messages, scriptCell, lastText: JSON.stringify(scriptCell),
      success: scriptCell.status === 'completed' && !scriptCell.hadToolErrors,
      interrupted: scriptCell.status === 'cancelled',
      runtimeSessionSnapshot: snapshotRuntimeSessionState(state, { includeUnchanged: false }) };
  });
}
