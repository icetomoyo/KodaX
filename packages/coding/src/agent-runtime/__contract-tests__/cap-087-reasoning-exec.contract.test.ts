/**
 * Contract test for CAP-087: per-turn reasoning execution state builder
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-087-per-turn-reasoning-execution-state-builder
 *
 * Test obligations:
 * - CAP-REASONING-EXEC-001: effectiveOptions carries repo intel context
 *   + policy hints (FUNCTION-LEVEL but requires the env-skipping
 *   `repoIntelligenceMode: 'off'` shortcut to avoid filesystem touches.)
 * - CAP-REASONING-EXEC-002: systemPromptOverride bypasses
 *   buildSystemPrompt (FUNCTION-LEVEL — fully active here).
 * - CAP-REASONING-EXEC-003: promptOverlay joins caller + plan overlays
 *   in order, separated by `\n\n` (FUNCTION-LEVEL — fully active here).
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/reasoning-plan-entry.ts:78
 * (extracted from agent.ts:3066-3120 during FEATURE_100 P2 CAP-052).
 *
 * Time-ordering constraint: AFTER reasoning plan creation (CAP-052);
 * BEFORE per-turn provider stream.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6l.
 */

import { describe, expect, it } from 'vitest';

import { buildReasoningExecutionState } from '../reasoning-plan-entry.js';
import type { KodaXOptions } from '../../types.js';
import type { ReasoningPlan } from '../../reasoning.js';

function makeMinimalPlan(overrides?: Partial<ReasoningPlan>): ReasoningPlan {
  return {
    mode: 'off',
    depth: 'off',
    decision: {
      primaryTask: 'investigation',
      recommendedMode: 'plan',
      taskFamily: 'investigation',
      mutationSurface: 'none',
      riskLevel: 'low',
      harnessProfile: 'standard',
    } as unknown as ReasoningPlan['decision'],
    amaControllerDecision: {} as ReasoningPlan['amaControllerDecision'],
    promptOverlay: '',
    ...(overrides ?? {}),
  };
}

describe('CAP-087: per-turn reasoning execution state builder contract', () => {
  it('CAP-REASONING-EXEC-002: when options.context.systemPromptOverride is set, that exact string is used as systemPrompt — buildSystemPrompt is NOT invoked', async () => {
    const override = '__test_system_prompt_override__';
    const options = {
      provider: 'anthropic',
      context: {
        repoIntelligenceMode: 'off' as const,
        systemPromptOverride: override,
      },
    } as unknown as KodaXOptions;

    const state = await buildReasoningExecutionState(
      options,
      makeMinimalPlan(),
      true,
    );

    expect(state.systemPrompt).toBe(override);
  });

  it('CAP-REASONING-EXEC-003a: promptOverlay is the `\\n\\n` join of caller overlay + plan overlay in that order', async () => {
    const options = {
      provider: 'anthropic',
      context: {
        repoIntelligenceMode: 'off' as const,
        systemPromptOverride: 'override',
        promptOverlay: 'caller-side',
      },
    } as unknown as KodaXOptions;
    const plan = makeMinimalPlan({ promptOverlay: 'plan-side' });

    const state = await buildReasoningExecutionState(options, plan, true);

    expect(state.effectiveOptions.context?.promptOverlay).toBe(
      'caller-side\n\nplan-side',
    );
  });

  it('CAP-REASONING-EXEC-003b: empty caller overlay produces plan-only output (no leading \\n\\n)', async () => {
    const options = {
      provider: 'anthropic',
      context: {
        repoIntelligenceMode: 'off' as const,
        systemPromptOverride: 'override',
        promptOverlay: '',
      },
    } as unknown as KodaXOptions;
    const plan = makeMinimalPlan({ promptOverlay: 'plan-only' });

    const state = await buildReasoningExecutionState(options, plan, true);

    expect(state.effectiveOptions.context?.promptOverlay).toBe('plan-only');
  });

  it('CAP-REASONING-EXEC-003c: empty plan overlay produces caller-only output (no trailing \\n\\n)', async () => {
    const options = {
      provider: 'anthropic',
      context: {
        repoIntelligenceMode: 'off' as const,
        systemPromptOverride: 'override',
        promptOverlay: 'caller-only',
      },
    } as unknown as KodaXOptions;
    const plan = makeMinimalPlan({ promptOverlay: '' });

    const state = await buildReasoningExecutionState(options, plan, true);

    expect(state.effectiveOptions.context?.promptOverlay).toBe('caller-only');
  });

  it('CAP-REASONING-EXEC-001: effectiveOptions carries the reasoning plan mode + executionCwd resolution', async () => {
    const options = {
      provider: 'anthropic',
      context: {
        repoIntelligenceMode: 'off' as const,
        systemPromptOverride: 'override',
        executionCwd: process.cwd(),
      },
    } as unknown as KodaXOptions;
    const plan = makeMinimalPlan({ mode: 'auto' });

    const state = await buildReasoningExecutionState(options, plan, true);

    expect(state.effectiveOptions.reasoningMode).toBe('auto');
    expect(state.effectiveOptions.context?.executionCwd).toBeDefined();
    // providerPolicyHints object is always created from the decision
    expect(state.effectiveOptions.context?.providerPolicyHints).toBeDefined();
  });
});
