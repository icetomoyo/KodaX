/**
 * Placeholder Agent declarations for the internal task-engine roles
 * (Scout / Planner / Generator / Evaluator).
 *
 * FEATURE_080 (v0.7.23): these declarations exist so the role identities
 * are represented as Layer A `Agent` data, which downstream features need:
 *
 *   - FEATURE_084 (v0.7.26): runtime rewrite of Scout/Planner/Generator/
 *     Evaluator on top of `Runner` consumes these declarations as the
 *     source of truth for role metadata.
 *   - FEATURE_078 (v0.7.29): reasoning profiles attach to the `reasoning`
 *     field on these declarations.
 *   - FEATURE_087+ self-construction: Agent-as-data means role specs can
 *     be serialized, versioned, and mutated.
 *
 * Runtime note: **no preset dispatcher is registered for these agents**.
 * They are declarative placeholders. `Runner.run(scoutAgent, ...)` without
 * an `opts.llm` callback will throw the generic "no dispatcher" error;
 * that's intentional — the current task-engine executes these roles via
 * its existing internal flow, not through `Runner`. FEATURE_084 wires the
 * Runner runtime to these declarations.
 *
 * `instructions` strings here are short identifier-level summaries — the
 * full role prompts live in
 * `packages/coding/src/task-engine/_internal/prompts/role-prompt.ts` (the
 * FEATURE_079 extraction) and are loaded by the existing code path.
 */

import { createAgent, type Agent } from './agent.js';

export const SCOUT_AGENT_NAME = 'kodax/role/scout';
export const PLANNER_AGENT_NAME = 'kodax/role/planner';
export const GENERATOR_AGENT_NAME = 'kodax/role/generator';
export const EVALUATOR_AGENT_NAME = 'kodax/role/evaluator';

/**
 * Scout role declaration. Scout is the AMA entry point that both judges
 * task complexity and executes the H0 direct case; on H1/H2 it hands off
 * to Generator or Planner (see FEATURE_061).
 */
export const scoutAgent: Agent = createAgent({
  name: SCOUT_AGENT_NAME,
  instructions:
    'AMA entry role: judge task complexity, execute H0 direct tasks, '
    + 'hand off to Generator (H1) or Planner (H2) when complexity requires it.',
});

/**
 * Planner role declaration. Produces an execution plan consumed by
 * Generator in the H2 harness.
 */
export const plannerAgent: Agent = createAgent({
  name: PLANNER_AGENT_NAME,
  instructions:
    'H2 role: produce a structured execution plan from task context, '
    + 'constraints, and repo intelligence signals.',
});

/**
 * Generator role declaration. Performs the actual code changes /
 * investigations in both H1 and H2 harnesses.
 */
export const generatorAgent: Agent = createAgent({
  name: GENERATOR_AGENT_NAME,
  instructions:
    'H1/H2 execution role: apply tool calls to satisfy the task contract, '
    + 'emit managed-protocol evidence, converge to a final answer.',
});

/**
 * Evaluator role declaration. Lightweight verifier in H1, structured
 * revise/replan gate in H2.
 */
export const evaluatorAgent: Agent = createAgent({
  name: EVALUATOR_AGENT_NAME,
  instructions:
    'H1/H2 verifier role: check generator output against the verification '
    + 'contract, emit revise / replan verdicts when needed.',
});

/** All four placeholder role agents, exposed for iteration in downstream features. */
export const TASK_ENGINE_ROLE_AGENTS = Object.freeze({
  scout: scoutAgent,
  planner: plannerAgent,
  generator: generatorAgent,
  evaluator: evaluatorAgent,
} as const);
