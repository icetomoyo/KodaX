import {
  emitKodaXDiagnostic,
  persistCompactedSessionHistory,
  type KodaXSessionData,
  type KodaXSessionScope,
  type KodaXSessionStorage,
} from '@kodax-ai/agent';
import type { KodaXEvents } from '../types.js';

export interface DurableCompactionEventsInput {
  readonly events: KodaXEvents;
  readonly storage?: KodaXSessionStorage;
  readonly sessionId: string;
  readonly persistedByHost?: boolean;
  readonly currentAgentId?: string;
  readonly sessionScope?: KodaXSessionScope;
  readonly initialSessionData?: Omit<KodaXSessionData, 'messages' | 'lineage'>;
  readonly signal?: AbortSignal;
}

function stripRunnerSystemMessage<T extends { readonly role: string }>(
  messages: readonly T[],
): readonly T[] {
  return messages[0]?.role === 'system' ? messages.slice(1) : messages;
}

/** Add an awaited durable commit for a core-owned root or isolated child run. */
export function withDurableCompactionPersistence(
  input: DurableCompactionEventsInput,
): KodaXEvents {
  const storage = input.storage;
  const isolatedChild = input.currentAgentId !== undefined
    && input.sessionScope === 'managed-task-worker';
  if (!storage || input.persistedByHost || (input.currentAgentId !== undefined && !isolatedChild)) {
    return input.events;
  }
  const original = input.events.onCompactedMessages;
  return {
    ...input.events,
    async onCompactedMessages(messages, update, meta) {
      if (meta?.contextKind === 'child' && !isolatedChild) {
        await original?.(messages, update, meta);
        return;
      }
      if (!update?.preCompactionMessages) {
        throw new Error('Committed compaction is missing its exact pre-compaction snapshot.');
      }
      const persistentMessages = stripRunnerSystemMessage(messages);
      const persistentUpdate = {
        ...update,
        preCompactionMessages: stripRunnerSystemMessage(update.preCompactionMessages),
      };
      await persistCompactedSessionHistory({
        storage,
        sessionId: input.sessionId,
        compactedMessages: persistentMessages,
        update: persistentUpdate,
        initialSessionData: input.initialSessionData,
        signal: input.signal,
      });
      input.signal?.throwIfAborted();
      try {
        await original?.(messages, update, meta);
      } catch (error) {
        // Core-owned storage is the canonical commit. A downstream observer
        // cannot roll that durable fact back after save has succeeded.
        emitKodaXDiagnostic({
          source: 'coding:compaction',
          level: 'warn',
          message: 'Post-commit compaction observer failed.',
          detail: {
            sessionId: input.sessionId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },
  };
}
