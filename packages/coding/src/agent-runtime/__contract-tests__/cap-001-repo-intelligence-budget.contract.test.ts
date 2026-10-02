import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KodaXOptions } from '../../types.js';
import type { ReasoningPlan } from '../../reasoning.js';

const repoContextMocks = vi.hoisted(() => ({
  buildRepoIntelligenceContext: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  getImpactEstimate: vi.fn(),
  getModuleContext: vi.fn(),
  getRepoPreturnBundle: vi.fn(),
  resolveKodaXAutoRepoMode: vi.fn(),
  resolveKodaXHotPathRepoMode: vi.fn(),
}));

vi.mock('../../repo-intelligence/index.js', () => repoContextMocks);
vi.mock('../../repo-intelligence/runtime.js', () => runtimeMocks);
vi.mock('../../repo-intelligence/semantic-render.js', () => ({
  renderImpactEstimate: () => 'rendered impact',
  renderModuleContext: () => 'rendered module',
}));

import { buildAutoRepoIntelligenceContext } from '../middleware/repo-intelligence.js';

function reviewPlan(): ReasoningPlan {
  return {
    decision: {
      primaryTask: 'review',
      harnessProfile: 'H0_DIRECT',
      complexity: 'simple',
    },
  } as unknown as ReasoningPlan;
}

describe('CAP-001 repo-intelligence hot-path budget', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('omits active repo-intelligence guidance when cold full preturn misses the hot-path budget', async () => {
    vi.useFakeTimers();
    repoContextMocks.buildRepoIntelligenceContext.mockResolvedValue('## Repository Intelligence\nmock overview');
    runtimeMocks.resolveKodaXAutoRepoMode.mockReturnValue('full');
    runtimeMocks.resolveKodaXHotPathRepoMode.mockReturnValue('full');
    runtimeMocks.getRepoPreturnBundle.mockReturnValue(new Promise(() => undefined));

    const resultPromise = buildAutoRepoIntelligenceContext(
      {
        context: {
          executionCwd: 'C:/repo',
          repoIntelligenceMode: 'auto',
        },
      } as KodaXOptions,
      reviewPlan(),
      true,
    );

    await vi.advanceTimersByTimeAsync(2_001);
    const result = await resultPromise;

    expect(result).toContain('mock overview');
    expect(result).not.toContain('## Active Module Intelligence');
    expect(result).not.toContain('## Active Impact Intelligence');
    expect(result).not.toContain('## Repo Intelligence Guidance');
    expect(runtimeMocks.getRepoPreturnBundle).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.getModuleContext).not.toHaveBeenCalled();
    expect(runtimeMocks.getImpactEstimate).not.toHaveBeenCalled();
  });

  it('omits automatic repo-intelligence context when the overview misses the hot-path budget', async () => {
    vi.useFakeTimers();
    repoContextMocks.buildRepoIntelligenceContext.mockReturnValue(new Promise(() => undefined));
    runtimeMocks.resolveKodaXAutoRepoMode.mockReturnValue('full');
    runtimeMocks.resolveKodaXHotPathRepoMode.mockReturnValue('full');
    runtimeMocks.getRepoPreturnBundle.mockResolvedValue(null);

    const resultPromise = buildAutoRepoIntelligenceContext(
      {
        context: {
          executionCwd: 'C:/repo-overview-budget',
          repoIntelligenceMode: 'auto',
        },
      } as KodaXOptions,
      reviewPlan(),
      true,
    );

    await vi.advanceTimersByTimeAsync(2_001);
    const result = await resultPromise;

    expect(result).toBe('');
    expect(repoContextMocks.buildRepoIntelligenceContext).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.getRepoPreturnBundle).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.getModuleContext).not.toHaveBeenCalled();
    expect(runtimeMocks.getImpactEstimate).not.toHaveBeenCalled();
  });

  it('reuses an in-flight cold preturn without spending a second hot-path budget', async () => {
    vi.useFakeTimers();
    repoContextMocks.buildRepoIntelligenceContext.mockResolvedValue('## Repository Intelligence\nmock overview');
    runtimeMocks.resolveKodaXAutoRepoMode.mockReturnValue('full');
    runtimeMocks.resolveKodaXHotPathRepoMode.mockReturnValue('full');
    runtimeMocks.getRepoPreturnBundle.mockReturnValue(new Promise(() => undefined));

    const options = {
      context: {
        executionCwd: 'C:/repo-second-budget',
        repoIntelligenceMode: 'auto',
      },
    } as KodaXOptions;

    const first = buildAutoRepoIntelligenceContext(options, reviewPlan(), true);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await first).toContain('mock overview');

    let secondSettled = false;
    const second = buildAutoRepoIntelligenceContext(options, reviewPlan(), true)
      .then((result) => {
        secondSettled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(0);

    expect(secondSettled).toBe(true);
    expect(await second).toContain('mock overview');
    expect(runtimeMocks.getRepoPreturnBundle).toHaveBeenCalledTimes(1);
  });
});
