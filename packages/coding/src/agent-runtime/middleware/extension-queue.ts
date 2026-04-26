/**
 * Extension queue + per-turn settle middleware — CAP-020
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-020-extensionruntime-per-turn-queued-message-consumption
 *
 * Class 1 (substrate middleware). Three responsibilities, all triggered
 * at the per-turn epilogue of the SA loop:
 *
 *   1. **`createExtensionRuntimeSessionController`** — factory that
 *      produces the controller object passed to `extensionRuntime.bindController`
 *      at frame entry. Extensions read/mutate session state through this
 *      controller (queueUserMessage / get/setSessionState /
 *      append/list/clearSessionRecords / get/setActiveTools /
 *      get/setModelSelection / get/setThinkingLevel).
 *
 *   2. **`settleExtensionTurn`** — fires the `turn:settle` extension hook
 *      at the end of each turn, exposing `queueUserMessage`,
 *      `setModelSelection`, `setThinkingLevel` callbacks so extensions
 *      can react to turn outcome. Time-ordering: AFTER current turn's
 *      tool results settle; BEFORE microcompact (CAP-014); MUST run
 *      before queue drain.
 *
 *   3. **`appendQueuedRuntimeMessages`** — splices the queued-messages
 *      array out of `RuntimeSessionState` and pushes them onto the
 *      active message buffer. Returns true iff anything was drained.
 *      Time-ordering: AFTER `settleExtensionTurn`; BEFORE next prompt
 *      build.
 *
 * The four `settleExtensionTurn` call sites in agent.ts (turn-end
 * success, COMPLETE, BLOCKED, error) all fire BEFORE
 * `appendQueuedRuntimeMessages` to preserve the invariant: extensions
 * may queue messages during settle, those messages are then consumed
 * before the next turn.
 *
 * Migration history: extracted from `agent.ts:366-450`
 * (`createExtensionRuntimeSessionController`), `agent.ts:494-502`
 * (`appendQueuedRuntimeMessages`), `agent.ts:1278-1304`
 * (`settleExtensionTurn`) — pre-FEATURE_100 baseline — during
 * FEATURE_100 P2.
 */

import type { KodaXMessage } from '@kodax/ai';

import type {
  KodaXExtensionSessionRecord,
  KodaXJsonValue,
  KodaXReasoningMode,
} from '../../types.js';
import { runActiveExtensionHook } from '../../extensions/runtime.js';
import {
  type RuntimeSessionState,
  createSessionRecordId,
  getExtensionStateBucket,
  normalizeQueuedRuntimeMessage,
  normalizeRuntimeModelSelection,
} from '../runtime-session-state.js';

export function appendQueuedRuntimeMessages(
  messages: KodaXMessage[],
  runtimeSessionState: RuntimeSessionState,
): boolean {
  if (runtimeSessionState.queuedMessages.length === 0) {
    return false;
  }

  messages.push(...runtimeSessionState.queuedMessages.splice(0));
  return true;
}

export async function settleExtensionTurn(
  sessionId: string,
  lastText: string,
  runtimeSessionState: RuntimeSessionState,
  options: {
    hadToolCalls: boolean;
    success: boolean;
    signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  },
): Promise<void> {
  await runActiveExtensionHook('turn:settle', {
    sessionId,
    lastText,
    hadToolCalls: options.hadToolCalls,
    success: options.success,
    signal: options.signal,
    queueUserMessage: (message) => {
      runtimeSessionState.queuedMessages.push(normalizeQueuedRuntimeMessage(message));
    },
    setModelSelection: (next) => {
      runtimeSessionState.modelSelection = normalizeRuntimeModelSelection(next);
    },
    setThinkingLevel: (level) => {
      runtimeSessionState.thinkingLevel = level;
    },
  });
}

export function createExtensionRuntimeSessionController(state: RuntimeSessionState) {
  return {
    queueUserMessage: (message: KodaXMessage) => {
      state.queuedMessages.push(normalizeQueuedRuntimeMessage(message));
    },
    getSessionState: <T = KodaXJsonValue>(extensionId: string, key: string) =>
      state.extensionState.get(extensionId)?.get(key) as T | undefined,
    setSessionState: (extensionId: string, key: string, value: KodaXJsonValue | undefined) => {
      const bucket = getExtensionStateBucket(state.extensionState, extensionId);
      if (value === undefined) {
        bucket.delete(key);
        if (bucket.size === 0) {
          state.extensionState.delete(extensionId);
        }
        return;
      }
      bucket.set(key, value);
    },
    getSessionStateSnapshot: (extensionId: string) =>
      Object.fromEntries((state.extensionState.get(extensionId) ?? new Map()).entries()),
    appendSessionRecord: (
      extensionId: string,
      type: string,
      data?: KodaXJsonValue,
      options?: { dedupeKey?: string },
    ) => {
      const normalizedType = type.trim();
      const dedupeKey = options?.dedupeKey?.trim() || undefined;
      const record: KodaXExtensionSessionRecord = {
        id: createSessionRecordId(),
        extensionId,
        type: normalizedType,
        ts: Date.now(),
        ...(data === undefined ? {} : { data }),
        ...(dedupeKey ? { dedupeKey } : {}),
      };

      if (dedupeKey) {
        const existingIndex = state.extensionRecords.findIndex((entry) =>
          entry.extensionId === extensionId
          && entry.type === normalizedType
          && entry.dedupeKey === dedupeKey,
        );
        if (existingIndex >= 0) {
          state.extensionRecords.splice(existingIndex, 1, record);
          return record;
        }
      }

      state.extensionRecords.push(record);
      return record;
    },
    listSessionRecords: (extensionId: string, type?: string) =>
      state.extensionRecords
        .filter((record) =>
          record.extensionId === extensionId
          && (type === undefined || record.type === type),
        )
        .map((record) => ({ ...record })),
    clearSessionRecords: (extensionId: string, type?: string) => {
      const before = state.extensionRecords.length;
      state.extensionRecords = state.extensionRecords.filter((record) =>
        record.extensionId !== extensionId
        || (type !== undefined && record.type !== type),
      );
      return before - state.extensionRecords.length;
    },
    getActiveTools: () => [...state.activeTools],
    setActiveTools: (toolNames: string[]) => {
      state.activeTools = Array.from(
        new Set(toolNames.map((name) => name.trim()).filter(Boolean)),
      );
    },
    getModelSelection: () => ({ ...state.modelSelection }),
    setModelSelection: (next: { provider?: string; model?: string }) => {
      state.modelSelection = normalizeRuntimeModelSelection(next);
    },
    getThinkingLevel: () => state.thinkingLevel,
    setThinkingLevel: (level: KodaXReasoningMode) => {
      state.thinkingLevel = level;
    },
  };
}
