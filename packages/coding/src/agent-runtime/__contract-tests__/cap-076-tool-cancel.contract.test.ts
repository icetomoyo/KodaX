/**
 * Contract test for CAP-076: pre-tool abort check + graceful tool cancellation (Issue 088)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-076-pre-tool-abort-check--graceful-tool-cancellation-issue-088
 *
 * Test obligations:
 * - CAP-TOOL-CANCEL-001: Ctrl+C before dispatch yields cancelled tool_results
 * - CAP-TOOL-CANCEL-002: no tools execute after abort
 *
 * Risk: HIGH (cancellation correctness)
 *
 * Class: 1
 *
 * Verified location: agent-runtime/tool-cancellation.ts (extracted from
 * agent.ts:1257-1271 — pre-FEATURE_100 baseline — during FEATURE_100 P3.3c)
 *
 * Time-ordering constraint: BEFORE tool execution (loop entry); also
 * re-checked per-bash-tool inside sequential loop (CAP-077, P3.3d).
 *
 * Active here:
 *   - signal not aborted → returns null (caller proceeds with normal dispatch)
 *   - signal aborted → returns array of cancelled blocks (one per VISIBLE
 *     tool — invisible tools like emit_managed_protocol are NOT included
 *     because they don't produce visible tool_results in the transcript)
 *   - tool:result extension event + onToolResult fire ONCE per visible tool
 *   - executeToolCall is NEVER called (graceful, not throwing) — verified
 *     via "no execution" pin: the function only calls emit/onToolResult,
 *     never dispatches
 *
 * STATUS: ACTIVE since FEATURE_100 P3.3c.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents } from '../../types.js';
import type { KodaXToolUseBlock } from '@kodax/ai';

import { checkPreToolAbort } from '../tool-cancellation.js';
import { CANCELLED_TOOL_RESULT_MESSAGE } from '../../constants.js';
import type { ExtensionEventEmitter } from '../stream-handler-wiring.js';

function fakeEmitter(): ExtensionEventEmitter {
  return vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter;
}

function tool(id: string, name: string): KodaXToolUseBlock {
  return { id, name, type: 'tool_use', input: {} } as unknown as KodaXToolUseBlock;
}

describe('CAP-076: checkPreToolAbort — signal not aborted', () => {
  it('CAP-TOOL-CANCEL-NOOP: undefined abortSignal → returns null (caller proceeds)', async () => {
    const result = await checkPreToolAbort({
      toolBlocks: [tool('t1', 'read')],
      abortSignal: undefined,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
    });
    expect(result).toBeNull();
  });

  it('CAP-TOOL-CANCEL-NOOP-2: abortSignal not aborted → returns null', async () => {
    const ctrl = new AbortController();
    const result = await checkPreToolAbort({
      toolBlocks: [tool('t1', 'read')],
      abortSignal: ctrl.signal,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
    });
    expect(result).toBeNull();
  });
});

describe('CAP-076: checkPreToolAbort — signal aborted', () => {
  it('CAP-TOOL-CANCEL-001: aborted signal → returns cancelled blocks for every visible tool', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await checkPreToolAbort({
      toolBlocks: [tool('t1', 'read'), tool('t2', 'edit')],
      abortSignal: ctrl.signal,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
    });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]!.tool_use_id).toBe('t1');
    expect(result![0]!.content).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
    expect(result![1]!.tool_use_id).toBe('t2');
  });

  it('CAP-TOOL-CANCEL-001-INVISIBLE: invisible tools (emit_managed_protocol) are filtered out of cancelled blocks', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await checkPreToolAbort({
      toolBlocks: [
        tool('visible', 'read'),
        tool('invisible', 'emit_managed_protocol'),
      ],
      abortSignal: ctrl.signal,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
    });
    expect(result).toHaveLength(1);
    expect(result![0]!.tool_use_id).toBe('visible');
  });

  it('CAP-TOOL-CANCEL-002: aborted signal → emits tool:result extension event + onToolResult per VISIBLE tool, no execution side effects', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const onToolResult = vi.fn();
    const emit = fakeEmitter();
    await checkPreToolAbort({
      toolBlocks: [tool('t1', 'read'), tool('invisible', 'emit_managed_protocol')],
      abortSignal: ctrl.signal,
      events: { onToolResult } as unknown as KodaXEvents,
      emitActiveExtensionEvent: emit,
    });
    // Only 1 visible tool — exactly one extension event + one consumer event
    expect(emit).toHaveBeenCalledExactlyOnceWith('tool:result', {
      id: 't1',
      name: 'read',
      content: CANCELLED_TOOL_RESULT_MESSAGE,
    });
    expect(onToolResult).toHaveBeenCalledExactlyOnceWith({
      id: 't1',
      name: 'read',
      content: CANCELLED_TOOL_RESULT_MESSAGE,
    });
  });
});
