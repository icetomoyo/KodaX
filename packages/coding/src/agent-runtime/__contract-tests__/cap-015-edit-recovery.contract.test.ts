/**
 * Contract test for CAP-015: edit anchor recovery + write-block
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-015-edit-anchor-recovery--write-block
 *
 * Test obligations:
 * - CAP-EDIT-RECOVERY-001: synthesized recovery user-message after anchor failure
 * - CAP-EDIT-RECOVERY-002: write-block on the affected path is enforced
 * - CAP-EDIT-RECOVERY-003: write-block state cleared once a successful re-read lands
 *
 * The function-level tests here pin every behaviour the substrate executor's
 * tool-error hook chain depends on:
 *
 *   • `clearEditRecoveryStateForPath` is a Map/Set delete pair (CAP-EDIT-CLEAR-*)
 *   • `maybeBlockExistingFileWrite` short-circuits for non-`write` tools and
 *     for non-blocked paths; auto-clears stale blocks for missing files
 *     (CAP-EDIT-BLOCK-*)
 *   • `buildEditRecoveryUserMessage` (CAP-EDIT-RECOVERY-001):
 *       - returns undefined when `parseEditToolError` cannot extract a code
 *       - returns the EDIT_TOO_LARGE branch text when the error code is
 *         `EDIT_TOO_LARGE`
 *       - returns the "auto-recovery exhausted" branch when attempt > 2
 *       - records attempt count and `lastToolErrorCode` on the runtime state
 *
 * The "candidate anchor" branch (≤ 2 attempts) calls `inspectEditFailure`
 * which reads the actual file from disk — covered by integration tests, not
 * function-level contract.
 *
 * Risk: MEDIUM (data-loss risk if recovery message is dropped — model may
 * retry with stale anchor)
 *
 * Verified location: agent-runtime/middleware/edit-recovery.ts (extracted from
 * agent.ts:902-1032 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER tool failure, BEFORE next prompt build.
 * Permission gate (CAP-010) consults write-block state during gate evaluation.
 *
 * STATUS: ACTIVE since FEATURE_100 P2 for state mutation + branch selection;
 * candidate-anchor integration test stays `it.todo`.
 */

import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KodaXToolExecutionContext } from '../../types.js';
import {
  type RunnableToolCall,
  buildEditRecoveryUserMessage,
  clearEditRecoveryStateForPath,
  maybeBlockExistingFileWrite,
} from '../middleware/edit-recovery.js';
import {
  type RuntimeSessionState,
  buildRuntimeSessionState,
} from '../runtime-session-state.js';

function emptyState(): RuntimeSessionState {
  return buildRuntimeSessionState({ activeTools: [], modelSelection: {} });
}

function makeCtx(overrides: Partial<KodaXToolExecutionContext> = {}): KodaXToolExecutionContext {
  return {
    backups: new Map(),
    executionCwd: '/repo',
    ...overrides,
  } as KodaXToolExecutionContext;
}

describe('CAP-015: edit anchor recovery + write-block contract', () => {
  let savedDebugStream: string | undefined;
  let savedDebugResilience: string | undefined;

  beforeEach(() => {
    // Save+clear so resilience-debug stays silent for deterministic test
    // output, then restore in afterEach so an outer-suite env (CI / shell)
    // is not permanently scrubbed.
    savedDebugStream = process.env.KODAX_DEBUG_STREAM;
    savedDebugResilience = process.env.KODAX_DEBUG_RESILIENCE;
    delete process.env.KODAX_DEBUG_STREAM;
    delete process.env.KODAX_DEBUG_RESILIENCE;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedDebugStream === undefined) {
      delete process.env.KODAX_DEBUG_STREAM;
    } else {
      process.env.KODAX_DEBUG_STREAM = savedDebugStream;
    }
    if (savedDebugResilience === undefined) {
      delete process.env.KODAX_DEBUG_RESILIENCE;
    } else {
      process.env.KODAX_DEBUG_RESILIENCE = savedDebugResilience;
    }
    vi.restoreAllMocks();
  });

  it('CAP-EDIT-CLEAR-001: clearEditRecoveryStateForPath removes both the attempt count and the write-block for that path', () => {
    const state = emptyState();
    state.editRecoveryAttempts.set('/repo/a.ts', 2);
    state.blockedEditWrites.add('/repo/a.ts');

    clearEditRecoveryStateForPath(state, '/repo/a.ts');

    expect(state.editRecoveryAttempts.has('/repo/a.ts')).toBe(false);
    expect(state.blockedEditWrites.has('/repo/a.ts')).toBe(false);
  });

  it('CAP-EDIT-CLEAR-002: clearEditRecoveryStateForPath is a no-op when path is undefined (defensive)', () => {
    const state = emptyState();
    state.editRecoveryAttempts.set('/repo/a.ts', 1);
    state.blockedEditWrites.add('/repo/a.ts');

    clearEditRecoveryStateForPath(state, undefined);

    expect(state.editRecoveryAttempts.has('/repo/a.ts')).toBe(true);
    expect(state.blockedEditWrites.has('/repo/a.ts')).toBe(true);
  });

  it('CAP-EDIT-BLOCK-001: maybeBlockExistingFileWrite returns undefined for non-write tools (short-circuit)', () => {
    const state = emptyState();
    state.blockedEditWrites.add('/repo/a.ts');
    const toolCall: RunnableToolCall = { id: 't1', name: 'read', input: { path: 'a.ts' } };

    expect(maybeBlockExistingFileWrite(toolCall, makeCtx(), state)).toBeUndefined();
  });

  it('CAP-EDIT-BLOCK-002: maybeBlockExistingFileWrite returns undefined when path is not in blocked set', () => {
    const state = emptyState();
    const toolCall: RunnableToolCall = { id: 't1', name: 'write', input: { path: 'a.ts' } };

    expect(maybeBlockExistingFileWrite(toolCall, makeCtx(), state)).toBeUndefined();
  });

  it('CAP-EDIT-BLOCK-003: maybeBlockExistingFileWrite returns the BLOCKED_AFTER_EDIT_FAILURE message when path IS blocked AND file exists on disk', () => {
    // Use a path that definitely exists — repository root package.json.
    // path.resolve normalises slash vs backslash so the blocked-set key
    // must be computed the same way the production code does.
    const repoRoot = process.cwd();
    const realFile = path.resolve(repoRoot, 'package.json');
    const state = emptyState();
    state.blockedEditWrites.add(realFile);
    const toolCall: RunnableToolCall = {
      id: 't1',
      name: 'write',
      input: { path: realFile },
    };

    const result = maybeBlockExistingFileWrite(
      toolCall,
      makeCtx({ executionCwd: repoRoot }),
      state,
    );
    expect(result).toContain('BLOCKED_AFTER_EDIT_FAILURE');
    expect(result).toContain(realFile);
    expect(state.blockedEditWrites.has(realFile)).toBe(true);
  });

  it('CAP-EDIT-BLOCK-004: maybeBlockExistingFileWrite auto-clears stale blocks for missing files (file-not-found short-circuit)', () => {
    // Build an explicit absolute path under the OS tempdir that is
    // guaranteed not to exist. Avoids relying on `path.resolve`
    // cancelling out a POSIX-rooted literal on Windows (which is
    // accidentally portable but fragile).
    const fakePath = path.join(os.tmpdir(), '__kodax_never__', 'missing.ts');
    const state = emptyState();
    state.blockedEditWrites.add(fakePath);
    const toolCall: RunnableToolCall = { id: 't1', name: 'write', input: { path: fakePath } };

    const result = maybeBlockExistingFileWrite(toolCall, makeCtx(), state);
    expect(result).toBeUndefined();
    // Auto-cleared
    expect(state.blockedEditWrites.has(fakePath)).toBe(false);
  });

  it('CAP-EDIT-RECOVERY-PARSE-NOOP: buildEditRecoveryUserMessage returns undefined when toolResult does not contain a recognised error code', async () => {
    const state = emptyState();
    const toolCall: RunnableToolCall = { id: 't1', name: 'edit', input: { path: 'a.ts', old_string: 'foo' } };

    const result = await buildEditRecoveryUserMessage(toolCall, 'plain success message', state, makeCtx());
    expect(result).toBeUndefined();
    // No state mutation when nothing to recover
    expect(state.editRecoveryAttempts.size).toBe(0);
    expect(state.blockedEditWrites.size).toBe(0);
  });

  it('CAP-EDIT-RECOVERY-001-LARGE: EDIT_TOO_LARGE branch returns split-edit guidance and adds path to blocked set + records attempt + lastToolErrorCode', async () => {
    // Use process.cwd() as the executionCwd so path.resolve produces a
    // platform-portable absolute path. Asserting against the same
    // resolution keeps the test cross-platform (Windows backslash vs
    // POSIX forward slash).
    const cwd = process.cwd();
    const expectedKey = path.resolve(cwd, 'a.ts');

    const state = emptyState();
    const toolCall: RunnableToolCall = {
      id: 't1',
      name: 'edit',
      input: { path: 'a.ts', old_string: 'foo' },
    };

    const result = await buildEditRecoveryUserMessage(
      toolCall,
      '[Tool Error] edit: EDIT_TOO_LARGE: payload exceeded',
      state,
      makeCtx({ executionCwd: cwd }),
    );

    expect(result).toContain('failed with EDIT_TOO_LARGE');
    expect(result).toContain('Split the change into smaller edit calls');
    expect(result).toContain('insert_after_anchor');

    expect(state.lastToolErrorCode).toBe('EDIT_TOO_LARGE');
    expect(state.editRecoveryAttempts.get(expectedKey)).toBe(1);
    expect(state.blockedEditWrites.has(expectedKey)).toBe(true);
  });

  it('CAP-EDIT-RECOVERY-001-EXHAUSTED: when attempt count > 2, returns "auto-recovery exhausted" message instead of nearby-anchor diagnostic', async () => {
    const cwd = process.cwd();
    const expectedKey = path.resolve(cwd, 'a.ts');

    const state = emptyState();
    state.editRecoveryAttempts.set(expectedKey, 2); // next attempt will be 3
    const toolCall: RunnableToolCall = {
      id: 't1',
      name: 'edit',
      input: { path: 'a.ts', old_string: 'foo' },
    };

    // Use a recognised error code — `parseEditToolError` only returns
    // for EDIT_NOT_FOUND / EDIT_AMBIGUOUS / EDIT_TOO_LARGE.
    const result = await buildEditRecoveryUserMessage(
      toolCall,
      '[Tool Error] edit: EDIT_NOT_FOUND: anchor missing',
      state,
      makeCtx({ executionCwd: cwd }),
    );

    expect(result).toContain('automatic anchor recovery is exhausted');
    expect(result).toContain('Do not escalate to a whole-file write');
    expect(state.editRecoveryAttempts.get(expectedKey)).toBe(3);
  });

  it.todo('CAP-EDIT-RECOVERY-001-CANDIDATES: ≤ 2-attempts branch reads file from disk via inspectEditFailure and includes candidate anchor windows (integration — fs-mock deferred)');
  it.todo('CAP-EDIT-RECOVERY-003: write-block cleared on successful re-read tool against same path (integration with updateToolOutcomeTracking — agent.ts call site)');
});
