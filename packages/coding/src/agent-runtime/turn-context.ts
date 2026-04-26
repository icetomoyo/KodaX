/**
 * TurnContext — FEATURE_100 P3.0 (substrate adoption / Runner frame)
 *
 * Design: docs/features/v0.7.29.md § P3 Implementation Plan
 *
 * The single immutable value threaded through every step of the
 * substrate executor. Each step receives a TurnContext, performs its
 * work (which may include async I/O and streaming side effects via
 * StepCallbacks), and returns the next TurnContext via spread:
 *
 *   const next: TurnContext = { ...ctx, fieldThatChanged: nextValue };
 *
 * Steps MUST NOT mutate ctx in place. Side-effect callbacks (event
 * emission, persistence, abort signal) are passed via StepCallbacks
 * rather than stored on TurnContext, because:
 *   - AbortSignal is not serialisable / not part of session state
 *   - KodaXEvents is reference-stable across the session — already
 *     captured once via `events: KodaXEvents` (see STABLE tier)
 *
 * Lifecycle tiers:
 *   STABLE   — set at session-start, never replaced (resolved before for-loop)
 *   PER_TURN — advanced at iteration boundaries via spread
 *   PER_STEP — updated within a single turn by sub-steps (also via spread)
 *
 * Three documented mutability exceptions for fields whose underlying
 * objects are mutated in place by external owners:
 *
 *   (a) `toolCtx.backups: Map<string, string>` — write-tool execution
 *       grows this map in place. Per-step deep copy is O(n) prohibitive
 *       and no step needs to observe a pre-execution snapshot. The
 *       `toolCtx` field reference is stable; its `.backups` map is
 *       allowed to grow in place.
 *
 *   (b) `sessionState: RuntimeSessionState` — extension callbacks hold
 *       a live reference via `createExtensionRuntimeSessionController`.
 *       The frame binds the controller before the first turn and
 *       releases it in `finally`. The `sessionState` reference is
 *       stable; its inner `Map` / `Set` fields (`extensionState`,
 *       `editRecoveryAttempts`, `blockedEditWrites`) are allowed to
 *       mutate in place through the controller.
 *
 *   (c) `managedProtocolPayload: { current: ... }` — the wrapper object
 *       is captured by closure inside `toolCtx.emitManagedProtocol`. The
 *       callback updates `.current` via `mergeManagedProtocolPayload`
 *       during streaming. The wrapper reference itself is stable; only
 *       its `.current` field is replaced, and only by that closure.
 *
 * Streaming buffers (onTextDelta / onThinkingDelta character-by-character
 * accumulation) live in step-local variables, NOT on TurnContext. Only
 * the post-stream settled `lastText` is committed back via spread.
 *
 * AbortSignal is intentionally NOT a field on TurnContext — it lives on
 * StepCallbacks and is read directly by steps that need abort checks.
 * Storing it on TurnContext would imply it participates in frame state
 * advance, which it does not.
 *
 * STATUS: P3.0 type definitions only — no usage yet. Wired in P3.1+.
 */

import type {
  KodaXOptions,
  KodaXEvents,
  KodaXToolExecutionContext,
  KodaXContextTokenSnapshot,
  KodaXManagedProtocolPayload,
  SessionErrorMetadata,
} from '../types.js';
import type { KodaXMessage } from '@kodax/ai';
import type { CompactionConfig } from '@kodax/agent';
import type { CostTracker } from '@kodax/ai';
import type { RuntimeSessionState } from './runtime-session-state.js';
import type { ReasoningPlan } from '../reasoning.js';
import type { ReasoningExecutionState } from './reasoning-plan-entry.js';

/**
 * Single immutable value threaded through every step of the substrate
 * executor. See the module docstring for the full lifecycle and
 * mutability contract.
 */
export interface TurnContext {
  // ── STABLE tier ────────────────────────────────────────────────────────
  // Set once during session-start setup, never replaced. The substrate
  // executor treats any TurnContext that differs in a STABLE field from
  // its predecessor as a bug.

  readonly options: KodaXOptions;
  readonly events: KodaXEvents;
  readonly maxIter: number;
  readonly sessionId: string;
  readonly executionCwd: string;

  /**
   * Tool execution context passed to every executeToolCall.
   * @mutable-exception (a) — `toolCtx.backups` Map grows in place during
   * write-tool execution. The `toolCtx` reference itself is stable.
   */
  readonly toolCtx: KodaXToolExecutionContext;

  readonly compactionConfig: CompactionConfig;
  readonly prompt: string;

  /**
   * Session title. Mutable in the sense that it CAN change once during
   * first-turn title extraction, before the first `persistSession`
   * call. After that, treat as frozen — `persistSession` may emit a
   * debug-mode warning if it observes title changes across calls.
   */
  readonly title: string;

  readonly errorMetadata: SessionErrorMetadata | undefined;

  /**
   * Managed-protocol payload accumulator.
   * @mutable-exception (c) — the wrapper object is stable; only its
   * `.current` field is replaced, by the closure inside
   * `toolCtx.emitManagedProtocol`. See module docstring exception (c).
   */
  readonly managedProtocolPayload: { current: KodaXManagedProtocolPayload | undefined };

  // ── PER_TURN tier ───────────────────────────────────────────────────────
  // Advanced at the start or end of each iteration via spread.

  readonly iter: number;
  readonly messages: readonly KodaXMessage[];

  /**
   * @mutable-exception (b) — extension callbacks hold a live reference
   * to this object via the runtime controller. Inner Map/Set fields
   * mutate in place. The reference itself is stable across all turns.
   *
   * Note: per-turn `currentProviderName` / `currentModelOverride` /
   * `runtimeThinkingLevel` are NOT separate TurnContext fields — they
   * are derived each iteration from `sessionState.modelSelection` and
   * `sessionState.thinkingLevel`. The substrate executor re-derives
   * them in the turn-start step (P3.1).
   */
  readonly sessionState: RuntimeSessionState;

  readonly currentExecution: ReasoningExecutionState;
  readonly reasoningPlan: ReasoningPlan;
  readonly contextTokenSnapshot: KodaXContextTokenSnapshot;
  readonly costTracker: CostTracker;

  // Per-session counters and latches — reset to defaults on resume.
  readonly compactConsecutiveFailures: number;
  readonly managedProtocolContinueAttempted: boolean;
  readonly incompleteRetryCount: number;
  readonly maxTokensRetryCount: number;
  readonly preAnswerJudgeConsumed: boolean;
  readonly postToolJudgeConsumed: boolean;
  readonly autoFollowUpCount: number;
  readonly autoDepthEscalationCount: number;
  readonly autoTaskRerouteCount: number;

  // ── PER_STEP tier ───────────────────────────────────────────────────────
  // Updated within a single turn by sub-steps. Also advanced via spread.

  readonly lastText: string;
  readonly limitReached: boolean;
}

/**
 * Side-effect channel passed to every step. NEVER stored on TurnContext.
 *
 * Built once per Runner.run invocation and passed unchanged to every
 * step. Steps read `callbacks.signal` for abort checking and
 * `callbacks.persistSession` for session save.
 *
 * `persistSession` MUST internally wrap any `storage.save` rejection
 * in try/catch — an error here must not propagate into the step
 * pipeline. This resolves the CAP-013-003 storage-failure-isolation
 * gap that was P3-deferred during P2.
 */
export interface StepCallbacks {
  readonly emit: KodaXEvents;
  readonly signal: AbortSignal | undefined;
  readonly persistSession: (ctx: TurnContext) => Promise<void>;
}

/**
 * A substrate executor step.
 *
 * Receives the current TurnContext, performs its work (which may
 * include async I/O and streaming side effects via callbacks), and
 * returns the next TurnContext.
 *
 * MUST NOT mutate `ctx` in place — produce the next value via
 * `{ ...ctx, field: nextValue }`. The two `@mutable-exception` fields
 * documented on `TurnContext` are the only legal in-place mutations.
 *
 * Steps that signal loop termination (e.g. promise-signal detection,
 * cancellation) return a TurnContext with the appropriate field set
 * (e.g. `limitReached: true`). The executor reads the next outcome
 * via the discriminated union below.
 */
export type Step = (ctx: TurnContext, callbacks: StepCallbacks) => Promise<TurnContext>;

/**
 * Outcome variants returned by the per-turn step pipeline. The executor
 * reads this after the step pipeline completes and routes to the
 * appropriate terminal (return result / break / continue).
 */
export type TurnOutcome =
  | { kind: 'continue'; ctx: TurnContext }
  | { kind: 'complete'; ctx: TurnContext; signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE' }
  | { kind: 'interrupted'; ctx: TurnContext } // AbortError — clean exit
  | { kind: 'error'; ctx: TurnContext; error: Error } // unhandled error
  | { kind: 'limit_reached'; ctx: TurnContext };
