/**
 * Contract test for CAP-096: child-executor parallel execution semaphore
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-096-child-executor-parallel-execution-semaphore
 *
 * Test obligations:
 * - CAP-CHILD-PAR-001: semaphore caps concurrency
 * - CAP-CHILD-PAR-002: rejected promise → failed result
 * - CAP-CHILD-PAR-003: mid-batch abort sets cancelled ids
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: child-executor.ts:128-191 (executeChildAgents semaphore + Promise.allSettled orchestration)
 *
 * Time-ordering constraint: AFTER write-bundle validation (only H2 Generator allowed); BEFORE worktree cleanup.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { executeChildAgents } from '../../child-executor.js';

describe('CAP-096: child-executor parallel execution semaphore contract', () => {
  it.todo('CAP-CHILD-PAR-001: createSemaphore(maxParallel) caps the number of concurrently running child agents to options.maxParallel at any point in time');
  it.todo('CAP-CHILD-PAR-002: when a child agent Promise is rejected, the rejection is captured by Promise.allSettled and results in a "[Crash] {reason}" failed result in the output (not an unhandled rejection)');
  it.todo('CAP-CHILD-PAR-003: when options.abortSignal fires mid-batch, remaining not-yet-started children are marked as cancelled and their ids appear in the cancellations list');
});
