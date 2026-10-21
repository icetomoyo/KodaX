import { createHash } from 'node:crypto';
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
  let committedDigest: string | undefined;
  return {
    ...input.events,
    ...(input.events.onContextCapacityBlocked ? {
      onContextCapacityBlocked: async (state, signal, meta) => {
        if (meta?.childAgentId !== undefined && meta.childAgentId !== input.currentAgentId) {
          return input.events.onContextCapacityBlocked!(state, signal, meta);
        }
        signal?.throwIfAborted();
        const saved = await storage.load(input.sessionId);
        const digest = saved && createHash('sha256').update(JSON.stringify(saved.messages)).digest('hex');
        if (!saved?.lineage || !committedDigest || digest !== committedDigest) {
          throw new Error('Context recovery checkpoint no longer matches committed history.');
        }
        const turnId = [...saved.messages].reverse().find(message => message.role === 'user' && message.turnId)?.turnId;
        return input.events.onContextCapacityBlocked!({ ...state, checkpoint: {
          ...(state.remainingIterations === undefined ? {} : { remainingIterations: state.remainingIterations }),
          ...(state.remainingContinuationIterations === undefined ? {} : { remainingContinuationIterations: state.remainingContinuationIterations }),
          version: 1, sessionId: input.sessionId, activeEntryId: saved.lineage.activeEntryId,
          messagesDigest: committedDigest, ...(turnId ? { turnId } : {}),
        } }, signal, meta);
      },
    } satisfies Pick<KodaXEvents, 'onContextCapacityBlocked'> : {}),
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
      committedDigest = createHash('sha256').update(JSON.stringify(persistentMessages)).digest('hex');
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
