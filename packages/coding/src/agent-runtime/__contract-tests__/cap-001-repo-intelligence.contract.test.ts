/**
 * Contract test for CAP-001: repoIntelligenceContext injection
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-001-repointelligencecontext-injection
 *
 * Test obligations:
 * - CAP-REPO-INTEL-001: overview + scope decision matrix (includeRepoOverview /
 *   includeChangedScope flags); active here as the decision-matrix
 *   short-circuit cases — when both flags are false, the function MUST
 *   return the caller-supplied context without invoking any repo-intel API.
 * - CAP-REPO-INTEL-OFF: `autoRepoMode === 'off'` short-circuit returns the
 *   caller-supplied context (no repo-intel API invocation).
 * - CAP-REPO-INTEL-TRACE-001: `emitRepoIntelligenceTrace` is gated by
 *   `events.onRepoIntelligenceTrace` AND
 *   (`options.context.repoIntelligenceTrace` OR
 *    `KODAX_REPO_INTELLIGENCE_TRACE === '1'`).
 *
 * Deferred (require fs / git mocking — out of P2 scope):
 * - CAP-REPO-INTEL-002: premium-native bundle path (full integration of
 *   `getRepoPreturnBundle` requires repo-intel runtime mocks).
 * - CAP-REPO-INTEL-003: low-confidence fallback guidance (requires
 *   getModuleContext / getImpactEstimate mocks).
 * - CAP-REPO-INTEL-004: best-effort try/catch (requires forcing the
 *   underlying APIs to throw; integration test territory).
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:317, :444, :4241-4263`
 * parity-restore evidence: "the Runner-driven path (FEATURE_084 Shard 6d-L)
 * routed around `runKodaX`, so the injection was dropped"
 *
 * Verified location: agent-runtime/middleware/repo-intelligence.ts (extracted
 * from agent.ts:2934-3064 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * STATUS: ACTIVE since FEATURE_100 P2 for the short-circuit and trace-gating
 * obligations. Deeper API-integration tests stay `it.todo` with explicit
 * deferral notes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KodaXEvents, KodaXOptions } from '../../types.js';
import type { ReasoningPlan } from '../../reasoning.js';
import {
  buildAutoRepoIntelligenceContext,
  emitRepoIntelligenceTrace,
  shouldEmitRepoIntelligenceTrace,
} from '../middleware/repo-intelligence.js';

function makeReasoningPlan(overrides: Partial<ReasoningPlan['decision']> = {}): ReasoningPlan {
  // Cast through `unknown` — only the fields read by buildAutoRepoIntelligenceContext
  // are populated; full KodaXTaskRoutingDecision shape isn't needed for this contract.
  return {
    decision: {
      primaryTask: 'unknown',
      harnessProfile: 'H0_DIRECT',
      complexity: 'simple',
      ...overrides,
    },
  } as unknown as ReasoningPlan;
}

describe('CAP-001: repoIntelligenceContext injection contract', () => {
  const originalEnv = process.env.KODAX_REPO_INTELLIGENCE_TRACE;

  beforeEach(() => {
    delete process.env.KODAX_REPO_INTELLIGENCE_TRACE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.KODAX_REPO_INTELLIGENCE_TRACE;
    } else {
      process.env.KODAX_REPO_INTELLIGENCE_TRACE = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('CAP-REPO-INTEL-OFF: when repoIntelligenceMode=off, returns caller-supplied context unchanged (no repo-intel API invoked)', async () => {
    const callerCtx = '## Caller-Provided\nbaseline content';
    const options = {
      context: {
        repoIntelligenceMode: 'off',
        repoIntelligenceContext: callerCtx,
      },
    } as KodaXOptions;

    const result = await buildAutoRepoIntelligenceContext(
      options,
      makeReasoningPlan({ primaryTask: 'plan' }),
      true,
    );

    expect(result).toBe(callerCtx);
  });

  it('CAP-REPO-INTEL-001: when both includeRepoOverview AND includeChangedScope are false, returns passthrough (early-return)', async () => {
    // To make BOTH flags false:
    //   - includeRepoOverview = isNewSession || primaryTask=plan || harnessProfile≠H0_DIRECT || complexity≠simple
    //     → all four must be false → !isNewSession && primaryTask≠plan && harnessProfile=H0_DIRECT && complexity=simple
    //   - includeChangedScope = primaryTask in {review,bugfix,edit,refactor}
    //     → primaryTask must be NONE of those
    //   - 'unknown' primaryTask satisfies both negations
    const callerCtx = '## Caller-Provided';
    const options = {
      context: { repoIntelligenceContext: callerCtx },
    } as KodaXOptions;

    const result = await buildAutoRepoIntelligenceContext(
      options,
      makeReasoningPlan({
        primaryTask: 'unknown',
        harnessProfile: 'H0_DIRECT',
        complexity: 'simple',
      }),
      false, // !isNewSession
    );

    expect(result).toBe(callerCtx);
  });

  it('CAP-REPO-INTEL-001b: returns undefined passthrough when caller-supplied context is also undefined and decision matrix short-circuits', async () => {
    const options = { context: {} } as KodaXOptions;
    const result = await buildAutoRepoIntelligenceContext(
      options,
      makeReasoningPlan({
        primaryTask: 'unknown',
        harnessProfile: 'H0_DIRECT',
        complexity: 'simple',
      }),
      false,
    );

    expect(result).toBeUndefined();
  });

  it('CAP-REPO-INTEL-TRACE-GATE: shouldEmitRepoIntelligenceTrace is true when context.repoIntelligenceTrace=true', () => {
    const options = { context: { repoIntelligenceTrace: true } } as KodaXOptions;
    expect(shouldEmitRepoIntelligenceTrace(options)).toBe(true);
  });

  it('CAP-REPO-INTEL-TRACE-GATE-ENV: shouldEmitRepoIntelligenceTrace is true when KODAX_REPO_INTELLIGENCE_TRACE=1 (strict equality)', () => {
    process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
    expect(shouldEmitRepoIntelligenceTrace({} as KodaXOptions)).toBe(true);

    process.env.KODAX_REPO_INTELLIGENCE_TRACE = 'true';
    expect(shouldEmitRepoIntelligenceTrace({} as KodaXOptions)).toBe(false);
  });

  it('CAP-REPO-INTEL-TRACE-001: emitRepoIntelligenceTrace fires only when (a) onRepoIntelligenceTrace handler wired AND (b) trace gate is on AND (c) carrier carries capability/trace metadata', () => {
    const handler = vi.fn();
    const events: KodaXEvents = { onRepoIntelligenceTrace: handler };
    const optionsTraceOn = { context: { repoIntelligenceTrace: true } } as KodaXOptions;
    const optionsTraceOff = {} as KodaXOptions;
    // `createRepoIntelligenceTraceEvent` returns null when both `capability`
    // and `trace` are absent — carrier must carry one to actually fire.
    const carrier = {
      capability: { mode: 'auto', engine: 'native', bridge: 'cli', level: 'standard', status: 'ok' },
    } as never;

    // (a) wired + (b) gate on + (c) carrier present → fires
    emitRepoIntelligenceTrace(events, optionsTraceOn, 'routing', carrier);
    expect(handler).toHaveBeenCalledTimes(1);

    // (b) gate off → does not fire
    handler.mockClear();
    emitRepoIntelligenceTrace(events, optionsTraceOff, 'routing', carrier);
    expect(handler).not.toHaveBeenCalled();

    // (c) carrier null → does not fire
    handler.mockClear();
    emitRepoIntelligenceTrace(events, optionsTraceOn, 'routing', null);
    expect(handler).not.toHaveBeenCalled();

    // (a) handler not wired → does not fire (no throw)
    emitRepoIntelligenceTrace({}, optionsTraceOn, 'routing', carrier);
  });

  it.todo('CAP-REPO-INTEL-002: premium-native autoRepoMode + active-module conditions invoke getRepoPreturnBundle and prepend premiumContext (integration — repo-intel runtime mocks deferred to P3 substrate test layer)');
  it.todo('CAP-REPO-INTEL-003: module/impact confidence < 0.72 triggers fallbackGuidance with the four canonical lines (integration — getModuleContext / getImpactEstimate mocks deferred)');
  it.todo('CAP-REPO-INTEL-004: best-effort — when underlying repo-intel APIs throw, returns options.context.repoIntelligenceContext passthrough (integration — fault-injection test deferred)');
});
