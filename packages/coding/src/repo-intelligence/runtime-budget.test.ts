import { describe, expect, it, vi } from 'vitest';

const workerMocks = vi.hoisted(() => ({
  buildRepoIntelligenceIndex: vi.fn(),
  detachRepoIntelligenceWorkerRequest: vi.fn(() => true),
  getCyclicDependencyAnalysis: vi.fn(),
  getImpactEstimate: vi.fn(),
  getModuleContext: vi.fn(),
  getProcessContext: vi.fn(),
  getRepoIntelligenceIndex: vi.fn(),
  getRepoRoutingSignals: vi.fn(),
  getSymbolContext: vi.fn(),
  semanticLookup: vi.fn(),
}));

vi.mock('./semantic-worker-client.js', () => workerMocks);

import {
  getCyclicDependencyAnalysis,
  getModuleContext,
  semanticLookup,
} from './runtime.js';
import { RepoIntelligenceQueryError, RepoIntelligenceUnavailableError } from './internal.js';

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('repo-intelligence tool budgets', () => {
  it('rejects with a warming error instead of a placeholder module when the worker misses the tool budget', async () => {
    workerMocks.getModuleContext.mockReturnValueOnce(never());

    const error = await getModuleContext(
      { executionCwd: 'C:/repo' },
      { targetPath: 'src/index.ts', mode: 'full', maxWaitMs: 1 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RepoIntelligenceUnavailableError);
    expect(error).toMatchObject({ status: 'warming' });
    expect((error as Error).message).toContain('still warming');
    expect(workerMocks.getModuleContext).toHaveBeenCalledTimes(1);
  });

  it('rejects with an unavailable error when the worker fails', async () => {
    workerMocks.getModuleContext.mockRejectedValueOnce(new Error('worker crashed'));

    const error = await getModuleContext(
      { executionCwd: 'C:/repo' },
      { targetPath: 'src/index.ts', mode: 'full', maxWaitMs: 1_000 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RepoIntelligenceUnavailableError);
    expect(error).toMatchObject({ status: 'unavailable' });
  });

  it('passes a not-found answer from the worker through instead of calling the index unavailable', async () => {
    workerMocks.getModuleContext.mockRejectedValueOnce(new RepoIntelligenceQueryError('No module matched "payments".'));

    const error = await getModuleContext(
      { executionCwd: 'C:/repo' },
      { module: 'payments', mode: 'full', maxWaitMs: 1_000 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RepoIntelligenceQueryError);
    expect((error as Error).message).toBe('No module matched "payments".');
  });

  it('returns warming semantic lookup results when the worker misses the tool budget', async () => {
    workerMocks.semanticLookup.mockReturnValueOnce(never());

    const result = await semanticLookup(
      { executionCwd: 'C:/repo' },
      { query: 'NameService', kind: 'symbol', limit: 5, mode: 'full', maxWaitMs: 1 },
    );

    expect(result.items).toEqual([]);
    expect(result.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
      status: 'warming',
    });
  });

  it('returns warming cyclic analysis when the worker misses the tool budget', async () => {
    workerMocks.getCyclicDependencyAnalysis.mockReturnValueOnce(never());

    const result = await getCyclicDependencyAnalysis(
      { executionCwd: 'C:/repo' },
      { mode: 'full', maxWaitMs: 1 },
    );

    expect(result.cycles).toEqual([]);
    expect(result.summary).toContain('still warming');
  });
});
