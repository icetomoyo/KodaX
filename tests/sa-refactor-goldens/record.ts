/**
 * SA Refactor Goldens — Orchestration entry points
 *
 * Companion: `docs/features/v0.7.29-capability-inventory.md` and
 *            `docs/features/v0.7.29.md#5-重保险机制--3-项加强` (mechanism 2)
 *            `tests/sa-refactor-goldens/providers.ts` (Recorder / Replay)
 *
 * STATUS:
 *   - RecorderProvider / ReplayProvider — implemented in providers.ts and
 *     re-exported below.
 *   - GoldenSessionSnapshot / GoldenTurnSnapshot shapes — frozen.
 *   - Source-session selection criteria + edge-case detectors — declared,
 *     bodies stubbed (return false) pending audit of the user's actual
 *     `.kodax/sessions/` directory.
 *   - `recordGoldens` / `verifyGoldens` orchestration — stubbed; implementation
 *     deferred to P1 mid-stage once selection has been calibrated against
 *     real session data.
 *
 * Do NOT delete; the interfaces in this file are the contract the
 * orchestration implementation must satisfy.
 */

import type { KodaXMessage } from '@kodax/ai';

// Recorder/Replay providers landed in providers.ts; re-export here so the
// orchestration entry points remain a single import for callers.
export { RecorderProvider, ReplayProvider } from './providers.js';
export type {
  RecordedCallback,
  RecordedRequestEnvelope,
  RecordedStreamCall,
  SessionRecording,
  ShapeDiff,
} from './providers.js';

// ---------------------------------------------------------------------------
// Snapshot shape — see README for semantics
// ---------------------------------------------------------------------------

export interface GoldenTurnSnapshot {
  /** Turn index (0-based) */
  turn: number;
  /** Tool calls the model emitted this turn, in order */
  toolCalls: Array<{ name: string; argsHash: string }>;
  /** Provider request envelope summary (params that affect routing/behavior) */
  providerRequest: {
    model: string;
    reasoningDepth: 'off' | 'quick' | 'balanced' | 'deep';
    maxTokens: number;
    systemPromptHash: string;
    messageCount: number;
  };
  /** Structural digest of history before this turn's stream */
  historyShape: {
    roleHistogram: Record<'user' | 'assistant' | 'system' | 'tool', number>;
    contentKindHistogram: Record<string, number>;
    canonicalizedContentHash: string;
  };
  /** Events fired in order during this turn (callback name only, arg shape via hash) */
  eventsEmitted: Array<{ name: string; argsHash: string }>;
  /** CAP-XXX hooks that ran this turn (auto-collected via instrumented middleware) */
  capabilityHooksFired: string[];
}

export interface GoldenSessionSnapshot {
  /** Source session id (from .kodax/sessions/<id>.json) */
  sessionId: string;
  /** Task family classification (debug / explain / refactor / search / build-fix / review) */
  taskFamily: string;
  /** Recorded under SA mode unless test specifies AMA */
  agentMode: 'sa' | 'ama';
  /** Per-turn data */
  turns: GoldenTurnSnapshot[];
  /** Terminal state */
  terminal: {
    success: boolean;
    errorClass?: string;
    exitReason: 'success' | 'block' | 'error' | 'cancel';
    finalMessageCount: number;
    finalCost: { inputTokens: number; outputTokens: number };
  };
  /** Aggregated capability hooks (union across all turns) */
  capabilityHooksAggregate: string[];
  /** Snapshot format version (bump when shape changes) */
  formatVersion: 1;
}

// ---------------------------------------------------------------------------
// Source session selection — stratified sampling
// ---------------------------------------------------------------------------

export interface SessionSelectionCriteria {
  /** Minimum sessions per task family */
  minPerFamily: number;
  /** Length buckets — minimum sessions per bucket */
  lengthBuckets: {
    short: number; // 1-2 turns
    medium: number; // 3-7 turns
    long: number; // 8+ turns
  };
  /** Edge-case capabilities each requiring ≥ 1 covering session */
  mandatoryCapabilities: Array<{
    capId: string; // e.g., 'CAP-015'
    name: string;
    detector: (session: RawSession) => boolean;
  }>;
  /** Hard cap on total session count */
  maxTotal: number;
}

export const DEFAULT_SELECTION: SessionSelectionCriteria = {
  minPerFamily: 5,
  lengthBuckets: { short: 8, medium: 15, long: 8 },
  mandatoryCapabilities: [
    { capId: 'CAP-015', name: 'edit recovery', detector: hasEditRecoveryEvidence },
    { capId: 'CAP-009', name: 'multimodal image', detector: hasImageInput },
    { capId: 'CAP-008', name: 'session resume', detector: isResumedSession },
    { capId: 'CAP-007', name: 'rate limit', detector: hasRateLimitEvent },
    { capId: 'CAP-019', name: 'auto-reroute', detector: hasAutoRerouteEvent },
    { capId: 'CAP-020', name: 'extension queue', detector: hasExtensionQueueEvent },
    { capId: 'CAP-013', name: 'crash error snapshot', detector: hasErrorSnapshot },
  ],
  maxTotal: 50,
};

interface RawSession {
  sessionId: string;
  filePath: string;
  messages: KodaXMessage[];
  metadata: {
    taskFamily?: string;
    turnCount: number;
    hadError: boolean;
    hadResume: boolean;
  };
}

// ---------------------------------------------------------------------------
// Edge-case detectors — implementation pending real-session audit
// ---------------------------------------------------------------------------

function hasEditRecoveryEvidence(_session: RawSession): boolean {
  // STUB: scan for 'edit anchor not found' / 'file changed since last read' markers
  // in tool result content + 'buildEditRecoveryUserMessage' synthesized message.
  return false;
}

function hasImageInput(_session: RawSession): boolean {
  // STUB: scan first user message for multimodal content blocks of kind 'image'.
  return false;
}

function isResumedSession(_session: RawSession): boolean {
  // STUB: session metadata has `resumedFrom` field or initialMessages.length > 0
  // at session creation.
  return false;
}

function hasRateLimitEvent(_session: RawSession): boolean {
  // STUB: events log contains 'onProviderRateLimit' callback name.
  return false;
}

function hasAutoRerouteEvent(_session: RawSession): boolean {
  // STUB: events log contains 'onRetry' with prefix 'Auto' or 'Post-tool auto'.
  return false;
}

function hasExtensionQueueEvent(_session: RawSession): boolean {
  // STUB: assistant message followed by user message NOT from interactive input
  // (i.e., synthetically appended by extension queue drain).
  return false;
}

function hasErrorSnapshot(_session: RawSession): boolean {
  // STUB: session record has terminal { exitReason: 'error', errorMetadata: ... }.
  return false;
}

// ---------------------------------------------------------------------------
// Top-level entry points
// ---------------------------------------------------------------------------

export interface RecordOptions {
  /** Source root for .kodax/sessions/<id>.json */
  sessionsDir: string;
  /** Output root for snapshots */
  snapshotsDir: string;
  /** Output root for raw provider recordings */
  recordingsDir: string;
  /** Selection criteria (defaults to DEFAULT_SELECTION) */
  selection?: SessionSelectionCriteria;
  /** Dry-run: only emit selection report, do not run sessions */
  dryRun?: boolean;
}

/**
 * Record goldens. Top-level entry — wired by `npm run goldens:record`.
 *
 * Implementation outline:
 * 1. Enumerate sessions in `sessionsDir`
 * 2. Apply `DEFAULT_SELECTION` to pick representative samples
 * 3. For each selected session:
 *    a. Wrap provider with `RecorderProvider` writing to recordingsDir
 *    b. Replay session through `runKodaX` (with mock event emitters that
 *       collect into the `eventsEmitted` array)
 *    c. Instrument middleware to populate `capabilityHooksFired`
 *    d. Write `GoldenSessionSnapshot` to snapshotsDir
 * 4. Emit selection-coverage report (which CAP-XXX edge cases ARE / ARE NOT
 *    covered after sampling); fail if any mandatory capability missed
 */
export async function recordGoldens(_options: RecordOptions): Promise<void> {
  throw new Error(
    'recordGoldens not yet implemented. This is a P1 skeleton; full implementation pending real-session audit. See docs/features/v0.7.29.md P1 deliverables.',
  );
}

export interface VerifyOptions {
  snapshotsDir: string;
  recordingsDir: string;
  /** Single session (optional); if omitted, verifies all */
  sessionId?: string;
  /** Determinism mode: replay N times and assert byte-identical */
  determinismRuns?: number;
}

/**
 * Verify goldens. Replay each snapshot through current code; diff against
 * recorded shape; report.
 *
 * Implementation outline:
 * 1. Load `GoldenSessionSnapshot` from snapshotsDir
 * 2. For each session:
 *    a. Wrap provider with `ReplayProvider` (recordings from recordingsDir)
 *    b. Replay session through `runKodaX` (or post-FEATURE_100, through
 *       `Runner.run(defaultCodingAgent, ...)`)
 *    c. Build live `GoldenSessionSnapshot` from this run
 *    d. Diff against the recorded snapshot
 *    e. Any diff → fail with structured report (which turn, which field)
 * 3. If `determinismRuns > 1`: run replay N times, assert all N produce same
 *    snapshot
 */
export async function verifyGoldens(_options: VerifyOptions): Promise<void> {
  throw new Error(
    'verifyGoldens not yet implemented. This is a P1 skeleton; full implementation pending real-session audit. See docs/features/v0.7.29.md P1 deliverables.',
  );
}
