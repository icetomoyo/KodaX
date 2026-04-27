/**
 * Iteration limit terminal — CAP-085
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-085-iteration-limit-terminal
 *
 * Class 1 (substrate). The natural-completion terminal — fires only
 * when the turn loop runs all `maxIter` iterations without an early
 * break (no COMPLETE signal, no interrupt, no error). Performs:
 *
 *   1. Final session snapshot save (CAP-011 calling site).
 *   2. Promise-signal extraction from `lastText` via `checkPromiseSignal`
 *      (CAP-039 calling site) — surfaces COMPLETE/BLOCKED/DECIDE if
 *      the model hinted at one in its closing message even though the
 *      loop ran out of iterations.
 *
 * Returns the data the caller needs to assemble the final
 * `KodaXResult` with `success: true, limitReached: true`. The caller
 * is responsible for the `finalizeManagedProtocolResult` wrap (closure
 * over `emittedManagedProtocolPayload`) and the actual return.
 *
 * Time-ordering constraint: ONLY reached on natural `for` loop exit;
 * AFTER all turns consumed without an early break.
 *
 * Migration history: extracted from `agent.ts:1422-1432` — pre-FEATURE_100
 * baseline — during FEATURE_100 P3.5c. The `let limitReached` toggle is
 * folded: callers of this helper set the flag literal `true` at the
 * single use site since the iteration-limit branch is the only place
 * the terminal fires.
 */

import type { KodaXMessage } from '@kodax/ai';

import type { KodaXOptions } from '../types.js';
import { saveSessionSnapshot } from './middleware/session-snapshot.js';
import { checkPromiseSignal } from './thinking-mode-replay.js';
import type { RuntimeSessionState } from './runtime-session-state.js';

export interface IterationLimitTerminalInput {
  readonly options: KodaXOptions;
  readonly sessionId: string;
  readonly messages: KodaXMessage[];
  readonly title: string;
  readonly runtimeSessionState: RuntimeSessionState;
  readonly lastText: string;
}

export interface IterationLimitTerminalOutput {
  /** COMPLETE/BLOCKED/DECIDE if the closing text hinted at one. */
  readonly finalSignal: 'COMPLETE' | 'BLOCKED' | 'DECIDE' | undefined;
  /** Optional human-readable reason that accompanies the signal. */
  readonly finalReason: string | undefined;
}

/**
 * CAP-085: iteration-limit terminal side effects + signal extraction.
 * Caller wraps the returned data with `finalizeManagedProtocolResult`
 * and returns from `runKodaX`.
 */
export async function applyIterationLimitTerminal(
  input: IterationLimitTerminalInput,
): Promise<IterationLimitTerminalOutput> {
  await saveSessionSnapshot(input.options, input.sessionId, {
    messages: input.messages,
    title: input.title,
    runtimeSessionState: input.runtimeSessionState,
  });
  const [finalSignal, finalReason] = checkPromiseSignal(input.lastText);
  return {
    finalSignal: finalSignal as 'COMPLETE' | 'BLOCKED' | 'DECIDE' | undefined,
    finalReason,
  };
}
