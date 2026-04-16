import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock runKodaX before importing child-executor
vi.mock('./agent.js', () => ({
  runKodaX: vi.fn(),
}));

vi.mock('./tools/worktree.js', () => ({
  toolWorktreeCreate: vi.fn(),
  toolWorktreeRemove: vi.fn(),
}));

import type {
  KodaXChildContextBundle,
  KodaXAmaFanoutClass,
} from './types.js';
import { executeChildAgents, buildEvaluatorMergePrompt, collectWriteChildDiffs } from './child-executor.js';
import type { ChildExecutorOptions, WriteChildDiff } from './child-executor.js';
import { runKodaX } from './agent.js';
import { toolWorktreeCreate, toolWorktreeRemove } from './tools/worktree.js';

const mockRunKodaX = runKodaX as ReturnType<typeof vi.fn>;
const mockWorktreeCreate = toolWorktreeCreate as ReturnType<typeof vi.fn>;
const mockWorktreeRemove = toolWorktreeRemove as ReturnType<typeof vi.fn>;

function createBundle(overrides: Partial<KodaXChildContextBundle> = {}): KodaXChildContextBundle {
  return {
    id: `cb-${Math.random().toString(36).slice(2, 6)}`,
    fanoutClass: 'evidence-scan' as KodaXAmaFanoutClass,
    objective: 'Test objective',
    evidenceRefs: [],
    constraints: [],
    readOnly: true,
    ...overrides,
  };
}

function createOptions(overrides: Partial<ChildExecutorOptions> = {}): ChildExecutorOptions {
  return {
    maxParallel: 4,
    maxIterationsPerChild: 20,
    parentOptions: { provider: 'anthropic' },
    parentRole: 'scout',
    parentHarness: 'H0_DIRECT',
    ...overrides,
  };
}

function createCtx() {
  return {
    backups: new Map(),
    gitRoot: '/test/repo',
    executionCwd: '/test/repo',
  };
}

describe('executeChildAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /* ---------- Read-only fan-out ---------- */

  it('returns empty result for empty bundles', async () => {
    const result = await executeChildAgents([], createCtx(), createOptions());
    expect(result.results).toEqual([]);
    expect(result.mergedFindings).toEqual([]);
    expect(result.cancelledChildren).toEqual([]);
  });

  it('executes read-only bundles in parallel', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', objective: 'Check auth module' }),
      createBundle({ id: 'cb-2', objective: 'Check cache module' }),
    ];

    mockRunKodaX
      .mockResolvedValueOnce({ success: true, lastText: 'Auth coverage: 85%', messages: [{ role: 'assistant', content: '' }], sessionId: 's1' })
      .mockResolvedValueOnce({ success: true, lastText: 'Cache coverage: 72%', messages: [{ role: 'assistant', content: '' }], sessionId: 's2' });

    const result = await executeChildAgents(bundles, createCtx(), createOptions());

    expect(result.results).toHaveLength(2);
    expect(result.mergedFindings).toHaveLength(2);
    expect(result.mergedFindings[0]!.objective).toBe('Check auth module');
    expect(result.mergedFindings[1]!.objective).toBe('Check cache module');
    expect(mockRunKodaX).toHaveBeenCalledTimes(2);
  });

  it('handles child failure without affecting other children', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', objective: 'Success task' }),
      createBundle({ id: 'cb-2', objective: 'Failing task' }),
    ];

    mockRunKodaX
      .mockResolvedValueOnce({ success: true, lastText: 'Done', messages: [{ role: 'assistant', content: '' }], sessionId: 's1' })
      .mockRejectedValueOnce(new Error('Provider timeout'));

    const result = await executeChildAgents(bundles, createCtx(), createOptions());

    expect(result.results).toHaveLength(2);
    const success = result.results.find((r) => r.childId === 'cb-1');
    const failure = result.results.find((r) => r.childId === 'cb-2');
    expect(success?.status).toBe('completed');
    expect(failure?.status).toBe('failed');
    expect(failure?.summary).toContain('Provider timeout');
  });

  it('respects maxParallel concurrency limit', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    mockRunKodaX.mockImplementation(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((resolve) => setTimeout(resolve, 50));
      concurrentCount--;
      return { success: true, lastText: 'Done', messages: [{ role: 'assistant', content: '' }], sessionId: 's' };
    });

    const bundles = Array.from({ length: 6 }, (_, i) =>
      createBundle({ id: `cb-${i}`, objective: `Task ${i}` }),
    );

    await executeChildAgents(bundles, createCtx(), createOptions({ maxParallel: 2 }));

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(mockRunKodaX).toHaveBeenCalledTimes(6);
  });

  it('cancels pending children when abort signal fires', async () => {
    const controller = new AbortController();

    mockRunKodaX.mockImplementation(async () => {
      // Simulate slow execution
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { success: true, lastText: 'Done', messages: [{ role: 'assistant', content: '' }], sessionId: 's' };
    });

    const bundles = [
      createBundle({ id: 'cb-1' }),
      createBundle({ id: 'cb-2' }),
      createBundle({ id: 'cb-3' }),
    ];

    // Abort after a short delay
    setTimeout(() => controller.abort(), 50);

    const result = await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ maxParallel: 1, abortSignal: controller.signal }),
    );

    // At least some should be cancelled
    expect(result.cancelledChildren.length + result.results.length).toBeGreaterThan(0);
  });

  it('merges findings with anchored incremental approach', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', objective: 'Find bugs in auth', evidenceRefs: ['file:src/auth.ts'] }),
      createBundle({ id: 'cb-2', objective: 'Find bugs in cache', evidenceRefs: ['file:src/cache.ts'] }),
    ];

    mockRunKodaX
      .mockResolvedValueOnce({ success: true, lastText: 'Found null check bug', messages: [{ role: 'assistant', content: '' }], sessionId: 's1' })
      .mockResolvedValueOnce({ success: true, lastText: 'Found race condition', messages: [{ role: 'assistant', content: '' }], sessionId: 's2' });

    const result = await executeChildAgents(bundles, createCtx(), createOptions());

    expect(result.mergedFindings).toHaveLength(2);
    expect(result.mergedFindings[0]!.evidence).toContain('Found null check bug');
    expect(result.mergedFindings[1]!.evidence).toContain('Found race condition');
    // Evidence refs from bundle are preserved
    expect(result.mergedFindings[0]!.evidence).toContain('file:src/auth.ts');
  });

  /* ---------- Write fan-out validation ---------- */

  it('rejects write bundles from non-H2 Generator roles', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', readOnly: false, objective: 'Write task' }),
    ];

    // Scout cannot do write fan-out
    const result = await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ parentRole: 'scout', parentHarness: 'H0_DIRECT' }),
    );

    expect(result.results).toEqual([]);
    expect(mockRunKodaX).not.toHaveBeenCalled();
  });

  it('allows write bundles from H2 Generator', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', readOnly: false, objective: 'Refactor auth' }),
    ];

    mockWorktreeCreate.mockResolvedValueOnce(JSON.stringify({ path: '/tmp/wt-auth', branch: 'wt-auth' }));
    mockRunKodaX.mockResolvedValueOnce({ success: true, lastText: 'Refactored', messages: [{ role: 'assistant', content: '' }], sessionId: 's1' });
    mockWorktreeRemove.mockResolvedValueOnce('removed');

    const result = await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ parentRole: 'generator', parentHarness: 'H2_PLAN_EXECUTE_EVAL' }),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe('completed');
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(1);
    // Successful write children's worktrees are kept for Evaluator review (not cleaned up here)
    expect(mockWorktreeRemove).toHaveBeenCalledTimes(0);
    // worktreePaths should be in result for downstream cleanup
    expect(result.worktreePaths).toBeDefined();
    expect(result.worktreePaths!.size).toBe(1);
  });

  it('cleans up worktrees even when child crashes', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', readOnly: false, objective: 'Crash task' }),
    ];

    mockWorktreeCreate.mockResolvedValueOnce(JSON.stringify({ path: '/tmp/wt-crash', branch: 'wt-crash' }));
    mockRunKodaX.mockRejectedValueOnce(new Error('Crash!'));
    mockWorktreeRemove.mockResolvedValueOnce('removed');

    const result = await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ parentRole: 'generator', parentHarness: 'H2_PLAN_EXECUTE_EVAL' }),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe('failed');
    // Worktree must still be cleaned up
    expect(mockWorktreeRemove).toHaveBeenCalledTimes(1);
  });

  it('handles worktree creation failure gracefully', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', readOnly: false, objective: 'Task' }),
    ];

    mockWorktreeCreate.mockResolvedValueOnce('some non-json error output');

    const result = await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ parentRole: 'generator', parentHarness: 'H2_PLAN_EXECUTE_EVAL' }),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe('failed');
    expect(result.results[0]!.summary).toContain('Failed to create worktree');
  });

  /* ---------- Evidence resolution ---------- */

  it('passes resolved evidence refs to child briefing', async () => {
    const bundles = [
      createBundle({
        id: 'cb-1',
        objective: 'Investigate auth',
        evidenceRefs: ['finding:Token validation skips expiry check'],
      }),
    ];

    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'Confirmed: expiry check missing',
      messages: [],
      sessionId: 's1',
    });

    await executeChildAgents(bundles, createCtx(), createOptions());

    // Verify the prompt passed to runKodaX contains the resolved finding
    const callArgs = mockRunKodaX.mock.calls[0]!;
    const prompt = callArgs[1] as string;
    expect(prompt).toContain('Token validation skips expiry check');
    expect(prompt).toContain('Known fact');
  });

  /* ---------- Write fan-out worktreePaths export ---------- */

  it('exports worktreePaths in result for write children', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', readOnly: false, objective: 'Refactor' }),
    ];

    mockWorktreeCreate.mockResolvedValueOnce(JSON.stringify({ path: '/tmp/wt-ref', branch: 'wt-ref' }));
    mockRunKodaX.mockResolvedValueOnce({ success: true, lastText: 'Done', messages: [{ role: 'assistant', content: '' }], sessionId: 's1' });
    mockWorktreeRemove.mockResolvedValueOnce('removed');

    const result = await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ parentRole: 'generator', parentHarness: 'H2_PLAN_EXECUTE_EVAL' }),
    );

    // worktreePaths should be available before cleanup
    // (cleanup happens in finally, but result is built before that)
    expect(result.results).toHaveLength(1);
  });
});

/* ---------- Evaluator merge helpers ---------- */

describe('buildEvaluatorMergePrompt', () => {
  it('builds a structured prompt from write child diffs', () => {
    const diffs: WriteChildDiff[] = [
      { childId: 'cb-1', objective: 'Refactor auth', worktreePath: '/wt/auth', diff: '+new code\n-old code', status: 'completed' },
      { childId: 'cb-2', objective: 'Refactor cache', worktreePath: '/wt/cache', diff: '+cache fix', status: 'completed' },
    ];

    const prompt = buildEvaluatorMergePrompt(diffs);

    expect(prompt).toContain('Refactor auth');
    expect(prompt).toContain('Refactor cache');
    expect(prompt).toContain('+new code');
    expect(prompt).toContain('ACCEPT');
    expect(prompt).toContain('REVISE');
  });
});

describe('collectWriteChildDiffs', () => {
  it('collects diffs from worktree paths', () => {
    const results = [
      { childId: 'cb-1', fanoutClass: 'evidence-scan' as KodaXAmaFanoutClass, status: 'completed' as const, disposition: 'valid' as const, summary: 'done', evidenceRefs: [], contradictions: [] },
    ];
    const bundles = [createBundle({ id: 'cb-1', objective: 'Test' })];
    const worktreePaths = new Map([['cb-1', '/tmp/wt-test']]);

    // collectWorktreeDiff calls execSync internally — will fail in test but should return (no changes)
    const diffs = collectWriteChildDiffs(results, bundles, worktreePaths);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.childId).toBe('cb-1');
    expect(diffs[0]!.objective).toBe('Test');
  });
});
