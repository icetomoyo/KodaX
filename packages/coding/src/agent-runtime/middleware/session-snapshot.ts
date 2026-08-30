/**
 * Session snapshot middleware — CAP-011 + CAP-013
 *
 * Capability inventory:
 * - docs/features/v0.7.29-capability-inventory.md#cap-011-savesessionsnapshot-at-terminal-sites
 * - docs/features/v0.7.29-capability-inventory.md#cap-013-error-snapshot-persistence-on-crash
 *
 * Persists `.kodax/sessions/<id>.json` so that `/resume <id>` and
 * `--continue` can reload a run mid-flight. Called at four sites in the
 * SA loop:
 *
 *   1. mid-flow after auto-reroute (CAP-019 plan accepted) — persists
 *      so that a crash between iterations is recoverable.
 *   2. success terminal (turn loop ended cleanly).
 *   3. error terminal (catch branch) — CAP-013, includes
 *      `errorMetadata` so the user sees the reason on resume.
 *   4. limit-reached terminal.
 *
 * **Behavior preserved verbatim from FEATURE_100 baseline**:
 * - When `options.session?.storage` is absent, returns immediately
 *   (silent no-op).
 * - When `data.gitRoot` is not provided, falls back to `getGitRoot()`
 *   (a `git rev-parse --show-toplevel` call), then `''` if git fails.
 * - durable extension state is snapshotted via `snapshotRuntimeSessionState`
 *   (drops empty buckets unless a dirty clear must be represented).
 * - `extensionRecords` are cloned at the field level so subsequent in-memory
 *   mutations do not mutate the persisted snapshot.
 *
 * **Storage failure isolation (CAP-013-003 / CAP-SESSION-SNAPSHOT-003)**:
 * `saveSessionSnapshot` absorbs `storage.save` rejections locally and logs
 * diagnostics. `saveRequiredSessionSnapshot` instead propagates failures at
 * Runtime-owned durable boundaries. Ordinary snapshots remain best-effort
 * session continuity, NOT load-bearing for the run's success/failure.
 * Particularly important inside the catch-block cleanup chain
 * (`runCatchCleanup`) where a storage failure would otherwise clobber
 * the original error we are trying to record. Closed in FEATURE_100
 * P3.6a (was P3-deferred during P2 byte-for-byte migration).
 *
 * Migration history: extracted from `agent.ts:844-872` (function) and
 * `agent.ts:3154-3156` (`getGitRoot` private helper) — pre-FEATURE_100
 * baseline — during FEATURE_100 P2. Storage isolation added in P3.6a.
 */

import { exec } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import type { KodaXContentBlock, KodaXMessage } from '@kodax-ai/llm';
import type { KodaXSessionData, KodaXSessionLineage, KodaXSessionRuntimeInfo } from '@kodax-ai/agent';

import type { KodaXOptions, SessionErrorMetadata } from '../../types.js';
import {
  type RuntimeSessionState,
  snapshotRuntimeSessionState,
} from '../runtime-session-state.js';

const execAsync = promisify(exec);

/**
 * v0.7.45 fix — accept optional `cwd` so the git resolution runs in the
 * caller's project directory rather than `process.cwd()`. In-process
 * embedders (KodaX Space) serve multiple projects from a single runtime;
 * without an explicit cwd, the git rev-parse fallback would resolve to
 * the host process's startup directory, mis-tagging all sessions.
 */
async function getGitRoot(cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', {
      cwd,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function normalizeSnapshotPath(value: string | null | undefined): string | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }
  return path.resolve(value).replace(/\\/g, '/');
}

function buildSnapshotRuntimeInfo(
  gitRoot: string,
  executionCwd: string,
  sandboxWorktreeRoots: readonly string[] = [],
): KodaXSessionRuntimeInfo {
  return {
    ...(gitRoot ? { canonicalRepoRoot: gitRoot, workspaceRoot: gitRoot } : {}),
    executionCwd,
    workspaceKind: 'detected',
    ...(sandboxWorktreeRoots.length > 0
      ? { sandboxWorktreeRoots: [...sandboxWorktreeRoots] }
      : {}),
  };
}

/**
 * v0.7.43 — process-level dedup so we warn at most once per session id
 * about the "id-without-storage" silent-noop trap. Keyed by sessionId
 * so legitimately new runs (different ids) each get their own one-shot
 * warning; the same id firing terminal save twice (mid-flow + success)
 * only warns once.
 */
const warnedSessionIds = new Set<string>();

type StartKodaXGeneratedSession = NonNullable<KodaXOptions['session']> & {
  readonly __startKodaXGeneratedId?: true;
};

export function markStartKodaXGeneratedSessionId<T extends NonNullable<KodaXOptions['session']>>(
  session: T,
): T {
  Object.defineProperty(session, '__startKodaXGeneratedId', {
    value: true,
    enumerable: false,
  });
  return session;
}

function hasStartKodaXGeneratedSessionId(session: KodaXOptions['session']): boolean {
  return (session as StartKodaXGeneratedSession | undefined)?.__startKodaXGeneratedId === true;
}

function contentBlocks(message: KodaXMessage): readonly KodaXContentBlock[] {
  return Array.isArray(message.content) ? message.content : [];
}

function collectToolUseIds(message: KodaXMessage): string[] {
  return contentBlocks(message)
    .filter((block) => block.type === 'tool_use')
    .map((block) => block.id);
}

function collectToolResultIds(message: KodaXMessage): string[] {
  return contentBlocks(message)
    .filter((block) => block.type === 'tool_result')
    .map((block) => block.tool_use_id);
}

function isSafeAuthoritativeTranscript(messages: readonly KodaXMessage[]): boolean {
  const firstNonSystem = messages.find((message) => message.role !== 'system');
  if (!firstNonSystem) {
    return false;
  }
  if (firstNonSystem.role !== 'user') {
    return false;
  }

  const pendingToolUseIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const id of collectToolUseIds(message)) {
        pendingToolUseIds.add(id);
      }
      continue;
    }
    if (message.role === 'user') {
      for (const id of collectToolResultIds(message)) {
        if (!pendingToolUseIds.delete(id)) {
          return false;
        }
      }
    }
  }
  return pendingToolUseIds.size === 0;
}

interface SessionSnapshotData {
  messages: KodaXMessage[];
  title: string;
  gitRoot?: string;
  errorMetadata?: SessionErrorMetadata;
  runtimeSessionState?: RuntimeSessionState;
}

async function saveSessionSnapshotWithPolicy(
  options: KodaXOptions,
  sessionId: string,
  data: SessionSnapshotData,
  required: boolean,
): Promise<void> {
  // FEATURE_173 dual-writer fix: when the host (interactive REPL) owns
  // persistence it writes the full lineage / uiHistory / artifactLedger
  // incrementally via `appendSessionDelta`. The runner must NOT also write
  // ROUTINE snapshots — its flat full-rewrite `storage.save` raced the
  // host's appends and regressed `activeEntryId` to the first round on
  // resume (the "resume only loads the first round" report).
  //
  // Error / crash-recovery saves (which carry `errorMetadata`) are the one
  // job the host does NOT replicate, so they bypass the gate and still
  // persist — the storage layer's no-regress guard (mergeAndWriteInternal)
  // keeps them from clobbering the host's lineage. `storage` stays wired so
  // resume / `resolveInitialMessages` can still LOAD.
  //
  // Headless callers (print CLI, ACP, SDK) leave `persistedByHost` unset and
  // remain the sole writer for every save — unchanged behaviour.
  if (options.session?.persistedByHost && !data.errorMetadata) {
    return;
  }

  if (!options.session?.storage) {
    if (required) {
      throw new Error(
        `Durable managed Run persistence requires session.storage for session "${sessionId}".`,
      );
    }
    // v0.7.43 — when an SDK embedder supplies `session.id` but no
    // `session.storage`, the run completes successfully but nothing
    // lands on disk; the embedder's "sessions" UI silently stays empty.
    // Surface this once per id so onboarding consumers learn the
    // explicit-injection contract before they ship a buggy popout.
    //
    // The CLI is unaffected — it always wires FileSessionStorage, so
    // this branch is unreachable for the standalone `kodax` binary.
    if (
      options.session?.id
      && !hasStartKodaXGeneratedSessionId(options.session)
      && !warnedSessionIds.has(options.session.id)
    ) {
      warnedSessionIds.add(options.session.id);
      emitKodaXDiagnostic({
        source: 'coding:session-snapshot',
        level: 'warn',
        message:
          `[KodaX SDK] session.id="${options.session.id}" was provided but session.storage is undefined — ` +
          `session snapshots will NOT be persisted. To persist, pass a storage instance: ` +
          `import { createSessionManager } from '@kodax-ai/kodax/session'; ` +
          `const { storage } = createSessionManager(); ` +
          `runKodaX({ session: { id, storage, ... }, ... }, prompt);  ` +
          `See public_docs/sdk/embedder-guide.md §6.`,
      });
    }
    return;
  }

  // v0.7.45 fix — 3-tier gitRoot resolution. Previously the middleware
  // only honored `data.gitRoot` and fell straight through to a
  // process.cwd()-bound `git rev-parse`, which mis-tagged sessions in
  // in-process multi-project embedders (KodaX Space ADR-003): the host
  // ran from its own directory but the user had opened a different
  // project, and every session ended up labeled with the host's git
  // root instead of the project's.
  //
  // Resolution order:
  //   1. `data.gitRoot` — explicit override (highest priority; existing API).
  //   2. `options.context.gitRoot` — the canonical SDK context field
  //      callers already populate (used by tool-execution-context.ts,
  //      repo-intelligence.ts, run-substrate.ts repo routing). This tier
  //      closes the bug independently of the call-site fix.
  //   3. `getGitRoot(executionCwd)` — fallback git rev-parse, now run in
  //      the SDK consumer's executionCwd rather than process.cwd().
  //   4. `''` — empty string when git resolution fails (legacy behavior).
  let messagesToPersist = data.messages;
  let lineageToPreserve: KodaXSessionLineage | undefined;
  let extensionStateToPersist: KodaXSessionData['extensionState'];
  let extensionRecordsToPersist: KodaXSessionData['extensionRecords'];
  let shouldUseRuntimeSessionSnapshot = true;
  if (data.errorMetadata && !isSafeAuthoritativeTranscript(data.messages)) {
    shouldUseRuntimeSessionSnapshot = false;
    try {
      const existing = await options.session.storage.load(sessionId);
      if (existing) {
        messagesToPersist = existing.messages;
        lineageToPreserve = existing.lineage;
        extensionStateToPersist = existing.extensionState
          ? structuredClone(existing.extensionState)
          : undefined;
        extensionRecordsToPersist = existing.extensionRecords?.map((record) => ({ ...record }));
      } else {
        // No clean persisted state exists yet: record the error metadata, but
        // do not promote the unsafe provider fragment into authoritative history.
        messagesToPersist = [];
        lineageToPreserve = undefined;
        extensionStateToPersist = undefined;
        extensionRecordsToPersist = undefined;
      }
    } catch {
      messagesToPersist = [];
      lineageToPreserve = undefined;
      extensionStateToPersist = undefined;
      extensionRecordsToPersist = undefined;
    }
  }

  const executionCwd = normalizeSnapshotPath(
    options.context?.executionCwd
    ?? options.context?.gitRoot
    ?? process.cwd(),
  ) ?? process.cwd().replace(/\\/g, '/');
  const gitRoot =
    data.gitRoot
    ?? options.context?.gitRoot
    ?? (await getGitRoot(executionCwd))
    ?? '';
  const runtimeInfo = buildSnapshotRuntimeInfo(
    gitRoot,
    executionCwd,
    options.context?.workspaceSandboxRoots?.list(),
  );
  const runtimeSessionSnapshot = data.runtimeSessionState
    ? snapshotRuntimeSessionState(data.runtimeSessionState)
    : undefined;
  if (shouldUseRuntimeSessionSnapshot) {
    extensionStateToPersist = runtimeSessionSnapshot?.extensionState;
    extensionRecordsToPersist = runtimeSessionSnapshot?.extensionRecords;
  }
  // CAP-013-003 / CAP-SESSION-SNAPSHOT-003: storage failures are absorbed
  // here so a transient backend issue (disk full, FS permission, race) cannot
  // mask the caller's original error nor abort an otherwise-successful run.
  // Snapshots are best-effort; resume just won't see the latest state.
  try {
    await options.session.storage.save(sessionId, {
      messages: messagesToPersist,
      title: data.title,
      gitRoot,
      runtimeInfo,
      tag: options.session.tag,
      scope: options.session.scope ?? 'user',
      errorMetadata: data.errorMetadata,
      ...(lineageToPreserve !== undefined ? { lineage: lineageToPreserve } : {}),
      extensionState: extensionStateToPersist,
      extensionRecords: extensionRecordsToPersist,
    });
  } catch (storageError) {
    emitKodaXDiagnostic({
      source: 'coding:session-snapshot',
      level: 'error',
      message: required
        ? 'storage.save failed at a required canonical Session boundary.'
        : 'storage.save failed; continuing without snapshot persistence.',
      detail: storageError,
    });
    if (required) throw storageError;
  }
}

/** Best-effort snapshot used by ordinary SDK and error-cleanup paths. */
export async function saveSessionSnapshot(
  options: KodaXOptions,
  sessionId: string,
  data: SessionSnapshotData,
): Promise<void> {
  await saveSessionSnapshotWithPolicy(options, sessionId, data, false);
}

/**
 * Required canonical boundary used when Runtime declares itself the Session
 * owner. A published durable lifecycle event must never outrun this write.
 */
export async function saveRequiredSessionSnapshot(
  options: KodaXOptions,
  sessionId: string,
  data: SessionSnapshotData,
): Promise<void> {
  await saveSessionSnapshotWithPolicy(options, sessionId, data, true);
}
