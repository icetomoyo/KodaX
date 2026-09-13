import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({
  getRepoRoutingSignals: vi.fn(),
  getModuleContext: vi.fn(),
  getImpactEstimate: vi.fn(),
}));

vi.mock('./semantic-worker-client.js', () => worker);
vi.mock('./index.js', () => ({ buildRepoIntelligenceContext: vi.fn(async () => 'Full repository context') }));

import {
  _resetRepoIntelligenceCachesForTesting,
  getRepoRoutingSignals,
  prewarmRepoIntelligenceCaches,
} from './runtime.js';

describe('Full repository startup prewarm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('KODAX_PREWARM_REPO_INTELLIGENCE', '1');
    _resetRepoIntelligenceCachesForTesting();
    worker.getRepoRoutingSignals.mockReset().mockResolvedValue({ changedFileCount: 7 });
    worker.getModuleContext.mockReset().mockResolvedValue(undefined);
    worker.getImpactEstimate.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    _resetRepoIntelligenceCachesForTesting();
  });

  it('serves the first prompt from Full prewarm after the short inner cache expires', async () => {
    const context = { executionCwd: 'C:/repo' };
    prewarmRepoIntelligenceCaches(context, { mode: 'full' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(worker.getRepoRoutingSignals).toHaveBeenCalledTimes(1);

    const routing = await getRepoRoutingSignals(context, { mode: 'full' });

    expect(routing.changedFileCount).toBe(7);
    expect(routing.capability).toMatchObject({ mode: 'full', engine: 'full', status: 'ok' });
    expect(worker.getRepoRoutingSignals).toHaveBeenCalledTimes(1);
  });
});
