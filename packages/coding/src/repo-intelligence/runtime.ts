import type {
  ImpactEstimateResult,
  ModuleCapsule,
  ModuleContextResult,
  ProcessContextResult,
  ProcessCapsule,
  RepoSymbolRecord,
  RepoIntelligenceIndex,
  SymbolContextResult,
} from './query.js';
import {
  buildRepoIntelligenceIndex as buildFallbackRepoIntelligenceIndex,
  getImpactEstimate as getFallbackImpactEstimate,
  getModuleContext as getFallbackModuleContext,
  getProcessContext as getFallbackProcessContext,
  getRepoIntelligenceIndex as getFallbackRepoIntelligenceIndex,
  getRepoRoutingSignals as getFallbackRepoRoutingSignals,
  renderImpactEstimate,
  renderModuleContext,
  renderProcessContext,
  renderSymbolContext,
  getSymbolContext as getFallbackSymbolContext,
} from './query.js';
import { buildRepoIntelligenceContext as buildBaselineRepoIntelligenceContext } from './index.js';
import type {
  KodaXRepoIntelligenceCapability,
  KodaXRepoIntelligenceMode,
  KodaXRepoIntelligenceResolvedMode,
  KodaXRepoIntelligenceTrace,
  KodaXRepoRoutingSignals,
  KodaXToolExecutionContext,
} from '../types.js';
import type { RepoPreturnBundle } from '@kodax/repointel-protocol';
import { REPOINTEL_CONTRACT_VERSION } from '@kodax/repointel-protocol';
import {
  callPremiumDaemon,
  resolveRepoIntelligenceMode,
  resolveRepoIntelligenceRuntimeConfig,
} from './premium-client.js';
import { debugLogRepoIntelligence } from './internal.js';

type RepoContext = Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>;
type ValidatedRepoPreturnBundle = Omit<
  RepoPreturnBundle,
  'routingSignals' | 'moduleContext' | 'impactEstimate'
> & {
  routingSignals?: KodaXRepoRoutingSignals;
  moduleContext?: ModuleContextResult;
  impactEstimate?: ImpactEstimateResult;
};
type PremiumPreturnResult = {
  bundle: ValidatedRepoPreturnBundle;
  capability: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
};

const PRETURN_CACHE_TTL_MS = 1_500;
const premiumPreturnCache = new Map<string, {
  expiresAt: number;
  promise: Promise<PremiumPreturnResult | null>;
}>();
const MAX_PRETURN_CACHE_ENTRIES = 64;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isModuleCapsule(value: unknown): value is ModuleCapsule {
  return isRecord(value)
    && typeof value.moduleId === 'string'
    && typeof value.label === 'string'
    && typeof value.root === 'string'
    && isFiniteNumber(value.fileCount)
    && isFiniteNumber(value.sourceFileCount)
    && isFiniteNumber(value.symbolCount)
    && Array.isArray(value.languages)
    && isStringArray(value.topSymbols)
    && isStringArray(value.dependencies)
    && isStringArray(value.dependents)
    && isStringArray(value.entryFiles)
    && isStringArray(value.keyTests)
    && isStringArray(value.keyDocs)
    && isStringArray(value.sampleFiles)
    && isStringArray(value.processIds)
    && isFiniteNumber(value.confidence);
}

function isRepoSymbolRecord(value: unknown): value is RepoSymbolRecord {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.qualifiedName === 'string'
    && typeof value.filePath === 'string'
    && typeof value.moduleId === 'string'
    && typeof value.language === 'string'
    && typeof value.capabilityTier === 'string'
    && isFiniteNumber(value.line)
    && typeof value.signature === 'string'
    && typeof value.exported === 'boolean'
    && isStringArray(value.calls)
    && Array.isArray(value.callTargets)
    && isStringArray(value.importPaths)
    && isFiniteNumber(value.confidence);
}

function isProcessCapsule(value: unknown): value is ProcessCapsule {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && typeof value.moduleId === 'string'
    && typeof value.entryFile === 'string'
    && typeof value.summary === 'string'
    && Array.isArray(value.steps)
    && value.steps.every((step) => isRecord(step)
      && typeof step.kind === 'string'
      && typeof step.symbolName === 'string'
      && typeof step.filePath === 'string'
      && typeof step.note === 'string'
      && (step.line === undefined || isFiniteNumber(step.line)))
    && isFiniteNumber(value.confidence);
}

function isRepoRoutingSignals(value: unknown): value is KodaXRepoRoutingSignals {
  return isRecord(value)
    && isFiniteNumber(value.changedFileCount)
    && isFiniteNumber(value.changedLineCount)
    && isFiniteNumber(value.addedLineCount)
    && isFiniteNumber(value.deletedLineCount)
    && isFiniteNumber(value.touchedModuleCount)
    && isStringArray(value.changedModules)
    && typeof value.crossModule === 'boolean'
    && isStringArray(value.riskHints)
    && typeof value.plannerBias === 'boolean'
    && typeof value.investigationBias === 'boolean'
    && typeof value.lowConfidence === 'boolean';
}

function isModuleContextResult(value: unknown): value is ModuleContextResult {
  return isRecord(value)
    && isModuleCapsule(value.module)
    && typeof value.freshness === 'string'
    && isFiniteNumber(value.confidence)
    && isStringArray(value.evidence);
}

function isSymbolContextResult(value: unknown): value is SymbolContextResult {
  return isRecord(value)
    && isRepoSymbolRecord(value.symbol)
    && Array.isArray(value.alternatives)
    && value.alternatives.every(isRepoSymbolRecord)
    && Array.isArray(value.callers)
    && value.callers.every(isRepoSymbolRecord)
    && typeof value.freshness === 'string'
    && isFiniteNumber(value.confidence);
}

function isProcessContextResult(value: unknown): value is ProcessContextResult {
  return isRecord(value)
    && isProcessCapsule(value.process)
    && Array.isArray(value.alternatives)
    && value.alternatives.every(isProcessCapsule)
    && typeof value.freshness === 'string'
    && isFiniteNumber(value.confidence);
}

function isImpactEstimateResult(value: unknown): value is ImpactEstimateResult {
  return isRecord(value)
    && isRecord(value.target)
    && typeof value.target.kind === 'string'
    && typeof value.target.label === 'string'
    && typeof value.summary === 'string'
    && Array.isArray(value.impactedModules)
    && value.impactedModules.every(isModuleCapsule)
    && Array.isArray(value.impactedSymbols)
    && value.impactedSymbols.every(isRepoSymbolRecord)
    && Array.isArray(value.callers)
    && value.callers.every(isRepoSymbolRecord)
    && typeof value.freshness === 'string'
    && isFiniteNumber(value.confidence);
}

function isRepoPreturnBundle(value: unknown): value is ValidatedRepoPreturnBundle {
  return isRecord(value)
    && (value.routingSignals === undefined || isRepoRoutingSignals(value.routingSignals))
    && (value.moduleContext === undefined || isModuleContextResult(value.moduleContext))
    && (value.impactEstimate === undefined || isImpactEstimateResult(value.impactEstimate))
    && (value.repoContext === undefined || typeof value.repoContext === 'string')
    && (value.summary === undefined || typeof value.summary === 'string')
    && (value.recommendedFiles === undefined || isStringArray(value.recommendedFiles))
    && (value.lowConfidence === undefined || typeof value.lowConfidence === 'boolean');
}

function validatePremiumResult<T>(
  value: unknown,
  validator: (candidate: unknown) => candidate is T,
  label: string,
): T | undefined {
  if (validator(value)) {
    return value;
  }
  debugLogRepoIntelligence(`Premium repo-intelligence returned invalid ${label}; falling back to OSS.`);
  return undefined;
}

function pruneExpiredPremiumPreturnCache(now = Date.now()): void {
  for (const [key, entry] of premiumPreturnCache.entries()) {
    if (entry.expiresAt <= now) {
      premiumPreturnCache.delete(key);
    }
  }

  if (premiumPreturnCache.size <= MAX_PRETURN_CACHE_ENTRIES) {
    return;
  }

  const keys = Array.from(premiumPreturnCache.keys());
  for (const key of keys.slice(0, premiumPreturnCache.size - MAX_PRETURN_CACHE_ENTRIES)) {
    premiumPreturnCache.delete(key);
  }
}

function buildFallbackCapability(
  warnings: string[] = [],
): KodaXRepoIntelligenceCapability {
  return {
    mode: 'oss',
    engine: 'oss',
    bridge: 'none',
    level: 'basic',
    status: warnings.length > 0 ? 'limited' : 'ok',
    warnings,
  };
}

function buildPremiumCapability(
  mode: KodaXRepoIntelligenceResolvedMode,
  status: KodaXRepoIntelligenceCapability['status'],
  warnings: string[] = [],
): KodaXRepoIntelligenceCapability {
  return {
    mode,
    engine: 'premium',
    bridge: mode === 'premium-native' ? 'native' : 'shared',
    level: 'enhanced',
    status,
    warnings,
    contractVersion: REPOINTEL_CONTRACT_VERSION,
  };
}

function attachRepoIntelligenceMeta<T extends object>(
  result: T,
  capability: KodaXRepoIntelligenceCapability,
  trace?: KodaXRepoIntelligenceTrace,
): T {
  return {
    ...result,
    capability,
    ...(trace ? { trace } : {}),
  };
}

function premiumWarnings(
  mode: KodaXRepoIntelligenceResolvedMode,
  responseWarnings?: string[],
): string[] {
  return [
    ...(responseWarnings ?? []),
    ...(mode === 'premium-shared'
      ? ['Premium shared mode keeps KodaX on the cross-host path without native auto preturn injection.']
      : []),
  ];
}

async function tryPremiumPreturn(
  context: RepoContext,
  options: {
    targetPath?: string;
    refresh?: boolean;
    mode?: KodaXRepoIntelligenceMode;
    trace?: boolean;
  } = {},
): Promise<PremiumPreturnResult | null> {
  const runtimeConfig = resolveRepoIntelligenceRuntimeConfig(options.mode, options.trace);
  const resolvedMode = resolveRepoIntelligenceMode(runtimeConfig.mode);
  const cacheKey = JSON.stringify({
    mode: resolvedMode,
    endpoint: runtimeConfig.endpoint,
    bin: runtimeConfig.bin,
    executionCwd: context.executionCwd ?? '',
    gitRoot: context.gitRoot ?? '',
    targetPath: options.targetPath ?? '',
    refresh: options.refresh ?? false,
    trace: runtimeConfig.trace,
  });
  const now = Date.now();
  pruneExpiredPremiumPreturnCache(now);
  const cached = premiumPreturnCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = callPremiumDaemon('preturn', {
    executionCwd: context.executionCwd,
    gitRoot: context.gitRoot,
    targetPath: options.targetPath,
    refresh: options.refresh,
    host: 'kodax',
    intent: 'auto',
    budget: 1600,
  }, {
    mode: options.mode,
    trace: options.trace,
  }).then((premium) => {
    const bundle = validatePremiumResult(
      premium?.response.result,
      isRepoPreturnBundle,
      'preturn bundle',
    );
    if (!premium || !bundle) {
      return null;
    }
    return {
      bundle,
      capability: buildPremiumCapability(
        resolvedMode,
        premium.response.status,
        premiumWarnings(resolvedMode, premium.response.warnings),
      ),
      trace: premium.trace,
    };
  }).catch((error) => {
    premiumPreturnCache.delete(cacheKey);
    throw error;
  });

  premiumPreturnCache.set(cacheKey, {
    expiresAt: now + PRETURN_CACHE_TTL_MS,
    promise,
  });
  pruneExpiredPremiumPreturnCache(now);
  return promise;
}

function fallbackWarningsForMode(
  mode?: KodaXRepoIntelligenceMode,
): string[] {
  const resolvedMode = resolveRepoIntelligenceMode(mode);
  if (resolvedMode === 'off') {
    return ['Repo intelligence auto lane is disabled; using OSS baseline only.'];
  }
  if (resolvedMode === 'premium-shared' || resolvedMode === 'premium-native') {
    return ['Premium repo intelligence unavailable; fell back to OSS baseline.'];
  }
  return [];
}

export function resolveKodaXAutoRepoMode(
  mode?: KodaXRepoIntelligenceMode,
): KodaXRepoIntelligenceResolvedMode {
  const resolved = resolveRepoIntelligenceMode(mode);
  if (resolved === 'premium-shared') {
    return 'oss';
  }
  return resolved;
}

export async function buildRepoIntelligenceIndex(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<RepoIntelligenceIndex> {
  const index = await buildFallbackRepoIntelligenceIndex(context, options);
  return attachRepoIntelligenceMeta(index, buildFallbackCapability());
}

export async function getRepoIntelligenceIndex(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<RepoIntelligenceIndex> {
  const index = await getFallbackRepoIntelligenceIndex(context, options);
  return attachRepoIntelligenceMeta(index, buildFallbackCapability());
}

export async function getModuleContext(
  context: RepoContext,
  options: { module?: string; targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode } = {},
): Promise<ModuleContextResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  if (resolvedMode === 'premium-shared' || resolvedMode === 'premium-native') {
    const premium = await callPremiumDaemon('context-pack', {
      executionCwd: context.executionCwd,
      gitRoot: context.gitRoot,
      targetPath: options.targetPath,
      module: options.module,
      refresh: options.refresh,
      host: 'kodax',
      intent: 'auto',
      budget: 2200,
    }, {
      mode: options.mode,
    });
    const result = validatePremiumResult(
      premium?.response.result,
      isRepoPreturnBundle,
      'context-pack bundle',
    );
    if (premium && result?.moduleContext) {
      return attachRepoIntelligenceMeta(
        result.moduleContext,
        buildPremiumCapability(
          resolvedMode,
          premium.response.status,
          premiumWarnings(resolvedMode, premium.response.warnings),
        ),
        premium.trace,
      );
    }
  }
  const fallback = await getFallbackModuleContext(context, options);
  return attachRepoIntelligenceMeta(
    fallback,
    buildFallbackCapability(fallbackWarningsForMode(options.mode)),
  );
}

export async function getSymbolContext(
  context: RepoContext,
  options: { symbol: string; module?: string; targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode },
): Promise<SymbolContextResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  if (resolvedMode === 'premium-shared' || resolvedMode === 'premium-native') {
    const premium = await callPremiumDaemon('symbol', {
      executionCwd: context.executionCwd,
      gitRoot: context.gitRoot,
      targetPath: options.targetPath,
      module: options.module,
      symbol: options.symbol,
      refresh: options.refresh,
      host: 'kodax',
      intent: 'explain',
    }, {
      mode: options.mode,
    });
    const premiumResult = validatePremiumResult(
      premium?.response.result,
      isSymbolContextResult,
      'symbol context',
    );
    if (premium && premiumResult) {
      return attachRepoIntelligenceMeta(
        premiumResult,
        buildPremiumCapability(
          resolvedMode,
          premium.response.status,
          premiumWarnings(resolvedMode, premium.response.warnings),
        ),
        premium.trace,
      );
    }
  }
  const fallback = await getFallbackSymbolContext(context, options);
  return attachRepoIntelligenceMeta(
    fallback,
    buildFallbackCapability(fallbackWarningsForMode(options.mode)),
  );
}

export async function getProcessContext(
  context: RepoContext,
  options: { entry?: string; module?: string; targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode },
): Promise<ProcessContextResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  if (resolvedMode === 'premium-shared' || resolvedMode === 'premium-native') {
    const premium = await callPremiumDaemon('process', {
      executionCwd: context.executionCwd,
      gitRoot: context.gitRoot,
      targetPath: options.targetPath,
      module: options.module,
      entry: options.entry,
      refresh: options.refresh,
      host: 'kodax',
      intent: 'explain',
    }, {
      mode: options.mode,
    });
    const premiumResult = validatePremiumResult(
      premium?.response.result,
      isProcessContextResult,
      'process context',
    );
    if (premium && premiumResult) {
      return attachRepoIntelligenceMeta(
        premiumResult,
        buildPremiumCapability(
          resolvedMode,
          premium.response.status,
          premiumWarnings(resolvedMode, premium.response.warnings),
        ),
        premium.trace,
      );
    }
  }
  const fallback = await getFallbackProcessContext(context, options);
  return attachRepoIntelligenceMeta(
    fallback,
    buildFallbackCapability(fallbackWarningsForMode(options.mode)),
  );
}

export async function getImpactEstimate(
  context: RepoContext,
  options: { symbol?: string; module?: string; path?: string; targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode },
): Promise<ImpactEstimateResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  if (resolvedMode === 'premium-shared' || resolvedMode === 'premium-native') {
    const premium = await callPremiumDaemon('impact', {
      executionCwd: context.executionCwd,
      gitRoot: context.gitRoot,
      targetPath: options.targetPath,
      path: options.path,
      module: options.module,
      symbol: options.symbol,
      refresh: options.refresh,
      host: 'kodax',
      intent: 'review',
    }, {
      mode: options.mode,
    });
    const premiumResult = validatePremiumResult(
      premium?.response.result,
      isImpactEstimateResult,
      'impact estimate',
    );
    if (premium && premiumResult) {
      return attachRepoIntelligenceMeta(
        premiumResult,
        buildPremiumCapability(
          resolvedMode,
          premium.response.status,
          premiumWarnings(resolvedMode, premium.response.warnings),
        ),
        premium.trace,
      );
    }
  }
  const fallback = await getFallbackImpactEstimate(context, options);
  return attachRepoIntelligenceMeta(
    fallback,
    buildFallbackCapability(fallbackWarningsForMode(options.mode)),
  );
}

export async function getRepoRoutingSignals(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode } = {},
): Promise<KodaXRepoRoutingSignals> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  if (resolvedMode === 'premium-native') {
    const premium = await tryPremiumPreturn(context, options);
    if (premium?.bundle.routingSignals) {
      return attachRepoIntelligenceMeta(
        premium.bundle.routingSignals,
        premium.capability,
        premium.trace,
      );
    }
  }
  const fallback = await getFallbackRepoRoutingSignals(context, options);
  return attachRepoIntelligenceMeta(
    fallback,
    buildFallbackCapability(fallbackWarningsForMode(options.mode)),
  );
}

export async function getRepoPreturnBundle(
  context: RepoContext,
  options: {
    targetPath?: string;
    refresh?: boolean;
    mode?: KodaXRepoIntelligenceMode;
  } = {},
): Promise<{
  routingSignals?: KodaXRepoRoutingSignals;
  moduleContext?: ModuleContextResult;
  impactEstimate?: ImpactEstimateResult;
  repoContext?: string;
  summary?: string;
  recommendedFiles?: string[];
  lowConfidence?: boolean;
  capability: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  if (resolvedMode === 'premium-native') {
    const premium = await tryPremiumPreturn(context, options);
    if (premium) {
      return {
        routingSignals: premium.bundle.routingSignals
          ? attachRepoIntelligenceMeta(
            premium.bundle.routingSignals,
            premium.capability,
            premium.trace,
          )
          : undefined,
        moduleContext: premium.bundle.moduleContext
          ? attachRepoIntelligenceMeta(
            premium.bundle.moduleContext,
            premium.capability,
            premium.trace,
          )
          : undefined,
        impactEstimate: premium.bundle.impactEstimate
          ? attachRepoIntelligenceMeta(
            premium.bundle.impactEstimate,
            premium.capability,
            premium.trace,
          )
          : undefined,
        repoContext: premium.bundle.repoContext,
        summary: premium.bundle.summary,
        recommendedFiles: premium.bundle.recommendedFiles,
        lowConfidence: premium.bundle.lowConfidence,
        capability: premium.capability,
        trace: premium.trace,
      };
    }
  }

  const activeTargetPath = options.targetPath ?? (context.executionCwd ? '.' : undefined);
  const [routingSignals, moduleContext, impactEstimate, repoContext] = await Promise.all([
    getRepoRoutingSignals(context, { targetPath: options.targetPath, refresh: options.refresh, mode: 'oss' }),
    activeTargetPath
      ? getModuleContext(context, { targetPath: activeTargetPath, refresh: options.refresh, mode: 'oss' }).catch(() => undefined)
      : Promise.resolve(undefined),
    activeTargetPath
      ? getImpactEstimate(context, { targetPath: activeTargetPath, refresh: options.refresh, mode: 'oss' }).catch(() => undefined)
      : Promise.resolve(undefined),
    buildBaselineRepoIntelligenceContext(context, {
      includeRepoOverview: true,
      includeChangedScope: true,
      refreshOverview: options.refresh,
      changedScope: 'all',
      targetPath: options.targetPath,
    }).catch(() => ''),
  ]);

  const capability = buildFallbackCapability(fallbackWarningsForMode(options.mode));
  const recommendedFiles = [
    ...(moduleContext?.module?.entryFiles ?? []),
    ...(impactEstimate?.impactedSymbols?.slice(0, 4).map((symbol) => symbol.filePath) ?? []),
  ].slice(0, 6);
  return {
    routingSignals,
    moduleContext,
    impactEstimate,
    repoContext: repoContext || undefined,
    summary: repoContext
      || impactEstimate?.summary
      || (moduleContext ? `active module: ${moduleContext.module.label}` : undefined),
    recommendedFiles: recommendedFiles.length > 0 ? recommendedFiles : undefined,
    lowConfidence: (routingSignals?.lowConfidence ?? false)
      || (moduleContext?.confidence ?? 1) < 0.72
      || (impactEstimate?.confidence ?? 1) < 0.72,
    capability,
  };
}

export {
  renderImpactEstimate,
  renderModuleContext,
  renderProcessContext,
  renderSymbolContext,
};
