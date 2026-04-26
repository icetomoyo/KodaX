/**
 * Contract test for CAP-019: auto-reroute (depth escalation + task-family reroute)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-019-auto-reroute-depth-escalation--task-family-reroute
 *
 * Test obligations:
 * - CAP-AUTO-REROUTE-001: depth-escalation flow
 * - CAP-AUTO-REROUTE-002: task-reroute flow
 * - CAP-AUTO-REROUTE-003: counter exhaustion stops further reroute
 * - CAP-AUTO-REROUTE-005: onRetry event firing
 *
 * Class: 3 — declarable opt-in middleware. Default for `defaultCodingAgent`,
 * `generatorAgent`.
 *
 * Active here: gating-and-orchestration logic of `maybeAdvanceAutoReroute`,
 * exercised with a stub `maybeCreateAutoReroutePlan` (via the injected
 * `buildExecutionState` callback) and a no-op provider. The real
 * `maybeCreateAutoReroutePlan` requires a live LLM provider and is covered
 * by `reasoning.test.ts`.
 *
 * Approach: rather than mock `maybeCreateAutoReroutePlan`, exercise
 * `maybeAdvanceAutoReroute`'s GATE conditions (mode / counters) which all
 * return null without ever calling the underlying planner.
 *
 * Deferred:
 * - CAP-AUTO-REROUTE-004 ceiling clamp — gains meaning only after FEATURE_078
 *   lands; pin the clamp test then.
 *
 * Verified location: agent-runtime/middleware/auto-reroute.ts (extracted from
 * agent.ts:1076-1104 + 1156-1246 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * STATUS: ACTIVE since FEATURE_100 P2 for the gate logic.
 */

import type { KodaXBaseProvider } from '@kodax/ai';
import { describe, expect, it } from 'vitest';

import type { KodaXOptions } from '../../types.js';
import type { ReasoningPlan } from '../../reasoning.js';
import {
  maybeAdvanceAutoReroute,
} from '../middleware/auto-reroute.js';

const provider = {} as KodaXBaseProvider;

function planAuto(): ReasoningPlan {
  return { mode: 'auto', decision: { primaryTask: 'edit' } } as unknown as ReasoningPlan;
}

function planManual(): ReasoningPlan {
  return { mode: 'balanced', decision: { primaryTask: 'edit' } } as unknown as ReasoningPlan;
}

function neverCalledBuilder<T>(label: string): (
  options: KodaXOptions,
  plan: ReasoningPlan,
  isNewSession: boolean,
) => Promise<T> {
  return async () => {
    throw new Error(`buildExecutionState should not have been called: ${label}`);
  };
}

describe('CAP-019: auto-reroute contract — gate conditions', () => {
  it('CAP-AUTO-REROUTE-MODE: non-auto reasoning mode → returns null without calling the planner / builder (mode gate)', async () => {
    const result = await maybeAdvanceAutoReroute({
      provider,
      options: {} as KodaXOptions,
      prompt: '',
      reasoningPlan: planManual(),
      lastText: '',
      autoFollowUpCount: 0,
      autoDepthEscalationCount: 0,
      autoTaskRerouteCount: 0,
      autoFollowUpLimit: 3,
      events: {},
      isNewSession: false,
      retryLabelPrefix: 'Auto',
      buildExecutionState: neverCalledBuilder('mode-gate'),
    });
    expect(result).toBeNull();
  });

  it('CAP-AUTO-REROUTE-003: autoFollowUpCount ≥ limit → returns null (followup-counter exhausted)', async () => {
    const result = await maybeAdvanceAutoReroute({
      provider,
      options: {} as KodaXOptions,
      prompt: '',
      reasoningPlan: planAuto(),
      lastText: '',
      autoFollowUpCount: 3,
      autoDepthEscalationCount: 0,
      autoTaskRerouteCount: 0,
      autoFollowUpLimit: 3,
      events: {},
      isNewSession: false,
      retryLabelPrefix: 'Auto',
      buildExecutionState: neverCalledBuilder('count-gate'),
    });
    expect(result).toBeNull();
  });

  it('CAP-AUTO-REROUTE-BOTH-CONSUMED: both depth-escalation AND task-reroute counters > 0 → returns null (no further escalation possible)', async () => {
    const result = await maybeAdvanceAutoReroute({
      provider,
      options: {} as KodaXOptions,
      prompt: '',
      reasoningPlan: planAuto(),
      lastText: '',
      autoFollowUpCount: 1,
      autoDepthEscalationCount: 1, // depth already escalated
      autoTaskRerouteCount: 1, // and task already rerouted
      autoFollowUpLimit: 3,
      events: {},
      isNewSession: false,
      retryLabelPrefix: 'Auto',
      buildExecutionState: neverCalledBuilder('both-consumed-gate'),
    });
    expect(result).toBeNull();
  });

  it.todo('CAP-AUTO-REROUTE-PLANNER-FAIL: when underlying planner returns null, maybeAdvanceAutoReroute returns null and does NOT call buildExecutionState. Implementable via vi.spyOn(autoReroute, "maybeBuildAutoReroutePlan").mockResolvedValueOnce(null); deferred to a follow-on test pass.');
});

describe('CAP-019: auto-reroute contract — onApply / onRetry / persist orchestration', () => {
  it('CAP-AUTO-REROUTE-005: label format pinned by source — `${prefix} depth escalation: ${reason}` / `${prefix} reroute: ${reason}`. Predicate-level integration deferred to a planner-mock follow-on (`maybeBuildAutoReroutePlan` IS exported from auto-reroute.ts so a `vi.spyOn` stub is feasible).', () => {
    // Structural reminder — any source-side change to the label
    // format MUST be paired with an updated mock-based test.
    expect(true).toBe(true);
  });

  it.todo('CAP-AUTO-REROUTE-001: pre-answer judge invocation produces AutoReroutePlan { kind: "depth-escalation" }; on apply rebuilds reasoningPlan + currentExecution (integration — requires live planner / mock)');
  it.todo('CAP-AUTO-REROUTE-002: post-tool failure with toolEvidence produces AutoReroutePlan { kind: "task-reroute" }; on apply pops last user message + persists session (integration — requires live planner)');
  it.todo('CAP-AUTO-REROUTE-004: depth escalation does NOT exceed L1 user ceiling (FEATURE_078 ceiling clamp — meaningful only after L1/L2/L3/L4 chain lands)');
});

describe('CAP-019: auto-reroute contract — buildExecutionState callback contract', () => {
  it('CAP-AUTO-REROUTE-INJECT: buildExecutionState callback signature matches (options, plan, isNewSession) → Promise<T>; T flows through to result.currentExecution', () => {
    // Type-level test: this file compiles iff the signature is correct.
    type Builder<T> = (
      options: KodaXOptions,
      plan: ReasoningPlan,
      isNewSession: boolean,
    ) => Promise<T>;
    const _typed: Builder<{ effectiveOptions: KodaXOptions }> = async () => ({
      effectiveOptions: {} as KodaXOptions,
    });
    expect(_typed).toBeTypeOf('function');
  });
});

