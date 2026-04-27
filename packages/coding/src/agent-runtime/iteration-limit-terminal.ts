/**
 * Iteration limit terminal — CAP-085
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-085-iteration-limit-terminal
 *
 * Class 1 (substrate). Side-effect helper that runs the standard
 * end-of-turn finalization regardless of whether the exit is a genuine
 * iteration-budget exhaustion or a model-driven clean completion.
 * Performs:
 *
 *   1. Final session snapshot save (CAP-011 calling site).
 *   2. Promise-signal extraction from `lastText` via `checkPromiseSignal`
 *      (CAP-039 calling site) — surfaces COMPLETE/BLOCKED/DECIDE if
 *      the model hinted at one in its closing message.
 *
 * Returns the data the caller needs to assemble the final
 * `KodaXResult`. The caller decides `limitReached`:
 *   - `true` for the post-loop natural-exhaustion branch (every iter
 *     consumed without an early `return`).
 *   - `false` for the two model-driven completion paths (text-only
 *     turn and tools-with-no-results turn) — these are NOT
 *     budget-exhaustion and must not be tagged as such.
 *
 * Migration history: extracted from `agent.ts:1422-1432` — pre-FEATURE_100
 * baseline — during FEATURE_100 P3.5c. Two additional call sites added
 * during the P3.5 verify-fixes pass to fix the `break`-fallthrough bug
 * (clean-completion exits were getting `limitReached: true` and
 * downstream `scout-signals.ts` was misclassifying them as
 * 'budget-exhausted').
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
