import path from 'path';
import {
  analyzeChangedScopeFromSnapshot,
  resolveRepoOverviewSnapshot,
  debugLogRepoIntelligence,
  type ChangedScopeReport,
  type KodaXRepoRoutingSignals,
  type KodaXToolExecutionContext,
} from './public-bridge.js';
import type {
  ImpactEstimateResult,
  ModuleCapsule,
  ModuleContextResult,
  ProcessCapsule,
  ProcessContextResult,
  RepoIntelligenceIndex,
  RepoSymbolRecord,
  SymbolContextResult,
} from './semantic-types.js';
import { getRepoIntelligenceIndex, getRepoIntelligenceIndexFromSnapshot } from './semantic-build-cache.js';
import { deriveReviewScale, deriveRoutingComplexity } from './routing-signals.js';
import {
  MAX_RELATED_RESULTS,
  dedupeStrings,
  normalizeRelativePath,
  type RepoIntelligenceAnalysisProfile,
} from './semantic-shared.js';

export function buildFreshnessLabel(index: RepoIntelligenceIndex): string {
  return `${index.generatedAt} (overview ${index.overviewGeneratedAt})`;
}

/** The most specific module containing the path; the root module contains every workspace path. */
function findModuleByPath(index: RepoIntelligenceIndex, targetPath: string): ModuleCapsule | null {
  const relative = path.isAbsolute(targetPath) ? path.relative(index.workspaceRoot, targetPath) : targetPath;
  const normalizedPath = normalizeRelativePath(relative);
  const containing = index.modules.filter((module) =>
    module.root === '.'
    || normalizedPath === module.root
    || normalizedPath.startsWith(`${module.root}/`)
    || module.sampleFiles.includes(normalizedPath),
  );
  return containing.sort((left, right) => rootDepth(right) - rootDepth(left))[0] ?? null;
}

function rootDepth(module: ModuleCapsule): number {
  return module.root === '.' ? 0 : module.root.split('/').length;
}

/**
 * Returns null when nothing matches so callers report "not found"; guessing a
 * module would hand the model a confident answer about unrelated code.
 */
export function findModuleMatch(index: RepoIntelligenceIndex, query?: string, targetPath?: string): ModuleCapsule | null {
  if (targetPath) {
    const byPath = findModuleByPath(index, targetPath);
    if (byPath) {
      return byPath;
    }
  }

  const normalizedQuery = query?.trim().toLowerCase();
  if (!normalizedQuery) {
    return targetPath ? null : index.modules.find((module) => module.root === '.') ?? null;
  }

  return index.modules
    .slice()
    .sort((left, right) => right.symbolCount - left.symbolCount)
    .find((module) =>
      module.moduleId.toLowerCase() === normalizedQuery
      || module.label.toLowerCase() === normalizedQuery
      || module.root.toLowerCase() === normalizedQuery
      || path.posix.basename(module.root).toLowerCase() === normalizedQuery,
    ) ?? index.modules.find((module) =>
      module.moduleId.toLowerCase().includes(normalizedQuery)
      || module.label.toLowerCase().includes(normalizedQuery)
      || module.root.toLowerCase().includes(normalizedQuery),
    ) ?? null;
}

export function findSymbolMatches(
  index: RepoIntelligenceIndex,
  symbol: string,
  moduleHint?: string,
): RepoSymbolRecord[] {
  const normalized = symbol.trim().toLowerCase();
  const normalizedModule = moduleHint?.trim().toLowerCase();

  return index.symbols
    .filter((candidate) =>
      candidate.name.toLowerCase() === normalized
      || candidate.qualifiedName.toLowerCase() === normalized
      || candidate.filePath.toLowerCase() === normalized,
    )
    .sort((left, right) => {
      const leftModuleScore = normalizedModule && (
        left.moduleId.toLowerCase().includes(normalizedModule)
        || left.filePath.toLowerCase().includes(normalizedModule)
      ) ? 1 : 0;
      const rightModuleScore = normalizedModule && (
        right.moduleId.toLowerCase().includes(normalizedModule)
        || right.filePath.toLowerCase().includes(normalizedModule)
      ) ? 1 : 0;
      if (rightModuleScore !== leftModuleScore) {
        return rightModuleScore - leftModuleScore;
      }
      return Number(right.exported) - Number(left.exported) || right.confidence - left.confidence;
    });
}

export function findProcessMatches(
  index: RepoIntelligenceIndex,
  query?: string,
  moduleHint?: string,
): ProcessCapsule[] {
  const normalizedQuery = query?.trim().toLowerCase();
  const normalizedModule = moduleHint?.trim().toLowerCase();

  return index.processes
    .filter((process) => {
      const matchesQuery = !normalizedQuery
        || process.label.toLowerCase().includes(normalizedQuery)
        || process.entryFile.toLowerCase().includes(normalizedQuery)
        || (process.entrySymbol?.toLowerCase().includes(normalizedQuery) ?? false);
      const matchesModule = !normalizedModule || process.moduleId.toLowerCase().includes(normalizedModule);
      return matchesQuery && matchesModule;
    })
    .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label));
}

/** Every symbol that calls one of `symbolIds`, most confident first. */
export function collectCallers(index: RepoIntelligenceIndex, symbolIds: ReadonlySet<string>): RepoSymbolRecord[] {
  return index.symbols
    .filter((candidate) => candidate.callTargets.some((target) => symbolIds.has(target.symbolId)))
    .sort((left, right) => right.confidence - left.confidence);
}

const MAX_ALTERNATIVES = 4;

function limitList<T>(items: readonly T[], limit: number): { shown: T[]; omitted: number } {
  return { shown: items.slice(0, limit), omitted: Math.max(0, items.length - limit) };
}

/** Keeps only non-zero counts so an uncut result carries no `omitted` field. */
function omittedCounts<K extends string>(counts: Record<K, number>): { omitted?: Partial<Record<K, number>> } {
  const entries = Object.entries(counts).filter(([, count]) => (count as number) > 0);
  return entries.length > 0 ? { omitted: Object.fromEntries(entries) as Partial<Record<K, number>> } : {};
}

export function resolveModuleContextFromIndex(
  index: RepoIntelligenceIndex,
  options: { module?: string; targetPath?: string },
): ModuleContextResult {
  const module = findModuleMatch(index, options.module, options.targetPath);
  if (!module) {
    throw new Error(`No module matched "${options.module ?? options.targetPath ?? 'current workspace'}".`);
  }

  return {
    module,
    freshness: buildFreshnessLabel(index),
    confidence: module.confidence,
    evidence: module.sampleFiles.slice(0, 4),
  };
}

export function resolveSymbolContextFromIndex(
  index: RepoIntelligenceIndex,
  options: { symbol: string; module?: string },
): SymbolContextResult {
  const matches = findSymbolMatches(index, options.symbol, options.module);
  if (matches.length === 0) {
    throw new Error(`No symbol matched "${options.symbol}".`);
  }

  const [symbol, ...rest] = matches;
  const alternatives = limitList(rest, MAX_ALTERNATIVES);
  const callers = limitList(collectCallers(index, new Set([symbol.id])), MAX_RELATED_RESULTS);
  return {
    symbol,
    alternatives: alternatives.shown,
    callers: callers.shown,
    ...omittedCounts({ callers: callers.omitted, alternatives: alternatives.omitted }),
    freshness: buildFreshnessLabel(index),
    confidence: symbol.confidence,
  };
}

export function resolveProcessContextFromIndex(
  index: RepoIntelligenceIndex,
  options: { entry?: string; module?: string; targetPath?: string },
): ProcessContextResult {
  const processMatches = findProcessMatches(index, options.entry ?? options.targetPath, options.module);
  if (processMatches.length === 0 && options.module) {
    const module = findModuleMatch(index, options.module, options.targetPath);
    if (module?.processIds[0]) {
      const matched = index.processes.find((process) => process.id === module.processIds[0]);
      if (matched) {
        return {
          process: matched,
          alternatives: [],
          freshness: buildFreshnessLabel(index),
          confidence: matched.confidence,
        };
      }
    }
  }

  const [process, ...alternatives] = processMatches;
  if (!process) {
    throw new Error(`No process matched "${options.entry ?? options.module ?? options.targetPath ?? 'request'}".`);
  }

  return {
    process,
    alternatives: alternatives.slice(0, 4),
    freshness: buildFreshnessLabel(index),
    confidence: process.confidence,
  };
}

export function resolveImpactEstimateFromIndex(
  index: RepoIntelligenceIndex,
  options: { symbol?: string; module?: string; path?: string; targetPath?: string },
  changedScope?: ChangedScopeReport,
): ImpactEstimateResult {
  let target: ImpactEstimateResult['target'] | null = null;
  let impactedModules: ModuleCapsule[] = [];
  let impactedSymbols: RepoSymbolRecord[] = [];
  let callers: RepoSymbolRecord[] = [];
  let confidence = 0.65;

  if (options.symbol) {
    const symbolContext = resolveSymbolContextFromIndex(index, {
      symbol: options.symbol,
      module: options.module,
    });
    const symbolCallers = collectCallers(index, new Set([symbolContext.symbol.id]));
    const directModules = dedupeStrings([
      symbolContext.symbol.moduleId,
      ...symbolContext.symbol.callTargets.map((targetRef) => targetRef.moduleId),
      ...symbolCallers.map((caller) => caller.moduleId),
    ]);

    target = {
      kind: 'symbol',
      label: symbolContext.symbol.name,
      moduleId: symbolContext.symbol.moduleId,
      filePath: symbolContext.symbol.filePath,
    };
    impactedModules = index.modules.filter((module) => directModules.includes(module.moduleId));
    impactedSymbols = dedupeStrings([
      symbolContext.symbol.id,
      ...symbolContext.symbol.callTargets.map((targetRef) => targetRef.symbolId),
      ...symbolCallers.map((caller) => caller.id),
    ])
      .map((id) => index.symbols.find((symbol) => symbol.id === id))
      .filter((symbol): symbol is RepoSymbolRecord => symbol !== undefined);
    callers = symbolCallers;
    confidence = symbolContext.confidence;
  } else if (options.path) {
    const normalizedPath = normalizeRelativePath(options.path);
    const module = findModuleMatch(index, undefined, normalizedPath);
    const symbolsInFile = index.symbols.filter((symbol) => symbol.filePath === normalizedPath);
    target = {
      kind: 'path',
      label: normalizedPath,
      moduleId: module?.moduleId,
      filePath: normalizedPath,
    };
    impactedModules = module ? [module, ...index.modules.filter((candidate) => module.dependents.includes(candidate.moduleId))] : [];
    impactedSymbols = symbolsInFile;
    callers = collectCallers(index, new Set(symbolsInFile.map((symbol) => symbol.id)));
    confidence = module?.confidence ?? 0.62;
  } else {
    const module = findModuleMatch(index, options.module, options.targetPath);
    if (!module) {
      throw new Error('impact_estimate requires one of symbol, path, or module.');
    }
    target = {
      kind: 'module',
      label: module.label,
      moduleId: module.moduleId,
    };
    impactedModules = [module, ...index.modules.filter((candidate) => module.dependents.includes(candidate.moduleId))];
    impactedSymbols = index.symbols.filter((symbol) => symbol.moduleId === module.moduleId);
    callers = collectCallers(index, new Set(impactedSymbols.map((symbol) => symbol.id)));
    confidence = module.confidence;
  }

  const changedOverlap = changedScope
    ? changedScope.files.filter((file) =>
      impactedModules.some((module) => file.areaId === module.moduleId)
      || impactedSymbols.some((symbol) => file.path === symbol.filePath),
    ).length
    : 0;
  const shownSymbols = limitList(impactedSymbols, MAX_RELATED_RESULTS);
  const shownCallers = limitList(callers, MAX_RELATED_RESULTS);

  return {
    target,
    summary: changedOverlap > 0
      ? `${target.label} overlaps with ${changedOverlap} currently changed file(s); validate blast radius before editing.`
      : `${target.label} primarily affects ${dedupeStrings(impactedModules.map((module) => module.label), 4).join(', ') || 'its local module'} and ${impactedSymbols.length} indexed symbol(s).`,
    impactedModules,
    impactedSymbols: shownSymbols.shown,
    callers: shownCallers.shown,
    ...omittedCounts({ impactedSymbols: shownSymbols.omitted, callers: shownCallers.omitted }),
    changedScope,
    freshness: buildFreshnessLabel(index),
    confidence,
  };
}

export async function getModuleContext(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: {
    module?: string;
    targetPath?: string;
    refresh?: boolean;
    profile?: RepoIntelligenceAnalysisProfile;
  } = {},
): Promise<ModuleContextResult> {
  const index = await getRepoIntelligenceIndex(context, options);
  return resolveModuleContextFromIndex(index, options);
}

export async function getSymbolContext(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: {
    symbol: string;
    module?: string;
    targetPath?: string;
    refresh?: boolean;
    profile?: RepoIntelligenceAnalysisProfile;
  },
): Promise<SymbolContextResult> {
  const index = await getRepoIntelligenceIndex(context, options);
  return resolveSymbolContextFromIndex(index, options);
}

export async function getProcessContext(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: {
    entry?: string;
    module?: string;
    targetPath?: string;
    refresh?: boolean;
    profile?: RepoIntelligenceAnalysisProfile;
  },
): Promise<ProcessContextResult> {
  const index = await getRepoIntelligenceIndex(context, options);
  return resolveProcessContextFromIndex(index, options);
}

export async function getImpactEstimate(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: {
    symbol?: string;
    module?: string;
    path?: string;
    targetPath?: string;
    refresh?: boolean;
    profile?: RepoIntelligenceAnalysisProfile;
  },
): Promise<ImpactEstimateResult> {
  const snapshot = await resolveRepoOverviewSnapshot(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const index = await getRepoIntelligenceIndexFromSnapshot(
    snapshot,
    options.refresh === true,
    options.profile ?? 'full',
  );
  let changedScope: ChangedScopeReport | undefined;
  try {
    changedScope = await analyzeChangedScopeFromSnapshot(snapshot, {
      scope: 'all',
    });
  } catch (error) {
    debugLogRepoIntelligence('impact_estimate could not load changed scope.', error);
    changedScope = undefined;
  }
  return resolveImpactEstimateFromIndex(index, options, changedScope);
}

export async function getRepoRoutingSignals(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: {
    targetPath?: string;
    refresh?: boolean;
    profile?: RepoIntelligenceAnalysisProfile;
  } = {},
): Promise<KodaXRepoRoutingSignals> {
  const snapshot = await resolveRepoOverviewSnapshot(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const activeModuleTargetPath = options.targetPath ?? (context.executionCwd ? '.' : undefined);
  const [index, changedScope] = await Promise.all([
    getRepoIntelligenceIndexFromSnapshot(snapshot, options.refresh === true, options.profile ?? 'full'),
    analyzeChangedScopeFromSnapshot(snapshot, {
      scope: 'all',
    }).catch((error) => {
      debugLogRepoIntelligence('Routing signals could not load changed scope.', error);
      return null;
    }),
  ]);
  let moduleResult: ModuleContextResult | null = null;
  let impactResult: ImpactEstimateResult | null = null;
  try {
    moduleResult = resolveModuleContextFromIndex(index, {
      targetPath: activeModuleTargetPath,
    });
  } catch (error) {
    debugLogRepoIntelligence('Routing signals could not resolve module context.', error);
  }
  try {
    impactResult = resolveImpactEstimateFromIndex(index, {
      targetPath: activeModuleTargetPath,
    }, changedScope ?? undefined);
  } catch (error) {
    debugLogRepoIntelligence('Routing signals could not resolve impact estimate.', error);
  }

  const changedModules = changedScope?.areasTouched.map((area) => area.areaId).slice(0, 8) ?? [];
  const changedFileCount = changedScope?.totalChangedFiles ?? 0;
  const changedLineCount = changedScope?.changedLineCount ?? 0;
  const addedLineCount = changedScope?.addedLineCount ?? 0;
  const deletedLineCount = changedScope?.deletedLineCount ?? 0;
  const touchedModuleCount = changedScope?.areasTouched.length ?? 0;
  const impactedModuleCount = impactResult?.impactedModules.length ?? (moduleResult ? 1 : 0);
  const suggestedComplexity = deriveRoutingComplexity(
    changedFileCount,
    changedLineCount,
    touchedModuleCount,
    impactedModuleCount,
  );
  const reviewScale = deriveReviewScale(
    changedFileCount,
    changedLineCount,
    touchedModuleCount,
  );
  const moduleConfidence = moduleResult?.confidence;
  const impactConfidence = impactResult?.confidence;
  const lowConfidence = (moduleConfidence ?? 1) < 0.72 || (impactConfidence ?? 1) < 0.72;
  const predominantCapabilityTier = moduleResult?.module.languages[0]?.capabilityTier
    ?? index.languages[0]?.capabilityTier
    ?? 'low';
  const plannerBias =
    suggestedComplexity === 'complex'
    || suggestedComplexity === 'systemic'
    || changedModules.length > 1
    || (impactResult?.impactedModules.length ?? 0) > 1;
  const investigationBias =
    lowConfidence
    || (changedScope?.riskHints.length ?? 0) > 0
    || (impactResult?.changedScope?.riskHints.length ?? 0) > 0;

  return {
    workspaceRoot: index.workspaceRoot,
    changedFileCount,
    changedLineCount,
    addedLineCount,
    deletedLineCount,
    touchedModuleCount,
    changedModules,
    crossModule: touchedModuleCount > 1 || impactedModuleCount > 1,
    reviewScale,
    riskHints: dedupeStrings([
      ...(lowConfidence ? ['Light repo routing uses heuristic static analysis; validate low-confidence edges before editing.'] : []),
      ...(changedScope?.riskHints ?? []),
      ...(impactResult?.changedScope?.riskHints ?? []),
    ], 4),
    activeModuleId: moduleResult?.module.moduleId,
    activeModuleConfidence: moduleConfidence,
    activeImpactConfidence: impactConfidence,
    impactedModuleCount,
    impactedSymbolCount: impactResult?.impactedSymbols.length ?? 0,
    predominantCapabilityTier,
    suggestedComplexity,
    plannerBias,
    investigationBias,
    lowConfidence,
  };
}
