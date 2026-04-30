/**
 * FEATURE_107 P2.1 unit tests — DELETE WITH B-PATH IMPL AT P6 unless 档 1
 * wins. Covers both source-side eval hooks:
 *   1. `KODAX_FORCE_MAX_HARNESS` env override in `dispatchManagedTask`
 *   2. `stripPlannerReasoningForGenerator` filter shape (the inputFilter
 *      attached to `plannerHandoffs` when `KODAX_PLANNER_INPUTFILTER=
 *      strip-reasoning`)
 *
 * Both env vars are eval-only. Production code never sets them, so we
 * verify both flag=off (no-op identity) and flag=on (engaged) paths.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { dispatchManagedTask, type ManagedDispatchDeps } from '../task-engine.js';
import { stripPlannerReasoningForGenerator } from './runner-driven.js';
import type { KodaXOptions, KodaXResult, KodaXTaskRoutingDecision } from '../types.js';
import type { ReasoningPlan } from '../reasoning.js';
import type { AgentMessage } from '@kodax/core';
import { EMIT_CONTRACT_TOOL_NAME } from '../agents/protocol-emitters.js';

function fakeDecision(profile: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL'): KodaXTaskRoutingDecision {
  return {
    primaryTask: 'conversation',
    taskFamily: 'investigation',
    workIntent: 'review',
    actionability: 'discuss',
    complexity: 'simple',
    riskLevel: 'low',
    mutationSurface: 'none',
    assuranceIntent: 'none',
    executionPattern: 'direct',
    harnessProfile: profile,
    reasoning: 'unit test',
  } as unknown as KodaXTaskRoutingDecision;
}

function fakePlan(profile: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL'): ReasoningPlan {
  return {
    mode: 'off',
    depth: 'off',
    decision: fakeDecision(profile),
    amaControllerDecision: undefined,
    promptOverlay: '',
  } as unknown as ReasoningPlan;
}

function makeDeps(captured: { plan?: ReasoningPlan }): ManagedDispatchDeps {
  return {
    runSA: async () => ({ messages: [], success: true, lastText: '', sessionId: 't' }) as unknown as KodaXResult,
    runAMA: async (_options, _prompt, _sa, plan) => {
      captured.plan = plan;
      return { messages: [], success: true, lastText: '', sessionId: 't' } as unknown as KodaXResult;
    },
    buildPlan: async () => fakePlan('H0_DIRECT'),
  };
}

const baseOptions: KodaXOptions = {
  agentMode: 'ama',
  context: {},
} as unknown as KodaXOptions;

describe('FEATURE_107 P2.1 — KODAX_FORCE_MAX_HARNESS', () => {
  const ENV_KEY = 'KODAX_FORCE_MAX_HARNESS';
  const ORIGINAL = process.env[ENV_KEY];

  // afterEach (not in-test restore) so env always restored, even when an
  // expect throws — otherwise the leak races with parallel test files
  // (h2-boundary-runner.test.ts saw H1 force leaking from this suite).
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = ORIGINAL;
  });

  it('flag=off: plan.decision.harnessProfile passes through unchanged (production default)', async () => {
    delete process.env[ENV_KEY];
    const captured: { plan?: ReasoningPlan } = {};
    await dispatchManagedTask(baseOptions, 'task', makeDeps(captured));
    expect(captured.plan?.decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('flag=H1: harnessProfile is rewritten to H1_EXECUTE_EVAL', async () => {
    process.env[ENV_KEY] = 'H1';
    const captured: { plan?: ReasoningPlan } = {};
    await dispatchManagedTask(baseOptions, 'task', makeDeps(captured));
    expect(captured.plan?.decision.harnessProfile).toBe('H1_EXECUTE_EVAL');
  });

  it('flag=H2: harnessProfile is rewritten to H2_PLAN_EXECUTE_EVAL', async () => {
    process.env[ENV_KEY] = 'H2';
    const captured: { plan?: ReasoningPlan } = {};
    await dispatchManagedTask(baseOptions, 'task', makeDeps(captured));
    expect(captured.plan?.decision.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
  });

  it('flag with garbage value: ignored (fail-open to plan default)', async () => {
    process.env[ENV_KEY] = 'NOT_A_HARNESS';
    const captured: { plan?: ReasoningPlan } = {};
    await dispatchManagedTask(baseOptions, 'task', makeDeps(captured));
    expect(captured.plan?.decision.harnessProfile).toBe('H0_DIRECT');
  });

  it('flag=H1 returns a NEW plan object (immutability — original plan untouched)', async () => {
    process.env[ENV_KEY] = 'H1';
    const originalPlan = fakePlan('H0_DIRECT');
    const deps: ManagedDispatchDeps = {
      runSA: async () => ({ messages: [], success: true, lastText: '', sessionId: 't' }) as unknown as KodaXResult,
      runAMA: async (_options, _prompt, _sa, plan) => {
        expect(plan).not.toBe(originalPlan);
        expect(plan?.decision.harnessProfile).toBe('H1_EXECUTE_EVAL');
        expect(originalPlan.decision.harnessProfile).toBe('H0_DIRECT');
        return { messages: [], success: true, lastText: '', sessionId: 't' } as unknown as KodaXResult;
      },
      buildPlan: async () => originalPlan,
    };
    await dispatchManagedTask(baseOptions, 'task', deps);
  });
});

describe('FEATURE_107 P2.1 — stripPlannerReasoningForGenerator', () => {
  const userMsg: AgentMessage = { role: 'user', content: 'do the thing' };
  const plannerThinking: AgentMessage = {
    role: 'assistant',
    content: 'Let me think about this... I will read some files first.',
  };
  const plannerToolUse: AgentMessage = {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't1', name: 'read', input: { path: 'foo.ts' } },
    ],
  };
  const plannerToolResult: AgentMessage = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'file contents' },
    ],
  };
  const plannerEmitContract: AgentMessage = {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 't2',
        name: EMIT_CONTRACT_TOOL_NAME,
        input: { summary: 'plan v1', success_criteria: ['x'], steps: ['a', 'b'] },
      },
    ],
  };
  const contractToolResult: AgentMessage = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't2', content: 'contract recorded' },
    ],
  };

  it('keeps user prompt + emit_contract assistant message, drops Planner reasoning + intermediate tools', () => {
    const filtered = stripPlannerReasoningForGenerator([
      userMsg,
      plannerThinking,
      plannerToolUse,
      plannerToolResult,
      plannerEmitContract,
      contractToolResult,
    ]);
    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toBe(userMsg);
    expect(filtered[1]).toBe(plannerEmitContract);
  });

  it('picks the LAST emit_contract when Planner re-emitted (replan path)', () => {
    const firstContract: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'c1', name: EMIT_CONTRACT_TOOL_NAME, input: { v: 1 } },
      ],
    };
    const secondContract: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'c2', name: EMIT_CONTRACT_TOOL_NAME, input: { v: 2 } },
      ],
    };
    const filtered = stripPlannerReasoningForGenerator([
      userMsg,
      firstContract,
      plannerThinking,
      secondContract,
    ]);
    expect(filtered).toHaveLength(2);
    expect(filtered[1]).toBe(secondContract);
  });

  it('falls back to original history when no emit_contract is found (degenerate Planner)', () => {
    const history = [userMsg, plannerThinking, plannerToolUse];
    const filtered = stripPlannerReasoningForGenerator(history);
    expect(filtered).toBe(history);
  });

  it('skips assistant messages with string content (text-only Planner reasoning)', () => {
    const filtered = stripPlannerReasoningForGenerator([
      userMsg,
      plannerThinking, // string content — should not be considered as plan source
      plannerEmitContract,
    ]);
    expect(filtered).toHaveLength(2);
    expect(filtered[1]).toBe(plannerEmitContract);
  });

  it('skips messages whose tool_use blocks are not emit_contract', () => {
    const otherTool: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tx', name: 'emit_handoff', input: {} },
      ],
    };
    const filtered = stripPlannerReasoningForGenerator([
      userMsg,
      otherTool,
      plannerEmitContract,
    ]);
    expect(filtered).toHaveLength(2);
    expect(filtered[1]).toBe(plannerEmitContract);
  });

  it('handles missing user message (degenerate input — system-only)', () => {
    const filtered = stripPlannerReasoningForGenerator([
      plannerEmitContract,
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toBe(plannerEmitContract);
  });
});
