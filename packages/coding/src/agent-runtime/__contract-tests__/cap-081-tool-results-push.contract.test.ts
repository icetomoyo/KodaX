/**
 * Contract test for CAP-081: tool result accumulation + editRecoveryMessages
 * append + settle (post-tool epilogue, non-cancellation branch).
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-081-tool-result-accumulation--editrecoverymessages-append--settle
 *
 * Test obligations:
 * - CAP-TOOL-RESULTS-PUSH-001: recovery messages flagged synthetic
 * - CAP-TOOL-RESULTS-PUSH-002: settle fires before queued-message drain
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/middleware/extension-queue.ts:pushToolResultsAndSettle
 * (extracted from agent.ts:1390-1414 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.3e).
 *
 * Time-ordering constraint: AFTER `hasCancellation` non-cancel branch;
 * BEFORE post-tool judge gate (CAP-018).
 *
 * Active here:
 *   - Push toolResults as user message
 *   - Push editRecoveryMessages (joined, _synthetic: true) when present
 *   - Rebase contextTokenSnapshot using the tool-result-extended history
 *   - Run settleExtensionTurn (extension hook fires BEFORE queue drain)
 *   - Drain runtimeSessionState.queuedMessages → if drained: rebase
 *     again, emit turn:end, signal "continue" to caller
 *
 * STATUS: ACTIVE since FEATURE_100 P3.3e.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXMessage, KodaXToolResultBlock } from '@kodax/ai';
import type { KodaXContextTokenSnapshot } from '../../types.js';

import { pushToolResultsAndSettle } from '../middleware/extension-queue.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';
import type { ExtensionEventEmitter } from '../stream-handler-wiring.js';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({ activeTools: ['read'], modelSelection: {} });
}

function fakeEmitter(): ExtensionEventEmitter {
  return vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter;
}

function fakeSnapshot(label = 'snap'): KodaXContextTokenSnapshot {
  return {
    currentTokens: 100,
    source: 'estimated',
    _label: label,
  } as unknown as KodaXContextTokenSnapshot;
}

function toolResult(id: string, content = 'ok'): KodaXToolResultBlock {
  return { type: 'tool_result', tool_use_id: id, content } as unknown as KodaXToolResultBlock;
}

describe('CAP-081: pushToolResultsAndSettle — base path (no queued messages)', () => {
  it('CAP-TOOL-RESULTS-PUSH-BASE: pushes toolResults as a user message; drainedQueuedMessages=false; turn:end NOT emitted', async () => {
    const messages: KodaXMessage[] = [];
    const emit = fakeEmitter();

    const out = await pushToolResultsAndSettle({
      messages,
      toolResults: [toolResult('t1')],
      editRecoveryMessages: [],
      completedTurnTokenSnapshot: fakeSnapshot('completed'),
      runtimeSessionState: freshState(),
      emitActiveExtensionEvent: emit,
      sessionId: 'sess-1',
      lastText: 'last',
      iter: 0,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toEqual([toolResult('t1')]);
    expect(out.drainedQueuedMessages).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('CAP-081: pushToolResultsAndSettle — recovery messages', () => {
  it('CAP-TOOL-RESULTS-PUSH-001: editRecoveryMessages flagged `_synthetic: true` and joined with double-newline separator', async () => {
    const messages: KodaXMessage[] = [];

    await pushToolResultsAndSettle({
      messages,
      toolResults: [toolResult('t1')],
      editRecoveryMessages: ['retry with smaller anchor', 'second guidance'],
      completedTurnTokenSnapshot: fakeSnapshot(),
      runtimeSessionState: freshState(),
      emitActiveExtensionEvent: fakeEmitter(),
      sessionId: 'sess-1',
      lastText: 'last',
      iter: 0,
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('user'); // tool_results message
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!._synthetic).toBe(true);
    expect(messages[1]!.content).toBe('retry with smaller anchor\n\nsecond guidance');
  });

  it('CAP-TOOL-RESULTS-PUSH-001b: empty editRecoveryMessages → no synthetic message pushed', async () => {
    const messages: KodaXMessage[] = [];
    await pushToolResultsAndSettle({
      messages,
      toolResults: [toolResult('t1')],
      editRecoveryMessages: [],
      completedTurnTokenSnapshot: fakeSnapshot(),
      runtimeSessionState: freshState(),
      emitActiveExtensionEvent: fakeEmitter(),
      sessionId: 'sess-1',
      lastText: 'last',
      iter: 0,
    });
    expect(messages).toHaveLength(1);
    expect(messages.some((m) => m._synthetic === true)).toBe(false);
  });
});

describe('CAP-081: pushToolResultsAndSettle — settle/drain ordering', () => {
  it('CAP-TOOL-RESULTS-PUSH-002: queue drain produces drainedQueuedMessages=true, turn:end fired with iter+1, queue is cleared', async () => {
    const messages: KodaXMessage[] = [];
    const state = freshState();
    // Pre-seed the queue as if an extension had pushed a follow-up
    // during settle. (The drain target lives on RuntimeSessionState;
    // pre-seeding pins the same flow that the live extension hook
    // produces — tested separately in CAP-020 contract.)
    state.queuedMessages.push({ role: 'user', content: 'follow-up from extension' });
    const emit = fakeEmitter();

    const out = await pushToolResultsAndSettle({
      messages,
      toolResults: [toolResult('t1')],
      editRecoveryMessages: [],
      completedTurnTokenSnapshot: fakeSnapshot(),
      runtimeSessionState: state,
      emitActiveExtensionEvent: emit,
      sessionId: 'sess-x',
      lastText: 'final lastText',
      iter: 5,
    });

    expect(out.drainedQueuedMessages).toBe(true);
    // tool_results message + follow-up from queue.
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toBe('follow-up from extension');
    expect(state.queuedMessages).toHaveLength(0); // splice cleared
    expect(emit).toHaveBeenCalledExactlyOnceWith('turn:end', {
      sessionId: 'sess-x',
      iteration: 6, // iter + 1
      lastText: 'final lastText',
      hadToolCalls: true,
      signal: undefined,
    });
  });

  it('CAP-TOOL-RESULTS-PUSH-002b: empty queue → no turn:end emission, drainedQueuedMessages=false', async () => {
    const emit = fakeEmitter();
    const out = await pushToolResultsAndSettle({
      messages: [],
      toolResults: [toolResult('t1')],
      editRecoveryMessages: [],
      completedTurnTokenSnapshot: fakeSnapshot(),
      runtimeSessionState: freshState(),
      emitActiveExtensionEvent: emit,
      sessionId: 'sess-1',
      lastText: 'last',
      iter: 0,
    });
    expect(out.drainedQueuedMessages).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it.todo('CAP-TOOL-RESULTS-PUSH-002c: settleExtensionTurn fires turn:settle hook BEFORE drain — pinned by CAP-020 contract; cross-CAP integration test deferred');
});
