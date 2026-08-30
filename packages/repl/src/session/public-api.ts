/**
 * FEATURE_173 Part B (v0.7.42) — Session Management Public SDK.
 *
 * Thin facades over FileSessionStorage + discoverInstances. All methods
 * NEVER throw — missing sessions return null, blocked operations return
 * an error envelope, missing directories return empty arrays / no-op
 * watchers.
 *
 * The `@kodax-ai/kodax/session` SDK subpath re-exports this module.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  createSessionLineage,
  discoverInstances,
  emitKodaXDiagnostic,
} from '@kodax-ai/agent';
import {
  maybeRunReferenceAwareToolOutputGc,
  resolveToolOutputDir,
} from '@kodax-ai/coding';
import type {
  KodaXJsonValue,
  KodaXMessage,
  KodaXSessionClientNoticeEntry,
  KodaXSessionEntry,
  KodaXSessionLineage,
  KodaXSessionRuntimeInfo,
  KodaXTaskResultMetadata,
} from '@kodax-ai/agent';

import {
  FileSessionStorage,
  SessionReadError,
  assertSessionReadBudget,
  readStableSessionBundleFiles,
  readSessionFirstLine,
  type SessionReadOptions,
  type SessionReadSnapshot,
} from '../interactive/storage.js';
export {
  type SessionReadErrorCode,
  type SessionReadOptions,
} from '../interactive/storage.js';
export { SessionReadError };
export { ConversationPageCacheCapacityError } from '../interactive/storage.js';
import { compactSession } from './compact-session.js';
export { compactSession } from './compact-session.js';
export type { CompactSessionOptions, CompactSessionResult } from './compact-session.js';
import {
  buildLineageUnavailableConversationHistory,
  buildSessionConversationHistory,
  type SessionConversationHistoryData,
} from './conversation-history.js';
export {
  createConversationEntryChain,
  createSessionConversationHistoryRevision,
  emptyConversationEntryChain,
  extendConversationEntryChain,
} from './conversation-history.js';
export type {
  SessionConversationHistoryData,
  SessionConversationHistoryEntry,
  SessionConversationHistoryIssue,
  SessionConversationHistoryIssueCode,
  SessionConversationHistoryStatus,
} from './conversation-history.js';
import {
  deriveProjectKeyFromRoot,
  sessionProjectMatchesAnyRoot,
} from '../interactive/project-key.js';
import { ensureLayoutMigrated } from '../interactive/session-migration.js';
import type { SessionData } from '../ui/utils/session-storage.js';
import { KODAX_SESSIONS_DIR } from '../common/utils.js';
import type { SessionSourceRevisionState } from './source-revision.js';
export type { SessionSourceRevisionState } from './source-revision.js';

/**
 * FEATURE_219 — collect candidate session file paths from the per-project
 * layout (flat legacy pool + every `<projectKey>/` dir, plus each project's
 * `archived/` subdir when requested). Returns absolute file paths. Excludes
 * island sidecars (`.archive.jsonl` / `.islands.jsonl`).
 */
async function collectSessionFilePaths(
  sessionsDir: string,
  includeArchived: boolean,
): Promise<{ readonly paths: string[]; readonly complete: boolean }> {
  const out: string[] = [];
  let complete = true;
  const isSession = (name: string): boolean =>
    name.endsWith('.jsonl')
    && !name.endsWith('.archive.jsonl')
    && !name.endsWith('.islands.jsonl')
    && !name.startsWith('.'); // skip control files (.migration-journal.jsonl)
  let top: import('node:fs').Dirent[] = [];
  try {
    top = await fsPromises.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return { paths: out, complete: false };
  }
  for (const entry of top) {
    if (entry.isFile()) {
      if (isSession(entry.name) && (includeArchived || !entry.name.startsWith('archived-'))) {
        out.push(path.join(sessionsDir, entry.name));
      }
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const dir = path.join(sessionsDir, entry.name);
    try {
      for (const f of await fsPromises.readdir(dir)) {
        if (isSession(f)) {
          out.push(path.join(dir, f));
        }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
      // unreadable project dir — skip
    }
    if (includeArchived) {
      const archivedDir = path.join(dir, 'archived');
      try {
        for (const f of await fsPromises.readdir(archivedDir)) {
          if (isSession(f)) {
            out.push(path.join(archivedDir, f));
          }
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
        // no archived subdir — fine
      }
    }
  }
  return { paths: out, complete };
}

function sessionMatchesProjectRoot(
  summaryRuntime: { workspaceRoot?: string; gitRoot?: string } | undefined,
  metaGitRoot: string | undefined,
  projectRoot: string | undefined,
): boolean {
  if (!projectRoot?.trim()) return true;
  return sessionProjectMatchesAnyRoot({
    ...(metaGitRoot === undefined ? {} : { gitRoot: metaGitRoot }),
    ...(summaryRuntime === undefined ? {} : {
      runtimeInfo: {
        ...(summaryRuntime.gitRoot === undefined ? {} : {
          canonicalRepoRoot: summaryRuntime.gitRoot,
        }),
        ...(summaryRuntime.workspaceRoot === undefined ? {} : {
          workspaceRoot: summaryRuntime.workspaceRoot,
        }),
      },
    }),
  }, [projectRoot]);
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface SessionSummary {
  readonly id: string;
  /** Opaque continuation token; pass the last item cursor back to listSessions(). */
  readonly cursor?: string;
  readonly title: string;
  readonly msgCount: number;
  readonly tag?: string;
  readonly createdAt?: string;
  // FEATURE_247 (R5): surface + profileId are projected onto the list summary
  // so an embedder can filter a Partner session from a Coder session without a
  // full loadSession(). provider/model/etc. stay on the full-load runtimeInfo.
  readonly runtimeInfo?: {
    workspaceRoot?: string;
    gitRoot?: string;
    surface?: string;
    profileId?: string;
  };
  /**
   * FEATURE_219 (v0.7.46) — the per-project directory key this session lives
   * under (ADR-038 §7). A backward-compatible hint: consumers may pass it back
   * for precise disambiguation, but `loadSession(id)` works without it.
   */
  readonly projectKey?: string;
  /** FEATURE_219 — true when the session is whole-session archived (only ever
   * surfaced when `includeArchived` is set). */
  readonly archived?: boolean;
}

export type SessionTranscriptEntryType =
  | 'message'
  | 'compaction'
  | 'branch_summary'
  /** Rewind audit marker; not included in `FullTranscriptSessionData.messages`. */
  | 'rewind_marker'
  | 'client_notice'
  /**
   * Synthetic task/workflow completion entry derived from `_taskResult`,
   * `_taskResults`, or legacy `<task-completed>` banners. The original
   * `KodaXMessage` is still exposed on `message`, but consumers that want a
   * complete transcript should not filter only `type === 'message'`.
   */
  | 'task_result';

export type SessionTranscriptEntrySource =
  | 'user'
  | 'assistant'
  | 'workflow'
  | 'child_task'
  | 'system'
  | 'client';

export interface SessionTranscriptEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  /** Stable logical identity shared by cloned/forked copies of the same entry. */
  readonly logicalId: string;
  /** Direct physical predecessor entry id when this transcript entry was cloned/forked. */
  readonly sourceEntryId?: string;
  readonly timestamp: string;
  readonly type: SessionTranscriptEntryType;
  readonly source?: SessionTranscriptEntrySource;
  readonly turnId?: string;
  readonly message: KodaXMessage;
  readonly active: boolean;
  readonly summary?: string;
  readonly payload?: unknown;
  readonly taskResults?: readonly KodaXTaskResultMetadata[];
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(entryPath);
    }
  }
  return files;
}

async function collectToolOutputReferences(
  sessionsDir: string,
  outputDir: string,
): Promise<ReadonlySet<string>> {
  let artifactNames: Set<string>;
  try {
    artifactNames = new Set(await fsPromises.readdir(outputDir));
  } catch {
    return new Set();
  }
  const referenced = new Set<string>();
  const collectNames = (content: string): void => {
    for (const match of content.matchAll(/[a-zA-Z0-9._-]+\.txt/g)) {
      const name = match[0];
      if (artifactNames.has(name)) referenced.add(path.join(outputDir, name));
    }
  };
  for (const sessionFile of await collectJsonlFiles(sessionsDir)) {
    let content: string;
    try {
      content = await fsPromises.readFile(sessionFile, 'utf-8');
    } catch {
      continue;
    }
    collectNames(content);
  }
  for (const manifestPath of [...referenced].filter((filePath) => (
    path.basename(filePath).includes('-bash-recovery-manifest-')
  ))) {
    try {
      collectNames(await fsPromises.readFile(manifestPath, 'utf-8'));
    } catch {
      // A missing/unreadable manifest is still retained by its session reference.
    }
  }
  return referenced;
}

function scheduleToolOutputRetention(sessionsDir: string): void {
  const outputDir = resolveToolOutputDir();
  const timer = setTimeout(() => {
    void maybeRunReferenceAwareToolOutputGc(
      outputDir,
      () => collectToolOutputReferences(sessionsDir, outputDir),
    );
  }, 30_000);
  timer.unref();
}

export interface FullTranscriptSessionData extends Omit<SessionData, 'messages'> {
  /** Legacy flattened projection. Rewind markers are excluded. */
  readonly messages: KodaXMessage[];
  /** Messages on the active branch that are eligible for model context. */
  readonly activeMessages: KodaXMessage[];
  /**
   * Authoritative raw append-order audit entries, including archived islands
   * and inactive branches. The host owns visibility, folding, and presentation.
   */
  readonly transcriptEntries: SessionTranscriptEntry[];
}

/** One immutable storage boundary shared by Runtime admission and history. */
export interface SessionReadCapture {
  readonly data: SessionData;
  readonly transcript: FullTranscriptSessionData;
  readonly sourceRevision: string;
  /** Internal exact-revision witness used to extend prepared page caches. */
  readonly sourceRevisionState: SessionSourceRevisionState;
  /** Bounded persisted-file witness corresponding to sourceRevision. */
  readonly boundaryRevision: string;
}

export type SessionBundleExportStatus =
  | 'ok'
  | 'partial'
  | 'unsupported'
  | 'corrupt'
  | 'ambiguous'
  | 'missing';

export interface SessionBundleExportFile {
  readonly kind: 'main' | 'islands' | 'legacy_archive';
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly modifiedAt: string;
  /** Best-effort UTF-8 projection for inspection and JSONL diagnostics. */
  readonly content: string;
  /** Canonical byte-preserving representation. */
  readonly contentBase64: string;
}

export interface SessionBundleExportDiagnostic {
  readonly code:
    | 'partial_tail'
    | 'malformed_record'
    | 'unsupported_record'
    | 'unsupported_version';
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface SessionBundleExportResult {
  readonly sessionId: string;
  readonly status: SessionBundleExportStatus;
  readonly files: readonly SessionBundleExportFile[];
  readonly candidates?: readonly string[];
  readonly diagnostics: readonly SessionBundleExportDiagnostic[];
}

export interface SessionBundleExportOptions extends SessionReadOptions {
  readonly sessionsDir?: string;
}

export interface AppendClientNoticeOptions {
  readonly source?: string;
  readonly content: string;
  readonly timestamp?: string;
  readonly turnId?: string;
  readonly payload?: KodaXJsonValue;
}

export interface ListSessionsOptions {
  /**
   * Alias for gitRoot; backwards-compat with KodaX Space terminology.
   * When provided, list() is scoped to sessions from this project root.
   */
  readonly projectRoot?: string;
  /**
   * Which session scopes to include.
   * - 'user' (default): only user-initiated sessions.
   * - 'managed-task-worker': only managed-task worker sessions.
   * - 'all': no scope filter.
   */
  readonly scope?: 'user' | 'managed-task-worker' | 'all';
  /**
   * Whether to include whole-session-archived sessions. FEATURE_219 (v0.7.46):
   * archived sessions live in `<projectKey>/archived/` (see `archiveSession`);
   * also still hides the legacy `archived-` filename prefix. Default false.
   */
  readonly includeArchived?: boolean;
  /** Maximum number of sessions to return. Default 50. */
  readonly limit?: number;
  /**
   * ISO date string — return only sessions whose createdAt is before this
   * timestamp. Applied after list + scope filtering.
   */
  readonly before?: string;
  /** Exact match. Omitted means no tag filter. */
  readonly tag?: string;
  /** Exact runtime surface match, for example `repl`, `cli`, `acp`, or `partner`. */
  readonly surface?: string;
  /** Opaque cursor returned on a previous page's last SessionSummary. */
  readonly cursor?: string;
}

type SessionListCandidate = SessionSummary & { _createdAtMs?: number };

interface SessionListReadFilter {
  readonly scope: NonNullable<ListSessionsOptions['scope']>;
  readonly before?: number;
  readonly tag?: string;
  readonly surface?: string;
  readonly gitRoot?: string;
}

async function readSessionMetaRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  const firstLine = await readSessionFirstLine(filePath);
  if (!firstLine) return undefined;
  const first: unknown = JSON.parse(firstLine);
  if (first === null || typeof first !== 'object') return undefined;
  const meta = first as Record<string, unknown>;
  return meta._type === 'meta' ? meta : undefined;
}

async function readActiveMessageCount(
  filePath: string,
  meta: Record<string, unknown>,
): Promise<number> {
  if (typeof meta.activeMessageCount === 'number' && meta.activeMessageCount >= 0) {
    return meta.activeMessageCount;
  }
  const content = (await fsPromises.readFile(filePath, 'utf-8')).trim();
  const extensionRecordCount =
    typeof meta.extensionRecordCount === 'number' && meta.extensionRecordCount > 0
      ? meta.extensionRecordCount
      : 0;
  return Math.max(0, content.split('\n').length - 1 - extensionRecordCount);
}

async function readSessionListCandidate(
  filePath: string,
  filter: SessionListReadFilter,
): Promise<SessionListCandidate | undefined> {
  const meta = await readSessionMetaRecord(filePath);
  if (!meta) return undefined;
  const sessionScope = meta.scope === 'managed-task-worker' ? 'managed-task-worker' : 'user';
  if (filter.scope !== 'all' && filter.scope !== sessionScope) return undefined;

  const createdAt = typeof meta.createdAt === 'string' ? meta.createdAt : undefined;
  const createdAtMs = createdAt ? Date.parse(createdAt) : undefined;
  if (
    filter.before !== undefined
    && createdAtMs !== undefined
    && Number.isFinite(createdAtMs)
    && createdAtMs >= filter.before
  ) {
    return undefined;
  }
  const tag = typeof meta.tag === 'string' ? meta.tag : undefined;
  if (filter.tag !== undefined && tag !== filter.tag) return undefined;

  const runtimeInfo = meta.runtimeInfo !== null && typeof meta.runtimeInfo === 'object'
    ? extractRuntimeInfoSummary(meta.runtimeInfo as KodaXSessionRuntimeInfo)
    : undefined;
  const metaGitRoot = typeof meta.gitRoot === 'string' ? meta.gitRoot : undefined;
  const summaryRuntime = runtimeInfo ?? (metaGitRoot ? { gitRoot: metaGitRoot } : undefined);
  if (!sessionMatchesProjectRoot(summaryRuntime, metaGitRoot, filter.gitRoot)) return undefined;
  if (filter.surface !== undefined && summaryRuntime?.surface !== filter.surface) return undefined;

  const id = path.basename(filePath, '.jsonl');
  const archived = path.basename(path.dirname(filePath)) === 'archived';
  return {
    id,
    title: typeof meta.title === 'string' ? meta.title : '',
    msgCount: await readActiveMessageCount(filePath, meta),
    ...(tag !== undefined ? { tag } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(summaryRuntime !== undefined ? { runtimeInfo: summaryRuntime } : {}),
    projectKey: deriveProjectKeyFromRoot(summaryRuntime?.gitRoot ?? summaryRuntime?.workspaceRoot).key,
    ...(archived ? { archived: true } : {}),
    _createdAtMs: createdAtMs,
  };
}

export type WatchSessionsCallback = (
  event: { kind: 'change' | 'add' | 'remove'; sessionId: string },
) => void;

export interface SessionManager {
  listSessions: typeof listSessions;
  loadSession: typeof loadSession;
  loadFullTranscript: typeof loadFullTranscript;
  readFullTranscript: typeof readFullTranscript;
  readConversationHistory: typeof readConversationHistory;
  readSessionCapture(
    id: string,
    options?: SessionReadOptions,
  ): Promise<SessionReadCapture | null>;
  appendClientNotice: typeof appendClientNotice;
  forkSession: typeof forkSession;
  rewindSession: typeof rewindSession;
  setActiveEntry: typeof setActiveEntry;
  deleteSession: typeof deleteSession;
  archiveSession: typeof archiveSession;
  unarchiveSession: typeof unarchiveSession;
  listRunningSessions: typeof listRunningSessions;
  watchSessions: typeof watchSessions;
  /** FEATURE_247 (R6) — imperatively compact a session by id (writes lineage + emits nothing; returns stats). */
  compactSession: typeof compactSession;
  /**
   * v0.7.43 — the raw write-side storage instance. SDK embedders pass
   * this into `runKodaX({ session: { id, scope, storage } })` so the
   * SA / AMA loops write per-turn JSONL snapshots to disk. Without an
   * injected storage, `saveSessionSnapshot` is a silent no-op and the
   * sessions directory stays empty regardless of `session.id`.
   *
   * See {@link FileSessionStorage} for the concrete implementation and
   * `public_docs/sdk/embedder-guide.md` §6 for the end-to-end recipe.
   */
  storage: FileSessionStorage;
}

// ── Shared storage instance (lazy) ───────────────────────────────────────────

function getStorage(sessionsDir?: string, configHome?: string): FileSessionStorage {
  return sessionsDir !== undefined || configHome !== undefined
    ? new FileSessionStorage({
        ...(sessionsDir === undefined ? {} : { sessionsDir }),
        ...(configHome === undefined ? {} : { configHome }),
      })
    : new FileSessionStorage();
}

function resolveSessionsDir(override?: string): string {
  return override ?? KODAX_SESSIONS_DIR;
}

function encodeSessionCursor(sessionId: string): string {
  return Buffer.from(sessionId, 'utf8').toString('base64url');
}

function decodeSessionCursor(cursor: string): string | undefined {
  if (!cursor || cursor.length > 1024) return undefined;
  try {
    const sessionId = Buffer.from(cursor, 'base64url').toString('utf8');
    return sessionId && encodeSessionCursor(sessionId) === cursor ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

// ── listSessions ─────────────────────────────────────────────────────────────

/**
 * List sessions, optionally filtered by scope, limit, and date.
 * NEVER throws. Returns [] when the sessions directory is empty or missing.
 */
export async function listSessions(opts?: ListSessionsOptions): Promise<SessionSummary[]> {
  return listSessionsImpl(opts, undefined);
}

async function listSessionsImpl(
  opts: ListSessionsOptions | undefined,
  sessionsDirOverride: string | undefined,
): Promise<SessionSummary[]> {
  try {
    const sessionsDir = resolveSessionsDir(sessionsDirOverride);
    // FEATURE_219 — trigger the one-shot auto-migration here too, so the SDK
    // SLOW path (scope='all' / before / includeArchived) which reads the
    // directory directly (collectSessionFilePaths) doesn't bypass the gate the
    // FileSessionStorage entry points enforce. Idempotent (marker fast-path).
    await ensureLayoutMigrated(sessionsDir);
    // FileSessionStorage.list() accepts an optional gitRoot to scope to the
    // current workspace. Map projectRoot alias to gitRoot.
    const gitRoot = opts?.projectRoot;
    const storage = getStorage(sessionsDirOverride);

    // Read all .jsonl files directly so we can lift the hard-cap of 10 that
    // FileSessionStorage.list() applies, and support scope='all' / 'managed-task-worker'.
    // We replicate the core listing logic here to get createdAt + runtimeInfo
    // without re-reading files.
    await fsPromises.mkdir(sessionsDir, { recursive: true });
    const scope = opts?.scope ?? 'user';
    const includeArchived = opts?.includeArchived ?? false;
    const limit = opts?.limit ?? 50;
    const before = opts?.before ? Date.parse(opts.before) : undefined;
    const tag = opts?.tag;
    const surface = opts?.surface;
    const cursorId = opts?.cursor === undefined ? undefined : decodeSessionCursor(opts.cursor);
    if (opts?.cursor !== undefined && cursorId === undefined) return [];

    if (
      scope === 'user'
      && before === undefined
      && !includeArchived
      && tag === undefined
      && surface === undefined
      && cursorId === undefined
    ) {
      // Fast path: delegate to storage.list() which already handles the
      // common case (head-read every meta file, sorted newest-first,
      // archived/.archive.jsonl filtered, runtimeInfo + gitRoot
      // fallback applied). v0.7.46 — pass `limit` so the caller's
      // requested page size actually lands at the storage layer
      // (pre-v0.7.46 storage.list() had a hardcoded `.slice(0, 10)`
      // that silently truncated any larger limit).
      const raw = await storage.list(gitRoot, { limit });
      return raw.map(toSessionSummary);
    }

    // Slow path: read the sessions directory ourselves for scope / before
    // filtering. FEATURE_219 — gather from the per-project layout (+ flat
    // legacy pool), dedup by id (a session mid-migration may appear twice).
    const locationBoundary = storage.beginSessionLocationTraversal();
    const locationDiscovery = await collectSessionFilePaths(sessionsDir, true);
    const locatedFilePaths = locationDiscovery.paths;
    storage.completeSessionLocationTraversal(
      locationBoundary,
      locatedFilePaths.filter(
        (filePath) => !path.basename(filePath).startsWith('archived-'),
      ),
      locationDiscovery.complete,
    );
    const filePaths = includeArchived
      ? locatedFilePaths
      : locatedFilePaths.filter((filePath) => (
          path.basename(path.dirname(filePath)) !== 'archived'
          && !path.basename(filePath).startsWith('archived-')
        ));

    const sessions: SessionListCandidate[] = [];
    const seenIds = new Set<string>();
    const readFilter: SessionListReadFilter = {
      scope,
      ...(before !== undefined ? { before } : {}),
      ...(tag !== undefined ? { tag } : {}),
      ...(surface !== undefined ? { surface } : {}),
      ...(gitRoot !== undefined ? { gitRoot } : {}),
    };

    const readConcurrency = 48;
    for (let index = 0; index < filePaths.length; index += readConcurrency) {
      const batch = await Promise.all(
        filePaths.slice(index, index + readConcurrency).map(async (filePath) => {
          try {
            return await readSessionListCandidate(filePath, readFilter);
          } catch (error: unknown) {
            emitKodaXDiagnostic({
              source: 'session.public-api',
              level: 'warn',
              message: 'Unreadable session record was skipped.',
              detail: { filePath, error },
            });
            return undefined;
          }
        }),
      );
      for (const candidate of batch) {
        if (candidate && !seenIds.has(candidate.id)) {
          seenIds.add(candidate.id);
          sessions.push(candidate);
        }
      }
    }

    // Sort newest-first (mirrors FileSessionStorage.list()).
    sessions.sort((a, b) => {
      const at = a._createdAtMs;
      const bt = b._createdAtMs;
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) {
        return (bt as number) - (at as number);
      }
      if (Number.isFinite(bt) && !Number.isFinite(at)) return 1;
      if (Number.isFinite(at) && !Number.isFinite(bt)) return -1;
      return b.id.localeCompare(a.id);
    });

    const cursorIndex = cursorId === undefined
      ? -1
      : sessions.findIndex((session) => session.id === cursorId);
    if (cursorId !== undefined && cursorIndex < 0) return [];
    const pageStart = cursorIndex + 1;

    return sessions.slice(pageStart, pageStart + limit).map(({ id, title, msgCount, tag: sessionTag, createdAt, runtimeInfo, projectKey, archived }) => ({
      id,
      cursor: encodeSessionCursor(id),
      title,
      msgCount,
      ...(sessionTag !== undefined ? { tag: sessionTag } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(runtimeInfo !== undefined ? { runtimeInfo } : {}),
      ...(projectKey !== undefined ? { projectKey } : {}),
      ...(archived ? { archived: true } : {}),
    }));
  } catch {
    return [];
  }
}

function extractRuntimeInfoSummary(
  ri: KodaXSessionRuntimeInfo,
): { workspaceRoot?: string; gitRoot?: string; surface?: string; profileId?: string } | undefined {
  // FEATURE_247 (R5): include surface + profileId so a Partner session is
  // identifiable from the list without a full load, even when it has no
  // workspace root.
  const out = {
    ...(ri.workspaceRoot ? { workspaceRoot: ri.workspaceRoot } : {}),
    ...(ri.canonicalRepoRoot ? { gitRoot: ri.canonicalRepoRoot } : {}),
    ...(ri.surface ? { surface: ri.surface } : {}),
    ...(ri.profileId ? { profileId: ri.profileId } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function toSessionSummary(raw: {
  id: string;
  title: string;
  msgCount: number;
  tag?: string;
  runtimeInfo?: KodaXSessionRuntimeInfo;
  /**
   * v0.7.46 — carried through from `storage.list()` so the fast path
   * populates `SessionSummary.createdAt`. Pre-v0.7.46 this field was
   * dropped on the fast path (storage.list() return shape lacked it),
   * so any consumer sorting by createdAt got `undefined` for every
   * entry on the common-case call.
   */
  createdAt?: string;
}): SessionSummary {
  const runtimeInfo = raw.runtimeInfo
    ? extractRuntimeInfoSummary(raw.runtimeInfo)
    : undefined;
  const projectKey = deriveProjectKeyFromRoot(
    runtimeInfo?.gitRoot ?? runtimeInfo?.workspaceRoot,
  ).key;
  return {
    id: raw.id,
    cursor: encodeSessionCursor(raw.id),
    title: raw.title,
    msgCount: raw.msgCount,
    ...(raw.tag !== undefined ? { tag: raw.tag } : {}),
    ...(runtimeInfo !== undefined ? { runtimeInfo } : {}),
    ...(raw.createdAt !== undefined ? { createdAt: raw.createdAt } : {}),
    projectKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ── loadSession ───────────────────────────────────────────────────────────────

// Full transcript helpers preserve append order without changing active
// lineage semantics.
function collectActiveIds(lineage: KodaXSessionLineage): Set<string> {
  const byId = new Map(lineage.entries.map((entry) => [entry.id, entry]));
  const activeIds = new Set<string>();
  let currentId = lineage.activeEntryId;
  while (currentId) {
    const entry = byId.get(currentId);
    if (!entry) {
      break;
    }
    activeIds.add(entry.id);
    currentId = entry.parentId;
  }
  return activeIds;
}

function summaryMessage(summary: string, kind: SessionTranscriptEntryType): KodaXMessage {
  if (kind === 'branch_summary') {
    return {
      role: 'user',
      content: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${summary}\n</summary>`,
    };
  }
  return {
    role: 'system',
    content: `[\u5bf9\u8bdd\u5386\u53f2\u6458\u8981]\n\n${summary}`,
  };
}

function rewindMarkerMessage(summary: string): KodaXMessage {
  return {
    role: 'system',
    content: `[Rewind] ${summary}`,
  };
}

function clientNoticeMessage(entry: KodaXSessionClientNoticeEntry): KodaXMessage {
  return {
    role: 'system',
    content: entry.content,
    _source: 'client_notice',
    timestamp: entry.timestamp,
    ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
  };
}

function messageStringField(message: KodaXMessage, key: string): string | undefined {
  const value = (message as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function messageSource(message: KodaXMessage): SessionTranscriptEntrySource | undefined {
  if (message.role === 'user') return 'user';
  if (message.role === 'assistant') return 'assistant';
  if (message.role === 'system') return 'system';
  return undefined;
}

function isTaskResultMetadata(value: unknown): value is KodaXTaskResultMetadata {
  if (!isRecord(value)) return false;
  return value.type === 'task_result'
    && (value.source === 'workflow' || value.source === 'child_task')
    && typeof value.taskId === 'string'
    && (
      value.status === 'completed'
      || value.status === 'failed'
      || value.status === 'cancelled'
    )
    && (value.runId === undefined || typeof value.runId === 'string')
    && (value.title === undefined || typeof value.title === 'string')
    && (value.summary === undefined || typeof value.summary === 'string')
    && (
      value.artifactRefs === undefined
      || (Array.isArray(value.artifactRefs) && value.artifactRefs.every((item) => typeof item === 'string'))
    );
}

function taskResultsFromMessage(message: KodaXMessage): KodaXTaskResultMetadata[] {
  if (isTaskResultMetadata(message._taskResult)) {
    return [message._taskResult];
  }
  if (Array.isArray(message._taskResults)) {
    return message._taskResults.filter(isTaskResultMetadata);
  }
  if (message._source !== 'task-completed' || typeof message.content !== 'string') {
    return [];
  }
  const results: KodaXTaskResultMetadata[] = [];
  const pattern = /<task-completed\s+task_id="([^"]+)">([\s\S]*?)<\/task-completed>/g;
  for (const match of message.content.matchAll(pattern)) {
    const taskId = match[1];
    if (!taskId) continue;
    const summary = match[2]?.trim() ?? '';
    results.push({
      type: 'task_result',
      source: 'child_task',
      taskId,
      status: summary.startsWith('failed:') || summary.startsWith('[Tool Error]')
        ? 'failed'
        : 'completed',
      ...(summary.length > 0 ? { summary } : {}),
    });
  }
  return results;
}

function taskResultPayload(results: readonly KodaXTaskResultMetadata[]): unknown {
  if (results.length === 1) {
    return results[0];
  }
  const first = results[0];
  return first
    ? {
        type: 'task_result',
        source: first.source,
        taskId: first.taskId,
        status: first.status,
        results,
      }
    : undefined;
}

function legacyRewindDetails(details: KodaXJsonValue | undefined): {
  readonly rewindTargetId?: string;
  readonly truncatedCount?: number;
} {
  if (!isRecord(details)) {
    return {};
  }
  const rewindTargetId = typeof details.rewindTargetId === 'string'
    ? details.rewindTargetId
    : undefined;
  const truncatedCount = typeof details.truncatedCount === 'number'
    ? details.truncatedCount
    : undefined;
  return {
    ...(rewindTargetId !== undefined ? { rewindTargetId } : {}),
    ...(truncatedCount !== undefined ? { truncatedCount } : {}),
  };
}

function transcriptEntryActive(
  entry: KodaXSessionEntry,
  activeIds: ReadonlySet<string>,
  activeEntryId: string | null,
): boolean {
  if (activeIds.has(entry.id)) {
    return true;
  }
  if (entry.type !== 'client_notice' && entry.type !== 'rewind_marker') {
    return false;
  }
  return entry.parentId === null
    ? activeEntryId === null
    : activeIds.has(entry.parentId);
}

function transcriptEntryIdentity(entry: KodaXSessionEntry): {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly logicalId: string;
  readonly sourceEntryId?: string;
} {
  return {
    entryId: entry.id,
    parentId: entry.parentId,
    logicalId: entry.logicalId ?? entry.id,
    ...(entry.sourceEntryId !== undefined ? { sourceEntryId: entry.sourceEntryId } : {}),
  };
}

function toTranscriptEntry(
  entry: KodaXSessionEntry,
  activeIds: ReadonlySet<string>,
  activeEntryId: string | null,
): SessionTranscriptEntry | null {
  const active = transcriptEntryActive(entry, activeIds, activeEntryId);
  switch (entry.type) {
    case 'message': {
      const taskResults = taskResultsFromMessage(entry.message);
      if (taskResults.length > 0) {
        const first = taskResults[0]!;
        return {
          ...transcriptEntryIdentity(entry),
          timestamp: entry.timestamp,
          type: 'task_result',
          source: first.source,
          turnId: messageStringField(entry.message, 'turnId'),
          message: entry.message,
          active,
          payload: taskResultPayload(taskResults),
          taskResults,
        };
      }
      if (entry.message._source === 'client_notice') {
        return {
          ...transcriptEntryIdentity(entry),
          timestamp: entry.timestamp,
          type: 'client_notice',
          source: 'client',
          turnId: messageStringField(entry.message, 'turnId'),
          message: entry.message,
          active,
          payload: {
            content: entry.message.content,
            entersModelContext: false,
          },
        };
      }
      return {
        ...transcriptEntryIdentity(entry),
        timestamp: entry.timestamp,
        type: 'message',
        source: messageSource(entry.message),
        turnId: messageStringField(entry.message, 'turnId'),
        message: entry.message,
        active,
      };
    }
    case 'compaction':
      if (entry.reason === 'rewind') {
        const details = legacyRewindDetails(entry.details);
        const markerActive = active || (entry.parentId === null
          ? activeEntryId === null
          : activeIds.has(entry.parentId));
        return {
          ...transcriptEntryIdentity(entry),
          timestamp: entry.timestamp,
          type: 'rewind_marker',
          source: 'system',
          message: rewindMarkerMessage(entry.summary),
          active: markerActive,
          summary: entry.summary,
          payload: {
            summary: entry.summary,
            reason: 'rewind',
            ...(details.rewindTargetId !== undefined ? { rewindTargetId: details.rewindTargetId } : {}),
            ...(details.truncatedCount !== undefined ? { truncatedCount: details.truncatedCount } : {}),
            ...(entry.details !== undefined ? { details: entry.details } : {}),
          },
        };
      }
      return {
        ...transcriptEntryIdentity(entry),
        timestamp: entry.timestamp,
        type: 'compaction',
        source: 'system',
        message: summaryMessage(entry.summary, 'compaction'),
        active,
        summary: entry.summary,
        payload: {
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          tokensAfter: entry.tokensAfter,
          reason: entry.reason,
          details: entry.details,
        },
      };
    case 'rewind_marker':
      return {
        ...transcriptEntryIdentity(entry),
        timestamp: entry.timestamp,
        type: 'rewind_marker',
        source: 'system',
        message: rewindMarkerMessage(entry.summary),
        active,
        summary: entry.summary,
        payload: {
          summary: entry.summary,
          rewindTargetId: entry.targetId,
          ...(entry.fromId !== undefined ? { fromId: entry.fromId } : {}),
          truncatedCount: entry.truncatedCount,
        },
      };
    case 'branch_summary':
      return {
        ...transcriptEntryIdentity(entry),
        timestamp: entry.timestamp,
        type: 'branch_summary',
        source: 'system',
        message: summaryMessage(entry.summary, 'branch_summary'),
        active,
        summary: entry.summary,
        payload: {
          summary: entry.summary,
          fromId: entry.fromId,
          details: entry.details,
        },
      };
    case 'client_notice':
      return {
        ...transcriptEntryIdentity(entry),
        timestamp: entry.timestamp,
        type: 'client_notice',
        source: 'client',
        turnId: entry.turnId,
        message: clientNoticeMessage(entry),
        active,
        payload: {
          source: entry.source,
          content: entry.content,
          entersModelContext: false,
          ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
        },
      };
    case 'archive_marker':
    case 'label':
    case 'goal':
    case 'memory_outcome_digest':
    case 'memory_review_receipt':
      return null;
    default: {
      const exhaustiveCheck: never = entry;
      return exhaustiveCheck;
    }
  }
}

function buildTranscriptEntries(lineage: KodaXSessionLineage): SessionTranscriptEntry[] {
  const activeIds = collectActiveIds(lineage);
  return lineage.entries
    .map((entry) => toTranscriptEntry(entry, activeIds, lineage.activeEntryId))
    .filter((entry): entry is SessionTranscriptEntry => entry !== null);
}

/**
 * Load full session data by ID.
 * Returns null for a missing session. NEVER throws.
 */
export async function loadSession(id: string): Promise<SessionData | null> {
  return loadSessionImpl(id, undefined);
}

async function loadSessionImpl(
  id: string,
  sessionsDirOverride: string | undefined,
): Promise<SessionData | null> {
  return loadSessionWithStorage(id, getStorage(sessionsDirOverride));
}

async function loadSessionWithStorage(
  id: string,
  storage: FileSessionStorage,
): Promise<SessionData | null> {
  try {
    return await storage.load(id);
  } catch {
    return null;
  }
}

/**
 * Load append-order transcript data by ID.
 *
 * `loadSession` remains the active model-context API. This helper returns raw
 * host-facing scrollback/audit data, including archived islands and inactive
 * branches, in append order. Hosts decide what to show or fold.
 */
export async function loadFullTranscript(id: string): Promise<FullTranscriptSessionData | null> {
  return loadFullTranscriptImpl(id, undefined);
}

/**
 * Strict, boundary-consistent history read.
 *
 * Unlike the legacy null-on-error helper, this never migrates or repairs the
 * Session and preserves structured read errors for the host.
 */
export async function readFullTranscript(
  id: string,
  options: SessionReadOptions = {},
): Promise<FullTranscriptSessionData | null> {
  return readFullTranscriptImpl(id, undefined, options);
}

/**
 * Read the SDK-resolved ordinary conversation view at one immutable boundary.
 * Raw append-order audit data remains available through `readFullTranscript`.
 */
export async function readConversationHistory(
  id: string,
  options: SessionReadOptions = {},
): Promise<SessionConversationHistoryData | null> {
  return readConversationHistoryWithStorage(id, getStorage(), options);
}

/** Build the conversation projection from an already captured read boundary. */
export function conversationHistoryFromCapture(
  capture: SessionReadCapture,
  checkpoint?: () => void,
): SessionConversationHistoryData {
  return capture.transcript.lineage === undefined
      ? buildLineageUnavailableConversationHistory(
          capture.transcript.activeMessages,
          capture.sourceRevision,
          checkpoint,
        )
    : buildSessionConversationHistory(
        capture.transcript.lineage,
        capture.sourceRevision,
        checkpoint,
      );
}

export async function readSessionCapture(
  id: string,
  options: SessionReadOptions = {},
): Promise<SessionReadCapture | null> {
  return readSessionCaptureWithStorage(id, getStorage(), options);
}

/**
 * Export the exact persisted Session bundle without migration, recovery, or
 * schema rewriting. Unknown and malformed records remain byte-for-byte intact
 * and are described by diagnostics instead of being discarded.
 */
export async function exportSessionBundle(
  id: string,
  options: SessionBundleExportOptions = {},
): Promise<SessionBundleExportResult> {
  if (options.signal?.aborted) {
    throw new SessionReadError('read_cancelled', 'Session bundle export cancelled');
  }
  const sessionsDir = path.resolve(options.sessionsDir ?? KODAX_SESSIONS_DIR);
  const timeoutMs = normalizeBundleExportTimeout(options.timeoutMs);
  const operation = (async (): Promise<SessionBundleExportResult> => {
    const snapshot = await readStableSessionBundleFiles(
      sessionsDir,
      id,
      options.signal,
    );
    if (snapshot.candidates.length === 0) {
      return { sessionId: id, status: 'missing', files: [], diagnostics: [] };
    }
    if (snapshot.candidates.length > 1) {
      return {
        sessionId: id,
        status: 'ambiguous',
        files: [],
        candidates: snapshot.candidates,
        diagnostics: [],
      };
    }
    const files = snapshot.files.map((file): SessionBundleExportFile => ({
      kind: file.kind,
      path: file.path,
      byteLength: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
      modifiedAt: file.modifiedAt,
      content: file.bytes.toString('utf8'),
      contentBase64: file.bytes.toString('base64'),
    }));
    const diagnostics = files.flatMap(inspectSessionBundleFile);
    return {
      sessionId: id,
      status: bundleExportStatus(diagnostics),
      files,
      diagnostics,
    };
  })();
  return raceBundleExport(operation, options, timeoutMs);
}

function inspectSessionBundleFile(
  file: SessionBundleExportFile,
): SessionBundleExportDiagnostic[] {
  const diagnostics: SessionBundleExportDiagnostic[] = [];
  const lines = file.content.split(/\r?\n/);
  let lastRecordIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? '').trim().length > 0) {
      lastRecordIndex = index;
      break;
    }
  }
  for (let index = 0; index <= lastRecordIndex; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      diagnostics.push({
        code: index === lastRecordIndex ? 'partial_tail' : 'malformed_record',
        file: file.path,
        line: index + 1,
        message: index === lastRecordIndex
          ? 'Trailing partial record was preserved verbatim.'
          : 'Malformed record was preserved verbatim.',
      });
      continue;
    }
    if (
      file.kind === 'main'
      && index === 0
      && isRecord(value)
      && value._type === 'meta'
      && value.lineageVersion !== undefined
      && value.lineageVersion !== 2
    ) {
      diagnostics.push({
        code: 'unsupported_version',
        file: file.path,
        line: 1,
        message: `Unsupported Session lineage version: ${String(value.lineageVersion)}`,
      });
      continue;
    }
    if (!isRecognizedBundleRecord(value, file.kind)) {
      diagnostics.push({
        code: 'unsupported_record',
        file: file.path,
        line: index + 1,
        message: 'Unknown record was preserved verbatim.',
      });
    }
  }
  return diagnostics;
}

function isRecognizedBundleRecord(
  value: unknown,
  kind: SessionBundleExportFile['kind'],
): boolean {
  if (!isRecord(value)) return false;
  if (kind !== 'main') {
    return value._type === 'archive_batch' || value._type === 'archived_entry';
  }
  if (
    value._type === 'meta'
    || value._type === 'meta_update'
    || value._type === 'lineage_entry'
    || value._type === 'artifact_ledger_entry'
    || value._type === 'extension_record'
  ) {
    return true;
  }
  return (
    value.role === 'user'
    || value.role === 'assistant'
    || value.role === 'system'
  ) && (typeof value.content === 'string' || Array.isArray(value.content));
}

function bundleExportStatus(
  diagnostics: readonly SessionBundleExportDiagnostic[],
): SessionBundleExportStatus {
  if (diagnostics.some((item) => item.code === 'malformed_record')) {
    return 'corrupt';
  }
  if (diagnostics.some((item) => (
    item.code === 'unsupported_record' || item.code === 'unsupported_version'
  ))) {
    return 'unsupported';
  }
  return diagnostics.some((item) => item.code === 'partial_tail')
    ? 'partial'
    : 'ok';
}

function normalizeBundleExportTimeout(timeoutMs: number | undefined): number {
  const normalized = timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error('Session bundle export timeoutMs must be a positive safe integer');
  }
  return normalized;
}

async function raceBundleExport<T>(
  operation: Promise<T>,
  options: SessionReadOptions,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SessionReadError(
            'read_timeout',
            `Session bundle export timed out after ${timeoutMs}ms`,
          )),
          timeoutMs,
        );
        if (options.signal !== undefined) {
          abort = () => reject(new SessionReadError(
            'read_cancelled',
            'Session bundle export cancelled',
          ));
          options.signal.addEventListener('abort', abort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) options.signal?.removeEventListener('abort', abort);
  }
}

async function loadFullTranscriptImpl(
  id: string,
  sessionsDirOverride: string | undefined,
): Promise<FullTranscriptSessionData | null> {
  try {
    return await readFullTranscriptImpl(id, sessionsDirOverride, {});
  } catch {
    return null;
  }
}

async function readFullTranscriptImpl(
  id: string,
  sessionsDirOverride: string | undefined,
  options: SessionReadOptions,
): Promise<FullTranscriptSessionData | null> {
  return (await readSessionCaptureWithStorage(
    id,
    getStorage(sessionsDirOverride),
    options,
  ))?.transcript ?? null;
}

async function readSessionCaptureWithStorage(
  id: string,
  storage: FileSessionStorage,
  options: SessionReadOptions,
): Promise<SessionReadCapture | null> {
  const snapshot = await storage.readFullSnapshot(id, options);
  if (snapshot === null) return null;
  const transcript = fullTranscriptFromSnapshot(snapshot);
  return {
    data: snapshot.data,
    transcript,
    sourceRevision: snapshot.sourceRevision,
    sourceRevisionState: snapshot.sourceRevisionState,
    boundaryRevision: snapshot.boundaryRevision,
  };
}

async function readConversationHistoryWithStorage(
  id: string,
  storage: FileSessionStorage,
  options: SessionReadOptions,
): Promise<SessionConversationHistoryData | null> {
  const startedAt = Date.now();
  const capture = await readSessionCaptureWithStorage(id, storage, options);
  if (capture === null) return null;
  const history = conversationHistoryFromCapture(
    capture,
    () => assertSessionReadBudget(options, startedAt),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assertSessionReadBudget(options, startedAt);
  return history;
}

function fullTranscriptFromSnapshot(
  snapshot: SessionReadSnapshot,
): FullTranscriptSessionData {
  if (snapshot.lineage === null) {
    return {
      ...snapshot.data,
      activeMessages: snapshot.data.messages,
      transcriptEntries: [],
    };
  }
  const transcriptEntries = buildTranscriptEntries(snapshot.lineage);
  return {
    ...snapshot.data,
    messages: transcriptEntries
      .filter((entry) => entry.type !== 'rewind_marker')
      .map((entry) => entry.message),
    activeMessages: snapshot.data.messages,
    transcriptEntries,
    lineage: snapshot.lineage,
  };
}

function normalizeClientNoticeSource(source: string | undefined): string {
  const trimmed = source?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'client';
}

function createClientNoticeEntry(
  lineage: KodaXSessionLineage,
  options: AppendClientNoticeOptions,
): KodaXSessionClientNoticeEntry {
  const entryId = `notice_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  return {
    type: 'client_notice',
    id: entryId,
    parentId: lineage.activeEntryId,
    timestamp: options.timestamp ?? new Date().toISOString(),
    logicalId: entryId,
    source: normalizeClientNoticeSource(options.source),
    content: options.content,
    ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
  };
}

/**
 * Append a host-owned transcript notice that never enters model context.
 *
 * Use this for local slash-command output such as `/doctor`, `/mcp status`,
 * or host-side status panes. It is visible through `loadFullTranscript()` but
 * `loadSession()` keeps returning only the active model messages.
 */
export async function appendClientNotice(
  id: string,
  options: AppendClientNoticeOptions,
): Promise<SessionTranscriptEntry | null> {
  return appendClientNoticeImpl(id, options, undefined);
}

async function appendClientNoticeImpl(
  id: string,
  options: AppendClientNoticeOptions,
  sessionsDirOverride: string | undefined,
): Promise<SessionTranscriptEntry | null> {
  return appendClientNoticeWithStorage(id, options, getStorage(sessionsDirOverride));
}

async function appendClientNoticeWithStorage(
  id: string,
  options: AppendClientNoticeOptions,
  storage: FileSessionStorage,
): Promise<SessionTranscriptEntry | null> {
  try {
    const loaded = await storage.load(id);
    if (!loaded) {
      return null;
    }

    const lineage = loaded.lineage ?? createSessionLineage(loaded.messages);
    const notice = createClientNoticeEntry(lineage, options);
    const nextLineage: KodaXSessionLineage = {
      ...lineage,
      entries: [...lineage.entries, notice],
    };
    const nextData: SessionData = {
      ...loaded,
      lineage: nextLineage,
      messages: loaded.messages,
    };

    await storage.appendSessionDelta(id, nextData);
    const activeIds = collectActiveIds(nextLineage);
    return toTranscriptEntry(notice, activeIds, nextLineage.activeEntryId);
  } catch {
    return null;
  }
}

// ── forkSession ───────────────────────────────────────────────────────────────

export interface SessionConversationMutationBoundary {
  readonly boundaryId: string;
  readonly sourceRevision: string;
}

export interface ForkSessionOptions {
  readonly selector?: string;
  readonly sessionId?: string;
  readonly title?: string;
  readonly historyBoundary?: SessionConversationMutationBoundary;
}

export interface RewindSessionOptions {
  readonly selector?: string;
  readonly historyBoundary?: SessionConversationMutationBoundary;
}

/**
 * Fork a session at an optional selector.
 * Returns null for a missing session. NEVER throws.
 */
export async function forkSession(
  id: string,
  opts?: ForkSessionOptions,
): Promise<{ sessionId: string; data: SessionData } | null> {
  return forkSessionImpl(id, opts, undefined);
}

async function forkSessionImpl(
  id: string,
  opts: ForkSessionOptions | undefined,
  sessionsDirOverride: string | undefined,
): Promise<{ sessionId: string; data: SessionData } | null> {
  try {
    if (opts?.selector !== undefined && opts.historyBoundary !== undefined) {
      return null;
    }
    const historyBoundary = opts?.historyBoundary;
    return await getStorage(sessionsDirOverride).fork(
      id,
      historyBoundary?.boundaryId ?? opts?.selector,
      {
        sessionId: opts?.sessionId,
        title: opts?.title,
        ...(historyBoundary !== undefined
          ? { historyBoundary: { sourceRevision: historyBoundary.sourceRevision } }
          : {}),
      },
    );
  } catch {
    return null;
  }
}

// ── rewindSession ─────────────────────────────────────────────────────────────

/**
 * Rewind a session to a previous user entry.
 * Returns null for a missing session. NEVER throws.
 */
export async function rewindSession(
  id: string,
  opts?: RewindSessionOptions,
): Promise<SessionData | null> {
  return rewindSessionImpl(id, opts, undefined);
}

async function rewindSessionImpl(
  id: string,
  opts: RewindSessionOptions | undefined,
  sessionsDirOverride: string | undefined,
  configHomeOverride?: string,
): Promise<SessionData | null> {
  try {
    if (opts?.selector !== undefined && opts.historyBoundary !== undefined) {
      return null;
    }
    const historyBoundary = opts?.historyBoundary;
    return await getStorage(sessionsDirOverride, configHomeOverride).rewind(
      id,
      historyBoundary?.boundaryId ?? opts?.selector,
      historyBoundary === undefined
        ? undefined
        : { historyBoundary: { sourceRevision: historyBoundary.sourceRevision } },
    );
  } catch {
    return null;
  }
}

// ── setActiveEntry ────────────────────────────────────────────────────────────

/**
 * Set the active lineage entry by selector.
 * Returns null for a missing session. NEVER throws.
 */
export async function setActiveEntry(
  id: string,
  selector: string,
): Promise<SessionData | null> {
  return setActiveEntryImpl(id, selector, undefined);
}

async function setActiveEntryImpl(
  id: string,
  selector: string,
  sessionsDirOverride: string | undefined,
  configHomeOverride?: string,
): Promise<SessionData | null> {
  try {
    return await getStorage(sessionsDirOverride, configHomeOverride).setActiveEntry(id, selector);
  } catch {
    return null;
  }
}

// ── listRunningSessions ───────────────────────────────────────────────────────

export interface RunningSessionInfo {
  readonly pid: number;
  readonly startedAt: number;
  readonly cwd: string;
  /**
   * v0.7.43 — populated from `PersistedSessionState.sessionId`, published
   * by the REPL after `createInteractiveContext`. Remains `undefined` for
   * a brief window during a peer's bootstrap (before the first sessionId
   * is generated) and for peers running pre-v0.7.43 binaries; consumers
   * MUST handle `undefined`.
   */
  readonly sessionId: string | undefined;
}

/**
 * Returns live KodaX sibling instances (excluding this process).
 * Uses discoverInstances() from @kodax-ai/agent (FEATURE_125 Team Mode).
 * NEVER throws. Returns [] when no instances directory exists.
 */
export async function listRunningSessions(): Promise<RunningSessionInfo[]> {
  try {
    const instances = discoverInstances({ excludePid: process.pid });
    return instances.map((inst) => ({
      pid: inst.pid,
      startedAt: inst.state.meta.startedAt,
      cwd: inst.state.meta.cwd,
      sessionId: inst.state.sessionId,
    }));
  } catch {
    return [];
  }
}

// ── deleteSession ─────────────────────────────────────────────────────────────

export type DeleteSessionResult =
  | { ok: true }
  | { error: { code: 'session_running'; runningProcess: { pid: number; startedAt: number } } }
  | { error: { code: 'delete_failed' } };

/**
 * Delete a session by ID.
 * Returns { ok: true } on success (including when the session doesn't exist).
 * Returns an error envelope when the session is currently running.
 * NEVER throws.
 */
export async function deleteSession(id: string): Promise<DeleteSessionResult> {
  return deleteSessionImpl(id, undefined);
}

async function deleteSessionImpl(
  id: string,
  sessionsDirOverride: string | undefined,
): Promise<DeleteSessionResult> {
  try {
    const running = await listRunningSessions();
    const match = running.find((r) => r.sessionId === id);
    if (match) {
      return {
        error: {
          code: 'session_running',
          runningProcess: { pid: match.pid, startedAt: match.startedAt },
        },
      };
    }
    await getStorage(sessionsDirOverride).delete(id);
    return { ok: true };
  } catch (error: unknown) {
    emitKodaXDiagnostic({
      source: 'session.public-api',
      level: 'error',
      message: 'Session deletion failed.',
      detail: { sessionId: id, error },
    });
    return { error: { code: 'delete_failed' } };
  }
}

// ── archiveSession / unarchiveSession ─────────────────────────────────────────

/**
 * FEATURE_219 (v0.7.46) — whole-session archive. Moves the session (and its
 * island sidecar) into `<projectKey>/archived/`. Returns false for a missing
 * session. NEVER throws. Archived sessions are hidden from the default listing
 * and resurface only with `listSessions({ includeArchived: true })`.
 */
export async function archiveSession(id: string): Promise<boolean> {
  return archiveSessionImpl(id, undefined);
}

async function archiveSessionImpl(id: string, sessionsDirOverride: string | undefined): Promise<boolean> {
  try {
    return await getStorage(sessionsDirOverride).archive(id);
  } catch (error: unknown) {
    emitKodaXDiagnostic({
      source: 'session.public-api',
      level: 'error',
      message: 'Session archive failed.',
      detail: { sessionId: id, error },
    });
    return false;
  }
}

/** Restore an archived session back into its project directory. NEVER throws. */
export async function unarchiveSession(id: string): Promise<boolean> {
  return unarchiveSessionImpl(id, undefined);
}

async function unarchiveSessionImpl(id: string, sessionsDirOverride: string | undefined): Promise<boolean> {
  try {
    return await getStorage(sessionsDirOverride).unarchive(id);
  } catch (error: unknown) {
    emitKodaXDiagnostic({
      source: 'session.public-api',
      level: 'error',
      message: 'Session unarchive failed.',
      detail: { sessionId: id, error },
    });
    return false;
  }
}

// ── watchSessions ─────────────────────────────────────────────────────────────

/**
 * Watch the sessions directory for changes.
 * Returns { close() } that stops the watcher / poll interval.
 *
 * Platform branches:
 * - POSIX: fs.watch() with 100ms debounce.
 * - Windows: readdir poll every 1000ms, diffed against a snapshot.
 *
 * NEVER throws — if the directory doesn't exist the watcher is a no-op
 * until the directory is created.
 */
export function watchSessions(cb: WatchSessionsCallback): { close: () => void } {
  return watchSessionsImpl(cb, undefined);
}

function watchSessionsImpl(
  cb: WatchSessionsCallback,
  sessionsDirOverride: string | undefined,
): { close: () => void } {
  const sessionsDir = resolveSessionsDir(sessionsDirOverride);
  // FEATURE_219 — kick off the one-shot migration so a watcher started before
  // any read/write still observes the per-project layout (fire-and-forget; the
  // recursive watcher / poll picks up the moved files as migration lands).
  void ensureLayoutMigrated(sessionsDir).catch(() => undefined);
  if (process.platform === 'win32') {
    return watchSessionsWindows(cb, sessionsDir);
  }
  return watchSessionsPosix(cb, sessionsDir);
}

function sessionIdFromFilename(filename: string): string | null {
  // FEATURE_219 — recursive watch events carry a `<projectKey>/<id>.jsonl`
  // relative path; reduce to the basename and reject island sidecars.
  const base = path.basename(filename);
  if (
    !base.endsWith('.jsonl')
    || base.endsWith('.archive.jsonl')
    || base.endsWith('.islands.jsonl')
    || base.startsWith('.') // skip control files (.migration-journal.jsonl)
  ) {
    return null;
  }
  return base.slice(0, -6); // strip ".jsonl"
}

function watchSessionsPosix(
  cb: WatchSessionsCallback,
  sessionsDir: string,
): { close: () => void } {
  let watcher: fs.FSWatcher | null = null;
  let closed = false;

  const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

  function emitDebounced(kind: 'change' | 'add' | 'remove', sessionId: string): void {
    const existing = debounceMap.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounceMap.delete(sessionId);
      if (!closed) cb({ kind, sessionId });
    }, 100);
    debounceMap.set(sessionId, timer);
  }

  function startWatch(): void {
    if (closed) return;
    try {
      if (!fs.existsSync(sessionsDir)) {
        // Directory not yet created — retry after 1s.
        setTimeout(startWatch, 1000);
        return;
      }
      // FEATURE_219 — watch recursively so per-project subdir writes surface.
      // Linux does not support `{ recursive: true }` and throws; fall back to a
      // flat watch of the top dir (degraded — sees flat + new project dirs).
      const onEvent = (eventType: string, filename: string | Buffer | null): void => {
        if (!filename) return;
        const name = typeof filename === 'string' ? filename : filename.toString();
        const sessionId = sessionIdFromFilename(name);
        if (!sessionId) return;
        const kind = eventType === 'rename' ? detectRenameKind(sessionsDir, name) : 'change';
        emitDebounced(kind, sessionId);
      };
      try {
        watcher = fs.watch(sessionsDir, { recursive: true }, onEvent);
      } catch {
        watcher = fs.watch(sessionsDir, onEvent);
      }
      watcher.on('error', () => {
        // Watcher error (e.g. directory deleted) — restart.
        watcher?.close();
        watcher = null;
        if (!closed) setTimeout(startWatch, 1000);
      });
    } catch {
      // Silently ignore — directory may not exist yet.
    }
  }

  startWatch();

  return {
    close() {
      closed = true;
      watcher?.close();
      watcher = null;
      for (const t of debounceMap.values()) clearTimeout(t);
      debounceMap.clear();
    },
  };
}

function detectRenameKind(sessionsDir: string, filename: string): 'add' | 'remove' {
  // On POSIX 'rename' fires for both add and remove; check existence.
  try {
    fs.statSync(path.join(sessionsDir, filename));
    return 'add';
  } catch {
    return 'remove';
  }
}

function watchSessionsWindows(
  cb: WatchSessionsCallback,
  sessionsDir: string,
): { close: () => void } {
  let closed = false;
  let lastSnapshot = new Set<string>();

  function addIds(target: Set<string>, dir: string): void {
    try {
      for (const f of fs.readdirSync(dir)) {
        const id = sessionIdFromFilename(f);
        if (id) target.add(id);
      }
    } catch {
      // unreadable dir — skip
    }
  }

  function buildSnapshot(): Set<string> {
    const ids = new Set<string>();
    try {
      if (!fs.existsSync(sessionsDir)) return ids;
      // FEATURE_219 — snapshot the flat pool + every <projectKey>/ dir + each
      // project's archived/ subdir, so Space sees per-project writes.
      for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          const id = sessionIdFromFilename(entry.name);
          if (id) ids.add(id);
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const dir = path.join(sessionsDir, entry.name);
          addIds(ids, dir);
          addIds(ids, path.join(dir, 'archived'));
        }
      }
    } catch {
      // best-effort
    }
    return ids;
  }

  // Build initial snapshot without emitting events.
  lastSnapshot = buildSnapshot();

  const interval = setInterval(() => {
    if (closed) return;
    const current = buildSnapshot();
    for (const id of current) {
      if (!lastSnapshot.has(id)) cb({ kind: 'add', sessionId: id });
    }
    for (const id of lastSnapshot) {
      if (!current.has(id)) cb({ kind: 'remove', sessionId: id });
    }
    lastSnapshot = current;
  }, 1000);

  return {
    close() {
      closed = true;
      clearInterval(interval);
    },
  };
}

// ── createSessionManager ──────────────────────────────────────────────────────

/**
 * Factory that returns an object with all session management methods bound.
 *
 * v0.7.43 (FEATURE_173 Part B follow-up) — the `sessionsDir` override is
 * now honored. When provided, all read/write/watch operations go through
 * that directory instead of the module-load-frozen `KODAX_SESSIONS_DIR`.
 * `listRunningSessions` still consults the agent-config-home instances
 * directory (sibling-process awareness is not scoped per sessions dir).
 * `configHome` binds rewind/setActive review fencing to the same Runtime owner.
 */
export function createSessionManager(opts?: {
  sessionsDir?: string;
  configHome?: string;
}): SessionManager {
  const sessionsDir = opts?.sessionsDir;
  const configHome = opts?.configHome;
  scheduleToolOutputRetention(sessionsDir ?? KODAX_SESSIONS_DIR);
  // Single FileSessionStorage instance per manager. Returned via the
  // `storage` field so callers can pass it through
  // `runKodaX({ session: { id, storage } })`; sharing one instance keeps
  // write-queue + append-watermark caches (CAP-013-001) coherent across
  // mixed read (load/list) + write (run) operations.
  const storage = sessionsDir !== undefined || configHome !== undefined
    ? new FileSessionStorage({
        ...(sessionsDir === undefined ? {} : { sessionsDir }),
        ...(configHome === undefined ? {} : { configHome }),
      })
    : new FileSessionStorage();
  if (sessionsDir === undefined && configHome === undefined) {
    return {
      listSessions,
      loadSession: (id) => loadSessionWithStorage(id, storage),
      loadFullTranscript: async (id) => {
        try {
          return (await readSessionCaptureWithStorage(id, storage, {}))?.transcript ?? null;
        } catch {
          return null;
        }
      },
      readFullTranscript: async (id, options) =>
        (await readSessionCaptureWithStorage(id, storage, options ?? {}))?.transcript ?? null,
      readConversationHistory: (id, options) =>
        readConversationHistoryWithStorage(id, storage, options ?? {}),
      readSessionCapture: (id, options) =>
        readSessionCaptureWithStorage(id, storage, options ?? {}),
      appendClientNotice: (id, options) => appendClientNoticeWithStorage(id, options, storage),
      forkSession,
      rewindSession,
      setActiveEntry,
      deleteSession,
      archiveSession,
      unarchiveSession,
      listRunningSessions,
      watchSessions,
      // FEATURE_247 (R6): bind the manager's own storage so a manager-scoped
      // compact always uses the manager's directory (a caller-supplied
      // `storage`/`sessionsDir` cannot silently bypass the manager's isolation).
      compactSession: (id, o) => compactSession(id, { ...o, storage }),
      storage,
    };
  }
  return {
    listSessions: (o) => listSessionsImpl(o, sessionsDir),
    loadSession: (id) => loadSessionWithStorage(id, storage),
    loadFullTranscript: async (id) => {
      try {
        return (await readSessionCaptureWithStorage(id, storage, {}))?.transcript ?? null;
      } catch {
        return null;
      }
    },
    readFullTranscript: async (id, options) =>
      (await readSessionCaptureWithStorage(id, storage, options ?? {}))?.transcript ?? null,
    readConversationHistory: (id, options) =>
      readConversationHistoryWithStorage(id, storage, options ?? {}),
    readSessionCapture: (id, options) =>
      readSessionCaptureWithStorage(id, storage, options ?? {}),
    appendClientNotice: (id, options) => appendClientNoticeWithStorage(id, options, storage),
    forkSession: (id, o) => forkSessionImpl(id, o, sessionsDir),
    rewindSession: (id, o) => rewindSessionImpl(id, o, sessionsDir, configHome),
    setActiveEntry: (id, selector) =>
      setActiveEntryImpl(id, selector, sessionsDir, configHome),
    deleteSession: (id) => deleteSessionImpl(id, sessionsDir),
    archiveSession: (id) => archiveSessionImpl(id, sessionsDir),
    unarchiveSession: (id) => unarchiveSessionImpl(id, sessionsDir),
    listRunningSessions,
    watchSessions: (cb) => watchSessionsImpl(cb, sessionsDir),
    // FEATURE_247 (R6): bind the manager's sessionsDir-scoped storage so a
    // caller-supplied `storage` cannot bypass the manager's dir isolation.
    compactSession: (id, o) => compactSession(id, { ...o, storage }),
    storage,
  };
}
