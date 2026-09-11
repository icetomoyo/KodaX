/**
 * @kodax-ai/agent/messaging/queue — 2-tier agentId-scoped FIFO message queue.
 *
 * FEATURE_115 (v0.7.36).
 *
 * Invariants:
 *   - In-priority FIFO: messages of the same priority drain in enqueue order.
 *   - Cross-priority precedence: 'user' drains before 'background', regardless
 *     of enqueue order.
 *   - agentId routing: messages addressed to agentId X are only visible to
 *     consumers filtering for that exact agentId. undefined ≠ "any agent" —
 *     it specifically matches main-thread messages.
 *   - Not persistent: process restart loses queue state, by design (matches
 *     TodoStore semantics).
 *
 * The queue is process-global by default (`getMessageQueue()`); the class is
 * also exported for tests / isolated downstream use.
 */

import type {
  DequeueFilter,
  EnqueueInput,
  MessagePriority,
  QueueEvent,
  QueueEventListener,
  QueuedMessage,
} from './types.js';

/**
 * Smaller rank = higher precedence (drains first).
 *
 * Semantics of `maxPriority` filter (intentionally inclusive of the named
 * priority and any higher-precedence one):
 *   maxPriority='user'       → rank ≤ 0 → only user priority included.
 *   maxPriority='background' → rank ≤ 1 → user + background both included
 *                                          (Sleep-gated case).
 */
const PRIORITY_RANK: Record<MessagePriority, number> = {
  user: 0,
  background: 1,
};

function priorityWithinMax(
  target: MessagePriority,
  max: MessagePriority,
): boolean {
  return PRIORITY_RANK[target] <= PRIORITY_RANK[max];
}

function matchesFilter(message: QueuedMessage, filter: DequeueFilter): boolean {
  if (message.agentId !== filter.agentId) return false;
  if (!priorityWithinMax(message.priority, filter.maxPriority)) return false;
  if (filter.mode !== undefined && message.mode !== filter.mode) return false;
  if (filter.id !== undefined && message.id !== filter.id) return false;
  // Predicate runs LAST so it never sees messages outside the caller's
  // scope (saves cost on hot paths + prevents predicate from accidentally
  // observing cross-agent / cross-priority traffic).
  if (filter.predicate && !filter.predicate(message)) return false;
  return true;
}

export class MessageQueue {
  private messages: QueuedMessage[] = [];
  private nextSeq = 1;
  /**
   * FEATURE_159 (v0.7.40) — observable subscription set. Same pattern as
   * Claude Code's `messageQueueManager.ts` `createSignal()` substrate,
   * but the listener carries a structured `QueueEvent` so SDK
   * observability consumers (logger, tracer, metrics) can react per-
   * event without re-diffing snapshots. `useSyncExternalStore` consumers
   * still work — they ignore the event argument.
   *
   * Cached `snapshotRef` keeps reference identity stable across reads
   * when nothing changed — required by React 18's `useSyncExternalStore`
   * to avoid render loops.
   */
  private listeners = new Set<QueueEventListener>();
  private snapshotRef: readonly QueuedMessage[] = Object.freeze([]);

  private notify(event: QueueEvent): void {
    this.snapshotRef = Object.freeze([...this.messages]);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Subscribers must not be able to break each other's notifications.
        // React's useSyncExternalStore listener never throws, and KodaX's
        // own subscribers wrap in try/catch — defensive swallow keeps the
        // queue invariant intact if a buggy SDK consumer is added later.
      }
    }
  }

  /**
   * Subscribe to queue mutations. Compatible with React 18's
   * `useSyncExternalStore(subscribe, getSnapshot)` — the hook passes a
   * `() => void` callback, which is structurally assignable to the
   * `QueueEventListener` parameter because TypeScript treats
   * callback parameter discards as compatible. SDK consumers that
   * declare a typed `(event: QueueEvent) => void` listener see the
   * structured event.
   *
   * Listener is called synchronously after every mutation; returns an
   * unsubscribe function.
   */
  subscribe = (listener: QueueEventListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Returns the current frozen queue snapshot. Reference identity is
   * stable across reads when the queue has not mutated, which is the
   * contract React's `useSyncExternalStore` relies on.
   */
  getSnapshot = (): readonly QueuedMessage[] => {
    return this.snapshotRef;
  };

  /** Returns the assigned id of the enqueued message. */
  enqueue(input: EnqueueInput): string {
    const id = `msg-${this.nextSeq++}`;
    const message: QueuedMessage = {
      id,
      priority: input.priority,
      mode: input.mode,
      delivery: input.delivery,
      content: input.content,
      ...(input.inputId !== undefined ? { inputId: input.inputId } : {}),
      agentId: input.agentId,
      inputArtifacts: input.inputArtifacts,
      taskResult: input.taskResult,
      enqueuedAt: Date.now(),
    };
    this.messages = [...this.messages, message];
    this.notify({ kind: 'enqueued', message });
    return id;
  }

  /**
   * Drain matching messages, ordered by priority (user > background) then
   * FIFO within each priority. Removes drained messages from the queue.
   */
  dequeue(filter: DequeueFilter): QueuedMessage[] {
    const candidates: { originalIndex: number; message: QueuedMessage }[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const message = this.messages[i];
      if (!message) continue;
      if (matchesFilter(message, filter)) {
        candidates.push({ originalIndex: i, message });
      }
    }

    candidates.sort((a, b) => {
      // Smaller rank = higher precedence → ascending sort puts user first.
      const priorityDelta =
        PRIORITY_RANK[a.message.priority] - PRIORITY_RANK[b.message.priority];
      if (priorityDelta !== 0) return priorityDelta;
      return a.originalIndex - b.originalIndex;
    });

    const limit = filter.limit;
    const taken =
      typeof limit === 'number' && candidates.length > limit
        ? candidates.slice(0, limit)
        : candidates;

    if (taken.length === 0) {
      // Nothing matched — no mutation, no notify. Keeps subscribers from
      // re-rendering on no-op drains and read-register-recheck probes.
      return [];
    }

    const takenIndices = new Set(taken.map((t) => t.originalIndex));
    this.messages = this.messages.filter((_, i) => !takenIndices.has(i));
    const drained = taken.map((t) => t.message);
    this.notify({ kind: 'dequeued', messages: drained });

    return drained;
  }

  /**
   * Peek at matching messages without removing them. Returns messages in
   * the same priority + FIFO order that `dequeue(filter)` would return,
   * so callers can inspect what the next drain would yield.
   */
  peek(filter: DequeueFilter): QueuedMessage[] {
    const candidates: { originalIndex: number; message: QueuedMessage }[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const message = this.messages[i];
      if (!message) continue;
      if (matchesFilter(message, filter)) {
        candidates.push({ originalIndex: i, message });
      }
    }

    candidates.sort((a, b) => {
      const priorityDelta =
        PRIORITY_RANK[a.message.priority] - PRIORITY_RANK[b.message.priority];
      if (priorityDelta !== 0) return priorityDelta;
      return a.originalIndex - b.originalIndex;
    });

    const limit = filter.limit;
    const sliced =
      typeof limit === 'number' && candidates.length > limit
        ? candidates.slice(0, limit)
        : candidates;
    return sliced.map((c) => c.message);
  }

  /** Total queue size across all priorities / agents. */
  size(): number {
    return this.messages.length;
  }

  /** Count of messages matching the filter. */
  count(filter: DequeueFilter): number {
    return this.peek(filter).length;
  }

  /** True iff at least one message matches the filter. */
  has(filter: DequeueFilter): boolean {
    return this.count(filter) > 0;
  }

  /** Remove all queued messages — used in tests / process abort scenarios. */
  clear(): void {
    if (this.messages.length === 0) return;
    const cleared = this.messages;
    this.messages = [];
    this.notify({ kind: 'cleared', messages: cleared });
  }
}

let processGlobalQueue: MessageQueue | undefined;

/**
 * Returns the process-global MessageQueue singleton, creating it lazily on
 * first call. Use this for production wiring; instantiate `MessageQueue`
 * directly in tests / isolated subsystems where a shared instance would
 * cause cross-test pollution.
 */
export function getMessageQueue(): MessageQueue {
  if (!processGlobalQueue) {
    processGlobalQueue = new MessageQueue();
  }
  return processGlobalQueue;
}

/**
 * Test-only reset hook. Production code MUST NOT call this. Underscored
 * prefix follows the same convention as `_resetInvariantRegistry` /
 * `_resetAdmittedAgentBindings` / `_resetAdmissionMetrics`.
 */
export function _resetMessageQueueForTests(): void {
  processGlobalQueue = undefined;
}
