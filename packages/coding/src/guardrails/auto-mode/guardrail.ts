/**
 * AutoModeToolGuardrail — FEATURE_092 Phase 2b.6 (v0.7.33).
 *
 * Assembles the auto-mode classifier modules (rules + projection +
 * classify + denial-tracker + circuit-breaker + model-resolver) into a
 * `ToolGuardrail` that the Runner calls via `beforeTool` on every
 * tool invocation.
 *
 * Decision flow (per design doc "三层权限金字塔"):
 *
 *   1. Tool projection is '' (Tier 1)        → allow (zero token cost)
 *   2. Engine has been downgraded to rules   → escalate (user confirms)
 *   3. denialTracker.shouldFallback (3/20)   → engine downgrade, then escalate
 *   4. circuitBreaker.shouldFallback (5/10m) → engine downgrade, then escalate
 *   5. classify(...) sideQuery
 *        allow                               → allow (record allow → reset consecutive)
 *        block                               → block + reason (record block)
 *        escalate                            → escalate + reason (record error)
 *        AbortError thrown                   → re-throw (propagate user cancel)
 *
 * State (mutable, session-scoped):
 *   - engine: 'llm' | 'rules' (starts at 'llm', downgrades on threshold)
 *   - denialTracker (immutable type, swapped on each event)
 *   - circuitBreaker (immutable type, swapped on each event)
 *
 * Subagent sharing:
 *   The factory accepts an optional `sharedState` ref; passing the same ref
 *   to a subagent's guardrail means denial / circuit / engine state is
 *   shared (per design doc "防绕阈值"). Without it each guardrail is
 *   independent.
 *
 * Capability check, Tier 2 path-shortcuts, and the explicit
 * `supportsAutoModeClassifier` provider flag are deferred to follow-up
 * phases — v1 of the guardrail relies on Tier 1 (projection==='') as the
 * structural opt-out and forwards everything else to the classifier.
 */

import type { CostTracker, KodaXBaseProvider } from '@kodax/ai';
import type {
  GuardrailContext,
  GuardrailVerdict,
  RunnerToolCall,
  ToolGuardrail,
} from '@kodax/core';

import { classify, type ClassifyDecision } from './classify.js';
import {
  createCircuitBreaker,
  recordError as recordBreakerError,
  shouldFallback as breakerShouldFallback,
  type CircuitBreaker,
} from './circuit-breaker.js';
import {
  createDenialTracker,
  recordAllow as recordDenialAllow,
  recordBlock as recordDenialBlock,
  shouldFallback as denialShouldFallback,
  type DenialTracker,
} from './denial-tracker.js';
import {
  resolveClassifierModel,
  type ResolveClassifierModelOptions,
} from './model-resolver.js';
import type { AutoRules } from './rules.js';

export type AutoModeEngine = 'llm' | 'rules';

export interface AutoModeSharedState {
  engine: AutoModeEngine;
  denials: DenialTracker;
  breaker: CircuitBreaker;
}

export interface AutoModeGuardrailConfig {
  readonly rules: AutoRules;
  readonly claudeMd?: string;

  /**
   * Look up a tool's `toClassifierInput` projection by tool name.
   * Returns `undefined` when the tool isn't in the registry — guardrail
   * treats that as "no projection ⇒ Tier 1 skip" (conservative for
   * unknown tools is debatable; v1 favors not blocking on noise).
   */
  readonly getToolProjection: (
    toolName: string,
  ) => ((input: unknown) => string) | undefined;

  /**
   * Resolve a provider name to an instance. Returns `undefined` when
   * unconfigured / unknown — the guardrail then escalates.
   */
  readonly resolveProvider: (providerName: string) => KodaXBaseProvider | undefined;

  readonly defaultProvider: string;
  readonly defaultModel: string;

  // Override layers consumed by `resolveClassifierModel`
  readonly cliFlag?: string;
  readonly envVar?: string;
  readonly sessionOverride?: string;
  readonly userSettings?: string;

  /**
   * Optional cost-tracker accessors. The classifier writes its tokens to
   * the tracker under `querySource: 'auto_mode'` (handled inside sideQuery).
   */
  readonly getCostTracker?: () => CostTracker | undefined;
  readonly setCostTracker?: (t: CostTracker) => void;

  /** Optional logger for engine-downgrade and config warnings. */
  readonly log?: (level: 'info' | 'warn', msg: string) => void;

  /**
   * Optional shared state for subagent threshold-bypass defense
   * (design doc "防绕阈值"). When supplied, the parent and child
   * guardrails reference the SAME object — engine downgrades and
   * tracker advances are visible across the session boundary.
   */
  readonly sharedState?: AutoModeSharedState;
}

export interface AutoModeToolGuardrail extends ToolGuardrail {
  /**
   * Test-only accessor: peek at the current engine. Production callers
   * should treat this state as opaque.
   */
  getEngineForTest(): AutoModeEngine;
  getStatsForTest(): {
    readonly engine: AutoModeEngine;
    readonly denials: DenialTracker;
    readonly breaker: CircuitBreaker;
  };
  /** Test-only override: swap the provider mid-test (for downgrade scenarios). */
  setProviderForTest(provider: KodaXBaseProvider): void;
}

const TIMEOUT_MS = 8000;

export function createAutoModeToolGuardrail(
  config: AutoModeGuardrailConfig,
): AutoModeToolGuardrail {
  const state: AutoModeSharedState = config.sharedState ?? {
    engine: 'llm',
    denials: createDenialTracker(),
    breaker: createCircuitBreaker(),
  };

  // For tests only: lets us swap the provider mid-flight to verify downgrade.
  let providerOverride: KodaXBaseProvider | undefined;

  const beforeTool = async (
    call: RunnerToolCall,
    ctx: GuardrailContext,
  ): Promise<GuardrailVerdict> => {
    // Tier 1: tool opted out of classifier via empty projection
    const projector = config.getToolProjection(call.name);
    const action = projector ? projector(call.input) : '';
    if (action === '') {
      return { action: 'allow' };
    }

    // Engine has previously downgraded — rules-engine behavior is
    // "Tier 1/2 allow, else escalate to user"; v1 doesn't yet implement
    // Tier 2 path-shortcuts so all non-Tier-1 calls escalate.
    if (state.engine === 'rules') {
      return {
        action: 'escalate',
        reason: 'auto-mode engine is in rules mode (downgraded); user confirmation required',
      };
    }

    // Threshold checks — engine downgrade BEFORE making another classify call
    if (denialShouldFallback(state.denials)) {
      state.engine = 'rules';
      config.log?.('warn', '[auto-mode] denial threshold crossed — engine downgraded to rules');
      return {
        action: 'escalate',
        reason: 'auto-mode engine downgraded after consecutive denials; user confirmation required',
      };
    }
    if (breakerShouldFallback(state.breaker, Date.now())) {
      state.engine = 'rules';
      config.log?.('warn', '[auto-mode] circuit breaker tripped — engine downgraded to rules');
      return {
        action: 'escalate',
        reason: 'classifier infrastructure unstable; engine downgraded',
      };
    }

    // Resolve which (provider, model) the classifier should use this call
    const resolved = resolveClassifierModel(buildResolveOptions(config));
    const provider = providerOverride ?? config.resolveProvider(resolved.providerName);
    if (!provider) {
      return {
        action: 'escalate',
        reason: `classifier provider "${resolved.providerName}" is not configured`,
      };
    }

    // Run the classifier. AbortError propagates to caller; we don't capture it.
    let decision: ClassifyDecision;
    try {
      decision = await classify({
        provider,
        model: resolved.model,
        rules: config.rules,
        claudeMd: config.claudeMd,
        transcript: ctx.messages ?? [],
        action,
        timeoutMs: TIMEOUT_MS,
        abortSignal: ctx.abortSignal,
        costTracker: config.getCostTracker?.(),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      // Any other error gets routed through the breaker
      state.breaker = recordBreakerError(state.breaker, Date.now());
      return {
        action: 'escalate',
        reason: `classifier error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Map decision → verdict + update tracker / breaker.
    // After recording, immediately re-check thresholds so the engine
    // downgrades on the SAME call that crosses the line, not the next one.
    switch (decision.kind) {
      case 'allow':
        state.denials = recordDenialAllow(state.denials);
        return { action: 'allow' };

      case 'block':
        state.denials = recordDenialBlock(state.denials);
        if (denialShouldFallback(state.denials)) {
          state.engine = 'rules';
          config.log?.('warn', '[auto-mode] denial threshold crossed — engine downgraded to rules');
        }
        return { action: 'block', reason: decision.reason };

      case 'escalate':
        state.breaker = recordBreakerError(state.breaker, Date.now());
        if (breakerShouldFallback(state.breaker, Date.now())) {
          state.engine = 'rules';
          config.log?.('warn', '[auto-mode] circuit breaker tripped — engine downgraded to rules');
        }
        return { action: 'escalate', reason: decision.reason };
    }
  };

  return {
    kind: 'tool',
    name: 'auto-mode',
    beforeTool,
    getEngineForTest: () => state.engine,
    getStatsForTest: () => ({
      engine: state.engine,
      denials: state.denials,
      breaker: state.breaker,
    }),
    setProviderForTest: (p) => { providerOverride = p; },
  };
}

function buildResolveOptions(
  config: AutoModeGuardrailConfig,
): ResolveClassifierModelOptions {
  return {
    cliFlag: config.cliFlag,
    envVar: config.envVar,
    sessionOverride: config.sessionOverride,
    userSettings: config.userSettings,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
  };
}
