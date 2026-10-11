/**
 * Shared interfaces used across the runner-driven managed-task internals.
 *
 * Lives here so the per-feature modules under `_internal/managed-task/`
 * (role-prompts, role-exclude, observer-bridge,
 * status-derivation, agent-chain, llm-adapter, payload-builder,
 * checkpoint-flow, …) can all import the same canonical contracts
 * without depending on the top-level `runner-driven.ts` orchestrator —
 * the original cause of cyclic references when the file was monolithic.
 *
 * Extracted as part of FEATURE_171 (v0.7.41) — `runner-driven.ts`
 * modular split. Zero behavior change: the interfaces are byte-identical
 * to the previous in-file declarations.
 */

import type {
  KodaXJsonValue,
  KodaXResult,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
  KodaXTaskToolPolicy,
} from '../../../types.js';

/**
 * The set of AMA roles whose tool surface is controlled by the
 * exclude-based wiring contract. Excludes `direct` (an SA fast-path
 * pseudo-role) since direct runs do not pass through the AMA
 * chain-builder's exclude resolution.
 *
 * FEATURE_184 (v0.7.45) Phase C.1: 'evaluator' removed.
 * FEATURE_193 (v0.7.43): V1 chain retired — 'scout' / 'planner' /
 * 'generator' removed. Worker single-loop is the only V2 agent
 * dispatched through the AMA chain-builder. The wider `KodaXTaskRole`
 * union (in `../../../types.ts`) still carries the V1 names for
 * pre-1.0 SDK consumer compat (checkpoint reading + REPL UI shapes),
 * but the AMA-specific subset narrows to a single member.
 */
export type AmaRole = 'worker';

/**
 * Factory that resolves the `ManagedRolePromptContext` for a given role from
 * current runtime state. Called by the dynamic `instructions` closure on every
 * agent invocation so fresh context reaches the Worker prompt.
 */
export type RolePromptContextFactory = (role: KodaXTaskRole
) => import('./role-prompt-types.js').ManagedRolePromptContext | undefined;

/**
 * Optional prompt context plumbed into `buildRunnerAgentChain`. When
 * present, the chain builder uses `createRolePrompt` to produce a full
 * v0.7.22-parity role prompt for every turn. When absent (test paths),
 * the fallback constants in `role-prompts.ts` are used instead.
 */
export interface RunnerChainPromptContext {
  /** Original user task. Becomes `rolePromptContext.originalTask`. */
  readonly prompt: string;
  /**
   * Routing decision. Legacy callers / tests pass a static
   * `KodaXTaskRoutingDecision` captured at chain construction. The runtime
   * path passes a thunk so prompt construction reads the latest plan decision
   * without rebuilding the agent graph.
   */
  readonly decision: KodaXTaskRoutingDecision | (() => KodaXTaskRoutingDecision);
  /** Optional structured task metadata. */
  readonly metadata?: Record<string, KodaXJsonValue>;
  /**
   * Optional static tool policy. Kept for tests / topology-only call sites
   * that don't need per-role policy. When both `toolPolicy` and
   * `toolPolicyFactory` are absent, the prompt's "## Tool Policy" section
   * is omitted (matches legacy behavior when a role falls through to
   * `undefined` in `buildManagedWorkerToolPolicy`).
   */
  readonly toolPolicy?: KodaXTaskToolPolicy;
  /**
   * P1 parity — per-role tool policy factory. Called lazily at each
   * Runner invocation so future role policies can attach without changing
   * prompt construction. The current Worker policy returns `undefined`.
   */
  readonly toolPolicyFactory?: (role: KodaXTaskRole
  ) => KodaXTaskToolPolicy | undefined;
  /** Optional role-context factory for runtime prompt context injection. */
  readonly contextFactory?: RolePromptContextFactory;
  /**
   * Pre-computed repo-intelligence context block (Repository Overview /
   * Changed Scope / Active Module / Impact / Fallback Guidance /
   * Premium Context sections). Built once per `runManagedTaskViaRunner`
   * entry via `buildAutoRepoIntelligenceContext` and appended in the
   * request-only managed context so the Worker sees it from turn 1 without
   * destabilizing the leading System prefix.
   */
  readonly repoIntelligenceContext?: string;
  /**
   * FEATURE_247 (R1) — SDK-consumer agent-profile instructions (e.g. KodaX-Space
   * Partner). When set, prepended to the Worker role prompt as the governing
   * directive so a Partner profile behaves consistently on the AMA/AMAW path
   * (the SA path uses `context.systemPromptOverride`). Absent ⇒ byte-identical
   * default coding worker prompt.
   */
  readonly partnerInstructions?: string;
}

/**
 * Observer surface the runner-driven path uses to bridge into
 * `options.events`. Built once per managed-task run by
 * `buildObserverBridge`; consumed by emit-wrapper, agent-chain, llm-
 * adapter and the outer-loop wrapper.
 */
export interface ObserverBridge {
  readonly preflight: () => void;
  readonly onRoleEmit: (role: KodaXTaskRole) => void;
  readonly completed: (signal: KodaXResult['signal'], reason?: string) => void;
  readonly notifyBudgetApprovalRequest: () => void;
  // Shard 6d-Q (v0.7.22 parity): fire a status event when a child task
  // dispatch starts so the REPL's AmaWorkStrip can render
  // "Scout/Generator fanning out ${class} × ${count}" badge.
  readonly notifyChildFanout: (
    fanoutClass: 'finding-validation' | 'evidence-scan' | 'module-triage',
    count?: number,
  ) => void;
  /**
   * v0.7.38 FEATURE_156 — fire when the runner-driven outer loop is
   * about to park in `waitForWakeEvent` (idle-yield from FEATURE_155).
   * Surfaces "alive but suspended pending external wake" so the REPL's
   * status-bar can render "Worker - waiting for N children" instead
   * of falling back to the last role-emit label, which gives the user
   * no signal about what the spinner is waiting on.
   *
   * Agent-agnostic — caller passes the role of whichever agent just
   * exited idle (today always 'worker'; the field doesn't lock in
   * that invariant).
   *
   * No paired "resumed" emit needed: the next iteration's
   * `onRoleEmit` naturally clears `idleWaiting` because it doesn't
   * set the field, and the consumer branches on `=== true` so
   * undefined transitions out of the waiting label.
   */
  readonly idleWaiting: (
    role: KodaXTaskRole | undefined,
    pendingCount: number,
  ) => void;

  readonly agentSwitched: (role: KodaXTaskRole | undefined) => void;
  /**
   * FEATURE_187 Phase C (v0.7.43) — opt-in observability for the
   * FEATURE_178 stall sidecar. Fires AFTER each L2 sidecar verdict
   * resolves so the REPL can persist a one-line summary into the
   * transcript:
   *   `[Stall Sidecar] isStuck=true · zhipu/glm-5.1 (inherit) · 1842ms · sidecar_ok`
   *
   * Gated by `KODAX_STALL_LOG=1` (env or `stallLog: true` in
   * `~/.kodax/config.json`) — off by default. The stall sidecar
   * middleware factory checks the env var inside its `onVerdict`
   * callback before invoking this method because stall verdicts arrive
   * asynchronously.
   *
   * `persistToHistory: true` writes a durable record per stall verdict
   * to session jsonl when users opt in to the log.
   */
  readonly stallSidecarFired: (info: StallSidecarFiredInfo) => void;
}

export interface StallSidecarFiredInfo {
  /** Whether the L2 sidecar decided the agent is in a real stall. */
  readonly isStuck: boolean;
  /** Resolved stall-sidecar provider name (kodax provider registry id). */
  readonly providerName: string;
  /** Resolved stall-sidecar model id. `undefined` means the provider's
   *  registered default was used (no `KODAX_STALL_MODEL` override AND
   *  no main-agent model configured — log renders `(default)`). */
  readonly model: string | undefined;
  /** Whether the stall sidecar inherited from main or came from env override. */
  readonly source: 'explicit-env' | 'inherit-main';
  /** Wall-clock duration of the stall sidecar LLM call in milliseconds. */
  readonly elapsedMs: number;
  /** Diagnostic trace tag — see `SidecarVerdictTrace` in
   *  `stall-sidecar/sidecar.ts` for the closed enum
   *  (sidecar_ok / fuzzy_tool_match / timeout / provider_error /
   *  no_tool_call / invalid_isStuck / missing_nudge). */
  readonly trace: string;
}
