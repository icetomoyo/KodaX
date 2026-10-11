/**
 * Unit test for task-engine role Agent placeholders.
 *
 * FEATURE_193 v0.7.43: V1 chain (Scout/Planner/Generator) Agent placeholders
 * retired. The name constants survive for historical
 * session id compat; Worker is the only declarative Agent now.
 */

import { describe, expect, it } from 'vitest';

import { Runner } from '@kodax-ai/agent';
import {
  WORKER_AGENT_NAME,
  TASK_ENGINE_ROLE_AGENTS,
  workerAgent,
} from './task-engine-agents.js';

describe('task-engine role agents', () => {
  it('Worker has a stable name', () => {
    expect(workerAgent.name).toBe(WORKER_AGENT_NAME);
  });

  it('exposes Worker via TASK_ENGINE_ROLE_AGENTS', () => {
    expect(TASK_ENGINE_ROLE_AGENTS.worker).toBe(workerAgent);
  });

  it('Worker has non-empty instructions', () => {
    expect(typeof workerAgent.instructions).toBe('string');
    expect((workerAgent.instructions as string).length).toBeGreaterThan(0);
  });

  it('has no preset dispatcher registered (Worker is a placeholder — runtime Worker is built by buildRunnerAgentChain)', async () => {
    await expect(Runner.run(workerAgent, 'test'))
      .rejects.toThrow(/no registered preset dispatcher/);
  });
});
