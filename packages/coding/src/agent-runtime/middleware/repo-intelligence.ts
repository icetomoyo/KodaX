/**
 * Repository intelligence context middleware — CAP-001
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-001-repointelligencecontext-injection
 *
 * Builds a composed `repoIntelligenceContext` string injected into the
 * system-prompt before each provider call. The composition has up to five
 * sections (in priority order):
 *
 *   1. caller-supplied `options.context.repoIntelligenceContext` passthrough
 *   2. current `generatedContext` from `buildRepoIntelligenceContext`
 *      (Repository Overview + Changed Scope, gated by the decision flags),
 *      falling back to the bundle's baseline context if unavailable
 *   3. `moduleContext` from `getModuleContext` + `renderModuleContext`
 *      (review/bugfix/edit/refactor task types)
 *   4. `impactContext` from `getImpactEstimate` + `renderImpactEstimate`
 *   5. `fallbackGuidance` when module/impact confidence < 0.72 OR neither
 *      resolved (suggests using `module_context` / `symbol_context` /
 *      `grep` / `read` for validation)
 *
 * **Best-effort contract**: the outer `try/catch` swallows ANY error and
 * falls back to the caller-supplied context. This is deliberate — repo-intel
 * is observability, not core functionality, and a stale repo-intel must
 * never block a run. Inner per-API calls also `.catch(() => null)` so a
 * single-API failure doesn't poison the bundle.
 *
 * **Decision rules** (verified from baseline agent.ts:2946-2956):
 *   - `includeRepoOverview = isNewSession || primaryTask === 'plan' ||`
 *     `harnessProfile !== 'H0_DIRECT' || complexity !== 'simple'`
 *   - `includeChangedScope = primaryTask in {review, bugfix, edit, refactor}`
 *   - `includeActiveModule = primaryTask in {review, bugfix, edit, refactor}`
 *
 * Time-ordering: must build BEFORE first provider call (via
 * `currentExecution`); AFTER session loader; idempotent enough to run every
 * turn (intermediate caching is the underlying repo-intel APIs' job).
 *
 * `emitRepoIntelligenceTrace` and `shouldEmitRepoIntelligenceTrace` are
 * colocated here because they are exclusively repo-intel observability
 * helpers — they live with the data they trace. agent.ts imports them
 * back for the 'routing' stage emission at frame entry.
 *
 * Migration history: `buildAutoRepoIntelligenceContext` extracted from
 * `agent.ts:2934-3064`, `emitRepoIntelligenceTrace` from `agent.ts:176-190`,
 * `shouldEmitRepoIntelligenceTrace` from `agent.ts:171-174` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P2.
 */

import {
  type KodaXEvents,
  type KodaXOptions,
  type KodaXRepoIntelligenceCarrier,
} from '../../types.js';
import { buildRepoIntelligenceContext } from '../../repo-intelligence/index.js';
import {
  getImpactEstimate,
  getModuleContext,
  getRepoPreturnBundle,
  resolveKodaXAutoRepoMode,
  resolveKodaXHotPathRepoMode,
} from '../../repo-intelligence/runtime.js';
import {
  renderImpactEstimate,
  renderModuleContext,
} from '../../repo-intelligence/semantic-render.js';
import { createRepoIntelligenceTraceEvent } from '../../repo-intelligence/trace-events.js';
import type { ReasoningPlan } from '../../reasoning.js';

const AUTO_CONTEXT_REPO_INTELLIGENCE_BUDGET_MS = 2_000;
const AUTO_CONTEXT_PRETURN_STATE_TTL_MS = 60_000;
const MAX_AUTO_CONTEXT_PRETURN_STATES = 64;
type AutoPreturnResult = Awaited<ReturnType<typeof getRepoPreturnBundle>>;

interface BudgetedRepoIntelligenceResult<T> {
  value: T | null;
  timedOut: boolean;
}

interface AutoContextPreturnState {
  promise: Promise<AutoPreturnResult | null>;
  budgetMissed: boolean;
  settled: boolean;
  expiresAt: number;
}

interface AutoContextPreturnKeyContext {
  executionCwd?: string;
  gitRoot?: string;
}

const autoContextPreturnStates = new Map<string, AutoContextPreturnState>();

async function settleWithinAutoContextBudget<T>(
  promise: Promise<T | null>,
): Promise<BudgetedRepoIntelligenceResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BudgetedRepoIntelligenceResult<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ value: null, timedOut: true });
    }, AUTO_CONTEXT_REPO_INTELLIGENCE_BUDGET_MS);
    if (typeof timer === 'object' && typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  try {
    return await Promise.race([
      promise.then((value): BudgetedRepoIntelligenceResult<T> => ({ value, timedOut: false })),
      timeout,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function pruneAutoContextPreturnStates(now = Date.now()): void {
  for (const [key, state] of autoContextPreturnStates.entries()) {
    if (state.settled && state.expiresAt <= now) {
      autoContextPreturnStates.delete(key);
    }
  }

  if (autoContextPreturnStates.size <= MAX_AUTO_CONTEXT_PRETURN_STATES) {
    return;
  }

  const keys = Array.from(autoContextPreturnStates.keys());
  for (const key of keys.slice(0, autoContextPreturnStates.size - MAX_AUTO_CONTEXT_PRETURN_STATES)) {
    autoContextPreturnStates.delete(key);
  }
}

function autoContextPreturnKey(
  repoContext: AutoContextPreturnKeyContext,
  mode: string,
  targetPath: string | undefined,
): string {
  return JSON.stringify({
    executionCwd: repoContext.executionCwd ?? '',
    gitRoot: repoContext.gitRoot ?? '',
    mode,
    targetPath: targetPath ?? '',
  });
}

function getAutoContextPreturnState(
  key: string,
  load: () => Promise<AutoPreturnResult | null>,
): AutoContextPreturnState {
  const now = Date.now();
  pruneAutoContextPreturnStates(now);
  const cached = autoContextPreturnStates.get(key);
  if (cached && (!cached.settled || cached.expiresAt > now)) {
    return cached;
  }

  let state: AutoContextPreturnState;
  const promise = load()
    .catch(() => null)
    .finally(() => {
      state.settled = true;
      state.expiresAt = Date.now() + AUTO_CONTEXT_PRETURN_STATE_TTL_MS;
    });
  state = {
    promise,
    budgetMissed: false,
    settled: false,
    expiresAt: Number.POSITIVE_INFINITY,
  };
  autoContextPreturnStates.set(key, state);
  pruneAutoContextPreturnStates(now);
  return state;
}

async function settleAutoContextPreturn(
  state: AutoContextPreturnState,
): Promise<BudgetedRepoIntelligenceResult<AutoPreturnResult>> {
  if (state.budgetMissed && !state.settled) {
    return { value: null, timedOut: true };
  }
  const result = await settleWithinAutoContextBudget(state.promise);
  if (result.timedOut) {
    state.budgetMissed = true;
  }
  return result;
}

export function shouldEmitRepoIntelligenceTrace(options: KodaXOptions): boolean {
  return options.context?.repoIntelligenceTrace === true
    || process.env.KODAX_REPO_INTELLIGENCE_TRACE === '1';
}

export function emitRepoIntelligenceTrace(
  events: KodaXEvents | undefined,
  options: KodaXOptions,
  stage: 'routing' | 'preturn' | 'module' | 'impact',
  carrier: KodaXRepoIntelligenceCarrier | null | undefined,
  detail?: string,
): void {
  if (!events?.onRepoIntelligenceTrace || !shouldEmitRepoIntelligenceTrace(options) || !carrier) {
    return;
  }
  const traceEvent = createRepoIntelligenceTraceEvent(stage, carrier, detail);
  if (traceEvent) {
    events.onRepoIntelligenceTrace(traceEvent);
  }
}

export async function buildAutoRepoIntelligenceContext(
  options: KodaXOptions,
  reasoningPlan: ReasoningPlan,
  isNewSession: boolean,
  events?: KodaXEvents,
): Promise<string | undefined> {
  const autoRepoMode = resolveKodaXAutoRepoMode(options.context?.repoIntelligenceMode);
  if (autoRepoMode === 'off') {
    return options.context?.repoIntelligenceContext;
  }
  const hotPathRepoMode = resolveKodaXHotPathRepoMode(options.context?.repoIntelligenceMode);

  const decision = reasoningPlan.decision;
  // Repo-overview gate. The old `harnessProfile !== 'H0_DIRECT'` clause is
  // dropped: after the harness-LLM-judgment refactor `decision.harnessProfile`
  // collapsed to a constant 'H0_DIRECT', so that clause was always false and
  // contributed nothing. The gate now keys on the still-meaningful signals
  // (new session / planning task / non-simple complexity).
  const includeRepoOverview =
    isNewSession
    || decision.primaryTask === 'plan'
    || decision.complexity !== 'simple';
  const includeChangedScope =
    decision.primaryTask === 'review'
    || decision.primaryTask === 'bugfix'
    || decision.primaryTask === 'edit'
    || decision.primaryTask === 'refactor';

  if (!includeRepoOverview && !includeChangedScope) {
    return options.context?.repoIntelligenceContext;
  }

  try {
    const activeModuleTargetPath = options.context?.executionCwd ? '.' : undefined;
    const repoContext = {
      executionCwd: options.context?.executionCwd,
      gitRoot: options.context?.gitRoot ?? undefined,
    };
    const includeActiveModule =
      decision.primaryTask === 'review'
      || decision.primaryTask === 'bugfix'
      || decision.primaryTask === 'edit'
      || decision.primaryTask === 'refactor';

    // First-round preturn stays best-effort and never forces refresh. The
    // worker-isolated engine can reuse a warm cache, while explicit tool
    // calls can still request refresh and wait for high-fidelity results.
    // Automatic prompt injection has a short budget so a cold semantic index
    // cannot delay the first model request; the worker promise continues in
    // the background and warms the shared repo-intelligence cache.
    //
    // P1.a — Phase 1: OSS overview build and full preturn fetch run in
    // parallel (both local, with independent caches).
    // Behavioural pins preserved:
    //   - preturn is only attempted when `includeActiveModule && full mode`
    //   - `.catch(() => null)` keeps a failed preturn from poisoning the build
    //   - emit order: preturn → module → impact
    const useFullPreturn = hotPathRepoMode === 'full';
    const preturnBudgetPromise = includeActiveModule && useFullPreturn
      ? settleAutoContextPreturn(getAutoContextPreturnState(
        autoContextPreturnKey(repoContext, hotPathRepoMode, activeModuleTargetPath),
        () => getRepoPreturnBundle(repoContext, {
          targetPath: activeModuleTargetPath,
          refresh: false,
          mode: hotPathRepoMode,
        }),
      ))
      : Promise.resolve({ value: null, timedOut: false });
    const overviewBudgetPromise = settleWithinAutoContextBudget(
      buildRepoIntelligenceContext({
        executionCwd: options.context?.executionCwd,
        gitRoot: options.context?.gitRoot ?? undefined,
      }, {
        includeRepoOverview,
        includeChangedScope,
        refreshOverview: false,
        changedScope: 'all',
      }).catch(() => null),
    );
    const [overviewBudget, preturnBudget] = await Promise.all([
      overviewBudgetPromise,
      preturnBudgetPromise,
    ]);
    const generatedContext = overviewBudget.value ?? '';
    const preturn = preturnBudget.value;

    let moduleContext = '';
    let impactContext = '';
    let fallbackGuidance = '';
    let bundledRepoContext = '';
    let repoIntelligenceBudgetTimedOut = overviewBudget.timedOut || preturnBudget.timedOut;

    let moduleResult: Awaited<ReturnType<typeof getModuleContext>> | null = null;
    let impactResult: Awaited<ReturnType<typeof getImpactEstimate>> | null = null;

    if (preturn) {
      emitRepoIntelligenceTrace(events, options, 'preturn', preturn, preturn.summary);
      moduleResult = preturn.moduleContext ?? null;
      impactResult = preturn.impactEstimate ?? null;
      bundledRepoContext = preturn.repoContext ?? '';
    }

    if (includeActiveModule) {
      // v0.7.41 P1.a — Phase 2: module/impact direct-call fallbacks only fire
      // for slots NOT already filled by the preturn bundle (preserves the
      // pre-refactor `??` short-circuit — if preturn populated moduleResult,
      // we still skip the getModuleContext call). When both are missing they
      // race in parallel instead of running sequentially.
      const allowDirectFallback = !repoIntelligenceBudgetTimedOut;
      const [moduleFallback, impactFallback] = await Promise.all([
        allowDirectFallback && !moduleResult
          ? settleWithinAutoContextBudget(getModuleContext(repoContext, {
            targetPath: activeModuleTargetPath,
            refresh: false,
            mode: hotPathRepoMode,
          }).catch(() => null)).then((result) => {
            repoIntelligenceBudgetTimedOut = repoIntelligenceBudgetTimedOut || result.timedOut;
            return result.value;
          })
          : Promise.resolve(null),
        allowDirectFallback && !impactResult
          ? settleWithinAutoContextBudget(getImpactEstimate(repoContext, {
            targetPath: activeModuleTargetPath,
            refresh: false,
            mode: hotPathRepoMode,
          }).catch(() => null)).then((result) => {
            repoIntelligenceBudgetTimedOut = repoIntelligenceBudgetTimedOut || result.timedOut;
            return result.value;
          })
          : Promise.resolve(null),
      ]);
      moduleResult = moduleResult ?? moduleFallback;
      impactResult = impactResult ?? impactFallback;

      if (moduleResult) {
        emitRepoIntelligenceTrace(
          events,
          options,
          'module',
          moduleResult,
          `module=${moduleResult.module.moduleId}`,
        );
        moduleContext = ['## Active Module Intelligence', renderModuleContext(moduleResult)].join('\n');
      }

      if (impactResult) {
        emitRepoIntelligenceTrace(
          events,
          options,
          'impact',
          impactResult,
          `target=${impactResult.target.label}`,
        );
        impactContext = ['## Active Impact Intelligence', renderImpactEstimate(impactResult)].join('\n');
      }

      const lowConfidence =
        (moduleResult?.confidence ?? 1) < 0.72
        || (impactResult?.confidence ?? 1) < 0.72;
      if (!repoIntelligenceBudgetTimedOut && (lowConfidence || (!moduleResult && !impactResult))) {
        fallbackGuidance = [
          '## Repo Intelligence Guidance',
          '- Current repository intelligence is low-confidence for this area.',
          '- Validate critical edits with `module_context`, `symbol_context`, `grep`, and `read` before committing to a change.',
        ].join('\n');
      }
    }

    return [
      options.context?.repoIntelligenceContext,
      // The bundle contains the same baseline overview/scope renderer, not
      // additional semantic evidence. Prefer this request's current snapshot
      // over its cached copy; keep the bundle as a best-effort fallback.
      generatedContext || bundledRepoContext,
      moduleContext,
      impactContext,
      fallbackGuidance,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n');
  } catch {
    return options.context?.repoIntelligenceContext;
  }
}
