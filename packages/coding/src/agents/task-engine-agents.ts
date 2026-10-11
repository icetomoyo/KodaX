/**
 * Role-name constants for the coding-AMA task-engine.
 *
 * FEATURE_193 v0.7.43: V1 chain (Scout/Planner/Generator) retired — the
 * placeholder Agent declarations are deleted, but the name constants
 * (`SCOUT_AGENT_NAME` / `PLANNER_AGENT_NAME` / `GENERATOR_AGENT_NAME`) survive
 * as string literals so historical session ids can still parse.
 *
 * Worker is the only live placeholder Agent — the runtime Worker (with full
 * tool set, handoffs, mutation guards) is constructed in
 * `task-engine/runner-driven.ts::buildRunnerAgentChain`.
 */

import { createAgent, type Agent } from '@kodax-ai/agent';

export const SCOUT_AGENT_NAME = 'kodax/role/scout';
export const PLANNER_AGENT_NAME = 'kodax/role/planner';
export const GENERATOR_AGENT_NAME = 'kodax/role/generator';
export const WORKER_AGENT_NAME = 'kodax/role/worker';

export const workerAgent: Agent = createAgent({
  name: WORKER_AGENT_NAME,
  instructions:
    'KodaX single primary role: plan via todo_update, execute via tool calls, '
    + 'verify the actual result, then terminate text-only when done.',
});

/** Worker role agent exposed for iteration in downstream features. */
export const TASK_ENGINE_ROLE_AGENTS = Object.freeze({
  worker: workerAgent,
} as const);
