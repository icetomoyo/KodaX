import type { KodaXRepoRoutingSignals, KodaXToolExecutionContext } from '../types.js';
import { analyzeChangedScope, type ChangedScopeReport } from './index.js';
import { debugLogRepoIntelligence } from './internal.js';

export function deriveRoutingComplexity(
  changedFileCount: number,
  changedLineCount: number,
  touchedModuleCount: number,
  impactedModuleCount: number,
): KodaXRepoRoutingSignals['suggestedComplexity'] {
  if (
    changedFileCount >= 20
    || changedLineCount >= 4000
    || touchedModuleCount >= 5
    || impactedModuleCount >= 5
  ) {
    return 'systemic';
  }
  if (
    changedFileCount >= 8
    || changedLineCount >= 1200
    || touchedModuleCount >= 3
    || impactedModuleCount >= 3
  ) {
    return 'complex';
  }
  if (
    changedFileCount >= 3
    || changedLineCount >= 250
    || touchedModuleCount >= 2
    || impactedModuleCount >= 2
  ) {
    return 'moderate';
  }
  return 'simple';
}

export function deriveReviewScale(
  changedFileCount: number,
  changedLineCount: number,
  touchedModuleCount: number,
): KodaXRepoRoutingSignals['reviewScale'] {
  if (
    changedFileCount >= 30
    || changedLineCount >= 4000
    || touchedModuleCount >= 5
  ) {
    return 'massive';
  }
  if (
    changedFileCount >= 10
    || changedLineCount >= 1200
    || touchedModuleCount >= 3
  ) {
    return 'large';
  }
  return 'small';
}

/** Routing signals from git changes alone; no semantic index is built or read. */
export function buildChangeRoutingSignals(
  workspaceRoot: string | undefined,
  changedScope: ChangedScopeReport | undefined,
): KodaXRepoRoutingSignals {
  const changedFileCount = changedScope?.totalChangedFiles ?? 0;
  const changedLineCount = changedScope?.changedLineCount ?? 0;
  const touchedModuleCount = changedScope?.areasTouched.length ?? 0;
  const changedModules = changedScope?.areasTouched.map((area) => area.areaId).slice(0, 8) ?? [];
  const suggestedComplexity = deriveRoutingComplexity(changedFileCount, changedLineCount, touchedModuleCount, 0);
  return {
    workspaceRoot: changedScope?.workspaceRoot ?? workspaceRoot,
    changedFileCount,
    changedLineCount,
    addedLineCount: changedScope?.addedLineCount ?? 0,
    deletedLineCount: changedScope?.deletedLineCount ?? 0,
    touchedModuleCount,
    changedModules,
    crossModule: touchedModuleCount > 1,
    reviewScale: deriveReviewScale(changedFileCount, changedLineCount, touchedModuleCount),
    riskHints: (changedScope?.riskHints ?? []).slice(0, 4),
    suggestedComplexity,
    plannerBias: suggestedComplexity === 'complex' || suggestedComplexity === 'systemic' || changedModules.length > 1,
    investigationBias: (changedScope?.riskHints.length ?? 0) > 0,
    lowConfidence: false,
  };
}

export async function getChangeRoutingSignals(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
): Promise<KodaXRepoRoutingSignals> {
  const workspaceRoot = context.gitRoot ?? context.executionCwd;
  const changedScope = await analyzeChangedScope(context, { scope: 'all', refreshOverview: false })
    .catch((error: unknown) => {
      // A non-git workspace has no changed scope; routing then sees no changes.
      debugLogRepoIntelligence('Change routing signals could not load changed scope.', error);
      return undefined;
    });
  return buildChangeRoutingSignals(workspaceRoot, changedScope);
}
