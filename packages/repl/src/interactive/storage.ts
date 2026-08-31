/**
 * KodaX session storage - filesystem implementation.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import chalk from 'chalk';
import type {
  AgentActorSaveAttempt,
  AgentActorSaveDiagnostics,
  AgentActorSavePhase,
  AgentActorSaveTiming,
  KodaXExtensionSessionRecord,
  KodaXMessage,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionLineage,
  KodaXSessionMeta,
  KodaXSessionRuntimeInfo,
  KodaXSessionScope,
  KodaXSessionStorage,
  KodaXSessionUiHistoryItem,
  AgentActorSnapshot,
} from '@kodax-ai/agent';
import {
  AgentActorStoreConflictError,
  AgentOwnerConflictError,
  AgentOwnerUnknownError,
  appendSessionLineageLabel,
  archiveOldIslands,
  cleanupIncompleteToolCalls,
  countActiveLineageMessages,
  createSessionLineage,
  emitKodaXDiagnostic,
  findPreviousUserEntryId,
  forkSessionLineage,
  generateSessionId,
  getSessionLineagePath,
  getSessionMessagesFromLineage,
  getActiveMemoryOutcomeReviewIds,
  rewindSessionLineage,
  reclaimStaleKodaXFileLock,
  setSessionLineageActiveEntry,
  withPendingEpisodeReviewSessionFence,
  withKodaXFileLock,
} from '@kodax-ai/agent';
import type { SessionData, SessionErrorMetadata } from '../ui/utils/session-storage.js';
// `KODAX_SESSIONS_DIR` is a module-load-time-frozen constant (see
// `../common/utils.ts` JSDoc — v0.7.35.1 FEATURE_145). It is the default
// used when `FileSessionStorage` is constructed without an explicit
// `sessionsDir` override (v0.7.43 FEATURE_173 Part B follow-up).
// Substrate consumers that need the agent-config-home redirected via
// `setAgentConfigHome()` from `@kodax-ai/agent` MUST still call it
// BEFORE importing `@kodax-ai/repl`. SDK consumers that want a
// per-instance override should pass `{ sessionsDir }` to
// `createSessionManager()` instead.
import { getGitRoot, KODAX_DIR, KODAX_SESSIONS_DIR } from '../common/utils.js';
import { inspectWorkspaceRuntime, isSameCanonicalRepo, resolveSessionRuntimeInfo } from './workspace-runtime.js';
import {
  deriveProjectKeyFromData,
  sessionProjectMatchesAnyRoot,
  type ProjectIdentity,
} from './project-key.js';
import {
  projectManifestExists,
  publishProjectManifest,
} from './project-manifest.js';
import { ensureLayoutMigrated } from './session-migration.js';
import {
  buildSessionConversationHistory,
  forkSessionConversationLineage,
  type SessionConversationHistoryData,
} from '../session/conversation-history.js';
import {
  appendConversationPageCache,
  canAppendConversationPageCache,
  conversationPageIdentityFilterContains,
  ConversationPageCacheStaleError,
  createConversationPageIdentityFilter,
  extendConversationPageIdentityFilter,
  readConversationPageCache as readPreparedConversationPage,
  readConversationPageCacheChunk as readPreparedConversationChunk,
  readConversationPageCacheManifest,
  refreshConversationPageCache,
  removeConversationPageCache,
  writeConversationPageCache,
  type ConversationPageCacheChunk,
  type ConversationPageCacheChunkInput,
  type ConversationPageCacheAdmission,
  type ConversationPageCacheInput,
  type ConversationPageCachePage,
} from '../session/conversation-page-cache.js';
import {
  createSessionSourceRevision,
  createSessionSourceRevisionState,
  extendSessionMainSourceRevisionState,
  type SessionSourceRevisionState,
} from '../session/source-revision.js';
import {
  commitResumeIndexEntry,
  prepareResumeIndexEntry,
  readResumeIndex,
  resumeIndexProjectDir,
  type ResumeIndexEntry,
} from '../session/resume-index.js';
import { countResumableSessionItems } from '../session/resumable-session.js';
export type {
  ConversationPageCacheChunk,
  ConversationPageCacheChunkInput,
  ConversationPageCacheAdmission,
  ConversationPageCacheInput,
  ConversationPageCachePage,
} from '../session/conversation-page-cache.js';
export { ConversationPageCacheCapacityError } from '../session/conversation-page-cache.js';
import {
  isKodaXExtensionSessionRecord,
  isKodaXExtensionSessionState,
  isKodaXJsonValue,
  isKodaXMessage,
  isKodaXSessionUiHistoryItem,
  isRecord,
  isSessionErrorMetadata,
} from './json-guards.js';

/**
 * Opaque process-local boundary for a prepared, append-only Session write.
 * Obtain a fresh value from {@link FileSessionStorage.prepareSessionAppend};
 * a committed append consumes the boundary. It returns a reusable successor
 * when that successor can be witnessed safely, or `null` when the caller must
 * reload before another append.
 */
export interface PreparedSessionAppendBaseline {
  readonly sessionId: string;
  readonly revision: string;
  readonly lineageCount: number;
  readonly artifactCount: number;
  readonly extensionCount: number;
  readonly activeEntryId: string | null;
  readonly tag?: string;
}

/**
 * An explicit append-only delta. Historical arrays are intentionally absent:
 * callers that need to rewrite existing Session data must use
 * {@link FileSessionStorage.appendSessionDelta}, which performs an exact merge.
 */
export interface PreparedSessionTailDelta {
  readonly baseline: PreparedSessionAppendBaseline;
  readonly title: string;
  readonly activeEntryId: string | null;
  readonly lineageEntries: readonly KodaXSessionEntry[];
  readonly artifactEntries?: readonly KodaXSessionArtifactLedgerEntry[];
  readonly extensionRecords?: readonly KodaXExtensionSessionRecord[];
  readonly uiHistory?: readonly KodaXSessionUiHistoryItem[];
  readonly scope?: KodaXSessionScope;
}

interface PersistedExtensionRecordLine extends KodaXExtensionSessionRecord {
  _type: 'extension_record';
}

interface PersistedLineageEntryLine {
  _type: 'lineage_entry';
  entry: KodaXSessionEntry;
}

interface PersistedArtifactLedgerLine {
  _type: 'artifact_ledger_entry';
  entry: KodaXSessionArtifactLedgerEntry;
}

interface PersistedMetaUpdateLine {
  _type: 'meta_update';
  title?: string;
  tag?: string;
  activeEntryId?: string | null;
  activeMessageCount?: number;
  uiHistory?: unknown[];
  scope?: string;
  lineageIdentityFilterHash?: string;
}

interface PersistedSessionMeta extends KodaXSessionMeta {
  lineageIdentityFilterHash?: string;
}

interface PersistedArchivedEntryCore {
  _type: 'archived_entry';
  archiveBatchId: string;
  entry: KodaXSessionEntry;
}

interface PersistedArchivedEntryLine extends PersistedArchivedEntryCore {
  previousEntryId?: string | null;
  nextEntryId?: string | null;
}

interface ArchivedLineageRecord extends PersistedArchivedEntryLine {
  readonly streamId: number;
}

const ATOMIC_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100] as const;
const SESSION_WRITE_LOCK_TIMEOUT_MS = 60_000;
const ACTOR_SAVE_ELIGIBILITY_TIMEOUT_MS = SESSION_WRITE_LOCK_TIMEOUT_MS + 5_000;
const DEFAULT_SESSION_READ_TIMEOUT_MS = 15_000;
const SESSION_LOCATION_TOPOLOGY_EPOCH = '.location-topology';
const SESSION_LOCATION_TOPOLOGY_LOCK = '.location-topology.lock';
const SESSION_LOCATION_INDEX_DIR = '.location-index';
const MAX_SESSION_LOCATION_HINT_BYTES = 64 * 1024;
const SESSION_CONVERSATION_CACHE_CHUNK_BYTES = 256 * 1024;
// Keep prepared artifact appends aligned with mergeArtifactLedger's bounded,
// first-position-preserving canonical ledger semantics.
const SESSION_ARTIFACT_LEDGER_MAX_ENTRIES = 256;
let sessionTempSequence = 0;

interface SerializedWriteObserver {
  onDequeued(): void;
  beforeFileLock(): void;
  onFileLockAcquired(): void;
  onFileLockSettled(): void;
}

interface CanonicalWriteObserver {
  beforeCommit(): void;
  afterCommit(): void;
  beginTiming(stage: AgentActorSaveTiming): void;
  recordTiming(stage: AgentActorSaveTiming, durationMs: number): void;
}

interface ActorSaveLifecycle {
  readonly attempt: AgentActorSaveAttempt;
  readonly queueObserver: SerializedWriteObserver;
  readonly canonicalObserver: CanonicalWriteObserver;
  markCommitObservedByReadback(): void;
  markCommitNotObserved(error: unknown): void;
  settleCompletion(completion: Promise<void>): void;
}

interface DeferredValue<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

class ActorSnapshotSaveCancelledError extends Error {
  readonly code = 'actor_snapshot_save_cancelled' as const;

  constructor(readonly attemptId: string) {
    super(`Actor snapshot save ${attemptId} was cancelled before canonical commit.`);
    this.name = 'ActorSnapshotSaveCancelledError';
  }
}

function deferredValue<T>(): DeferredValue<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function jsonPersistedValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class ActorSaveLifecycleState implements ActorSaveLifecycle {
  readonly attempt: AgentActorSaveAttempt;
  readonly queueObserver: SerializedWriteObserver;
  readonly canonicalObserver: CanonicalWriteObserver;
  private readonly attemptId: string;
  private readonly startedAt = performance.now();
  private readonly dequeued = deferredValue<void>();
  private readonly eligible = deferredValue<void>();
  private readonly canonical = deferredValue<void>();
  private readonly completion = deferredValue<void>();
  private readonly timings: Partial<Record<AgentActorSaveTiming, number>> = {};
  private readonly cancelled: ActorSnapshotSaveCancelledError;
  private phaseValue: AgentActorSavePhase = 'queued';
  private activeStage: AgentActorSaveTiming | undefined = 'storageQueue';
  private activeStageStartedAt = this.startedAt;
  private failedStage: AgentActorSaveTiming | undefined;
  private fileLockStartedAt = this.startedAt;
  private committedAt: number | undefined;
  private canonicalOutcome: AgentActorSaveDiagnostics['canonicalOutcome'] = 'pending';
  private completionOutcome: AgentActorSaveDiagnostics['completionOutcome'] = 'pending';

  constructor(sessionId: string, targetRevision: number) {
    this.attemptId = `${sessionId}:${targetRevision}:${randomUUID()}`;
    this.cancelled = new ActorSnapshotSaveCancelledError(this.attemptId);
    this.attempt = this.createAttempt();
    this.queueObserver = {
      onDequeued: () => this.onDequeued(),
      beforeFileLock: () => this.beforeFileLock(),
      onFileLockAcquired: () => this.onFileLockAcquired(),
      onFileLockSettled: () => this.onFileLockSettled(),
    };
    this.canonicalObserver = {
      beforeCommit: () => this.beforeCommit(),
      afterCommit: () => this.afterCommit(),
      beginTiming: (stage) => this.beginTiming(stage),
      recordTiming: (stage, durationMs) => this.recordTiming(stage, durationMs),
    };
    void this.dequeued.promise.catch(() => undefined);
    void this.eligible.promise.catch(() => undefined);
    void this.canonical.promise.catch(() => undefined);
    void this.completion.promise.catch(() => undefined);
  }

  settleCompletion(write: Promise<void>): void {
    void write.then(
      () => {
        this.completionOutcome = 'succeeded';
        this.recordCompletionTimings();
        this.completion.resolve(undefined);
      },
      (error: unknown) => {
        this.completionOutcome = 'failed';
        if (
          this.activeStage !== undefined
          && this.timings[this.activeStage] === undefined
        ) {
          this.recordTiming(
            this.activeStage,
            elapsedMs(this.activeStageStartedAt),
          );
        }
        if (this.phaseValue === 'committed') {
          this.failedStage ??= this.activeStage ?? 'postCommit';
        } else {
          this.rejectBeforeCommit(error);
        }
        this.recordCompletionTimings();
        this.completion.reject(error);
      },
    );
  }

  private createAttempt(): AgentActorSaveAttempt {
    return {
      dequeued: this.dequeued.promise,
      eligible: this.eligible.promise,
      canonical: this.canonical.promise,
      completion: this.completion.promise,
      phase: () => this.phaseValue,
      cancelBeforeCommit: () => this.cancelBeforeCommit(),
      diagnostics: () => this.diagnostics(),
    };
  }

  markCommitNotObserved(error: unknown): void {
    if (this.phaseValue !== 'commit_inflight') return;
    this.phaseValue = 'not_committed';
    this.canonicalOutcome = 'not_committed';
    this.rejectBeforeCommit(error);
  }

  markCommitObservedByReadback(): void {
    if (this.phaseValue !== 'commit_inflight') return;
    this.failedStage ??= 'rename';
    this.afterCommit('committed_by_readback');
  }

  private cancelBeforeCommit(): boolean {
    if (this.phaseValue !== 'queued' && this.phaseValue !== 'precommit') return false;
    this.failedStage ??= this.activeStage;
    this.phaseValue = 'not_committed';
    this.canonicalOutcome = 'not_committed';
    this.rejectBeforeCommit(this.cancelled);
    return true;
  }

  private onDequeued(): void {
    this.recordTiming('storageQueue', elapsedMs(this.startedAt));
    this.dequeued.resolve(undefined);
  }

  private beforeFileLock(): void {
    if (this.phaseValue === 'not_committed') throw this.cancelled;
    this.beginTiming('fileLock');
    this.fileLockStartedAt = performance.now();
  }

  private onFileLockAcquired(): void {
    this.recordTiming('fileLock', elapsedMs(this.fileLockStartedAt));
    if (this.phaseValue === 'not_committed') throw this.cancelled;
    this.phaseValue = 'precommit';
    this.eligible.resolve(undefined);
  }

  private onFileLockSettled(): void {
    if (this.timings.fileLock === undefined) {
      this.recordTiming('fileLock', elapsedMs(this.fileLockStartedAt));
    }
  }

  private beforeCommit(): void {
    if (this.phaseValue !== 'precommit') throw this.cancelled;
    this.phaseValue = 'commit_inflight';
    this.canonicalOutcome = 'ambiguous';
  }

  private afterCommit(
    outcome: Extract<
      NonNullable<AgentActorSaveDiagnostics['canonicalOutcome']>,
      'committed' | 'committed_by_readback'
    > = 'committed',
  ): void {
    if (this.phaseValue === 'committed') return;
    this.phaseValue = 'committed';
    this.canonicalOutcome = outcome;
    this.beginTiming('postCommit');
    this.committedAt = performance.now();
    this.canonical.resolve(undefined);
  }

  private recordCompletionTimings(): void {
    if (this.committedAt !== undefined) {
      this.recordTiming('postCommit', elapsedMs(this.committedAt));
    }
    this.recordTiming('total', elapsedMs(this.startedAt));
    this.activeStage = undefined;
  }

  private rejectBeforeCommit(error: unknown): void {
    this.failedStage ??= this.activeStage;
    if (this.phaseValue !== 'commit_inflight') {
      this.phaseValue = 'not_committed';
      this.canonicalOutcome = 'not_committed';
    }
    this.dequeued.reject(error);
    this.eligible.reject(error);
    this.canonical.reject(error);
  }

  private beginTiming(stage: AgentActorSaveTiming): void {
    this.activeStage = stage;
    this.activeStageStartedAt = performance.now();
  }

  private recordTiming(stage: AgentActorSaveTiming, durationMs: number): void {
    this.timings[stage] = durationMs;
  }

  private diagnostics(): AgentActorSaveDiagnostics {
    return {
      attemptId: this.attemptId,
      phase: this.phaseValue,
      ...(this.activeStage !== undefined ? { activeStage: this.activeStage } : {}),
      ...(this.activeStage !== undefined
        ? { activeStageElapsedMs: elapsedMs(this.activeStageStartedAt) }
        : {}),
      ...(this.failedStage !== undefined ? { failedStage: this.failedStage } : {}),
      canonicalOutcome: this.canonicalOutcome,
      completionOutcome: this.completionOutcome,
      timingsMs: { ...this.timings },
    };
  }
}

function createActorSaveLifecycle(
  sessionId: string,
  targetRevision: number,
): ActorSaveLifecycle {
  return new ActorSaveLifecycleState(sessionId, targetRevision);
}

function normalizeSessionReadTimeout(timeoutMs: number | undefined): number {
  const normalized = timeoutMs ?? DEFAULT_SESSION_READ_TIMEOUT_MS;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error('Session read timeoutMs must be a positive safe integer');
  }
  return normalized;
}

function throwIfSessionReadAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new SessionReadError('read_cancelled', 'Session history read cancelled');
}

/** Check synchronous projection work against the same budget as file reads. */
export function assertSessionReadBudget(
  options: SessionReadOptions,
  startedAt: number,
): void {
  throwIfSessionReadAborted(options.signal);
  const timeoutMs = normalizeSessionReadTimeout(options.timeoutMs);
  if (Date.now() - startedAt < timeoutMs) return;
  throw new SessionReadError(
    'read_timeout',
    `Session history read timed out after ${timeoutMs}ms`,
  );
}

async function raceSessionRead<T>(
  operation: Promise<T>,
  options: SessionReadOptions,
): Promise<T> {
  const timeoutMs = normalizeSessionReadTimeout(options.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SessionReadError(
            'read_timeout',
            `Session history read timed out after ${timeoutMs}ms`,
          )),
          timeoutMs,
        );
        if (options.signal !== undefined) {
          abort = () => reject(new SessionReadError(
            'read_cancelled',
            'Session history read cancelled',
          ));
          options.signal.addEventListener('abort', abort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) {
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

async function replaceSessionFile(tempPath: string, targetPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tempPath, targetPath);
      return;
    } catch (error: unknown) {
      const delay = ATOMIC_RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientRenameError(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

function isTransientRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function isPersistedMetaUpdateLine(value: unknown): value is PersistedMetaUpdateLine {
  if (!isRecord(value) || value._type !== 'meta_update') {
    return false;
  }
  return (value.title === undefined || typeof value.title === 'string')
    && (value.tag === undefined || typeof value.tag === 'string')
    && (value.activeEntryId === undefined || typeof value.activeEntryId === 'string' || value.activeEntryId === null)
    && (value.activeMessageCount === undefined || typeof value.activeMessageCount === 'number')
    && (value.uiHistory === undefined || Array.isArray(value.uiHistory))
    && (value.scope === undefined || typeof value.scope === 'string')
    && (value.lineageIdentityFilterHash === undefined
      || (typeof value.lineageIdentityFilterHash === 'string'
        && /^[a-f0-9]{64}$/.test(value.lineageIdentityFilterHash)));
}

function normalizeKodaXSessionUiHistory(value: unknown): KodaXSessionUiHistoryItem[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .filter(isKodaXSessionUiHistoryItem)
    .map((item): KodaXSessionUiHistoryItem => (
      item.type === 'tool_group'
        ? { ...item, tools: item.tools.map((tool) => ({ ...tool })) }
        : { ...item }
    ));
  return items.length > 0 ? items : undefined;
}

interface PersistedSessionSnapshot {
  meta?: PersistedSessionMeta;
  legacyMessages: KodaXMessage[];
  lineageEntries: KodaXSessionEntry[];
  artifactLedger: KodaXSessionArtifactLedgerEntry[];
  extensionRecords: KodaXExtensionSessionRecord[];
  malformedCount: number;
  rawContent: string;
  mainIdentity?: StableFileIdentity;
}

interface ResolvedSessionSnapshot {
  data: SessionData;
  createdAt?: string;
  filePath: string;
  mainIdentity?: StableFileIdentity;
  activeMessageCount: number;
  lineageIdentityFilterHash?: string;
}

export type SessionReadErrorCode =
  | 'data_corrupt'
  | 'data_changed'
  | 'version_incompatible'
  | 'read_timeout'
  | 'read_cancelled';

export class SessionReadError extends Error {
  constructor(
    readonly code: SessionReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionReadError';
  }
}

export interface SessionReadOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Immutable read boundary used by conversation-history fork/rewind. */
export interface SessionHistoryBoundary {
  readonly sourceRevision: string;
}

export interface SessionReadSnapshot {
  readonly data: SessionData;
  readonly lineage: KodaXSessionLineage | null;
  /** Exact identity of the immutable persisted bundle used for this capture. */
  readonly sourceRevision: string;
  /** Incrementally extendable witness for the exact persisted bundle revision. */
  readonly sourceRevisionState: SessionSourceRevisionState;
  /** Stat-derived witness for prepared-page validation at this exact capture. */
  readonly boundaryRevision: string;
}

function completeLineageBoundaryPath(
  lineage: KodaXSessionLineage,
  targetId: string,
): ReturnType<typeof getSessionLineagePath> | undefined {
  const boundaryPath = getSessionLineagePath(lineage, targetId);
  if (
    boundaryPath.at(-1)?.id !== targetId
    || boundaryPath[0]?.parentId !== null
  ) {
    return undefined;
  }
  return boundaryPath.every((entry, index) =>
    index === 0 || entry.parentId === boundaryPath[index - 1]!.id)
    ? boundaryPath
    : undefined;
}

export interface StableSessionBundleFile {
  readonly kind: 'main' | 'islands' | 'legacy_archive';
  readonly path: string;
  readonly bytes: Buffer;
  readonly modifiedAt: string;
}

export interface StableSessionBundleSnapshot {
  readonly candidates: readonly string[];
  readonly files: readonly StableSessionBundleFile[];
  readonly sourceRevision: string;
  readonly sourceRevisionState: SessionSourceRevisionState;
  /** Bounded stat-derived witness used to validate prepared conversation pages. */
  readonly boundaryRevision: string;
}

type StableFileIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
};

type SessionTopologyIdentity = {
  readonly root: StableFileIdentity;
  readonly epoch: string | null;
  readonly writerScope: 'session' | 'global';
  readonly writerIdentity: StableFileIdentity | null;
  readonly activeWriterIdentity: StableFileIdentity | null;
};

interface PersistedStableFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface PersistedSessionLocationHint {
  readonly version: 1;
  readonly id: string;
  readonly filePaths: readonly string[];
  readonly topology: {
    readonly root: PersistedStableFileIdentity;
    readonly epoch: string | null;
    readonly writerIdentity: PersistedStableFileIdentity | null;
  };
}

type SessionLocationTraversalBoundary = {
  readonly topologyBefore?: SessionTopologyIdentity;
  readonly writerTopologyDigestBefore?: string;
  readonly topologyMutationBefore: boolean;
};

type StableBundleRead = {
  readonly file: StableSessionBundleFile;
  readonly identity: StableFileIdentity;
};

function sessionWriteLockPath(sessionsDir: string, id: string): string {
  const key = createHash('sha256').update(id, 'utf8').digest('hex');
  return path.join(sessionsDir, '.write-locks', `${key}.lock`);
}

function sessionLocationTopologyLockPath(sessionsDir: string): string {
  return path.join(sessionsDir, SESSION_LOCATION_TOPOLOGY_LOCK);
}

function sessionLocationHintPath(sessionsDir: string, id: string): string {
  const key = createHash('sha256').update(id, 'utf8').digest('hex');
  return path.join(sessionsDir, SESSION_LOCATION_INDEX_DIR, `${key}.json`);
}

function sessionWriteQueuePath(sessionsDir: string, id: string): string {
  return `${sessionWriteLockPath(sessionsDir, id)}.queue`;
}

function sessionGlobalWriteBoundaryPath(sessionsDir: string): string {
  return path.join(sessionsDir, '.write-locks');
}

function sessionWriterTopologyDigestSync(sessionsDir: string): string | undefined {
  const root = sessionGlobalWriteBoundaryPath(sessionsDir);
  try {
    const digest = createHash('sha256');
    const entries = fsSync.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.lock.queue'))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const identity = stableFileIdentity(fsSync.statSync(
        path.join(root, entry.name),
        { bigint: true },
      ));
      digest.update(entry.name);
      digest.update('\0');
      digest.update(identity.dev.toString());
      digest.update('\0');
      digest.update(identity.ino.toString());
      digest.update('\0');
      digest.update(identity.size.toString());
      digest.update('\0');
      digest.update(identity.mtimeNs.toString());
      digest.update('\0');
      digest.update(identity.ctimeNs.toString());
      digest.update('\n');
    }
    return digest.digest('hex');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createHash('sha256').digest('hex');
    }
    return undefined;
  }
}

function assertStableSessionReadBoundary(sessionsDir: string, id: string): void {
  const activePath = [
    sessionWriteLockPath(sessionsDir, id),
    sessionLocationTopologyLockPath(sessionsDir),
    path.join(sessionsDir, '.migration-lock'),
    path.join(sessionsDir, '.migration-journal.jsonl'),
  ].find((candidate) => fsSync.existsSync(candidate));
  if (activePath !== undefined) {
    throw new SessionReadError(
      'data_changed',
      `Session data changed during the read boundary: ${path.basename(activePath)}`,
    );
  }
}

async function prepareStableSessionReadBoundary(
  sessionsDir: string,
  id: string,
): Promise<void> {
  const writerPath = sessionWriteLockPath(sessionsDir, id);
  if (fsSync.existsSync(writerPath)) {
    await reclaimStaleKodaXFileLock(writerPath);
  }
  assertStableSessionReadBoundary(sessionsDir, id);
}

function assertSessionMigrationInactive(sessionsDir: string): void {
  const activePath = [
    path.join(sessionsDir, '.migration-lock'),
    path.join(sessionsDir, '.migration-journal.jsonl'),
  ].find((candidate) => fsSync.existsSync(candidate));
  if (activePath !== undefined) {
    throw new SessionReadError(
      'data_changed',
      `Session layout migration is active: ${path.basename(activePath)}`,
    );
  }
}

type SessionCandidatePresence = 'present' | 'missing' | 'unverifiable';

function inspectSessionCandidate(filePath: string): SessionCandidatePresence {
  try {
    return fsSync.statSync(filePath).isFile() ? 'present' : 'missing';
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    return 'unverifiable';
  }
}

async function inspectSessionCandidateAsync(filePath: string): Promise<SessionCandidatePresence> {
  try {
    return (await fs.stat(filePath)).isFile() ? 'present' : 'missing';
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    return 'unverifiable';
  }
}

function inaccessibleSessionCandidate(id: string, filePath: string): SessionReadError {
  return new SessionReadError(
    'data_changed',
    `Session candidate could not be verified for ${id}: ${path.basename(filePath)}`,
  );
}

async function findStableSessionCandidates(
  sessionsDir: string,
  id: string,
): Promise<string[]> {
  const candidates: string[] = [];
  const flat = path.join(sessionsDir, `${id}.jsonl`);
  const flatPresence = inspectSessionCandidate(flat);
  if (flatPresence === 'present') candidates.push(flat);
  if (flatPresence === 'unverifiable') throw inaccessibleSessionCandidate(id, flat);
  let entries: import('fs').Dirent[] = [];
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw inaccessibleSessionCandidate(id, sessionsDir);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const projectDir = path.join(sessionsDir, entry.name);
    for (const candidate of [
      path.join(projectDir, `${id}.jsonl`),
      path.join(projectDir, 'archived', `${id}.jsonl`),
    ]) {
      const presence = inspectSessionCandidate(candidate);
      if (presence === 'present') candidates.push(candidate);
      if (presence === 'unverifiable') {
        throw inaccessibleSessionCandidate(id, candidate);
      }
    }
  }
  return candidates.sort();
}

async function readStableBundleFile(
  kind: StableSessionBundleFile['kind'],
  filePath: string,
): Promise<StableBundleRead | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const beforeIdentity = stableFileIdentity(before);
    const afterIdentity = stableFileIdentity(after);
    if (
      !sameStableFileIdentity(beforeIdentity, afterIdentity)
      || BigInt(bytes.length) !== afterIdentity.size
    ) {
      throw new SessionReadError(
        'data_changed',
        `Session file changed while reading: ${path.basename(filePath)}`,
      );
    }
    return {
      file: {
        kind,
        path: filePath,
        bytes,
        modifiedAt: new Date(Number(afterIdentity.mtimeNs / 1_000_000n)).toISOString(),
      },
      identity: afterIdentity,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SessionReadError(
        'data_changed',
        `Session file changed while reading: ${path.basename(filePath)}`,
      );
    }
    throw error;
  } finally {
    await handle.close();
  }
}

function stableFileIdentity(
  snapshot: import('fs').BigIntStats,
): StableFileIdentity {
  return {
    dev: snapshot.dev,
    ino: snapshot.ino,
    size: snapshot.size,
    mtimeNs: snapshot.mtimeNs,
    ctimeNs: snapshot.ctimeNs,
  };
}

function persistStableFileIdentity(identity: StableFileIdentity): PersistedStableFileIdentity {
  return {
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    size: identity.size.toString(),
    mtimeNs: identity.mtimeNs.toString(),
    ctimeNs: identity.ctimeNs.toString(),
  };
}

function parsePersistedStableFileIdentity(value: unknown): StableFileIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const;
  if (!fields.every((field) => typeof value[field] === 'string' && /^\d+$/.test(value[field]))) {
    return undefined;
  }
  return {
    dev: BigInt(value.dev as string),
    ino: BigInt(value.ino as string),
    size: BigInt(value.size as string),
    mtimeNs: BigInt(value.mtimeNs as string),
    ctimeNs: BigInt(value.ctimeNs as string),
  };
}

function sameStableFileIdentity(
  left: StableFileIdentity,
  right: StableFileIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameOptionalStableFileIdentity(
  left: StableFileIdentity | null,
  right: StableFileIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return sameStableFileIdentity(left, right);
}

function sameSessionTopologyIdentity(
  left: SessionTopologyIdentity,
  right: SessionTopologyIdentity,
): boolean {
  return sameStableFileIdentity(left.root, right.root)
    && left.epoch === right.epoch
    && left.writerScope === right.writerScope
    && sameOptionalStableFileIdentity(left.writerIdentity, right.writerIdentity)
    && sameOptionalStableFileIdentity(
      left.activeWriterIdentity,
      right.activeWriterIdentity,
    );
}

function sameSessionTopologyWithoutActiveWriter(
  left: SessionTopologyIdentity,
  right: SessionTopologyIdentity,
): boolean {
  return sameStableFileIdentity(left.root, right.root)
    && left.epoch === right.epoch
    && left.writerScope === right.writerScope
    && sameOptionalStableFileIdentity(left.writerIdentity, right.writerIdentity);
}

function sameOptionalSessionTopologyIdentity(
  left: SessionTopologyIdentity | null,
  right: SessionTopologyIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return sameSessionTopologyIdentity(left, right);
}

function resolvePersistedSessionLocationPath(
  sessionsDir: string,
  id: string,
  relativePath: string,
): string | undefined {
  if (path.isAbsolute(relativePath)) return undefined;
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const fileName = `${id}.jsonl`;
  const validShape = (
    segments.length === 1 && segments[0] === fileName
  ) || (
    segments.length === 2
    && !segments[0]!.startsWith('.')
    && segments[1] === fileName
  ) || (
    segments.length === 3
    && !segments[0]!.startsWith('.')
    && segments[1] === 'archived'
    && segments[2] === fileName
  );
  if (!validShape || segments.some((segment) => segment === '..' || segment === '')) {
    return undefined;
  }
  const root = path.resolve(sessionsDir);
  const resolved = path.resolve(sessionsDir, ...segments);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
}

async function readSessionLocationHint(
  sessionsDir: string,
  id: string,
): Promise<{
  readonly filePaths: readonly string[];
  readonly topology: SessionTopologyIdentity;
} | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(sessionLocationHintPath(sessionsDir, id), 'r');
    const size = (await handle.stat()).size;
    if (size > MAX_SESSION_LOCATION_HINT_BYTES) return undefined;
    const encoded = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(encoded, offset, size - offset, offset);
      if (bytesRead === 0) return undefined;
      offset += bytesRead;
    }
    const value: unknown = JSON.parse(encoded.toString('utf8'));
    if (
      !isRecord(value)
      || value.version !== 1
      || value.id !== id
      || !Array.isArray(value.filePaths)
      || value.filePaths.length === 0
      || value.filePaths.length > 16
      || !isRecord(value.topology)
      || (value.topology.epoch !== null && typeof value.topology.epoch !== 'string')
    ) return undefined;
    const root = parsePersistedStableFileIdentity(value.topology.root);
    const writerIdentity = value.topology.writerIdentity === null
      ? null
      : parsePersistedStableFileIdentity(value.topology.writerIdentity);
    if (root === undefined || writerIdentity === undefined) return undefined;
    const filePaths = value.filePaths.flatMap((candidate) => {
      if (typeof candidate !== 'string') return [];
      const resolved = resolvePersistedSessionLocationPath(sessionsDir, id, candidate);
      return resolved === undefined ? [] : [resolved];
    });
    if (filePaths.length !== value.filePaths.length || new Set(filePaths).size !== filePaths.length) {
      return undefined;
    }
    return {
      filePaths,
      topology: {
        root,
        epoch: value.topology.epoch,
        writerScope: 'session',
        writerIdentity,
        activeWriterIdentity: null,
      },
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function statSessionTopologyIdentity(
  sessionsDir: string,
  id: string,
  writerScope: SessionTopologyIdentity['writerScope'] = 'session',
): Promise<SessionTopologyIdentity | null> {
  const root = await statStableFileIdentity(sessionsDir);
  if (root === null) return null;
  const writerIdentity = await statStableFileIdentity(writerScope === 'session'
    ? sessionWriteQueuePath(sessionsDir, id)
    : sessionGlobalWriteBoundaryPath(sessionsDir));
  const activeWriterIdentity = writerScope === 'session'
    ? await statStableFileIdentity(sessionWriteLockPath(sessionsDir, id))
    : null;
  try {
    return {
      root,
      epoch: (await fs.readFile(
        path.join(sessionsDir, SESSION_LOCATION_TOPOLOGY_EPOCH),
        'utf8',
      )).trim(),
      writerScope,
      writerIdentity,
      activeWriterIdentity,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { root, epoch: null, writerScope, writerIdentity, activeWriterIdentity };
    }
    throw error;
  }
}

async function statStableFileIdentity(
  filePath: string,
): Promise<StableFileIdentity | null> {
  try {
    return stableFileIdentity(await fs.stat(filePath, { bigint: true }));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function createStableBundleSourceRevisionState(
  sessionsDir: string,
  files: readonly StableSessionBundleFile[],
): SessionSourceRevisionState {
  return createSessionSourceRevisionState(files.map((file) => ({
    kind: file.kind,
    relativePath: path.relative(sessionsDir, file.path).replace(/\\/g, '/'),
    bytes: file.bytes,
  })));
}

function createStableBundleBoundaryRevision(
  sessionsDir: string,
  reads: readonly (StableBundleRead | null)[],
): string {
  const hash = createHash('sha256');
  hash.update('kodax-session-bundle-boundary-v1\0');
  for (const read of reads) {
    if (read === null) continue;
    const relativePath = path.relative(sessionsDir, read.file.path).replace(/\\/g, '/');
    const identity = read.identity;
    hash.update(`${read.file.kind}:${relativePath}:`);
    hash.update([
      identity.dev,
      identity.ino,
      identity.size,
      identity.mtimeNs,
      identity.ctimeNs,
    ].map((value) => value.toString()).join(':'));
  }
  return `sha256:${hash.digest('hex')}`;
}

async function readStableSessionBundleAtPath(
  sessionsDir: string,
  id: string,
  mainPath: string,
  signal?: AbortSignal,
  allowActiveWriter = false,
  mainBytesOverride?: Buffer,
): Promise<StableSessionBundleSnapshot> {
  throwIfSessionReadAborted(signal);
  if (!allowActiveWriter) assertStableSessionReadBoundary(sessionsDir, id);
  const directory = path.dirname(mainPath);
  const descriptors = [
    { kind: 'main' as const, filePath: mainPath },
    { kind: 'islands' as const, filePath: path.join(directory, `${id}.islands.jsonl`) },
    { kind: 'legacy_archive' as const, filePath: path.join(directory, `${id}.archive.jsonl`) },
  ];
  const reads: Array<StableBundleRead | null> = [];
  for (const descriptor of descriptors) {
    throwIfSessionReadAborted(signal);
    if (descriptor.kind === 'main' && mainBytesOverride !== undefined) {
      const identity = await statStableFileIdentity(descriptor.filePath);
      if (identity === null || identity.size !== BigInt(mainBytesOverride.length)) {
        throw new SessionReadError('data_changed', 'Session main file changed after append');
      }
      reads.push({
        identity,
        file: {
          kind: 'main',
          path: descriptor.filePath,
          bytes: mainBytesOverride,
          modifiedAt: new Date(Number(identity.mtimeNs / 1_000_000n)).toISOString(),
        },
      });
    } else {
      reads.push(await readStableBundleFile(descriptor.kind, descriptor.filePath));
    }
  }
  if (reads[0] === null) {
    throw new SessionReadError(
      'data_changed',
      'Session main file moved during the read boundary',
    );
  }
  if (!allowActiveWriter) assertStableSessionReadBoundary(sessionsDir, id);
  for (let index = 0; index < descriptors.length; index += 1) {
    throwIfSessionReadAborted(signal);
    const finalIdentity = await statStableFileIdentity(descriptors[index]!.filePath);
    const captured = reads[index];
    if (
      (captured === null && finalIdentity !== null)
      || (captured !== null && (
        finalIdentity === null
        || !sameStableFileIdentity(captured.identity, finalIdentity)
      ))
    ) {
      throw new SessionReadError(
        'data_changed',
        `Session file changed during the read boundary: ${path.basename(descriptors[index]!.filePath)}`,
      );
    }
  }
  if (!allowActiveWriter) assertStableSessionReadBoundary(sessionsDir, id);
  const files = reads.flatMap((read) => read === null ? [] : [read.file]);
  const sourceRevisionState = createStableBundleSourceRevisionState(sessionsDir, files);
  return {
    candidates: [mainPath],
    files,
    sourceRevision: createSessionSourceRevision(sourceRevisionState),
    sourceRevisionState,
    boundaryRevision: createStableBundleBoundaryRevision(sessionsDir, reads),
  };
}

async function readStableSessionBundleBoundaryAtPath(
  sessionsDir: string,
  id: string,
  mainPath: string,
  allowActiveWriter = false,
): Promise<string> {
  return (await readStableSessionBundleBoundarySnapshotAtPath(
    sessionsDir,
    id,
    mainPath,
    allowActiveWriter,
  )).revision;
}

interface StableSessionBundleBoundarySnapshot {
  readonly revision: string;
  readonly identities: readonly (StableFileIdentity | null)[];
}

async function readStableSessionBundleBoundarySnapshotAtPath(
  sessionsDir: string,
  id: string,
  mainPath: string,
  allowActiveWriter = false,
): Promise<StableSessionBundleBoundarySnapshot> {
  if (!allowActiveWriter) assertStableSessionReadBoundary(sessionsDir, id);
  const directory = path.dirname(mainPath);
  const descriptors = [
    { kind: 'main' as const, filePath: mainPath },
    { kind: 'islands' as const, filePath: path.join(directory, `${id}.islands.jsonl`) },
    { kind: 'legacy_archive' as const, filePath: path.join(directory, `${id}.archive.jsonl`) },
  ];
  const reads: Array<StableBundleRead | null> = [];
  for (const descriptor of descriptors) {
    const identity = await statStableFileIdentity(descriptor.filePath);
    reads.push(identity === null ? null : {
      identity,
      file: {
        kind: descriptor.kind,
        path: descriptor.filePath,
        bytes: Buffer.alloc(0),
        modifiedAt: '',
      },
    });
  }
  if (reads[0] === null) {
    throw new SessionReadError('data_changed', 'Session main file moved during the read boundary');
  }
  if (!allowActiveWriter) assertStableSessionReadBoundary(sessionsDir, id);
  for (let index = 0; index < descriptors.length; index += 1) {
    const finalIdentity = await statStableFileIdentity(descriptors[index]!.filePath);
    const captured = reads[index];
    if (
      (captured === null && finalIdentity !== null)
      || (captured !== null && (
        finalIdentity === null || !sameStableFileIdentity(captured.identity, finalIdentity)
      ))
    ) {
      throw new SessionReadError(
        'data_changed',
        `Session file changed during the read boundary: ${path.basename(descriptors[index]!.filePath)}`,
      );
    }
  }
  if (!allowActiveWriter) assertStableSessionReadBoundary(sessionsDir, id);
  return {
    revision: createStableBundleBoundaryRevision(sessionsDir, reads),
    identities: reads.map((read) => read?.identity ?? null),
  };
}

function isExpectedAppendBoundaryTransition(
  before: StableSessionBundleBoundarySnapshot,
  after: StableSessionBundleBoundarySnapshot,
  appendedBytes: number,
): boolean {
  const previousMain = before.identities[0];
  const currentMain = after.identities[0];
  if (
    previousMain === null
    || previousMain === undefined
    || currentMain === null
    || currentMain === undefined
    || previousMain.dev !== currentMain.dev
    || previousMain.ino !== currentMain.ino
    || currentMain.size !== previousMain.size + BigInt(appendedBytes)
  ) return false;
  return [1, 2].every((index) => {
    const previous = before.identities[index] ?? null;
    const current = after.identities[index] ?? null;
    return previous === null
      ? current === null
      : current !== null && sameStableFileIdentity(previous, current);
  });
}

/**
 * Capture a read-only, cross-file Session snapshot. Each payload is read once;
 * descriptor identity and read-only writer/migrator checks fence the boundary.
 */
export async function readStableSessionBundleFiles(
  sessionsDirInput: string,
  id: string,
  signal?: AbortSignal,
): Promise<StableSessionBundleSnapshot> {
  const sessionsDir = path.resolve(sessionsDirInput);
  throwIfSessionReadAborted(signal);
  await prepareStableSessionReadBoundary(sessionsDir, id);
  const candidates = await findStableSessionCandidates(sessionsDir, id);
  if (candidates.length !== 1) {
    const sourceRevisionState = createStableBundleSourceRevisionState(sessionsDir, []);
    return {
      candidates,
      files: [],
      sourceRevision: createSessionSourceRevision(sourceRevisionState),
      sourceRevisionState,
      boundaryRevision: createStableBundleBoundaryRevision(sessionsDir, []),
    };
  }
  const snapshot = await readStableSessionBundleAtPath(
    sessionsDir,
    id,
    candidates[0]!,
    signal,
  );
  throwIfSessionReadAborted(signal);
  const finalCandidates = await findStableSessionCandidates(sessionsDir, id);
  if (
    finalCandidates.length !== candidates.length
    || finalCandidates.some((candidate, index) => candidate !== candidates[index])
  ) {
    throw new SessionReadError(
      'data_changed',
      'Session location changed during the read boundary',
    );
  }
  return snapshot;
}

function reportStorageDiagnostic(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
  emitKodaXDiagnostic({
    source: 'repl:session-storage',
    level,
    message,
    ...(detail !== undefined ? { detail } : {}),
  });
}

function warnMalformedSessionData(filePath: string, count: number): void {
  if (count === 0) {
    return;
  }

  reportStorageDiagnostic(
    'warn',
    `Skipped ${count} malformed session record(s) from ${path.basename(filePath)}.`,
  );
}

function writeStorageNotice(message: string): void {
  reportStorageDiagnostic('info', message);
}

function toExtensionRecordLine(
  record: KodaXExtensionSessionRecord,
): PersistedExtensionRecordLine {
  return {
    _type: 'extension_record',
    ...record,
  };
}

function toLineageEntryLine(entry: KodaXSessionEntry): PersistedLineageEntryLine {
  return {
    _type: 'lineage_entry',
    entry,
  };
}

function toArtifactLedgerLine(entry: KodaXSessionArtifactLedgerEntry): PersistedArtifactLedgerLine {
  return {
    _type: 'artifact_ledger_entry',
    entry,
  };
}

function activeMessageContribution(entry: KodaXSessionEntry): number | undefined {
  switch (entry.type) {
    case 'message':
    case 'branch_summary':
      return 1;
    case 'compaction':
      return entry.reason === 'rewind'
        ? 0
        : 1 + (entry.postCompactAttachments?.length ?? 0);
    case 'archive_marker':
      return 0;
    case 'label':
    case 'rewind_marker':
    case 'client_notice':
    case 'memory_outcome_digest':
    case 'memory_review_receipt':
    case 'goal':
      return undefined;
    default: {
      const exhaustiveCheck: never = entry;
      return exhaustiveCheck;
    }
  }
}

function activeMessageCountAfterAppend(
  previousActiveEntryId: string | null | undefined,
  previousCount: number,
  appended: readonly KodaXSessionEntry[],
  activeEntryId: string | null,
): number | undefined {
  if (previousActiveEntryId === undefined) return undefined;
  const appendedById = new Map(appended.map((entry) => [entry.id, entry]));
  const activeTailIds = new Set<string>();
  let currentId: string | null = activeEntryId;
  let addedCount = 0;
  while (currentId !== previousActiveEntryId) {
    if (currentId === null || activeTailIds.has(currentId)) return undefined;
    activeTailIds.add(currentId);
    const entry = appendedById.get(currentId);
    if (entry === undefined) return undefined;
    const contribution = activeMessageContribution(entry);
    if (contribution === undefined) return undefined;
    addedCount += contribution;
    currentId = entry.parentId;
  }
  if (appended.some((entry) => entry.type === 'message' && !activeTailIds.has(entry.id))) {
    return undefined;
  }
  return previousCount + addedCount;
}

function hasTailIdCollision<T extends { readonly id: string }>(
  entries: readonly T[],
  persistedIds: ReadonlySet<string>,
): boolean {
  const tailIds = new Set<string>();
  for (const entry of entries) {
    if (persistedIds.has(entry.id) || tailIds.has(entry.id)) return true;
    tailIds.add(entry.id);
  }
  return false;
}

function artifactLedgerDedupKey(entry: KodaXSessionArtifactLedgerEntry): string {
  return [
    entry.kind,
    entry.sourceTool ?? '',
    entry.action ?? '',
    entry.target,
  ].join('::');
}

function hasArtifactTailConflict(
  entries: readonly KodaXSessionArtifactLedgerEntry[],
  persistedKeys: ReadonlySet<string>,
): boolean {
  if (persistedKeys.size + entries.length > SESSION_ARTIFACT_LEDGER_MAX_ENTRIES) return true;
  const tailKeys = new Set<string>();
  for (const entry of entries) {
    const key = artifactLedgerDedupKey(entry);
    if (persistedKeys.has(key) || tailKeys.has(key)) return true;
    tailKeys.add(key);
  }
  return false;
}

function conversationIdentityFilterHash(identityFilter: string): string {
  return createHash('sha256')
    .update('kodax-conversation-identity-filter-authority-v1\0')
    .update(identityFilter, 'utf8')
    .digest('hex');
}

function isLinearPreparedMessageTail(
  previousActiveEntryId: string | null | undefined,
  entries: readonly KodaXSessionEntry[],
  activeEntryId: string | null,
  persistedIdentityFilter: string,
): boolean {
  if (previousActiveEntryId === undefined) return false;
  let parentId = previousActiveEntryId;
  const tailIds = new Set<string>();
  for (const entry of entries) {
    if (
      entry.type !== 'message'
      || entry.parentId !== parentId
      || (entry.logicalId !== undefined && entry.logicalId !== entry.id)
      || entry.sourceEntryId !== undefined
      || conversationPageIdentityFilterContains(persistedIdentityFilter, entry.id)
      || tailIds.has(entry.id)
    ) return false;
    tailIds.add(entry.id);
    parentId = entry.id;
  }
  return activeEntryId === parentId;
}

function isPersistedExtensionRecordLine(
  value: unknown,
): value is PersistedExtensionRecordLine {
  return isRecord(value)
    && value._type === 'extension_record'
    && isKodaXExtensionSessionRecord(value);
}

function hasEntryBase(value: unknown): value is {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  logicalId?: string;
  sourceEntryId?: string;
} {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.parentId === null || typeof value.parentId === 'string')
    && typeof value.timestamp === 'string'
    && typeof value.type === 'string'
    && (value.logicalId === undefined || typeof value.logicalId === 'string')
    && (value.sourceEntryId === undefined || typeof value.sourceEntryId === 'string');
}

function isKodaXSessionEntry(value: unknown): value is KodaXSessionEntry {
  if (!hasEntryBase(value)) {
    return false;
  }

  const entry = value as Record<string, unknown>;

  switch (entry.type) {
    case 'message':
      return isKodaXMessage(entry.message);
    case 'compaction':
      return typeof entry.summary === 'string'
        && (entry.firstKeptEntryId === undefined || typeof entry.firstKeptEntryId === 'string')
        && (entry.tokensBefore === undefined || typeof entry.tokensBefore === 'number');
    case 'branch_summary':
      return typeof entry.summary === 'string'
        && (entry.fromId === undefined || typeof entry.fromId === 'string')
        && (entry.details === undefined || isKodaXJsonValue(entry.details));
    case 'label':
      return typeof entry.targetId === 'string'
        && (entry.label === undefined || typeof entry.label === 'string');
    case 'archive_marker':
      return typeof entry.archiveBatchId === 'string'
        && typeof entry.archivedEntryCount === 'number'
        && typeof entry.summary === 'string';
    case 'rewind_marker':
      return typeof entry.targetId === 'string'
        && (entry.fromId === undefined || typeof entry.fromId === 'string')
        && typeof entry.truncatedCount === 'number'
        && typeof entry.summary === 'string';
    case 'client_notice':
      return typeof entry.source === 'string'
        && typeof entry.content === 'string'
        && (entry.turnId === undefined || typeof entry.turnId === 'string')
        && (entry.payload === undefined || isKodaXJsonValue(entry.payload));
    case 'goal':
      return typeof entry.event === 'string';
    case 'memory_outcome_digest':
      return isRecord(entry.digest)
        && typeof entry.digest.id === 'string'
        && typeof entry.digest.reviewKey === 'string'
        && typeof entry.digest.sessionId === 'string'
        && typeof entry.digest.branchId === 'string'
        && Number.isSafeInteger(entry.digest.sequence)
        && (entry.jobId === undefined || typeof entry.jobId === 'string');
    case 'memory_review_receipt':
      return typeof entry.reviewKey === 'string'
        && Array.isArray(entry.proposalIds)
        && entry.proposalIds.every((id) => typeof id === 'string')
        && (entry.status === 'completed' || entry.status === 'no_action')
        && typeof entry.completedAt === 'string'
        && (entry.jobId === undefined || typeof entry.jobId === 'string');
    default:
      return false;
  }
}

function isPersistedLineageEntryLine(
  value: unknown,
): value is PersistedLineageEntryLine {
  return isRecord(value)
    && value._type === 'lineage_entry'
    && isKodaXSessionEntry(value.entry);
}

function isPersistedArchivedEntryLine(value: unknown): value is PersistedArchivedEntryCore {
  return isRecord(value)
    && value._type === 'archived_entry'
    && typeof value.archiveBatchId === 'string'
    && isKodaXSessionEntry(value.entry);
}

function archivedEntryAnchor(value: unknown): string | null | undefined {
  return typeof value === 'string' || value === null ? value : undefined;
}

function isCompactedPlaceholder(entry: KodaXSessionEntry): boolean {
  if (entry.type !== 'message') return false;
  if (entry.message.content === '[compacted]') return true;
  return Array.isArray(entry.message.content)
    && entry.message.content.length === 1
    && entry.message.content[0]?.type === 'text'
    && entry.message.content[0].text === '[compacted]';
}

function mergeConcurrentLineageEntries(
  persistedEntries: readonly KodaXSessionEntry[],
  incomingEntries: readonly KodaXSessionEntry[],
): KodaXSessionEntry[] {
  const merged = new Map<string, KodaXSessionEntry>();
  for (const entry of persistedEntries) merged.set(entry.id, entry);
  for (const entry of incomingEntries) {
    const persisted = merged.get(entry.id);
    if (!persisted || isCompactedPlaceholder(persisted)) merged.set(entry.id, entry);
  }
  return [...merged.values()];
}

function addOrderingEdge(
  edges: Map<string, Set<string>>,
  knownIds: ReadonlySet<string>,
  beforeId: string | null | undefined,
  afterId: string | null | undefined,
): void {
  if (!beforeId || !afterId || beforeId === afterId) return;
  if (!knownIds.has(beforeId) || !knownIds.has(afterId)) return;
  const targets = edges.get(beforeId) ?? new Set<string>();
  targets.add(afterId);
  edges.set(beforeId, targets);
}

function addSequenceEdges(
  edges: Map<string, Set<string>>,
  knownIds: ReadonlySet<string>,
  ids: readonly string[],
): void {
  const seen = new Set<string>();
  let previousId: string | undefined;
  for (const id of ids) {
    if (!knownIds.has(id) || seen.has(id)) continue;
    addOrderingEdge(edges, knownIds, previousId, id);
    previousId = id;
    seen.add(id);
  }
}

function pushMin(heap: number[], value: number): void {
  let index = heap.length;
  heap.push(value);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent]! <= value) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = value;
}

function popMin(heap: number[]): number | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (first === undefined || last === undefined || heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && heap[right]! < heap[left]! ? right : left;
    if (heap[child]! >= last) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
  return first;
}

function orderingIndegrees(
  preferredIds: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, number> {
  const indegree = new Map(preferredIds.map((id) => [id, 0]));
  for (const targets of edges.values()) {
    for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }
  return indegree;
}

function popEligibleIndex(
  heap: number[],
  preferredIds: readonly string[],
  emitted: ReadonlySet<string>,
  eligible: (id: string) => boolean,
): number | undefined {
  while (heap.length > 0) {
    const index = popMin(heap)!;
    const id = preferredIds[index]!;
    if (!emitted.has(id) && eligible(id)) return index;
  }
  return undefined;
}

function findParentCycleNode(
  preferredIds: readonly string[],
  emitted: ReadonlySet<string>,
  parentByChild: ReadonlyMap<string, string>,
): string | undefined {
  const start = preferredIds.find((id) => !emitted.has(id));
  if (!start) return undefined;
  const visited = new Set<string>();
  let current: string | undefined = start;
  while (current && !emitted.has(current)) {
    if (visited.has(current)) return current;
    visited.add(current);
    current = parentByChild.get(current);
  }
  return undefined;
}

function releaseOrderingTargets(
  id: string,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  indegree: Map<string, number>,
  emitted: ReadonlySet<string>,
  onReady: (target: string) => void,
): void {
  for (const target of edges.get(id) ?? []) {
    if (emitted.has(target)) continue;
    const remaining = indegree.get(target) ?? 0;
    if (remaining <= 0) continue;
    indegree.set(target, remaining - 1);
    if (remaining === 1) onReady(target);
  }
}

function stablePriorityTopologicalOrder(
  preferredIds: readonly string[],
  hardEdges: ReadonlyMap<string, ReadonlySet<string>>,
  softEdges: ReadonlyMap<string, ReadonlySet<string>>,
  parentByChild: ReadonlyMap<string, string>,
): string[] {
  const indexById = new Map(preferredIds.map((id, index) => [id, index]));
  const hardIndegree = orderingIndegrees(preferredIds, hardEdges);
  const softIndegree = orderingIndegrees(preferredIds, softEdges);
  const ready: number[] = [];
  const hardReady: number[] = [];
  const emitted = new Set<string>();
  const ordered: string[] = [];
  const queueIfReady = (id: string): void => {
    if (hardIndegree.get(id) === 0) pushMin(hardReady, indexById.get(id)!);
    if (hardIndegree.get(id) === 0 && softIndegree.get(id) === 0) {
      pushMin(ready, indexById.get(id)!);
    }
  };
  for (const id of preferredIds) queueIfReady(id);
  while (ordered.length < preferredIds.length) {
    let index = popEligibleIndex(ready, preferredIds, emitted, (id) =>
      hardIndegree.get(id) === 0 && softIndegree.get(id) === 0);
    index ??= popEligibleIndex(hardReady, preferredIds, emitted, (id) =>
      hardIndegree.get(id) === 0);
    if (index === undefined) {
      const cycleNode = findParentCycleNode(preferredIds, emitted, parentByChild);
      if (!cycleNode) break;
      hardIndegree.set(cycleNode, 0);
      queueIfReady(cycleNode);
      continue;
    }
    const id = preferredIds[index]!;
    emitted.add(id);
    ordered.push(id);
    releaseOrderingTargets(id, hardEdges, hardIndegree, emitted, queueIfReady);
    releaseOrderingTargets(id, softEdges, softIndegree, emitted, queueIfReady);
  }
  return ordered;
}

function mergeFullLineageEntries(
  archivedRecords: readonly ArchivedLineageRecord[],
  mainEntries: readonly KodaXSessionEntry[],
): KodaXSessionEntry[] {
  const merged = new Map<string, KodaXSessionEntry>();
  const archivedAuthority = new Map<string, ArchivedLineageRecord>();
  const fallbackIds: string[] = [];
  for (const record of archivedRecords) {
    const current = archivedAuthority.get(record.entry.id);
    if (!current) fallbackIds.push(record.entry.id);
    if (!current || shouldPreferArchivedRecord(record, current)) {
      archivedAuthority.set(record.entry.id, record);
    }
  }
  for (const [id, record] of archivedAuthority) merged.set(id, record.entry);
  for (const entry of mainEntries) {
    const archived = merged.get(entry.id);
    if (!archived) fallbackIds.push(entry.id);
    if (!archived || !isCompactedPlaceholder(entry)) merged.set(entry.id, entry);
  }
  const knownIds = new Set(merged.keys());
  const relativeEdges = new Map<string, Set<string>>();
  addSequenceEdges(relativeEdges, knownIds, mainEntries.map((entry) => entry.id));
  const exactMainIds = new Set(
    mainEntries
      .filter((entry) => !isCompactedPlaceholder(entry))
      .map((entry) => entry.id),
  );
  const priorArchiveEntryByStream = new Map<string, string>();
  for (const record of archivedRecords) {
    const streamKey = `${record.streamId}:${record.archiveBatchId}`;
    const isOrderingAuthority = archivedAuthority.get(record.entry.id) === record
      && !exactMainIds.has(record.entry.id);
    if (!isOrderingAuthority) {
      priorArchiveEntryByStream.delete(streamKey);
      continue;
    }
    addOrderingEdge(
      relativeEdges,
      knownIds,
      priorArchiveEntryByStream.get(streamKey),
      record.entry.id,
    );
    priorArchiveEntryByStream.set(streamKey, record.entry.id);
    addOrderingEdge(relativeEdges, knownIds, record.previousEntryId, record.entry.id);
    addOrderingEdge(relativeEdges, knownIds, record.entry.id, record.nextEntryId);
  }
  const parentEdges = new Map<string, Set<string>>();
  const parentByChild = new Map<string, string>();
  for (const entry of merged.values()) {
    addOrderingEdge(parentEdges, knownIds, entry.parentId, entry.id);
    if (entry.parentId && knownIds.has(entry.parentId) && entry.parentId !== entry.id) {
      parentByChild.set(entry.id, entry.parentId);
    }
  }
  return stablePriorityTopologicalOrder(
    fallbackIds,
    parentEdges,
    relativeEdges,
    parentByChild,
  ).map((id) => merged.get(id)!);
}

function shouldPreferArchivedRecord(
  candidate: ArchivedLineageRecord,
  current: ArchivedLineageRecord,
): boolean {
  const candidateExact = !isCompactedPlaceholder(candidate.entry);
  const currentExact = !isCompactedPlaceholder(current.entry);
  if (candidateExact !== currentExact) return candidateExact;
  if (candidate.streamId !== current.streamId) {
    return candidate.streamId < current.streamId;
  }
  return true;
}

function mergeConcurrentAppendData(
  incoming: SessionData,
  persisted: SessionData,
): SessionData {
  const incomingLineage = incoming.lineage;
  const persistedLineage = persisted.lineage;
  const lineage = incomingLineage && persistedLineage
    ? {
        ...incomingLineage,
        entries: mergeConcurrentLineageEntries(
          persistedLineage.entries,
          incomingLineage.entries,
        ),
      }
    : incomingLineage ?? persistedLineage;
  const artifacts = new Map<string, KodaXSessionArtifactLedgerEntry>();
  for (const entry of persisted.artifactLedger ?? []) artifacts.set(entry.id, entry);
  for (const entry of incoming.artifactLedger ?? []) artifacts.set(entry.id, entry);
  const extensions = new Map<string, KodaXExtensionSessionRecord>();
  for (const record of persisted.extensionRecords ?? []) extensions.set(record.id, record);
  for (const record of incoming.extensionRecords ?? []) extensions.set(record.id, record);
  return {
    ...incoming,
    ...(lineage ? { lineage } : {}),
    ...(
      incoming.artifactLedger !== undefined || persisted.artifactLedger !== undefined
        ? { artifactLedger: [...artifacts.values()] }
        : {}
    ),
    ...(
      incoming.extensionRecords !== undefined || persisted.extensionRecords !== undefined
        ? { extensionRecords: [...extensions.values()] }
        : {}
    ),
  };
}

function reconcileCompactionLineage(
  incoming: KodaXSessionLineage,
  persistedMain: KodaXSessionLineage | undefined,
  archivedRecords: readonly ArchivedLineageRecord[],
): KodaXSessionLineage {
  const archivedEntries = archivedRecords.map((record) => record.entry);
  const authoritative = persistedTopologySupersedesIncoming(incoming, persistedMain)
    ? mergeContextSilentLineageEntries(persistedMain!, incoming)
    : incoming;
  const activeIds = new Set(getSessionLineagePath(authoritative).map((entry) => entry.id));
  const archivedById = new Map(archivedEntries.map((entry) => [entry.id, entry]));
  const exactById = new Map<string, KodaXSessionEntry>();
  for (const entry of archivedEntries) {
    if (!isCompactedPlaceholder(entry)) exactById.set(entry.id, entry);
  }
  for (const entry of persistedMain?.entries ?? []) {
    if (!isCompactedPlaceholder(entry)) exactById.set(entry.id, entry);
  }

  const entries: KodaXSessionEntry[] = [];
  const seen = new Set<string>();
  for (const entry of authoritative.entries) {
    if (archivedById.has(entry.id) && !activeIds.has(entry.id)) continue;
    const exact = isCompactedPlaceholder(entry) ? exactById.get(entry.id) : undefined;
    const reconciled = exact?.type === 'message' && entry.type === 'message'
      ? { ...entry, message: exact.message }
      : entry;
    entries.push(reconciled);
    seen.add(entry.id);
  }

  // Archive markers are storage-owned topology hints. The live host keeps the
  // unslimmed lineage in memory, so its next snapshot legitimately omits them.
  for (const entry of persistedMain?.entries ?? []) {
    if ((entry.type === 'archive_marker'
      || entry.type === 'memory_outcome_digest'
      || entry.type === 'memory_review_receipt'
      || entry.type === 'client_notice')
      && !seen.has(entry.id)) {
      entries.push(entry);
      seen.add(entry.id);
    }
  }
  return { ...authoritative, entries };
}

function persistedTopologySupersedesIncoming(
  incoming: KodaXSessionLineage,
  persisted: KodaXSessionLineage | undefined,
): boolean {
  if (persisted === undefined) return false;
  const incomingIds = new Set(incoming.entries.map((entry) => entry.id));
  return persisted.entries.some((entry) =>
    isTopologyEntry(entry) && !incomingIds.has(entry.id));
}

function isTopologyEntry(entry: KodaXSessionEntry): boolean {
  return entry.type === 'compaction' || entry.type === 'rewind_marker';
}

function mergeContextSilentLineageEntries(
  persisted: KodaXSessionLineage,
  incoming: KodaXSessionLineage,
): KodaXSessionLineage {
  const entries = [...persisted.entries];
  const seen = new Set(entries.map((entry) => entry.id));
  for (const entry of incoming.entries) {
    if (!seen.has(entry.id) && isContextSilentLineageEntry(entry)) {
      entries.push(entry);
      seen.add(entry.id);
    }
  }
  return { ...persisted, entries };
}

function isContextSilentLineageEntry(entry: KodaXSessionEntry): boolean {
  return entry.type === 'archive_marker'
    || entry.type === 'label'
    || entry.type === 'goal'
    || entry.type === 'client_notice'
    || entry.type === 'memory_outcome_digest'
    || entry.type === 'memory_review_receipt';
}

function isKodaXSessionArtifactLedgerEntry(
  value: unknown,
): value is KodaXSessionArtifactLedgerEntry {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.kind === 'string'
    && typeof value.target === 'string'
    && typeof value.timestamp === 'string'
    && (value.sourceTool === undefined || typeof value.sourceTool === 'string')
    && (value.action === undefined || typeof value.action === 'string')
    && (value.displayTarget === undefined || typeof value.displayTarget === 'string')
    && (value.summary === undefined || typeof value.summary === 'string')
    && (value.sessionEntryId === undefined || typeof value.sessionEntryId === 'string')
    && (value.metadata === undefined || isKodaXJsonValue(value.metadata));
}

function isPersistedArtifactLedgerLine(
  value: unknown,
): value is PersistedArtifactLedgerLine {
  return isRecord(value)
    && value._type === 'artifact_ledger_entry'
    && isKodaXSessionArtifactLedgerEntry(value.entry);
}

function isKodaXSessionRuntimeInfo(value: unknown): value is KodaXSessionRuntimeInfo {
  return isRecord(value)
    && (value.canonicalRepoRoot === undefined || typeof value.canonicalRepoRoot === 'string')
    && (value.workspaceRoot === undefined || typeof value.workspaceRoot === 'string')
    && (value.executionCwd === undefined || typeof value.executionCwd === 'string')
    && (value.branch === undefined || typeof value.branch === 'string')
    && (
      value.workspaceKind === undefined
      || value.workspaceKind === 'detected'
      || value.workspaceKind === 'managed'
    )
    && (
      value.sandboxWorktreeRoots === undefined
      || (
        Array.isArray(value.sandboxWorktreeRoots)
        && value.sandboxWorktreeRoots.every((root) => typeof root === 'string')
      )
    );
}

function getLastNavigableEntryId(entries: KodaXSessionEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry
      && entry.type !== 'label'
      && entry.type !== 'goal'
      && entry.type !== 'client_notice'
      && entry.type !== 'rewind_marker'
    ) {
      return entry.id;
    }
  }
  return null;
}

const LEGACY_LINEAGE_FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function buildDeterministicLegacyLineage(
  snapshot: PersistedSessionSnapshot,
): KodaXSessionLineage {
  const namespace = snapshot.meta?.id
    ?? createHash('sha256').update(snapshot.rawContent).digest('hex');
  const fallbackTimestamp = snapshot.meta?.createdAt
    ?? LEGACY_LINEAGE_FALLBACK_TIMESTAMP;
  let parentId: string | null = null;
  const entries: KodaXSessionEntry[] = snapshot.legacyMessages.map(
    (message, index): KodaXSessionEntry => {
      const identity = createHash('sha256')
        .update('kodax-legacy-lineage-v1\0')
        .update(`${namespace}\0${index}:`)
        .update(JSON.stringify(message))
        .digest('hex')
        .slice(0, 12);
      const id = `entry_${identity}`;
      const entry: KodaXSessionEntry = {
        type: 'message',
        id,
        parentId,
        logicalId: id,
        timestamp: message.timestamp ?? fallbackTimestamp,
        message: structuredClone(message),
      };
      parentId = id;
      return entry;
    },
  );
  return {
    version: 2,
    activeEntryId: parentId,
    entries,
  };
}

function buildLineage(
  snapshot: PersistedSessionSnapshot,
): KodaXSessionLineage | undefined {
  if (snapshot.lineageEntries.length > 0) {
    return {
      version: 2,
      activeEntryId: snapshot.meta?.activeEntryId ?? getLastNavigableEntryId(snapshot.lineageEntries),
      entries: snapshot.lineageEntries,
    };
  }

  if (snapshot.legacyMessages.length === 0) {
    return snapshot.meta?.lineageVersion === 2
      ? {
          version: 2,
          activeEntryId: snapshot.meta.activeEntryId ?? null,
          entries: [],
        }
      : undefined;
  }

  return buildDeterministicLegacyLineage(snapshot);
}

function serializeMessageContentForCompare(content: KodaXMessage['content']): string {
  return typeof content === 'string' ? `t:${content}` : `j:${JSON.stringify(content)}`;
}

function sameMessageByContent(left: KodaXMessage, right: KodaXMessage): boolean {
  if (left === right) {
    return true;
  }
  return left.role === right.role
    && (left._synthetic === true) === (right._synthetic === true)
    && serializeMessageContentForCompare(left.content) === serializeMessageContentForCompare(right.content);
}

/**
 * FEATURE_173 no-regress guard.
 *
 * Resolve the lineage a snapshot `save()` should persist. The runner's
 * `saveSessionSnapshot` writes flat messages with NO lineage; rebuilding via
 * `createSessionLineage(messages, existing)` keeps every existing entry but
 * sets `activeEntryId` from the message walk. When the snapshot's messages
 * are a PREFIX of the persisted active path (a stale / subset view — exactly
 * what a delayed runner save carries), that walk regresses `activeEntryId`
 * to an earlier round, so resume only replays up to that point ("resume only
 * loads the first round"). In that case the snapshot has nothing new to
 * contribute, so reuse the persisted lineage verbatim — the active pointer
 * never moves backward.
 *
 * An EMPTY message set is treated the same as a prefix — it carries nothing
 * new, so the persisted lineage is reused verbatim. This guards the
 * error-recovery save path (`runner-driven.ts:419` passes `messages: []`
 * when no in-flight messages were recovered): rebuilding via
 * `createSessionLineage([], existing)` would reset `activeEntryId` to null
 * and make resume load an empty conversation, while the errorMetadata that
 * the caller DOES want persisted still lands via the merge.
 *
 * A caller-supplied lineage (the REPL's authoritative `context.lineage`) is
 * always honoured. Divergent / extending message sets reconcile normally,
 * so legitimate new rounds and headless single-writer saves are unaffected.
 * Rewind / fork / setActiveEntry never reach here — they own dedicated
 * methods that set `activeEntryId` explicitly.
 */
function resolveSnapshotLineage(
  data: SessionData,
  existingLineage: KodaXSessionLineage | undefined,
): KodaXSessionLineage {
  if (data.lineage) {
    return data.lineage;
  }
  if (existingLineage) {
    const activeMessages = getSessionMessagesFromLineage(existingLineage);
    const messages = data.messages;
    // Empty or prefix-of-active → the snapshot adds nothing; keep the
    // persisted lineage so `activeEntryId` never regresses (incl. to null).
    const carriesNothingNew =
      messages.length <= activeMessages.length
      && messages.every((message, index) => sameMessageByContent(message, activeMessages[index]!));
    if (carriesNothingNew) {
      return existingLineage;
    }
  }
  return createSessionLineage(data.messages, existingLineage);
}

function buildSessionData(
  snapshot: PersistedSessionSnapshot,
  filePath: string,
): ResolvedSessionSnapshot {
  const lineage = buildLineage(snapshot);
  const messages = lineage
    ? getSessionMessagesFromLineage(lineage)
    : [...snapshot.legacyMessages];
  return {
    createdAt: snapshot.meta?.createdAt,
    filePath,
    ...(snapshot.mainIdentity !== undefined ? { mainIdentity: snapshot.mainIdentity } : {}),
    activeMessageCount: messages.length,
    ...(snapshot.meta?.lineageIdentityFilterHash !== undefined
      ? { lineageIdentityFilterHash: snapshot.meta.lineageIdentityFilterHash }
      : {}),
    data: {
      messages,
      title: snapshot.meta?.title ?? '',
      gitRoot: snapshot.meta?.gitRoot ?? '',
      tag: typeof snapshot.meta?.tag === 'string' ? snapshot.meta.tag : undefined,
      runtimeInfo: isKodaXSessionRuntimeInfo(snapshot.meta?.runtimeInfo)
        ? { ...snapshot.meta.runtimeInfo }
        : undefined,
      scope: snapshot.meta?.scope ?? 'user',
      uiHistory: normalizeKodaXSessionUiHistory(snapshot.meta?.uiHistory),
      ...(isSessionErrorMetadata(snapshot.meta?.errorMetadata)
        ? { errorMetadata: { ...snapshot.meta!.errorMetadata } }
        : {}),
      extensionState: isKodaXExtensionSessionState(snapshot.meta?.extensionState)
        ? snapshot.meta?.extensionState
        : undefined,
      extensionRecords: snapshot.extensionRecords.map((record) => ({ ...record })),
      lineage,
      artifactLedger: snapshot.artifactLedger.map((entry) => ({
        ...entry,
        metadata: entry.metadata ? structuredClone(entry.metadata) : undefined,
      })),
      actorSnapshot: snapshot.meta?.actorSnapshot
        ? structuredClone(snapshot.meta.actorSnapshot)
        : undefined,
    },
  };
}

function createSessionMeta(
  id: string,
  data: SessionData,
  lineage: KodaXSessionLineage | undefined,
  createdAt?: string,
  lineageIdentityFilterHash?: string,
): PersistedSessionMeta {
  return {
    _type: 'meta',
    title: data.title,
    id,
    gitRoot: data.gitRoot,
    tag: data.tag,
    runtimeInfo: data.runtimeInfo ? { ...data.runtimeInfo } : undefined,
    createdAt: createdAt ?? new Date().toISOString(),
    scope: data.scope ?? 'user',
    uiHistory: data.uiHistory,
    errorMetadata: data.errorMetadata,
    extensionState: data.extensionState,
    extensionRecordCount: data.extensionRecords?.length ?? 0,
    artifactLedgerCount: data.artifactLedger?.length ?? 0,
    actorSnapshot: data.actorSnapshot ? structuredClone(data.actorSnapshot) : undefined,
    lineageVersion: lineage?.version,
    activeEntryId: lineage?.activeEntryId,
    lineageEntryCount: lineage?.entries.length ?? 0,
    activeMessageCount: lineage ? countActiveLineageMessages(lineage) : data.messages.length,
    lineageIdentityFilterHash,
  };
}

function createResumeIndexEntry(
  id: string,
  title: string,
  msgCount: number,
  createdAt?: string,
  surface?: string,
): ResumeIndexEntry {
  return {
    id,
    title,
    msgCount,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(surface !== undefined ? { surface } : {}),
  };
}

async function readPersistedSessionFile(
  filePath: string,
  strict = false,
  contentOverride?: string,
): Promise<PersistedSessionSnapshot | null> {
  // Read directly and treat a missing file as "no session" rather than doing a
  // separate `existsSync` precheck — the precheck was TOCTOU-racy: a concurrent
  // deletion (another window, or opt-in session retention cleanup) between the
  // check and the read would surface as an uncaught ENOENT crash instead of a
  // graceful null. `load()` already treats null as "session not found".
  let rawContent = contentOverride;
  let mainIdentity: StableFileIdentity | undefined;
  if (rawContent === undefined) {
    try {
      const beforeReadIdentity = await statStableFileIdentity(filePath);
      rawContent = await fs.readFile(filePath, 'utf-8');
      const afterReadIdentity = await statStableFileIdentity(filePath);
      // A non-strict load may return the bytes it successfully read while a
      // concurrent writer atomically replaces the path. Only grant append
      // authority when both path identities prove those bytes came from the
      // same durable file; otherwise the next append must cold-merge.
      mainIdentity = beforeReadIdentity !== null
        && afterReadIdentity !== null
        && sameStableFileIdentity(beforeReadIdentity, afterReadIdentity)
        ? afterReadIdentity
        : undefined;
      if (strict && mainIdentity === undefined) {
        throw new SessionReadError(
          'data_changed',
          `Session data changed while reading ${path.basename(filePath)}; re-read the Session.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
  const trimmedContent = rawContent.trim();
  if (!trimmedContent) {
    return null;
  }

  const snapshot: PersistedSessionSnapshot = {
    legacyMessages: [],
    lineageEntries: [],
    artifactLedger: [],
    extensionRecords: [],
    malformedCount: 0,
    rawContent,
    ...(mainIdentity !== undefined ? { mainIdentity } : {}),
  };

  const lines = trimmedContent.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(lines[index]!);
      if (index === 0 && isRecord(parsed) && parsed._type === 'meta') {
        if (
          strict
          && parsed.lineageVersion !== undefined
          && parsed.lineageVersion !== 2
        ) {
          throw new SessionReadError(
            'version_incompatible',
            `Unsupported Session lineage version in ${path.basename(filePath)}: ${String(parsed.lineageVersion)}`,
          );
        }
        snapshot.meta = parsed as unknown as PersistedSessionMeta;
        continue;
      }

      // meta_update: white-list merge into existing meta (append-only hot path support)
      if (isPersistedMetaUpdateLine(parsed)) {
        if (snapshot.meta) {
          if (parsed.title !== undefined) snapshot.meta.title = parsed.title;
          if (parsed.tag !== undefined) snapshot.meta.tag = parsed.tag;
          if (parsed.activeEntryId !== undefined) snapshot.meta.activeEntryId = parsed.activeEntryId;
          if (parsed.activeMessageCount !== undefined) snapshot.meta.activeMessageCount = parsed.activeMessageCount;
          if (parsed.uiHistory !== undefined) {
            snapshot.meta.uiHistory = normalizeKodaXSessionUiHistory(parsed.uiHistory);
          }
          if (parsed.scope !== undefined) snapshot.meta.scope = parsed.scope as KodaXSessionScope;
          if (parsed.lineageIdentityFilterHash !== undefined) {
            snapshot.meta.lineageIdentityFilterHash = parsed.lineageIdentityFilterHash;
          }
        }
        continue;
      }

      if (isPersistedLineageEntryLine(parsed)) {
        snapshot.lineageEntries.push(parsed.entry);
        continue;
      }

      if (isPersistedArtifactLedgerLine(parsed)) {
        snapshot.artifactLedger.push(parsed.entry);
        continue;
      }

      if (isPersistedExtensionRecordLine(parsed)) {
        snapshot.extensionRecords.push({
          id: parsed.id,
          extensionId: parsed.extensionId,
          type: parsed.type,
          ts: parsed.ts,
          data: parsed.data,
          dedupeKey: parsed.dedupeKey,
        });
        continue;
      }

      if (isKodaXMessage(parsed)) {
        snapshot.legacyMessages.push(parsed);
        continue;
      }

      if (strict) {
        throw new SessionReadError(
          'version_incompatible',
          `Unsupported Session record at ${path.basename(filePath)}:${index + 1}`,
        );
      }
      snapshot.malformedCount += 1;
    } catch (error: unknown) {
      if (error instanceof SessionReadError) throw error;
      if (strict) {
        throw new SessionReadError(
          'data_corrupt',
          `Malformed Session record at ${path.basename(filePath)}:${index + 1}`,
        );
      }
      snapshot.malformedCount += 1;
    }
  }

  return snapshot;
}

// Session-list scale fix (modeled on claudecode `sessionStoragePortable.ts`):
// `list()` only needs the `meta` first line of each session, but historically
// `fs.readFile`'d the WHOLE file (a 24MB archive or 6MB transcript) just to read
// line 1 + count lines. On a large sessions dir (hundreds of files / hundreds of
// MB) that turned `kodax -c` + the session picker into a multi-second blocking
// read. We now read only the first chunk via a single fd. The whole-file read is
// kept ONLY as a fallback for the rare cases that genuinely need it (a first line
// longer than the buffer, or a legacy non-`meta` session whose msgCount is the
// total line count).
const SESSION_HEAD_READ_BYTES = 65536;

async function readConversationPageAdmission(
  filePath: string,
): Promise<ConversationPageCacheAdmission> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(SESSION_HEAD_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) {
      throw new SessionReadError('data_corrupt', 'Session metadata is empty');
    }
    const head = buffer.toString('utf8', 0, bytesRead);
    const newline = head.indexOf('\n');
    if (newline < 0 && bytesRead === buffer.length) {
      throw new SessionReadError(
        'data_corrupt',
        'Session metadata exceeds the bounded page-admission record',
      );
    }
    let value: unknown;
    try {
      value = JSON.parse((newline < 0 ? head : head.slice(0, newline)).trim());
    } catch (error: unknown) {
      throw new SessionReadError(
        'data_corrupt',
        `Session metadata is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(value) || value._type !== 'meta') return {};
    const runtimeInfo = isKodaXSessionRuntimeInfo(value.runtimeInfo)
      ? value.runtimeInfo
      : undefined;
    return {
      ...(runtimeInfo?.surface !== undefined ? { surface: runtimeInfo.surface } : {}),
      ...(runtimeInfo?.profileId !== undefined ? { profileId: runtimeInfo.profileId } : {}),
    };
  } finally {
    await handle.close();
  }
}

export async function readSessionFirstLine(filePath: string): Promise<string | null> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.allocUnsafe(SESSION_HEAD_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SESSION_HEAD_READ_BYTES, 0);
    if (bytesRead === 0) {
      return null;
    }
    const head = buf.toString('utf8', 0, bytesRead);
    const newlineIdx = head.indexOf('\n');
    if (newlineIdx >= 0) {
      return head.slice(0, newlineIdx).trim();
    }
    // First line longer than the read buffer (pathological — meta lines are
    // normally < a few KB). Fall back to a full read so we never silently drop
    // an otherwise-valid session from the list.
    const full = await fs.readFile(filePath, 'utf-8');
    const fullNewline = full.indexOf('\n');
    return (fullNewline >= 0 ? full.slice(0, fullNewline) : full).trim();
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

async function countSessionLines(filePath: string): Promise<number> {
  try {
    const content = (await fs.readFile(filePath, 'utf-8')).trim();
    if (!content) {
      return 0;
    }
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

type SessionLocationState =
  | {
      readonly kind: 'located';
      readonly filePath: string;
      /** Safe for strict reads because all project locations were inspected. */
      readonly globallyVerified: boolean;
      /** Root + durable epoch that the global verification was derived from. */
      readonly topologyIdentity?: SessionTopologyIdentity;
    }
  | { readonly kind: 'ambiguous'; readonly filePaths: readonly string[] };

const processSessionLocationIndexes = new Map<
  string,
  Map<string, SessionLocationState>
>();

function processSessionLocationIndex(
  sessionsDir: string,
): Map<string, SessionLocationState> {
  let index = processSessionLocationIndexes.get(sessionsDir);
  if (index === undefined) {
    index = new Map<string, SessionLocationState>();
    processSessionLocationIndexes.set(sessionsDir, index);
  }
  return index;
}

export class FileSessionStorage implements KodaXSessionStorage {
  readonly actorSnapshotEligibilityTimeoutMs = ACTOR_SAVE_ELIGIBILITY_TIMEOUT_MS;

  // v0.7.43 (FEATURE_173 Part B follow-up) — optional per-instance
  // override of the sessions directory. Defaults to the
  // module-load-time-frozen KODAX_SESSIONS_DIR so existing single-process
  // callers see no behavior change. Constructed by `createSessionManager`
  // to let SDK consumers point at an isolated sessions root without
  // mutating the agent-config-home singleton.
  private readonly sessionsDir: string;
  private readonly configHome: string;
  private readonly sessionLocations: Map<string, SessionLocationState>;
  private readonly verifiedLocationMisses = new Map<string, SessionTopologyIdentity>();

  /**
   * v0.7.46 — optional explicit project cwd for in-process embedders
   * (KodaX Space) serving multiple projects from a single runtime.
   * Threaded through `getGitRoot(this.hostCwd)` and `inspectWorkspaceRuntime({cwd: this.hostCwd})`
   * so the workspace-mismatch check in `load()` compares against the
   * project the embedder opened, NOT the embedder's startup directory.
   * Unset → all paths behave identically to the pre-v0.7.46 form.
   */
  private readonly hostCwd?: string;

  /**
   * v0.7.46 F7 — explicit opt-in for the CLI-style "[Warning] Session
   * project mismatch" stderr notice emitted from `load()`. Pre-v0.7.46
   * the gate was `!this.hostCwd` which fired whenever the embedder
   * hadn't supplied a cwd — but that ALSO matched SDK consumers who
   * don't set cwd (e.g. KodaX Space), bleeding the yellow warning into
   * their stdout/stderr UI channels on every cross-project load. The
   * v0.7.46 default is `false` — silent. CLI surfaces that want the
   * old behavior (warn when user resumes a session from outside its
   * original project) can pass `emitMismatchWarnings: true`.
   */
  private readonly emitMismatchWarnings: boolean;

  constructor(opts?: {
    sessionsDir?: string;
    configHome?: string;
    cwd?: string;
    emitMismatchWarnings?: boolean;
  }) {
    this.sessionsDir = path.resolve(opts?.sessionsDir ?? KODAX_SESSIONS_DIR);
    this.configHome = path.resolve(opts?.configHome ?? KODAX_DIR);
    this.sessionLocations = processSessionLocationIndex(this.sessionsDir);
    this.hostCwd = opts?.cwd;
    this.emitMismatchWarnings = opts?.emitMismatchWarnings ?? false;
  }

  /** Absolute session root used by this storage instance. */
  getSessionsDir(): string {
    return this.sessionsDir;
  }

  /**
   * Return the current one-shot boundary for an explicit tail-only append.
   * A full save/load initializes this boundary; every successful write rotates
   * it so stale or concurrent deltas fail with `data_changed`.
   */
  private currentPreparedSessionAppend(id: string): PreparedSessionAppendBaseline | null {
    const state = this.appendState.get(id);
    if (
      state === undefined
      || state.filePath === undefined
      || state.mainIdentity === undefined
      || state.lineageIdentityFilter === undefined
      || state.lineageIdentityFilterHash === undefined
      || state.bundleBoundaryRevision === undefined
      || state.artifactCount > SESSION_ARTIFACT_LEDGER_MAX_ENTRIES
      || state.artifactEntryIds.size !== state.artifactCount
      || state.artifactDedupKeys.size !== state.artifactCount
      || state.extensionRecordIds.size !== state.extensionCount
    ) return null;
    return {
      sessionId: id,
      revision: state.appendRevision,
      lineageCount: state.lineageCount,
      artifactCount: state.artifactCount,
      extensionCount: state.extensionCount,
      activeEntryId: state.activeEntryId ?? null,
      ...(state.tag !== undefined ? { tag: state.tag } : {}),
    };
  }

  /**
   * Prepare an authenticated one-shot boundary for a bounded tail append.
   * Returns `null` when no canonical cache witness is available; callers must
   * then load/rebuild or use the exact full-snapshot append path.
   */
  async prepareSessionAppend(id: string): Promise<PreparedSessionAppendBaseline | null> {
    const prepared = this.currentPreparedSessionAppend(id);
    if (prepared !== null) return prepared;
    const state = this.appendState.get(id);
    if (
      state?.filePath === undefined
      || state.mainIdentity === undefined
    ) return null;
    const appendRevision = state.appendRevision;
    try {
      const manifest = await readConversationPageCacheManifest(state.filePath);
      if (manifest === undefined) return null;
      const boundary = await readStableSessionBundleBoundarySnapshotAtPath(
        this.sessionsDir,
        id,
        state.filePath,
      );
      const current = this.appendState.get(id);
      const boundaryMainIdentity = boundary.identities[0];
      if (
        current === undefined
        || current.appendRevision !== appendRevision
        || current.mainIdentity === undefined
        || boundaryMainIdentity === null
        || boundaryMainIdentity === undefined
        || !sameStableFileIdentity(current.mainIdentity, boundaryMainIdentity)
        || manifest.boundaryRevision !== boundary.revision
      ) return null;
      if (conversationIdentityFilterHash(manifest.identityFilter)
        !== current.lineageIdentityFilterHash) return null;
      current.lineageIdentityFilter = manifest.identityFilter;
      current.bundleBoundaryRevision = boundary.revision;
      return this.currentPreparedSessionAppend(id);
    } catch (error: unknown) {
      if (error instanceof SessionReadError && error.code === 'data_changed') return null;
      throw error;
    }
  }

  /** @internal Register main paths found by one list traversal. */
  indexSessionLocations(
    filePaths: readonly string[],
    globallyVerified: boolean,
    topologyIdentity?: SessionTopologyIdentity,
  ): void {
    const authoritative = globallyVerified && topologyIdentity !== undefined;
    const locationsById = new Map<string, string[]>();
    for (const filePath of filePaths) {
      const id = path.basename(filePath, '.jsonl');
      const locations = locationsById.get(id) ?? [];
      locations.push(filePath);
      locationsById.set(id, locations);
    }
    for (const [id, locations] of locationsById) {
      const unique = [...new Set(locations)].sort();
      if (authoritative) {
        this.sessionLocations.set(id, unique.length === 1
          ? {
              kind: 'located',
              filePath: unique[0]!,
              globallyVerified: true,
              topologyIdentity,
            }
          : { kind: 'ambiguous', filePaths: unique });
        continue;
      }
      const cached = this.sessionLocations.get(id);
      const known = [...new Set([
        ...unique,
        ...(cached?.kind === 'located'
          ? [cached.filePath]
          : cached?.filePaths ?? []),
      ])].filter((candidate) => fsSync.existsSync(candidate)).sort();
      if (known.length === 0) {
        this.sessionLocations.delete(id);
        continue;
      }
      const cachedAuthoritative = cached?.kind === 'located'
        && cached.filePath === known[0]
        && this.isLocationGloballyVerified(id);
      this.sessionLocations.set(id, known.length === 1
        ? {
            kind: 'located',
            filePath: known[0]!,
            globallyVerified: cachedAuthoritative,
            ...(cachedAuthoritative && cached?.kind === 'located'
              ? { topologyIdentity: cached.topologyIdentity }
              : {}),
          }
        : { kind: 'ambiguous', filePaths: known });
    }
  }

  /** @internal Start an authoritative all-project locator traversal. */
  beginSessionLocationTraversal(): SessionLocationTraversalBoundary {
    let locationIndexReady = true;
    try {
      fsSync.mkdirSync(path.join(this.sessionsDir, SESSION_LOCATION_INDEX_DIR), {
        recursive: true,
      });
    } catch (error: unknown) {
      locationIndexReady = false;
      reportStorageDiagnostic(
        'warn',
        'Unable to prepare the durable Session location index.',
        error,
      );
    }
    return {
      topologyBefore: locationIndexReady
        ? this.readSessionTopologyIdentitySync('', 'global')
        : undefined,
      writerTopologyDigestBefore: locationIndexReady
        ? sessionWriterTopologyDigestSync(this.sessionsDir)
        : undefined,
      topologyMutationBefore: !locationIndexReady || fsSync.existsSync(
        sessionLocationTopologyLockPath(this.sessionsDir),
      ),
    };
  }

  /** @internal Commit locator hints only when the whole traversal was stable. */
  completeSessionLocationTraversal(
    boundary: SessionLocationTraversalBoundary,
    filePaths: readonly string[],
    traversalComplete: boolean,
  ): void {
    const topologyAfterTraversal = this.readSessionTopologyIdentitySync('', 'global');
    const writerTopologyDigestAfter = sessionWriterTopologyDigestSync(this.sessionsDir);
    const stableTraversal = traversalComplete
      && !boundary.topologyMutationBefore
      && !fsSync.existsSync(sessionLocationTopologyLockPath(this.sessionsDir))
      && boundary.topologyBefore !== undefined
      && boundary.writerTopologyDigestBefore !== undefined
      && topologyAfterTraversal !== undefined
      && writerTopologyDigestAfter !== undefined
      && sameSessionTopologyIdentity(boundary.topologyBefore, topologyAfterTraversal)
      && boundary.writerTopologyDigestBefore === writerTopologyDigestAfter;
    if (!stableTraversal) {
      this.indexSessionLocations(filePaths, false);
      return;
    }

    const pathsById = new Map<string, string[]>();
    for (const filePath of filePaths) {
      const id = path.basename(filePath, '.jsonl');
      const paths = pathsById.get(id) ?? [];
      paths.push(filePath);
      pathsById.set(id, paths);
    }
    const topologyById = new Map<string, SessionTopologyIdentity>();
    for (const id of pathsById.keys()) {
      const topology = this.readSessionTopologyIdentitySync(id);
      if (topology === undefined) {
        this.indexSessionLocations(filePaths, false);
        return;
      }
      topologyById.set(id, topology);
    }
    const topologyAfterWitnesses = this.readSessionTopologyIdentitySync('', 'global');
    const stableWitnessCollection = topologyAfterWitnesses !== undefined
      && topologyAfterTraversal !== undefined
      && !fsSync.existsSync(sessionLocationTopologyLockPath(this.sessionsDir))
      && sameSessionTopologyIdentity(topologyAfterTraversal, topologyAfterWitnesses);
    if (!stableWitnessCollection) {
      this.indexSessionLocations(filePaths, false);
      return;
    }
    for (const [id, paths] of pathsById) {
      this.indexSessionLocations(paths, true, topologyById.get(id));
    }
  }

  // ── Session-level write serialization ──
  // All writes (append / cold save / maintenance) for the same session are
  // serialized through a per-session promise chain.  State reads, delta
  // computation, and writes all happen inside the queued callback.
  private writeQueues = new Map<string, Promise<void>>();

  private serializedWrite(
    id: string,
    fn: () => Promise<void>,
    observer?: SerializedWriteObserver,
  ): Promise<void> {
    const prev = this.writeQueues.get(id) ?? Promise.resolve();
    const locked = async (): Promise<void> => {
      observer?.onDequeued();
      observer?.beforeFileLock();
      try {
        await withKodaXFileLock(
          this.sessionWriteLockPath(id),
          async () => {
            observer?.onFileLockAcquired();
            assertSessionMigrationInactive(this.sessionsDir);
            await fn();
          },
          SESSION_WRITE_LOCK_TIMEOUT_MS,
        );
      } finally {
        observer?.onFileLockSettled();
      }
      this.refreshSelfVerifiedLocationTopology(id);
      await this.persistSessionLocationHint(id);
    };
    const next = prev.then(locked, locked);
    this.writeQueues.set(id, next);
    return next;
  }

  private refreshSelfVerifiedLocationTopology(id: string): void {
    const location = this.sessionLocations.get(id);
    if (
      location?.kind !== 'located'
      || !location.globallyVerified
      || location.topologyIdentity?.writerScope !== 'session'
      || location.topologyIdentity.activeWriterIdentity === null
    ) {
      return;
    }
    const observed = location.topologyIdentity;

    const stable = this.readSessionTopologyIdentitySync(id);
    if (
      stable === undefined
      || stable.activeWriterIdentity !== null
      || !sameSessionTopologyWithoutActiveWriter(observed, stable)
    ) {
      return;
    }
    this.sessionLocations.set(id, {
      kind: 'located',
      filePath: location.filePath,
      globallyVerified: true,
      topologyIdentity: stable,
    });
  }

  private sessionWriteLockPath(id: string): string {
    return sessionWriteLockPath(this.sessionsDir, id);
  }

  private async persistSessionLocationHint(id: string): Promise<void> {
    const target = sessionLocationHintPath(this.sessionsDir, id);
    try {
      const location = this.sessionLocations.get(id);
      if (location === undefined) {
        await fs.rm(target, { force: true });
        return;
      }
      if (location.kind !== 'located' || !location.globallyVerified) {
        await fs.rm(target, { force: true });
        return;
      }
      const filePaths = [location.filePath];
      const presences = await Promise.all(filePaths.map(inspectSessionCandidateAsync));
      if (presences.some((presence) => presence !== 'present')) return;
      await fs.mkdir(path.dirname(target), { recursive: true });
      const topology = await statSessionTopologyIdentity(this.sessionsDir, id);
      if (
        topology === null
        || topology.activeWriterIdentity !== null
        || fsSync.existsSync(sessionLocationTopologyLockPath(this.sessionsDir))
        || location.topologyIdentity === undefined
        || !sameSessionTopologyIdentity(location.topologyIdentity, topology)
      ) return;
      const relativePaths = filePaths.map((filePath) =>
        path.relative(this.sessionsDir, filePath).replace(/\\/g, '/'));
      const persisted: PersistedSessionLocationHint = {
        version: 1,
        id,
        filePaths: relativePaths,
        topology: {
          root: persistStableFileIdentity(topology.root),
          epoch: topology.epoch,
          writerIdentity: topology.writerIdentity === null
            ? null
            : persistStableFileIdentity(topology.writerIdentity),
        },
      };
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      let handle: fs.FileHandle | undefined;
      try {
        handle = await fs.open(temp, 'wx');
        await handle.writeFile(JSON.stringify(persisted), 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await replaceSessionFile(temp, target);
      } finally {
        await handle?.close().catch(() => undefined);
        await fs.rm(temp, { force: true });
      }
      this.sessionLocations.set(id, {
        kind: 'located',
        filePath: filePaths[0]!,
        globallyVerified: true,
        topologyIdentity: topology,
      });
    } catch (error: unknown) {
      reportStorageDiagnostic(
        'warn',
        `Unable to update the Session location hint for ${id}.`,
        error,
      );
    }
  }

  private async resolveSessionLocationHint(
    id: string,
    strict: boolean,
  ): Promise<string | undefined> {
    let hint: Awaited<ReturnType<typeof readSessionLocationHint>>;
    try {
      hint = await readSessionLocationHint(this.sessionsDir, id);
    } catch (error: unknown) {
      reportStorageDiagnostic('warn', `Unable to read the Session location hint for ${id}.`, error);
      return undefined;
    }
    if (hint === undefined || fsSync.existsSync(sessionLocationTopologyLockPath(this.sessionsDir))) {
      return undefined;
    }
    const current = await statSessionTopologyIdentity(this.sessionsDir, id);
    if (
      current === null
      || current.activeWriterIdentity !== null
      || !sameSessionTopologyIdentity(hint.topology, current)
    ) return undefined;
    const presences = await Promise.all(hint.filePaths.map(inspectSessionCandidateAsync));
    const inaccessible = presences.findIndex((presence) => presence === 'unverifiable');
    if (inaccessible >= 0 && strict) {
      throw inaccessibleSessionCandidate(id, hint.filePaths[inaccessible]!);
    }
    if (presences.some((presence) => presence !== 'present')) return undefined;
    if (hint.filePaths.length === 1) {
      this.sessionLocations.set(id, {
        kind: 'located',
        filePath: hint.filePaths[0]!,
        globallyVerified: true,
        topologyIdentity: current,
      });
      return hint.filePaths[0]!;
    }
    const filePaths = [...hint.filePaths].sort();
    this.sessionLocations.set(id, { kind: 'ambiguous', filePaths });
    if (strict) {
      throw new SessionReadError(
        'data_changed',
        `Ambiguous Session id ${id} has multiple persisted main files`,
      );
    }
    return this.resolveAmbiguousSessionLocation(id, filePaths);
  }

  // ── Append watermarks ──
  // Tracks how many entries have been written to disk per session.
  // When the count matches the in-memory lineage, only new entries are appended.
  // On process restart the cache is empty → first save falls back to full write.
  // load() initializes the watermark so subsequent appends don't need fallback.
  private appendState = new Map<string, {
    appendRevision: string;
    lineageCount: number;
    artifactCount: number;
    extensionCount: number;
    activeEntryId?: string | null;
    activeMessageCount: number;
    presentationOnlyHistoryCount: number;
    lineageIdentityFilter?: string;
    lineageIdentityFilterHash?: string;
    bundleBoundaryRevision?: string;
    artifactEntryIds: Set<string>;
    artifactDedupKeys: Set<string>;
    extensionRecordIds: Set<string>;
    tag?: string;
    scope?: SessionData['scope'];
    surface?: string;
    projectCanonicalRoot?: string;
    filePath?: string;
    mainIdentity?: StableFileIdentity;
  }>();
  private lineageIdentityFilterHashes = new Map<string, string>();

  private projectJsonWritten = new Map<string, string>();

  // ── FEATURE_219 one-shot auto-migration gate (ADR-038 §8) ──
  // Runs the flat→per-project migration on the first storage entry point.
  // Successful work is cached; observable cleanup failures clear the gate so
  // the same storage instance can retry safely.
  private migrationPromise?: Promise<void>;
  private ensureMigrated(): Promise<void> {
    if (!this.migrationPromise) {
      let tracked: Promise<void>;
      tracked = ensureLayoutMigrated(this.sessionsDir).catch((error: unknown) => {
        if (this.migrationPromise === tracked) this.migrationPromise = undefined;
        throw error;
      });
      this.migrationPromise = tracked;
    }
    return this.migrationPromise;
  }

  /** Update watermarks without retaining or serializing the full Session graph. */
  private syncAppendState(
    id: string,
    data: SessionData,
    fileWitness?: {
      readonly filePath: string;
      readonly mainIdentity: StableFileIdentity | undefined;
    },
    activeMessageCount?: number,
  ): void {
    const prev = this.appendState.get(id);
    this.appendState.set(id, {
      appendRevision: randomUUID(),
      lineageCount: data.lineage?.entries.length ?? prev?.lineageCount ?? 0,
      artifactCount: data.artifactLedger?.length ?? prev?.artifactCount ?? 0,
      extensionCount: data.extensionRecords?.length ?? prev?.extensionCount ?? 0,
      activeEntryId: data.lineage === undefined
        ? prev?.activeEntryId
        : data.lineage.activeEntryId,
      activeMessageCount: activeMessageCount
        ?? (data.lineage ? countActiveLineageMessages(data.lineage) : data.messages.length),
      presentationOnlyHistoryCount: data.uiHistory === undefined
        ? prev?.presentationOnlyHistoryCount ?? 0
        : countResumableSessionItems(0, data.uiHistory),
      // A full-lineage no-false-negative witness is admitted lazily from the
      // cache manifest by prepareSessionAppend(). Main-file entries alone are
      // insufficient because older ids may live in the islands sidecar.
      lineageIdentityFilter: undefined,
      lineageIdentityFilterHash: this.lineageIdentityFilterHashes.get(id),
      bundleBoundaryRevision: undefined,
      artifactEntryIds: data.artifactLedger
        ? new Set(data.artifactLedger.map((entry) => entry.id))
        : prev?.artifactEntryIds ?? new Set(),
      artifactDedupKeys: data.artifactLedger
        ? new Set(data.artifactLedger.map(artifactLedgerDedupKey))
        : prev?.artifactDedupKeys ?? new Set(),
      extensionRecordIds: data.extensionRecords
        ? new Set(data.extensionRecords.map((record) => record.id))
        : prev?.extensionRecordIds ?? new Set(),
      tag: data.tag !== undefined ? data.tag : prev?.tag,
      scope: data.scope ?? prev?.scope,
      surface: data.runtimeInfo?.surface ?? prev?.surface,
      projectCanonicalRoot: deriveProjectKeyFromData(data).canonicalRoot ?? prev?.projectCanonicalRoot,
      filePath: fileWitness?.filePath ?? prev?.filePath,
      // A write without a fresh post-write witness must not inherit an older
      // identity. The next append safely takes the cold merge path instead.
      mainIdentity: fileWitness?.mainIdentity,
    });
  }

  private async syncAppendStateFromFile(
    id: string,
    data: SessionData,
    filePath: string,
    activeMessageCount?: number,
  ): Promise<void> {
    this.syncAppendState(id, data, {
      filePath,
      mainIdentity: await statStableFileIdentity(filePath) ?? undefined,
    }, activeMessageCount);
  }

  // ── FEATURE_219 path resolution ──
  // Legacy flat paths (pre-FEATURE_219 layout) are still read as a fallback
  // and lazily superseded on the next write.
  private legacyFlatPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.jsonl`);
  }

  private legacyFlatArchivePath(id: string): string {
    return path.join(this.sessionsDir, `${id}.archive.jsonl`);
  }

  private projectDir(key: string): string {
    return path.join(this.sessionsDir, key);
  }

  /** Resolve (and cache) the project directory a write for `id` should land in. */
  private resolveWriteDir(id: string, data: SessionData): string {
    const cached = this.sessionLocations.get(id);
    if (cached?.kind === 'located') {
      const locatedDir = path.dirname(cached.filePath);
      if (locatedDir !== this.sessionsDir) {
        return path.basename(locatedDir) === 'archived'
          ? path.dirname(locatedDir)
          : locatedDir;
      }
    }
    const identity = deriveProjectKeyFromData(data);
    return this.projectDir(identity.key);
  }

  private isLocationGloballyVerified(id: string): boolean {
    return this.verifiedLocationTopology(id) !== undefined;
  }

  private verifiedLocationTopology(id: string): SessionTopologyIdentity | undefined {
    const location = this.sessionLocations.get(id);
    if (
      location?.kind !== 'located'
      || !location.globallyVerified
      || location.topologyIdentity === undefined
    ) {
      return undefined;
    }
    const current = this.readSessionTopologyIdentitySync(
      id,
      location.topologyIdentity.writerScope,
    );
    return current !== undefined
      && sameSessionTopologyIdentity(location.topologyIdentity, current)
      ? location.topologyIdentity
      : undefined;
  }

  private verifiedMissingLocationTopology(id: string): SessionTopologyIdentity | undefined {
    const topologyIdentity = this.verifiedLocationMisses.get(id);
    if (topologyIdentity === undefined) return undefined;
    const current = this.readSessionTopologyIdentitySync(
      id,
      topologyIdentity.writerScope,
    );
    if (current !== undefined && sameSessionTopologyIdentity(topologyIdentity, current)) {
      return topologyIdentity;
    }
    this.verifiedLocationMisses.delete(id);
    return undefined;
  }

  private assertLocationTopologyUnchanged(
    id: string,
    expected: SessionTopologyIdentity | undefined,
  ): void {
    assertStableSessionReadBoundary(this.sessionsDir, id);
    const current = expected === undefined
      ? undefined
      : this.readSessionTopologyIdentitySync(id, expected.writerScope);
    if (
      expected === undefined
      || current === undefined
      || !sameSessionTopologyIdentity(expected, current)
    ) {
      throw new SessionReadError(
        'data_changed',
        `Session location topology changed during the read boundary for ${id}`,
      );
    }
  }

  private readSessionTopologyIdentitySync(
    id: string,
    writerScope: SessionTopologyIdentity['writerScope'] = 'session',
  ): SessionTopologyIdentity | undefined {
    try {
      const root = stableFileIdentity(fsSync.statSync(this.sessionsDir, { bigint: true }));
      let writerIdentity: StableFileIdentity | null;
      try {
        writerIdentity = stableFileIdentity(fsSync.statSync(
          writerScope === 'session'
            ? sessionWriteQueuePath(this.sessionsDir, id)
            : sessionGlobalWriteBoundaryPath(this.sessionsDir),
          { bigint: true },
        ));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
        writerIdentity = null;
      }
      let activeWriterIdentity: StableFileIdentity | null = null;
      if (writerScope === 'session') {
        try {
          activeWriterIdentity = stableFileIdentity(fsSync.statSync(
            sessionWriteLockPath(this.sessionsDir, id),
            { bigint: true },
          ));
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
        }
      }
      try {
        return {
          root,
          epoch: fsSync.readFileSync(
            path.join(this.sessionsDir, SESSION_LOCATION_TOPOLOGY_EPOCH),
            'utf8',
          ).trim(),
          writerScope,
          writerIdentity,
          activeWriterIdentity,
        };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return {
            root,
            epoch: null,
            writerScope,
            writerIdentity,
            activeWriterIdentity,
          };
        }
        return undefined;
      }
    } catch (error: unknown) {
      return undefined;
    }
  }

  private async advanceSessionLocationTopology(): Promise<void> {
    const targetPath = path.join(this.sessionsDir, SESSION_LOCATION_TOPOLOGY_EPOCH);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${sessionTempSequence++}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(tempPath, 'wx');
      await handle.writeFile(`${randomUUID()}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await replaceSessionFile(tempPath, targetPath);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(tempPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }

  private withSessionLocationTopologyChange<T>(
    operation: () => Promise<T>,
    onTopologyReady?: () => void,
  ): Promise<T> {
    return withKodaXFileLock(
      sessionLocationTopologyLockPath(this.sessionsDir),
      async () => {
        await this.advanceSessionLocationTopology();
        onTopologyReady?.();
        return operation();
      },
      SESSION_WRITE_LOCK_TIMEOUT_MS,
    );
  }

  private writeFilePath(id: string, data: SessionData): string {
    return path.join(this.resolveWriteDir(id, data), `${id}.jsonl`);
  }

  /**
   * id-only locator (ADR-038 §7). Resolution order:
   *   1. cached project dir for this id
   *   2. bounded scan of project dirs:  <key>/<id>.jsonl
   *   3. bounded scan of archived:      <key>/archived/<id>.jsonl
   *   4. legacy flat:                   <sessionsDir>/<id>.jsonl
   * On multiple matches (only possible for pre-FEATURE_219 same-second
   * duplicate ids) it prefers the current process's project dir, else
   * returns null with a warning rather than guessing.
   */
  private async resolveSessionLocation(
    id: string,
    strict = false,
  ): Promise<string | null> {
    if (strict) await prepareStableSessionReadBoundary(this.sessionsDir, id);
    const cached = this.sessionLocations.get(id);
    if (
      cached?.kind === 'located'
      && fsSync.existsSync(cached.filePath)
      && (!strict || this.isLocationGloballyVerified(id))
    ) {
      return cached.filePath;
    }
    if (cached?.kind === 'ambiguous') {
      const stillPresent = cached.filePaths.filter((candidate) => fsSync.existsSync(candidate));
      if (stillPresent.length === cached.filePaths.length) {
        if (strict) {
          throw new SessionReadError(
            'data_changed',
            `Ambiguous Session id ${id} has multiple persisted main files`,
          );
        }
        return this.resolveAmbiguousSessionLocation(id, stillPresent);
      }
    }
    const hinted = await this.resolveSessionLocationHint(id, strict);
    if (hinted !== undefined) return hinted;

    let traversalComplete = true;
    try {
      await fs.mkdir(path.join(this.sessionsDir, SESSION_LOCATION_INDEX_DIR), {
        recursive: true,
      });
    } catch (error: unknown) {
      traversalComplete = false;
      reportStorageDiagnostic(
        'warn',
        `Unable to prepare the durable Session location index for ${id}.`,
        error,
      );
    }
    const flat = this.legacyFlatPath(id);
    let topologyBefore: SessionTopologyIdentity | null | undefined;
    try {
      topologyBefore = await statSessionTopologyIdentity(this.sessionsDir, id);
    } catch {
      traversalComplete = false;
    }
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        traversalComplete = false;
      }
      entries = [];
    }
    const candidates = [flat];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      candidates.push(
        path.join(this.sessionsDir, entry.name, `${id}.jsonl`),
        path.join(this.sessionsDir, entry.name, 'archived', `${id}.jsonl`),
      );
    }
    const matches: string[] = [];
    const LOCATOR_STAT_CONCURRENCY = 48;
    for (let offset = 0; offset < candidates.length; offset += LOCATOR_STAT_CONCURRENCY) {
      const batch = candidates.slice(offset, offset + LOCATOR_STAT_CONCURRENCY);
      const presences = await Promise.all(batch.map(inspectSessionCandidateAsync));
      for (const [index, presence] of presences.entries()) {
        const candidate = batch[index]!;
        if (presence === 'present') matches.push(candidate);
        if (presence === 'unverifiable') traversalComplete = false;
      }
    }
    matches.sort();
    let topologyAfter: SessionTopologyIdentity | null | undefined;
    try {
      topologyAfter = await statSessionTopologyIdentity(this.sessionsDir, id);
    } catch {
      traversalComplete = false;
    }
    traversalComplete = traversalComplete
      && topologyBefore !== undefined
      && topologyAfter !== undefined
      && sameOptionalSessionTopologyIdentity(topologyBefore, topologyAfter);
    if (strict && !traversalComplete) {
      throw new SessionReadError(
        'data_changed',
        `Session location topology could not be verified for ${id}`,
      );
    }
    if (strict) assertStableSessionReadBoundary(this.sessionsDir, id);
    if (matches.length === 0) {
      this.sessionLocations.delete(id);
      if (traversalComplete && topologyAfter !== null && topologyAfter !== undefined) {
        this.verifiedLocationMisses.set(id, topologyAfter);
      } else {
        this.verifiedLocationMisses.delete(id);
      }
      await this.persistSessionLocationHint(id);
      return null;
    }
    this.verifiedLocationMisses.delete(id);
    if (matches.length === 1) {
      this.sessionLocations.set(id, {
        kind: 'located',
        filePath: matches[0]!,
        globallyVerified: traversalComplete,
        ...(traversalComplete && topologyAfter !== null && topologyAfter !== undefined
          ? { topologyIdentity: topologyAfter }
          : {}),
      });
      await this.persistSessionLocationHint(id);
      return matches[0]!;
    }
    this.sessionLocations.set(id, { kind: 'ambiguous', filePaths: matches });
    await this.persistSessionLocationHint(id);
    if (strict) {
      throw new SessionReadError(
        'data_changed',
        `Ambiguous Session id ${id} has multiple persisted main files`,
      );
    }
    return this.resolveAmbiguousSessionLocation(id, matches);
  }

  private async resolveAmbiguousSessionLocation(
    id: string,
    matches: readonly string[],
  ): Promise<string> {
    // Ambiguous (legacy same-second duplicate ids across projects).
    // v0.7.46 F8 — only try cwd-based disambiguation when the caller has
    // signaled project intent via `this.hostCwd`. Pre-fix this fell
    // through to `process.cwd()`, which for SDK consumers without
    // `cwd` (e.g. KodaX Space) resolved to the embedder's startup
    // directory — neither candidate matched → `preferred = undefined`
    // → `null` returned → session load silently failed. Now: with no
    // hostCwd, take the first match (best-effort; FEATURE_219 added
    // an id uniqueness suffix so new sessions can't trigger this
    // path; only legacy same-second cross-project duplicates do).
    // The diagnostic notice still fires so the caller can debug.
    if (this.hostCwd) {
      const currentRuntime = await inspectWorkspaceRuntime({ cwd: this.hostCwd });
      const currentGitRoot = await getGitRoot(this.hostCwd);
      const currentDir = this.projectDir(deriveProjectKeyFromData({
        gitRoot: currentGitRoot ?? undefined,
        runtimeInfo: currentRuntime,
      }).key);
      const preferred = matches.find((candidate) => {
        const candidateDir = path.dirname(candidate);
        return candidateDir === currentDir
          || (path.basename(candidateDir) === 'archived'
            && path.dirname(candidateDir) === currentDir);
      });
      if (preferred) {
        return preferred;
      }
    }
    writeStorageNotice(
      `[KodaX] Ambiguous session id ${id} found in ${matches.length} projects; ` +
      `${this.hostCwd ? 'no current-project match — ' : ''}returning the first match. ` +
      `Specify projectKey to disambiguate.`,
    );
    return matches[0]!;
  }

  private async readSession(
    id: string,
    options: { readonly migrate?: boolean; readonly strict?: boolean } = {},
  ): Promise<ResolvedSessionSnapshot | null> {
    if (options.migrate !== false) await this.ensureMigrated();
    const filePath = await this.resolveSessionLocation(id, options.strict === true);
    if (!filePath) {
      return null;
    }
    const topologyIdentity = options.strict === true
      ? this.verifiedLocationTopology(id)
      : undefined;
    const snapshot = await readPersistedSessionFile(
      filePath,
      options.strict === true,
    );
    if (!snapshot) {
      return null;
    }
    if (options.strict === true) {
      this.assertLocationTopologyUnchanged(id, topologyIdentity);
    }

    warnMalformedSessionData(filePath, snapshot.malformedCount);
    const resolved = buildSessionData(snapshot, filePath);
    if (resolved.lineageIdentityFilterHash === undefined) {
      this.lineageIdentityFilterHashes.delete(id);
    } else {
      this.lineageIdentityFilterHashes.set(id, resolved.lineageIdentityFilterHash);
    }
    return resolved;
  }

  private async readArchivedEntries(
    id: string,
    sessionPath?: string,
    strict = false,
    contentOverrides?: ReadonlyMap<string, string | null>,
  ): Promise<ArchivedLineageRecord[]> {
    const located = sessionPath ?? await this.resolveSessionLocation(id);
    if (!located) return [];
    const dir = path.dirname(located);
    const paths = [
      path.join(dir, `${id}.islands.jsonl`),
      path.join(dir, `${id}.archive.jsonl`),
    ];
    const entries: ArchivedLineageRecord[] = [];
    for (let streamId = 0; streamId < paths.length; streamId += 1) {
      const sidecarPath = paths[streamId]!;
      let content: string;
      if (contentOverrides?.has(sidecarPath)) {
        const contentOverride = contentOverrides.get(sidecarPath);
        if (contentOverride === null || contentOverride === undefined) continue;
        content = contentOverride;
      } else {
        try {
          content = await fs.readFile(sidecarPath, 'utf-8');
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
      }
      const lines = content.split(/\r?\n/);
      let lastRecordIndex = -1;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if ((lines[index] ?? '').trim().length > 0) {
          lastRecordIndex = index;
          break;
        }
      }
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isPersistedArchivedEntryLine(parsed)) {
            const record = parsed as PersistedArchivedEntryCore & Record<string, unknown>;
            entries.push({
              ...parsed,
              previousEntryId: archivedEntryAnchor(record.previousEntryId),
              nextEntryId: archivedEntryAnchor(record.nextEntryId),
              streamId,
            });
          } else if (isRecord(parsed) && parsed._type === 'archive_batch') {
            continue;
          } else if (strict) {
            throw new SessionReadError(
              'version_incompatible',
              `Unsupported island sidecar record at ${path.basename(sidecarPath)}:${index + 1}`,
            );
          }
        } catch (error: unknown) {
          if (error instanceof SessionReadError) throw error;
          if (strict) {
            throw new SessionReadError(
              'data_corrupt',
              `Malformed island sidecar record at ${path.basename(sidecarPath)}:${index + 1}`,
            );
          }
          // A crash can leave one partial tail record. Earlier flushed records
          // and the main session remain authoritative and readable.
          reportStorageDiagnostic(
            'warn',
            index === lastRecordIndex
              ? `Ignored incomplete island sidecar tail ${path.basename(sidecarPath)}:${index + 1}.`
              : `Skipped malformed island sidecar record ${path.basename(sidecarPath)}:${index + 1}.`,
            error,
          );
        }
      }
    }
    return entries;
  }

  private async completeConversationLineage(
    id: string,
    sessionPath: string,
    lineage: KodaXSessionLineage,
  ): Promise<KodaXSessionLineage> {
    const archivedEntries = await this.readArchivedEntries(id, sessionPath);
    if (archivedEntries.length === 0) return lineage;
    return {
      ...lineage,
      entries: mergeFullLineageEntries(archivedEntries, lineage.entries),
    };
  }

  private async appendIslandArchive(
    id: string,
    data: SessionData,
    entries: readonly KodaXSessionEntry[],
    archiveBatchId: string,
    sourceEntries: readonly KodaXSessionEntry[],
    exactSessionPath?: string,
  ): Promise<void> {
    if (entries.length === 0) return;
    const archiveDir = exactSessionPath
      ? path.dirname(exactSessionPath)
      : this.resolveWriteDir(id, data);
    await fs.mkdir(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${id}.islands.jsonl`);
    const positionById = new Map(sourceEntries.map((entry, index) => [entry.id, index]));
    const handle = await fs.open(archivePath, 'a');
    try {
      await handle.write(JSON.stringify({
        _type: 'archive_batch',
        archiveBatchId,
        sessionId: id,
        archivedAt: new Date().toISOString(),
        entryCount: entries.length,
      }) + '\n');
      for (const entry of entries) {
        const index = positionById.get(entry.id);
        await handle.write(JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId,
          ...(index === undefined
            ? {}
            : {
                previousEntryId: sourceEntries[index - 1]?.id ?? null,
                nextEntryId: sourceEntries[index + 1]?.id ?? null,
              }),
          entry,
        }) + '\n');
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Create `<dir>/project.json` without ever writing through a conflicting identity. */
  private async ensureProjectJson(
    dir: string,
    identity: ProjectIdentity,
    replacementPath?: string,
  ): Promise<void> {
    if (identity.canonicalRoot === null) {
      return;
    }
    const cachedCanonicalRoot = this.projectJsonWritten.get(dir);
    if (cachedCanonicalRoot === identity.canonicalRoot) return;
    if (cachedCanonicalRoot !== undefined) {
      throw new SessionReadError(
        'data_changed',
        `Refusing to change the cached project identity for ${dir}`,
      );
    }
    const manifestPath = path.join(dir, 'project.json');
    let manifestExists: boolean;
    try {
      manifestExists = await projectManifestExists(dir);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SessionReadError('data_changed', `Unable to validate ${manifestPath}: ${reason}`);
    }
    if (!manifestExists) {
      const isMainSessionFile = (name: string): boolean => name.endsWith('.jsonl')
        && !name.endsWith('.archive.jsonl')
        && !name.endsWith('.islands.jsonl')
        && !name.startsWith('.');
      const activeEntries = await fs.readdir(dir, { withFileTypes: true });
      const hasActiveSessions = activeEntries.some((entry) => entry.isFile() && isMainSessionFile(entry.name));
      let hasArchivedSessions = false;
      try {
        hasArchivedSessions = (await fs.readdir(path.join(dir, 'archived'), { withFileTypes: true }))
          .some((entry) => entry.isFile() && isMainSessionFile(entry.name));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          const reason = error instanceof Error ? error.message : String(error);
          throw new SessionReadError('data_changed', `Unable to inspect ${dir}: ${reason}`);
        }
      }
      if (hasActiveSessions || hasArchivedSessions) {
        const directories = [dir, path.join(dir, 'archived')];
        const sessionFiles: string[] = [];
        for (const directory of directories) {
          try {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
              if (entry.isFile() && isMainSessionFile(entry.name)) {
                sessionFiles.push(path.join(directory, entry.name));
              }
            }
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        for (let offset = 0; offset < sessionFiles.length; offset += 48) {
          const batchMatches = await Promise.all(sessionFiles.slice(offset, offset + 48).map(async (filePath) => {
            const firstLine = await readSessionFirstLine(filePath);
            if (!firstLine) {
              return replacementPath !== undefined
                && path.basename(dir) === identity.key
                && path.resolve(filePath) === path.resolve(replacementPath);
            }
            try {
              const parsed: unknown = JSON.parse(firstLine);
              if (!isRecord(parsed) || parsed._type !== 'meta') return false;
              const persistedIdentity = deriveProjectKeyFromData({
                gitRoot: typeof parsed.gitRoot === 'string' ? parsed.gitRoot : undefined,
                runtimeInfo: isKodaXSessionRuntimeInfo(parsed.runtimeInfo) ? parsed.runtimeInfo : undefined,
              });
              return persistedIdentity.key === identity.key
                && persistedIdentity.canonicalRoot === identity.canonicalRoot;
            } catch {
              return false;
            }
          }));
          if (batchMatches.some((matches) => !matches)) {
            throw new SessionReadError(
              'data_changed',
              `Refusing to claim a mixed or unverifiable project bucket at ${manifestPath}`,
            );
          }
        }
      }
    }
    try {
      await publishProjectManifest(dir, identity);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SessionReadError('data_changed', `Unable to publish ${manifestPath}: ${reason}`);
    }
    this.projectJsonWritten.set(dir, identity.canonicalRoot);
  }

  // ── Phase 2: Streaming write (no join) ──
  // Writes one JSONL line at a time via file handle, eliminating the giant
  // concatenated string that the old join('\n') approach produced.
  private async rebuildConversationCache(
    id: string,
    mainPath: string,
    lineage: KodaXSessionLineage,
    runtimeInfo: KodaXSessionRuntimeInfo | undefined,
  ): Promise<void> {
    try {
      const archivedEntries = await this.readArchivedEntries(id, mainPath, true);
      const completeLineage = archivedEntries.length === 0
        ? lineage
        : {
            ...lineage,
            entries: mergeFullLineageEntries(archivedEntries, lineage.entries),
          };
      const bundle = await readStableSessionBundleAtPath(
        this.sessionsDir,
        id,
        mainPath,
        undefined,
        true,
      );
      const history = buildSessionConversationHistory(completeLineage, bundle.sourceRevision);
      if (await refreshConversationPageCache(
        mainPath,
        bundle.boundaryRevision,
        bundle.sourceRevisionState,
        history,
        completeLineage,
        runtimeInfo,
      )) return;
      await writeConversationPageCache(
        mainPath,
        bundle.boundaryRevision,
        bundle.sourceRevisionState,
        history,
        completeLineage,
        runtimeInfo,
        SESSION_CONVERSATION_CACHE_CHUNK_BYTES,
      );
    } catch (error: unknown) {
      try {
        await removeConversationPageCache(mainPath);
      } catch (cleanupError: unknown) {
        reportStorageDiagnostic(
          'warn',
          `Unable to invalidate Conversation page cache for ${id}.`,
          new AggregateError([error, cleanupError]),
        );
        return;
      }
      reportStorageDiagnostic(
        'warn',
        `Unable to prepare Conversation pages for ${id}; reads will use the canonical fallback.`,
        error,
      );
    }
  }

  private async updateConversationCacheAfterAppend(
    id: string,
    mainPath: string,
    priorBoundary: StableSessionBundleBoundarySnapshot,
    priorActiveEntryId: string | null | undefined,
    appendedLineageEntries: readonly KodaXSessionEntry[],
    activeEntryId: string | null,
    appendedContent: string,
  ): Promise<void> {
    try {
      const manifest = await readConversationPageCacheManifest(mainPath);
      const projected = manifest?.boundaryRevision === priorBoundary.revision
          ? canAppendConversationPageCache(
            manifest,
            priorActiveEntryId,
            appendedLineageEntries,
            activeEntryId,
          )
        : undefined;
      if (manifest === undefined || projected === undefined) {
        if (manifest !== undefined) await removeConversationPageCache(mainPath);
        return;
      }
      const sourceRevisionState = extendSessionMainSourceRevisionState(
        manifest.sourceRevisionState,
        path.relative(this.sessionsDir, mainPath).replace(/\\/g, '/'),
        Buffer.from(appendedContent, 'utf8'),
      );
      if (sourceRevisionState === undefined) {
        await removeConversationPageCache(mainPath);
        return;
      }
      const boundary = await readStableSessionBundleBoundarySnapshotAtPath(
        this.sessionsDir,
        id,
        mainPath,
        true,
      );
      if (!isExpectedAppendBoundaryTransition(
        priorBoundary,
        boundary,
        Buffer.byteLength(appendedContent, 'utf8'),
      )) {
        await removeConversationPageCache(mainPath);
        return;
      }
      await appendConversationPageCache(
        mainPath,
        manifest,
        boundary.revision,
        sourceRevisionState,
        projected,
        appendedLineageEntries,
        activeEntryId,
      );
    } catch (error: unknown) {
      reportStorageDiagnostic(
        'warn',
        `Unable to extend Conversation page cache for ${id}; invalidating it.`,
        error,
      );
      try {
        await removeConversationPageCache(mainPath);
      } catch (cleanupError: unknown) {
        reportStorageDiagnostic(
          'warn',
          `Unable to invalidate Conversation page cache for ${id}.`,
          new AggregateError([error, cleanupError]),
        );
      }
    }
  }

  private async writeSessionInternal(
    id: string,
    data: SessionData,
    createdAt?: string,
    exactTargetPath?: string,
    verifiedTopology = this.verifiedLocationTopology(id),
    conversationLineage?: KodaXSessionLineage,
    canonicalObserver?: CanonicalWriteObserver,
  ): Promise<string> {
    const dir = exactTargetPath
      ? path.dirname(exactTargetPath)
      : this.resolveWriteDir(id, data);
    const targetPath = exactTargetPath ?? path.join(dir, `${id}.jsonl`);
    const projectDir = path.basename(dir) === 'archived' ? path.dirname(dir) : dir;
    const nextProjectIdentity = deriveProjectKeyFromData(data);
    const cachedCanonicalRoot = this.appendState.get(id)?.projectCanonicalRoot;
    if (
      exactTargetPath !== undefined
      && cachedCanonicalRoot !== undefined
      && nextProjectIdentity.canonicalRoot !== null
      && cachedCanonicalRoot !== nextProjectIdentity.canonicalRoot
    ) {
      throw new SessionReadError(
        'data_changed',
        `Refusing to move Session ${id} across cached project identities`,
      );
    }
    await fs.mkdir(dir, { recursive: true });
    await this.ensureProjectJson(projectDir, nextProjectIdentity, targetPath);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${sessionTempSequence++}.tmp`;
    const lineage = data.lineage ?? createSessionLineage(data.messages);
    const completeIdentityFilter = conversationLineage === undefined
      ? undefined
      : createConversationPageIdentityFilter(conversationLineage);
    const completeIdentityFilterHash = completeIdentityFilter === undefined
      ? undefined
      : conversationIdentityFilterHash(completeIdentityFilter);
    const meta = createSessionMeta(
      id,
      data,
      lineage,
      createdAt,
      completeIdentityFilterHash,
    );
    const resumeProjectDir = resumeIndexProjectDir(targetPath);
    const targetsActiveSession = path.basename(path.dirname(targetPath)) !== 'archived';
    const resumeItemCount = countResumableSessionItems(
      meta.activeMessageCount ?? 0,
      meta.uiHistory,
    );
    const resumable = targetsActiveSession
      && meta.scope !== 'managed-task-worker'
      && resumeItemCount > 0;
    const resumeEntry = createResumeIndexEntry(
      id,
      meta.title,
      resumeItemCount,
      meta.createdAt,
      meta.runtimeInfo?.surface,
    );
    if (resumable) {
      try {
        await prepareResumeIndexEntry(resumeProjectDir, resumeEntry);
      } catch (error: unknown) {
        reportStorageDiagnostic('warn', `Unable to prepare the resume index for ${id}.`, error);
      }
    }
    const legacy = this.legacyFlatPath(id);
    const changesLocation = !fsSync.existsSync(targetPath)
      || (legacy !== targetPath && fsSync.existsSync(legacy));
    const write = async (): Promise<void> => {
      try {
        canonicalObserver?.beginTiming('tempWrite');
        const tempWriteStartedAt = performance.now();
        const handle = await fs.open(tempPath, 'w');
        try {
          try {
            await handle.write(JSON.stringify(meta) + '\n');
            for (const entry of lineage.entries) {
              await handle.write(JSON.stringify(toLineageEntryLine(entry)) + '\n');
            }
            for (const entry of (data.artifactLedger ?? [])) {
              await handle.write(JSON.stringify(toArtifactLedgerLine(entry)) + '\n');
            }
            for (const record of (data.extensionRecords ?? [])) {
              await handle.write(JSON.stringify(toExtensionRecordLine(record)) + '\n');
            }
          } finally {
            canonicalObserver?.recordTiming('tempWrite', elapsedMs(tempWriteStartedAt));
          }
          canonicalObserver?.beginTiming('fsync');
          const fsyncStartedAt = performance.now();
          try {
            await handle.sync();
          } finally {
            canonicalObserver?.recordTiming('fsync', elapsedMs(fsyncStartedAt));
          }
        } finally {
          await handle.close();
        }
        canonicalObserver?.beginTiming('rename');
        canonicalObserver?.beforeCommit();
        const renameStartedAt = performance.now();
        try {
          await replaceSessionFile(tempPath, targetPath);
        } finally {
          canonicalObserver?.recordTiming('rename', elapsedMs(renameStartedAt));
        }
        canonicalObserver?.afterCommit();
        // Lazy migrate-on-write: a legacy flat copy is now superseded by the
        // per-project file. Remove it (and relocate its sidecar) so the locator
        // never sees the same id in two places.
        if (legacy !== targetPath && fsSync.existsSync(legacy)) {
          await fs.unlink(legacy).catch(() => undefined);
          const legacyArchive = this.legacyFlatArchivePath(id);
          if (fsSync.existsSync(legacyArchive)) {
            // Rename the legacy `.archive.jsonl` sidecar to `.islands.jsonl` (Phase 3).
            await fs.rename(
              legacyArchive,
              path.join(projectDir, `${id}.islands.jsonl`),
            ).catch(() => undefined);
          }
        }
      } finally {
        if (fsSync.existsSync(tempPath)) {
          await fs.unlink(tempPath).catch(() => undefined);
        }
      }
    };
    if (changesLocation) {
      canonicalObserver?.beginTiming('topology');
      const topologyStartedAt = performance.now();
      let topologyRecorded = false;
      try {
        await this.withSessionLocationTopologyChange(write, () => {
          topologyRecorded = true;
          canonicalObserver?.recordTiming('topology', elapsedMs(topologyStartedAt));
        });
      } finally {
        if (!topologyRecorded) {
          canonicalObserver?.recordTiming('topology', elapsedMs(topologyStartedAt));
        }
      }
    } else {
      await write();
    }
    try {
      await commitResumeIndexEntry(
        resumeProjectDir,
        resumeEntry,
        resumable,
      );
    } catch (error: unknown) {
      reportStorageDiagnostic('warn', `Unable to refresh the resume index for ${id}.`, error);
    }
    if (conversationLineage === undefined) {
      // Without an explicit complete lineage, rebuilding from the main file
      // alone could omit archived-sidecar identities and incorrectly authorize
      // a later prepared tail. The next exact full merge rebuilds the cache.
      await removeConversationPageCache(targetPath);
    } else {
      await this.rebuildConversationCache(
        id,
        targetPath,
        conversationLineage,
        data.runtimeInfo,
      );
    }
    const knownMainPaths = [targetPath];
    if (legacy !== targetPath && fsSync.existsSync(legacy)) {
      knownMainPaths.push(legacy);
    }
    const currentTopology = this.readSessionTopologyIdentitySync(id);
    const globallyVerified = verifiedTopology !== undefined
      && currentTopology !== undefined;
    this.verifiedLocationMisses.delete(id);
    this.sessionLocations.set(id, knownMainPaths.length === 1
      ? {
          kind: 'located',
          filePath: targetPath,
          globallyVerified,
          ...(globallyVerified
            ? { topologyIdentity: currentTopology }
            : {}),
        }
      : { kind: 'ambiguous', filePaths: knownMainPaths.sort() });
    if (completeIdentityFilterHash === undefined) {
      this.lineageIdentityFilterHashes.delete(id);
    } else {
      this.lineageIdentityFilterHashes.set(id, completeIdentityFilterHash);
    }
    return targetPath;
  }

  // ── Merge helper ──
  // Reads existing session, merges omitted fields (extensionState, runtimeInfo,
  // etc.), then does a full streamed write. Used by both save() and
  // appendSessionDelta fallback so that partially-populated data from
  // InkREPL.persistContextState never overwrites already-persisted fields.
  private async mergeAndWriteInternal(
    id: string,
    data: SessionData,
    acceptSandboxWorktreeRoots = false,
  ): Promise<void> {
    const existing = await this.readSession(id);
    const verifiedTopology = existing === null
      ? this.verifiedMissingLocationTopology(id)
      : this.verifiedLocationTopology(id);
    const merged: SessionData = {
      ...data,
      scope: data.scope ?? existing?.data.scope ?? 'user',
      uiHistory: data.uiHistory ?? existing?.data.uiHistory,
      extensionState: data.extensionState ?? existing?.data.extensionState,
      artifactLedger: data.artifactLedger ?? existing?.data.artifactLedger,
      // Actor state has one writer: saveActorSnapshot's revision CAS. A stale
      // full Session snapshot must never replace a newer owner/revision.
      actorSnapshot: existing?.data.actorSnapshot ?? data.actorSnapshot,
      extensionRecords: data.extensionRecords ?? existing?.data.extensionRecords,
      runtimeInfo: data.runtimeInfo === undefined
        ? existing?.data.runtimeInfo
        : {
            ...data.runtimeInfo,
            ...(!acceptSandboxWorktreeRoots
              && existing?.data.runtimeInfo?.sandboxWorktreeRoots !== undefined
              ? {
                  sandboxWorktreeRoots:
                    existing.data.runtimeInfo.sandboxWorktreeRoots,
                }
              : {}),
          },
      // Full snapshots use own-property presence as a three-state contract:
      // omitted preserves a partial writer's value, an object records a
      // failure, and explicit undefined clears stale crash metadata after a
      // later successful Turn.
      errorMetadata: Object.prototype.hasOwnProperty.call(data, 'errorMetadata')
        ? data.errorMetadata
        : existing?.data.errorMetadata,
      tag: data.tag ?? existing?.data.tag,
      // FEATURE_173 no-regress guard — a lineage-less snapshot whose messages
      // are a prefix of the persisted active path reuses the existing lineage
      // instead of regressing `activeEntryId` (the dual-writer corruption).
      lineage: resolveSnapshotLineage(data, existing?.data.lineage),
    };
    if (existing !== null) {
      const existingIdentity = deriveProjectKeyFromData(existing.data);
      const nextIdentity = deriveProjectKeyFromData(merged);
      if (
        existingIdentity.canonicalRoot !== null
        && nextIdentity.canonicalRoot !== null
        && existingIdentity.canonicalRoot !== nextIdentity.canonicalRoot
      ) {
        throw new SessionReadError(
          'data_changed',
          `Refusing to move Session ${id} across project identities during an in-place save`,
        );
      }
    }
    const archivedRecords = await this.readArchivedEntries(id);
    const reconciledLineage = reconcileCompactionLineage(
      merged.lineage!,
      existing?.data.lineage,
      archivedRecords,
    );
    const archiveResult = archiveOldIslands(reconciledLineage);
    await this.appendIslandArchive(
      id,
      merged,
      archiveResult.archivedEntries,
      archiveResult.archiveBatchId,
      reconciledLineage.entries,
      existing?.filePath,
    );
    const persisted: SessionData = { ...merged, lineage: archiveResult.slimmedLineage };
    const targetPath = await this.writeSessionInternal(
      id,
      persisted,
      existing?.createdAt,
      existing?.filePath,
      verifiedTopology,
      reconciledLineage,
    );
    // The caller continues with the unslimmed lineage. Keep its count as the
    // append watermark even though storage moved old entries to the sidecar.
    await this.syncAppendStateFromFile(
      id,
      { ...merged, lineage: reconciledLineage },
      targetPath,
    );
  }

  // ── Phase 1: Append-only hot path ──
  // Full caller-owned snapshots take the exact canonical merge path. A
  // cross-process change is merged with the caller snapshot rather than
  // allowing either writer to silently discard the other's new branch.
  async appendSessionDelta(id: string, data: SessionData): Promise<void> {
    await this.ensureMigrated();

    await this.serializedWrite(id, async () => {
      const cached = this.appendState.get(id);
      const latestMainIdentity = cached?.filePath === undefined
        ? null
        : await statStableFileIdentity(cached.filePath);
      const baselineChanged = cached !== undefined && (
        cached.mainIdentity === undefined
        || latestMainIdentity === null
        || !sameStableFileIdentity(cached.mainIdentity, latestMainIdentity)
      );
      if (!baselineChanged) {
        await this.mergeAndWriteInternal(id, data);
        return;
      }
      const latest = await this.readSession(id);
      await this.mergeAndWriteInternal(
        id,
        latest ? mergeConcurrentAppendData(data, latest.data) : data,
      );
    });
  }

  /**
   * Append an explicit new tail without accepting any historical prefix.
   * A fulfilled non-null value means the append committed and its successor
   * boundary is reusable. A fulfilled `null` also means the append committed,
   * but the successor could not be witnessed: reload and do not retry the same
   * tail. Pre-commit validation conflicts reject with `data_changed`.
   */
  async appendPreparedSessionTail(
    id: string,
    delta: PreparedSessionTailDelta,
  ): Promise<PreparedSessionAppendBaseline | null> {
    // Snapshot the complete bounded delta before the first await. Public SDK
    // callers retain mutable object references; validation and serialization
    // must observe the same values.
    const preparedDelta = structuredClone(delta);
    await this.ensureMigrated();
    let nextBaseline: PreparedSessionAppendBaseline | undefined;
    let committed = false;
    try {
      await this.serializedWrite(id, async () => {
      const cached = this.appendState.get(id);
      const expected = preparedDelta.baseline;
      if (
        cached === undefined
        || expected.sessionId !== id
        || cached.appendRevision !== expected.revision
        || cached.lineageCount !== expected.lineageCount
        || cached.artifactCount !== expected.artifactCount
        || cached.extensionCount !== expected.extensionCount
        || (cached.activeEntryId ?? null) !== expected.activeEntryId
        || cached.tag !== expected.tag
      ) {
        throw new SessionReadError(
          'data_changed',
          `Prepared Session append boundary changed for ${id}; reload before retrying`,
        );
      }

      const newLineage = preparedDelta.lineageEntries;
      const newArtifacts = preparedDelta.artifactEntries ?? [];
      const newExtensions = preparedDelta.extensionRecords ?? [];
      if (
        cached.lineageIdentityFilter === undefined
        || cached.lineageIdentityFilterHash === undefined
        || conversationIdentityFilterHash(cached.lineageIdentityFilter)
          !== cached.lineageIdentityFilterHash
        || cached.bundleBoundaryRevision === undefined
        || !isLinearPreparedMessageTail(
          cached.activeEntryId,
          newLineage,
          preparedDelta.activeEntryId,
          cached.lineageIdentityFilter,
        )
        || hasTailIdCollision(newArtifacts, cached.artifactEntryIds)
        || hasArtifactTailConflict(newArtifacts, cached.artifactDedupKeys)
        || hasTailIdCollision(newExtensions, cached.extensionRecordIds)
      ) {
        throw new SessionReadError(
          'data_changed',
          `Prepared Session tail for ${id} is not a new linear append; use appendSessionDelta()`,
        );
      }
      const nextActiveMessageCount = activeMessageCountAfterAppend(
        cached.activeEntryId,
        cached.activeMessageCount,
        newLineage,
        preparedDelta.activeEntryId,
      );
      if (nextActiveMessageCount === undefined) {
        throw new SessionReadError(
          'data_changed',
          `Prepared Session tail for ${id} is not a linear append; use appendSessionDelta()`,
        );
      }

      const latestMainIdentity = cached.filePath === undefined
        ? null
        : await statStableFileIdentity(cached.filePath);
      if (
        cached.filePath === undefined
        || cached.mainIdentity === undefined
        || latestMainIdentity === null
        || !sameStableFileIdentity(cached.mainIdentity, latestMainIdentity)
      ) {
        throw new SessionReadError(
          'data_changed',
          `Persisted Session changed after the prepared append boundary for ${id}`,
        );
      }

      const priorBoundary = await readStableSessionBundleBoundarySnapshotAtPath(
        this.sessionsDir,
        id,
        cached.filePath,
        true,
      );
      if (priorBoundary.revision !== cached.bundleBoundaryRevision) {
        throw new SessionReadError(
          'data_changed',
          `Persisted Session bundle changed after the prepared append boundary for ${id}`,
        );
      }
      const parts: string[] = [];
      for (const entry of newLineage) {
        parts.push(JSON.stringify(toLineageEntryLine(entry)));
      }
      for (const entry of newArtifacts) {
        parts.push(JSON.stringify(toArtifactLedgerLine(entry)));
      }
      for (const record of newExtensions) {
        parts.push(JSON.stringify(toExtensionRecordLine(record)));
      }
      const nextLineageIdentityFilter = extendConversationPageIdentityFilter(
        cached.lineageIdentityFilter,
        newLineage,
      );
      const nextLineageIdentityFilterHash = conversationIdentityFilterHash(
        nextLineageIdentityFilter,
      );
      const metaUpdate: PersistedMetaUpdateLine = {
        _type: 'meta_update',
        title: preparedDelta.title,
        activeEntryId: preparedDelta.activeEntryId,
        activeMessageCount: nextActiveMessageCount,
        ...(preparedDelta.uiHistory !== undefined ? { uiHistory: [...preparedDelta.uiHistory] } : {}),
        ...(preparedDelta.scope !== undefined ? { scope: preparedDelta.scope } : {}),
        lineageIdentityFilterHash: nextLineageIdentityFilterHash,
      };
      parts.push(JSON.stringify(metaUpdate));

      const appendedContent = `\n${parts.join('\n')}`;
      const nextScope = preparedDelta.scope ?? cached.scope ?? 'user';
      const targetsActiveSession = path.basename(path.dirname(cached.filePath)) !== 'archived';
      const nextPresentationOnlyHistoryCount = preparedDelta.uiHistory === undefined
        ? cached.presentationOnlyHistoryCount
        : countResumableSessionItems(0, preparedDelta.uiHistory);
      const nextResumeItemCount = nextActiveMessageCount + nextPresentationOnlyHistoryCount;
      const resumable = targetsActiveSession
        && nextScope !== 'managed-task-worker'
        && nextResumeItemCount > 0;
      const resumeProjectDir = resumeIndexProjectDir(cached.filePath);
      const resumeEntry = createResumeIndexEntry(
        id,
        preparedDelta.title,
        nextResumeItemCount,
        undefined,
        cached.surface,
      );
      if (resumable) {
        try {
          await prepareResumeIndexEntry(resumeProjectDir, resumeEntry);
        } catch (error: unknown) {
          reportStorageDiagnostic('warn', `Unable to prepare the resume index for ${id}.`, error);
        }
      }
      await fs.appendFile(cached.filePath, appendedContent, 'utf-8');
      committed = true;
      try {
        await commitResumeIndexEntry(
          resumeProjectDir,
          resumeEntry,
          resumable,
        );
      } catch (error: unknown) {
        reportStorageDiagnostic('warn', `Unable to refresh the resume index for ${id}.`, error);
      }
      await this.updateConversationCacheAfterAppend(
        id,
        cached.filePath,
        priorBoundary,
        cached.activeEntryId,
        newLineage,
        preparedDelta.activeEntryId,
        appendedContent,
      );

      for (const entry of newArtifacts) cached.artifactEntryIds.add(entry.id);
      for (const entry of newArtifacts) cached.artifactDedupKeys.add(artifactLedgerDedupKey(entry));
      for (const record of newExtensions) cached.extensionRecordIds.add(record.id);

      const nextBoundary = await readStableSessionBundleBoundarySnapshotAtPath(
        this.sessionsDir,
        id,
        cached.filePath,
        true,
      );

      this.appendState.set(id, {
        ...cached,
        appendRevision: randomUUID(),
        lineageCount: cached.lineageCount + newLineage.length,
        artifactCount: cached.artifactCount + newArtifacts.length,
        extensionCount: cached.extensionCount + newExtensions.length,
        activeEntryId: preparedDelta.activeEntryId,
        activeMessageCount: nextActiveMessageCount,
        presentationOnlyHistoryCount: nextPresentationOnlyHistoryCount,
        scope: nextScope,
        lineageIdentityFilter: nextLineageIdentityFilter,
        lineageIdentityFilterHash: nextLineageIdentityFilterHash,
        bundleBoundaryRevision: nextBoundary.revision,
        mainIdentity: await statStableFileIdentity(cached.filePath) ?? undefined,
      });
      this.lineageIdentityFilterHashes.set(id, nextLineageIdentityFilterHash);
      nextBaseline = this.currentPreparedSessionAppend(id) ?? undefined;
      });
    } catch (error: unknown) {
      if (!committed) throw error;
      this.appendState.delete(id);
      reportStorageDiagnostic(
        'error',
        `Prepared Session tail for ${id} committed, but its successor boundary could not be prepared; reload before the next append.`,
        error,
      );
      return null;
    }

    return nextBaseline ?? null;
  }

  // ── Public API ──

  async save(id: string, data: SessionData): Promise<void> {
    await this.serializedWrite(id, async () => {
      await this.mergeAndWriteInternal(id, data);
    });
  }

  /**
   * Fast creation path for IDs produced by KodaX's timestamp + random-bit
   * generator. The per-ID cross-process lock and exact target check preserve
   * atomic creation without an all-project negative lookup. Caller-supplied
   * IDs must continue through the ordinary global conflict check.
  */
  async createGenerated(id: string, data: SessionData): Promise<void> {
    await this.serializedWrite(id, async () => {
      await fs.mkdir(path.join(this.sessionsDir, SESSION_LOCATION_INDEX_DIR), {
        recursive: true,
      });
      const targetPath = this.writeFilePath(id, data);
      if (fsSync.existsSync(targetPath) || fsSync.existsSync(this.legacyFlatPath(id))) {
        throw Object.assign(new Error(`Session already exists: ${id}`), {
          code: 'conflict' as const,
        });
      }
      await this.writeSessionInternal(
        id,
        data,
        undefined,
        targetPath,
        undefined,
        data.lineage ?? createSessionLineage(data.messages),
      );
      const topology = this.readSessionTopologyIdentitySync(id);
      if (topology !== undefined) {
        this.sessionLocations.set(id, {
          kind: 'located',
          filePath: targetPath,
          globallyVerified: true,
          topologyIdentity: topology,
        });
      }
      await this.syncAppendStateFromFile(id, data, targetPath);
    });
  }

  async mutateLineage(
    id: string,
    mutation: (lineage: KodaXSessionLineage) => KodaXSessionLineage,
  ): Promise<boolean> {
    let found = false;
    await this.serializedWrite(id, async () => {
      const existing = await this.readSession(id);
      if (existing === null) return;
      found = true;
      const lineage = existing.data.lineage ?? createSessionLineage(existing.data.messages);
      const nextLineage = mutation(lineage);
      if (nextLineage === lineage) return;
      await this.mergeAndWriteInternal(id, {
        ...existing.data,
        lineage: nextLineage,
      });
    });
    return found;
  }

  async mutateRuntimeInfo(
    id: string,
    mutation: (
      runtimeInfo: KodaXSessionRuntimeInfo | undefined,
    ) => KodaXSessionRuntimeInfo | undefined,
  ): Promise<boolean> {
    let found = false;
    await this.serializedWrite(id, async () => {
      const existing = await this.readSession(id);
      if (existing === null) return;
      found = true;
      const current = existing.data.runtimeInfo === undefined
        ? undefined
        : structuredClone(existing.data.runtimeInfo);
      const runtimeInfo = mutation(current);
      await this.mergeAndWriteInternal(id, {
        ...existing.data,
        runtimeInfo,
      }, true);
    });
    return found;
  }

  /** Phase-aware Actor CAS save; canonical success is observable before cache maintenance. */
  beginActorSnapshotSave(
    id: string,
    snapshot: AgentActorSnapshot,
    expectedRevision: number,
  ): AgentActorSaveAttempt {
    const lifecycle = createActorSaveLifecycle(id, snapshot.revision);
    const write = this.serializedWrite(
      id,
      async () => {
        lifecycle.canonicalObserver.beginTiming('readCas');
        const readStartedAt = performance.now();
        let resolved: ResolvedSessionSnapshot;
        try {
          const current = await this.readSession(id);
          if (!current) throw new Error(`Session not found: ${id}`);
          const actualRevision = current.data.actorSnapshot?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            throw new AgentActorStoreConflictError(expectedRevision, actualRevision, id);
          }
          resolved = current;
        } finally {
          lifecycle.canonicalObserver.recordTiming('readCas', elapsedMs(readStartedAt));
        }
        const updated: SessionData = {
          ...resolved.data,
          actorSnapshot: structuredClone(snapshot),
        };
        lifecycle.canonicalObserver.beginTiming('lineage');
        const lineageStartedAt = performance.now();
        let completeLineage: KodaXSessionLineage | undefined;
        try {
          completeLineage = updated.lineage === undefined
            ? undefined
            : await this.completeConversationLineage(id, resolved.filePath, updated.lineage);
        } finally {
          lifecycle.canonicalObserver.recordTiming('lineage', elapsedMs(lineageStartedAt));
        }
        let targetPath: string;
        try {
          targetPath = await this.writeSessionInternal(
            id,
            updated,
            resolved.createdAt,
            resolved.filePath,
            undefined,
            completeLineage,
            lifecycle.canonicalObserver,
          );
        } catch (error: unknown) {
          let persistenceError = error;
          if (lifecycle.attempt.phase() === 'commit_inflight') {
            try {
              const observed = await this.readSession(id);
              const observedSnapshot = observed?.data.actorSnapshot;
              const observedRevision = observed?.data.actorSnapshot?.revision ?? 0;
              if (isDeepStrictEqual(observedSnapshot, jsonPersistedValue(snapshot))) {
                lifecycle.markCommitObservedByReadback();
              } else if (observedRevision === expectedRevision) {
                lifecycle.markCommitNotObserved(error);
              } else {
                persistenceError = new AggregateError(
                  [
                    error,
                    new Error(
                      `Actor snapshot readback observed revision ${observedRevision}; `
                      + `expected prior ${expectedRevision} or exact target ${snapshot.revision}.`,
                    ),
                  ],
                  'Actor snapshot replacement result is ambiguous.',
                );
              }
            } catch (readbackError: unknown) {
              persistenceError = new AggregateError(
                [error, readbackError],
                'Actor snapshot replacement failed and canonical readback was unavailable.',
              );
            }
          }
          throw persistenceError;
        }
        await this.syncAppendStateFromFile(id, updated, targetPath);
      },
      lifecycle.queueObserver,
    );
    lifecycle.settleCompletion(write);
    return lifecycle.attempt;
  }

  /** F270/F269 owner mutation: CAS-update only the Actor section of a session snapshot. */
  async saveActorSnapshot(
    id: string,
    snapshot: AgentActorSnapshot,
    expectedRevision: number,
  ): Promise<void> {
    await this.beginActorSnapshotSave(id, snapshot, expectedRevision).completion;
  }

  /** Read Session data without recovery writes or append-watermark mutation. */
  async peek(id: string): Promise<SessionData | null> {
    const resolved = await this.readSession(id, { migrate: false });
    return resolved ? structuredClone(resolved.data) : null;
  }

  /** Strict read-only Session load. It never migrates or repairs persisted data. */
  async read(
    id: string,
    options: SessionReadOptions = {},
  ): Promise<SessionData | null> {
    throwIfSessionReadAborted(options.signal);
    const resolved = await raceSessionRead(
      this.readSession(id, { migrate: false, strict: true }),
      options,
    );
    return resolved ? structuredClone(resolved.data) : null;
  }

  async readConversationPageCache(
    id: string,
    input: ConversationPageCacheInput,
    options: SessionReadOptions = {},
  ): Promise<ConversationPageCachePage | null> {
    throwIfSessionReadAborted(options.signal);
    const operation = (async (): Promise<ConversationPageCachePage | null> => {
      const mainPath = await this.resolveSessionLocation(id, true);
      if (mainPath === null) return null;
      const topologyIdentity = this.verifiedLocationTopology(id);
      try {
        const before = await readStableSessionBundleBoundaryAtPath(
          this.sessionsDir,
          id,
          mainPath,
        );
        const page = await readPreparedConversationPage(mainPath, before, {
          ...input,
          signal: options.signal,
        });
        const after = await readStableSessionBundleBoundaryAtPath(
          this.sessionsDir,
          id,
          mainPath,
        );
        this.assertLocationTopologyUnchanged(id, topologyIdentity);
        if (before !== after) {
          throw new ConversationPageCacheStaleError('Conversation history changed during paging');
        }
        if (page === null && input.expectedRevision !== undefined) {
          throw new ConversationPageCacheStaleError('Conversation history changed; request a fresh page');
        }
        return page;
      } catch (error: unknown) {
        if (error instanceof ConversationPageCacheStaleError) {
          if (input.expectedRevision === undefined) return null;
          throw new SessionReadError('data_changed', error.message);
        }
        throw error;
      }
    })();
    return raceSessionRead(operation, options);
  }

  async readConversationPageBoundary(
    id: string,
    options: SessionReadOptions = {},
  ): Promise<{
    readonly boundaryRevision: string;
    readonly admission: ConversationPageCacheAdmission;
  } | null> {
    throwIfSessionReadAborted(options.signal);
    const operation = (async () => {
      const mainPath = await this.resolveSessionLocation(id, true);
      if (mainPath === null) return null;
      const topologyIdentity = this.verifiedLocationTopology(id);
      const before = await readStableSessionBundleBoundaryAtPath(
        this.sessionsDir,
        id,
        mainPath,
      );
      const admission = await readConversationPageAdmission(mainPath);
      const after = await readStableSessionBundleBoundaryAtPath(
        this.sessionsDir,
        id,
        mainPath,
      );
      this.assertLocationTopologyUnchanged(id, topologyIdentity);
      if (before !== after) {
        throw new SessionReadError(
          'data_changed',
          'Session changed while validating a Conversation page boundary',
        );
      }
      return { boundaryRevision: after, admission };
    })();
    return raceSessionRead(operation, options);
  }

  async prepareConversationPageCache(
    id: string,
    history: SessionConversationHistoryData,
    lineage: KodaXSessionLineage,
    runtimeInfo: KodaXSessionRuntimeInfo | undefined,
    boundaryRevision: string,
    sourceRevisionState: SessionSourceRevisionState,
    options: SessionReadOptions = {},
  ): Promise<void> {
    throwIfSessionReadAborted(options.signal);
    const mainPath = await this.resolveSessionLocation(id, true);
    if (mainPath === null) {
      throw new SessionReadError('data_changed', 'Session moved before page preparation');
    }
    await raceSessionRead(this.serializedWrite(id, async () => {
      throwIfSessionReadAborted(options.signal);
      const currentBoundary = await readStableSessionBundleBoundaryAtPath(
        this.sessionsDir,
        id,
        mainPath,
        true,
      );
      if (currentBoundary !== boundaryRevision) {
        throw new SessionReadError('data_changed', 'Session changed before page preparation');
      }
      await writeConversationPageCache(
        mainPath,
        boundaryRevision,
        sourceRevisionState,
        history,
        lineage,
        runtimeInfo,
        SESSION_CONVERSATION_CACHE_CHUNK_BYTES,
      );
    }), options);
  }

  async readConversationPageCacheChunk(
    id: string,
    input: ConversationPageCacheChunkInput,
    options: SessionReadOptions = {},
  ): Promise<ConversationPageCacheChunk | null> {
    throwIfSessionReadAborted(options.signal);
    const operation = (async (): Promise<ConversationPageCacheChunk | null> => {
      const mainPath = await this.resolveSessionLocation(id, true);
      if (mainPath === null) return null;
      const topologyIdentity = this.verifiedLocationTopology(id);
      try {
        const before = await readStableSessionBundleBoundaryAtPath(
          this.sessionsDir,
          id,
          mainPath,
        );
        const chunk = await readPreparedConversationChunk(mainPath, before, {
          ...input,
          signal: options.signal,
        });
        const after = await readStableSessionBundleBoundaryAtPath(
          this.sessionsDir,
          id,
          mainPath,
        );
        this.assertLocationTopologyUnchanged(id, topologyIdentity);
        if (before !== after || chunk === null) {
          throw new ConversationPageCacheStaleError('Conversation history changed; request a fresh page');
        }
        return chunk;
      } catch (error: unknown) {
        if (error instanceof ConversationPageCacheStaleError) {
          throw new SessionReadError('data_changed', error.message);
        }
        throw error;
      }
    })();
    return raceSessionRead(operation, options);
  }

  /** Stable read-only main + sidecar snapshot with no lock or migration writes. */
  async readFullSnapshot(
    id: string,
    options: SessionReadOptions = {},
  ): Promise<SessionReadSnapshot | null> {
    throwIfSessionReadAborted(options.signal);
    const operation = (async (): Promise<SessionReadSnapshot | null> => {
      const mainPath = await this.resolveSessionLocation(id, true);
      if (mainPath === null) return null;
      return this.readFullSnapshotAtPath(id, mainPath, options.signal, false);
    })();
    return raceSessionRead(operation, options);
  }

  private async readFullSnapshotAtPath(
    id: string,
    mainPath: string,
    signal: AbortSignal | undefined,
    allowActiveWriter: boolean,
  ): Promise<SessionReadSnapshot | null> {
    const topologyIdentity = this.verifiedLocationTopology(id);
    const bundle = await readStableSessionBundleAtPath(
      this.sessionsDir,
      id,
      mainPath,
      signal,
      allowActiveWriter,
    );
      const main = bundle.files.find((file) => file.kind === 'main');
      if (main === undefined) {
        throw new SessionReadError(
          'data_changed',
          'Session main file moved during the read boundary',
        );
      }
      const persisted = await readPersistedSessionFile(
        main.path,
        true,
        main.bytes.toString('utf8'),
      );
      if (persisted === null) return null;
      const resolved = buildSessionData(persisted, main.path);
      const directory = path.dirname(main.path);
      const sidecars = new Map<string, string | null>([
        [path.join(directory, `${id}.islands.jsonl`), null],
        [path.join(directory, `${id}.archive.jsonl`), null],
      ]);
      for (const file of bundle.files) {
        if (file.kind !== 'main') sidecars.set(file.path, file.bytes.toString('utf8'));
      }
      const archivedEntries = await this.readArchivedEntries(
        id,
        main.path,
        true,
        sidecars,
      );
      const completeEntries = mergeFullLineageEntries(
        archivedEntries,
        resolved.data.lineage?.entries ?? [],
      );
      const lineage: KodaXSessionLineage | null = resolved.data.lineage === undefined
        ? completeEntries.length === 0
          ? null
          : { version: 2, activeEntryId: null, entries: completeEntries }
        : { ...resolved.data.lineage, entries: completeEntries };
      if (!allowActiveWriter) {
        this.assertLocationTopologyUnchanged(id, topologyIdentity);
      }
    return {
      data: structuredClone(resolved.data),
      lineage,
      sourceRevision: bundle.sourceRevision,
      sourceRevisionState: bundle.sourceRevisionState,
      boundaryRevision: bundle.boundaryRevision,
    };
  }

  async load(id: string): Promise<SessionData | null> {
    const resolved = await this.readSession(id);
    if (!resolved) {
      return null;
    }

    // Initialize append watermark so subsequent appendSessionDelta calls
    // don't need to fallback to full rewrite.
    this.syncAppendState(
      id,
      resolved.data,
      {
        filePath: resolved.filePath,
        mainIdentity: resolved.mainIdentity,
      },
      resolved.activeMessageCount,
    );

    const { data } = resolved;
    // Label only — used by the no-op `warnMalformedSessionData(filePath, 0)`
    // call below (count 0 returns early). The actual file was already located
    // by `readSession` via the id-only locator.
    const filePath = this.legacyFlatPath(id);

    // v0.7.46 F7 — Workspace-mismatch warning is gated on the explicit
    // `emitMismatchWarnings` flag (default off) rather than the original
    // `!this.hostCwd` gate, which silently fired for any SDK consumer
    // that didn't set cwd (e.g. KodaX Space) — bleeding yellow stderr
    // noise into their UI output channel on every cross-project load.
    // When the flag is off, skip the runtime/git resolution entirely so
    // the common SDK case is also cheap. CLI surfaces that want the
    // legacy warning can opt-in via `new FileSessionStorage({ emitMismatchWarnings: true })`.
    if (this.emitMismatchWarnings) {
      const currentGitRoot = await getGitRoot(this.hostCwd);
      const currentRuntime = await inspectWorkspaceRuntime({ cwd: this.hostCwd });
      const sessionRuntime = resolveSessionRuntimeInfo(data);
      const canonicalMismatch =
        currentRuntime.canonicalRepoRoot
        && sessionRuntime?.canonicalRepoRoot
        && !isSameCanonicalRepo(currentRuntime, sessionRuntime);
      const shouldEmitMismatchWarning = Boolean(canonicalMismatch || (
        currentGitRoot && data.gitRoot && currentGitRoot !== data.gitRoot && !isSameCanonicalRepo(
          currentRuntime,
          { canonicalRepoRoot: data.gitRoot },
        )
      ));
      if (shouldEmitMismatchWarning) {
        writeStorageNotice(chalk.yellow('\n[Warning] Session project mismatch:'));
        if (currentRuntime.workspaceRoot) {
          writeStorageNotice(`  Current workspace:  ${currentRuntime.workspaceRoot}`);
        }
        if (sessionRuntime?.workspaceRoot) {
          writeStorageNotice(`  Session workspace:  ${sessionRuntime.workspaceRoot}`);
        }
        if (currentRuntime.canonicalRepoRoot) {
          writeStorageNotice(`  Current repo:      ${currentRuntime.canonicalRepoRoot}`);
        }
        if (sessionRuntime?.canonicalRepoRoot) {
          writeStorageNotice(`  Session repo:      ${sessionRuntime.canonicalRepoRoot}`);
        } else if (data.gitRoot) {
          writeStorageNotice(`  Session repo:      ${data.gitRoot}`);
        }
        writeStorageNotice('  Continuing anyway...\n');
      }
    }

    if (data.errorMetadata?.consecutiveErrors && data.errorMetadata.consecutiveErrors > 0) {
      let current: SessionData | null = data;
      let recovered = false;
      await this.serializedWrite(id, async () => {
        const latest = await this.readSession(id);
        if (!latest) {
          current = null;
          return;
        }
        current = latest.data;
        const actorSnapshot = latest.data.actorSnapshot;
        if (
          (actorSnapshot?.schemaVersion === 2 && actorSnapshot.owner !== undefined)
          || actorSnapshot?.turns.some(
            (turn) => turn.state === 'accepted' || turn.state === 'running',
          )
        ) {
          this.syncAppendState(id, latest.data, {
            filePath: latest.filePath,
            mainIdentity: latest.mainIdentity,
          });
          return;
        }
        if (
          !latest.data.errorMetadata?.consecutiveErrors
          || latest.data.errorMetadata.consecutiveErrors <= 0
        ) {
          this.syncAppendState(id, latest.data, {
            filePath: latest.filePath,
            mainIdentity: latest.mainIdentity,
          });
          return;
        }
        const cleaned = cleanupIncompleteToolCalls(latest.data.messages);
        if (cleaned === latest.data.messages) {
          this.syncAppendState(id, latest.data, {
            filePath: latest.filePath,
            mainIdentity: latest.mainIdentity,
          });
          return;
        }
        const next: SessionData = {
          ...latest.data,
          messages: cleaned,
          errorMetadata: {
            ...latest.data.errorMetadata,
            consecutiveErrors: 0,
          },
          lineage: createSessionLineage(cleaned, latest.data.lineage),
        };
        const completeLineage = await this.completeConversationLineage(
          id,
          latest.filePath,
          next.lineage!,
        );
        const targetPath = await this.writeSessionInternal(
          id,
          next,
          latest.createdAt,
          latest.filePath,
          undefined,
          completeLineage,
        );
        await this.syncAppendStateFromFile(id, next, targetPath);
        current = next;
        recovered = true;
      });
      if (recovered) {
        writeStorageNotice(chalk.cyan(
          '[Session Recovery] Cleaned incomplete tool calls from previous session',
        ));
      }
      return current;
    }

    warnMalformedSessionData(filePath, 0);
    return data;
  }

  async has(id: string): Promise<boolean> {
    try {
      await this.ensureMigrated();
      return await this.resolveSessionLocation(id) !== null;
    } catch (error: unknown) {
      reportStorageDiagnostic('warn', `Unable to locate Session ${id}.`, error);
      return false;
    }
  }

  async isArchived(id: string): Promise<boolean> {
    await this.ensureMigrated();
    const filePath = await this.resolveSessionLocation(id);
    return filePath !== null && path.basename(path.dirname(filePath)) === 'archived';
  }

  async getLineage(id: string): Promise<KodaXSessionLineage | null> {
    const resolved = await this.readSession(id);
    return resolved?.data.lineage ?? null;
  }

  async loadFullLineage(id: string): Promise<KodaXSessionLineage | null> {
    await this.ensureMigrated();
    return withKodaXFileLock(
      this.sessionWriteLockPath(id),
      async () => {
        const resolved = await this.readSession(id);
        if (!resolved?.data.lineage) return null;
        const archivedEntries = await this.readArchivedEntries(id, resolved.filePath);
        if (archivedEntries.length === 0) return resolved.data.lineage;
        return {
          ...resolved.data.lineage,
          entries: mergeFullLineageEntries(archivedEntries, resolved.data.lineage.entries),
        };
      },
      SESSION_WRITE_LOCK_TIMEOUT_MS,
    );
  }

  async setActiveEntry(
    id: string,
    selector: string,
    options?: { summarizeCurrentBranch?: boolean },
  ): Promise<SessionData | null> {
    let result: SessionData | null = null;
    await withPendingEpisodeReviewSessionFence(
      { configHome: this.configHome, sessionId: id },
      async (fence) => this.serializedWrite(id, async () => {
        const resolved = await this.readSession(id);
        if (!resolved?.data.lineage) return;

        const lineage = setSessionLineageActiveEntry(
          resolved.data.lineage,
          selector,
          options,
        );
        if (!lineage) return;
        await fence(getActiveMemoryOutcomeReviewIds(lineage));

        const nextData: SessionData = {
          ...resolved.data,
          messages: getSessionMessagesFromLineage(lineage),
          lineage,
        };
        const completeLineage = await this.completeConversationLineage(
          id,
          resolved.filePath,
          lineage,
        );
        const targetPath = await this.writeSessionInternal(
          id,
          nextData,
          resolved.createdAt,
          resolved.filePath,
          undefined,
          completeLineage,
        );
        await this.syncAppendStateFromFile(id, nextData, targetPath);
        result = nextData;
      }),
    );
    return result;
  }

  async rewind(
    id: string,
    selector?: string,
    options?: { historyBoundary?: SessionHistoryBoundary },
  ): Promise<SessionData | null> {
    let result: SessionData | null = null;
    await withPendingEpisodeReviewSessionFence(
      { configHome: this.configHome, sessionId: id },
      async (fence) => this.serializedWrite(id, async () => {
        const resolved = await this.readSession(id);
        if (!resolved?.data.lineage) return;
        const historyBoundary = options?.historyBoundary;
        const captured = historyBoundary === undefined
          ? undefined
          : await this.readFullSnapshotAtPath(id, resolved.filePath, undefined, true);
        if (
          captured !== undefined
          && captured?.sourceRevision !== historyBoundary?.sourceRevision
        ) {
          throw new SessionReadError(
            'data_changed',
            `Conversation history boundary is stale for ${id}`,
          );
        }
        const sourceLineage = captured?.lineage ?? resolved.data.lineage;
        if (sourceLineage === null) return;
        const targetId = selector ?? findPreviousUserEntryId(sourceLineage);
        if (!targetId) return;
        const boundaryPath = captured === undefined
          ? undefined
          : completeLineageBoundaryPath(sourceLineage, targetId);
        if (captured !== undefined && boundaryPath === undefined) return;
        const rewindSource = boundaryPath === undefined
          ? sourceLineage
          : {
              version: 2 as const,
              activeEntryId: targetId,
              entries: boundaryPath,
            };
        const rewound = rewindSessionLineage(rewindSource, targetId);
        if (!rewound) return;
        const rewindMarker = rewound.entries.at(-1);
        if (rewindMarker?.type !== 'rewind_marker') return;
        const sourceTargetIndex = sourceLineage.entries.findIndex(
          (entry) => entry.id === targetId,
        );
        if (sourceTargetIndex < 0) return;
        const { fromId: _syntheticFromId, ...rewindMarkerBase } = rewindMarker;
        const correctedRewindMarker = {
          ...rewindMarkerBase,
          ...(sourceLineage.activeEntryId !== null
            ? { fromId: sourceLineage.activeEntryId }
            : {}),
          truncatedCount: sourceLineage.entries.length - sourceTargetIndex - 1,
        };
        const lineage: KodaXSessionLineage = {
          ...rewound,
          entries: [...rewound.entries.slice(0, -1), correctedRewindMarker],
        };
        await fence(getActiveMemoryOutcomeReviewIds(lineage));

        const archivedEntries = await this.readArchivedEntries(id, resolved.filePath);
        const fullEntriesBeforeRewind = captured?.lineage?.entries
          ?? (archivedEntries.length === 0
            ? resolved.data.lineage.entries
            : mergeFullLineageEntries(archivedEntries, resolved.data.lineage.entries));
        const retainedIds = new Set(lineage.entries.map((entry) => entry.id));
        const removedEntries = resolved.data.lineage.entries.filter(
          (entry) => !retainedIds.has(entry.id),
        );
        const nextData: SessionData = {
          ...resolved.data,
          messages: getSessionMessagesFromLineage(lineage),
          lineage,
        };
        await this.appendIslandArchive(
          id,
          nextData,
          removedEntries,
          correctedRewindMarker.id,
          [...fullEntriesBeforeRewind, correctedRewindMarker],
          resolved.filePath,
        );
        const completeLineage = await this.completeConversationLineage(
          id,
          resolved.filePath,
          lineage,
        );
        const targetPath = await this.writeSessionInternal(
          id,
          nextData,
          resolved.createdAt,
          resolved.filePath,
          undefined,
          completeLineage,
        );
        await this.syncAppendStateFromFile(id, nextData, targetPath);
        result = nextData;
      }),
    );
    return result;
  }

  async setLabel(id: string, selector: string, label?: string): Promise<SessionData | null> {
    let result: SessionData | null = null;
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved?.data.lineage) return;

      const lineage = appendSessionLineageLabel(resolved.data.lineage, selector, label);
      if (!lineage) return;

      const nextData: SessionData = {
        ...resolved.data,
        lineage,
      };
      const completeLineage = await this.completeConversationLineage(
        id,
        resolved.filePath,
        lineage,
      );
      const targetPath = await this.writeSessionInternal(
        id,
        nextData,
        resolved.createdAt,
        resolved.filePath,
        undefined,
        completeLineage,
      );
      await this.syncAppendStateFromFile(id, nextData, targetPath);
      result = nextData;
    });
    return result;
  }

  async fork(
    id: string,
    selector?: string,
    options?: {
      sessionId?: string;
      title?: string;
      historyBoundary?: SessionHistoryBoundary;
    },
  ): Promise<{ sessionId: string; data: SessionData } | null> {
    let result: { sessionId: string; data: SessionData } | null = null;
    // Serialize on the SOURCE session (the one being read)
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved?.data.lineage) return;
      const historyBoundary = options?.historyBoundary;
      const captured = historyBoundary === undefined
        ? undefined
        : await this.readFullSnapshotAtPath(id, resolved.filePath, undefined, true);
      if (
        captured !== undefined
        && captured?.sourceRevision !== historyBoundary?.sourceRevision
      ) {
        throw new SessionReadError(
          'data_changed',
          `Conversation history boundary is stale for ${id}`,
        );
      }
      if (historyBoundary !== undefined && captured === null) return;
      const sourceLineage = captured?.lineage ?? resolved.data.lineage;
      if (sourceLineage === null) return;
      if (
        captured !== undefined
        && (
          selector === undefined
          || completeLineageBoundaryPath(sourceLineage, selector) === undefined
        )
      ) {
        return;
      }
      const projectionStartedAt = Date.now();
      const lineage = captured === undefined
        ? forkSessionLineage(sourceLineage, selector)
        : captured === null
          ? null
          : forkSessionConversationLineage(
              sourceLineage,
              selector!,
              captured.sourceRevision,
              () => assertSessionReadBudget({}, projectionStartedAt),
            );
      if (!lineage) return;

      const sessionId = options?.sessionId ?? await generateSessionId();
      const forked: SessionData = {
        messages: getSessionMessagesFromLineage(lineage),
        title: options?.title ?? resolved.data.title,
        gitRoot: resolved.data.gitRoot,
        tag: resolved.data.tag,
        // FEATURE_247 (R5) — inherit runtime identity (workspace + profile /
        // provider / model / permission mode) so a forked Partner session stays
        // a Partner. Previously runtimeInfo was dropped entirely on fork.
        runtimeInfo: resolved.data.runtimeInfo
          ? { ...resolved.data.runtimeInfo }
          : undefined,
        uiHistory: resolved.data.uiHistory
          ? resolved.data.uiHistory.map((item) => ({ ...item }))
          : undefined,
        extensionState: resolved.data.extensionState
          ? structuredClone(resolved.data.extensionState)
          : undefined,
        artifactLedger: resolved.data.artifactLedger
          ? structuredClone(resolved.data.artifactLedger)
          : undefined,
        extensionRecords: resolved.data.extensionRecords
          ? structuredClone(resolved.data.extensionRecords)
          : undefined,
        lineage,
      };
      // Fork writes to a NEW session id — serialize on that id too
      await this.writeSessionInternal(
        sessionId,
        forked,
        undefined,
        undefined,
        undefined,
        lineage,
      );
      result = { sessionId, data: forked };
    });
    return result;
  }

  /**
   * v0.7.46 — `opts.limit` added so SDK consumers can request more than
   * the legacy 10-entry cap. Default stays at 10 to preserve the
   * interactive REPL picker's behavior. The `public-api.ts` fast path
   * forwards the caller's `limit`; `deleteAll()` passes a large value
   * so it can enumerate ALL sessions for the gitRoot.
   *
   * v0.7.46 — return now carries `createdAt` so the fast path in
   * `public-api.ts` no longer silently strips it. Pre-v0.7.46 callers
   * that only destructured `{id, title, msgCount, runtimeInfo}` are
   * unaffected (extra fields are ignored).
   */
  async list(
    gitRoot?: string,
    opts?: { limit?: number; includeArchived?: boolean },
  ): Promise<Array<{
    id: string;
    title: string;
    msgCount: number;
    tag?: string;
    runtimeInfo?: KodaXSessionRuntimeInfo;
    archived?: boolean;
    createdAt?: string;
  }>> {
    await this.ensureMigrated();
    await fs.mkdir(this.sessionsDir, { recursive: true });
    // v0.7.46 fix — only auto-resolve gitRoot when the caller has
    // signaled project intent (explicit `gitRoot` arg OR `hostCwd`
    // on the FileSessionStorage instance). Previously this fell
    // through to `getGitRoot(undefined)` → `git rev-parse` in the
    // host process's `process.cwd()`, which is the SDK consumer's
    // startup directory (NOT the project the user opened) for
    // in-process embedders like KodaX Space. Result: the
    // per-project filter at line 1237 (`currentGitRoot ? [currentProjectKey]
    // : <all dirs>`) silently selected the wrong project,
    // and the user saw an empty session list. With no project
    // intent supplied, `currentGitRoot` stays null → the
    // per-project loop scans all project dirs (the "show me
    // everything" behavior the slow path provides).
    const requestedGitRoot = gitRoot && gitRoot.trim() ? gitRoot : undefined;
    const hasProjectIntent = requestedGitRoot !== undefined || this.hostCwd !== undefined;
    const currentGitRoot =
      requestedGitRoot ?? (this.hostCwd ? await getGitRoot(this.hostCwd) : null);
    const currentRuntime = hasProjectIntent
      ? await inspectWorkspaceRuntime({
          cwd: currentGitRoot ?? this.hostCwd ?? process.cwd(),
        })
      : undefined;
    // FEATURE_219 — candidate files come from the CURRENT project's directory
    // (O(sessions-in-project), the whole point of the per-project layout) plus
    // the legacy flat pool (compat until auto-migration empties it). When there
    // is no resolvable project root (rootless `kodax -c`), fall back to scanning
    // every project dir so the "show me everything" behavior is preserved.
    // Exclude `.archive.jsonl` island sidecars and the `archived/` subdir.
    const locationBoundary = hasProjectIntent
      ? undefined
      : this.beginSessionLocationTraversal();
    const topEntries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    // A directory manifest authenticates the bucket, not every later file.
    // Project-scoped reads still validate each metadata identity they already
    // open so an out-of-band or legacy misplaced file cannot cross projects.
    const candidatePaths: Array<{ path: string; archived: boolean }> = [];
    const indexedResumeEntries = new Map<string, ResumeIndexEntry>();
    const locatedPaths: string[] = [];
    const currentProjectIdentity = currentRuntime === undefined
      ? undefined
      : deriveProjectKeyFromData({
          gitRoot: currentGitRoot ?? undefined,
          runtimeInfo: currentRuntime,
        });
    const currentProjectKey = currentProjectIdentity?.key;
    const isSidecar = (f: string): boolean => f.endsWith('.archive.jsonl') || f.endsWith('.islands.jsonl');
    const projectDirNames = currentProjectKey !== undefined
      ? [currentProjectKey]
      : topEntries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    let locationTraversalComplete = !hasProjectIntent;
    const readDirectory = async (directory: string): Promise<{
      readonly files: readonly string[];
      readonly complete: boolean;
    }> => {
      try {
        return { files: await fs.readdir(directory), complete: true };
      } catch (error: unknown) {
        return {
          files: [],
          complete: (error as NodeJS.ErrnoException).code === 'ENOENT',
        };
      }
    };
    const LIST_DIRECTORY_CONCURRENCY = 48;
    for (let offset = 0; offset < projectDirNames.length; offset += LIST_DIRECTORY_CONCURRENCY) {
      const projectFiles = await Promise.all(
        projectDirNames.slice(offset, offset + LIST_DIRECTORY_CONCURRENCY).map(async (key) => {
          const projectDir = this.projectDir(key);
          const [active, archived, resumeEntries] = await Promise.all([
            readDirectory(projectDir),
            readDirectory(path.join(projectDir, 'archived')),
            readResumeIndex(projectDir).catch((error: unknown) => {
              reportStorageDiagnostic('warn', `Unable to read the resume index in ${key}.`, error);
              return undefined;
            }),
          ]);
          return { projectDir, active, archived, resumeEntries };
        }),
      );
      for (const project of projectFiles) {
        const projectResumeById = new Map(
          project.resumeEntries?.map((entry) => [entry.id, entry] as const) ?? [],
        );
        if (!project.active.complete || !project.archived.complete) {
          locationTraversalComplete = false;
        }
        for (const file of project.active.files) {
          if (!file.endsWith('.jsonl') || isSidecar(file)) continue;
          const filePath = path.join(project.projectDir, file);
          locatedPaths.push(filePath);
          candidatePaths.push({ path: filePath, archived: false });
          const indexed = projectResumeById.get(path.basename(file, '.jsonl'));
          if (indexed !== undefined) indexedResumeEntries.set(filePath, indexed);
        }
        for (const file of project.archived.files) {
          if (!file.endsWith('.jsonl') || isSidecar(file)) continue;
          const filePath = path.join(project.projectDir, 'archived', file);
          locatedPaths.push(filePath);
          if (opts?.includeArchived) {
            candidatePaths.push({ path: filePath, archived: true });
          }
        }
      }
    }
    for (const e of topEntries) {
      if (
        e.isFile() &&
        e.name.endsWith('.jsonl') &&
        !isSidecar(e.name) &&
        !e.name.startsWith('archived-') &&
        !e.name.startsWith('.') // skip control files like .migration-journal.jsonl
      ) {
        const filePath = path.join(this.sessionsDir, e.name);
        locatedPaths.push(filePath);
        candidatePaths.push({ path: filePath, archived: false });
      }
    }

    if (locationBoundary === undefined) {
      this.indexSessionLocations(locatedPaths, false);
    } else {
      this.completeSessionLocationTraversal(
        locationBoundary,
        locatedPaths,
        locationTraversalComplete,
      );
    }

    const sessions: Array<{
      id: string;
      title: string;
      msgCount: number;
      tag?: string;
      createdAt?: string;
      archived?: boolean;
      runtimeInfo?: KodaXSessionRuntimeInfo;
    }> = [];

    type SessionEntry = (typeof sessions)[number];
    const parseSessionFile = async (filePath: string, archived: boolean): Promise<SessionEntry | null> => {
      try {
        const firstLine = await readSessionFirstLine(filePath);
        if (!firstLine) {
          return null;
        }

        const first = JSON.parse(firstLine);
        if (isRecord(first) && first._type === 'meta') {
          const sessionGitRoot = typeof first.gitRoot === 'string' ? first.gitRoot : '';
          const sessionRuntime = isKodaXSessionRuntimeInfo(first.runtimeInfo)
            ? first.runtimeInfo
            : undefined;
          const scope: KodaXSessionScope = first.scope === 'managed-task-worker'
            ? 'managed-task-worker'
            : 'user';
          if (currentRuntime !== undefined && currentProjectKey !== undefined) {
            const sameProject = sessionProjectMatchesAnyRoot({
              gitRoot: sessionGitRoot || undefined,
              runtimeInfo: sessionRuntime,
            }, [
              currentRuntime.canonicalRepoRoot,
              currentRuntime.workspaceRoot,
              currentRuntime.executionCwd,
              currentGitRoot,
            ].filter((root): root is string => typeof root === 'string' && root.length > 0));
            if (!sameProject) return null;
          }
          if (scope !== 'user') {
            return null;
          }

          const extensionRecordCount =
            typeof first.extensionRecordCount === 'number' && first.extensionRecordCount > 0
              ? first.extensionRecordCount
              : 0;
          // `activeMessageCount` (present on modern meta records) lets us avoid
          // reading the whole file. Only legacy meta records without it need a
          // full line count — rare, and these tend to be small/old sessions.
          const activeMessageCount =
            typeof first.activeMessageCount === 'number' && first.activeMessageCount >= 0
              ? first.activeMessageCount
              : Math.max(0, (await countSessionLines(filePath)) - 1 - extensionRecordCount);
          const indexedResume = archived ? undefined : indexedResumeEntries.get(filePath);
          let resumeItemCount = indexedResume?.msgCount
            ?? countResumableSessionItems(activeMessageCount, first.uiHistory);
          if (!archived && indexedResume === undefined && resumeItemCount === 0) {
            // Prepared tails are append-only, so an originally empty Session
            // may gain its first canonical or presentation-only item in a
            // trailing meta_update. Keep the common non-empty head/index path
            // bounded; only empty candidates need the full compatibility read.
            const latest = await readPersistedSessionFile(filePath);
            const latestActiveMessageCount = latest?.meta?.activeMessageCount;
            resumeItemCount = countResumableSessionItems(
              typeof latestActiveMessageCount === 'number' ? latestActiveMessageCount : 0,
              latest?.meta?.uiHistory,
            );
          }
          return {
            id: path.basename(filePath, '.jsonl'),
            title: indexedResume?.title ?? (typeof first.title === 'string' ? first.title : ''),
            msgCount: resumeItemCount,
            ...(typeof first.tag === 'string' ? { tag: first.tag } : {}),
            createdAt: typeof first.createdAt === 'string' ? first.createdAt : undefined,
            // v0.7.46 fix — fall back to `sessionGitRoot` when the meta
            // record predates the nested `runtimeInfo` field. Without
            // this, legacy meta records returned `runtimeInfo:
            // undefined` even though `gitRoot` was right there at the
            // top level — the in-process embedder bug Space reported.
            //
            // Wrapped as `{ canonicalRepoRoot }` (NOT `{ gitRoot }`)
            // because `KodaXSessionRuntimeInfo` uses canonicalRepoRoot
            // as the project-identity field — verified semantic match
            // in storage.ts:842 (`isSameCanonicalRepo(...,
            // { canonicalRepoRoot: data.gitRoot })`) and in
            // session/public-api.ts:234 where `extractRuntimeInfoSummary`
            // remaps `canonicalRepoRoot → gitRoot` on the consumer side.
            runtimeInfo: sessionRuntime
              ? { ...sessionRuntime }
              : sessionGitRoot
                ? { canonicalRepoRoot: sessionGitRoot }
                : undefined,
            ...(archived ? { archived: true } : {}),
          };
        }
        const lineCount = await countSessionLines(filePath);
        return {
          id: path.basename(filePath, '.jsonl'),
          title: '',
          msgCount: lineCount,
          ...(archived ? { archived: true } : {}),
        };
      } catch {
        return null;
      }
    };

    // Head-read every candidate concurrently (bounded so we never exhaust fds
    // on a large sessions dir). Project-dir paths are listed before flat paths,
    // so on a duplicate id (a session mid-migration) the project-dir copy wins.
    const LIST_READ_CONCURRENCY = 48;
    const seenIds = new Set<string>();
    for (let i = 0; i < candidatePaths.length; i += LIST_READ_CONCURRENCY) {
      const batch = await Promise.all(
        candidatePaths.slice(i, i + LIST_READ_CONCURRENCY).map((c) => parseSessionFile(c.path, c.archived)),
      );
      for (const entry of batch) {
        if (entry && !seenIds.has(entry.id)) {
          seenIds.add(entry.id);
          sessions.push(entry);
        }
      }
    }

    // v0.7.46 — `opts.limit` overrides the legacy 10-entry hard cap.
    // Default stays at 10 so the interactive REPL picker keeps its
    // existing behavior; SDK consumers pass an explicit limit.
    const limit = opts?.limit ?? 10;
    return sessions
      .sort((left, right) => {
        const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
        const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
          return rightTime - leftTime;
        }
        if (Number.isFinite(rightTime) && !Number.isFinite(leftTime)) {
          return 1;
        }
        if (Number.isFinite(leftTime) && !Number.isFinite(rightTime)) {
          return -1;
        }
        return right.id.localeCompare(left.id);
      })
      .slice(0, limit)
      // v0.7.46 — surface `createdAt` so the public-api fast path can
      // populate `SessionSummary.createdAt` instead of silently
      // emitting `undefined` (previously every fast-path summary had
      // createdAt=undefined → consumer UIs sorting by date got
      // random order).
      .map(({ id, title, msgCount, tag, runtimeInfo, createdAt, archived }) => ({
        id,
        title,
        msgCount,
        ...(tag !== undefined ? { tag } : {}),
        ...(runtimeInfo ? { runtimeInfo } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(archived ? { archived: true } : {}),
      }));
  }

  /**
   * FEATURE_219 Phase 4 — whole-session archive (ADR-038 §4). Moves the session
   * file together with its island sidecar into `<projectKey>/archived/`. Paired
   * (never orphans the sidecar). No-op + returns false for a missing session.
   */
  async archive(id: string): Promise<boolean> {
    return this.archiveWithActorOwner(id);
  }

  async archiveOwned(id: string, ownerId: string): Promise<boolean> {
    return this.archiveWithActorOwner(id, ownerId);
  }

  private sessionConversationCacheMainPaths(id: string, mainPath: string): readonly string[] {
    const directory = path.dirname(mainPath);
    const counterpart = path.basename(directory) === 'archived'
      ? path.join(path.dirname(directory), `${id}.jsonl`)
      : path.join(directory, 'archived', `${id}.jsonl`);
    return [mainPath, counterpart, this.legacyFlatPath(id)];
  }

  private async removeSessionConversationCaches(id: string, mainPath: string): Promise<void> {
    const seen = new Set<string>();
    for (const candidate of this.sessionConversationCacheMainPaths(id, mainPath)) {
      const normalized = path.resolve(candidate);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      await removeConversationPageCache(candidate);
    }
  }

  private async removeResumeMembership(id: string, mainPath: string): Promise<void> {
    try {
      await commitResumeIndexEntry(
        resumeIndexProjectDir(mainPath),
        createResumeIndexEntry(id, '', 0),
        false,
      );
    } catch (error: unknown) {
      reportStorageDiagnostic('warn', `Unable to remove ${id} from the resume index.`, error);
    }
  }

  private async archiveWithActorOwner(
    id: string,
    expectedOwnerId?: string,
  ): Promise<boolean> {
    await this.ensureMigrated();
    // Serialized through the per-session write queue so a concurrent
    // appendSessionDelta / save can't write to a path we're moving.
    let result = false;
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved) return;
      this.assertActorFileOwner(resolved.data.actorSnapshot, expectedOwnerId);
      const dir = path.dirname(resolved.filePath);
      if (path.basename(dir) === 'archived') {
        for (const detached of this.sessionConversationCacheMainPaths(id, resolved.filePath).slice(1)) {
          await removeConversationPageCache(detached);
        }
        await this.removeResumeMembership(id, resolved.filePath);
        result = true; // already archived
        return;
      }
      const verifiedTopology = this.verifiedLocationTopology(id);
      const archivedDir = path.join(dir, 'archived');
      await this.removeSessionConversationCaches(id, resolved.filePath);
      await this.withSessionLocationTopologyChange(
        () => this.movePair(id, dir, archivedDir),
      );
      await this.removeResumeMembership(id, resolved.filePath);
      const currentTopology = this.readSessionTopologyIdentitySync(id);
      const globallyVerified = verifiedTopology !== undefined
        && currentTopology !== undefined;
      this.sessionLocations.set(id, {
        kind: 'located',
        filePath: path.join(archivedDir, `${id}.jsonl`),
        globallyVerified,
        ...(globallyVerified
          ? { topologyIdentity: currentTopology }
          : {}),
      });
      await this.rebuildConversationCache(
        id,
        path.join(archivedDir, `${id}.jsonl`),
        resolved.data.lineage ?? createSessionLineage(resolved.data.messages),
        resolved.data.runtimeInfo,
      );
      result = true;
    });
    return result;
  }

  /** Restore an archived session back into its project directory. */
  async unarchive(id: string): Promise<boolean> {
    return this.unarchiveWithActorOwner(id);
  }

  async unarchiveOwned(id: string, ownerId: string): Promise<boolean> {
    return this.unarchiveWithActorOwner(id, ownerId);
  }

  private async unarchiveWithActorOwner(
    id: string,
    expectedOwnerId?: string,
  ): Promise<boolean> {
    await this.ensureMigrated();
    let result = false;
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved) return;
      this.assertActorFileOwner(resolved.data.actorSnapshot, expectedOwnerId);
      const dir = path.dirname(resolved.filePath);
      if (path.basename(dir) !== 'archived') {
        for (const detached of this.sessionConversationCacheMainPaths(id, resolved.filePath).slice(1)) {
          await removeConversationPageCache(detached);
        }
        result = true; // not archived
        return;
      }
      const verifiedTopology = this.verifiedLocationTopology(id);
      const activeDir = path.dirname(dir);
      const activeMessageCount = resolved.data.lineage
        ? countActiveLineageMessages(resolved.data.lineage)
        : resolved.data.messages.length;
      const resumeItemCount = countResumableSessionItems(
        activeMessageCount,
        resolved.data.uiHistory,
      );
      const resumable = resolved.data.scope !== 'managed-task-worker'
        && resumeItemCount > 0;
      const resumeEntry = createResumeIndexEntry(
        id,
        resolved.data.title,
        resumeItemCount,
        resolved.createdAt,
        resolved.data.runtimeInfo?.surface,
      );
      if (resumable) {
        try {
          await prepareResumeIndexEntry(activeDir, resumeEntry);
        } catch (error: unknown) {
          reportStorageDiagnostic('warn', `Unable to prepare the resume index for ${id}.`, error);
        }
      }
      await this.removeSessionConversationCaches(id, resolved.filePath);
      await this.withSessionLocationTopologyChange(
        () => this.movePair(id, dir, activeDir),
      );
      try {
        await commitResumeIndexEntry(
          activeDir,
          resumeEntry,
          resumable,
        );
      } catch (error: unknown) {
        reportStorageDiagnostic('warn', `Unable to refresh the resume index for ${id}.`, error);
      }
      const currentTopology = this.readSessionTopologyIdentitySync(id);
      const globallyVerified = verifiedTopology !== undefined
        && currentTopology !== undefined;
      this.sessionLocations.set(id, {
        kind: 'located',
        filePath: path.join(activeDir, `${id}.jsonl`),
        globallyVerified,
        ...(globallyVerified
          ? { topologyIdentity: currentTopology }
          : {}),
      });
      await this.rebuildConversationCache(
        id,
        path.join(activeDir, `${id}.jsonl`),
        resolved.data.lineage ?? createSessionLineage(resolved.data.messages),
        resolved.data.runtimeInfo,
      );
      result = true;
    });
    return result;
  }

  /**
   * Move a session + modern and legacy island sidecars between two directories. Propagates a
   * non-ENOENT rename error (e.g. Windows file-in-use) so a partial move is
   * surfaced as a failure instead of silently splitting main + sidecar.
   */
  private async movePair(id: string, fromDir: string, toDir: string): Promise<void> {
    const reservedNames = [`${id}.jsonl`, `${id}.islands.jsonl`, `${id}.archive.jsonl`];
    for (const name of reservedNames) {
      if (fsSync.existsSync(path.join(toDir, name))) {
        throw new Error(`Refusing to overwrite existing Session archive file: ${name}`);
      }
    }
    await fs.mkdir(toDir, { recursive: true });
    const names = reservedNames.filter(
      (name) => fsSync.existsSync(path.join(fromDir, name)),
    );
    const moved: string[] = [];
    try {
      for (const name of names) {
        const src = path.join(fromDir, name);
        await fs.rename(src, path.join(toDir, name));
        moved.push(name);
      }
    } catch (error: unknown) {
      const rollbackErrors: unknown[] = [];
      for (const name of moved.reverse()) {
        try {
          await fs.rename(path.join(toDir, name), path.join(fromDir, name));
        } catch (rollbackError: unknown) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Session ${id} move failed and rollback was incomplete.`,
        );
      }
      throw error;
    }
  }

  /**
   * Remove a complete Session file set without exposing a partial failure.
   * Every canonical path is first renamed to an ignored tombstone. A staging
   * failure rolls all prior renames back; only after the full set is hidden do
   * we unlink tombstones. A locked tombstone is recoverable and no longer
   * represents a live Session, so cleanup failure is diagnostic rather than a
   * failed logical deletion.
   */
  private async removeFileSetAtomically(
    id: string,
    targets: readonly string[],
  ): Promise<number> {
    const staged: Array<{ readonly source: string; readonly tombstone: string }> = [];
    try {
      for (const source of [...new Set(targets)]) {
        const tombstone = `${source}.${process.pid}.${Date.now()}.${sessionTempSequence++}.deleting.tmp`;
        try {
          await fs.rename(source, tombstone);
          staged.push({ source, tombstone });
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    } catch (error: unknown) {
      const rollbackErrors: unknown[] = [];
      for (const entry of staged.reverse()) {
        try {
          await fs.rename(entry.tombstone, entry.source);
        } catch (rollbackError: unknown) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Session ${id} deletion failed and rollback was incomplete.`,
        );
      }
      throw error;
    }

    for (const entry of staged) {
      try {
        await fs.unlink(entry.tombstone);
      } catch (error: unknown) {
        reportStorageDiagnostic(
          'warn',
          `Session ${id} was deleted, but a recoverable tombstone could not be removed.`,
          error,
        );
      }
    }
    return staged.length;
  }

  private assertActorFileOwner(
    snapshot: AgentActorSnapshot | undefined,
    expectedOwnerId?: string,
  ): void {
    if (expectedOwnerId !== undefined) {
      if (
        snapshot?.schemaVersion !== 2
        || snapshot.owner?.ownerId !== expectedOwnerId
      ) {
        throw new AgentOwnerConflictError(
          snapshot?.schemaVersion === 2 ? snapshot.owner?.runtimeId : undefined,
          snapshot?.revision ?? 0,
          false,
        );
      }
      return;
    }
    if (snapshot?.schemaVersion === 2 && snapshot.owner) {
      throw new AgentOwnerConflictError(
        snapshot.owner.runtimeId,
        snapshot.revision,
        false,
      );
    }
    if (snapshot?.turns.some(
      (turn) => turn.state === 'accepted' || turn.state === 'running',
    )) {
      throw new AgentOwnerUnknownError(snapshot.revision);
    }
  }

  async delete(id: string): Promise<void> {
    return this.deleteWithActorOwner(id);
  }

  /** Strict deletion path for the Runtime that already owns the Actor tree. */
  async deleteOwned(id: string, ownerId: string): Promise<void> {
    if (ownerId.trim().length === 0) {
      throw new Error('Actor owner ID is required for owned Session deletion.');
    }
    return this.deleteWithActorOwner(id, ownerId);
  }

  private async deleteWithActorOwner(
    id: string,
    expectedOwnerId?: string,
  ): Promise<void> {
    await this.ensureMigrated();
    // Locate the session anywhere (project dir / archived / legacy flat), then
    // remove it together with its island sidecar (paired — never orphan a
    // sidecar, ADR-038 §4). Also sweep a legacy flat copy if one lingers.
    await this.serializedWrite(id, async () => {
      const resolved = await this.readSession(id);
      if (!resolved) return;
      this.assertActorFileOwner(resolved.data.actorSnapshot, expectedOwnerId);

      const located = resolved.filePath;
      const targets: string[] = [];
      const addTarget = (target: string): void => {
        if (!targets.includes(target)) targets.push(target);
      };
      addTarget(located.replace(/\.jsonl$/, '.archive.jsonl'));
      addTarget(located.replace(/\.jsonl$/, '.islands.jsonl'));
      addTarget(this.legacyFlatArchivePath(id));
      addTarget(this.legacyFlatPath(id));
      const earlierIndex = targets.indexOf(located);
      if (earlierIndex >= 0) targets.splice(earlierIndex, 1);
      targets.push(located);
      // Cache entries contain recoverable message bodies. Remove them before
      // hiding the canonical file set so a cleanup failure leaves the Session
      // attached and the whole operation safe to retry.
      await this.removeSessionConversationCaches(id, located);
      await this.withSessionLocationTopologyChange(
        () => this.removeFileSetAtomically(id, targets),
      );
      await this.removeResumeMembership(id, located);
      this.sessionLocations.delete(id);
    });
  }

  async deleteAll(gitRoot?: string): Promise<void> {
    // v0.7.46 fix — mirror list()'s revised gitRoot semantic. Only
    // auto-resolve when caller has signaled project intent (either
    // explicit gitRoot OR hostCwd on the storage instance). Otherwise
    // null → list() returns all projects' sessions → deleteAll wipes
    // everything. No production callers were found at v0.7.46; the
    // method is purely SDK surface.
    const currentGitRoot =
      gitRoot ?? (this.hostCwd ? await getGitRoot(this.hostCwd) : null);
    // v0.7.46 fix — bypass the legacy 10-entry cap so "delete all
    // sessions for this project" actually deletes ALL of them. Pre-fix
    // `deleteAll()` silently leaked any session beyond the 10 most
    // recent because it reused `list()`'s default cap.
    const sessions = await this.list(currentGitRoot ?? undefined, {
      limit: Number.MAX_SAFE_INTEGER,
    });
    for (const session of sessions) {
      await this.delete(session.id);
    }
  }

  /**
   * Auto-retention: delete a complete Session file set when its main file
   * mtime is older than `retentionDays`. Modeled on claudecode's
   * `cleanup.ts` (`unlinkIfOld`). Bounds the sessions directory so it never
   * accumulates unboundedly — which is what keeps `list()`'s head-read pass
   * fast (its cost scales with file COUNT, not size). A non-positive /
   * non-finite `retentionDays` disables cleanup (no-op). The sweep continues
   * after individual failures, then reports them together so cleanup is
   * observable and retryable. Durable Actor owners and non-terminal turns are
   * never eligible.
   * Returns the number of files removed.
   */
  async cleanupOldSessions(retentionDays: number): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return 0;
    }
    await this.ensureMigrated();
    let removed = 0;
    const failures: unknown[] = [];
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const unlinkSessionIfOld = async (filePath: string): Promise<void> => {
      const fileName = path.basename(filePath);
      if (
        !fileName.endsWith('.jsonl')
        || fileName.endsWith('.archive.jsonl')
        || fileName.endsWith('.islands.jsonl')
      ) {
        return;
      }
      const id = fileName.slice(0, -'.jsonl'.length);
      try {
        await this.serializedWrite(id, async () => {
          const stat = await fs.stat(filePath);
          if (stat.mtimeMs >= cutoffMs) return;
          const persisted = await readPersistedSessionFile(filePath);
          const actorSnapshot = persisted?.meta?.actorSnapshot;
          if (
            !persisted?.meta
            || (
              actorSnapshot !== undefined
              && (
                (actorSnapshot.schemaVersion === 2 && actorSnapshot.owner !== undefined)
                || actorSnapshot.turns.some(
                  (turn) => turn.state === 'accepted' || turn.state === 'running',
                )
              )
            )
          ) {
            return;
          }
          await this.removeSessionConversationCaches(id, filePath);
          removed += await this.withSessionLocationTopologyChange(
            () => this.removeFileSetAtomically(id, [
              filePath.replace(/\.jsonl$/, '.archive.jsonl'),
              filePath.replace(/\.jsonl$/, '.islands.jsonl'),
              filePath,
            ]),
          );
          this.sessionLocations.delete(id);
        });
      } catch (error: unknown) {
        failures.push(error);
      }
    };
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      // FEATURE_219 — sweep the flat pool (legacy), every project dir, and each
      // project's `archived/` subdir. One level of recursion is enough; the
      // layout is never deeper than `<key>/archived/<id>.jsonl`.
      const top = await fs.readdir(this.sessionsDir, { withFileTypes: true });
      for (const entry of top) {
        const entryPath = path.join(this.sessionsDir, entry.name);
        if (entry.isFile()) {
          await unlinkSessionIfOld(entryPath);
          continue;
        }
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue;
        }
        let inner: import('fs').Dirent[] = [];
        try {
          inner = await fs.readdir(entryPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of inner) {
          const childPath = path.join(entryPath, child.name);
          if (child.isFile()) {
            await unlinkSessionIfOld(childPath);
          } else if (child.isDirectory() && child.name === 'archived') {
            let archived: string[] = [];
            try {
              archived = await fs.readdir(childPath);
            } catch {
              continue;
            }
            for (const f of archived) {
              await unlinkSessionIfOld(path.join(childPath, f));
            }
          }
        }
      }
    } catch (error: unknown) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more Session retention cleanups failed.');
    }
    return removed;
  }
}
