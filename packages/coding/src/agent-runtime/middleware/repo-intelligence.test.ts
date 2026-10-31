import { afterEach, expect, it, vi } from 'vitest';
import type { ReasoningPlan } from '../../reasoning.js';

const sources = vi.hoisted(() => ({
  buildRepoIntelligenceContext: vi.fn(),
  getRepoPreturnBundle: vi.fn(),
  getModuleContext: vi.fn(),
  getImpactEstimate: vi.fn(),
}));
vi.mock('../../repo-intelligence/index.js', () => ({ buildRepoIntelligenceContext: sources.buildRepoIntelligenceContext }));
vi.mock('../../repo-intelligence/runtime.js', () => ({ ...sources,
  resolveKodaXAutoRepoMode: () => 'full', resolveKodaXHotPathRepoMode: () => 'full' }));
vi.mock('../../repo-intelligence/semantic-render.js', () => ({
  renderModuleContext: () => 'current module evidence', renderImpactEstimate: () => 'current impact evidence' }));

import { buildAutoRepoIntelligenceContext } from './repo-intelligence.js';

const plan = { decision: { primaryTask: 'review', complexity: 'simple' } } as ReasoningPlan;
afterEach(() => vi.resetAllMocks());

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
  const result = await buildAutoRepoIntelligenceContext({ context: {
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
  const result = await buildAutoRepoIntelligenceContext({ context: {
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
  const result = await buildAutoRepoIntelligenceContext({ context: {
    executionCwd: 'C:/repo-resumed-scope-test',
  } }, plan, false);
  expect(result).toContain('## Repository Change Scope\nnewly modified files');
  expect(result).not.toContain('old overview');
  expect(result).not.toContain('old changes');
  expect(result).toContain('current module evidence');
  expect(result).toContain('current impact evidence');
});
