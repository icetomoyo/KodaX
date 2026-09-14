import type {
  ImpactEstimateResult,
  ModuleContextResult,
  ModuleCapsule,
  ProcessCapsule,
  ProcessContextResult,
  RepoSymbolRecord,
  RepoIntelligenceIndex,
  SymbolContextResult,
} from './semantic-types.js';
import {
  buildRepoIntelligenceIndex as buildWorkerRepoIntelligenceIndex,
  detachRepoIntelligenceWorkerRequest,
  getImpactEstimate as getWorkerImpactEstimate,
  getModuleContext as getWorkerModuleContext,
  getProcessContext as getWorkerProcessContext,
  getRepoIntelligenceIndex as getWorkerRepoIntelligenceIndex,
  getRepoRoutingSignals as getWorkerRepoRoutingSignals,
  getSymbolContext as getWorkerSymbolContext,
  getCyclicDependencyAnalysis as getWorkerCyclicDependencyAnalysis,
  semanticLookup as getWorkerSemanticLookup,
} from './semantic-worker-client.js';
import {
  renderImpactEstimate,
  renderModuleContext,
  renderProcessContext,
  renderSymbolContext,
} from './semantic-render.js';
import type { RepoIntelligenceAnalysisProfile } from './semantic-shared.js';
import type {
  SemanticLookupKind,
  SemanticLookupResult,
} from './semantic-lookup-query.js';
import type { CycleAnalysis } from './cyclic-deps.js';
import path from 'node:path';
import { buildRepoIntelligenceContext as buildBaselineRepoIntelligenceContext } from './index.js';
import type {
  KodaXRepoIntelligenceCapability,
  KodaXRepoIntelligenceMode,
  KodaXRepoIntelligenceResolvedMode,
  KodaXRepoIntelligenceTrace,
  KodaXRepoRoutingSignals,
  KodaXToolExecutionContext,
} from '../types.js';
import type { RepoPreturnBundle } from './protocol.js';
import { REPOINTEL_CONTRACT_VERSION } from './protocol.js';
import {
  resolveRepoIntelligenceMode,
  resolveRepoIntelligenceRuntimeConfig,
} from './runtime-config.js';
export type {
  RepoIntelligenceRuntimeConfig,
  RepoIntelligenceRuntimeInspection,
} from './runtime-config.js';
export {
  inspectRepoIntelligenceRuntime,
  resolveRepoIntelligenceMode,
  resolveRepoIntelligenceRuntimeConfig,
} from './runtime-config.js';
import { debugLogRepoIntelligence } from './internal.js';

type RepoContext = Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>;
const REPO_INTELLIGENCE_PREWARM_DISABLED = '0';
const REPO_INTELLIGENCE_PREWARM_DELAY_MS = 1_500;
const DEFAULT_REPO_INTELLIGENCE_TOOL_WAIT_MS = 2_000;
const MIN_REPO_INTELLIGENCE_TOOL_WAIT_MS = 250;

export function readRepoIntelligenceToolWaitMs(): number {
  const configured = Number(process.env.KODAX_REPO_INTELLIGENCE_TOOL_WAIT_MS);
  if (Number.isFinite(configured) && configured >= MIN_REPO_INTELLIGENCE_TOOL_WAIT_MS) {
    return Math.floor(configured);
  }
  return DEFAULT_REPO_INTELLIGENCE_TOOL_WAIT_MS;
}

/**
 * v0.7.41 hotfix - cacheKey-input normalizer. Different callers produce
 * subtly-different path strings for the same workspace:
 *   - `run-substrate.ts` runs `path.resolve(opts.context.executionCwd)`
 *     which (on Windows) upper-cases the drive letter (`c:\` -> `C:\`).
 *   - Startup prewarm previously passed the raw `context.gitRoot` from
 *     React state without any normalization.
 *
 * Without normalizing here the two callers produce different cacheKey
 * strings for the same workspace -> cache miss -> prewarm misses its target
 * round entirely. Normalizing inside the cacheKey computation makes the
 * cache robust to all caller variations (case differences, trailing slash,
 * forward/back slash on Windows, relative vs absolute, etc.).
 *
 * Empty input returns '' (matches prior behaviour of `context.X ?? ''`).
 */
function normalizeCachePath(value: string | undefined | null): string {
  if (!value) return '';
  try {
    return path.resolve(value);
  } catch {
    return value;
  }
}

function normalizePreturnTargetPath(
  context: RepoContext,
  targetPath: string | undefined,
): string | undefined {
  return targetPath ?? (context.executionCwd ? '.' : undefined);
}
type ValidatedRepoPreturnBundle = Omit<
  RepoPreturnBundle,
  'routingSignals' | 'moduleContext' | 'impactEstimate'
> & {
  routingSignals?: KodaXRepoRoutingSignals;
  moduleContext?: ModuleContextResult;
  impactEstimate?: ImpactEstimateResult;
};
type FullPreturnResult = {
  bundle: ValidatedRepoPreturnBundle;
  capability: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
};

const PRETURN_CACHE_TTL_MS = 1_500;
/**
 * v0.7.41 P3 - routing-signals cache TTL. Routing signals (active module id,
 * primaryTask hints, harness profile, complexity) describe stable repo
 * properties; for an interactive REPL session they do not change between
 * rounds unless cwd / gitRoot / mode changes, and the cache key already
 * includes those. The 60s TTL is a defensive ceiling so a long-running
 * session eventually re-validates against fresh built-in index state. Caller
 * can still bypass with `refresh: true` (e.g. eval harness or explicit
 * diagnostics refresh path).
 *
 * Cross-layer note: this cache sits OUTSIDE `tryFullPreturn`'s 1.5s
 * cache - the inner cache coalesces same-round duplicates (P2); this outer
 * cache eliminates duplicate full-index work across rounds (P3).
 */
const ROUTING_SIGNALS_CACHE_TTL_MS = 60_000;
/**
 * v0.7.41 P2 - `pending` distinguishes an in-flight full-engine call from a
 * resolved-and-cached entry. While `pending===true` the entry's `expiresAt`
 * is `Number.POSITIVE_INFINITY` so the TTL never prunes it mid-flight; once
 * the promise resolves we flip `pending=false` and stamp the real expiry.
 * This lets same-round duplicate callers (e.g. `getRepoRoutingSignals` then
 * `getRepoPreturnBundle`, both keyed on the same preturn payload) coalesce
 * onto one full-index build/read even when that work exceeds the prior 1.5s
 * TTL. Full cold refreshes can still take multiple seconds on large repos.
 */
type FullPreturnCacheEntry = {
  pending: boolean;
  expiresAt: number;
  promise: Promise<FullPreturnResult | null>;
};
const fullPreturnCache = new Map<string, FullPreturnCacheEntry>();
const MAX_PRETURN_CACHE_ENTRIES = 64;

/**
 * v0.7.41 P3 - routing-signals cross-round cache. Same in-flight/TTL shape
 * as `fullPreturnCache`. Key serialises (mode, executionCwd, gitRoot,
 * targetPath) so any change there triggers a fresh resolve.
 */
type RoutingSignalsCacheEntry = {
  pending: boolean;
  expiresAt: number;
  promise: Promise<KodaXRepoRoutingSignals>;
};
const routingSignalsCache = new Map<string, RoutingSignalsCacheEntry>();

/**
 * v0.7.41 P3+ preturn-bundle session cache (same shape as routing signals).
 * The bundle returned by `getRepoPreturnBundle` is the heavy repo-intel
 * payload; the rest of the pre-LLM pipeline keys off it. Sharing across rounds
 * and across startup prewarm -> first-round is the single biggest TTFB win.
 */
type RepoPreturnBundleResult = {
  routingSignals?: KodaXRepoRoutingSignals;
  moduleContext?: ModuleContextResult;
  impactEstimate?: ImpactEstimateResult;
  repoContext?: string;
  summary?: string;
  recommendedFiles?: string[];
  lowConfidence?: boolean;
  capability: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
};
type PreturnBundleCacheEntry = {
  pending: boolean;
  expiresAt: number;
  promise: Promise<RepoPreturnBundleResult>;
};
const preturnBundleCache = new Map<string, PreturnBundleCacheEntry>();

/**
 * v0.7.41 P2/P3 - test-only helper to drop both module-singleton caches.
 * Production code MUST NOT call this; cache invalidation in real runs is
 * handled by TTL expiry and the `refresh: true` opt-out at call sites.
 *
 * Exposed so test fixtures can isolate per-`it()` cache state without
 * depending on the previous test having different cacheKeys.
 */
export function _resetRepoIntelligenceCachesForTesting(): void {
  fullPreturnCache.clear();
  routingSignalsCache.clear();
  preturnBundleCache.clear();
}

export function _getRepoIntelligenceCacheSizesForTesting(): {
  readonly fullPreturn: number;
  readonly routingSignals: number;
  readonly preturnBundle: number;
} {
  return {
    fullPreturn: fullPreturnCache.size,
    routingSignals: routingSignalsCache.size,
    preturnBundle: preturnBundleCache.size,
  };
}

function pruneCacheEntries<T extends { readonly expiresAt: number }>(
  cache: Map<string, T>,
  maxEntries: number,
  now = Date.now(),
): void {
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }

  if (cache.size <= maxEntries) {
    return;
  }

  const keys = Array.from(cache.keys());
  for (const key of keys.slice(0, cache.size - maxEntries)) {
    cache.delete(key);
  }
}

function pruneExpiredFullPreturnCache(now = Date.now()): void {
  pruneCacheEntries(fullPreturnCache, MAX_PRETURN_CACHE_ENTRIES, now);
}

function pruneRoutingSignalsCache(now = Date.now()): void {
  pruneCacheEntries(routingSignalsCache, MAX_PRETURN_CACHE_ENTRIES, now);
}

function prunePreturnBundleCache(now = Date.now()): void {
  pruneCacheEntries(preturnBundleCache, MAX_PRETURN_CACHE_ENTRIES, now);
}

function isFullRepoIntelligenceMode(mode: KodaXRepoIntelligenceResolvedMode): boolean {
  return mode === 'full';
}

function buildFullCapability(
  mode: KodaXRepoIntelligenceResolvedMode,
  status: KodaXRepoIntelligenceCapability['status'] = 'ok',
  warnings: string[] = [],
): KodaXRepoIntelligenceCapability {
  return {
    mode,
    engine: 'full',
    level: 'enhanced',
    status,
    warnings,
    contractVersion: REPOINTEL_CONTRACT_VERSION,
  };
}

function buildWorkerCapability(
  mode: KodaXRepoIntelligenceResolvedMode,
  status: KodaXRepoIntelligenceCapability['status'] = 'ok',
  warnings: string[] = [],
): KodaXRepoIntelligenceCapability {
  if (mode === 'full') {
    return buildFullCapability(mode, status, warnings);
  }
  return {
    mode,
    engine: 'light',
    level: 'basic',
    status,
    warnings,
    contractVersion: REPOINTEL_CONTRACT_VERSION,
  };
}

function profileForMode(mode: KodaXRepoIntelligenceResolvedMode): RepoIntelligenceAnalysisProfile | undefined {
  if (mode === 'full') return 'full';
  if (mode === 'light') return 'light';
  return undefined;
}

function workspaceRootForContext(context: RepoContext): string {
  return context.gitRoot ?? context.executionCwd ?? process.cwd();
}

function limitedWarnings(label: string): string[] {
  return [
    `Repo intelligence ${label} unavailable; worker fallback stayed lightweight to keep the UI responsive.`,
    'Validate critical edits with read, grep, and targeted repo-intelligence tools after the worker recovers.',
  ];
}

function warmingWarnings(label: string, maxWaitMs: number | undefined): string[] {
  const wait = maxWaitMs === undefined ? 'the short tool budget' : `${maxWaitMs}ms`;
  return [
    `Repo intelligence ${label} is still warming and did not finish within ${wait}.`,
    'The background worker continues indexing; retry this tool shortly for full structural results.',
    'Use read, grep, glob, and LSP tools for immediate exploration while the index finishes.',
  ];
}

function buildLimitedModule(context: RepoContext, targetPath?: string): ModuleCapsule {
  return {
    moduleId: '.',
    label: 'Workspace Root (limited)',
    kind: 'root',
    root: '.',
    fileCount: 0,
    sourceFileCount: 0,
    symbolCount: 0,
    languages: [],
    topSymbols: [],
    dependencies: [],
    dependents: [],
    entryFiles: targetPath ? [targetPath] : [],
    keyTests: [],
    keyDocs: [],
    sampleFiles: targetPath ? [targetPath] : [],
    processIds: [],
    confidence: 0.1,
  };
}

function buildLimitedSymbol(name: string, targetPath?: string): RepoSymbolRecord {
  return {
    id: `limited:${name}`,
    name,
    qualifiedName: name,
    kind: 'function',
    filePath: targetPath ?? '',
    moduleId: '.',
    language: 'unknown',
    capabilityTier: 'low',
    line: 1,
    signature: name,
    exported: false,
    calls: [],
    callTargets: [],
    importPaths: [],
    confidence: 0.1,
  };
}

function unavailableSummary(
  label: string,
  capability: KodaXRepoIntelligenceCapability,
): string {
  return capability.status === 'warming'
    ? `Repo intelligence ${label} is still warming; retry this tool shortly for full structural results.`
    : `Repo intelligence ${label} is unavailable because the worker did not respond.`;
}

function buildLimitedProcess(
  capability: KodaXRepoIntelligenceCapability,
  targetPath?: string,
): ProcessCapsule {
  return {
    id: 'limited',
    label: 'Limited repo-intelligence process',
    moduleId: '.',
    entryFile: targetPath ?? '',
    summary: unavailableSummary('process context', capability),
    steps: [],
    confidence: 0.1,
  };
}

function buildLimitedIndex(
  context: RepoContext,
  capability: KodaXRepoIntelligenceCapability,
  targetPath?: string,
): RepoIntelligenceIndex {
  const now = new Date().toISOString();
  const module = buildLimitedModule(context, targetPath);
  return {
    schemaVersion: 1,
    workspaceRoot: workspaceRootForContext(context),
    generatedAt: now,
    overviewGeneratedAt: now,
    sourceFileCount: 0,
    sourceFingerprint: 'limited',
    languages: [],
    modules: [module],
    symbols: [],
    processes: [],
    capability,
  };
}

function buildLimitedModuleContext(
  context: RepoContext,
  capability: KodaXRepoIntelligenceCapability,
  targetPath?: string,
): ModuleContextResult {
  return {
    module: buildLimitedModule(context, targetPath),
    freshness: 'limited',
    confidence: 0.1,
    evidence: [],
    capability,
  };
}

function buildLimitedSymbolContext(
  capability: KodaXRepoIntelligenceCapability,
  symbol: string,
  targetPath?: string,
): SymbolContextResult {
  return {
    symbol: buildLimitedSymbol(symbol, targetPath),
    alternatives: [],
    callers: [],
    freshness: 'limited',
    confidence: 0.1,
    capability,
  };
}

function buildLimitedProcessContext(
  capability: KodaXRepoIntelligenceCapability,
  targetPath?: string,
): ProcessContextResult {
  return {
    process: buildLimitedProcess(capability, targetPath),
    alternatives: [],
    freshness: 'limited',
    confidence: 0.1,
    capability,
  };
}

function buildLimitedImpactEstimate(
  capability: KodaXRepoIntelligenceCapability,
  options: { symbol?: string; module?: string; path?: string; targetPath?: string },
): ImpactEstimateResult {
  const label = options.symbol ?? options.module ?? options.path ?? options.targetPath ?? 'workspace';
  return {
    target: options.symbol
      ? { kind: 'symbol', label }
      : options.module
        ? { kind: 'module', label, moduleId: options.module }
        : { kind: 'path', label, filePath: options.path ?? options.targetPath },
    summary: unavailableSummary('impact estimate', capability),
    impactedModules: [],
    impactedSymbols: [],
    callers: [],
    freshness: 'limited',
    confidence: 0.1,
    capability,
  };
}

function buildLimitedRoutingSignals(
  context: RepoContext,
  capability: KodaXRepoIntelligenceCapability,
): KodaXRepoRoutingSignals {
  return {
    workspaceRoot: workspaceRootForContext(context),
    changedFileCount: 0,
    changedLineCount: 0,
    addedLineCount: 0,
    deletedLineCount: 0,
    touchedModuleCount: 0,
    changedModules: [],
    crossModule: false,
    riskHints: ['repo-intelligence-worker-unavailable'],
    plannerBias: false,
    investigationBias: true,
    lowConfidence: true,
    capability,
  };
}

function buildFullTrace(
  mode: KodaXRepoIntelligenceResolvedMode,
  triggeredAt: number,
): KodaXRepoIntelligenceTrace {
  return {
    mode,
    engine: 'full',
    triggeredAt: new Date(triggeredAt).toISOString(),
    source: 'full',
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

async function captureFullPreturnValue<T>(
  label: string,
  warnings: string[],
  promise: Promise<T>,
): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    warnings.push(`${label} unavailable`);
    debugLogRepoIntelligence(`Full repo-intelligence ${label} unavailable.`, error);
    return undefined;
  }
}

function buildContextPackSummary(
  moduleContext?: ModuleContextResult,
  impactEstimate?: ImpactEstimateResult,
): string | undefined {
  const summaryParts: string[] = [];
  if (moduleContext?.module.label) {
    summaryParts.push(`active module: ${moduleContext.module.label}`);
  }
  if (impactEstimate?.summary) {
    summaryParts.push(impactEstimate.summary);
  }
  return summaryParts.length > 0 ? summaryParts.join(' | ') : undefined;
}

async function tryWorkerQuery<T extends object>(
  mode: KodaXRepoIntelligenceResolvedMode,
  label: string,
  load: (profile: RepoIntelligenceAnalysisProfile) => Promise<T>,
): Promise<T | undefined> {
  const outcome = await tryWorkerQueryOutcome(mode, label, load);
  return outcome.result;
}

interface WorkerQueryOutcome<T> {
  result?: T;
  timedOut: boolean;
}

function normalizeMaxWaitMs(maxWaitMs: number | undefined): number | undefined {
  if (maxWaitMs === undefined) {
    return undefined;
  }
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
    return undefined;
  }
  return Math.floor(maxWaitMs);
}

async function settleWorkerQueryWithinBudget<T>(
  label: string,
  promise: Promise<T | undefined>,
  maxWaitMs: number | undefined,
  detachPromise?: Promise<unknown>,
): Promise<WorkerQueryOutcome<T>> {
  const budget = normalizeMaxWaitMs(maxWaitMs);
  if (budget === undefined) {
    return { result: await promise, timedOut: false };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = promise.then(
    (result): WorkerQueryOutcome<T> => ({ result, timedOut: false }),
    (error): WorkerQueryOutcome<T> => {
      debugLogRepoIntelligence(`Repo-intelligence worker ${label} failed after budget race.`, error);
      return { result: undefined, timedOut: false };
    },
  );
  const timeout = new Promise<WorkerQueryOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ result: undefined, timedOut: true });
    }, budget);
    if (typeof timer === 'object' && typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  const outcome = await Promise.race([guarded, timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  if (outcome.timedOut) {
    detachRepoIntelligenceWorkerRequest(detachPromise ?? promise);
    void guarded;
  }
  return outcome;
}

async function tryWorkerQueryOutcome<T extends object>(
  mode: KodaXRepoIntelligenceResolvedMode,
  label: string,
  load: (profile: RepoIntelligenceAnalysisProfile) => Promise<T>,
  maxWaitMs?: number,
): Promise<WorkerQueryOutcome<T>> {
  const profile = profileForMode(mode);
  if (!profile) {
    return { result: undefined, timedOut: false };
  }
  try {
    const workerPromise = load(profile);
    return await settleWorkerQueryWithinBudget(
      label,
      workerPromise.then((result) => attachRepoIntelligenceMeta(
        result,
        buildWorkerCapability(mode),
      )),
      maxWaitMs,
      workerPromise,
    );
  } catch (error) {
    debugLogRepoIntelligence(`Repo-intelligence worker ${label} unavailable.`, error);
    return { result: undefined, timedOut: false };
  }
}

async function tryFullPreturn(
  context: RepoContext,
  options: {
    targetPath?: string;
    refresh?: boolean;
    mode?: KodaXRepoIntelligenceMode;
    trace?: boolean;
  } = {},
): Promise<FullPreturnResult | null> {
  const runtimeConfig = resolveRepoIntelligenceRuntimeConfig(options.mode, options.trace);
  const resolvedMode = resolveRepoIntelligenceMode(runtimeConfig.mode);
  if (!isFullRepoIntelligenceMode(resolvedMode)) {
    return null;
  }
  // P2 in-flight cacheKey DELIBERATELY includes `refresh` (and `trace`) -
  // intentional asymmetry with the P3/P3+ outer caches (which omit refresh).
  // P3+ already dominates within 60s; P2 only matters when P3+ misses AND
  // two concurrent callers fire with different refresh values in the same
  // 1.5s window. In that narrow case, an explicit refresh:true caller
  // (e.g. explicit diagnostics refresh or eval harness) deserves its own full-index work
  // and MUST NOT be served a refresh:false sibling's Promise. Outer cache
  // semantics ("data within TTL is fresh by definition") apply at 60s
  // session scope; in-flight Promise sharing keeps the finer-grained intent.
  const activeTargetPath = normalizePreturnTargetPath(context, options.targetPath);
  const cacheKey = JSON.stringify({
    mode: resolvedMode,
    executionCwd: normalizeCachePath(context.executionCwd),
    gitRoot: normalizeCachePath(context.gitRoot),
    targetPath: activeTargetPath ?? '',
    refresh: options.refresh ?? false,
    trace: runtimeConfig.trace,
  });
  const now = Date.now();
  pruneExpiredFullPreturnCache(now);
  const cached = fullPreturnCache.get(cacheKey);
  if (cached) {
    // v0.7.41 P2: an in-flight call always coalesces, regardless of TTL.
    // A resolved entry honours the original 1.5s TTL.
    if (cached.pending || cached.expiresAt > now) {
      return cached.promise;
    }
  }

  // Allocate the entry with `pending: true` BEFORE awaiting so any
  // concurrent caller arriving between this point and the first await
  // sees the same in-flight promise. `expiresAt: Infinity` keeps prune
  // (TTL pass) from removing it while pending.
  let entry: FullPreturnCacheEntry;
  const promise = (async (): Promise<FullPreturnResult | null> => {
    const warnings: string[] = [];
    const triggeredAt = Date.now();
    const repoContext = await captureFullPreturnValue(
      'repo context',
      warnings,
      buildBaselineRepoIntelligenceContext(context, {
        includeRepoOverview: true,
        includeChangedScope: true,
        refreshOverview: options.refresh,
        changedScope: 'all',
        targetPath: activeTargetPath,
      }),
    );
    const routingSignals = await captureFullPreturnValue(
      'routing signals',
      warnings,
      getWorkerRepoRoutingSignals(context, {
        targetPath: activeTargetPath,
        refresh: options.refresh,
        profile: 'full',
      }),
    );
    const moduleContext = activeTargetPath
      ? await captureFullPreturnValue(
        'module context',
        warnings,
        getWorkerModuleContext(context, {
          targetPath: activeTargetPath,
          refresh: options.refresh,
          profile: 'full',
        }),
      )
      : undefined;
    const impactEstimate = activeTargetPath
      ? await captureFullPreturnValue(
        'impact estimate',
        warnings,
        getWorkerImpactEstimate(context, {
          targetPath: activeTargetPath,
          refresh: options.refresh,
          profile: 'full',
        }),
      )
      : undefined;
    const bundle: ValidatedRepoPreturnBundle | null = repoContext || moduleContext || impactEstimate || routingSignals
      ? {
        routingSignals,
        moduleContext,
        impactEstimate,
        repoContext,
        summary: buildContextPackSummary(moduleContext, impactEstimate),
        recommendedFiles: [
          ...(moduleContext?.module.entryFiles ?? []),
          ...(impactEstimate?.impactedSymbols.slice(0, 4).map((symbol) => symbol.filePath) ?? []),
        ].slice(0, 6),
        lowConfidence: (routingSignals?.lowConfidence ?? false)
          || (moduleContext?.confidence ?? 1) < 0.72
          || (impactEstimate?.confidence ?? 1) < 0.72,
      }
      : null;
    // Flip in-flight -> TTL-controlled now that the call has resolved.
    if (!bundle) {
      return null;
    }
    return {
      bundle,
      capability: buildFullCapability(
        resolvedMode,
        warnings.length > 0 ? 'limited' : 'ok',
        warnings,
      ),
      trace: runtimeConfig.trace ? buildFullTrace(resolvedMode, triggeredAt) : undefined,
    };
  })().then((result) => {
    entry.pending = false;
    entry.expiresAt = Date.now() + PRETURN_CACHE_TTL_MS;
    return result;
  }).catch((error) => {
    fullPreturnCache.delete(cacheKey);
    throw error;
  });

  entry = {
    pending: true,
    expiresAt: Number.POSITIVE_INFINITY,
    promise,
  };
  fullPreturnCache.set(cacheKey, entry);
  pruneExpiredFullPreturnCache(now);
  return promise;
}

export function resolveKodaXAutoRepoMode(
  mode?: KodaXRepoIntelligenceMode,
): KodaXRepoIntelligenceResolvedMode {
  const resolved = resolveRepoIntelligenceMode(mode);
  return resolved;
}

export function resolveKodaXHotPathRepoMode(
  mode?: KodaXRepoIntelligenceMode,
): KodaXRepoIntelligenceMode {
  return resolveRepoIntelligenceMode(mode);
}

export async function buildRepoIntelligenceIndex(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<RepoIntelligenceIndex> {
  const resolvedMode = resolveRepoIntelligenceMode();
  const profile = profileForMode(resolvedMode);
  if (profile) {
    const result = await tryWorkerQuery(resolvedMode, 'index build', (activeProfile) =>
      buildWorkerRepoIntelligenceIndex(context, { ...options, profile: activeProfile }));
    if (result) return result;
  }
  return buildLimitedIndex(
    context,
    buildWorkerCapability(resolvedMode, 'unavailable', limitedWarnings('index build')),
    options.targetPath,
  );
}

export async function getRepoIntelligenceIndex(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<RepoIntelligenceIndex> {
  const resolvedMode = resolveRepoIntelligenceMode();
  const profile = profileForMode(resolvedMode);
  if (profile) {
    const result = await tryWorkerQuery(resolvedMode, 'index', (activeProfile) =>
      getWorkerRepoIntelligenceIndex(context, { ...options, profile: activeProfile }));
    if (result) return result;
  }
  return buildLimitedIndex(
    context,
    buildWorkerCapability(resolvedMode, 'unavailable', limitedWarnings('index')),
    options.targetPath,
  );
}

export async function semanticLookup(
  context: RepoContext,
  options: {
    query: string;
    kind: SemanticLookupKind;
    limit: number;
    targetPath?: string;
    refresh?: boolean;
    mode?: KodaXRepoIntelligenceMode;
    maxWaitMs?: number;
  },
): Promise<SemanticLookupResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  const outcome = await tryWorkerQueryOutcome(resolvedMode, 'semantic lookup', (profile) =>
    getWorkerSemanticLookup(context, {
      targetPath: options.targetPath,
      refresh: options.refresh,
      profile,
      query: options.query,
      lookupKind: options.kind,
      limit: options.limit,
    }), options.maxWaitMs);
  const result = outcome.result;
  if (result) {
    const capability = buildWorkerCapability(resolvedMode);
    return {
      ...result,
      capability,
      capabilityEngine: result.capabilityEngine ?? capability.engine,
    };
  }
  const capability = outcome.timedOut
    ? buildWorkerCapability(resolvedMode, 'warming', warmingWarnings('semantic lookup', options.maxWaitMs))
    : buildWorkerCapability(resolvedMode, 'unavailable', limitedWarnings('semantic lookup'));
  return {
    items: [],
    artifacts: [],
    generatedAt: new Date().toISOString(),
    sourceFileCount: 0,
    capability,
    capabilityEngine: capability.engine,
  };
}

export async function getCyclicDependencyAnalysis(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode; maxWaitMs?: number } = {},
): Promise<CycleAnalysis> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  const outcome = await tryWorkerQueryOutcome(resolvedMode, 'cyclic dependency analysis', (profile) =>
    getWorkerCyclicDependencyAnalysis(context, {
      targetPath: options.targetPath,
      refresh: options.refresh,
      profile,
    }), options.maxWaitMs);
  const result = outcome.result;
  if (result) return result;
  if (outcome.timedOut) {
    return {
      cycles: [],
      scanned: { modules: 0, edges: 0 },
      summary: warmingWarnings('cyclic dependency analysis', options.maxWaitMs).join(' '),
    };
  }
  return {
    cycles: [],
    scanned: { modules: 0, edges: 0 },
    summary: 'Cyclic dependency analysis unavailable because the repo-intelligence worker did not respond.',
  };
}

export async function getModuleContext(
  context: RepoContext,
  options: { module?: string; targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode; maxWaitMs?: number } = {},
): Promise<ModuleContextResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  const outcome = await tryWorkerQueryOutcome(resolvedMode, 'module context', (profile) =>
    getWorkerModuleContext(context, { ...options, profile }), options.maxWaitMs);
  const result = outcome.result;
  if (result) return result;
  return buildLimitedModuleContext(
    context,
    outcome.timedOut
      ? buildWorkerCapability(resolvedMode, 'warming', warmingWarnings('module context', options.maxWaitMs))
      : buildWorkerCapability(resolvedMode, 'unavailable', limitedWarnings('module context')),
    options.targetPath,
  );
}

export async function getSymbolContext(
  context: RepoContext,
  options: { symbol: string; module?: string; targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode; maxWaitMs?: number },
): Promise<SymbolContextResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  const outcome = await tryWorkerQueryOutcome(resolvedMode, 'symbol context', (profile) =>
    getWorkerSymbolContext(context, { ...options, profile }), options.maxWaitMs);
  const result = outcome.result;
  if (result) return result;
  return buildLimitedSymbolContext(
    outcome.timedOut
      ? buildWorkerCapability(resolvedMode, 'warming', warmingWarnings('symbol context', options.maxWaitMs))
      : buildWorkerCapability(resolvedMode, 'unavailable', limitedWarnings('symbol context')),
    options.symbol,
    options.targetPath,
  );
}

export async function getProcessContext(
  context: RepoContext,
  options: { entry?: string; module?: string; targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode; maxWaitMs?: number },
): Promise<ProcessContextResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  const outcome = await tryWorkerQueryOutcome(resolvedMode, 'process context', (profile) =>
    getWorkerProcessContext(context, { ...options, profile }), options.maxWaitMs);
  const result = outcome.result;
  if (result) return result;
  return buildLimitedProcessContext(
    outcome.timedOut
      ? buildWorkerCapability(resolvedMode, 'warming', warmingWarnings('process context', options.maxWaitMs))
      : buildWorkerCapability(resolvedMode, 'unavailable', limitedWarnings('process context')),
    options.targetPath,
  );
}

export async function getImpactEstimate(
  context: RepoContext,
  options: { symbol?: string; module?: string; path?: string; targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode; maxWaitMs?: number },
): Promise<ImpactEstimateResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  const outcome = await tryWorkerQueryOutcome(resolvedMode, 'impact estimate', (profile) =>
    getWorkerImpactEstimate(context, { ...options, profile }), options.maxWaitMs);
  const result = outcome.result;
  if (result) return result;
  return buildLimitedImpactEstimate(
    outcome.timedOut
      ? buildWorkerCapability(resolvedMode, 'warming', warmingWarnings('impact estimate', options.maxWaitMs))
      : buildWorkerCapability(resolvedMode, 'unavailable', limitedWarnings('impact estimate')),
    options,
  );
}

export async function getRepoRoutingSignals(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean; mode?: KodaXRepoIntelligenceMode } = {},
): Promise<KodaXRepoRoutingSignals> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  const activeTargetPath = normalizePreturnTargetPath(context, options.targetPath);

  // v0.7.41 P3 - session-scoped cache. Two-tier lookup:
  //   1. In-flight: always share the pending promise, regardless of refresh.
  //      Otherwise two concurrent callers (startup prewarm + first-round
  //      prompt) would each launch their own full-index build.
  //   2. Resolved + within TTL: serve from cache even when caller asked for
  //      refresh:true. The intent of refresh:true is "I want fresh data";
  //      data resolved within the 60s TTL is BY DEFINITION fresh, so the
  //      cache hit honors that intent without redundant local indexing. This
  //      is what lets startup prewarm (L2, refresh:false) cover the
  //      first-round middleware call (L1, also refresh:false).
  //   3. Resolved + stale (past TTL): cache miss; new local full-index read
  //      or rebuild is made, with refresh:true propagated to that call.
  //
  // cacheKey deliberately ignores legacy endpoint/bin settings because full
  // repo intelligence is now in-process.
  // cacheKey deliberately OMITS `refresh` so prewarm and first-round share
  // the same entry - see the prewarm/first-round coalescing semantics above.
  const cacheKey = JSON.stringify({
    mode: resolvedMode,
    executionCwd: normalizeCachePath(context.executionCwd),
    gitRoot: normalizeCachePath(context.gitRoot),
    targetPath: activeTargetPath ?? '',
  });
  const now = Date.now();
  pruneRoutingSignalsCache(now);
  const cached = routingSignalsCache.get(cacheKey);
  if (cached) {
    if (cached.pending) {
      return cached.promise;
    }
    if (cached.expiresAt > now) {
      return cached.promise;
    }
  }

  let entry: RoutingSignalsCacheEntry;
  const promise = (async (): Promise<KodaXRepoRoutingSignals> => {
    if (isFullRepoIntelligenceMode(resolvedMode)) {
      const full = await tryFullPreturn(context, options);
      if (full?.bundle.routingSignals) {
        return attachRepoIntelligenceMeta(
          full.bundle.routingSignals,
          full.capability,
          full.trace,
        );
      }
      return buildLimitedRoutingSignals(
        context,
        buildWorkerCapability(resolvedMode, 'unavailable', limitedWarnings('routing signals')),
      );
    }
    if (resolvedMode === 'light') {
      const result = await tryWorkerQuery(resolvedMode, 'routing signals', (profile) =>
        getWorkerRepoRoutingSignals(context, {
          targetPath: activeTargetPath,
          refresh: options.refresh,
          profile,
        }));
      if (result) return result;
    }
    return buildLimitedRoutingSignals(
      context,
      buildWorkerCapability(resolvedMode, 'unavailable', limitedWarnings('routing signals')),
    );
  })().then((result) => {
    entry.pending = false;
    entry.expiresAt = Date.now() + ROUTING_SIGNALS_CACHE_TTL_MS;
    return result;
  }).catch((error) => {
    routingSignalsCache.delete(cacheKey);
    throw error;
  });

  entry = {
    pending: true,
    expiresAt: Number.POSITIVE_INFINITY,
    promise,
  };
  routingSignalsCache.set(cacheKey, entry);
  pruneRoutingSignalsCache(now);
  return promise;
}

export async function getRepoPreturnBundle(
  context: RepoContext,
  options: {
    targetPath?: string;
    refresh?: boolean;
    mode?: KodaXRepoIntelligenceMode;
  } = {},
): Promise<RepoPreturnBundleResult> {
  // v0.7.41 P3+ - session cache. Same semantics as routing signals:
  //   1. In-flight: share regardless of refresh
  //   2. Resolved + within TTL: serve even on refresh:true (the data IS fresh)
  //   3. Resolved + stale: miss -> new full-engine call (refresh propagates)
  // cacheKey omits refresh so startup prewarm and first-round share entry.
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  const activeTargetPath = normalizePreturnTargetPath(context, options.targetPath);
  const cacheKey = JSON.stringify({
    mode: resolvedMode,
    executionCwd: normalizeCachePath(context.executionCwd),
    gitRoot: normalizeCachePath(context.gitRoot),
    targetPath: activeTargetPath ?? '',
  });
  const now = Date.now();
  prunePreturnBundleCache(now);
  const cached = preturnBundleCache.get(cacheKey);
  if (cached) {
    if (cached.pending) {
      return cached.promise;
    }
    if (cached.expiresAt > now) {
      return cached.promise;
    }
  }

  let entry: PreturnBundleCacheEntry;
  const promise = fetchRepoPreturnBundleInner(context, options).then((result) => {
    entry.pending = false;
    entry.expiresAt = Date.now() + ROUTING_SIGNALS_CACHE_TTL_MS;
    return result;
  }).catch((error) => {
    preturnBundleCache.delete(cacheKey);
    throw error;
  });

  entry = {
    pending: true,
    expiresAt: Number.POSITIVE_INFINITY,
    promise,
  };
  preturnBundleCache.set(cacheKey, entry);
  prunePreturnBundleCache(now);
  return promise;
}

async function fetchRepoPreturnBundleInner(
  context: RepoContext,
  options: {
    targetPath?: string;
    refresh?: boolean;
    mode?: KodaXRepoIntelligenceMode;
  } = {},
): Promise<RepoPreturnBundleResult> {
  const resolvedMode = resolveRepoIntelligenceMode(options.mode);
  if (resolvedMode === 'off') {
    const capability = buildWorkerCapability(resolvedMode, 'unavailable', limitedWarnings('preturn bundle'));
    return {
      routingSignals: buildLimitedRoutingSignals(context, capability),
      moduleContext: options.targetPath
        ? buildLimitedModuleContext(context, capability, options.targetPath)
        : undefined,
      impactEstimate: options.targetPath
        ? buildLimitedImpactEstimate(capability, options)
        : undefined,
      summary: 'Repo intelligence is disabled.',
      lowConfidence: true,
      capability,
    };
  }
  if (isFullRepoIntelligenceMode(resolvedMode)) {
    const full = await tryFullPreturn(context, options);
    if (full) {
      return {
        routingSignals: full.bundle.routingSignals
          ? attachRepoIntelligenceMeta(
            full.bundle.routingSignals,
            full.capability,
            full.trace,
          )
          : undefined,
        moduleContext: full.bundle.moduleContext
          ? attachRepoIntelligenceMeta(
            full.bundle.moduleContext,
            full.capability,
            full.trace,
          )
          : undefined,
        impactEstimate: full.bundle.impactEstimate
          ? attachRepoIntelligenceMeta(
            full.bundle.impactEstimate,
            full.capability,
            full.trace,
          )
          : undefined,
        repoContext: full.bundle.repoContext,
        summary: full.bundle.summary,
        recommendedFiles: full.bundle.recommendedFiles,
        lowConfidence: full.bundle.lowConfidence,
        capability: full.capability,
        trace: full.trace,
      };
    }
  }

  const activeTargetPath = options.targetPath ?? (context.executionCwd ? '.' : undefined);
  const [routingSignals, moduleContext, impactEstimate, repoContext] = await Promise.all([
    getRepoRoutingSignals(context, { targetPath: options.targetPath, refresh: options.refresh, mode: 'light' }),
    activeTargetPath
      ? getModuleContext(context, { targetPath: activeTargetPath, refresh: options.refresh, mode: 'light' }).catch(() => undefined)
      : Promise.resolve(undefined),
    activeTargetPath
      ? getImpactEstimate(context, { targetPath: activeTargetPath, refresh: options.refresh, mode: 'light' }).catch(() => undefined)
      : Promise.resolve(undefined),
    buildBaselineRepoIntelligenceContext(context, {
      includeRepoOverview: true,
      includeChangedScope: true,
      refreshOverview: options.refresh,
      changedScope: 'all',
      targetPath: options.targetPath,
    }).catch(() => ''),
  ]);

  const capability = buildWorkerCapability('light', resolvedMode === 'full' ? 'limited' : 'ok', resolvedMode === 'full'
    ? ['Full repo intelligence unavailable; used worker-isolated light context.']
    : []);
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

/**
 * v0.7.41 L2 - best-effort warm both session-level caches (routing signals +
 * preturn bundle) for a given workspace. Designed to be called fire-and-forget
 * at REPL startup so the first user prompt finds the in-process caches warm.
 *
 * Why this works (and why M1's `refresh:true` design did NOT):
 *   - Uses `refresh: false` so the built-in engine can reuse its warm cache.
 *     Total warm preturn work is normally sub-second once the index exists.
 *   - Incremental cache identity keeps state fresh enough for startup prewarm;
 *     we don't force a cold refresh on every REPL startup.
 *   - If user submits BEFORE prewarm completes, P2 in-flight Promise sharing
 *     coalesces both calls onto the same full-engine work. The user avoids
 *     paying a second cold refresh.
 *   - If user submits AFTER prewarm completes, P3+ session cache (60s TTL)
 *     serves the result in ~0ms.
 *   - The middleware/first-round path (L1) also uses `refresh:false`, so
 *     prewarm and user-path are cache-coherent - the user-path call genuinely
 *     hits the warmed entry instead of being forced to bypass it.
 *
 * Failure modes:
 *   - All calls `.catch(() => {})` - prewarm is best-effort. If full mode
 *     fails, the first prompt falls back to light mode as before.
 *   - `off` mode short-circuits - no work at all when repo intelligence
 *     is disabled.
 */
export function prewarmRepoIntelligenceCaches(
  context: RepoContext,
  options: { mode?: KodaXRepoIntelligenceMode } = {},
): void {
  if (process.env.KODAX_PREWARM_REPO_INTELLIGENCE === REPO_INTELLIGENCE_PREWARM_DISABLED) {
    return;
  }
  const resolved = resolveKodaXAutoRepoMode(options.mode);
  if (resolved === 'off') {
    return;
  }
  if (!context.executionCwd && !context.gitRoot) {
    return;
  }
  if (resolved !== 'full') {
    return;
  }

  // Fire-and-forget - caller does not await.
  const timer = setTimeout(() => {
    const prewarmOptions = {
      mode: options.mode,
      refresh: false,
      targetPath: '.',
    };
    // Populate both public caches while their shared full-engine request is
    // in flight. Otherwise routing repeats the work after the inner 1.5s TTL,
    // even though the complete prewarmed bundle remains fresh for 60s.
    void Promise.all([
      getRepoPreturnBundle(context, prewarmOptions),
      getRepoRoutingSignals(context, prewarmOptions),
    ]).catch(() => {});
  }, REPO_INTELLIGENCE_PREWARM_DELAY_MS);
  if (typeof timer === 'object' && typeof timer.unref === 'function') {
    timer.unref();
  }
}
