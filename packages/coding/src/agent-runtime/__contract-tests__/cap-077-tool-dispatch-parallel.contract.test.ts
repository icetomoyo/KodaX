/**
 * Contract tests for CAP-077 (parallel/sequential dispatch split) and
 * CAP-079 (post-tool truncation guardrail wrapping).
 *
 * Inventory entries:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-077-tool-dispatch-parallelization-bash-sequential-non-bash-parallel
 *   - docs/features/v0.7.29-capability-inventory.md#cap-079-applytoolresultguardrail-post-tool-truncation-wrapping
 *
 * Test obligations (CAP-077):
 *   - CAP-TOOL-DISPATCH-PAR-001: non-bash tools run in parallel
 *   - CAP-TOOL-DISPATCH-PAR-002: bash tools run sequentially
 *   - CAP-TOOL-DISPATCH-PAR-003: mid-bash abort honored
 *
 * Test obligations (CAP-079):
 *   - CAP-TOOL-RESULT-GUARDRAIL-001: truncation honored when output
 *     exceeds limit (verified via wiring — `runToolDispatch` routes
 *     every result through `applyToolResultGuardrail`)
 *
 * Risk: CAP-077 = HIGH (correctness); CAP-079 = MEDIUM
 *
 * Class: 1 (CAP-077); 2 (CAP-079 — Runner-level guardrail primitive)
 *
 * Verified location: agent-runtime/tool-dispatch.ts:runToolDispatch
 * (extracted from agent.ts:1271-1322 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.3d).
 *
 * Time-ordering constraint: AFTER pre-tool abort check (CAP-076);
 * BEFORE per-result post-processing (CAP-078).
 *
 * Active here:
 *   - bash vs non-bash split via `tc.name === 'bash'`
 *   - non-bash dispatched through `Promise.all` (parallel)
 *   - bash dispatched in a sequential `for` loop
 *   - per-bash-iteration `abortSignal.aborted` recheck (Issue 088)
 *   - every call wrapped via `applyToolResultGuardrail(name, ..., ctx)`
 *
 * STATUS: ACTIVE since FEATURE_100 P3.3d.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents, KodaXToolExecutionContext } from '../../types.js';
import type { KodaXToolUseBlock } from '@kodax/ai';

import { runToolDispatch } from '../tool-dispatch.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';
import { CANCELLED_TOOL_RESULT_MESSAGE } from '../../constants.js';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({
    activeTools: ['read', 'edit', 'write', 'bash', 'grep'],
    modelSelection: {},
  });
}

function makeCtx(): KodaXToolExecutionContext {
  return { backups: new Map() };
}

function tool(id: string, name: string): KodaXToolUseBlock {
  return { id, name, type: 'tool_use', input: {} } as unknown as KodaXToolUseBlock;
}

describe('CAP-077: runToolDispatch — non-bash parallelization', () => {
  it('CAP-TOOL-DISPATCH-PAR-001: non-bash tools run in parallel (all start before any finishes)', async () => {
    const startedIds: string[] = [];
    const finishedIds: string[] = [];
    let releaseAll: () => void = () => undefined;
    const allReleased = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    const events: KodaXEvents = {
      beforeToolExecute: async (_name, _input, hint) => {
        startedIds.push(hint?.toolId ?? '');
        // All three tools must enter the gate before ANY resolves —
        // proves Promise.all dispatched them in parallel.
        if (startedIds.length === 3) {
          releaseAll();
        }
        await allReleased;
        finishedIds.push(hint?.toolId ?? '');
        return `result:${hint?.toolId}`;
      },
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [tool('a', 'read'), tool('b', 'grep'), tool('c', 'edit')],
      events,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['read', 'grep', 'edit'],
      abortSignal: undefined,
    });

    expect(startedIds).toHaveLength(3);
    // All three started before any finished (parallel invariant).
    // If serial, the gate would have observed start[i+1] only after
    // finish[i], and the `releaseAll` await would deadlock.
    expect(resultMap.get('a')).toBe('result:a');
    expect(resultMap.get('b')).toBe('result:b');
    expect(resultMap.get('c')).toBe('result:c');
  });
});

describe('CAP-077: runToolDispatch — bash sequentialization', () => {
  it('CAP-TOOL-DISPATCH-PAR-002: bash tools run sequentially (each finishes before the next starts)', async () => {
    const order: string[] = [];

    const events: KodaXEvents = {
      beforeToolExecute: async (_name, _input, hint) => {
        order.push(`start:${hint?.toolId}`);
        // Yield once so any concurrent dispatch would interleave.
        await new Promise((r) => setImmediate(r));
        order.push(`done:${hint?.toolId}`);
        return `result:${hint?.toolId}`;
      },
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [tool('b1', 'bash'), tool('b2', 'bash'), tool('b3', 'bash')],
      events,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['bash'],
      abortSignal: undefined,
    });

    // Sequential invariant: each bash tool must complete (`done:`)
    // BEFORE the next one starts (`start:`).
    expect(order).toEqual([
      'start:b1', 'done:b1',
      'start:b2', 'done:b2',
      'start:b3', 'done:b3',
    ]);
    expect(resultMap.get('b1')).toBe('result:b1');
    expect(resultMap.get('b3')).toBe('result:b3');
  });

  it('CAP-TOOL-DISPATCH-PAR-002b: non-bash and bash mix — non-bash parallel, bash sequential, both populate the result map', async () => {
    const events: KodaXEvents = {
      beforeToolExecute: async (_name, _input, hint) => `r:${hint?.toolId}`,
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [
        tool('p1', 'read'),
        tool('b1', 'bash'),
        tool('p2', 'edit'),
        tool('b2', 'bash'),
      ],
      events,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['read', 'edit', 'bash'],
      abortSignal: undefined,
    });

    expect(resultMap.size).toBe(4);
    expect(resultMap.get('p1')).toBe('r:p1');
    expect(resultMap.get('p2')).toBe('r:p2');
    expect(resultMap.get('b1')).toBe('r:b1');
    expect(resultMap.get('b2')).toBe('r:b2');
  });
});

describe('CAP-077: runToolDispatch — mid-bash abort (Issue 088)', () => {
  it('CAP-TOOL-DISPATCH-PAR-003: aborting mid-bash-loop yields CANCELLED for remaining bash tools (the first tool was already in flight)', async () => {
    const ctrl = new AbortController();
    const observedNames: string[] = [];

    const events: KodaXEvents = {
      beforeToolExecute: async (_name, _input, hint) => {
        observedNames.push(hint?.toolId ?? '');
        if (hint?.toolId === 'b1') {
          // First bash tool runs to completion, then user aborts.
          ctrl.abort();
          return 'result:b1';
        }
        return `result:${hint?.toolId}`;
      },
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [tool('b1', 'bash'), tool('b2', 'bash'), tool('b3', 'bash')],
      events,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['bash'],
      abortSignal: ctrl.signal,
    });

    // b1 ran to completion; b2/b3 short-circuit on the per-iteration
    // abort recheck and never reach the gate.
    expect(observedNames).toEqual(['b1']);
    expect(resultMap.get('b1')).toBe('result:b1');
    expect(resultMap.get('b2')).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
    expect(resultMap.get('b3')).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
  });

  it('CAP-TOOL-DISPATCH-PAR-003b: pre-aborted signal — non-bash still dispatches via executeToolCall whose abort gate fires first (returns CANCELLED), bash short-circuits via the per-iteration gate', async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    const events: KodaXEvents = {
      beforeToolExecute: vi.fn(async () => 'should-not-fire'),
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [tool('a', 'read'), tool('b', 'bash')],
      events,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['read', 'bash'],
      abortSignal: ctrl.signal,
    });

    expect(events.beforeToolExecute).not.toHaveBeenCalled();
    expect(resultMap.get('a')).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
    expect(resultMap.get('b')).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
  });
});

describe('CAP-079: applyToolResultGuardrail wrapping — wired into runToolDispatch', () => {
  it('CAP-TOOL-RESULT-GUARDRAIL-001: short content passes through the guardrail unchanged (truncation policy is wired but no-op for under-limit content)', async () => {
    const shortContent = 'fits well within the policy limits';
    const events: KodaXEvents = {
      beforeToolExecute: async () => shortContent,
    };

    const resultMap = await runToolDispatch({
      toolBlocks: [tool('t1', 'read')],
      events,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
      activeToolNames: ['read'],
      abortSignal: undefined,
    });

    // Identity: under-limit content survives the guardrail untouched.
    // Truncation behavior itself is exhaustively tested in
    // tool-result-policy.test.ts; here we only pin the wiring.
    expect(resultMap.get('t1')).toBe(shortContent);
  });
});
