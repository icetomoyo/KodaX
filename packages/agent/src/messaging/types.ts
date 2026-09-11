/**
 * @kodax-ai/agent/messaging — Message queue types
 *
 * FEATURE_115 (v0.7.36): agentId-scoped 2-tier priority queue infrastructure.
 *
 * Per ADR-021: messaging is a generic agent-platform primitive (not coding-
 * specific). Downstream consumers:
 *   - @kodax-ai/coding runner-driven mid-turn drain
 *   - @kodax-ai/repl InkREPL ESC soft-pause + text injection (FEATURE_111 absorbed)
 *   - subagent task-notification routing (FEATURE_155 idle-yield wakeup)
 *
 * Phase 0.6 study (`c:/tmp/claude-code-actual-usage.md`): Claude Code's
 * `'now'` priority has zero production usage; KodaX simplifies to 2 tiers.
 */

import type { KodaXInputArtifact } from '../media/types.js';
import type { KodaXTaskResultMetadata } from '@kodax-ai/llm';

export type MessagePriority = 'user' | 'background';

/**
 * Delivery owner for user prompts. Ordinary messages are runtime-deliverable.
 * `host` is reserved for prompts that must re-enter a trusted host command
 * pipeline (for example an explicit user Skill invocation) before any model
 * can observe them.
 */
export type MessageDelivery = 'runtime' | 'host';

/**
 * Delivery semantics, independent of priority:
 * - `prompt`: user-authored input; delivered as a real user turn.
 * - `agent-message`: Runtime-authenticated Agent communication.
 * - `task-notification`: structured Agent completion evidence.
 * - `system-reminder`: Runtime-authored synthetic guidance.
 */
export type MessageMode =
  | 'prompt'
  | 'agent-message'
  | 'task-notification'
  | 'system-reminder';

export type QueuedInputArtifact = KodaXInputArtifact;

export interface QueuedMessage {
  /** Stable id for tracing / dedup. Format: `msg-<sequence>`. */
  readonly id: string;
  readonly priority: MessagePriority;
  /**
   * Routing key:
   *   undefined = main thread / coordinator agent
   *   'agent-id-XYZ' = subagent / specific consumer
   *
   * Drain consumers MUST filter by agentId match — undefined matches only
   * undefined-agentId messages, not "any agent".
   */
  readonly agentId?: string;
  readonly mode: MessageMode;
  /** Omitted means `runtime`; `host` messages must not be spliced into a model turn. */
  readonly delivery?: MessageDelivery;
  readonly content: string;
  /** Accepted client input identity; joins the canonical user message to its Host admission. */
  readonly inputId?: string;
  readonly inputArtifacts?: readonly QueuedInputArtifact[];
  readonly taskResult?: KodaXTaskResultMetadata;
  /** Wall-clock timestamp (`Date.now()`) for tracing only — not used for ordering. */
  readonly enqueuedAt: number;
}

export interface DequeueFilter {
  /**
   * Only return messages with this agentId.
   * undefined matches messages with no agentId (main-thread messages only).
   */
  readonly agentId?: string;
  /**
   * Highest priority level included in the drain.
   *   'user'       → only user priority drained, background stays queued
   *   'background' → both user + background drained (Sleep-gated case)
   */
  readonly maxPriority: MessagePriority;
  /**
   * Optional cap on number of messages drained in this call.
   * Defaults to unlimited (drains all matching).
   */
  readonly limit?: number;
  /**
   * FEATURE_159 (v0.7.40) — optional mode filter. Lets REPL split the
   * single queue into mode-typed views (e.g. `mode:'prompt'` for user
   * input vs `mode:'task-notification'` for child completion banners)
   * without separate queues. When omitted, all modes match.
   */
  readonly mode?: MessageMode;
  /**
   * FEATURE_159 (v0.7.40) — optional precise-id filter. Single-message
   * targeted removal — drives Esc-pop-this-uuid in REPL. When set, all
   * other filters still apply (agentId / priority / mode mismatches still
   * skip the message), so callers can't accidentally remove a message
   * outside their scope.
   */
  readonly id?: string;
  /**
   * FEATURE_159 (v0.7.40) — optional escape-hatch predicate, AND-ed with
   * the structured filters. Lets SDK consumers express conditions the
   * typed fields don't cover (e.g. timestamp ranges, content-match) without
   * forcing every new use case to extend `DequeueFilter`. KodaX-internal
   * code should prefer the typed fields for readability; this is the
   * "data-driven main path + predicate escape" pattern.
   *
   * Evaluated AFTER the typed filters succeed — so a `predicate` that
   * inspects `message.content` never runs on messages outside the
   * caller's `agentId` / `mode` / `id` scope.
   */
  readonly predicate?: (message: QueuedMessage) => boolean;
}

/**
 * FEATURE_159 (v0.7.40) — structured queue event emitted to subscribers.
 *
 * Replaces the prior `() => void` bare-notify signal. Carries the kind +
 * affected messages so SDK observability consumers (logging, tracing,
 * metrics) can react per-event without re-diffing snapshots.
 *
 * Event granularity rules:
 *   - `enqueued` fires ONCE per `enqueue()` call (always 1 message).
 *   - `dequeued` fires ONCE per `dequeue()` call that removed ≥1 message,
 *     carrying ALL drained messages in priority+FIFO order. No-op drains
 *     (filter matched nothing) fire no event — quiet by design so the
 *     idle consumers can probe without spamming subscribers.
 *   - `cleared` fires ONCE per `clear()` call that removed ≥1 message,
 *     carrying the pre-clear messages. Empty-queue clear fires nothing.
 *
 * The `useSyncExternalStore` React hook ignores the event payload (it
 * only needs the change signal); SDK / tracer consumers read the event.
 */
export type QueueEvent =
  | { readonly kind: 'enqueued'; readonly message: QueuedMessage }
  | { readonly kind: 'dequeued'; readonly messages: readonly QueuedMessage[] }
  | { readonly kind: 'cleared'; readonly messages: readonly QueuedMessage[] };

/** FEATURE_159 — `MessageQueue.subscribe` listener signature. */
export type QueueEventListener = (event: QueueEvent) => void;

export interface EnqueueInput {
  readonly priority: MessagePriority;
  readonly mode: MessageMode;
  /** Accepted client input identity carried onto the drained user message. */
  readonly inputId?: string;
  /** Omitted means `runtime`; use `host` for command-pipeline-owned prompts. */
  readonly delivery?: MessageDelivery;
  readonly content: string;
  readonly agentId?: string;
  readonly inputArtifacts?: readonly QueuedInputArtifact[];
  readonly taskResult?: KodaXTaskResultMetadata;
}
