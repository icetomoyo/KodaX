/**
 * RuntimeSessionState — CAP-050
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-050-runtimesessionstate-construction
 *
 * Session-scoped mutable state container that lives for the duration of a
 * single Runner frame. Owns:
 *
 *   - `queuedMessages`     — REPL-side queued user inputs not yet folded
 *                            into the main turn loop (CAP-038 / CAP-020).
 *   - `extensionState`     — per-extension key/value store, hydrated from
 *                            session storage on resume and snapshotted on
 *                            terminal save (CAP-011/-013 consume this).
 *   - `extensionRecords`   — append-only audit log of extension events.
 *   - `activeTools`        — post-`filterExcludedTools` tool name list
 *                            (already excludes child-agent forbidden tools).
 *   - `editRecoveryAttempts` / `blockedEditWrites` — anchor-recovery state
 *                            consulted by CAP-015 + CAP-010.
 *   - `modelSelection`     — current provider/model (mutated by CAP-055
 *                            per-turn override).
 *   - `thinkingLevel`      — current reasoning depth (FEATURE_078).
 *   - `lastToolErrorCode` / `lastToolResultBytes` — small telemetry
 *                            fields used by retry-decision middleware.
 *
 * Construction is parameterised — callers resolve env (active tools,
 * provider name, thinking level) and pass the result through `input`.
 * This keeps the builder free of `KodaXOptions`-flavoured plumbing and
 * makes it directly testable.
 *
 * Migration history: extracted from `agent.ts:145-159` (interface),
 * `agent.ts:332-345` (`createRuntimeExtensionState`), `agent.ts:347-361`
 * (`snapshotRuntimeExtensionState`), `agent.ts:363-375`
 * (`getExtensionStateBucket`), `agent.ts:1578-1593` (inline builder
 * — pre-FEATURE_100 baseline) during FEATURE_100 P2.
 */

import type {
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXJsonValue,
  KodaXMessage,
  KodaXReasoningMode,
} from '../types.js';

export interface RuntimeSessionState {
  queuedMessages: KodaXMessage[];
  extensionState: Map<string, Map<string, KodaXJsonValue>>;
  extensionRecords: KodaXExtensionSessionRecord[];
  activeTools: string[];
  editRecoveryAttempts: Map<string, number>;
  blockedEditWrites: Set<string>;
  lastToolErrorCode?: string;
  lastToolResultBytes?: number;
  modelSelection: {
    provider?: string;
    model?: string;
  };
  thinkingLevel?: KodaXReasoningMode;
}

export function createRuntimeExtensionState(
  persisted?: KodaXExtensionSessionState,
): Map<string, Map<string, KodaXJsonValue>> {
  const state = new Map<string, Map<string, KodaXJsonValue>>();
  if (!persisted) {
    return state;
  }

  for (const [extensionId, values] of Object.entries(persisted)) {
    state.set(extensionId, new Map(Object.entries(values)));
  }

  return state;
}

export function snapshotRuntimeExtensionState(
  state: RuntimeSessionState['extensionState'],
): KodaXExtensionSessionState | undefined {
  const snapshot: KodaXExtensionSessionState = {};

  for (const [extensionId, values] of state.entries()) {
    if (values.size === 0) {
      continue;
    }

    snapshot[extensionId] = Object.fromEntries(values.entries());
  }

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

export function getExtensionStateBucket(
  state: RuntimeSessionState['extensionState'],
  extensionId: string,
): Map<string, KodaXJsonValue> {
  const existing = state.get(extensionId);
  if (existing) {
    return existing;
  }

  const next = new Map<string, KodaXJsonValue>();
  state.set(extensionId, next);
  return next;
}

export interface BuildRuntimeSessionStateInput {
  loadedExtensionState?: KodaXExtensionSessionState;
  loadedExtensionRecords?: KodaXExtensionSessionRecord[];
  /** Pre-filtered tool names — caller is responsible for `filterExcludedTools`. */
  activeTools: string[];
  modelSelection: { provider?: string; model?: string };
  thinkingLevel?: KodaXReasoningMode;
}

export function buildRuntimeSessionState(input: BuildRuntimeSessionStateInput): RuntimeSessionState {
  return {
    queuedMessages: [],
    extensionState: createRuntimeExtensionState(input.loadedExtensionState),
    extensionRecords: input.loadedExtensionRecords?.map((record) => ({ ...record })) ?? [],
    activeTools: input.activeTools,
    editRecoveryAttempts: new Map(),
    blockedEditWrites: new Set(),
    modelSelection: input.modelSelection,
    thinkingLevel: input.thinkingLevel,
  };
}

/**
 * Normalise an extension-supplied queued message — accept a string
 * shorthand (treated as a user message) or a fully-formed
 * `KodaXMessage`. Used by the queueUserMessage callback in the extension
 * runtime controller and by the `turn:settle` hook in `extension-queue.ts`.
 *
 * Migration history: extracted from `agent.ts:268-272` — pre-FEATURE_100
 * baseline — during FEATURE_100 P2 (CAP-020 batch).
 */
export function normalizeQueuedRuntimeMessage(message: string | KodaXMessage): KodaXMessage {
  return typeof message === 'string'
    ? { role: 'user', content: message }
    : message;
}

/**
 * Normalise an extension-supplied model-selection patch. Trims provider
 * and model strings, drops empty values. Used by the setModelSelection
 * callback in the extension runtime controller and by the `turn:settle`
 * hook in `extension-queue.ts`. CAP-030 will eventually own its
 * canonical placement in `provider-hook.ts`; for now it lives here
 * alongside the other RuntimeSessionState mutators.
 *
 * Migration history: extracted from `agent.ts:274-288` — pre-FEATURE_100
 * baseline — during FEATURE_100 P2 (CAP-020 batch).
 */
export function normalizeRuntimeModelSelection(
  next: { provider?: string; model?: string },
): { provider?: string; model?: string } {
  const normalized: { provider?: string; model?: string } = {};
  if (next.provider?.trim()) {
    normalized.provider = next.provider.trim();
  }
  if (next.model?.trim()) {
    normalized.model = next.model.trim();
  }
  return normalized;
}

/**
 * Generate a unique extension-session-record id. Format
 * `extrec_<ms-since-epoch>_<8-char-base36>` keeps records sortable by
 * timestamp prefix and resilient to within-millisecond collisions via
 * the random suffix.
 *
 * Migration history: extracted from `agent.ts:362-364` — pre-FEATURE_100
 * baseline — during FEATURE_100 P2 (CAP-020 batch).
 */
export function createSessionRecordId(): string {
  return `extrec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
