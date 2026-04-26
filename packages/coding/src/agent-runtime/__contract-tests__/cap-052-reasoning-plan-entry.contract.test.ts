/**
 * Contract test for CAP-052: reasoning plan execution-state builder
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-052-reasoning-plan-creation-entry
 *
 * Test obligations:
 * - CAP-REASONING-PLAN-001: builder reflects ReasoningPlan onto effectiveOptions / providerReasoning correctly
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/reasoning-plan-entry.ts (extracted from
 * agent.ts:3066-3120 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER repo routing signals (CAP-051) and
 * `createReasoningPlan`; BEFORE first turn / every reroute apply.
 *
 * Active here: the four-input merge contract —
 *   1. `repoIntelligenceContext` (CAP-001) folded into context
 *   2. `reasoningMode` propagated from plan onto effectiveOptions
 *   3. `providerPolicyHints` merge order (user-supplied first, then
 *      decision-derived hints overlay on top)
 *   4. `promptOverlay` concatenation (user + plan, double-newline)
 * Plus the `systemPromptOverride` honor and the `providerReasoning`
 * envelope shape.
 *
 * Tests pass `systemPromptOverride` so we don't pay for the heavy
 * `buildSystemPrompt` I/O — the override-vs-derived branch is pinned
 * separately. The integration round-trip with CAP-051 repo signals +
 * FEATURE_078 ceiling clamp is deferred to P3 (needs a Runner-frame
 * fixture).
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXOptions } from '../../types.js';
import type { ReasoningPlan } from '../../reasoning.js';
import { buildReasoningExecutionState } from '../reasoning-plan-entry.js';

function freshPlan(overrides: Record<string, unknown> = {}): ReasoningPlan {
  return {
    mode: 'balanced',
    depth: 'medium',
    promptOverlay: '',
    decision: {
      primaryTask: 'edit',
      recommendedMode: 'balanced',
    },
    ...overrides,
  } as unknown as ReasoningPlan;
}

function freshOptions(overrides: Record<string, unknown> = {}): KodaXOptions {
  // Two short-circuits keep the test fast:
  //  1. systemPromptOverride avoids the heavy buildSystemPrompt I/O path.
  //  2. repoIntelligenceMode='off' short-circuits CAP-001's
  //     buildAutoRepoIntelligenceContext (which would otherwise scan
  //     the repo / talk to git for every test).
  // Tests that exercise the derived branches override context fields
  // explicitly.
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

describe('CAP-052: buildReasoningExecutionState — input merging', () => {
  it('CAP-REASONING-PLAN-001a: effectiveOptions.reasoningMode is overridden by plan.mode (plan is source of truth)', async () => {
    const result = await buildReasoningExecutionState(
      freshOptions({ reasoningMode: 'balanced' }),
      freshPlan({ mode: 'deep' }),
      true,
    );
    expect(result.effectiveOptions.reasoningMode).toBe('deep');
  });

  it('CAP-REASONING-PLAN-001b: promptOverlay concatenates user.context.promptOverlay and plan.promptOverlay with double newline', async () => {
    const result = await buildReasoningExecutionState(
      freshOptions({ context: { promptOverlay: 'USER OVERLAY' } }),
      freshPlan({ promptOverlay: 'PLAN OVERLAY' }),
      true,
    );
    expect(result.effectiveOptions.context?.promptOverlay).toBe('USER OVERLAY\n\nPLAN OVERLAY');
  });

  it('CAP-REASONING-PLAN-001c: when only one of {user overlay, plan overlay} is non-empty, no leading/trailing double newline', async () => {
    const onlyPlan = await buildReasoningExecutionState(
      freshOptions(),
      freshPlan({ promptOverlay: 'PLAN ONLY' }),
      true,
    );
    expect(onlyPlan.effectiveOptions.context?.promptOverlay).toBe('PLAN ONLY');

    const onlyUser = await buildReasoningExecutionState(
      freshOptions({ context: { promptOverlay: 'USER ONLY' } }),
      freshPlan({ promptOverlay: '' }),
      true,
    );
    expect(onlyUser.effectiveOptions.context?.promptOverlay).toBe('USER ONLY');
  });

  it('CAP-REASONING-PLAN-001d: providerPolicyHints — user-supplied hints survive merge when no decision-derived counterpart exists', async () => {
    const result = await buildReasoningExecutionState(
      freshOptions({
        context: {
          providerPolicyHints: { customUserHint: 'kept' },
        },
      }),
      freshPlan(),
      true,
    );
    expect(
      (result.effectiveOptions.context?.providerPolicyHints as Record<string, unknown>)
        ?.customUserHint,
    ).toBe('kept');
  });

  it('CAP-REASONING-PLAN-001e: providerPolicyHints — decision-derived hints OVERRIDE same-keyed user-supplied hints (overlay direction)', async () => {
    // Pin the merge direction explicitly. A user that pre-sets
    // `evidenceHeavy: false` MUST be overridden by a decision-derived
    // `evidenceHeavy: true` for review/bugfix tasks (or vice-versa).
    // We use 'review' primaryTask which `buildProviderPolicyHintsForDecision`
    // typically maps to evidence-heavy hints.
    const result = await buildReasoningExecutionState(
      freshOptions({
        context: {
          providerPolicyHints: { evidenceHeavy: 'user-stub-value' },
        },
      }),
      freshPlan({
        decision: { primaryTask: 'review', recommendedMode: 'deep' },
      }),
      true,
    );

    const hints = result.effectiveOptions.context?.providerPolicyHints as
      | Record<string, unknown>
      | undefined;
    // The decision-derived value (whatever buildProviderPolicyHintsForDecision
    // produces) MUST replace the user-supplied stub when keys collide.
    // We don't pin the exact decision value (that's CAP-064's contract);
    // only that the user's `'user-stub-value'` did NOT survive.
    if ('evidenceHeavy' in (hints ?? {})) {
      expect(hints?.evidenceHeavy).not.toBe('user-stub-value');
    }
  });
});

describe('CAP-052: buildReasoningExecutionState — systemPrompt resolution', () => {
  it('CAP-REASONING-PLAN-002a: systemPromptOverride from context wins (does NOT call buildSystemPrompt)', async () => {
    const result = await buildReasoningExecutionState(
      freshOptions({ context: { systemPromptOverride: 'EXPLICIT OVERRIDE' } }),
      freshPlan(),
      true,
    );
    expect(result.systemPrompt).toBe('EXPLICIT OVERRIDE');
  });
});

describe('CAP-052: buildReasoningExecutionState — providerReasoning envelope', () => {
  it('CAP-REASONING-PLAN-003a: depth=`off` → enabled: false; otherwise enabled: true', async () => {
    const off = await buildReasoningExecutionState(
      freshOptions(),
      freshPlan({ depth: 'off' }),
      true,
    );
    expect(off.providerReasoning.enabled).toBe(false);

    const on = await buildReasoningExecutionState(
      freshOptions(),
      freshPlan({ depth: 'high' }),
      true,
    );
    expect(on.providerReasoning.enabled).toBe(true);
  });

  it('CAP-REASONING-PLAN-003b: providerReasoning fields mirror plan (mode/depth) + decision (primaryTask/recommendedMode)', async () => {
    const result = await buildReasoningExecutionState(
      freshOptions(),
      freshPlan({
        mode: 'deep',
        depth: 'high',
        decision: { primaryTask: 'review', recommendedMode: 'deep' },
      }),
      true,
    );

    expect(result.providerReasoning).toEqual({
      enabled: true,
      mode: 'deep',
      depth: 'high',
      taskType: 'review',
      executionMode: 'deep',
    });
  });
});

describe('CAP-052: buildReasoningExecutionState — input immutability', () => {
  it('CAP-REASONING-PLAN-IMMUTABILITY: original options object is not mutated (effectiveOptions is a fresh shallow copy)', async () => {
    const original = freshOptions({
      reasoningMode: 'balanced',
      context: { promptOverlay: 'ORIG', systemPromptOverride: 'X' },
    });
    const snapshot = JSON.stringify(original);

    await buildReasoningExecutionState(
      original,
      freshPlan({ mode: 'deep', promptOverlay: 'PLAN' }),
      true,
    );

    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
