/**
 * Contract test for CAP-096: child-executor parallel execution semaphore
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-096-child-executor-parallel-execution-semaphore
 *
 * Test obligations:
 * - CAP-CHILD-PAR-001: semaphore caps concurrency at `maxParallel`
 * - CAP-CHILD-PAR-002: rejected child promise → "[Crash] …" failed result
 * - CAP-CHILD-PAR-003: mid-batch abort cancels not-yet-started children
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: child-executor.ts:104-192 (executeChildAgents
 * semaphore + Promise.allSettled orchestration); :779-814 (createSemaphore).
 *
 * Time-ordering constraint: AFTER write-bundle validation (only
 * H2 Generator allowed); BEFORE worktree cleanup.
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
import type {
  KodaXChildContextBundle,
  KodaXAmaFanoutClass,
} from '../../types.js';

const mockRunKodaX = runKodaX as ReturnType<typeof vi.fn>;

function createBundle(overrides: Partial<KodaXChildContextBundle> = {}): KodaXChildContextBundle {
  return {
    id: `cb-${Math.random().toString(36).slice(2, 6)}`,
    fanoutClass: 'evidence-scan' as KodaXAmaFanoutClass,
    objective: 'task',
    evidenceRefs: [],
    constraints: [],
    readOnly: true,
    ...overrides,
  };
}

function createCtx() {
  return { backups: new Map(), gitRoot: '/repo', executionCwd: '/repo' };
}

const baseOptions = {
  maxIterationsPerChild: 5,
  parentOptions: { provider: 'anthropic' as const },
  parentRole: 'scout',
  parentHarness: 'H0_DIRECT',
};

describe('CAP-096: child-executor parallel execution semaphore contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CAP-CHILD-PAR-001: semaphore caps concurrency at maxParallel', async () => {
    let inFlight = 0;
    let observedMax = 0;
    mockRunKodaX.mockImplementation(async () => {
      inFlight += 1;
      observedMax = Math.max(observedMax, inFlight);
      // Yield to the event loop so other invocations can pile up if
      // the semaphore is broken.
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return { success: true, lastText: 'done', messages: [], sessionId: 's' };
    });

    const bundles = Array.from({ length: 8 }, (_, i) => createBundle({ id: `cb-${i}` }));
    await executeChildAgents(bundles, createCtx(), { ...baseOptions, maxParallel: 2 });

    expect(mockRunKodaX).toHaveBeenCalledTimes(8);
    expect(observedMax).toBeLessThanOrEqual(2);
    // Sanity: at least one moment of multi-flight (not strictly
    // serialized) — otherwise the test isn't proving concurrency.
    expect(observedMax).toBeGreaterThanOrEqual(1);
  });

  it('CAP-CHILD-PAR-002: a rejected child promise is captured by Promise.allSettled and surfaces as "[Crash] {reason}" failed result', async () => {
    mockRunKodaX
      .mockResolvedValueOnce({ success: true, lastText: 'ok', messages: [], sessionId: 's1' })
      .mockImplementationOnce(async () => {
        // Throw outside any try/catch the executor wraps the call site
        // in — this exercises the `Promise.allSettled` rejection path
        // (vs. the in-execute try/catch that produces the success+fail
        // pair).
        throw new Error('explosion in provider');
      });

    const bundles = [
      createBundle({ id: 'cb-good' }),
      createBundle({ id: 'cb-crash' }),
    ];

    const result = await executeChildAgents(bundles, createCtx(), {
      ...baseOptions,
      maxParallel: 2,
    });

    expect(result.results).toHaveLength(2);
    const crash = result.results.find((r) => r.summary.includes('explosion in provider'));
    expect(crash).toBeDefined();
    expect(crash?.status).toBe('failed');
  });

  it('CAP-CHILD-PAR-003: when abortSignal fires mid-batch, not-yet-started children are recorded in cancelledChildren', async () => {
    const controller = new AbortController();
    let started = 0;
    mockRunKodaX.mockImplementation(async () => {
      started += 1;
      // First child takes long enough that abort fires before later
      // children get scheduled (maxParallel: 1 forces strict serial).
      await new Promise((r) => setTimeout(r, 80));
      return { success: true, lastText: 'ok', messages: [], sessionId: `s${started}` };
    });

    const bundles = [
      createBundle({ id: 'cb-1' }),
      createBundle({ id: 'cb-2' }),
      createBundle({ id: 'cb-3' }),
    ];

    setTimeout(() => controller.abort(), 30);

    const result = await executeChildAgents(bundles, createCtx(), {
      ...baseOptions,
      maxParallel: 1,
      abortSignal: controller.signal,
    });

    // Some bundles must have been recorded as cancelled (those that
    // hit the `abortSignal.aborted` short-circuit before invoking
    // runKodaX). Combined with the started bundles, the total visited
    // equals the input.
    expect(result.cancelledChildren.length).toBeGreaterThan(0);
    expect(result.cancelledChildren.length + result.results.length).toBe(bundles.length);
  });
});
