/**
 * Unit test for task-engine role Agent placeholders (FEATURE_080 v0.7.23).
 *
 * These are declarative-only; no preset dispatcher is registered. Verifies:
 *   - Each role has a stable name the runtime can dispatch against later.
 *   - `TASK_ENGINE_ROLE_AGENTS` exposes all four roles.
 *   - Without a preset or `opts.llm`, Runner.run throws the standard
 *     "no dispatcher" error — confirming these are placeholders, not live
 *     dispatch targets in v0.7.23.
 */

import { describe, expect, it } from 'vitest';

import { Runner } from './runner.js';
import {
  EVALUATOR_AGENT_NAME,
  GENERATOR_AGENT_NAME,
  PLANNER_AGENT_NAME,
  SCOUT_AGENT_NAME,
  TASK_ENGINE_ROLE_AGENTS,
  evaluatorAgent,
  generatorAgent,
  plannerAgent,
  scoutAgent,
} from './task-engine-agents.js';

describe('task-engine role agents', () => {
  it('has stable names for each role', () => {
    expect(scoutAgent.name).toBe(SCOUT_AGENT_NAME);
    expect(plannerAgent.name).toBe(PLANNER_AGENT_NAME);
    expect(generatorAgent.name).toBe(GENERATOR_AGENT_NAME);
    expect(evaluatorAgent.name).toBe(EVALUATOR_AGENT_NAME);
  });

  it('exposes all four roles via TASK_ENGINE_ROLE_AGENTS', () => {
    expect(TASK_ENGINE_ROLE_AGENTS.scout).toBe(scoutAgent);
    expect(TASK_ENGINE_ROLE_AGENTS.planner).toBe(plannerAgent);
    expect(TASK_ENGINE_ROLE_AGENTS.generator).toBe(generatorAgent);
    expect(TASK_ENGINE_ROLE_AGENTS.evaluator).toBe(evaluatorAgent);
  });

  it('each role has non-empty instructions', () => {
    for (const agent of Object.values(TASK_ENGINE_ROLE_AGENTS)) {
      expect(typeof agent.instructions).toBe('string');
      expect((agent.instructions as string).length).toBeGreaterThan(0);
    }
  });

  it('has no preset dispatcher registered (placeholders only in v0.7.23)', async () => {
    // Without llm + no preset registered, Runner.run must throw.
    await expect(Runner.run(scoutAgent, 'test'))
      .rejects.toThrow(/no registered preset dispatcher/);
  });
});
