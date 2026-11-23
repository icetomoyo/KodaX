import { describe, expect, it } from 'vitest';
import type { ChangedScopeReport } from './index.js';
import { buildChangeRoutingSignals } from './routing-signals.js';

function scope(overrides: Partial<ChangedScopeReport>): ChangedScopeReport {
  return {
    schemaVersion: 1,
    workspaceRoot: 'C:/repo',
    analyzedAt: '',
    scope: 'all',
    totalChangedFiles: 0,
    changedLineCount: 0,
    addedLineCount: 0,
    deletedLineCount: 0,
    categories: { source: 0, docs: 0, tests: 0, config: 0, other: 0 },
    areasTouched: [],
    files: [],
    riskHints: [],
    ...overrides,
  };
}

function areas(count: number): ChangedScopeReport['areasTouched'] {
  return Array.from({ length: count }, (_, index) => ({
    areaId: `area-${index}`,
    label: `area-${index}`,
    root: `area-${index}`,
    kind: 'directory',
    fileCount: 1,
    files: [],
  }));
}

describe('git-only routing signals', () => {
  it('reports no changes when the workspace has no changed scope', () => {
    const signals = buildChangeRoutingSignals('C:/repo', undefined);

    expect(signals).toMatchObject({
      workspaceRoot: 'C:/repo',
      changedFileCount: 0,
      touchedModuleCount: 0,
      crossModule: false,
      reviewScale: 'small',
      suggestedComplexity: 'simple',
      plannerBias: false,
      investigationBias: false,
      lowConfidence: false,
    });
  });

  it('derives scale and bias from the change set without a semantic index', () => {
    const signals = buildChangeRoutingSignals('C:/fallback', scope({
      workspaceRoot: 'C:/repo',
      totalChangedFiles: 12,
      changedLineCount: 900,
      addedLineCount: 700,
      deletedLineCount: 200,
      areasTouched: areas(3),
      riskHints: ['a', 'b', 'c', 'd', 'e'],
    }));

    expect(signals.workspaceRoot).toBe('C:/repo');
    expect(signals.changedModules).toEqual(['area-0', 'area-1', 'area-2']);
    expect(signals.crossModule).toBe(true);
    expect(signals.reviewScale).toBe('large');
    expect(signals.suggestedComplexity).toBe('complex');
    expect(signals.plannerBias).toBe(true);
    expect(signals.investigationBias).toBe(true);
    expect(signals.riskHints).toHaveLength(4);
  });
});
