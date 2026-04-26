/**
 * Repository intelligence context middleware — CAP-001
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-001-repointelligencecontext-injection
 *
 * Builds a composed `repoIntelligenceContext` string injected into the
 * system-prompt before each provider call. The composition has up to six
 * sections (in priority order):
 *
 *   1. caller-supplied `options.context.repoIntelligenceContext` passthrough
 *   2. `premiumContext` from `getRepoPreturnBundle` (only `premium-native`
 *      mode + active-module conditions)
 *   3. `generatedContext` from `buildRepoIntelligenceContext` (Repository
 *      Overview + Changed Scope, gated by `includeRepoOverview` /
 *      `includeChangedScope` decision flags)
 *   4. `moduleContext` from `getModuleContext` + `renderModuleContext`
 *      (review/bugfix/edit/refactor task types)
 *   5. `impactContext` from `getImpactEstimate` + `renderImpactEstimate`
 *   6. `fallbackGuidance` when module/impact confidence < 0.72 OR neither
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
} from '../../repo-intelligence/runtime.js';
import {
  renderImpactEstimate,
  renderModuleContext,
} from '../../repo-intelligence/query.js';
import { createRepoIntelligenceTraceEvent } from '../../repo-intelligence/trace-events.js';
import type { ReasoningPlan } from '../../reasoning.js';

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

  const decision = reasoningPlan.decision;
  const includeRepoOverview =
    isNewSession
    || decision.primaryTask === 'plan'
    || decision.harnessProfile !== 'H0_DIRECT'
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
    const generatedContext = await buildRepoIntelligenceContext({
      executionCwd: options.context?.executionCwd,
      gitRoot: options.context?.gitRoot ?? undefined,
    }, {
      includeRepoOverview,
      includeChangedScope,
      refreshOverview: isNewSession,
      changedScope: 'all',
    });

    const includeActiveModule =
      decision.primaryTask === 'review'
      || decision.primaryTask === 'bugfix'
      || decision.primaryTask === 'edit'
      || decision.primaryTask === 'refactor';
    let moduleContext = '';
    let impactContext = '';
    let fallbackGuidance = '';
    let premiumContext = '';

    let moduleResult: Awaited<ReturnType<typeof getModuleContext>> | null = null;
    let impactResult: Awaited<ReturnType<typeof getImpactEstimate>> | null = null;

    if (includeActiveModule && autoRepoMode === 'premium-native') {
      const preturn = await getRepoPreturnBundle(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: isNewSession,
        mode: autoRepoMode,
      }).catch(() => null);
      if (preturn) {
        emitRepoIntelligenceTrace(events, options, 'preturn', preturn, preturn.summary);
        moduleResult = preturn.moduleContext ?? null;
        impactResult = preturn.impactEstimate ?? null;
        premiumContext = preturn.repoContext ?? '';
      }
    }

    if (includeActiveModule) {
      moduleResult = moduleResult ?? await getModuleContext(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: isNewSession,
        mode: autoRepoMode,
      }).catch(() => null);

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

      impactResult = impactResult ?? await getImpactEstimate(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: isNewSession,
        mode: autoRepoMode,
      }).catch(() => null);

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
      if (lowConfidence || (!moduleResult && !impactResult)) {
        fallbackGuidance = [
          '## Repo Intelligence Guidance',
          '- Current repository intelligence is low-confidence for this area.',
          '- Validate critical edits with `module_context`, `symbol_context`, `grep`, and `read` before committing to a change.',
        ].join('\n');
      }
    }

    return [
      options.context?.repoIntelligenceContext,
      premiumContext,
      generatedContext,
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
