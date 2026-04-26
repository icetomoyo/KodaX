/**
 * Contract test for CAP-026: tool outcome tracking (success/failure history)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-026-tool-outcome-tracking-successfailure-history
 *
 * Test obligations:
 * - CAP-TOOL-OUTCOME-001: failure increments counter, feeds into CAP-018 contract
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/middleware/tool-outcome-tracking.ts (extracted from
 * agent.ts:1034-1054 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER tool result settle; BEFORE post-tool judge (CAP-018).
 *
 * Active here: the three-write contract on `RuntimeSessionState`
 * (`lastToolResultBytes`, `lastToolErrorCode`, `editRecoveryAttempts`
 * cleanup) for the two anchor-bearing tools (`edit`,
 * `insert_after_anchor`). The asymmetry between the two — `edit` uses
 * `parseEditToolError`, `insert_after_anchor` uses
 * `isToolResultErrorContent` — is load-bearing and pinned here.
 *
 * P3 note: when CAP-024 (`executeToolCall`) is extracted, this module
 * will likely co-locate per inventory's "shared with CAP-024" annotation.
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import path from 'path';

import { describe, expect, it } from 'vitest';

import type { KodaXToolExecutionContext } from '../../types.js';
import { updateToolOutcomeTracking } from '../middleware/tool-outcome-tracking.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';
import type { RunnableToolCall } from '../middleware/edit-recovery.js';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({
    activeTools: ['edit', 'insert_after_anchor', 'read'],
    modelSelection: {},
  });
}

function makeCtx(): KodaXToolExecutionContext {
  return { backups: new Map() };
}

function makeToolCall(name: string, input: Record<string, unknown> = {}): RunnableToolCall {
  return { id: 't1', name, input } as RunnableToolCall;
}

// `resolveToolTargetPath` runs the tool's `path` arg through
// `resolveExecutionPath`, which resolves to an absolute (and on
// Windows, drive-letter-prefixed) path. Tests must pre-populate the
// edit-recovery map with the SAME resolved key, otherwise the
// `delete(resolvedPath)` becomes a no-op and the assertion fails.
function resolved(p: string): string {
  return path.resolve(p);
}

describe('CAP-026: updateToolOutcomeTracking — telemetry writes', () => {
  it('CAP-TOOL-OUTCOME-001a: every call sets lastToolResultBytes to UTF-8 byte length of toolResult', () => {
    const state = freshState();
    updateToolOutcomeTracking(makeToolCall('read', { path: 'x' }), 'hello world', state, makeCtx());
    expect(state.lastToolResultBytes).toBe(11);
  });

  it('CAP-TOOL-OUTCOME-001b: lastToolErrorCode is populated from CAP-032 envelope and cleared on success', () => {
    const state = freshState();
    updateToolOutcomeTracking(
      makeToolCall('read'),
      '[Tool Error] read: FILE_NOT_FOUND: missing',
      state,
      makeCtx(),
    );
    expect(state.lastToolErrorCode).toBe('FILE_NOT_FOUND');

    updateToolOutcomeTracking(makeToolCall('read'), 'plain success output', state, makeCtx());
    expect(state.lastToolErrorCode).toBeUndefined();
  });

  it('CAP-TOOL-OUTCOME-001c: lastToolResultBytes correctly counts multi-byte UTF-8 (Chinese characters: 3 bytes each in UTF-8)', () => {
    const state = freshState();
    updateToolOutcomeTracking(makeToolCall('read'), '你好', state, makeCtx());
    expect(state.lastToolResultBytes).toBe(6);
  });
});

describe('CAP-026: updateToolOutcomeTracking — anchor-tool edit-recovery cleanup', () => {
  it('CAP-TOOL-OUTCOME-001d: `edit` success (parseEditToolError returns falsy) clears editRecoveryAttempts for resolved path', () => {
    const state = freshState();
    const fooKey = resolved('/abs/foo.ts');
    const otherKey = resolved('/abs/other.ts');
    state.editRecoveryAttempts.set(fooKey, 2);
    state.editRecoveryAttempts.set(otherKey, 1);

    updateToolOutcomeTracking(
      makeToolCall('edit', { path: '/abs/foo.ts' }),
      'success: 1 edits applied',
      state,
      makeCtx(),
    );

    expect(state.editRecoveryAttempts.has(fooKey)).toBe(false);
    expect(state.editRecoveryAttempts.get(otherKey)).toBe(1);
  });

  it('CAP-TOOL-OUTCOME-001e: `edit` failure (parseEditToolError returns truthy) does NOT clear editRecoveryAttempts — and the function early-returns BEFORE the insert_after_anchor branch', () => {
    const state = freshState();
    const fooKey = resolved('/abs/foo.ts');
    state.editRecoveryAttempts.set(fooKey, 2);

    // `parseEditToolError` only recognises three structured error codes
    // (`EDIT_NOT_FOUND` / `EDIT_AMBIGUOUS` / `EDIT_TOO_LARGE`). Anything
    // else (including the generic `[Tool Error]` envelope) returns
    // undefined, which the outcome tracker treats as success — that is
    // pre-existing baseline behaviour and load-bearing for this branch.
    updateToolOutcomeTracking(
      makeToolCall('edit', { path: '/abs/foo.ts' }),
      '[Tool Error] edit: EDIT_NOT_FOUND: anchor missing',
      state,
      makeCtx(),
    );

    expect(state.editRecoveryAttempts.get(fooKey)).toBe(2);
  });

  it('CAP-TOOL-OUTCOME-001f: `insert_after_anchor` success (no [Tool Error] envelope) clears editRecoveryAttempts', () => {
    const state = freshState();
    const fooKey = resolved('/abs/foo.ts');
    state.editRecoveryAttempts.set(fooKey, 3);

    updateToolOutcomeTracking(
      makeToolCall('insert_after_anchor', { path: '/abs/foo.ts' }),
      'inserted 5 lines',
      state,
      makeCtx(),
    );

    expect(state.editRecoveryAttempts.has(fooKey)).toBe(false);
  });

  it('CAP-TOOL-OUTCOME-001g: `insert_after_anchor` failure ([Tool Error] envelope) does NOT clear editRecoveryAttempts', () => {
    const state = freshState();
    const fooKey = resolved('/abs/foo.ts');
    state.editRecoveryAttempts.set(fooKey, 3);

    updateToolOutcomeTracking(
      makeToolCall('insert_after_anchor', { path: '/abs/foo.ts' }),
      '[Tool Error] insert_after_anchor: anchor not found',
      state,
      makeCtx(),
    );

    expect(state.editRecoveryAttempts.get(fooKey)).toBe(3);
  });

  it('CAP-TOOL-OUTCOME-001h: non-anchor tools (e.g. `read`, `write`) never touch editRecoveryAttempts', () => {
    const state = freshState();
    const fooKey = resolved('/abs/foo.ts');
    state.editRecoveryAttempts.set(fooKey, 1);

    updateToolOutcomeTracking(
      makeToolCall('read', { path: '/abs/foo.ts' }),
      'file contents',
      state,
      makeCtx(),
    );
    updateToolOutcomeTracking(
      makeToolCall('write', { path: '/abs/foo.ts' }),
      'wrote 100 bytes',
      state,
      makeCtx(),
    );

    expect(state.editRecoveryAttempts.get(fooKey)).toBe(1);
  });
});
