/**
 * Keeps one RepoIntel engine for a Host: starts it when a repository is first
 * opened, watches that it answers and stays within its memory limit, replaces
 * it with growing waits when it fails, and stops it when nothing has used it
 * for a while. Callers never wait on it and never see it fail; what went wrong
 * shows in `status()`.
 */

import { connectRepoIntelEngine, type RepoIntelEngineConnection, type RepoIntelEngineLaunch } from './connection.js';

export type { RepoIntelEngineLaunch } from './connection.js';

export interface RepoIntelSupervisorTiming {
  /** How often the engine is asked for its status. */
  readonly pollMs: number;
  /** How long any request may take before the engine counts as stuck. */
  readonly statusTimeoutMs: number;
  /** How long without use before the engine is stopped. */
  readonly idleMs: number;
  /** The first wait before a restart; it doubles after each failure in a row. */
  readonly restartMinMs: number;
  readonly restartMaxMs: number;
}

export interface RepoIntelSupervisorOptions {
  readonly launch: RepoIntelEngineLaunch;
  /** Where the engine keeps its indexes. */
  readonly storageRoot: string;
  /** The engine stops growing its caches near this. */
  readonly memoryBudgetMb?: number;
  readonly timing?: Partial<RepoIntelSupervisorTiming>;
  /** Engine stderr and supervision events, for the Host's diagnostics. */
  readonly onLog?: (line: string) => void;
}

export type RepoIntelEngineState = 'idle' | 'starting' | 'running' | 'restarting' | 'closed';

export interface RepoIntelSupervisorStatus {
  readonly state: RepoIntelEngineState;
  readonly pid?: number;
  readonly residentBytes?: number;
  readonly roots: readonly string[];
  /** How many times the engine failed and was replaced. */
  readonly restarts: number;
  /** The last thing that went wrong, kept until something else does. */
  readonly problem?: string;
}

export interface RepoIntelSupervisor {
  /** Starts indexing a repository, starting the engine if need be. */
  open(root: string): void;
  /** Tells the engine which files of a repository an edit changed. */
  changed(root: string, paths: readonly string[]): void;
  status(): RepoIntelSupervisorStatus;
  close(): Promise<void>;
}

const DEFAULT_TIMING: RepoIntelSupervisorTiming = {
  pollMs: 5_000,
  statusTimeoutMs: 5_000,
  idleMs: 10 * 60_000,
  restartMinMs: 1_000,
  restartMaxMs: 5 * 60_000,
};
const DEFAULT_MEMORY_BUDGET_MB = 300;
/** Near the budget the engine stops growing; twice past it, it is stuck rather than busy. */
const HARD_LIMIT_FACTOR = 2;
/** An engine that ran this long before failing starts the restart waits over. */
const STABLE_MS = 10 * 60_000;
const MB = 1024 * 1024;

export function createRepoIntelSupervisor(options: RepoIntelSupervisorOptions): RepoIntelSupervisor {
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  const budgetMb = options.memoryBudgetMb ?? DEFAULT_MEMORY_BUDGET_MB;
  const hardLimitBytes = budgetMb * HARD_LIMIT_FACTOR * MB;
  const log = (line: string): void => options.onLog?.(line);
  const roots = new Set<string>();
  let state: RepoIntelEngineState = 'idle';
  let engine: RepoIntelEngineConnection | undefined;
  /** Bumped whenever the engine is dropped, so late callbacks from an old one do nothing. */
  let generation = 0;
  let launching: Promise<void> | undefined;
  let poll: NodeJS.Timeout | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  let polling = false;
  let lastUse = Date.now();
  let startedAt = 0;
  let failuresInRow = 0;
  let restarts = 0;
  let residentBytes: number | undefined;
  let problem: string | undefined;

  const drop = (): RepoIntelEngineConnection | undefined => {
    generation += 1;
    clearInterval(poll);
    clearTimeout(restartTimer);
    poll = undefined;
    restartTimer = undefined;
    residentBytes = undefined;
    const dropped = engine;
    engine = undefined;
    return dropped;
  };

  const fail = (reason: string): void => {
    problem = reason;
    log(`RepoIntel engine: ${reason}`);
    const dead = drop();
    if (dead) void dead.kill().catch((error: unknown) => log(`RepoIntel engine: cannot kill it: ${String(error)}`));
    if (Date.now() - startedAt > STABLE_MS) failuresInRow = 0;
    failuresInRow += 1;
    restarts += 1;
    state = 'restarting';
    const wait = Math.min(timing.restartMaxMs, timing.restartMinMs * 2 ** (failuresInRow - 1));
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (roots.size > 0) launch();
      else state = 'idle';
    }, wait);
    restartTimer.unref();
  };

  const openIn = (connection: RepoIntelEngineConnection, root: string): void => {
    connection.request('workspace.open', { root }, timing.statusTimeoutMs).catch((error: unknown) => {
      if (engine !== connection) return;
      problem = `Cannot index ${root}: ${message(error)}`;
      log(`RepoIntel engine: ${problem}`);
    });
  };

  const watch = (connection: RepoIntelEngineConnection): void => {
    if (Date.now() - lastUse > timing.idleMs) {
      void stopIdle();
      return;
    }
    if (polling) return;
    polling = true;
    const mine = generation;
    connection.request<{ residentBytes?: number | null }>('engine.status', undefined, timing.statusTimeoutMs)
      .then(status => {
        if (mine !== generation) return;
        residentBytes = status.residentBytes ?? undefined;
        if (residentBytes !== undefined && residentBytes > hardLimitBytes) {
          fail(`The engine used ${Math.round(residentBytes / MB)} MB, over its ${Math.round(hardLimitBytes / MB)} MB limit.`);
        }
      }, (error: unknown) => {
        if (mine === generation) fail(`The engine did not answer engine.status: ${message(error)}.`);
      })
      .finally(() => { polling = false; });
  };

  const start = async (mine: number): Promise<void> => {
    const connection = await connectRepoIntelEngine(options.launch, line => log(`RepoIntel engine: ${line}`));
    if (mine !== generation) {
      await connection.stop(timing.statusTimeoutMs);
      return;
    }
    engine = connection;
    startedAt = Date.now();
    void connection.exited.then(reason => { if (engine === connection) fail(`The engine ${reason}.`); });
    await connection.request('initialize', { storageRoot: options.storageRoot, memoryBudgetMb: budgetMb }, timing.statusTimeoutMs);
    if (engine !== connection) return;
    state = 'running';
    for (const root of roots) openIn(connection, root);
    poll = setInterval(() => watch(connection), timing.pollMs);
    poll.unref();
  };

  function launch(): void {
    state = 'starting';
    const mine = generation;
    launching = start(mine)
      .catch((error: unknown) => { if (mine === generation) fail(`The engine cannot start: ${message(error)}.`); })
      .finally(() => { launching = undefined; });
  }

  const stopIdle = async (): Promise<void> => {
    const idle = drop();
    roots.clear();
    failuresInRow = 0;
    state = 'idle';
    log('RepoIntel engine: stopped after idling');
    await idle?.stop(timing.statusTimeoutMs).catch((error: unknown) => log(`RepoIntel engine: cannot stop it: ${message(error)}`));
  };

  const open = (root: string): void => {
    if (state === 'closed') return;
    lastUse = Date.now();
    if (roots.has(root)) return;
    roots.add(root);
    if (state === 'running' && engine) openIn(engine, root);
    else if (state === 'idle') launch();
  };

  return {
    open,
    changed(root, paths) {
      if (state === 'closed') return;
      // Opening a repository sweeps all of it, which covers the edit.
      if (!roots.has(root)) return open(root);
      lastUse = Date.now();
      if (state === 'running') engine?.notify('files.changed', { root, paths });
    },
    status: () => ({
      state,
      ...(engine?.pid === undefined ? {} : { pid: engine.pid }),
      ...(residentBytes === undefined ? {} : { residentBytes }),
      roots: [...roots],
      restarts,
      ...(problem === undefined ? {} : { problem }),
    }),
    async close() {
      if (state === 'closed') return;
      state = 'closed';
      roots.clear();
      const pending = launching;
      const last = drop();
      await pending;
      await last?.stop(timing.statusTimeoutMs).catch((error: unknown) => log(`RepoIntel engine: cannot stop it: ${message(error)}`));
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
