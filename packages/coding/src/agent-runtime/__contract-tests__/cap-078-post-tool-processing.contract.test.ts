/**
 * Contract test for CAP-078: per-result post-processing chain
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-078-per-result-post-processing-chain-mutation-reflection-outcome-tracking-edit-recovery-visibility-events
 *
 * Test obligations:
 * - CAP-POST-TOOL-001: mutation reflection injected once when threshold crossed
 * - CAP-POST-TOOL-002: edit failure produces recovery message
 * - CAP-POST-TOOL-003: only visible tools emit events / push tool_result
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/tool-dispatch.ts:applyPostToolProcessing
 * (extracted from agent.ts:1324-1353 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.3d).
 *
 * Time-ordering constraint: AFTER tool execution + applyToolResultGuardrail;
 * BEFORE history push and `hasCancellation` check.
 *
 * Active here:
 *   - mutation reflection appended once on first significant mutation result
 *   - `updateToolOutcomeTracking` called for every tool block
 *   - edit-error → `buildEditRecoveryUserMessage` synthesizes recovery
 *   - visible tools emit `tool:result` ext event + `events.onToolResult`
 *     and push `tool_result` block; invisible tools are dropped from the
 *     transcript
 *
 * STATUS: ACTIVE since FEATURE_100 P3.3d.
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  KodaXEvents,
  KodaXToolExecutionContext,
} from '../../types.js';
import type { KodaXToolUseBlock } from '@kodax/ai';

import { applyPostToolProcessing } from '../tool-dispatch.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';
import type { ExtensionEventEmitter } from '../stream-handler-wiring.js';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({
    activeTools: ['read', 'edit', 'write', 'bash'],
    modelSelection: {},
  });
}

function makeCtx(): KodaXToolExecutionContext {
  return { backups: new Map() };
}

function fakeEmitter(): ExtensionEventEmitter {
  return vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter;
}

function tool(id: string, name: string, input: Record<string, unknown> = {}): KodaXToolUseBlock {
  return { id, name, type: 'tool_use', input } as unknown as KodaXToolUseBlock;
}

describe('CAP-078: applyPostToolProcessing — mutation reflection (CAP-016)', () => {
  it('CAP-POST-TOOL-001a: significant mutation scope on a write tool result → reflection appended once, marker set', async () => {
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      mutationTracker: {
        files: new Map([
          ['a.ts', 50],
          ['b.ts', 50],
          ['c.ts', 50],
        ]),
        totalOps: 0,
      },
    };
    const resultMap = new Map<string, string>([['t1', 'wrote 3 files']]);

    const out = await applyPostToolProcessing({
      toolBlocks: [tool('t1', 'write', { path: '/x.ts', content: 'x' })],
      resultMap,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      ctx,
      runtimeSessionState: freshState(),
    });

    expect(out.toolResults).toHaveLength(1);
    expect(out.toolResults[0]!.content).toMatch(/Scope: 3 files modified/);
    expect(ctx.mutationTracker?.reflectionInjected).toBe(true);
  });

  it('CAP-POST-TOOL-001b: reflection NOT injected on error result (envelope guard)', async () => {
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      mutationTracker: {
        files: new Map([['a.ts', 50], ['b.ts', 50], ['c.ts', 50]]),
        totalOps: 0,
      },
    };
    const resultMap = new Map<string, string>([['t1', '[Tool Error] write: failed']]);

    const out = await applyPostToolProcessing({
      toolBlocks: [tool('t1', 'write')],
      resultMap,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      ctx,
      runtimeSessionState: freshState(),
    });

    expect(out.toolResults[0]!.content).toBe('[Tool Error] write: failed');
    expect(ctx.mutationTracker?.reflectionInjected).toBeFalsy();
  });

  it('CAP-POST-TOOL-001c: reflection NOT injected on non-mutation tool', async () => {
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      mutationTracker: {
        files: new Map([['a.ts', 100]]), // line threshold met
        totalOps: 0,
      },
    };
    const resultMap = new Map<string, string>([['t1', 'normal read result']]);

    const out = await applyPostToolProcessing({
      toolBlocks: [tool('t1', 'read')],
      resultMap,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      ctx,
      runtimeSessionState: freshState(),
    });

    expect(out.toolResults[0]!.content).toBe('normal read result');
    expect(ctx.mutationTracker?.reflectionInjected).toBeFalsy();
  });

  it('CAP-POST-TOOL-001e: cancelled mutation tool result ([Cancelled] envelope) → reflection NOT injected (envelope guard treats cancelled as failure)', async () => {
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      mutationTracker: {
        files: new Map([['a.ts', 50], ['b.ts', 50], ['c.ts', 50]]),
        totalOps: 0,
      },
    };
    // [Cancelled] prefix is the same envelope shape that the
    // mid-bash cancellation path emits; mutation reflection must
    // skip just like it does for other error envelopes.
    const resultMap = new Map<string, string>([
      ['t1', '[Cancelled] Operation cancelled by user'],
    ]);

    const out = await applyPostToolProcessing({
      toolBlocks: [tool('t1', 'bash', { command: 'rm -rf /tmp/x' })],
      resultMap,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      ctx,
      runtimeSessionState: freshState(),
    });

    expect(out.toolResults[0]!.content).toBe('[Cancelled] Operation cancelled by user');
    expect(ctx.mutationTracker?.reflectionInjected).toBeFalsy();
  });

  it('CAP-POST-TOOL-001d: reflection injected ONCE — second mutation result in same batch does NOT re-append', async () => {
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      mutationTracker: {
        files: new Map([['a.ts', 50], ['b.ts', 50], ['c.ts', 50]]),
        totalOps: 0,
      },
    };
    const resultMap = new Map<string, string>([
      ['t1', 'first mutation'],
      ['t2', 'second mutation'],
    ]);

    const out = await applyPostToolProcessing({
      toolBlocks: [
        tool('t1', 'write', { path: '/a.ts', content: 'x' }),
        tool('t2', 'write', { path: '/b.ts', content: 'y' }),
      ],
      resultMap,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      ctx,
      runtimeSessionState: freshState(),
    });

    // First result has reflection appended; second does not.
    expect(out.toolResults[0]!.content).toMatch(/Scope: 3 files modified/);
    expect(out.toolResults[1]!.content).toBe('second mutation');
  });
});

describe('CAP-078: applyPostToolProcessing — edit recovery (CAP-015)', () => {
  it('CAP-POST-TOOL-002: edit-tool error envelope → recovery message synthesized into editRecoveryMessages', async () => {
    const resultMap = new Map<string, string>([
      ['t1', '[Tool Error] edit: EDIT_TOO_LARGE: bigger than allowed'],
    ]);

    const out = await applyPostToolProcessing({
      toolBlocks: [tool('t1', 'edit', { path: '/tmp/file.ts' })],
      resultMap,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
    });

    // The edit recovery builder produces a non-empty message keyed off
    // the EDIT_TOO_LARGE classification.
    expect(out.editRecoveryMessages).toHaveLength(1);
    expect(out.editRecoveryMessages[0]).toMatch(/EDIT_TOO_LARGE/);
  });

  it('CAP-POST-TOOL-002b: non-edit tool error → no recovery message', async () => {
    const resultMap = new Map<string, string>([
      ['t1', '[Tool Error] read: file not found'],
    ]);

    const out = await applyPostToolProcessing({
      toolBlocks: [tool('t1', 'read', { path: '/missing' })],
      resultMap,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
    });

    expect(out.editRecoveryMessages).toHaveLength(0);
  });

  it('CAP-POST-TOOL-002c: edit-tool success (no error envelope) → no recovery message', async () => {
    const resultMap = new Map<string, string>([['t1', 'edit applied successfully']]);

    const out = await applyPostToolProcessing({
      toolBlocks: [tool('t1', 'edit', { path: '/tmp/file.ts' })],
      resultMap,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
    });

    expect(out.editRecoveryMessages).toHaveLength(0);
  });
});

describe('CAP-078: applyPostToolProcessing — visibility events', () => {
  it('CAP-POST-TOOL-003: visible tools emit `tool:result` extension event + `events.onToolResult` AND push tool_result block; invisible tools (emit_managed_protocol) emit nothing and are absent from toolResults', async () => {
    const onToolResult = vi.fn();
    const emit = fakeEmitter();
    const resultMap = new Map<string, string>([
      ['vis', 'visible result'],
      ['hid', 'managed protocol result'],
    ]);

    const out = await applyPostToolProcessing({
      toolBlocks: [
        tool('vis', 'read'),
        tool('hid', 'emit_managed_protocol'),
      ],
      resultMap,
      events: { onToolResult } as unknown as KodaXEvents,
      emitActiveExtensionEvent: emit,
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
    });

    // Only the visible tool fires events and contributes a result block.
    expect(out.toolResults).toHaveLength(1);
    expect(out.toolResults[0]!.tool_use_id).toBe('vis');
    expect(out.toolResults[0]!.content).toBe('visible result');
    expect(onToolResult).toHaveBeenCalledExactlyOnceWith({
      id: 'vis',
      name: 'read',
      content: 'visible result',
    });
    expect(emit).toHaveBeenCalledExactlyOnceWith('tool:result', {
      id: 'vis',
      name: 'read',
      content: 'visible result',
    });
  });

  it('CAP-POST-TOOL-003b: missing entry in resultMap → fallback "[Error] No result" content', async () => {
    const out = await applyPostToolProcessing({
      toolBlocks: [tool('orphan', 'read')],
      resultMap: new Map(),
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      ctx: makeCtx(),
      runtimeSessionState: freshState(),
    });

    expect(out.toolResults).toHaveLength(1);
    expect(out.toolResults[0]!.content).toBe('[Error] No result');
  });
});
