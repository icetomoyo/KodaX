/**
 * Contract test for CAP-097: child-executor worktree lifecycle
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-097-child-executor-worktree-lifecycle-write-child-isolation--evaluator-review-preservation
 *
 * Test obligations:
 * - CAP-CHILD-WORKTREE-001: failed child's worktree removed with
 *   `discard_changes: true` in finally
 * - CAP-CHILD-WORKTREE-002: successful child's worktree preserved
 *   (Evaluator gets to review the diff)
 * - CAP-CHILD-WORKTREE-003: cleanup error for one child doesn't block
 *   cleanup of others (best-effort error-tolerant loop)
 *
 * Risk: HIGH (filesystem-mutating)
 *
 * Class: 1
 *
 * Verified location: child-executor.ts:171-189 (finally-block worktree
 * cleanup); :245-318 (executeWriteChild worktree creation).
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6t.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../agent.js', () => ({
  runKodaX: vi.fn(),
}));

vi.mock('../../tools/worktree.js', () => ({
  toolWorktreeCreate: vi.fn(),
  toolWorktreeRemove: vi.fn(),
}));

import { executeChildAgents } from '../../child-executor.js';
import { runKodaX } from '../../agent.js';
import { toolWorktreeCreate, toolWorktreeRemove } from '../../tools/worktree.js';
import type {
  KodaXChildContextBundle,
  KodaXAmaFanoutClass,
} from '../../types.js';

const mockRunKodaX = runKodaX as ReturnType<typeof vi.fn>;
const mockWorktreeCreate = toolWorktreeCreate as ReturnType<typeof vi.fn>;
const mockWorktreeRemove = toolWorktreeRemove as ReturnType<typeof vi.fn>;

function createBundle(overrides: Partial<KodaXChildContextBundle> = {}): KodaXChildContextBundle {
  return {
    id: `cb-${Math.random().toString(36).slice(2, 6)}`,
    fanoutClass: 'evidence-scan' as KodaXAmaFanoutClass,
    objective: 'task',
    evidenceRefs: [],
    constraints: [],
    readOnly: false, // worktree contracts only meaningful for write children
    ...overrides,
  };
}

function createCtx() {
  return { backups: new Map(), gitRoot: '/repo', executionCwd: '/repo' };
}

const writeOptions = {
  maxParallel: 4,
  maxIterationsPerChild: 5,
  parentOptions: { provider: 'anthropic' as const },
  // Only Generator + H2 may emit write fan-out.
  parentRole: 'generator',
  parentHarness: 'H2_PLAN_EXECUTE_EVAL',
};

describe('CAP-097: child-executor worktree lifecycle contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CAP-CHILD-WORKTREE-001: failed child\'s worktree is removed via toolWorktreeRemove({discard_changes:true}) in finally', async () => {
    mockWorktreeCreate.mockResolvedValueOnce(
      JSON.stringify({ path: '/tmp/wt-fail', branch: 'wt-fail' }),
    );
    mockRunKodaX.mockRejectedValueOnce(new Error('child crashed'));
    mockWorktreeRemove.mockResolvedValueOnce('removed');

    const result = await executeChildAgents(
      [createBundle({ id: 'cb-fail' })],
      createCtx(),
      writeOptions,
    );

    expect(result.results[0]?.status).toBe('failed');
    expect(mockWorktreeRemove).toHaveBeenCalledTimes(1);
    expect(mockWorktreeRemove).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'remove',
        worktree_path: '/tmp/wt-fail',
        discard_changes: true,
      }),
      expect.anything(),
    );
  });

  it('CAP-CHILD-WORKTREE-002: successful child\'s worktree is preserved for Evaluator review (NOT removed in executeChildAgents)', async () => {
    mockWorktreeCreate.mockResolvedValueOnce(
      JSON.stringify({ path: '/tmp/wt-ok', branch: 'wt-ok' }),
    );
    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'wrote',
      messages: [],
      sessionId: 's-ok',
    });

    const result = await executeChildAgents(
      [createBundle({ id: 'cb-ok' })],
      createCtx(),
      writeOptions,
    );

    expect(result.results[0]?.status).toBe('completed');
    expect(mockWorktreeRemove).toHaveBeenCalledTimes(0);
    // Worktree path is exposed on the result so the Evaluator
    // / orchestrator can clean it up later.
    expect(result.worktreePaths).toBeDefined();
    expect(result.worktreePaths!.size).toBe(1);
    expect(result.worktreePaths!.get('cb-ok')).toBe('/tmp/wt-ok');
  });

  it('CAP-CHILD-WORKTREE-003: cleanup error for one failed child does not prevent cleanup of other failed children', async () => {
    mockWorktreeCreate
      .mockResolvedValueOnce(JSON.stringify({ path: '/tmp/wt-a', branch: 'wt-a' }))
      .mockResolvedValueOnce(JSON.stringify({ path: '/tmp/wt-b', branch: 'wt-b' }));
    mockRunKodaX
      .mockRejectedValueOnce(new Error('crash a'))
      .mockRejectedValueOnce(new Error('crash b'));
    // The first cleanup throws — the second MUST still be invoked.
    mockWorktreeRemove
      .mockRejectedValueOnce(new Error('rm permissions'))
      .mockResolvedValueOnce('removed');

    const result = await executeChildAgents(
      [createBundle({ id: 'cb-a' }), createBundle({ id: 'cb-b' })],
      createCtx(),
      writeOptions,
    );

    expect(result.results.every((r) => r.status === 'failed')).toBe(true);
    // Both cleanup attempts ran despite the first throwing.
    expect(mockWorktreeRemove).toHaveBeenCalledTimes(2);
  });
});
