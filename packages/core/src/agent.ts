/**
 * Layer A Primitive: Agent / Handoff / Guardrail / AgentReasoningProfile
 *
 * FEATURE_080 (v0.7.23): Agent-as-data types. Declarative dataclass shape.
 * The runtime counterpart is `Runner` in `./runner.ts`.
 *
 * Moved to `@kodax/core` in FEATURE_082 (v0.7.24). `@kodax/coding` retains a
 * barrel re-export for batteries-included consumers.
 *
 * Status: @experimental — API shape may be refined during v0.7.x. Used by
 * the task-engine rewrite in FEATURE_084 (v0.7.26).
 *
 * Guardrail and AgentReasoningProfile are declared here but their runtime
 * behavior is deferred:
 *   - Guardrail runtime → FEATURE_085 (v0.7.26)
 *   - AgentReasoningProfile behavior → FEATURE_078 (v0.7.29)
 */

import type { KodaXMessage, KodaXReasoningMode, KodaXToolDefinition } from '@kodax/ai';

/**
 * Reasoning depth / mode selector. Alias for `KodaXReasoningMode` to keep the
 * Layer A surface independent of the `KodaX*` brand; unified during the prefix
 * cleanup in FEATURE_086 (v0.7.27).
 */
export type ReasoningDepth = KodaXReasoningMode;

/**
 * Tool binding accepted by an `Agent`. Layer A treats tools as opaque
 * definitions; the executor lives in `@kodax/coding` and is wired up by the
 * Runner when it dispatches through `runKodaX`.
 */
export type AgentTool = KodaXToolDefinition;

/**
 * Transport-level message reused from the AI layer. Kept as an alias so
 * consumers of the Layer A primitives do not need to import from `@kodax/ai`
 * directly.
 */
export type AgentMessage = KodaXMessage;

/**
 * Declarative reasoning profile attached to an Agent.
 *
 * In v0.7.23 this is a placeholder shape — only the `default` depth is read
 * when the Runner dispatches to `runKodaX`. Escalation on revise/replan and
 * max clamping are implemented in FEATURE_078 (v0.7.29).
 */
export interface AgentReasoningProfile {
  readonly default: ReasoningDepth;
  readonly max?: ReasoningDepth;
  readonly escalateOnRevise?: boolean;
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
 *     Mirrors FEATURE_067 `dispatch_child_task`.
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
  /** Reserved for structured-output agents; not consumed in v0.7.23. */
  readonly outputSchema?: unknown;
  readonly model?: string;
  readonly provider?: string;
}

/**
 * Ergonomic factory. Equivalent to a plain object literal but freezes the
 * shape so tests cannot mutate a shared Agent by accident.
 */
export function createAgent<TContext = unknown>(
  spec: Agent<TContext>,
): Agent<TContext> {
  return Object.freeze({ ...spec });
}

/**
 * Ergonomic factory for Handoff.
 */
export function createHandoff<TTo = unknown>(
  spec: Handoff<TTo>,
): Handoff<TTo> {
  return Object.freeze({ ...spec });
}
