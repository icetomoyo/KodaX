import { afterEach, expect, it, vi } from 'vitest';
const worker = vi.hoisted(() => ({ getRepoRoutingSignals: vi.fn(async () => ({ changedFileCount: 3 })),
  getModuleContext: vi.fn(async () => undefined), getImpactEstimate: vi.fn(async () => undefined) }));
vi.mock('./semantic-worker-client.js', () => worker);
vi.mock('./index.js', () => ({ buildRepoIntelligenceContext: async () => 'Repository context' }));
import { _resetRepoIntelligenceCachesForTesting, getRepoPreturnBundle, getRepoRoutingSignals,
  inspectRepoIntelligenceProject, prepareRepoIntelligenceProject } from './runtime.js';
afterEach(() => { _resetRepoIntelligenceCachesForTesting(); vi.clearAllMocks(); });
it('inspects without initializing and warms the same caches used by execution', async () => {
  const context = { executionCwd: 'C:/project-status' };
  expect(inspectRepoIntelligenceProject(context, { mode: 'full' })).toMatchObject({ initialized: false, status: 'unavailable' });
  expect(worker.getRepoRoutingSignals).not.toHaveBeenCalled();
  const [first, second] = await Promise.all([prepareRepoIntelligenceProject(context, { mode: 'full' }),
    prepareRepoIntelligenceProject(context, { mode: 'full' })]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({ initialized: true, effectiveEngine: 'full', status: 'ok' });
  await getRepoPreturnBundle(context, { mode: 'full', targetPath: '.' });
  await getRepoRoutingSignals(context, { mode: 'full', targetPath: '.' });
  expect(worker.getRepoRoutingSignals).toHaveBeenCalledTimes(1);
});
it('keeps disabled projects lazy', async () => {
  expect(await prepareRepoIntelligenceProject({ executionCwd: 'C:/off' }, { mode: 'off' }))
    .toMatchObject({ initialized: false, effectiveEngine: 'off', status: 'disabled' });
  expect(worker.getRepoRoutingSignals).not.toHaveBeenCalled();
});
it('reports actual degraded full capability when one worker query fails', async () => {
  worker.getRepoRoutingSignals.mockRejectedValue(new Error('Fixture worker unavailable'));
  try {
    expect(await prepareRepoIntelligenceProject({ executionCwd: 'C:/fallback' }, { mode: 'full' }))
      .toMatchObject({ initialized: true, requestedMode: 'full', effectiveEngine: 'full', status: 'limited',
        warnings: expect.arrayContaining(['routing signals unavailable']) });
  } finally { worker.getRepoRoutingSignals.mockResolvedValue({ changedFileCount: 3 }); }
});
it('does not call failed light workers healthy merely because a baseline context exists', async () => {
  worker.getRepoRoutingSignals.mockRejectedValue(new Error('Fixture worker unavailable'));
  try {
    expect(await prepareRepoIntelligenceProject({ executionCwd: 'C:/light-failure' }, { mode: 'light' }))
      .toMatchObject({ initialized: true, effectiveEngine: 'light', status: 'limited' });
  } finally { worker.getRepoRoutingSignals.mockResolvedValue({ changedFileCount: 3 }); }
});
