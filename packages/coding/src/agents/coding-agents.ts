/**
 * Coding Agent declarations — FEATURE_084 Shard 2 (v0.7.26).
 *
 * Concrete Agent instances for Scout / Planner / Generator / Evaluator with
 * their protocol emitter tools + handoff topology wired in. These extend
 * the placeholder Agent identities exported from `@kodax/core`
 * (FEATURE_080 v0.7.23) by adding:
 *
 *   - `tools`: the role-specific protocol emitter (Shard 2). Additional
 *     coding tools (read / grep / bash / write / edit / ...) bind at Shard 5
 *     when the Runner-driven task engine lands.
 *   - `handoffs`: the continuation topology that encodes the H0/H1/H2 state
 *     machine as Agent-as-data. Runner (FEATURE_084 Shard 4) reads these to
 *     execute the role transitions.
 *   - `reasoning`: placeholder depth hints; full escalation behaviour lands
 *     with FEATURE_078 (v0.7.29).
 *
 * **Data-only at this shard.** Nothing runs these agents yet — the legacy
 * `runManagedTask` path is still the sole runtime. Shard 5 wires a new
 * runner-driven path behind `KODAX_MANAGED_TASK_RUNTIME=runner`.
 *
 * Note on `instructions`: the field carries the short identifier summary
 * from the core placeholder. The full role prompt (via `createRolePrompt`)
 * is bound at Shard 5 where runtime context (prompt / decision / verification
 * contract / tool policy) is available.
 */

import {
  EVALUATOR_AGENT_NAME,
  GENERATOR_AGENT_NAME,
  PLANNER_AGENT_NAME,
  SCOUT_AGENT_NAME,
  type Agent,
  type AgentReasoningProfile,
  type AgentTool,
  type Handoff,
} from '@kodax/core';

import {
  emitContract,
  emitHandoff,
  emitScoutVerdict,
  emitVerdict,
} from './protocol-emitters.js';

/** Marker exported for tests and for future binding sites in Shard 5. */
export const CODING_AGENT_MARKER = 'kodax-coding-agent@0.7.26' as const;

interface AgentSpec {
  readonly name: string;
  readonly instructions: string;
  readonly tools: readonly AgentTool[];
  readonly reasoning: AgentReasoningProfile;
}

const scoutSpec: AgentSpec = {
  name: SCOUT_AGENT_NAME,
  instructions:
    'AMA entry role: judge task complexity, execute H0 direct tasks, ' +
    'hand off to Generator (H1) or Planner (H2) when complexity requires it. ' +
    'Emit the scout verdict via the emit_scout_verdict tool exactly once.',
  tools: [emitScoutVerdict],
  reasoning: { default: 'quick', max: 'balanced', escalateOnRevise: false },
};

const plannerSpec: AgentSpec = {
  name: PLANNER_AGENT_NAME,
  instructions:
    'H2 role: produce a structured execution contract from task context, ' +
    'constraints, and repo intelligence signals. Emit the contract via ' +
    'emit_contract exactly once, then hand off to Generator.',
  tools: [emitContract],
  reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: true },
};

const generatorSpec: AgentSpec = {
  name: GENERATOR_AGENT_NAME,
  instructions:
    'H1/H2 execution role: apply tool calls to satisfy the task contract, ' +
    'produce evidence, converge to a final answer. Emit the handoff via ' +
    'emit_handoff exactly once when execution is complete or blocked.',
  tools: [emitHandoff],
  reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: true },
};

const evaluatorSpec: AgentSpec = {
  name: EVALUATOR_AGENT_NAME,
  instructions:
    'H1/H2 verifier role: check generator output against the verification ' +
    'contract. Emit the verdict via emit_verdict exactly once: accept to ' +
    'finalize, revise to retry (optionally escalating harness tier), or ' +
    'blocked when verification cannot complete.',
  tools: [emitVerdict],
  reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: false },
};

/**
 * Build the four agents with a shared mutable closure so handoffs can
 * reference each other without circular import contortions. The resulting
 * Agent objects are frozen before export.
 */
function createCodingAgents(): {
  scout: Agent;
  planner: Agent;
  generator: Agent;
  evaluator: Agent;
} {
  // Step 1 — create bare Agent objects for each role. `handoffs` is mutable
  // in-scope here and is filled in step 3.
  type WritableAgent = {
    -readonly [K in keyof Agent]: Agent[K];
  };

  const make = (spec: AgentSpec): WritableAgent => ({
    name: spec.name,
    instructions: spec.instructions,
    tools: spec.tools,
    reasoning: spec.reasoning,
    handoffs: undefined,
  });

  const scout = make(scoutSpec);
  const planner = make(plannerSpec);
  const generator = make(generatorSpec);
  const evaluator = make(evaluatorSpec);

  // Step 2 — declare handoff topology. Scout can escalate to Generator (H1)
  // or Planner (H2). Planner always hands off to Generator. Generator always
  // hands off to Evaluator. Evaluator can revise (back to Generator) or
  // replan (back to Planner).
  const scoutHandoffs: Handoff[] = [
    { target: generator, kind: 'continuation', description: 'Upgrade to H1 — execute + evaluate' },
    { target: planner, kind: 'continuation', description: 'Upgrade to H2 — plan + execute + evaluate' },
  ];
  const plannerHandoffs: Handoff[] = [
    { target: generator, kind: 'continuation', description: 'Hand off execution to Generator' },
  ];
  const generatorHandoffs: Handoff[] = [
    { target: evaluator, kind: 'continuation', description: 'Hand off to Evaluator for verification' },
  ];
  const evaluatorHandoffs: Handoff[] = [
    { target: generator, kind: 'continuation', description: 'revise — retry execution' },
    { target: planner, kind: 'continuation', description: 'replan — revise the contract' },
  ];

  // Step 3 — attach handoffs. This is the only mutation allowed; everything
  // is frozen immediately after.
  scout.handoffs = scoutHandoffs;
  planner.handoffs = plannerHandoffs;
  generator.handoffs = generatorHandoffs;
  evaluator.handoffs = evaluatorHandoffs;

  return {
    scout: Object.freeze(scout) as Agent,
    planner: Object.freeze(planner) as Agent,
    generator: Object.freeze(generator) as Agent,
    evaluator: Object.freeze(evaluator) as Agent,
  };
}

const AGENTS = createCodingAgents();

export const scoutCodingAgent: Agent = AGENTS.scout;
export const plannerCodingAgent: Agent = AGENTS.planner;
export const generatorCodingAgent: Agent = AGENTS.generator;
export const evaluatorCodingAgent: Agent = AGENTS.evaluator;

/**
 * Topology record — iterable form of the four coding agents. Shard 5's
 * Runner-driven dispatcher uses this as the agent lookup.
 */
export const CODING_AGENTS = Object.freeze({
  scout: scoutCodingAgent,
  planner: plannerCodingAgent,
  generator: generatorCodingAgent,
  evaluator: evaluatorCodingAgent,
} as const);
