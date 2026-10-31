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

import type { Agent, AgentManifest, AgentTool, Handoff, InvariantId } from '@kodax-ai/agent';
import {
  _resetAdmittedAgentBindings,
  normalizeAgentReasoningProfile,
  setAdmittedAgentBindings,
} from '@kodax-ai/agent';
import { workerAgent } from '../agents/task-engine-agents.js';

import { getRegisteredToolDefinition } from '../tools/registry.js';

import type { AgentArtifact, AgentContent, AgentHandoffRef, ToolRef } from './types.js';

/**
 * FEATURE_101 v0.7.31.1 — builtin agent registry.
 *
 * Maps the 3 v1 builtin role names (scout/planner/generator) to their
 * `@kodax-ai/core/task-engine-agents` declarations. Constructed agents
 * that handoff to a builtin role (e.g. `target: { ref: 'builtin:scout' }`)
 * get the real role declaration here instead of a phantom stub
 * `{ name, instructions: '' }`. FEATURE_184 Phase C.1 (v0.7.45): evaluator
 * removed from chain and from this map.
 *
 * Without this map, builtin handoffs silently degraded — admission's
 * handoffLegality DAG check passed because the stub had no outgoing
 * edges, but the runtime resolution returned a no-op agent. Whatever
 * tools / instructions the builtin role contributes were missing from
 * the constructed-agent's downstream context.
 *
 * The map is also keyed on the short alias (`scout`) and the
 * `kodax/role/<x>` canonical form so refs written either way resolve.
 */
// FEATURE_184 Phase C.1: evaluatorAgent removed; FEATURE_193 v0.7.43: V1
// chain (Scout/Planner/Generator) Agent declarations retired. Worker is the
// only builtin agent now; unknown refs fall through to the stub path
// (empty instructions) — correct behavior since no other in-chain agent exists.
const BUILTIN_AGENTS: ReadonlyMap<string, Agent> = new Map<string, Agent>([
  ['worker', workerAgent],
  ['kodax/role/worker', workerAgent],
]);

const AGENT_REGISTRY = new Map<string, RegisteredConstructedAgent>();

/**
 * FEATURE_090 (v0.7.32) — pending registry for self-modify activations.
 *
 * Self-modify activations register here instead of `AGENT_REGISTRY` so
 * the in-flight `Runner.run` that initiated the change keeps using the
 * pre-self-modify Agent reference. `drainPendingSwaps()` promotes every
 * pending entry into `AGENT_REGISTRY` and is expected to be called by
 * the REPL surface once the top-level run completes. Within KodaX's
 * single-user / single-process CLI threat model that is "the run that
 * triggered the change finishes" — there is no concurrent run to
 * coordinate with.
 *
 * Why a separate map (not a flag inside the active entry):
 *   - Lookups (`resolveConstructedAgent`, `liftHandoffRef`) MUST keep
 *     returning the prior version while a swap is pending. A flag-on-
 *     entry approach would force every lookup to discriminate
 *     `pending ? prev : current`, scattering the rule across the file.
 *   - The drain operation is a single map move; a flag would require
 *     mutating in place and re-firing the resolver bindings.
 */
const _pendingSwap = new Map<string, RegisteredConstructedAgent>();

interface RegisteredConstructedAgent {
  readonly artifact: AgentArtifact;
  readonly agent: Agent;
  /**
   * FEATURE_191 — in-memory only source tag (not persisted to disk).
   * `undefined` when register caller doesn't supply one (legacy /
   * test path); production loaders pass an explicit tag.
   */
  readonly source?: ConstructedAgentSource;
  readonly toolPolicy?: ConstructedAgentToolPolicy;
}

export interface ConstructedAgentToolPolicy {
  readonly declaredTools: boolean;
  readonly effectiveToolNames: readonly string[];
}

export interface KodaXAgentScope {
  readonly kind: 'constructed-agent-scope';
  readonly id: string;
  readonly disposed: boolean;
  resolve(name: string): ConstructedAgentEntry | undefined;
  list(): readonly ConstructedAgentEntry[];
  dispose(): void;
}

/**
 * FEATURE_191 — registration source enum. Used in-memory to disambiguate
 * which loader registered an agent so REPL `/agents list` can group by
 * origin and same-name precedence is enforced via load order rather
 * than a precedence stack. Not persisted to `AgentArtifact` (the
 * artifact schema stays untouched to avoid migration).
 *
 * Load-order convention (boot path registers in this order; subsequent
 * registrations overwrite earlier ones via last-write-wins):
 *   built-in < extension < markdown:user < markdown:project <
 *   constructed:cli < constructed:llm
 */
export type ConstructedAgentSource =
  | 'built-in'
  | 'extension'
  | 'markdown:user'
  | 'markdown:project'
  | 'constructed:cli'
  | 'constructed:llm';

/**
 * Look up an activated constructed agent by name. Returns the
 * resolved `Agent` (with tools / handoffs lifted from refs). Returns
 * `undefined` when no agent at that name has been activated.
 */
export function resolveConstructedAgent(
  name: string,
  scope?: KodaXAgentScope,
): Agent | undefined {
  if (scope) {
    return scope.resolve(name)?.agent;
  }
  return AGENT_REGISTRY.get(name)?.agent;
}

/**
 * Snapshot of all currently-active constructed agents. Returned array
 * is freshly constructed; mutations to it do NOT affect the registry.
 */
export function listConstructedAgents(scope?: KodaXAgentScope): readonly Agent[] {
  if (scope) {
    return scope.list().map((e) => e.agent);
  }
  return Array.from(AGENT_REGISTRY.values()).map((e) => e.agent);
}

/**
 * FEATURE_191 — enriched snapshot exposing both the resolved Agent and
 * the in-memory source tag. Consumers that need provenance (REPL
 * `/agents list --by-source`, debug surfaces) call this instead of
 * `listConstructedAgents()`. The plain-Agent list keeps its signature
 * for backward compatibility with all pre-FEATURE_191 callers.
 *
 * @internal v0.7.43 surface — exposed for the planned v0.7.46+
 * `/agents list` REPL command and for source-tag round-trip tests
 * (see `agent-resolver.test.ts` FEATURE_191 B.3 block). NOT yet a
 * stable SDK surface; embedders SHOULD continue using
 * `listConstructedAgents()` (which is byte-identical post-F191).
 * Promoted to public when the REPL `/agents list` consumer ships.
 */
export interface ConstructedAgentEntry {
  readonly agent: Agent;
  readonly source: ConstructedAgentSource | undefined;
  readonly toolPolicy?: ConstructedAgentToolPolicy;
}

/**
 * Explicit specialist tool ceiling. `undefined` means no declared policy;
 * an empty array is an intentional deny-all ceiling.
 */
export function constructedAgentToolCeiling(
  entry: ConstructedAgentEntry,
): readonly string[] | undefined {
  if (entry.toolPolicy?.declaredTools === true) {
    return entry.toolPolicy.effectiveToolNames;
  }
  const names = entry.agent.tools?.map((tool) => tool.name) ?? [];
  return names.length > 0 ? names : undefined;
}

/** @internal — see {@link ConstructedAgentEntry} */
export function listConstructedAgentsWithSource(
  scope?: KodaXAgentScope,
): readonly ConstructedAgentEntry[] {
  if (scope) {
    return scope.list();
  }
  return Array.from(AGENT_REGISTRY.values()).map((e) => ({
    agent: e.agent,
    source: e.source,
    ...(e.toolPolicy ? { toolPolicy: e.toolPolicy } : {}),
  }));
}

/**
 * FEATURE_191 — single-agent source lookup. `undefined` when the agent
 * is not registered OR was registered without a source tag (legacy
 * caller). Surfaces for code paths that want to discriminate on
 * provenance without iterating the full registry.
 *
 * @internal — same v0.7.43 staging policy as
 * {@link listConstructedAgentsWithSource}.
 */
export function resolveConstructedAgentSource(
  name: string,
  scope?: KodaXAgentScope,
): ConstructedAgentSource | undefined {
  if (scope) {
    return scope.resolve(name)?.source;
  }
  return AGENT_REGISTRY.get(name)?.source;
}

export function resolveConstructedAgentEntry(
  name: string,
  scope?: KodaXAgentScope,
): ConstructedAgentEntry | undefined {
  if (scope) {
    return scope.resolve(name);
  }
  const entry = AGENT_REGISTRY.get(name);
  if (!entry) return undefined;
  return {
    agent: entry.agent,
    source: entry.source,
    ...(entry.toolPolicy ? { toolPolicy: entry.toolPolicy } : {}),
  };
}

/**
 * Test-only reset. Clears the registry to empty.
 * Production code MUST NOT call this.
 */
export function _resetAgentResolverForTesting(): void {
  for (const entry of AGENT_REGISTRY.values()) {
    _resetAdmittedAgentBindings(entry.agent);
  }
  AGENT_REGISTRY.clear();
  for (const entry of _pendingSwap.values()) {
    _resetAdmittedAgentBindings(entry.agent);
  }
  _pendingSwap.clear();
}

/**
 * FEATURE_090 — `true` iff a self-modify activation has been staged
 * for `name` but has not yet been drained into the active registry.
 * Surfaces for tooling that wants to display "next run will use
 * version X" hints, and as a sanity-check assertion in tests.
 */
export function hasPendingSwap(name: string): boolean {
  return _pendingSwap.has(name);
}

/**
 * FEATURE_090 — promote every pending self-modify entry into
 * `AGENT_REGISTRY`, replacing the prior active version. Returns the
 * names that were drained so the caller can surface a hint
 * ("alpha is now running version 1.1.0").
 *
 * Idempotent: calling on an empty pending map is a no-op. Atomic at
 * the JS event-loop level (a single synchronous pass); drain cannot
 * partially complete.
 *
 * Integration contract: the REPL surface calls this immediately after
 * any top-level `Runner.run` returns. KodaX is single-process and
 * single-user, so "the run that triggered the change" and "all
 * in-flight runs" are the same set — no concurrent-run coordination
 * needed.
 */
export function drainPendingSwaps(): readonly string[] {
  if (_pendingSwap.size === 0) return [];
  const drained: string[] = [];
  for (const [name, pending] of _pendingSwap) {
    const prior = AGENT_REGISTRY.get(name);
    if (prior) {
      _resetAdmittedAgentBindings(prior.agent);
    }
    AGENT_REGISTRY.set(name, pending);
    drained.push(name);
  }
  _pendingSwap.clear();
  return drained;
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
  // AgentTool === KodaXToolDefinition (see @kodax-ai/core/agent.ts:33),
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
 * Resolve a handoff ref to its target Agent.
 *
 * Resolution order (FEATURE_101 v0.7.31.1):
 *   1. `builtin:<role>` → look up in BUILTIN_AGENTS (returns the real
 *      `@kodax-ai/core` task-engine declaration with full instructions /
 *      reasoning profile).
 *   2. `constructed:<name>[@version]` → look up in AGENT_REGISTRY
 *      (returns the activated constructed agent).
 *   3. Bare ref / unknown scheme → fall back to a stub `{ name,
 *      instructions: '' }`. The stub keeps the handoff graph traversable
 *      for admission's name-only DAG check; runtime consumers that need
 *      to actually invoke the target see the empty instructions and
 *      can decide how to handle (typically: skip).
 *
 * Pre-patch behaviour silently degraded builtin refs to stubs — fixed
 * here so `Runner.run` on a constructed agent that handoffs to a builtin
 * gets the real role declaration.
 */
function liftHandoffRef(ref: AgentHandoffRef): Handoff {
  const colon = ref.target.ref.indexOf(':');
  const scheme = colon === -1 ? '' : ref.target.ref.slice(0, colon);
  const tail = colon === -1 ? ref.target.ref : ref.target.ref.slice(colon + 1);
  const at = tail.indexOf('@');
  const name = at === -1 ? tail : tail.slice(0, at);

  let target: Agent;
  if (scheme === 'builtin') {
    target = BUILTIN_AGENTS.get(name) ?? { name, instructions: '' };
  } else {
    const registered = AGENT_REGISTRY.get(name);
    target = registered?.agent ?? { name, instructions: '' };
  }
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
    ...(content.reasoning ? { reasoning: normalizeAgentReasoningProfile(content.reasoning) } : {}),
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
    ...(content.effort ? { effort: content.effort } : {}),
    ...(content.outputSchema ? { outputSchema: content.outputSchema } : {}),
    // FEATURE_191 — propagate description so the Worker SP `specialist-
    // agents` capability section (`prompts/capability-sections.ts`) can
    // surface it without re-reading the source artifact.
    ...(content.description ? { description: content.description } : {}),
  };
}

/**
 * Optional admission metadata attached at registration time so
 * `Runner.run` can dispatch observe / assertTerminal hooks for the
 * agent. Required for FEATURE_101 v0.7.31.1 runtime invariant
 * enforcement; omitting it (e.g. in legacy tests) leaves the agent
 * trusted from the Runner's perspective — invariants only run during
 * admit, and observe/terminal silently skip.
 */
export interface ConstructedAgentRegistration {
  readonly bindings?: readonly InvariantId[];
  readonly manifest?: AgentManifest;
  /**
   * FEATURE_191 — in-memory source tag for provenance tracking.
   * Optional so the FEATURE_089 / FEATURE_090 / FEATURE_101 legacy
   * callers and unit tests that bypass admission can omit it. When
   * present, surfaces via `listConstructedAgentsWithSource()` /
   * `resolveConstructedAgentSource(name)`.
   */
  readonly source?: ConstructedAgentSource;
}

/**
 * FEATURE_090 — registration options. `deferred=true` routes the new
 * Agent into the pending swap map instead of the active registry, so
 * lookups continue to return the prior active version until the next
 * `drainPendingSwaps()` call. Used by the self-modify activate path
 * so the in-flight Runner.run that triggered the modification keeps
 * its captured Agent reference consistent until termination.
 */
export interface ConstructedAgentRegisterOptions {
  readonly deferred?: boolean;
}

function buildToolPolicy(
  content: AgentContent,
  agent: Agent,
): ConstructedAgentToolPolicy | undefined {
  if (content.tools === undefined) {
    return undefined;
  }
  return {
    declaredTools: true,
    effectiveToolNames: agent.tools?.map((tool) => tool.name) ?? [],
  };
}

export function createConstructedAgentEntry(
  artifact: AgentArtifact,
  registration: ConstructedAgentRegistration = {},
): ConstructedAgentEntry {
  const agent = buildAgentFromContent(artifact.name, artifact.content);
  if (registration.bindings && registration.manifest) {
    setAdmittedAgentBindings(agent, registration.manifest, registration.bindings);
  }
  const toolPolicy = buildToolPolicy(artifact.content, agent);
  return {
    agent,
    source: registration.source,
    ...(toolPolicy ? { toolPolicy } : {}),
  };
}

export function releaseConstructedAgentEntry(entry: ConstructedAgentEntry): void {
  _resetAdmittedAgentBindings(entry.agent);
}

export function createConstructedAgentScope(input: {
  readonly id: string;
  readonly entries: readonly ConstructedAgentEntry[];
  readonly ownedEntries?: readonly ConstructedAgentEntry[];
}): KodaXAgentScope {
  const byName = new Map(input.entries.map((entry) => [entry.agent.name, entry]));
  const ownedEntries = new Set(input.ownedEntries ?? input.entries);
  let disposed = false;
  return {
    kind: 'constructed-agent-scope',
    id: input.id,
    get disposed() {
      return disposed;
    },
    resolve(name) {
      if (disposed) return undefined;
      return byName.get(name);
    },
    list() {
      if (disposed) return [];
      return Array.from(byName.values());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of ownedEntries) {
        releaseConstructedAgentEntry(entry);
      }
      byName.clear();
      ownedEntries.clear();
    },
  };
}

/**
 * Register a constructed agent. Replaces any existing entry at the
 * same name (idempotent — re-activate of the same name+version is a
 * no-op for the resolver). Returns an unregister callback the
 * ConstructionRuntime stores in its `_activated` map.
 *
 * @internal SDK consumers MUST go through an admission-enforcing entry
 * point:
 *   - `loadAgentsFromMarkdown(opts)` — user/project markdown loader
 *     (FEATURE_191 Phase B)
 *   - `KodaXExtensionAPI.registerAgent(name, content)` — extension API
 *     (FEATURE_191 Phase C)
 *   - `activate()` in `construction/runtime.ts` — CLI / LLM-constructed
 *     agents (FEATURE_087-090 / 101)
 *
 * Calling this function directly bypasses `Runner.admit` and is
 * intended ONLY for resolver-only unit coverage (omitting
 * `registration` exercises the trusted-agent silent-skip path, which
 * has no observe / assertTerminal hooks). Production code path was
 * audited 2026-05-23 in the F191 final review; all production callers
 * thread `{ bindings, manifest }` from `Runner.admit`.
 *
 * Threat model context (`feedback_review_threat_model`): KodaX is a
 * single-user CLI. Bypass-availability is not an attack surface in
 * this model — all in-process code runs at the same privilege as the
 * user. The `@internal` marker exists to keep SDK consumers on the
 * admission-enforcing entry points so a future multi-tenant evolution
 * does not require renaming the only production-safe API.
 *
 * Called from `runtime.ts::registerActiveAgentArtifact` — the resolver
 * does NOT itself enforce that the artifact has been admitted; that's
 * the runtime's responsibility (testedAt precondition + admission audit
 * during `testAgentArtifact`).
 *
 * FEATURE_101 v0.7.31.1: `registration.bindings` + `registration.manifest`
 * carry the AdmittedHandle output produced by `Runner.admit` at activate
 * time, threaded through so the resolved Agent can dispatch observe /
 * assertTerminal hooks at run time. The runtime calls this with both
 * fields populated; tests that bypass admission (e.g. resolver-only
 * unit coverage) may omit them and accept the trusted-agent semantics.
 */
export function registerConstructedAgent(
  artifact: AgentArtifact,
  registration: ConstructedAgentRegistration = {},
  options: ConstructedAgentRegisterOptions = {},
): () => void {
  const entry = createConstructedAgentEntry(artifact, registration);

  // FEATURE_090 — deferred path stages into `_pendingSwap` instead of
  // touching the active registry. Lookups (resolveConstructedAgent,
  // liftHandoffRef) still see the prior active version until
  // `drainPendingSwaps()` runs.
  const target = options.deferred ? _pendingSwap : AGENT_REGISTRY;
  target.set(artifact.name, {
    artifact,
    agent: entry.agent,
    // FEATURE_191 — persist source tag from registration arg (may be
    // undefined for legacy callers; absent source surfaces as
    // undefined through listConstructedAgentsWithSource).
    source: entry.source,
    ...(entry.toolPolicy ? { toolPolicy: entry.toolPolicy } : {}),
  });

  return () => {
    // The unregister callback must work whether the entry is currently
    // pending (deferred and not yet drained) or active (drained, or
    // registered without deferral). Check pending first so a "revoke
    // before drain" path doesn't accidentally match against a stale
    // active version that happens to share the same name.
    const pending = _pendingSwap.get(artifact.name);
    if (pending && pending.artifact.version === artifact.version) {
      _resetAdmittedAgentBindings(pending.agent);
      _pendingSwap.delete(artifact.name);
      return;
    }
    const current = AGENT_REGISTRY.get(artifact.name);
    if (current && current.artifact.version === artifact.version) {
      _resetAdmittedAgentBindings(current.agent);
      AGENT_REGISTRY.delete(artifact.name);
    }
    // If a different version is now active/pending under the same
    // name, leave it alone — this unregister callback is stale.
  };
}
