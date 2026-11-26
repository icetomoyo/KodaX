import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReasoningPlan } from '../../reasoning.js';
import type { RepoIntelQuery } from '../../repo-intelligence/engine/supervisor.js';

const sources = vi.hoisted(() => ({
  buildRepoIntelligenceContext: vi.fn(),
  getRepoPreturnBundle: vi.fn(),
  getModuleContext: vi.fn(),
  getImpactEstimate: vi.fn(),
}));
vi.mock('../../repo-intelligence/index.js', () => ({ buildRepoIntelligenceContext: sources.buildRepoIntelligenceContext }));
const surface = vi.hoisted(() => ({ enabled: vi.fn((_mode?: string) => true) }));
vi.mock('../../repo-intelligence/runtime.js', () => ({ ...sources,
  isRepoIntelligenceSemanticSurfaceEnabled: surface.enabled,
  resolveKodaXAutoRepoMode: () => 'full', resolveKodaXHotPathRepoMode: () => 'full' }));
vi.mock('../../repo-intelligence/semantic-render.js', () => ({
  renderModuleContext: () => 'current module evidence', renderImpactEstimate: () => 'current impact evidence' }));

import { buildAutoRepoIntelligenceContext } from './repo-intelligence.js';

const plan = { decision: { primaryTask: 'review', complexity: 'simple' } } as ReasoningPlan;
afterEach(() => vi.resetAllMocks());

it.each([0.71, 0.72])('CAP-REPO-INTEL-002/003: full preturn preserves current evidence and gates guidance at confidence %s', async confidence => {
  sources.buildRepoIntelligenceContext.mockResolvedValue('current repository overview');
  sources.getRepoPreturnBundle.mockResolvedValue({ repoContext: 'cached overview',
    moduleContext: { module: { moduleId: 'module' }, confidence },
    impactEstimate: { target: { label: 'impact' }, confidence },
  });
  const result = await buildAutoRepoIntelligenceContext({ provider: 'offline-fixture', context: {
    executionCwd: `C:/repo-confidence-${confidence}`, repoIntelligenceContext: 'caller-owned context',
  } }, plan, true);
  expect(sources.getRepoPreturnBundle).toHaveBeenCalledOnce();
  expect(result).toContain('caller-owned context\n\ncurrent repository overview');
  expect(result).toContain('## Active Module Intelligence\ncurrent module evidence');
  expect(result).toContain('## Active Impact Intelligence\ncurrent impact evidence');
  if (confidence === 0.71) {
    expect(result).toContain('## Repo Intelligence Guidance\n- Current repository intelligence is low-confidence for this area.\n- Confirm its claims against the source before an edit relies on them.');
  } else expect(result).not.toContain('## Repo Intelligence Guidance');
});

it('CAP-REPO-INTEL-004: repository source failures preserve caller context and return bounded best-effort guidance', async () => {
  for (const source of Object.values(sources)) source.mockRejectedValue(new Error('offline repository failure'));
  const result = await buildAutoRepoIntelligenceContext({ provider: 'offline-fixture', context: {
    executionCwd: 'C:/repo-all-sources-unavailable', repoIntelligenceContext: 'caller-owned evidence',
  } }, plan, true);
  expect(result).toContain('caller-owned evidence');
  expect(result).toContain('## Repo Intelligence Guidance');
  expect(result).not.toContain('offline repository failure');
  expect(result).not.toContain('## Active Module Intelligence');
});

it.each([{}, { workModePolicy: 'intersect' as const, agentProfile: { id: 'partner' }, toolVisibilityPolicy: () => true }])('skips automatic repository scans in Agent while preserving caller-owned repository material (%j)', async context => {
  const caller = 'Caller supplied repository facts and instructions.';
  sources.buildRepoIntelligenceContext.mockResolvedValue('unrequested automatic repository overview');
  const result = await buildAutoRepoIntelligenceContext({ provider: 'offline-fixture', workMode: 'agent', context: {
    ...context,
    executionCwd: 'C:/agent-work-surface', repoIntelligenceContext: caller,
  } }, plan, true);
  expect(result).toBe(caller);
  expect(sources.buildRepoIntelligenceContext).not.toHaveBeenCalled();
  expect(sources.getRepoPreturnBundle).not.toHaveBeenCalled();
  expect(sources.getModuleContext).not.toHaveBeenCalled();
  expect(sources.getImpactEstimate).not.toHaveBeenCalled();
});

it.each([
  { agentProfile: { id: 'custom-profile' } },
  { currentAgentId: '/root/explorer' },
  { systemPromptOverride: 'Custom instructions' },
  { toolVisibilityPolicy: () => true },
])('keeps the existing automatic repository context for explicit SDK or child declarations (%j)', async context => {
  sources.buildRepoIntelligenceContext.mockResolvedValue('Existing repository evidence');
  sources.getRepoPreturnBundle.mockResolvedValue(null);
  sources.getModuleContext.mockResolvedValue(null);
  sources.getImpactEstimate.mockResolvedValue(null);
  const result = await buildAutoRepoIntelligenceContext({ provider: 'offline-fixture', workMode: 'agent',
    context: { ...context, executionCwd: 'C:/custom-repo-work-surface' },
  }, plan, true);
  expect(sources.buildRepoIntelligenceContext).toHaveBeenCalledOnce();
  expect(result).toContain('Existing repository evidence');
});

it('prefers the current baseline over a cached bundle without rewriting caller context or losing active evidence', async () => {
  const caller = '## Repository Intelligence\nCaller-owned notes stay verbatim.';
  sources.buildRepoIntelligenceContext.mockResolvedValue('## Repository Intelligence\ncurrent overview\n\n## Repository Change Scope\ncurrent changes');
  sources.getRepoPreturnBundle.mockResolvedValue({
    repoContext: '## Repository Intelligence\ncached overview\n\n## Repository Change Scope\nold changes',
    moduleContext: { module: { moduleId: 'cache' }, confidence: 0.95 },
    impactEstimate: { target: { label: 'cache' }, confidence: 0.95 },
  });
  const result = await buildAutoRepoIntelligenceContext({ provider: 'offline-fixture', context: {
    executionCwd: 'C:/repo-current-baseline-test', repoIntelligenceContext: caller,
  } }, plan, true);
  expect(result).toBe(caller + '\n\n## Repository Intelligence\ncurrent overview\n\n## Repository Change Scope\ncurrent changes'
    + '\n\n## Active Module Intelligence\ncurrent module evidence\n\n## Active Impact Intelligence\ncurrent impact evidence');
});

it('retains bundle context when the current baseline cannot be built', async () => {
  sources.buildRepoIntelligenceContext.mockRejectedValue(new Error('Transient repository read failure'));
  sources.getRepoPreturnBundle.mockResolvedValue({
    repoContext: '## Repository Intelligence\navailable cached evidence',
    moduleContext: { module: { moduleId: 'cache' }, confidence: 0.4 },
    impactEstimate: { target: { label: 'cache' }, confidence: 0.4 },
  });
  const result = await buildAutoRepoIntelligenceContext({ provider: 'offline-fixture', context: {
    executionCwd: 'C:/repo-baseline-fallback-test',
  } }, plan, true);
  expect(result).toContain('## Repository Intelligence\navailable cached evidence');
  expect(result).toContain('## Active Module Intelligence\ncurrent module evidence');
  expect(result).toContain('## Active Impact Intelligence\ncurrent impact evidence');
  expect(result).toContain('## Repo Intelligence Guidance');
});

it('keeps the current change scope on resumed simple reviews without readding the bundle overview', async () => {
  sources.buildRepoIntelligenceContext.mockResolvedValue('## Repository Change Scope\nnewly modified files');
  sources.getRepoPreturnBundle.mockResolvedValue({
    repoContext: '## Repository Intelligence\nold overview\n\n## Repository Change Scope\nold changes',
    moduleContext: { module: { moduleId: 'cache' }, confidence: 0.95 },
    impactEstimate: { target: { label: 'cache' }, confidence: 0.95 },
  });
  const result = await buildAutoRepoIntelligenceContext({ provider: 'offline-fixture', context: {
    executionCwd: 'C:/repo-resumed-scope-test',
  } }, plan, false);
  expect(result).toContain('## Repository Change Scope\nnewly modified files');
  expect(result).not.toContain('old overview');
  expect(result).not.toContain('old changes');
  expect(result).toContain('current module evidence');
  expect(result).toContain('current impact evidence');
});

it('leaves module and impact capsules out unless the semantic surface is opted in', async () => {
  surface.enabled.mockReturnValue(false);
  sources.buildRepoIntelligenceContext.mockResolvedValue('current repository overview');
  const result = await buildAutoRepoIntelligenceContext({ provider: 'offline-fixture', context: {
    executionCwd: 'C:/repo-default-surface', repoIntelligenceMode: 'auto',
  } }, plan, true);
  expect(result).toBe('current repository overview');
  expect(surface.enabled).toHaveBeenCalledWith('auto');
  expect(sources.getRepoPreturnBundle).not.toHaveBeenCalled();
  expect(sources.getModuleContext).not.toHaveBeenCalled();
  expect(sources.getImpactEstimate).not.toHaveBeenCalled();
});

describe('the repository map', () => {
  const ready = { state: 'ready', indexed: 120, withSyntaxErrors: 0, notIndexed: {} };
  const map = 'src/types.ts\n  export interface Task';
  const bound = (answer: unknown, asked: string[] = []): RepoIntelQuery => ({
    root: 'C:/repo-map',
    request: async <T>(method: string): Promise<T> => {
      asked.push(method);
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  });
  const build = (repoIntel: RepoIntelQuery, isNewSession = true, decision = plan.decision) =>
    buildAutoRepoIntelligenceContext({ provider: 'offline-fixture', context: { executionCwd: 'C:/repo-map', repoIntel } },
      { decision } as ReasoningPlan, isNewSession);

  beforeEach(() => {
    surface.enabled.mockReturnValue(false);
    sources.buildRepoIntelligenceContext.mockResolvedValue('current repository overview');
  });

  it('follows the overview once the index is ready', async () => {
    const asked: string[] = [];
    const result = await build(bound({ text: map, files: 1, definitions: 1, tokens: 9, coverage: ready }, asked));
    expect(asked).toEqual(['workspace.map']);
    expect(result).toBe(['current repository overview', '', '## Repository Map',
      'The files the rest of the repository imports most, with their most imported definitions.',
      'Most files and definitions are not listed.', map].join('\n'));
  });

  it('is left out while the index is being built, or when the engine cannot answer', async () => {
    const indexing = await build(bound({ text: map, files: 1, definitions: 1, tokens: 9, coverage: { ...ready, state: 'indexing' } }));
    const failed = await build(bound(new Error('The RepoIntel engine is starting.')));
    expect([indexing, failed]).toEqual(['current repository overview', 'current repository overview']);
  });

  it('comes with the overview only, not with the change scope of a resumed simple task', async () => {
    const asked: string[] = [];
    await build(bound({ text: map, files: 1, definitions: 1, tokens: 9, coverage: ready }, asked), false);
    expect(asked).toEqual([]);
  });
});
