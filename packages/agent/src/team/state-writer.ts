/**
 * FEATURE_125 (v0.7.41) — Team Mode Layer 1: per-instance state broadcast.
 *
 * Each running KodaX session registers a directory under
 * `<agentConfigHome>/instances/<pid>/` containing three files:
 *
 *   meta.json   — written once at registration; cwd / startedAt /
 *                  optional git branch + remote. Static for the session.
 *   state.json  — re-written whenever the session's `currentIntent`,
 *                  `agentPhase`, or active/recently-modified file set
 *                  changes. Read by sibling sessions for context.
 *   heartbeat   — empty file whose mtime is touched on every refresh.
 *                  Sibling sessions use the mtime to declare an instance
 *                  stale (default 30s of no heartbeat → cleanup).
 *
 * Atomic write strategy:
 *   - state.json is written via `<path>.tmp` + `rename()`. On POSIX the
 *     rename is atomic; on Windows it is atomic when source + target sit
 *     on the same filesystem (always true for `<agentConfigHome>/...`).
 *   - heartbeat is touched via `utimesSync()`. Cheap, no rename needed.
 *
 * Lifecycle:
 *   - `createStateWriter` writes meta.json + state.json + heartbeat once,
 *     then starts an interval timer (default 1000ms) that refreshes
 *     state.json and touches heartbeat.
 *   - `update(patch)` shallow-merges the patch into the in-memory state
 *     and flushes immediately so peer sessions see the change at the
 *     next tool boundary, not at the next heartbeat tick.
 *   - `shutdown()` clears the timer, removes the instance directory,
 *     and resolves. Idempotent — safe to call multiple times.
 *
 * Crash recovery:
 *   - If a process is killed mid-run, the directory is left on disk.
 *     The next session's discovery scan (S2, `instance-discovery.ts`)
 *     detects the stale heartbeat and removes the directory.
 *
 * DI-clean: every fs / clock dependency is injectable for hermetic tests.
 */

import { promises as fsPromises } from 'node:fs';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';

import { getAgentConfigPath } from '../runtime/agent-home.js';

/**
 * Live session state surfaced to sibling KodaX sessions. Mirrors the
 * shape documented in `docs/features/v0.7.41.md#feature_125-step-1`.
 */
export interface SessionStateSnapshot {
  readonly agentPhase: 'idle' | 'awaiting_llm' | 'running_tool';
  /** Single-line description of what the agent is currently doing. */
  readonly currentIntent?: string;
  /** Files the session is actively editing right now. */
  readonly activeFiles?: readonly string[];
  /** Files modified in the recent past (sibling sessions read this to detect "their content may be stale"). */
  readonly recentlyModifiedFiles?: readonly RecentlyModifiedFile[];
  /**
   * FEATURE_170 (v0.7.41) — optional one-line summary of the active
   * todo list. Lets sibling sessions display "they're currently
   * working on: <X>" without owning the todo store.
   */
  readonly currentTodoSummary?: CurrentTodoSummary;
  /**
   * v0.7.43 (FEATURE_173 Part B follow-up) — REPL session id
   * (a UUIDv7; older sessions keep `YYYYMMDD_HHMMSS_<suffix>`). Lets `listRunningSessions()` correlate
   * a sibling instance with its `.jsonl` file. Mutable: starts
   * undefined during bootstrap, set after `createInteractiveContext`,
   * re-published on `/new`. Older writers omit this; readers MUST
   * treat as optional.
   */
  readonly sessionId?: string;
}

export interface RecentlyModifiedFile {
  readonly path: string;
  readonly modifiedAt: number;
}

export interface CurrentTodoSummary {
  readonly inProgress?: string;
  readonly pendingCount: number;
  readonly completedCount: number;
}

export interface SessionMeta {
  readonly cwd: string;
  readonly startedAt: number;
  readonly gitBranch?: string;
  readonly gitRemote?: string;
}

/**
 * Stored shape of `state.json` on disk — additive over SessionStateSnapshot.
 *
 * Reader contract (S2 `instance-discovery.ts`): parse the JSON, verify
 * `version === '1'` before reading any other field. On an unknown
 * version, log + skip the instance — this lets a newer writer coexist
 * with an older reader during an in-place upgrade.
 *
 * Fields are camelCase + a nested `meta` object (cwd / startedAt /
 * gitBranch / gitRemote). Do NOT assume the snake_case / flat shape
 * shown in early design-doc drafts — the typed interface here is the
 * ground truth; the doc has been updated to match.
 */
export interface PersistedSessionState extends SessionStateSnapshot {
  readonly version: '1';
  readonly pid: number;
  readonly updatedAt: number;
  readonly meta: SessionMeta;
}

/** Minimal injectable fs surface — lets tests drive the writer without disk I/O. */
export interface StateWriterFs {
  mkdirSync(dirPath: string, options: { recursive: true }): void;
  writeFileSync(filePath: string, data: string): void;
  /** Atomic write helper: writes to `${filePath}.tmp` then renames. */
  atomicWriteSync(filePath: string, data: string): void;
  utimesSync(filePath: string, atime: number, mtime: number): void;
  rmSync(dirPath: string, options: { recursive: true; force: true }): void;
  existsSync(targetPath: string): boolean;
}

const REAL_FS: StateWriterFs = {
  mkdirSync(dirPath, options) {
    nodeFs.mkdirSync(dirPath, options);
  },
  writeFileSync(filePath, data) {
    nodeFs.writeFileSync(filePath, data);
  },
  atomicWriteSync(filePath, data) {
    const tmpPath = `${filePath}.tmp`;
    nodeFs.writeFileSync(tmpPath, data);
    nodeFs.renameSync(tmpPath, filePath);
  },
  utimesSync(filePath, atime, mtime) {
    nodeFs.utimesSync(filePath, atime, mtime);
  },
  rmSync(dirPath, options) {
    nodeFs.rmSync(dirPath, options);
  },
  existsSync(targetPath) {
    return nodeFs.existsSync(targetPath);
  },
};

export interface StateWriterOptions {
  /** Defaults to `process.pid`. Tests / multi-instance fixtures override. */
  readonly pid?: number;
  readonly meta: SessionMeta;
  readonly initialState: SessionStateSnapshot;
  /** Defaults to 1000ms. Tests pass a faster tick. */
  readonly heartbeatIntervalMs?: number;
  /** Defaults to `Date.now`. Tests inject a controllable clock. */
  readonly clock?: () => number;
  /** Defaults to {@link REAL_FS}. Tests inject an in-memory fs. */
  readonly fs?: StateWriterFs;
  /**
   * Root directory under which `<pid>/` is created. Defaults to
   * `getAgentConfigPath('instances')`. Tests can point at a temp dir.
   */
  readonly instancesRoot?: string;
}

export interface StateWriter {
  readonly pid: number;
  readonly instanceDir: string;
  /** Apply a partial update to the in-memory state and flush to disk. */
  update(patch: Partial<SessionStateSnapshot>): void;
  /** Touch the heartbeat and re-write state.json without changing state. */
  refresh(): void;
  /** Stop the interval, remove the instance directory, resolve when done. */
  shutdown(): Promise<void>;
  /** Read-only snapshot of the current state. Useful for tests. */
  getState(): SessionStateSnapshot;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;

/**
 * Construct a writer, register the instance directory, and start the
 * heartbeat interval. Returns synchronously so the caller can rely on
 * `instanceDir` being live the moment the function returns.
 */
export function createStateWriter(options: StateWriterOptions): StateWriter {
  const fs = options.fs ?? REAL_FS;
  const clock = options.clock ?? Date.now;
  const pid = options.pid ?? process.pid;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const instancesRoot = options.instancesRoot ?? getAgentConfigPath('instances');
  const instanceDir = path.join(instancesRoot, String(pid));

  let state: SessionStateSnapshot = options.initialState;
  let shuttingDown = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  function statePath(): string {
    return path.join(instanceDir, 'state.json');
  }
  function metaPath(): string {
    return path.join(instanceDir, 'meta.json');
  }
  function heartbeatPath(): string {
    return path.join(instanceDir, 'heartbeat');
  }

  function writeState(): void {
    if (shuttingDown) return;
    const persisted: PersistedSessionState = {
      version: '1',
      pid,
      updatedAt: clock(),
      meta: options.meta,
      agentPhase: state.agentPhase,
      ...(state.currentIntent !== undefined ? { currentIntent: state.currentIntent } : {}),
      ...(state.activeFiles !== undefined ? { activeFiles: [...state.activeFiles] } : {}),
      ...(state.recentlyModifiedFiles !== undefined
        ? { recentlyModifiedFiles: state.recentlyModifiedFiles.map((f) => ({ ...f })) }
        : {}),
      ...(state.currentTodoSummary !== undefined
        ? { currentTodoSummary: { ...state.currentTodoSummary } }
        : {}),
      ...(state.sessionId !== undefined ? { sessionId: state.sessionId } : {}),
    };
    fs.atomicWriteSync(statePath(), JSON.stringify(persisted, null, 2));
  }

  function touchHeartbeat(): void {
    if (shuttingDown) return;
    const now = clock() / 1000;
    fs.utimesSync(heartbeatPath(), now, now);
  }

  // ─── Registration: create directory + initial files ──────────────────
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(metaPath(), JSON.stringify(options.meta, null, 2));
  // Heartbeat must exist before utimesSync works.
  fs.writeFileSync(heartbeatPath(), '');
  writeState();
  touchHeartbeat();

  // ─── Interval: refresh heartbeat + state every tick ──────────────────
  // Wrap in try/catch so a transient I/O failure (e.g. drive briefly
  // unavailable on Windows) doesn't kill the timer; the next tick
  // retries.
  interval = setInterval(() => {
    try {
      touchHeartbeat();
      // state.json is rewritten so `updatedAt` is fresh — sibling
      // sessions reading our state see a recent timestamp even when
      // the LLM is mid-thought.
      writeState();
    } catch {
      /* swallow; next tick retries */
    }
  }, heartbeatIntervalMs);
  // Don't block process exit on the timer alone.
  interval.unref?.();

  return {
    pid,
    instanceDir,
    update(patch) {
      if (shuttingDown) return;
      state = { ...state, ...patch };
      try {
        writeState();
        touchHeartbeat();
      } catch {
        /* swallow; next interval tick retries */
      }
    },
    refresh() {
      if (shuttingDown) return;
      try {
        writeState();
        touchHeartbeat();
      } catch {
        /* swallow */
      }
    },
    getState() {
      return state;
    },
    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
      try {
        if (fs.existsSync(instanceDir)) {
          fs.rmSync(instanceDir, { recursive: true, force: true });
        }
      } catch {
        /* directory may already be gone (concurrent peer cleanup) */
      }
      // Resolve on the next microtask to give any pending fs operations a chance to settle.
      await Promise.resolve();
    },
  };
}
