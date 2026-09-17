/**
 * Event-emitter helpers — CAP-035 + CAP-038 + CAP-053 + CAP-058
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-035-tool-name-visibility-classification
 *   - docs/features/v0.7.29-capability-inventory.md#cap-038-queued-follow-up-detection
 *   - docs/features/v0.7.29-capability-inventory.md#cap-053-emititerationend-helper-eventsoniterationend--token-snapshot-rebase
 *   - docs/features/v0.7.29-capability-inventory.md#cap-058-eventsoniterationstart-event
 *
 * Predicates and event-fan-out helpers used by the SA loop:
 *
 *   - `isVisibleToolName` (CAP-035): predicate for whether a given tool
 *     call should be surfaced to the host (REPL, IDE extension, AMA
 *     observer) via `onToolUseStart` / `onToolResult`. Managed-protocol
 *     tools (e.g. `emit_managed_protocol`) are infrastructure-level
 *     signals the host should not echo back — they belong to the harness,
 *     not to the user-visible work transcript.
 *
 *   - `hasQueuedFollowUp` (CAP-038): consulted at end-of-turn terminal
 *     decision points to keep the loop running when the host has a
 *     queued user input ready. The optional-chained call to
 *     `events.hasPendingInputs?.()` ensures hosts that don't implement
 *     this hook (the default) simply return `false` — no behavioural
 *     change for non-REPL embedders.
 *
 *   - `emitIterationStart` (CAP-058): fires `events.onIterationStart`
 *     with `iter+1` (1-based for display) and `maxIter`. Caller must
 *     have already fired the `turn:start` extension event — this helper
 *     is the user-visible counterpart that runs immediately after.
 *
 *   - `emitIterationEnd` (CAP-053): rebases the context-token snapshot
 *     against the latest messages buffer, then fires
 *     `events.onIterationEnd` carrying the rebased snapshot. Returns
 *     the new snapshot so the caller can reassign its mutable holder.
 *     The rebase is load-bearing — it's the only place where streaming
 *     usage deltas accumulated during the turn are reconciled with the
 *     persistent message-count baseline before the next turn begins.
 *
 * Migration history:
 *   - `isVisibleToolName` extracted from `agent.ts:882-884` during the
 *     FEATURE_100 P2 baseline batch.
 *   - `hasQueuedFollowUp` extracted from `agent.ts:769-771` during
 *     FEATURE_100 P2 (CAP-031/032/037/038 batch).
 *   - `emitIterationStart` / `emitIterationEnd` extracted from
 *     `agent.ts:511-528` and `agent.ts:577` during FEATURE_100 P3.1.
 */

import { randomUUID } from 'node:crypto';

import type {
  KodaXActivityEventMeta,
  KodaXEvents,
  KodaXContextTokenSnapshot,
  KodaXLiveEventMeta,
  KodaXTurnCompletedEvent,
  KodaXTurnDeliveryKind,
  KodaXTurnFailedEvent,
  KodaXTurnStartedEvent,
} from '../types.js';
import type { KodaXMessage } from '@kodax-ai/llm';
import { getMessageQueue } from '@kodax-ai/agent';
import { isManagedProtocolToolName } from '../managed-protocol.js';
import { rebaseContextTokenSnapshot } from '../token-accounting.js';

const LIVE_TURN_ATTRIBUTED = Symbol('KodaXLiveTurnAttributed');
const LIVE_TURN_BASE_EVENTS = Symbol('KodaXLiveTurnBaseEvents');
const LIVE_TURN_ID_HEX_LENGTH = 16;
// Process-lifetime by design: without a session-close signal, evicting an entry
// can make a later resume of the same sessionId reuse seq values.
const liveSessionSeq = new Map<string, number>();
const liveContextRevision = new Map<string, number>();

type AttributedEvents = KodaXEvents & {
  readonly [LIVE_TURN_ATTRIBUTED]: true;
  readonly [LIVE_TURN_BASE_EVENTS]: KodaXEvents;
};

export interface LiveTurnScope {
  readonly sessionId: string;
  readonly turnId: string;
  readonly contextId: string;
  readonly contextKind: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
  readonly deliveryId?: string;
  readonly deliveryKind: KodaXTurnDeliveryKind;
  readonly promptId?: string;
  readonly ownsContextRevision: boolean;
  nextMeta(): KodaXLiveEventMeta;
  advanceContextRevision(): number;
}

export interface LiveTurnScopeRef {
  current: LiveTurnScope;
}

export function createLiveTurnScope(input: {
  readonly sessionId: string;
  readonly deliveryKind?: KodaXTurnDeliveryKind;
  readonly turnId?: string;
  readonly deliveryId?: string;
  readonly promptId?: string;
  readonly contextId?: string;
  readonly contextKind?: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
  readonly ownsContextRevision?: boolean;
}): LiveTurnScope {
  const turnId = input.turnId ?? `turn_${randomUUID().replace(/-/g, '').slice(0, LIVE_TURN_ID_HEX_LENGTH)}`;
  const deliveryId = input.deliveryId ?? `delivery_${randomUUID().replace(/-/g, '').slice(0, LIVE_TURN_ID_HEX_LENGTH)}`;
  const contextId = input.contextId ?? input.sessionId;
  const contextKind = input.contextKind ?? 'root';
  if (!liveContextRevision.has(contextId)) liveContextRevision.set(contextId, 0);
  return {
    sessionId: input.sessionId,
    turnId,
    contextId,
    contextKind,
    parentContextId: input.parentContextId,
    agentId: input.agentId,
    deliveryId,
    deliveryKind: input.deliveryKind ?? 'initial',
    promptId: input.promptId,
    ownsContextRevision: input.ownsContextRevision ?? true,
    nextMeta() {
      const seq = (liveSessionSeq.get(input.sessionId) ?? 0) + 1;
      liveSessionSeq.set(input.sessionId, seq);
      return {
        sessionId: input.sessionId,
        seq,
        turnId,
        deliveryId,
        contextId,
        contextKind,
        ...(input.parentContextId !== undefined
          ? { parentContextId: input.parentContextId }
          : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        contextRevision: liveContextRevision.get(contextId) ?? 0,
        timestamp: new Date().toISOString(),
      };
    },
    advanceContextRevision() {
      if (input.ownsContextRevision === false) {
        return liveContextRevision.get(contextId) ?? 0;
      }
      const revision = (liveContextRevision.get(contextId) ?? 0) + 1;
      liveContextRevision.set(contextId, revision);
      return revision;
    },
  };
}

function isAttributedEvents(events: KodaXEvents): events is AttributedEvents {
  return (events as Partial<AttributedEvents>)[LIVE_TURN_ATTRIBUTED] === true;
}

function resolveLiveTurnScope(scope: LiveTurnScope | LiveTurnScopeRef): LiveTurnScope {
  return 'current' in scope ? scope.current : scope;
}

function withActivityMeta<TMeta extends KodaXActivityEventMeta>(
  scope: LiveTurnScope | LiveTurnScopeRef,
  meta: TMeta | undefined,
): TMeta & KodaXLiveEventMeta {
  const explicitContext = meta?.contextId === undefined
    || meta.contextKind === undefined
    || meta.contextRevision === undefined
    ? {}
    : {
        contextId: meta.contextId,
        contextKind: meta.contextKind,
        parentContextId: meta.parentContextId,
        agentId: meta.agentId,
        contextRevision: meta.contextRevision,
      };
  return {
    ...(meta ?? ({} as TMeta)),
    ...resolveLiveTurnScope(scope).nextMeta(),
    ...explicitContext,
  } as TMeta & KodaXLiveEventMeta;
}

function withLiveMeta<TEvent extends object>(
  scope: LiveTurnScope | LiveTurnScopeRef,
  event: TEvent,
): TEvent & KodaXLiveEventMeta {
  const candidate = event as Partial<KodaXLiveEventMeta>;
  const explicitContext = candidate.contextId === undefined
    || candidate.contextKind === undefined
    || candidate.contextRevision === undefined
    ? {}
    : {
        contextId: candidate.contextId,
        contextKind: candidate.contextKind,
        parentContextId: candidate.parentContextId,
        agentId: candidate.agentId,
        contextRevision: candidate.contextRevision,
      };
  return {
    ...event,
    ...resolveLiveTurnScope(scope).nextMeta(),
    ...explicitContext,
  };
}

export function withLiveTurnAttribution(
  events: KodaXEvents,
  scope: LiveTurnScope | LiveTurnScopeRef,
): KodaXEvents {
  const baseEvents = isAttributedEvents(events) ? events[LIVE_TURN_BASE_EVENTS] : events;
  const wrapped: KodaXEvents = {
    ...baseEvents,
    onSessionStart: (info) => {
      baseEvents.onSessionStart?.(withLiveMeta(scope, info));
    },
    onOutputSegmentStart: (segment, meta) => {
      baseEvents.onOutputSegmentStart?.(segment, withActivityMeta(scope, meta));
    },
    onTextDelta: (text, meta) => {
      baseEvents.onTextDelta?.(text, withActivityMeta(scope, meta));
    },
    onThinkingDelta: (text, meta) => {
      baseEvents.onThinkingDelta?.(text, withActivityMeta(scope, meta));
    },
    onThinkingEnd: (thinking, meta) => {
      baseEvents.onThinkingEnd?.(thinking, withActivityMeta(scope, meta));
    },
    onToolUseStart: (tool, meta) => {
      baseEvents.onToolUseStart?.(tool, withActivityMeta(scope, meta));
    },
    onToolInputDelta: (toolName, partialJson, meta) => {
      baseEvents.onToolInputDelta?.(toolName, partialJson, withActivityMeta(scope, meta));
    },
    onToolProgress: (update, meta) => {
      baseEvents.onToolProgress?.(update, withActivityMeta(scope, meta));
    },
    onToolSandboxObservation: (update, meta) => {
      baseEvents.onToolSandboxObservation?.(
        update,
        withActivityMeta(scope, meta),
      );
    },
    onToolResult: (result, meta) => {
      baseEvents.onToolResult?.(result, withActivityMeta(scope, meta));
    },
    onToolExecutionStart: (tool, meta) => {
      baseEvents.onToolExecutionStart?.(tool, withActivityMeta(scope, meta));
    },
    onToolExecutionEnd: (tool, meta) => {
      baseEvents.onToolExecutionEnd?.(tool, withActivityMeta(scope, meta));
    },
    onChildActivityEnd: (meta) => {
      baseEvents.onChildActivityEnd?.(withActivityMeta(scope, meta));
    },
    onStreamEnd: (meta) => {
      baseEvents.onStreamEnd?.(withActivityMeta(scope, meta));
    },
    onIterationStart: (iter, maxIter, meta) => {
      baseEvents.onIterationStart?.(iter, maxIter, withActivityMeta(scope, meta));
    },
    onIterationEnd: (info) => {
      baseEvents.onIterationEnd?.(withLiveMeta(scope, info));
    },
    onCompactStart: (meta) => {
      baseEvents.onCompactStart?.(withActivityMeta(scope, meta));
    },
    onCompact: (estimatedTokens, meta) => {
      baseEvents.onCompact?.(estimatedTokens, withActivityMeta(scope, meta));
    },
    onCompactStats: (info) => {
      baseEvents.onCompactStats?.(withLiveMeta(scope, info));
    },
    onCompactedMessages: async (messages, update, meta) => {
      const liveScope = resolveLiveTurnScope(scope);
      const committedRevision = liveScope.advanceContextRevision();
      try {
        await baseEvents.onCompactedMessages?.(messages, update, withActivityMeta(scope, meta));
      } catch (error) {
        // Durability is part of the commit acknowledgement. If it rejects,
        // preserve the prior context identity so later events cannot claim a
        // revision that never became canonical.
        if (
          liveScope.ownsContextRevision
          && liveContextRevision.get(liveScope.contextId) === committedRevision
        ) {
          liveContextRevision.set(liveScope.contextId, committedRevision - 1);
        }
        throw error;
      }
    },
    onContextCompactionFinished: (event) => {
      baseEvents.onContextCompactionFinished?.(withLiveMeta(scope, event));
    },
    onCompactEnd: (meta, result) => {
      baseEvents.onCompactEnd?.(withActivityMeta(scope, meta), result);
    },
    onMidTurnUserMessages: (contents, meta) => {
      baseEvents.onMidTurnUserMessages?.(contents, withActivityMeta(scope, meta));
    },
    onRetry: (reason, attempt, maxAttempts, meta) => {
      baseEvents.onRetry?.(reason, attempt, maxAttempts, withActivityMeta(scope, meta));
    },
    onProviderRateLimit: (attempt, maxRetries, delayMs, meta) => {
      baseEvents.onProviderRateLimit?.(attempt, maxRetries, delayMs, withActivityMeta(scope, meta));
    },
    onRetryAfter: (payload, meta) => {
      baseEvents.onRetryAfter?.(payload, withActivityMeta(scope, meta));
    },
    onProviderRecovery: (event, meta) => {
      baseEvents.onProviderRecovery?.(event, withActivityMeta(scope, meta));
    },
    onReasoningEffortRejected: (event) => {
      baseEvents.onReasoningEffortRejected?.(withLiveMeta(scope, event));
    },
    onReasoningResolved: (event) => {
      baseEvents.onReasoningResolved?.(withLiveMeta(scope, event));
    },
    onRepoIntelligenceTrace: (event) => {
      baseEvents.onRepoIntelligenceTrace?.(withLiveMeta(scope, event));
    },
    onContextBudgetSnapshot: (event) => {
      baseEvents.onContextBudgetSnapshot?.(withLiveMeta(scope, event));
    },
    onPromptCacheDiagnostics: (event) => {
      baseEvents.onPromptCacheDiagnostics?.(withLiveMeta(scope, event));
    },
    onToolExposurePlanned: (event) => {
      baseEvents.onToolExposurePlanned?.(withLiveMeta(scope, event));
    },
    onContextCompactionSkipped: (event) => {
      baseEvents.onContextCompactionSkipped?.(withLiveMeta(scope, event));
    },
    onSidecarMessage: (event) => {
      baseEvents.onSidecarMessage?.(withLiveMeta(scope, event));
    },
    onTodoUpdate: (items, meta) => {
      baseEvents.onTodoUpdate?.(items, withActivityMeta(scope, meta));
    },
    onTodoDriftWarning: (event) => {
      baseEvents.onTodoDriftWarning?.(withLiveMeta(scope, event));
    },
    onManagedTaskStatus: (status) => {
      baseEvents.onManagedTaskStatus?.(withLiveMeta(scope, status));
    },
    onEffectiveConfig: (config) => {
      baseEvents.onEffectiveConfig?.(withLiveMeta(scope, config));
    },
    onWorkflowProcessEvent: (event) => {
      baseEvents.onWorkflowProcessEvent?.(withLiveMeta(scope, event));
    },
    onWorkflowAgentDigest: (event) => {
      baseEvents.onWorkflowAgentDigest?.(withLiveMeta(scope, event));
    },
    onScoutSuspiciousCompletion: (payload) => {
      baseEvents.onScoutSuspiciousCompletion?.(withLiveMeta(scope, payload));
    },
    onComplete: (meta) => {
      baseEvents.onComplete?.(withActivityMeta(scope, meta));
    },
    onError: (error, meta) => {
      baseEvents.onError?.(error, withActivityMeta(scope, meta));
    },
  };
  Object.defineProperty(wrapped, LIVE_TURN_ATTRIBUTED, {
    value: true,
    enumerable: false,
  });
  Object.defineProperty(wrapped, LIVE_TURN_BASE_EVENTS, {
    value: baseEvents,
    enumerable: false,
  });
  return wrapped;
}

export function emitTurnStarted(events: KodaXEvents, scope: LiveTurnScope): void {
  const event: KodaXTurnStartedEvent = {
    ...scope.nextMeta(),
    deliveryKind: scope.deliveryKind,
    ...(scope.promptId !== undefined ? { promptId: scope.promptId } : {}),
  };
  events.onTurnStarted?.(event);
}

export function emitTurnCompleted(
  events: KodaXEvents,
  scope: LiveTurnScope,
  status: KodaXTurnCompletedEvent['status'],
): void {
  events.onTurnCompleted?.({
    ...scope.nextMeta(),
    status,
  });
}

export function emitTurnFailed(
  events: KodaXEvents,
  scope: LiveTurnScope,
  error: Error,
): void {
  const payload: KodaXTurnFailedEvent = {
    ...scope.nextMeta(),
    error: {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    },
  };
  events.onTurnFailed?.(payload);
}

/**
 * FEATURE_151 (v0.7.38) Slice E — `todo_update` and `todo_list` are
 * scaffolding for the user-visible TodoListSurface. The user already
 * sees plan progress through that surface; surfacing every individual
 * tool call (especially during a multi-step task where the Generator
 * fires `op:'update'` 2-4 times per round) is pure transcript noise.
 *
 * Mirrors Claude Code's stance: `TodoWriteTool` / `TaskCreateTool` /
 * `TaskUpdateTool` / `TaskListTool` all set `shouldDefer: true +
 * renderToolUseMessage() => null + userFacingName() => ''`, hiding the
 * call entirely from the user transcript.
 */
const HIDDEN_TODO_TOOL_NAMES: ReadonlySet<string> = new Set([
  'todo_update',
  'todo_list',
  // FEATURE_170 (v0.7.41) — `todo_create` is also plan-list scaffolding.
  // Same rationale as todo_update: the user sees inserted items via the
  // TodoListSurface; the raw tool call is pure transcript noise.
  'todo_create',
  // v0.7.42 — `todo_get` is read-only per-id lookup. Same scaffolding
  // role as todo_list (Generator / Worker uses it to refresh state
  // before `todo_update`, or to fetch full description on pick-up).
  // Mirrors CC's `TaskGetTool` (also `shouldDefer: true`).
  'todo_get',
]);

export function isVisibleToolName(name: string): boolean {
  return (
    !isManagedProtocolToolName(name)
    && !HIDDEN_TODO_TOOL_NAMES.has(name)
  );
}

/**
 * CAP-038 + FEATURE_159 (v0.7.40) — queue-aware queued-follow-up
 * predicate.
 *
 * Pre-FEATURE_159: only consulted `events.hasPendingInputs?.()` — the
 * REPL implemented this hook to expose its React `pendingInputs` array.
 * That coupling required the REPL to mirror its array into the agent-
 * side MessageQueue (legacy `syncPendingInputsToQueue`) so other
 * substrate consumers could see the same queued input.
 *
 * Post-FEATURE_159: MessageQueue is the canonical source of queued
 * user prompts. We OR-in a queue probe for `mode:'prompt'`
 * caller-scoped user-priority entries — so any origin (REPL,
 * idle-yield wake-resumed prompts, SDK consumer that enqueues
 * directly) triggers the same yield. The `events.hasPendingInputs?.()`
 * fallback is kept for SDK consumers that implement custom
 * queueing without routing through MessageQueue (BC-preserved).
 */
export function hasQueuedFollowUp(
  events: KodaXEvents,
  agentId?: string,
): boolean {
  if (events.hasPendingInputs?.() === true) return true;
  return getMessageQueue().has({
    agentId,
    maxPriority: 'user',
    mode: 'prompt',
  });
}

/**
 * Fire `onSessionStart` — CAP-003. Single shared site so SA (substrate
 * frame entry) and AMA (`runManagedTaskViaRunner`) emit through the
 * same surface. Future contract changes (richer payload, ordering
 * invariants) only need updating here.
 */
export function emitSessionStart(
  events: KodaXEvents,
  payload: { provider: string; sessionId: string },
): void {
  events.onSessionStart?.(payload);
}

/**
 * Fire `onStreamEnd` — CAP-004. Shared between SA's per-turn stream
 * finalization and AMA's per-worker-turn stream finalization.
 */
export function emitStreamEnd(events: KodaXEvents): void {
  events.onStreamEnd?.();
}

/**
 * Fire `onComplete` — CAP-005. Shared terminal signal across all
 * non-error terminals (success / interrupt / managed-protocol exit).
 * Mutually exclusive with `emitError` per CAP-084.
 */
export function emitComplete(events: KodaXEvents): void {
  events.onComplete?.();
}

/**
 * Fire `onError` — CAP-006. Shared catch-branch signal. Mutually
 * exclusive with `emitComplete` per CAP-084.
 */
export function emitError(events: KodaXEvents, error: Error): void {
  events.onError?.(error);
}

/**
 * Fire `onProviderRateLimit` — CAP-007. Distinct from generic
 * `onRetry`: only fires when the resilience classifier returns
 * `reasonCode === 'rate_limit'`. SA dispatches via the provider stream
 * handler bridge (`stream-handler-wiring.ts`); AMA dispatches inline
 * during its own retry decision pipeline. Both now emit through this
 * helper so the (attempt, maxRetries, delayMs) tuple shape is locked.
 */
export function emitProviderRateLimit(
  events: KodaXEvents,
  attempt: number,
  maxRetries: number,
  delayMs: number,
  meta?: KodaXActivityEventMeta,
): void {
  if (meta !== undefined) {
    events.onProviderRateLimit?.(attempt, maxRetries, delayMs, meta);
    return;
  }
  events.onProviderRateLimit?.(attempt, maxRetries, delayMs);
}

/**
 * Fire the user-facing `onIterationStart` event. `iter` is 0-based at
 * the call site; this helper translates to the 1-based display value.
 */
export function emitIterationStart(
  events: KodaXEvents,
  iter: number,
  maxIter: number,
): void {
  events.onIterationStart?.(iter + 1, maxIter);
}

/**
 * Rebase the context-token snapshot and fire `onIterationEnd`. Returns
 * the rebased snapshot so the caller can reassign its holder. Pass
 * `snapshotOverride` when an upstream step (compaction, post-compact
 * attachments) has already produced a fresher baseline.
 */
export function emitIterationEnd(
  events: KodaXEvents,
  params: {
    iter: number;
    maxIter: number;
    messages: readonly KodaXMessage[];
    currentSnapshot: KodaXContextTokenSnapshot;
    snapshotOverride?: KodaXContextTokenSnapshot;
  },
): KodaXContextTokenSnapshot {
  const rebased = rebaseContextTokenSnapshot(
    params.messages as KodaXMessage[],
    params.snapshotOverride ?? params.currentSnapshot,
  );
  events.onIterationEnd?.({
    iter: params.iter,
    maxIter: params.maxIter,
    tokenCount: rebased.currentTokens,
    tokenSource: rebased.source,
    usage: rebased.usage,
    contextTokenSnapshot: rebased,
  });
  return rebased;
}
