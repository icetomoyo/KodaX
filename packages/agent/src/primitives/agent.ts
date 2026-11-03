/**
 * Layer A Primitive: Agent / Handoff / Guardrail / AgentReasoningProfile
 *
 * FEATURE_080 (v0.7.23): Agent-as-data types. Declarative dataclass shape.
 * The runtime counterpart is `Runner` in `./runner.ts`.
 *
 * History: extracted to `@kodax-ai/core` in FEATURE_082 (v0.7.24); merged back
 * into `@kodax-ai/agent` in v0.7.35.1 FEATURE_142 (single-consumer rule —
 * @kodax-ai/core had only @kodax-ai/coding as consumer). `@kodax-ai/coding` retains
 * a barrel re-export for batteries-included consumers.
 *
 * Status: @experimental — API shape may be refined during v0.7.x. Used by
 * the task-engine rewrite in FEATURE_084 (v0.7.26).
 *
 * Guardrail and AgentReasoningProfile are declared here but their runtime
 * behavior is deferred:
 *   - Guardrail runtime → FEATURE_085 (v0.7.26)
 *   - AgentReasoningProfile behavior → FEATURE_078 (v0.7.29)
 */

import type {
  KodaXMessage,
  KodaXReasoningMode,
  KodaXToolDefinition,
  KodaXWireReasoningEffort,
} from '@kodax-ai/llm';
import { mapLegacyReasoningModeToEffortIntent } from '@kodax-ai/llm';

/**
 * Reasoning depth / mode selector. Alias for `KodaXReasoningMode` to keep the
 * Layer A surface independent of the `KodaX*` brand; unified during the prefix
 * cleanup in FEATURE_086 (v0.7.27).
 */
/** @deprecated Compatibility alias for old SDK inputs; use KodaXWireReasoningEffort. */
export type ReasoningDepth = KodaXReasoningMode;

/**
 * Tool binding accepted by an `Agent`. Layer A treats tools as opaque
 * definitions; the executor lives in `@kodax-ai/coding` and is wired up by the
 * Runner when it dispatches through `runKodaX`.
 */
export type AgentTool = KodaXToolDefinition;

/**
 * Transport-level message reused from the AI layer. Kept as an alias so
 * consumers of the Layer A primitives do not need to import from `@kodax-ai/llm`
 * directly.
 */
export type AgentMessage = KodaXMessage;

/**
 * Declarative reasoning profile attached to an Agent.
 *
 * Effort-native defaults for explicitly declared specialist agents.
 * Built-in roots inherit the Session selection without a role profile.
 */
export interface AgentReasoningProfile {
  readonly default: KodaXWireReasoningEffort;
  readonly max?: KodaXWireReasoningEffort;
  /** @deprecated Accepted for old declarations; automatic role escalation is retired. */
  readonly escalateOnRevise?: boolean;
}

/** Compatibility intake for old SDK declarations and persisted agent manifests. */
export function normalizeAgentReasoningProfile(profile: AgentReasoningProfile): AgentReasoningProfile {
  return { ...profile, default: mapLegacyReasoningModeToEffortIntent(profile.default),
    ...(profile.max !== undefined ? { max: mapLegacyReasoningModeToEffortIntent(profile.max) } : {}) };
}

/**
 * Declarative middleware reference attached to an Agent.
 *
 * FEATURE_100 (v0.7.29) introduces this field so the coding preset
 * can declare the four substrate middlewares (auto-reroute,
 * mutation-reflection, pre-answer-judge, post-tool-judge) on the
 * Agent declaration itself. Today these middlewares fire inside
 * the substrate body; the declaration field serves as the
 * machine-readable contract that the substrate honours, and lets
 * SDK consumers introspect / override middleware policy without
 * touching `runKodaX` internals.
 *
 * `enabled` is the only knob today; future versions add config
 * payload as additional fields (kept declarative — no fn callbacks).
 */
export interface AgentMiddlewareDeclaration {
  readonly name: string;
  readonly enabled: boolean;
}

/**
 * Guardrail placeholder. Layer A declares the slot; the actual
 * input/output/tool-call gating runtime lives in FEATURE_085 (v0.7.26).
 *
 * A guardrail targets one of three hook points:
 *   - `input`: inspect / veto prompts before they enter the agent loop.
 *   - `output`: inspect / rewrite assistant messages before they leave.
 *   - `tool`: inspect / veto tool invocations during the loop.
 */
export interface Guardrail {
  readonly kind: 'input' | 'output' | 'tool';
  readonly name: string;
}

/**
 * Handoff between Agents.
 *
 *   - `continuation`: ownership of the conversation transfers to `target` and
 *     the caller exits. Mirrors the Scout → Generator upgrade path.
 *   - `as-tool`: `target` is invoked like a tool from within the caller loop;
 *     only the generated input is passed, and control returns on completion.
 *     Mirrors the bounded handoff used by an Actor Turn.
 *
 * `inputFilter` is applied to the visible history before the target runs;
 * default is no filtering.
 */
export interface Handoff<TTo = unknown> {
  readonly target: Agent<TTo>;
  readonly kind: 'continuation' | 'as-tool';
  readonly description?: string;
  readonly inputFilter?: (history: readonly AgentMessage[]) => readonly AgentMessage[];
}

/**
 * Agent-as-data. A declarative specification of "who is running, with which
 * instructions, tools, handoffs, and reasoning profile."
 *
 * Runtime note: in v0.7.23 the only Agent that is fully executed is the
 * built-in coding preset (`createDefaultCodingAgent()`), which dispatches
 * through `runKodaX`. Custom Agents defined by SDK consumers run through a
 * generic Runner loop with limited capabilities (LLM call + Agent-declared
 * tools only — no extensions, no managed-task harness). The full runtime
 * arrives with FEATURE_084 (v0.7.26).
 */
export interface Agent<TContext = unknown> {
  readonly name: string;
  readonly instructions: string | ((ctx: TContext) => string);
  readonly tools?: readonly AgentTool[];
  readonly handoffs?: readonly Handoff[];
  readonly reasoning?: AgentReasoningProfile;
  readonly guardrails?: readonly Guardrail[];
  /**
   * FEATURE_191 — one-sentence human-readable summary surfaced to
   * other agents that may select this one (e.g., via
   * `spawn_agent(agent_id=<name>)`). The
   * field propagates from `AgentContent.description` when the agent is
   * built via the construction substrate; built-in / SDK-created
   * agents may set it directly. Optional for backward compatibility
   * with the FEATURE_089 minimal-agent shape and pre-FEATURE_191
   * built-ins.
   */
  readonly description?: string;
  /** Reserved for structured-output agents; not consumed in v0.7.23. */
  readonly outputSchema?: unknown;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: KodaXWireReasoningEffort;
  /**
   * FEATURE_100 (v0.7.29) substrate executor: when set, `Runner.run`
   * delegates execution to this function instead of consulting the
   * preset-dispatcher registry or running the generic LLM loop. The
   * coding preset attaches `runKodaX`'s full execution pipeline here so
   * the SDK surface `Runner.run(createDefaultCodingAgent(), prompt, opts)`
   * directly drives substrate without a `registerPresetDispatcher`
   * indirection (the v0.7.23 "Option Y" facade).
   *
   * Type is intentionally `unknown` to avoid a `core/agent.ts` ↔
   * `core/runner.ts` module cycle. `Runner.run` casts to the
   * `PresetDispatcher` shape declared in `runner.ts` at the call site.
   */
  readonly substrateExecutor?: unknown;
  /**
   * FEATURE_100 (v0.7.29) declarative middleware list. The coding
   * preset declares the four substrate middlewares it ships with
   * (auto-reroute, mutation-reflection, pre-answer-judge,
   * post-tool-judge). Substrate consults this list on entry and
   * skips the corresponding step when `enabled === false`. SDK
   * consumers can introspect or override declared middleware
   * without touching the substrate body.
   */
  readonly middleware?: readonly AgentMiddlewareDeclaration[];
}

/**
 * Ergonomic factory. Equivalent to a plain object literal but freezes the
 * shape so tests cannot mutate a shared Agent by accident.
 */
export function createAgent<TContext = unknown>(
  spec: Agent<TContext>,
): Agent<TContext> {
  return Object.freeze({ ...spec, ...(spec.reasoning ? { reasoning: normalizeAgentReasoningProfile(spec.reasoning) } : {}) });
}

/**
 * Ergonomic factory for Handoff.
 */
export function createHandoff<TTo = unknown>(
  spec: Handoff<TTo>,
): Handoff<TTo> {
  return Object.freeze({ ...spec });
}
