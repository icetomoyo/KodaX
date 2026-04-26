/**
 * Contract test for CAP-097: child-executor worktree lifecycle (write child isolation + Evaluator review preservation)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-097-child-executor-worktree-lifecycle-write-child-isolation--evaluator-review-preservation
 *
 * Test obligations:
 * - CAP-CHILD-WORKTREE-001: failed child's worktree cleaned
 * - CAP-CHILD-WORKTREE-002: successful child's worktree preserved for Evaluator
 * - CAP-CHILD-WORKTREE-003: cleanup error doesn't block other cleanups
 *
 * Risk: HIGH (filesystem-mutating; failed cleanups must not block other cleanups; successful children's worktrees MUST be preserved for Evaluator review)
 *
 * Class: 1
 *
 * Verified location: child-executor.ts:171-189 (finally-block worktree cleanup); :243-... (executeWriteChild worktree creation)
 *
 * Time-ordering constraint: in finally; after Promise.allSettled settles; BEFORE mergeChildResults returns.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { cleanupChildWorktrees } from '../../child-executor.js';

describe('CAP-097: child-executor worktree lifecycle contract', () => {
  it.todo('CAP-CHILD-WORKTREE-001: failed child\'s worktree is removed via toolWorktreeRemove(discard_changes: true) in the finally cleanup block');
  it.todo('CAP-CHILD-WORKTREE-002: successful child\'s worktree is preserved after executeChildAgents returns — removal responsibility is deferred to the caller after Evaluator review completes');
  it.todo('CAP-CHILD-WORKTREE-003: cleanup error from toolWorktreeRemove for one child does not prevent cleanup from running for the other children (error-tolerant finally loop)');
});
