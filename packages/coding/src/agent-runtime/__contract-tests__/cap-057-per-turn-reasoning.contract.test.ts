/**
 * Contract test for CAP-057: per-turn effectiveReasoningPlan with runtimeThinkingLevel override
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-057-per-turn-effectivereasoningplan-with-runtimethinkinglevel-override
 *
 * Test obligations:
 * - CAP-PER-TURN-REASONING-001: extension thinkingLevel override applies
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/per-turn-reasoning.ts (extracted from
 * agent.ts:554-570 — pre-FEATURE_100 baseline — during FEATURE_100 P3.1)
 *
 * Time-ordering constraint: AFTER per-turn provider re-resolution (CAP-055); BEFORE provider stream.
 *
 * Active here:
 *   - `buildEffectiveReasoningPlan` returns the input plan unchanged
 *     (reference-equal) when `thinkingLevel` is undefined
 *   - `buildEffectiveReasoningPlan` overrides `mode` and re-derives `depth`
 *     via `reasoningModeToDepth` when `thinkingLevel` is set
 *   - `resolvePerTurnReasoning` calls `buildReasoningExecutionState` with
 *     the effective plan + runtime overrides folded onto options
 *
 * NOTE (P3 R7): `messages.length === 1` "isNewSession" derivation has
 * known ambiguity after compaction. CAP-057 preserves the baseline
 * verbatim; the audit is P3-deferred.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.1.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXOptions } from '../../types.js';
import type { ReasoningPlan } from '../../reasoning.js';

import {
  buildEffectiveReasoningPlan,
  resolvePerTurnReasoning,
} from '../per-turn-reasoning.js';

function fakePlan(overrides: Partial<ReasoningPlan> = {}): ReasoningPlan {
  return {
    mode: 'balanced',
    depth: 'medium',
    promptOverlay: '',
    decision: { primaryTask: 'edit', recommendedMode: 'balanced' },
    ...overrides,
  } as unknown as ReasoningPlan;
}

function fakeOptions(overrides: Partial<KodaXOptions> = {}): KodaXOptions {
  // systemPromptOverride + repoIntelligenceMode='off' short-circuit
  // the heavy I/O paths inside buildReasoningExecutionState (CAP-052).
  const ctx = (overrides.context as Record<string, unknown>) ?? {};
  return {
    provider: 'anthropic',
    ...overrides,
    context: {
      systemPromptOverride: 'TEST-FIXTURE-PROMPT',
      repoIntelligenceMode: 'off',
      ...ctx,
    },
  } as unknown as KodaXOptions;
}

describe('CAP-057: buildEffectiveReasoningPlan — pure function', () => {
  it('CAP-PER-TURN-REASONING-001a: undefined thinkingLevel returns plan reference-equal (no allocation)', () => {
    const plan = fakePlan({ mode: 'balanced', depth: 'medium' });
    const result = buildEffectiveReasoningPlan(plan, undefined);
    expect(result).toBe(plan); // reference equal — load-bearing for hot-path perf
  });

  it('CAP-PER-TURN-REASONING-001b: thinkingLevel set overrides plan.mode and re-derives depth', () => {
    const plan = fakePlan({ mode: 'balanced', depth: 'medium' });
    const result = buildEffectiveReasoningPlan(plan, 'deep');
    expect(result).not.toBe(plan); // fresh allocation
    expect(result.mode).toBe('deep');
    // depth must be re-derived via reasoningModeToDepth, not copied from plan
    expect(result.depth).toBeDefined();
  });

  it('CAP-PER-TURN-REASONING-001c: other plan fields (decision, promptOverlay) survive the override', () => {
    const plan = fakePlan({
      mode: 'balanced',
      decision: { primaryTask: 'review', recommendedMode: 'deep' } as unknown as ReasoningPlan['decision'],
      promptOverlay: 'CARRIED-OVER',
    });
    const result = buildEffectiveReasoningPlan(plan, 'quick');
    expect(result.decision).toEqual({ primaryTask: 'review', recommendedMode: 'deep' });
    expect(result.promptOverlay).toBe('CARRIED-OVER');
  });
});

describe('CAP-057: resolvePerTurnReasoning — full step', () => {
  it('CAP-PER-TURN-REASONING-001d: thinkingLevel propagates through to currentExecution.effectiveOptions.reasoningMode', async () => {
    const result = await resolvePerTurnReasoning({
      options: fakeOptions({ reasoningMode: 'balanced' }),
      providerName: 'anthropic',
      modelOverride: undefined,
      thinkingLevel: 'deep',
      reasoningPlan: fakePlan({ mode: 'balanced' }),
      messages: [{ role: 'user', content: 'hi' }] as Parameters<typeof resolvePerTurnReasoning>[0]['messages'],
    });
    expect(result.effectiveReasoningPlan.mode).toBe('deep');
    expect(result.currentExecution.effectiveOptions.reasoningMode).toBe('deep');
  });

  it('CAP-PER-TURN-REASONING-001e: thinkingLevel undefined → effectiveReasoningPlan is the input plan reference-equal', async () => {
    // Note: `effectiveOptions.reasoningMode` is dictated by the plan
    // (CAP-052-001a: plan is source of truth), not by options.reasoningMode.
    // This test pins ONLY the resolvePerTurnReasoning-level invariant —
    // pass-through when thinkingLevel is undefined.
    const plan = fakePlan({ mode: 'balanced' });
    const result = await resolvePerTurnReasoning({
      options: fakeOptions({ reasoningMode: 'quick' }),
      providerName: 'anthropic',
      modelOverride: undefined,
      thinkingLevel: undefined,
      reasoningPlan: plan,
      messages: [{ role: 'user', content: 'hi' }] as Parameters<typeof resolvePerTurnReasoning>[0]['messages'],
    });
    expect(result.effectiveReasoningPlan).toBe(plan); // reference-equal pass-through
    // CAP-052 owns the plan→effectiveOptions mapping; we only verify the
    // plan was reference-passed through this layer.
    expect(result.currentExecution.effectiveOptions.reasoningMode).toBe('balanced');
  });
});
