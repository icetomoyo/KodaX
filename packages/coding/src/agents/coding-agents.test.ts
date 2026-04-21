/**
 * Coding Agent instances — FEATURE_084 Shard 2 (v0.7.26).
 *
 * Data-shape tests: name binding, tool wiring, handoff topology.
 * No runtime execution at this shard — that lands with Shard 5.
 */

import { describe, expect, it } from 'vitest';
import {
  EVALUATOR_AGENT_NAME,
  GENERATOR_AGENT_NAME,
  PLANNER_AGENT_NAME,
  SCOUT_AGENT_NAME,
} from '@kodax/core';
import {
  CODING_AGENTS,
  evaluatorCodingAgent,
  generatorCodingAgent,
  plannerCodingAgent,
  scoutCodingAgent,
} from './coding-agents.js';
import {
  EMIT_CONTRACT_TOOL_NAME,
  EMIT_HANDOFF_TOOL_NAME,
  EMIT_SCOUT_VERDICT_TOOL_NAME,
  EMIT_VERDICT_TOOL_NAME,
} from './protocol-emitters.js';

describe('coding-agents — identity', () => {
  it('binds each coding agent to its corresponding @kodax/core name', () => {
    expect(scoutCodingAgent.name).toBe(SCOUT_AGENT_NAME);
    expect(plannerCodingAgent.name).toBe(PLANNER_AGENT_NAME);
    expect(generatorCodingAgent.name).toBe(GENERATOR_AGENT_NAME);
    expect(evaluatorCodingAgent.name).toBe(EVALUATOR_AGENT_NAME);
  });

  it('exposes all four agents in CODING_AGENTS record', () => {
    expect(CODING_AGENTS.scout).toBe(scoutCodingAgent);
    expect(CODING_AGENTS.planner).toBe(plannerCodingAgent);
    expect(CODING_AGENTS.generator).toBe(generatorCodingAgent);
    expect(CODING_AGENTS.evaluator).toBe(evaluatorCodingAgent);
  });

  it('freezes each agent to prevent runtime mutation', () => {
    expect(Object.isFrozen(scoutCodingAgent)).toBe(true);
    expect(Object.isFrozen(plannerCodingAgent)).toBe(true);
    expect(Object.isFrozen(generatorCodingAgent)).toBe(true);
    expect(Object.isFrozen(evaluatorCodingAgent)).toBe(true);
  });
});

describe('coding-agents — tool wiring', () => {
  it('scout agent carries emit_scout_verdict', () => {
    const names = scoutCodingAgent.tools?.map((t) => t.name) ?? [];
    expect(names).toContain(EMIT_SCOUT_VERDICT_TOOL_NAME);
  });

  it('planner agent carries emit_contract', () => {
    const names = plannerCodingAgent.tools?.map((t) => t.name) ?? [];
    expect(names).toContain(EMIT_CONTRACT_TOOL_NAME);
  });

  it('generator agent carries emit_handoff', () => {
    const names = generatorCodingAgent.tools?.map((t) => t.name) ?? [];
    expect(names).toContain(EMIT_HANDOFF_TOOL_NAME);
  });

  it('evaluator agent carries emit_verdict', () => {
    const names = evaluatorCodingAgent.tools?.map((t) => t.name) ?? [];
    expect(names).toContain(EMIT_VERDICT_TOOL_NAME);
  });
});

describe('coding-agents — handoff topology', () => {
  function targetNames(agent: typeof scoutCodingAgent): string[] {
    return (agent.handoffs ?? []).map((h) => h.target.name);
  }

  it('scout hands off to generator (H1) and planner (H2)', () => {
    const targets = targetNames(scoutCodingAgent);
    expect(targets).toContain(GENERATOR_AGENT_NAME);
    expect(targets).toContain(PLANNER_AGENT_NAME);
    expect(targets).not.toContain(EVALUATOR_AGENT_NAME);
  });

  it('planner hands off to generator only', () => {
    const targets = targetNames(plannerCodingAgent);
    expect(targets).toEqual([GENERATOR_AGENT_NAME]);
  });

  it('generator hands off to evaluator only', () => {
    const targets = targetNames(generatorCodingAgent);
    expect(targets).toEqual([EVALUATOR_AGENT_NAME]);
  });

  it('evaluator hands off back to generator (revise) and planner (replan)', () => {
    const targets = targetNames(evaluatorCodingAgent);
    expect(targets).toContain(GENERATOR_AGENT_NAME);
    expect(targets).toContain(PLANNER_AGENT_NAME);
  });

  it('all handoffs are continuation kind', () => {
    for (const agent of [scoutCodingAgent, plannerCodingAgent, generatorCodingAgent, evaluatorCodingAgent]) {
      for (const handoff of agent.handoffs ?? []) {
        expect(handoff.kind).toBe('continuation');
      }
    }
  });

  it('every handoff has a human-readable description', () => {
    for (const agent of [scoutCodingAgent, plannerCodingAgent, generatorCodingAgent, evaluatorCodingAgent]) {
      for (const handoff of agent.handoffs ?? []) {
        expect(handoff.description).toBeTruthy();
      }
    }
  });
});

describe('coding-agents — reasoning profile placeholders', () => {
  it('scout defaults to quick reasoning', () => {
    expect(scoutCodingAgent.reasoning?.default).toBe('quick');
  });

  it('generator/evaluator default to balanced', () => {
    expect(generatorCodingAgent.reasoning?.default).toBe('balanced');
    expect(evaluatorCodingAgent.reasoning?.default).toBe('balanced');
  });
});
