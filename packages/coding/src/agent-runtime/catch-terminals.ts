/**
 * Catch-block terminal chain — CAP-082 + CAP-083 + CAP-084
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-082-catch-block--error-metadata--cleanup-chain
 *   - docs/features/v0.7.29-capability-inventory.md#cap-083-aborterror-silent-terminal-branch-gemini-cli-parity--interrupt-as-success
 *   - docs/features/v0.7.29-capability-inventory.md#cap-084-generic-error-terminal-path
 *
 * Class 1 (substrate). Three sequential phases of the outer try's
 * `catch` branch:
 *
 *   1. **`runCatchCleanup` (CAP-082)** — first step. Runs
 *      `cleanupIncompleteToolCalls + validateAndFixToolHistory` so the
 *      persisted history is resumable; increments `consecutiveErrors`;
 *      saves a session snapshot with the cleaned messages and updated
 *      metadata; rebases the context-token snapshot to the cleaned
 *      messages. Returns the data the caller threads into the AbortError
 *      vs generic-error branch decision.
 *
 *   2. **`applyAbortErrorTerminal` (CAP-083)** — fires when
 *      `error.name === 'AbortError'`. Per Gemini CLI parity, user
 *      interrupts are NOT failures — emits `events.onStreamEnd` +
 *      `stream:end` extension event and signals the caller to assemble
 *      a `success: true, interrupted: true` result. The Issue 072
 *      cleanup invariant (orphan tool_use blocks removed) is already
 *      satisfied by CAP-082; this terminal just emits.
 *
 *   3. **`applyGenericErrorTerminal` (CAP-084)** — fires when the
 *      caught error is NOT AbortError. Emits the `error` extension
 *      event and `events.onError(error)` (CAP-006 calling site), then
 *      signals the caller to assemble a `success: false` result with
 *      the cleaned messages and updated metadata.
 *
 * Time-ordering constraint: cleanup BEFORE branch decision; AbortError
 * branch BEFORE generic-error branch. The `runCatchCleanup` step MUST
 * run first because both terminal branches return the cleaned messages
 * and the updated metadata.
 *
 * Migration history: extracted from `agent.ts:1360-1421` — pre-FEATURE_100
 * baseline — during FEATURE_100 P3.5d.
 */

import type { KodaXMessage } from '@kodax/ai';

import type {
  KodaXContextTokenSnapshot,
  KodaXEvents,
  KodaXOptions,
  SessionErrorMetadata,
} from '../types.js';
import {
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from './history-cleanup.js';
import { saveSessionSnapshot } from './middleware/session-snapshot.js';
import { createEstimatedContextTokenSnapshot } from '../token-accounting.js';
import type { RuntimeSessionState } from './runtime-session-state.js';
import type { ExtensionEventEmitter } from './stream-handler-wiring.js';
import { emitError, emitStreamEnd } from './event-emitter.js';

// ---------------------------------------------------------------------------
// CAP-082 — runCatchCleanup
// ---------------------------------------------------------------------------

export interface CatchCleanupInput {
  readonly error: Error;
  readonly messages: KodaXMessage[];
  readonly errorMetadata: SessionErrorMetadata | undefined;
  readonly options: KodaXOptions;
  readonly sessionId: string;
  readonly title: string;
  readonly runtimeSessionState: RuntimeSessionState;
}

export interface CatchCleanupOutput {
  /** History with orphan tool_use blocks removed (Issue 072). */
  readonly cleanedMessages: KodaXMessage[];
  /** Updated metadata with `consecutiveErrors` incremented. */
  readonly updatedErrorMetadata: SessionErrorMetadata;
  /** Snapshot rebased to the cleaned messages. */
  readonly contextTokenSnapshot: KodaXContextTokenSnapshot;
}

/**
 * CAP-082: catch-block cleanup chain. ALWAYS runs first in the catch
 * branch; both terminal sub-branches consume its output.
 *
 * Storage-failure isolation: `saveSessionSnapshot` absorbs `storage.save`
 * rejections internally (CAP-013-003 / CAP-SESSION-SNAPSHOT-003 — closed
 * in P3.6a), so a transient storage failure here will NOT clobber the
 * original `error` or short-circuit the catch-flow. The caller still
 * sees the original error via the AbortError vs generic-error branch.
 */
export async function runCatchCleanup(
  input: CatchCleanupInput,
): Promise<CatchCleanupOutput> {
  let cleanedMessages = cleanupIncompleteToolCalls(input.messages);
  cleanedMessages = validateAndFixToolHistory(cleanedMessages);

  const updatedErrorMetadata: SessionErrorMetadata = {
    lastError: input.error.message,
    lastErrorTime: Date.now(),
    consecutiveErrors: (input.errorMetadata?.consecutiveErrors ?? 0) + 1,
  };

  await saveSessionSnapshot(input.options, input.sessionId, {
    messages: cleanedMessages,
    title: input.title,
    errorMetadata: updatedErrorMetadata,
    runtimeSessionState: input.runtimeSessionState,
  });

  const contextTokenSnapshot = createEstimatedContextTokenSnapshot(cleanedMessages);
  return { cleanedMessages, updatedErrorMetadata, contextTokenSnapshot };
}

// ---------------------------------------------------------------------------
// CAP-083 — applyAbortErrorTerminal
// ---------------------------------------------------------------------------

export interface AbortErrorTerminalInput {
  readonly events: KodaXEvents;
  readonly emitActiveExtensionEvent: ExtensionEventEmitter;
}

/**
 * CAP-083: AbortError silent terminal. Caller wraps with
 * `finalizeManagedProtocolResult({ success: true, interrupted: true,
 *   messages: cleanedMessages, errorMetadata: updatedErrorMetadata,
 *   ... })`.
 *
 * Per Gemini CLI parity, an aborted run is NOT a failure — the
 * KodaXResult carries `success: true, interrupted: true` so callers
 * can resume cleanly without surfacing an error to the user.
 */
export async function applyAbortErrorTerminal(
  input: AbortErrorTerminalInput,
): Promise<void> {
  emitStreamEnd(input.events);
  await input.emitActiveExtensionEvent('stream:end', undefined);
}

// ---------------------------------------------------------------------------
// CAP-084 — applyGenericErrorTerminal
// ---------------------------------------------------------------------------

export interface GenericErrorTerminalInput {
  readonly error: Error;
  readonly events: KodaXEvents;
  readonly emitActiveExtensionEvent: ExtensionEventEmitter;
}

/**
 * CAP-084: generic error terminal. Caller wraps with
 * `finalizeManagedProtocolResult({ success: false,
 *   messages: cleanedMessages, errorMetadata: updatedErrorMetadata,
 *   ... })`.
 *
 * Emits both the `error` extension event AND `events.onError(error)`
 * (CAP-006 calling site) so REPL-side and extension-side observers
 * see the failure.
 */
export async function applyGenericErrorTerminal(
  input: GenericErrorTerminalInput,
): Promise<void> {
  await input.emitActiveExtensionEvent('error', { error: input.error });
  emitError(input.events, input.error);
}
