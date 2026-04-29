/**
 * FEATURE_089 (v0.7.31) Phase 3.4 — Constructed Agent Resolver.
 *
 * Module-singleton registry mapping `name` → runnable `Agent` for
 * agents that have passed admission and been activated through
 * `ConstructionRuntime.activate()`. Mirrors the way TOOL_REGISTRY
 * holds activated constructed tools, but for agents.
 *
 * Why a separate registry (not in TOOL_REGISTRY):
 *
 *   - Tools and Agents are different runtime types. A `KodaXToolDefinition`
 *     has `input_schema` + `handler`; an `Agent` has `instructions` +
 *     `tools` + `handoffs` + `reasoning`. Conflating them would force
 *     consumers to discriminate on every lookup.
 *   - Resolution semantics differ: a tool lookup returns the executable
 *     handler; an agent lookup returns the declarative spec (Runner.run
 *     drives the loop separately).
 *
 * Resolution surface:
 *
 *   - `resolveConstructedAgent(name)`     — name → Agent | undefined
 *   - `listConstructedAgents()`           — snapshot of activated agents
 *   - `registerConstructedAgent(artifact)` → unregister fn (called by
 *      runtime on activate, captured in the runtime's `_activated` map)
 *   - `_resetAgentResolverForTesting()`   — test isolation
 *
 * Tool / handoff ref resolution:
 *   - Tool refs are resolved against TOOL_REGISTRY at activation time —
 *     a snapshot. If a referenced tool is later revoked, the agent
 *     keeps its stale ref; Phase 3.5 sandbox testing catches this.
 *   - Handoff target refs lift to stub Agent objects (`name` only) when
 *     the target hasn't been activated yet. Transitive admission ran
 *     at test time so the graph is known to be acyclic; runtime
 *     traversal just walks the names.
 *
 * Non-goal: full referential consistency between tools / agents /
 * handoffs. The threat model is single-user CLI integrity (DD §14.5);
 * stale refs are an LLM-authoring footgun, not a security bypass.
 */

import type { Agent, AgentTool, Handoff } from '@kodax/core';

import { getRegisteredToolDefinition } from '../tools/registry.js';

import type { AgentArtifact, AgentContent, AgentHandoffRef, ToolRef } from './types.js';

const AGENT_REGISTRY = new Map<string, RegisteredConstructedAgent>();

interface RegisteredConstructedAgent {
  readonly artifact: AgentArtifact;
  readonly agent: Agent;
}

/**
 * Look up an activated constructed agent by name. Returns the
 * resolved `Agent` (with tools / handoffs lifted from refs). Returns
 * `undefined` when no agent at that name has been activated.
 */
export function resolveConstructedAgent(name: string): Agent | undefined {
  return AGENT_REGISTRY.get(name)?.agent;
}

/**
 * Snapshot of all currently-active constructed agents. Returned array
 * is freshly constructed; mutations to it do NOT affect the registry.
 */
export function listConstructedAgents(): readonly Agent[] {
  return Array.from(AGENT_REGISTRY.values()).map((e) => e.agent);
}

/**
 * Test-only reset. Clears the registry to empty.
 * Production code MUST NOT call this.
 */
export function _resetAgentResolverForTesting(): void {
  AGENT_REGISTRY.clear();
}

/**
 * Resolve a single ToolRef against the live tool registry. Builtin and
 * constructed tools both live in TOOL_REGISTRY; the resolver doesn't
 * distinguish at lookup time. Returns a structural `AgentTool` shape
 * (KodaXToolDefinition without the handler — Runner doesn't execute
 * tools through Agent.tools, it dispatches through TOOL_REGISTRY).
 *
 * Returns `undefined` for refs that don't resolve. Callers can decide
 * whether to skip silently or surface a warning.
 */
function liftToolRef(ref: ToolRef): AgentTool | undefined {
  const colon = ref.ref.indexOf(':');
  const name = colon === -1 ? ref.ref : ref.ref.slice(colon + 1).split('@')[0]!;
  const registered = getRegisteredToolDefinition(name);
  if (!registered) return undefined;
  // AgentTool === KodaXToolDefinition (see @kodax/core/agent.ts:33),
  // shape: { name, description, input_schema }. We strip the runtime
  // `handler` field — Runner.run resolves tools by name through
  // TOOL_REGISTRY at execute time, so the AgentTool entry only carries
  // the schema shape the LLM provider needs to know about.
  return {
    name: registered.name,
    description: registered.description,
    input_schema: registered.input_schema,
  };
}

/**
 * Resolve a handoff ref to its target Agent. If the target is another
 * activated constructed agent, return that. If it's a builtin role
 * (scout / planner / generator / evaluator) the resolver doesn't have
 * a registry of those today — return a stub Agent with the parsed
 * name. Runner.run consumers that need the real builtin Agent should
 * supply it via their own resolution layer.
 */
function liftHandoffRef(ref: AgentHandoffRef): Handoff {
  const colon = ref.target.ref.indexOf(':');
  const name = colon === -1
    ? ref.target.ref
    : ref.target.ref.slice(colon + 1).split('@')[0]!;
  const registered = AGENT_REGISTRY.get(name);
  const target: Agent = registered?.agent ?? { name, instructions: '' };
  return {
    target,
    kind: ref.kind,
    description: ref.description,
  };
}

/**
 * Build the runnable `Agent` from an `AgentContent` body. Pure function
 * over the registry's current state — call at activation time, store
 * the result, don't recompute on every resolve.
 */
function buildAgentFromContent(name: string, content: AgentContent): Agent {
  const tools: AgentTool[] = [];
  if (content.tools) {
    for (const ref of content.tools) {
      const lifted = liftToolRef(ref);
      if (lifted) tools.push(lifted);
      // Silently skip unresolved refs: ref drift is an LLM-authoring
      // footgun, not a runtime bypass. Sandbox testing surfaces these.
    }
  }
  const handoffs = content.handoffs?.map(liftHandoffRef);
  return {
    name,
    instructions: content.instructions,
    ...(tools.length > 0 ? { tools } : {}),
    ...(handoffs && handoffs.length > 0 ? { handoffs } : {}),
    ...(content.reasoning ? { reasoning: content.reasoning } : {}),
    ...(content.guardrails
      ? {
          guardrails: content.guardrails.map((g) => {
            const colon = g.ref.indexOf(':');
            return {
              kind: g.kind,
              name: colon === -1 ? g.ref : g.ref.slice(colon + 1).split('@')[0]!,
            };
          }),
        }
      : {}),
    ...(content.model ? { model: content.model } : {}),
    ...(content.provider ? { provider: content.provider } : {}),
    ...(content.outputSchema ? { outputSchema: content.outputSchema } : {}),
  };
}

/**
 * Register a constructed agent. Replaces any existing entry at the
 * same name (idempotent — re-activate of the same name+version is a
 * no-op for the resolver). Returns an unregister callback the
 * ConstructionRuntime stores in its `_activated` map.
 *
 * Called from `runtime.ts::registerActiveAgentArtifact` — the resolver
 * does NOT itself enforce that the artifact has been admitted; that's
 * the runtime's responsibility (testedAt precondition + admission audit
 * during `testAgentArtifact`).
 */
export function registerConstructedAgent(artifact: AgentArtifact): () => void {
  const agent = buildAgentFromContent(artifact.name, artifact.content);
  AGENT_REGISTRY.set(artifact.name, { artifact, agent });
  return () => {
    const current = AGENT_REGISTRY.get(artifact.name);
    if (current && current.artifact.version === artifact.version) {
      AGENT_REGISTRY.delete(artifact.name);
    }
    // If a different version is now active under the same name, leave
    // it alone — this unregister callback is stale.
  };
}
