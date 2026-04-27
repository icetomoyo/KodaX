/**
 * Contract test for CAP-094: default coding agent declaration constructor
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-094-default-coding-agent-declaration-constructor
 *
 * Test obligations:
 * - CAP-DEFAULT-AGENT-001: declaration has expected name + frozen +
 *   declaration-borne substrate executor (post-FEATURE_100 P3.6s,
 *   `Agent.substrateExecutor` is the canonical hook for the coding
 *   pipeline — no `registerPresetDispatcher` indirection.) The
 *   middleware-defaults portion of the original claim — auto-reroute /
 *   mutation-reflection / pre-answer-judge / post-tool-judge — still
 *   awaits a future `Agent.middleware[]` field; today these live as
 *   branches inside the substrate body itself.
 * - CAP-DEFAULT-AGENT-002: overrides preserved (FULLY ACTIVE)
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: coding-preset.ts:125-133 (createDefaultCodingAgent).
 * Post-substrate this moves to `agents/default-coding-agent.ts`; the
 * relocation is deferred to the substrate-executor migration phase.
 *
 * Time-ordering constraint: at SDK entry or substrate frame initialization.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6t. CAP-DEFAULT-AGENT-001's
 * middleware-defaults assertion was activated when `Agent.middleware[]`
 * landed in `core/agent.ts` (FEATURE_100 P3.6t).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CODING_AGENT_NAME,
  createDefaultCodingAgent,
} from '../../coding-preset.js';

describe('CAP-094: default coding agent declaration constructor contract', () => {
  it('CAP-DEFAULT-AGENT-001a: createDefaultCodingAgent() returns an Agent with name "kodax/coding/default" and a non-empty instructions string', () => {
    const agent = createDefaultCodingAgent();
    expect(agent.name).toBe(DEFAULT_CODING_AGENT_NAME);
    expect(agent.name).toBe('kodax/coding/default');
    expect(typeof agent.instructions).toBe('string');
    expect((agent.instructions as string).length).toBeGreaterThan(0);
  });

  it('CAP-DEFAULT-AGENT-001b: createDefaultCodingAgent() returns a frozen Agent — accidental mutation throws (or is silently ignored in non-strict mode)', () => {
    const agent = createDefaultCodingAgent();
    expect(Object.isFrozen(agent)).toBe(true);
  });

  it('CAP-DEFAULT-AGENT-001d: createDefaultCodingAgent() attaches a `substrateExecutor` closure on the declaration (FEATURE_100 P3.6s — replaces Option Y `registerPresetDispatcher` indirection)', () => {
    const agent = createDefaultCodingAgent();
    expect(typeof agent.substrateExecutor).toBe('function');
  });

  it('CAP-DEFAULT-AGENT-001c: middleware defaults — autoReroute, mutationReflection, preAnswerJudge, postToolJudge — are declared on the Agent (FEATURE_100 P3.6t introduced `Agent.middleware[]`)', () => {
    const agent = createDefaultCodingAgent();
    expect(agent.middleware).toBeDefined();
    const names = agent.middleware!.map((m) => m.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'autoReroute',
        'mutationReflection',
        'preAnswerJudge',
        'postToolJudge',
      ]),
    );
    // All four ship enabled by default — substrate honors `enabled`
    // when consulting the declaration.
    for (const m of agent.middleware!) {
      expect(m.enabled).toBe(true);
    }
  });

  it('CAP-DEFAULT-AGENT-002: overrides passed to createDefaultCodingAgent are preserved in the returned Agent', () => {
    const customReasoning = {
      default: 'deep' as const,
      escalateOnRevise: true,
    };
    const customGuardrail = {
      kind: 'output' as const,
      name: 'custom-guard',
    };
    const agent = createDefaultCodingAgent({
      reasoning: customReasoning,
      guardrails: [customGuardrail],
      tools: [],
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    // Name + instructions are NOT overridable (the function signature
    // is `Partial<Omit<Agent, 'name' | 'instructions'>>`).
    expect(agent.name).toBe(DEFAULT_CODING_AGENT_NAME);
    // Override fields are preserved verbatim.
    expect(agent.reasoning).toEqual(customReasoning);
    expect(agent.guardrails).toHaveLength(1);
    expect(agent.guardrails?.[0]?.name).toBe('custom-guard');
    expect(agent.guardrails?.[0]?.kind).toBe('output');
    expect(agent.tools).toEqual([]);
    expect(agent.provider).toBe('anthropic');
    expect(agent.model).toBe('claude-sonnet-4-6');
  });

  it('CAP-DEFAULT-AGENT-002b: createDefaultCodingAgent({}) without overrides returns an Agent with NO override fields (only name + instructions + substrateExecutor + middleware)', () => {
    const agent = createDefaultCodingAgent();
    expect(agent.tools).toBeUndefined();
    expect(agent.handoffs).toBeUndefined();
    expect(agent.reasoning).toBeUndefined();
    expect(agent.guardrails).toBeUndefined();
    expect(agent.provider).toBeUndefined();
    expect(agent.model).toBeUndefined();
    // `substrateExecutor` is intentionally always present — it's how
    // FEATURE_100 P3.6s wires the coding pipeline post Option-Y deletion.
    expect(typeof agent.substrateExecutor).toBe('function');
    // `middleware` is intentionally always present — it's how
    // FEATURE_100 P3.6t declaratively pins the default middleware
    // policy (CAP-094-001c) on the declaration.
    expect(Array.isArray(agent.middleware)).toBe(true);
  });
});
