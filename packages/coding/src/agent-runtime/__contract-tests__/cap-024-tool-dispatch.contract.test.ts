/**
 * Contract test for CAP-024: tool execution dispatch + `createToolResultBlock`
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-024-tool-execution-dispatch
 *
 * Test obligations:
 * - CAP-TOOL-DISPATCH-001: success path produces tool_result block
 * - CAP-TOOL-DISPATCH-002: error path triggers CAP-015 (edit recovery)
 * - CAP-TOOL-DISPATCH-003: cancellation surfaces correctly
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/tool-dispatch.ts (extracted from
 * agent.ts:873-880 (`createToolResultBlock`) + 1306-1379
 * (`executeToolCall`) — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER permission gate (CAP-010); results
 * feed into mutation reflection (CAP-016) and tool-result truncation
 * guardrail.
 *
 * Active here:
 *   - The 7-step dispatch sequence: abort gate → visibility events →
 *     permission gate (override) → active-tool gate → write block
 *     (CAP-015) → tool execution → MCP fallback (CAP-025).
 *   - `createToolResultBlock` `is_error` field omission contract (CAP-037 envelope).
 *
 * Deferred (P3 — needs full Runner-frame fixture / live tool registry):
 * - CAP-TOOL-DISPATCH-002 integration: full edit-recovery round-trip
 *   (anchor-not-found → recovery prompt → next-turn retry). The unit
 *   contract that the dispatch path WIRES recovery is pinned here via
 *   the `maybeBlockExistingFileWrite` short-circuit; the multi-turn
 *   recovery flow is integration-tested in `child-executor.test.ts`.
 *
 * STATUS: ACTIVE since FEATURE_100 P2 for the dispatch sequence.
 */

import { describe, expect, it } from 'vitest';

import type {
  KodaXEvents,
  KodaXToolExecutionContext,
} from '../../types.js';
import {
  createToolResultBlock,
  executeToolCall,
} from '../tool-dispatch.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';
import { CANCELLED_TOOL_RESULT_MESSAGE } from '../../constants.js';
import type { RunnableToolCall } from '../middleware/edit-recovery.js';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({
    activeTools: ['read', 'edit', 'write'],
    modelSelection: {},
  });
}

function makeCtx(): KodaXToolExecutionContext {
  return { backups: new Map() };
}

function makeToolCall(
  name: string,
  input: Record<string, unknown> = {},
): RunnableToolCall {
  return { id: 't1', name, input } as RunnableToolCall;
}

describe('CAP-024: createToolResultBlock — is_error envelope detection', () => {
  it('CAP-TOOL-DISPATCH-001a: success content → block omits `is_error` field', () => {
    const block = createToolResultBlock('id-1', 'hello world');
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'id-1',
      content: 'hello world',
    });
    expect('is_error' in block).toBe(false);
  });

  it('CAP-TOOL-DISPATCH-001b: `[Tool Error]` prefix → block sets `is_error: true`', () => {
    const block = createToolResultBlock('id-2', '[Tool Error] read: missing');
    expect(block.is_error).toBe(true);
  });

  it('CAP-TOOL-DISPATCH-001c: `[Cancelled]` prefix → also sets `is_error: true` (CAP-037 envelope shape)', () => {
    const block = createToolResultBlock('id-3', '[Cancelled] user aborted');
    expect(block.is_error).toBe(true);
  });

  it('CAP-TOOL-DISPATCH-001d: `[Blocked]` prefix → also sets `is_error: true`', () => {
    const block = createToolResultBlock('id-4', '[Blocked] permission denied');
    expect(block.is_error).toBe(true);
  });
});

describe('CAP-024: executeToolCall — abort gate (Issue 088)', () => {
  it('CAP-TOOL-DISPATCH-003: pre-aborted signal → returns CANCELLED_TOOL_RESULT_MESSAGE WITHOUT executing the tool', async () => {
    const aborted = new AbortController();
    aborted.abort();

    let toolStarted = false;
    const events: KodaXEvents = {
      onToolUseStart: () => { toolStarted = true; },
    };

    const result = await executeToolCall(
      events,
      makeToolCall('read', { path: 'x' }),
      makeCtx(),
      freshState(),
      undefined,
      aborted.signal,
    );

    expect(result).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
    // Abort gate fires BEFORE the start event, so the host never sees
    // the tool fire — important for cancel-during-await UX.
    expect(toolStarted).toBe(false);
  });
});

describe('CAP-024: executeToolCall — active-tool gate', () => {
  it('CAP-TOOL-DISPATCH-ACTIVE-1: tool name not in `activeToolNames` → returns structured `[Tool Error] ... Tool is not active in the current runtime.` envelope (without invoking permission gate or registry)', async () => {
    const result = await executeToolCall(
      {} as KodaXEvents,
      makeToolCall('forbidden_tool'),
      makeCtx(),
      freshState(),
      ['read', 'edit'], // forbidden_tool is NOT in this list
    );

    expect(result).toBe('[Tool Error] forbidden_tool: Tool is not active in the current runtime.');
  });

  it('CAP-TOOL-DISPATCH-ACTIVE-2: undefined `activeToolNames` (no restriction) → does NOT short-circuit on this gate', async () => {
    // We don't run the registry here (would need a real tool); instead
    // we use the permission-gate override to short-circuit dispatch
    // BEFORE the registry call, so we can prove the active-tool gate
    // didn't fire (different message would have surfaced).
    const events: KodaXEvents = {
      beforeToolExecute: async () => 'permission-override-result',
    };

    const result = await executeToolCall(
      events,
      makeToolCall('exotic_tool'),
      makeCtx(),
      freshState(),
      undefined, // no restriction
    );

    expect(result).toBe('permission-override-result');
    // Critical: the message is the override, NOT the active-tool gate
    // error. This proves undefined activeToolNames bypasses that gate.
  });
});

describe('CAP-024: executeToolCall — permission gate (CAP-010) override', () => {
  it('CAP-TOOL-DISPATCH-PERMISSION-1: `beforeToolExecute` returning a string short-circuits dispatch and uses the returned string as the result', async () => {
    let registryCalled = false;
    const events: KodaXEvents = {
      beforeToolExecute: async () => '[Blocked] denied by user',
      // Synthesised registry-fail signal — if dispatch leaks past the
      // gate to the real registry, the test would crash on the
      // unknown tool name; the assertion proves we returned early.
      onToolUseStart: () => { registryCalled = true; },
    };

    const result = await executeToolCall(
      events,
      makeToolCall('read', { path: '/dev/null' }),
      makeCtx(),
      freshState(),
      ['read'],
    );

    expect(result).toBe('[Blocked] denied by user');
    // The start event WAS emitted (before permission gate), but the
    // override prevented the dispatch from reaching the registry.
    expect(registryCalled).toBe(true);
  });
});

describe('CAP-024: executeToolCall — write block (CAP-015) short-circuit', () => {
  it('CAP-TOOL-DISPATCH-EDIT-RECOVERY: a path in `runtimeSessionState.blockedEditWrites` causes `write` to short-circuit with the structured block message (CAP-015 wiring)', async () => {
    // `maybeBlockExistingFileWrite` only blocks when the file ACTUALLY
    // exists (otherwise it self-cleans the blocked entry). Use the
    // contract-test file itself as a guaranteed-existing target — no
    // write actually happens, the block fires before tool execution.
    const path = await import('path');
    const realFile = path.resolve(__filename);
    const state = freshState();
    state.blockedEditWrites.add(realFile);

    const result = await executeToolCall(
      {} as KodaXEvents,
      makeToolCall('write', { path: __filename, content: 'x' }),
      makeCtx(),
      state,
      ['write'],
    );

    // CAP-015's exact message: `[Tool Error] write: BLOCKED_AFTER_EDIT_FAILURE: ...`
    expect(result).toMatch(/^\[Tool Error\] write: BLOCKED_AFTER_EDIT_FAILURE:/);
  });

  // The "self-cleaning when path no longer exists" branch of
  // `maybeBlockExistingFileWrite` is covered by CAP-015's own contract
  // tests — it's an internal edit-recovery invariant. Re-asserting it
  // through `executeToolCall` would just exercise the same code path
  // through one extra layer (the permission gate fires BEFORE the
  // write-block check, complicating the setup), so we only pin the
  // POSITIVE block-fires case here.
});

describe('CAP-024: executeToolCall — managed-protocol visibility', () => {
  it('CAP-TOOL-DISPATCH-VISIBILITY: managed-protocol tool name (e.g. `emit_managed_protocol`) does NOT fire `onToolUseStart` — invisible to the host (CAP-035)', async () => {
    let started = false;
    const events: KodaXEvents = {
      onToolUseStart: () => { started = true; },
      // Permission-gate override short-circuits BEFORE the registry,
      // so we don't need a real handler for the protocol tool.
      beforeToolExecute: async () => 'managed-result',
    };

    await executeToolCall(
      events,
      makeToolCall('emit_managed_protocol', { payload: {} }),
      makeCtx(),
      freshState(),
      ['emit_managed_protocol'],
    );

    expect(started).toBe(false);
  });
});
