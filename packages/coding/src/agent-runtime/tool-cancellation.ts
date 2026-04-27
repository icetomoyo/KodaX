/**
 * Tool cancellation handling — CAP-076 + CAP-080
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-076-pre-tool-abort-check--graceful-tool-cancellation-issue-088
 *   - docs/features/v0.7.29-capability-inventory.md#cap-080-cancellation-routed-terminal-hascancellation-branch--interrupted-flag
 *
 * Class 1 (substrate). Two related pieces of cancellation handling:
 *
 *   - `checkPreToolAbort` (CAP-076): BEFORE tool dispatch, if
 *     `options.abortSignal` is already aborted (Ctrl+C between stream
 *     end and tool start), synthesize cancelled tool_results for every
 *     visible tool block and emit `tool:result` events for them. This
 *     is graceful cancellation rather than throwing — the downstream
 *     `hasCancellation` check (CAP-080) handles exit uniformly whether
 *     the user aborted before tools or during a sequential bash loop.
 *
 *   - `applyCancellationTerminal` (CAP-080): AFTER per-result
 *     post-processing, when `hasCancellation` is true, push the
 *     toolResults into messages, fire `turn:end` + `stream:end`, and
 *     return the data the caller needs to assemble the final
 *     `KodaXResult` — specifically the rebased `contextTokenSnapshot`
 *     and the `shouldYieldToQueuedFollowUp` flag that determines
 *     whether the result carries `interrupted: true` (no follow-up
 *     queued) or `interrupted: false` (a queued follow-up absorbs
 *     the cancellation).
 *
 *   - `CANCELLATION_LAST_TEXT`: the canonical lastText string surfaced
 *     to the host on cancellation. Exported as a constant so the
 *     contract test pins the exact string.
 *
 * Migration history: extracted from `agent.ts:1257-1271` (CAP-076) and
 * `agent.ts:1412-1438` (CAP-080) — pre-FEATURE_100 baseline — during
 * FEATURE_100 P3.3c.
 */

import type { KodaXEvents, KodaXContextTokenSnapshot } from '../types.js';
import type {
  KodaXMessage,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
} from '@kodax/ai';
import { CANCELLED_TOOL_RESULT_MESSAGE } from '../constants.js';
import { isVisibleToolName, hasQueuedFollowUp, emitStreamEnd } from './event-emitter.js';
import { isCancelledToolResultContent } from './tool-result-classify.js';
import { createToolResultBlock } from './tool-dispatch.js';
import { rebaseContextTokenSnapshot } from '../token-accounting.js';
import type { ExtensionEventEmitter } from './stream-handler-wiring.js';

/** Canonical cancellation `lastText` string — pinned by CAP-080 contract. */
export const CANCELLATION_LAST_TEXT = 'Operation cancelled by user';

export interface PreToolAbortInput {
  readonly toolBlocks: KodaXToolUseBlock[];
  readonly abortSignal: AbortSignal | undefined;
  readonly events: KodaXEvents;
  readonly emitActiveExtensionEvent: ExtensionEventEmitter;
}

/**
 * If `abortSignal` is already aborted at the start of tool dispatch,
 * synthesize cancelled tool_results for every visible tool block and
 * emit per-result `tool:result` events. Returns the cancelled blocks
 * (caller appends them to its `toolResults` accumulator and proceeds
 * to the cancellation-terminal branch via `hasCancellation`).
 *
 * Returns `null` when the signal is not aborted — caller should
 * proceed with normal tool dispatch.
 */
export async function checkPreToolAbort(
  input: PreToolAbortInput,
): Promise<KodaXToolResultBlock[] | null> {
  if (input.abortSignal?.aborted !== true) {
    return null;
  }
  const cancelled: KodaXToolResultBlock[] = [];
  for (const tc of input.toolBlocks) {
    if (isVisibleToolName(tc.name)) {
      await input.emitActiveExtensionEvent('tool:result', {
        id: tc.id,
        name: tc.name,
        content: CANCELLED_TOOL_RESULT_MESSAGE,
      });
      input.events.onToolResult?.({
        id: tc.id,
        name: tc.name,
        content: CANCELLED_TOOL_RESULT_MESSAGE,
      });
      cancelled.push(createToolResultBlock(tc.id, CANCELLED_TOOL_RESULT_MESSAGE));
    }
  }
  return cancelled;
}

/**
 * Predicate: did any tool result carry the cancellation marker? Used
 * to decide whether the cancellation-terminal branch fires.
 */
export function hasCancelledToolResult(
  toolResults: readonly KodaXToolResultBlock[],
): boolean {
  return toolResults.some(
    (r) => typeof r.content === 'string' && isCancelledToolResultContent(r.content),
  );
}

export interface CancellationTerminalInput {
  readonly events: KodaXEvents;
  readonly emitActiveExtensionEvent: ExtensionEventEmitter;
  /** Live message buffer — mutated in place (push toolResults). */
  readonly messages: KodaXMessage[];
  readonly toolResults: KodaXToolResultBlock[];
  readonly completedTurnTokenSnapshot: KodaXContextTokenSnapshot;
  readonly sessionId: string;
  readonly iter: number;
  /**
   * The local `emitIterationEnd` wrapper from agent.ts that takes
   * `(iterNumber, snapshotOverride?)` and updates the outer
   * `contextTokenSnapshot` via the substrate helper.
   */
  readonly emitIterationEnd: (
    iterNumber: number,
    snapshotOverride?: KodaXContextTokenSnapshot,
  ) => KodaXContextTokenSnapshot;
}

export interface CancellationTerminalResult {
  /** New snapshot caller assigns to its mutable holder. */
  readonly contextTokenSnapshot: KodaXContextTokenSnapshot;
  /**
   * Whether a queued follow-up input is waiting in the host. When
   * true, the cancellation result MUST set `interrupted: false` so
   * the follow-up turn picks up cleanly. When false, the result
   * carries `interrupted: true`.
   */
  readonly shouldYieldToQueuedFollowUp: boolean;
}

/**
 * Apply the cancellation terminal: push tool results into history,
 * rebase the snapshot, fire `turn:end` + `stream:end` events. Returns
 * the data the caller needs to build the final KodaXResult shape.
 *
 * Caller responsibilities (NOT inside this helper, to avoid the
 * 8+ parameter envelope build):
 *   - assemble the `KodaXResult` with `lastText: CANCELLATION_LAST_TEXT`,
 *     `success: true`, `interrupted: !shouldYieldToQueuedFollowUp`
 *   - call `finalizeManagedProtocolResult` (closure over local state)
 *   - return the result from `runKodaX`
 */
export async function applyCancellationTerminal(
  input: CancellationTerminalInput,
): Promise<CancellationTerminalResult> {
  const shouldYieldToQueuedFollowUp = hasQueuedFollowUp(input.events);
  input.messages.push({ role: 'user', content: input.toolResults });
  // Tool results are already appended, so emit the post-tool rebased snapshot here.
  let contextTokenSnapshot = rebaseContextTokenSnapshot(
    input.messages,
    input.completedTurnTokenSnapshot,
  );
  if (shouldYieldToQueuedFollowUp) {
    contextTokenSnapshot = input.emitIterationEnd(input.iter + 1, contextTokenSnapshot);
  }
  await input.emitActiveExtensionEvent('turn:end', {
    sessionId: input.sessionId,
    iteration: input.iter + 1,
    lastText: CANCELLATION_LAST_TEXT,
    hadToolCalls: true,
    signal: undefined,
  });
  emitStreamEnd(input.events);
  await input.emitActiveExtensionEvent('stream:end', undefined);
  return { contextTokenSnapshot, shouldYieldToQueuedFollowUp };
}
