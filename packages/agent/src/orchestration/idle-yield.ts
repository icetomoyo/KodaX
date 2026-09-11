/**
 * Idle-yield primitives — async chat-while-waiting orchestration core.
 *
 * Originally shipped as `packages/coding/src/task-engine/_internal/
 * managed-task/idle-yield.ts` (v0.7.39 Slices A1-C3, FEATURE_155). The
 * v0.7.38 hotfix follow-up chain (Bug A-G) landed inside the same file.
 * v0.7.39 FEATURE_120 Step 0 (this slice) lifts the module to
 * `@kodax-ai/agent`'s `orchestration/` so any agent-flavor consumer
 * outside KodaX's coding stack can reuse the same async fan-out
 * wait-and-resume mechanic (ADR-021).
 *
 * Replaces the blocking `await_child_task` semantics with a Claude-Code-
 * style "agent turn ends idle, runner waits for the next external event"
 * mechanism. When the agent has active descendant Actor turns and nothing
 * else to do, it outputs a brief status line (no tool calls), and Runner.run
 * returns. Actor completion and user input both arrive through the bounded
 * MessageQueue; this module interprets that exit and resumes from the first
 * queued wake event:
 *
 *   1. `detectIdleYield(...)` — synchronous predicate over the run's exit
 *      state. Returns true when the agent turn ended without an
 *      `emit_handoff` AND there are still descendant Actor turns the agent is
 *      expected to wait on. False on every other path so legacy
 *      semantics stay untouched.
 *
 *   2. `waitForWakeEvent(...)` — async wait on the MessageQueue, which
 *      carries committed Actor completion envelopes and user input.
 *      Cooperative with `AbortSignal` so REPL Esc tears it down promptly.
 *
 *   3. `composeIdleYieldUserMessage(...)` — given a resolved
 *      `WakeEvent`, builds the synthetic user message that the runner
 *      should splice into the next `Runner.run` input.
 *
 * Bug A-G hotfix invariants preserved verbatim from the v0.7.38
 * release:
 *
 *   - Bug B / D / `hasEmittedTerminalVerdict` field: outer loop gates
 *     on terminal Evaluator verdict, NOT on legacy
 *     `managedProtocolPayloadRef.verdict`. The agent layer carries
 *     the boolean as a snapshot field; callers compute it.
 *   - Bug E / `hasPendingBackgroundMessages` field: fast-Actor recovery —
 *     keep the loop alive when either the Actor tree OR the queue still has
 *     undelivered work.
 *   - Bug F / abort listener cleanup: explicit
 *     `removeEventListener` in `settle()` even on non-abort wakes.
 */

import type { KodaXMessage, KodaXContentBlock, KodaXTaskResultMetadata } from '@kodax-ai/llm';

import type {
  MessageQueue,
  QueuedInputArtifact,
  QueuedMessage,
} from '../messaging/index.js';
import { createRuntimeDeliveryPredicate } from '../messaging/index.js';

interface PromptFragment {
  readonly id: string;
  readonly content: string;
  /** Accepted client input identity; stamped onto the drained user message. */
  readonly inputId?: string;
  readonly inputArtifacts?: readonly QueuedInputArtifact[];
}

export class QueuedInputArtifactError extends Error {
  readonly code = 'MODEL_INPUT_UNSUPPORTED';
  readonly detail: string;
  readonly artifactKind: QueuedInputArtifact['kind'];

  constructor(artifact: QueuedInputArtifact) {
    const label = artifact.kind === 'file'
      ? artifact.name ?? artifact.path
      : artifact.path;
    super(
      `Queued ${artifact.kind} artifacts are not supported by the generic idle-yield queue: ${label}.`,
    );
    this.name = 'QueuedInputArtifactError';
    this.artifactKind = artifact.kind;
    this.detail =
      'Only image artifacts can be rendered by @kodax-ai/agent idle-yield. Validate file/video artifacts in the SDK runtime before enqueue.';
  }
}

function buildQueuedPromptContent(
  fragments: readonly PromptFragment[],
): string | KodaXContentBlock[] {
  const text = fragments.map((fragment) => fragment.content).join('\n\n---\n\n');
  const artifacts = fragments.flatMap((fragment) => fragment.inputArtifacts ?? []);
  if (artifacts.length === 0) return text;

  const blocks: KodaXContentBlock[] = [{ type: 'text', text }];
  for (const artifact of artifacts) {
    if (artifact.kind === 'image') {
      blocks.push({
        type: 'image',
        path: artifact.path,
        mediaType: artifact.mediaType,
      });
    } else {
      throw new QueuedInputArtifactError(artifact);
    }
  }
  return blocks;
}

/**
 * Env-flag gate for the runner outer-loop wiring.
 *
 * **Slice C3 (v0.7.39) — flag retired as a runtime gate.** With
 * `await_child_task` removed (Slice C1) there is no working "v0.7.38
 * emulation" path: the prompt + banner always teach idle-yield, so
 * gating only the outer loop would leave a flag-OFF deployment with
 * agents that exit text-only but no resumer to wake them. The
 * function is therefore hard-coded to `true` and exists only for
 * import compatibility with the Slice A1/A2 callers and
 * historical-test references; the env var has no effect.
 */
export function isIdleYieldEnabled(): boolean {
  return true;
}

/**
 * Count the `tool_use` blocks on the last assistant message of a Runner
 * transcript. Used to populate `IdleYieldSnapshot.lastAssistantToolCallCount`
 * — a 0 count is the marker for the no-tool-calls exit branch
 * `Runner.run` uses to terminate its tool loop.
 */
export function countLastAssistantToolCalls(
  messages: readonly KodaXMessage[],
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') return 0;
    return (msg.content as readonly KodaXContentBlock[]).filter(
      (b) => (b as { type?: string }).type === 'tool_use',
    ).length;
  }
  return 0;
}

/** Snapshot of the agent run's exit state, computed by the runner layer. */
export interface IdleYieldSnapshot {
  /**
   * The last assistant message's tool-call count from the Runner.run
   * transcript. Idle-yield is signalled when this is 0 (Runner
   * exited via the no-tool-calls branch, not via a tool-driven
   * handoff).
   */
  readonly lastAssistantToolCallCount: number;
  /**
   * Number of active descendant Actor turns when Runner.run returned.
   * The historical field name is retained for source compatibility. Idle-yield only
   * fires when this is > 0 OR `hasPendingBackgroundMessages` is true
   * — otherwise there's nothing to wait for and the stop is a real
   * terminal event.
   */
  readonly pendingChildTaskCount: number;
  /**
   * True if the run's managed-protocol payload has been populated
   * with a handoff (typically `emit_handoff` for the worker→evaluator
   * boundary in legacy V1 / V2 chains). False = the run ended without
   * a handoff. Idle-yield REQUIRES this to be false; otherwise the
   * handoff target already owns the next step.
   *
   * **FEATURE_184 (v0.7.45) + FEATURE_190 (v0.7.43)**: the Evaluator
   * role was retired and Worker/Generator are now terminal. Under the
   * Sidecar Verifier architecture, the CANONICAL post-F184 terminal
   * signal is text-only termination — Worker produces a final text
   * message with no `tool_use` block, Runner.run exits via the no-
   * tool-calls branch, and this snapshot reads `hasEmittedHandoff:
   * false` + `lastAssistantToolCallCount: 0`. `detectIdleYield`
   * correctly returns false in that state (no pending child, no
   * pending banner) → the outer loop breaks. So text-only termination
   * is a first-class exit path; `hasEmittedHandoff` retained only for
   * the pre-FEATURE_190 Phase 3 legacy `emit_handoff` tool that
   * remains in scope through the cleanup window.
   */
  readonly hasEmittedHandoff: boolean;
  /**
   * v0.7.38 FEATURE_155 Bug B+D hotfix — true if the run's managed-
   * protocol payload has been populated with a terminal verdict
   * (`accept` / `blocked`; `revise` triggers a chain re-run, not
   * idle-yield continuation). Without this gate the outer loop would
   * keep re-entering `Runner.run` after a terminal verdict — wasting
   * LLM turns on post-verdict child notifications. Idle-yield
   * REQUIRES this to be false; same reasoning as `hasEmittedHandoff`
   * but for the verdict side.
   */
  readonly hasEmittedTerminalVerdict: boolean;
  /**
   * v0.7.38 FEATURE_155 Bug E hotfix — true if the background-priority
   * message queue still has undelivered envelopes destined for the
   * caller agent. Set this alongside `pendingChildTaskCount` because
   * of the **fast-Actor race**: a terminal Actor commit can enqueue its
   * notification before the outer loop snapshots the tree. The active-turn
   * count is then already zero even though the completion envelope still
   * needs delivery.
   * With this field, the loop stays in the wait state whenever
   * there's still something to deliver, regardless of which arm
   * (registry or queue) carries it.
   *
   * Drained only by the outer loop's `composeIdleYieldUserMessage`
   * call AFTER `waitForWakeEvent` returns. The mid-turn drain caps
   * at `user` priority post-FEATURE_155, so this is the **only**
   * consumer of background-priority messages — losing it strands
   * the banner.
   */
  readonly hasPendingBackgroundMessages: boolean;
}

/**
 * Pure predicate. True when the agent turn ended via the
 * "no tool calls + still has pending children" path that idle-yield
 * is designed to handle.
 *
 * The conjunction terms are deliberately independent — caller can mix
 * in additional gating (e.g. a feature flag) without rewriting this.
 * Returning false here means "treat the run as terminal / delegate to
 * legacy semantics" and is the safe default. The current term set is:
 * `lastAssistantToolCallCount`, `hasEmittedHandoff`,
 * `hasEmittedTerminalVerdict`, and (`pendingChildTaskCount` OR
 * `hasPendingBackgroundMessages`) — the last pair forms the wait-or-
 * resume gate (fast-child race recovery; see field docs).
 */
export function detectIdleYield(snapshot: IdleYieldSnapshot): boolean {
  if (snapshot.lastAssistantToolCallCount > 0) return false;
  if (snapshot.hasEmittedHandoff) return false;
  if (snapshot.hasEmittedTerminalVerdict) return false;
  // Either a pending child OR an undelivered background banner keeps
  // us in the wait state — see `hasPendingBackgroundMessages` docs
  // for the fast-child race rationale.
  if (snapshot.pendingChildTaskCount <= 0
      && !snapshot.hasPendingBackgroundMessages) return false;
  return true;
}

// FEATURE_167 (v0.7.41) `detectMissingTerminalVerdict` predicate removed
// in FEATURE_190 (v0.7.43). F184 v0.7.45 retired the in-chain Evaluator
// role (`detectMissingTerminalVerdict`'s sole purpose was retrying the
// Evaluator turn when it terminated text-only without emit_verdict),
// and F184 Phase C.2 deleted the runner call site. The predicate
// remained as dead code until F190 cleaned it up. The B1 retry path it
// served is structurally absent under the Sidecar Verifier Stop-hook
// architecture — Worker text-only termination IS the canonical terminal
// signal; no separate "missing verdict" state exists.

/**
 * Discriminated union surfacing the reason a wake completed.
 *
 * Actor completions and user input are both represented as queued messages;
 * cancellation remains a distinct event so callers can terminate promptly.
 */
export type WakeEvent =
  | {
      readonly kind: 'messages-arrived';
      readonly messages: readonly QueuedMessage[];
    }
  | { readonly kind: 'host-input-arrived' }
  | { readonly kind: 'aborted' };

export interface WaitForWakeEventOptions {
  /** Process-global message queue surface (FEATURE_115 substrate). */
  readonly messageQueue: MessageQueue;
  /**
   * AgentId filter for queue dequeues. Use `undefined` to match
   * main-thread messages (the standard queue scope).
   */
  readonly agentId: string | undefined;
  /**
   * Optional cancellation. When fired, the waiter resolves with
   * `{ kind: 'aborted' }` and tears down its subscriptions.
   */
  readonly abortSignal?: AbortSignal;
  /** @deprecated Queue subscriptions now wake immediately. */
  readonly pollIntervalMs?: number;
}

/**
 * Wait for MessageQueue arrivals or cancellation. Returns the first wake
 * event. Guarantees:
 *
 *   - Cleanup: queue and abort subscriptions are removed on resolution.
 *   - At-most-once dequeue: when the queue arm wins, the messages it
 *     drained are returned to the caller AND removed from the queue
 *     (the caller is now responsible for splicing them into the
 *     agent's next-turn context).
 *   - Abort-safe: if `abortSignal` fires before any other event, the
 *     waiter resolves with `{ kind: 'aborted' }`. Actor execution
 *     cancellation remains owned by the Actor controller.
 *
 * Caller responsibilities:
 *   - Splice the returned messages into the agent's
 *     next Runner.run input. The waiter does not itself construct
 *     synthetic user-message bytes — that's the runner-layer's job.
 */
export function waitForWakeEvent(
  options: WaitForWakeEventOptions,
): Promise<WakeEvent> {
  const { messageQueue, agentId, abortSignal } = options;

  return new Promise<WakeEvent>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    // v0.7.38 FEATURE_155 Bug F hotfix — abort listener leak. Without
    // tracking & removing on wake, every idle-yield iteration on the
    // same long-lived `abortSignal` (one per outer-loop turn, capped at
    // IDLE_YIELD_MAX_ITERATIONS=64 per run) leaves a dead listener
    // attached. `{once:true}` only auto-removes when the listener
    // actually fires; if the wake wins the race (the common case),
    // the listener stays. AbortSignal is an EventTarget (no MaxListeners
    // warning), so the leak was silent. Capture the bound handler now
    // and remove it explicitly in `settle()`.
    const abortHandler = (): void => {
      settle({ kind: 'aborted' });
    };
    const settle = (event: WakeEvent): void => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      abortSignal?.removeEventListener('abort', abortHandler);
      resolve(event);
    };

    if (abortSignal?.aborted) {
      settle({ kind: 'aborted' });
      return;
    }

    // Queue arm — drain once, subscribe, then recheck. The second read closes
    // the enqueue gap between the first snapshot and listener registration.
    const drain = (): void => {
      if (settled) return;
      const snapshot = messageQueue.getSnapshot();
      const hasHostPrompt = snapshot.some((message) => (
        message.agentId === agentId
        && message.priority === 'user'
        && message.mode === 'prompt'
        && message.delivery === 'host'
      ));
      if (hasHostPrompt) {
        settle({ kind: 'host-input-arrived' });
        return;
      }
      const messages = messageQueue.dequeue({
        agentId,
        maxPriority: 'background',
        predicate: createRuntimeDeliveryPredicate(snapshot, agentId),
      });
      if (messages.length > 0) {
        settle({ kind: 'messages-arrived', messages });
      }
    };

    drain();
    if (settled) return;

    unsubscribe = messageQueue.subscribe((event) => {
      if (event.kind !== 'enqueued' || event.message.agentId !== agentId) return;
      drain();
    });

    // Abort arm — tear down on Esc / parent-cancel. Note: `{once:true}`
    // is still useful as belt-and-suspenders (auto-remove on abort
    // fire) but the explicit removeEventListener in `settle()` is the
    // load-bearing cleanup for the common non-abort path.
    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    if (abortSignal?.aborted) {
      settle({ kind: 'aborted' });
      return;
    }
    drain();

  });
}

/**
 * Compose the synthetic user message spliced after an agent idle-yield
 * resume. The runner outer loop calls this with the resolved
 * `WakeEvent` plus a function that drains any pending background
 * messages (typically `() => getMessageQueue().dequeue(...)`).
 *
 *   - `messages-arrived` wake: the queue arm already drained the
 *     QueuedMessage(s); pass their content through verbatim. Then
 *     drain anything that arrived between settle and this call (a
 *     tight race with the dispatch handler's enqueue is possible) and
 *     concatenate.
 *
 *   - `aborted`: caller is expected to break out before reaching this
 *     helper. If reached anyway, returns `undefined` so the outer
 *     loop treats it as a terminal exit.
 *
 * Returns `undefined` when the wake yields no spliceable content —
 * the outer loop treats that as a real terminal exit.
 */
/**
 * FEATURE_121 (v0.7.40) — Envelope aggregate budget enforcer.
 *
 * Pure `string[] → string[]` transform applied to drained envelope
 * fragments before they're joined into a single synthetic user
 * message. The coding layer provides the implementation that knows
 * how to spill oversized fragments to disk and replace them with
 * preview + path markers (see `@kodax-ai/coding`
 * `createEnvelopeAggregateBudgetEnforcer`). The agent layer only
 * sees this opaque function type — **no `@kodax-ai/coding` symbols
 * may leak into this signature**, otherwise ADR-021 layer
 * independence breaks and `@kodax/agent` cannot build standalone.
 */
export interface EnvelopeAggregateCapacityContext {
  /** Authoritative transcript immediately before the resume messages. */
  readonly transcript: readonly KodaXMessage[];
  /** Non-synthetic messages that will share the same next request. */
  readonly pendingMessages: readonly KodaXMessage[];
}

export type EnvelopeAggregateEnforcer = (
  fragments: readonly string[],
  context?: EnvelopeAggregateCapacityContext,
) => readonly string[] | Promise<readonly string[]>;

/**
 * FEATURE_159 (v0.7.40) — mode-split synthetic.
 *
 * Pre-FEATURE_159: every wake-drained message was wrapped in a single
 * `_synthetic: true` user message. This was correct for child-task
 * notifications (the agent needs to see them; the human doesn't), but
 * WRONG for user-typed prompts that arrived via chat-while-waiting —
 * those got hidden from the transcript so users couldn't see their own
 * messages echoed in the conversation history.
 *
 * Post-FEATURE_159: fragments are partitioned by `msg.mode`. Two
 * separate messages may be emitted:
 *   1. Synthetic banner (`_synthetic: true`) — concatenates
 *      `agent-message` + `task-notification` + `system-reminder` content. Hidden from
 *      REPL display; the agent sees it as context. Spliced FIRST so it
 *      reads as the "tail of the prior turn" before the new prompt.
 *   2. Real user message (no `_synthetic`) — concatenates `prompt`
 *      content from chat-while-waiting. Renders as a normal user
 *      bubble in transcript. Spliced AFTER the banner so the chain
 *      reads naturally as "previous turn outputs → user follow-up".
 *
 * Aggregate budget enforcer applies ONLY to the synthetic banner
 * fragments (the side that can carry child-task envelopes of arbitrary
 * size). User prompts pass through unchanged — the user's intent must
 * never be silently truncated.
 *
 * Return type changed from `KodaXMessage | undefined` to
 * `readonly KodaXMessage[]` (possibly empty). Callers must spread the
 * result into their next-iteration input.
 */
export async function composeIdleYieldUserMessage(
  wakeEvent: WakeEvent,
  drainBackgroundQueue: () => readonly QueuedMessage[],
  enforceAggregate?: EnvelopeAggregateEnforcer,
  // FEATURE_213 (v0.7.45) — reports the user-typed `mode:'prompt'` fragments
  // drained on this wake, so the caller can surface them to the UI. The wake
  // path splices the prompt into the agent transcript directly; this is the
  // only signal the UI gets about a follow-up typed during idle-yield.
  onUserPrompts?: (
    prompts: readonly string[],
    queuedMessageIds: readonly string[],
    promptMessage: KodaXMessage,
    promptMessagesByQueuedId: ReadonlyMap<string, KodaXMessage>,
  ) => void | Promise<void>,
  resolveTurnId?: () => string | undefined | Promise<string | undefined>,
  priorMessages: readonly KodaXMessage[] = [],
): Promise<readonly KodaXMessage[]> {
  if (wakeEvent.kind === 'host-input-arrived') return [];
  const promptFragments: PromptFragment[] = [];
  const syntheticFragments: string[] = [];
  // Tag the composed synthetic message when an actor result notification was
  // drained so restore can recover it at the original transcript position. A
  // pure system-reminder drain stays untagged. In the rare mixed drain (a
  // task-notification AND a system-reminder settle on the same wake), both are
  // concatenated into one message and the whole message is tagged — content is
  // preserved, only the single `_source` label is shared.
  let hadTaskNotification = false;
  const taskResults: KodaXTaskResultMetadata[] = [];

  const intake = (msg: QueuedMessage): void => {
    if (typeof msg.content !== 'string' || msg.content.length === 0) return;
    if (msg.mode === 'prompt') {
      promptFragments.push({
        id: msg.id,
        content: msg.content,
        ...(msg.inputId !== undefined ? { inputId: msg.inputId } : {}),
        inputArtifacts: msg.inputArtifacts,
      });
    } else {
      // 'agent-message' / 'task-notification' / 'system-reminder' /
      // future synthetic modes.
      if (msg.mode === 'task-notification') {
        hadTaskNotification = true;
        if (msg.taskResult) taskResults.push(msg.taskResult);
      }
      syntheticFragments.push(msg.content);
    }
  };

  if (wakeEvent.kind === 'messages-arrived') {
    for (const msg of wakeEvent.messages) intake(msg);
  }

  if (wakeEvent.kind !== 'aborted') {
    const drained = drainBackgroundQueue();
    for (const msg of drained) intake(msg);
  }

  // Defensive fallback — child-* wake with empty queue. Only shape
  // that can reach this branch is a misbehaving dispatch path that
  // resolved the promise without enqueuing; surface a minimal banner
  // (synthetic, not user-visible) so the agent still observes the
  // resolution rather than silently looping again.
  const messages: KodaXMessage[] = [];
  const promptTurnId = promptFragments.length > 0 ? await resolveTurnId?.() : undefined;
  const promptMessage: KodaXMessage | undefined = promptFragments.length > 0
    ? {
        role: 'user',
        content: buildQueuedPromptContent(promptFragments),
        ...(promptFragments.length === 1 && promptFragments[0]!.inputId !== undefined
          ? { inputId: promptFragments[0]!.inputId }
          : {}),
        ...(promptTurnId !== undefined ? { turnId: promptTurnId } : {}),
        timestamp: new Date().toISOString(),
      }
    : undefined;
  const promptMessagesByQueuedId = new Map<string, KodaXMessage>();
  if (promptMessage !== undefined) {
    if (promptFragments.length === 1) {
      promptMessagesByQueuedId.set(promptFragments[0]!.id, promptMessage);
    } else {
      for (const fragment of promptFragments) {
        promptMessagesByQueuedId.set(fragment.id, {
          role: 'user',
          content: buildQueuedPromptContent([fragment]),
          ...(fragment.inputId !== undefined ? { inputId: fragment.inputId } : {}),
          ...(promptTurnId !== undefined ? { turnId: promptTurnId } : {}),
          timestamp: promptMessage.timestamp,
        });
      }
    }
  }
  const promptMessages = [...promptMessagesByQueuedId.values()];

  if (syntheticFragments.length > 0) {
    // Aggregate budget enforcer applies only here — task-notification
    // envelopes are the side that can balloon into MB of child output.
    const enforced = enforceAggregate
      ? await enforceAggregate(syntheticFragments, {
          transcript: priorMessages,
          pendingMessages: promptMessages,
        })
      : syntheticFragments;
    if (enforced.length > 0) {
      messages.push({
        role: 'user',
        content: enforced.join('\n\n'),
        // Hidden in REPL display — agent-only context.
        _synthetic: true,
        // Only an actual task notification receives the provenance marker; a
        // pure system reminder stays untagged.
        ...(hadTaskNotification ? { _source: 'agent-completed' } : {}),
        ...(taskResults.length === 1 ? { _taskResult: taskResults[0] } : {}),
        ...(taskResults.length > 1 ? { _taskResults: taskResults } : {}),
        // GOAL 2: stamp finalize-time (when the parent observed the wake) so the
        // session entry carries a real per-message time, not the save-batch time.
        timestamp: new Date().toISOString(),
      });
    }
  }

  if (promptMessage) {
    // FEATURE_213 — tell the caller about the user's typed prompt(s) so the UI
    // records them. The message below only reaches the AGENT transcript; the UI
    // renders from its own history/ledger and would otherwise never see this.
    await onUserPrompts?.(
      promptFragments.map((fragment) => fragment.content),
      promptFragments.map((fragment) => fragment.id),
      promptMessage,
      promptMessagesByQueuedId,
    );
    // No `_synthetic` flag — this IS the user's typed input echoed into
    // the transcript as a normal user bubble.
    messages.push(...promptMessages);
  }

  return messages;
}
