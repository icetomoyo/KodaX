/**
 * Contract test for CAP-080: cancellation-routed terminal (hasCancellation branch + interrupted flag)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-080-cancellation-routed-terminal-hascancellation-branch--interrupted-flag
 *
 * Test obligations:
 * - CAP-CANCEL-TERMINAL-001: cancellation returns success:true with interrupted flag
 * - CAP-CANCEL-TERMINAL-002: queued follow-up suppresses interrupted flag
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/tool-cancellation.ts (extracted from
 * agent.ts:1412-1438 — pre-FEATURE_100 baseline — during FEATURE_100 P3.3c)
 *
 * Time-ordering constraint: AFTER per-result post-processing (CAP-078); terminates the run.
 *
 * Active here:
 *   - hasCancelledToolResult predicate detects CANCELLED_TOOL_RESULT_MESSAGE
 *   - applyCancellationTerminal pushes toolResults into messages, fires
 *     turn:end + stream:end + onStreamEnd
 *   - shouldYieldToQueuedFollowUp is read from events.hasPendingInputs?
 *     and exposed back to the caller — caller uses NOT-of-this for the
 *     `interrupted` flag on the final KodaXResult
 *   - CANCELLATION_LAST_TEXT is the canonical 'Operation cancelled by user'
 *     string surfaced as lastText on the result
 *
 * STATUS: ACTIVE since FEATURE_100 P3.3c.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents, KodaXContextTokenSnapshot } from '../../types.js';
import type { KodaXMessage, KodaXToolResultBlock } from '@kodax/ai';

import {
  hasCancelledToolResult,
  applyCancellationTerminal,
  CANCELLATION_LAST_TEXT,
} from '../tool-cancellation.js';
import { CANCELLED_TOOL_RESULT_MESSAGE } from '../../constants.js';
import type { ExtensionEventEmitter } from '../stream-handler-wiring.js';

function fakeEmitter(): ExtensionEventEmitter {
  return vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter;
}

function fakeSnapshot(): KodaXContextTokenSnapshot {
  return { currentTokens: 100, source: 'estimated' } as unknown as KodaXContextTokenSnapshot;
}

function cancelledBlock(id: string): KodaXToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: CANCELLED_TOOL_RESULT_MESSAGE,
  } as unknown as KodaXToolResultBlock;
}

function nonCancelledBlock(id: string): KodaXToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: 'normal result',
  } as unknown as KodaXToolResultBlock;
}

describe('CAP-080: hasCancelledToolResult — predicate', () => {
  it('CAP-CANCEL-TERMINAL-PREDICATE-001: detects cancellation when ANY result carries the marker', () => {
    expect(hasCancelledToolResult([cancelledBlock('t1')])).toBe(true);
    expect(
      hasCancelledToolResult([nonCancelledBlock('a'), cancelledBlock('b')]),
    ).toBe(true);
    expect(hasCancelledToolResult([nonCancelledBlock('a')])).toBe(false);
    expect(hasCancelledToolResult([])).toBe(false);
  });
});

describe('CAP-080: applyCancellationTerminal — terminal effects', () => {
  it('CAP-CANCEL-TERMINAL-001: pushes toolResults into messages, fires turn:end + stream:end + onStreamEnd', async () => {
    const messages: KodaXMessage[] = [];
    const onStreamEnd = vi.fn();
    const emit = fakeEmitter();
    const emitIterationEnd = vi.fn().mockReturnValue(fakeSnapshot());

    await applyCancellationTerminal({
      events: { onStreamEnd } as unknown as KodaXEvents,
      emitActiveExtensionEvent: emit,
      messages,
      toolResults: [cancelledBlock('t1')],
      completedTurnTokenSnapshot: fakeSnapshot(),
      sessionId: 'sess-1',
      iter: 0,
      emitIterationEnd,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(onStreamEnd).toHaveBeenCalledOnce();
    // turn:end + stream:end emissions
    const turnEndCall = (emit as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === 'turn:end');
    const streamEndCall = (emit as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === 'stream:end');
    expect(turnEndCall).toBeDefined();
    expect(streamEndCall).toBeDefined();
    expect((turnEndCall![1] as Record<string, unknown>).lastText).toBe(CANCELLATION_LAST_TEXT);
  });

  it('CAP-CANCEL-TERMINAL-002a: shouldYieldToQueuedFollowUp = true when events.hasPendingInputs returns true', async () => {
    const result = await applyCancellationTerminal({
      events: { hasPendingInputs: () => true } as unknown as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages: [],
      toolResults: [cancelledBlock('t1')],
      completedTurnTokenSnapshot: fakeSnapshot(),
      sessionId: 'sess-1',
      iter: 0,
      emitIterationEnd: vi.fn().mockReturnValue(fakeSnapshot()),
    });
    expect(result.shouldYieldToQueuedFollowUp).toBe(true);
  });

  it('CAP-CANCEL-TERMINAL-002b: shouldYieldToQueuedFollowUp = false when events.hasPendingInputs returns false (or absent)', async () => {
    const noInputsResult = await applyCancellationTerminal({
      events: { hasPendingInputs: () => false } as unknown as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages: [],
      toolResults: [cancelledBlock('t1')],
      completedTurnTokenSnapshot: fakeSnapshot(),
      sessionId: 'sess-1',
      iter: 0,
      emitIterationEnd: vi.fn().mockReturnValue(fakeSnapshot()),
    });
    expect(noInputsResult.shouldYieldToQueuedFollowUp).toBe(false);

    const noHookResult = await applyCancellationTerminal({
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages: [],
      toolResults: [cancelledBlock('t1')],
      completedTurnTokenSnapshot: fakeSnapshot(),
      sessionId: 'sess-1',
      iter: 0,
      emitIterationEnd: vi.fn().mockReturnValue(fakeSnapshot()),
    });
    expect(noHookResult.shouldYieldToQueuedFollowUp).toBe(false);
  });

  it('CAP-CANCEL-TERMINAL-002c: emitIterationEnd is called when shouldYieldToQueuedFollowUp is true', async () => {
    const emitIterationEnd = vi.fn().mockReturnValue(fakeSnapshot());
    await applyCancellationTerminal({
      events: { hasPendingInputs: () => true } as unknown as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages: [],
      toolResults: [cancelledBlock('t1')],
      completedTurnTokenSnapshot: fakeSnapshot(),
      sessionId: 'sess-1',
      iter: 5,
      emitIterationEnd,
    });
    expect(emitIterationEnd).toHaveBeenCalledOnce();
    expect(emitIterationEnd.mock.calls[0]![0]).toBe(6); // iter + 1
  });

  it('CAP-CANCEL-TERMINAL-002d: emitIterationEnd is NOT called when shouldYieldToQueuedFollowUp is false', async () => {
    const emitIterationEnd = vi.fn();
    await applyCancellationTerminal({
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages: [],
      toolResults: [cancelledBlock('t1')],
      completedTurnTokenSnapshot: fakeSnapshot(),
      sessionId: 'sess-1',
      iter: 0,
      emitIterationEnd,
    });
    expect(emitIterationEnd).not.toHaveBeenCalled();
  });
});

describe('CAP-080: CANCELLATION_LAST_TEXT — pinned constant', () => {
  it('CAP-CANCEL-TERMINAL-CONSTANT-001: lastText is exactly "Operation cancelled by user"', () => {
    expect(CANCELLATION_LAST_TEXT).toBe('Operation cancelled by user');
  });
});
