/**
 * Coding Agent declarations — FEATURE_084 (v0.7.26).
 *
 * **These are declarative references exposing the canonical Scout /
 * Planner / Generator / Evaluator topology to SDK consumers.** Each
 * exported Agent carries the role's emit tool + the H0/H1/H2 handoff
 * graph, but carries ONLY a short identifier `instructions` string and
 * NO coding tools (read / grep / bash / write / edit / etc.).
 *
 * **The runtime agents are built fresh by
 * `task-engine/runner-driven.ts::buildRunnerAgentChain` on every run**,
 * with:
 *   - full v0.7.22-parity `instructions` via
 *     `_internal/managed-task/role-prompt.ts::createRolePrompt` (dynamic
 *     closure resolving decision / contract / metadata / verification /
 *     tool-policy / evidence-strategy / dispatch guidance per turn)
 *   - per-run coding tools (read / grep / glob / bash / write / edit /
 *     dispatch_child_task) wrapped with budget + mutation tracking +
 *     progress reporting
 *   - recorder-wrapped emit tools that drive the budget-extension
 *     dialog + degraded-continue logic
 *
 * So these exports are **useful as topology documentation and as a
 * starting point for custom Runner invocations** (e.g. Runner.run with
 * your own llm adapter), but they are NOT the agents that run under
 * normal AMA dispatch. Do not expect wrapping `scoutCodingAgent` to
 * give you the behaviour of an in-SDK AMA run — for that, use
 * `runManagedTaskViaRunner` or the preset dispatcher on
 * `createDefaultCodingAgent`.
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
