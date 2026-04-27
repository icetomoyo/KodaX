/**
 * Integration contract for the P3.3 dispatch flow — pins the routing
 * invariants that no single CAP-level unit test can falsify.
 *
 * Inventory entries crossed:
 *   - CAP-076 (pre-tool abort): docs/features/v0.7.29-capability-inventory.md#cap-076-pre-tool-abort-check--graceful-tool-cancellation-issue-088
 *   - CAP-077 (parallel/sequential dispatch)
 *   - CAP-078 (per-result post-processing)
 *   - CAP-080 (cancellation terminal): docs/features/v0.7.29-capability-inventory.md#cap-080-cancellation-routed-terminal-hascancellation-branch--interrupted-flag
 *   - CAP-081 (push-and-settle)
 *
 * Why this file exists:
 *   The five P3.3 unit-level contract files exercise each helper in
 *   isolation. They cannot detect a routing mistake — e.g., wiring
 *   `preToolCancelled` results into `applyPostToolProcessing` (which
 *   would silently push cancelled tool_results into history and
 *   continue the loop instead of taking the cancellation terminal).
 *   This file pins the cross-helper composition.
 *
 * The asserted invariants:
 *   1. Pre-tool abort → cancelled blocks bypass `applyPostToolProcessing`
 *      → `hasCancelledToolResult` returns true → caller routes to
 *      `applyCancellationTerminal` (NOT `pushToolResultsAndSettle`).
 *   2. `applyCancellationTerminal`'s `shouldYieldToQueuedFollowUp`
 *      drives the caller's `interrupted` flag (true when no follow-up
 *      queued; false when one is).
 *   3. Non-cancelled dispatch → `pushToolResultsAndSettle` is the
 *      sole post-tool epilogue (no double-push, no cancellation
 *      terminal misfire).
 *
 * STATUS: ACTIVE since FEATURE_100 P3.3 sweep.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents, KodaXContextTokenSnapshot } from '../../types.js';
import type { KodaXMessage, KodaXToolUseBlock } from '@kodax/ai';

import {
  checkPreToolAbort,
  hasCancelledToolResult,
  applyCancellationTerminal,
  CANCELLATION_LAST_TEXT,
} from '../tool-cancellation.js';
import { applyPostToolProcessing } from '../tool-dispatch.js';
import { pushToolResultsAndSettle } from '../middleware/extension-queue.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';
import type { ExtensionEventEmitter } from '../stream-handler-wiring.js';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({ activeTools: ['read', 'edit'], modelSelection: {} });
}

function fakeEmitter(): ExtensionEventEmitter {
  return vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter;
}

function fakeSnapshot(): KodaXContextTokenSnapshot {
  return { currentTokens: 100, source: 'estimated' } as unknown as KodaXContextTokenSnapshot;
}

function tool(id: string, name: string): KodaXToolUseBlock {
  return { id, name, type: 'tool_use', input: {} } as unknown as KodaXToolUseBlock;
}

/**
 * Compose the P3.3 dispatch flow exactly as agent.ts wires it. The
 * helper returns enough state for the test to assert which branch
 * the routing took.
 */
async function runDispatchFlow(args: {
  toolBlocks: KodaXToolUseBlock[];
  abortSignal: AbortSignal | undefined;
  events: KodaXEvents;
  hasFollowUp?: boolean;
}): Promise<{
  branch: 'cancellation-terminal' | 'push-and-settle' | 'no-tools';
  messages: KodaXMessage[];
  interrupted?: boolean;
  emitter: ReturnType<typeof fakeEmitter>;
}> {
  const messages: KodaXMessage[] = [];
  const emitter = fakeEmitter();
  const events: KodaXEvents = {
    ...args.events,
    hasPendingInputs: () => args.hasFollowUp === true,
  };

  // STEP 1: pre-tool abort gate (CAP-076)
  const preToolCancelled = await checkPreToolAbort({
    toolBlocks: args.toolBlocks,
    abortSignal: args.abortSignal,
    events,
    emitActiveExtensionEvent: emitter,
  });

  let toolResults =
    preToolCancelled !== null ? preToolCancelled : [];

  if (preToolCancelled === null) {
    // STEP 2: dispatch elided in this contract — we assume an empty
    // resultMap (no tool blocks) since we are pinning routing, not
    // dispatch behavior.
    const post = await applyPostToolProcessing({
      toolBlocks: args.toolBlocks,
      resultMap: new Map(),
      events,
      emitActiveExtensionEvent: emitter,
      ctx: { backups: new Map() },
      runtimeSessionState: freshState(),
    });
    toolResults = post.toolResults;
  }

  // STEP 3: cancellation gate (CAP-080)
  if (toolResults.length === 0) {
    return { branch: 'no-tools', messages, emitter };
  }

  if (hasCancelledToolResult(toolResults)) {
    const terminal = await applyCancellationTerminal({
      events,
      emitActiveExtensionEvent: emitter,
      messages,
      toolResults,
      completedTurnTokenSnapshot: fakeSnapshot(),
      sessionId: 'sess-1',
      iter: 0,
      emitIterationEnd: vi.fn().mockReturnValue(fakeSnapshot()),
    });
    return {
      branch: 'cancellation-terminal',
      messages,
      interrupted: !terminal.shouldYieldToQueuedFollowUp,
      emitter,
    };
  }

  // STEP 4: settle (CAP-081)
  await pushToolResultsAndSettle({
    messages,
    toolResults,
    editRecoveryMessages: [],
    completedTurnTokenSnapshot: fakeSnapshot(),
    runtimeSessionState: freshState(),
    emitActiveExtensionEvent: emitter,
    sessionId: 'sess-1',
    lastText: 'last',
    iter: 0,
  });
  return { branch: 'push-and-settle', messages, emitter };
}

describe('P3.3 integration: pre-tool abort routing invariant', () => {
  it('P3.3-FLOW-001: pre-aborted signal → cancellation terminal branch (NOT push-and-settle)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await runDispatchFlow({
      toolBlocks: [tool('t1', 'read')],
      abortSignal: ctrl.signal,
      events: {},
    });
    expect(out.branch).toBe('cancellation-terminal');
    // Cancellation terminal pushed the cancelled tool_results into
    // history; the lastText surfaced via turn:end is the canonical
    // CANCELLATION_LAST_TEXT.
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.role).toBe('user');
    const turnEndCall = (out.emitter as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'turn:end',
    );
    expect((turnEndCall?.[1] as Record<string, unknown> | undefined)?.lastText).toBe(
      CANCELLATION_LAST_TEXT,
    );
  });

  it('P3.3-FLOW-002a: pre-aborted + NO queued follow-up → interrupted=true', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await runDispatchFlow({
      toolBlocks: [tool('t1', 'read')],
      abortSignal: ctrl.signal,
      events: {},
      hasFollowUp: false,
    });
    expect(out.branch).toBe('cancellation-terminal');
    expect(out.interrupted).toBe(true);
  });

  it('P3.3-FLOW-002b: pre-aborted + queued follow-up → interrupted=false (host-level resume absorbs cancellation)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await runDispatchFlow({
      toolBlocks: [tool('t1', 'read')],
      abortSignal: ctrl.signal,
      events: {},
      hasFollowUp: true,
    });
    expect(out.branch).toBe('cancellation-terminal');
    expect(out.interrupted).toBe(false);
  });
});

describe('P3.3 integration: non-cancelled dispatch routes to push-and-settle (no terminal misfire)', () => {
  it('P3.3-FLOW-003: signal not aborted + no cancelled tool_results in map → push-and-settle is sole epilogue', async () => {
    // The helper composes with an empty resultMap. `read` is a visible
    // tool, so `applyPostToolProcessing` pushes a fallback
    // `'[Error] No result'` block into toolResults (visible-tool gate
    // is true; the resultMap miss surfaces as the fallback string).
    // That content does NOT match `CANCELLED_TOOL_RESULT_MESSAGE`, so
    // `hasCancelledToolResult` returns false and the flow takes the
    // push-and-settle branch — pinning the negative-routing invariant
    // (no cancellation terminal misfire on plain dispatch errors).
    const out = await runDispatchFlow({
      toolBlocks: [tool('t1', 'read')],
      abortSignal: undefined,
      events: {},
    });
    expect(out.branch).toBe('push-and-settle');
  });
});
