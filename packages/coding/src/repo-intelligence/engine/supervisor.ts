/**
 * Keeps one RepoIntel engine for a Host: starts it when a repository is first
 * opened, closes each repository nobody used for a while, and stops the engine
 * when none is left. An engine that exits or stops answering for a sustained
 * time is replaced, with growing waits. An engine that cannot start is tried
 * again on the next use, never by a timer. Memory over the budget is reported,
 * not enforced. Callers never wait on it and never see it fail; what went
 * wrong shows in `status()`.
 */

import { connectRepoIntelEngine, type RepoIntelEngineConnection, type RepoIntelEngineLaunch } from './connection.js';

export type { RepoIntelEngineLaunch } from './connection.js';

export interface RepoIntelSupervisorTiming {
  /** How often the engine is asked for its status. */
  readonly pollMs: number;
  /** How long one status request may take; one late answer is not yet a stuck engine. */
  readonly statusTimeoutMs: number;
  /**
   * How long the engine may go without answering before it counts as stuck.
   * It answers on a normal-priority thread, but a busy machine can still hold it up for a while.
   */
  readonly stuckMs: number;
  /** How long a repository may go unused before it is closed; the engine stops when none is left. */
  readonly idleMs: number;
  /** The first wait before a restart; it doubles after each failure in a row. */
  readonly restartMinMs: number;
  readonly restartMaxMs: number;
}

export interface RepoIntelSupervisorOptions {
  readonly launch: RepoIntelEngineLaunch;
  /** Where the engine keeps its indexes. */
  readonly storageRoot: string;
  /** Memory the engine should stay within; going over it is reported, not enforced. */
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
  /** Starts or keeps indexing a repository, starting the engine if need be. */
  open(root: string): void;
  /** Tells the engine which files of a repository an edit changed. */
  changed(root: string, paths: readonly string[]): void;
  status(): RepoIntelSupervisorStatus;
  close(): Promise<void>;
}

const DEFAULT_TIMING: RepoIntelSupervisorTiming = {
  pollMs: 5_000,
  statusTimeoutMs: 5_000,
  stuckMs: 30_000,
  idleMs: 10 * 60_000,
  restartMinMs: 1_000,
  restartMaxMs: 5 * 60_000,
};
const DEFAULT_MEMORY_BUDGET_MB = 300;
/** The protocol this Host speaks; the engine reports its own from `initialize`. */
export const REPO_INTEL_ENGINE_PROTOCOL = 1;
/** An engine that ran this long before failing starts the restart waits over. */
const STABLE_MS = 10 * 60_000;
const MB = 1024 * 1024;

/** Why an engine's `initialize` answer rules it out, or undefined when this Host can talk to it. */
export function repoIntelEngineProtocolProblem(answer: { readonly protocol?: unknown }): string | undefined {
  if (answer.protocol === REPO_INTEL_ENGINE_PROTOCOL) return undefined;
  const theirs = typeof answer.protocol === 'number' ? `protocol ${answer.protocol}` : 'an unknown protocol';
  return `The engine speaks ${theirs}, but this KodaX needs ${REPO_INTEL_ENGINE_PROTOCOL}. `
    + 'Restart KodaX after an update, or use the engine program built for this KodaX version.';
}

export function createRepoIntelSupervisor(options: RepoIntelSupervisorOptions): RepoIntelSupervisor {
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  const budgetMb = options.memoryBudgetMb ?? DEFAULT_MEMORY_BUDGET_MB;
  const log = (line: string): void => options.onLog?.(line);
  /** Each open repository and when a Run last used it. */
  const roots = new Map<string, number>();
  let state: RepoIntelEngineState = 'idle';
  let engine: RepoIntelEngineConnection | undefined;
  /** Bumped whenever the engine is dropped, so late callbacks from an old one do nothing. */
  let generation = 0;
  let launching: Promise<void> | undefined;
  let poll: NodeJS.Timeout | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  let polling = false;
  let startedAt = 0;
  let lastAnswerAt = 0;
  /** After an engine would not start, the next use tries again only from this time. */
  let retryAt = 0;
  let failuresInRow = 0;
  let restarts = 0;
  let residentBytes: number | undefined;
  let overBudget = false;
  let problem: string | undefined;

  const drop = (): RepoIntelEngineConnection | undefined => {
    generation += 1;
    clearInterval(poll);
    clearTimeout(restartTimer);
    poll = undefined;
    restartTimer = undefined;
    residentBytes = undefined;
    overBudget = false;
    const dropped = engine;
    engine = undefined;
    return dropped;
  };

  /** Records a failure, ends the engine, and gives the wait before the next try. */
  const failed = (reason: string): number => {
    problem = reason;
    log(`RepoIntel engine: ${reason}`);
    const dead = drop();
    if (dead) void dead.kill().catch((error: unknown) => log(`RepoIntel engine: cannot kill it: ${message(error)}`));
    if (Date.now() - startedAt > STABLE_MS) failuresInRow = 0;
    failuresInRow += 1;
    restarts += 1;
    return Math.min(timing.restartMaxMs, timing.restartMinMs * 2 ** (failuresInRow - 1));
  };

  /** A running engine died while Runs use its repositories: bring it back after a wait. */
  const fail = (reason: string): void => {
    const wait = failed(reason);
    state = 'restarting';
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (roots.size > 0) launch();
      else state = 'idle';
    }, wait);
    restartTimer.unref();
  };

  /** The engine would not start: wait for the next use, so a missing program costs nothing meanwhile. */
  const startFailed = (reason: string): void => {
    retryAt = Date.now() + failed(reason);
    state = 'idle';
  };

  const openIn = (connection: RepoIntelEngineConnection, root: string): void => {
    connection.request('workspace.open', { root }, timing.stuckMs).catch((error: unknown) => {
      if (engine !== connection) return;
      problem = `Cannot index ${root}: ${message(error)}`;
      log(`RepoIntel engine: ${problem}`);
    });
  };

  const closeIdleRoots = (connection: RepoIntelEngineConnection, idle: readonly string[]): void => {
    for (const root of idle) {
      roots.delete(root);
      log(`RepoIntel engine: closed ${root} after idling`);
      connection.request('workspace.close', { root }, timing.stuckMs).catch((error: unknown) => {
        if (engine === connection) log(`RepoIntel engine: cannot close ${root}: ${message(error)}`);
      });
    }
  };

  const noteStatus = (status: { residentBytes?: number | null }): void => {
    lastAnswerAt = Date.now();
    const bytes = status.residentBytes ?? undefined;
    residentBytes = bytes;
    const over = bytes !== undefined && bytes > budgetMb * MB;
    if (over && !overBudget) {
      problem = `The engine uses ${Math.round(bytes / MB)} MB, over its ${budgetMb} MB budget.`;
      log(`RepoIntel engine: ${problem}`);
    }
    overBudget = over;
  };

  const watch = (connection: RepoIntelEngineConnection): void => {
    const now = Date.now();
    const idle = [...roots].filter(([, usedAt]) => now - usedAt > timing.idleMs).map(([root]) => root);
    if (idle.length === roots.size) {
      void stopIdle();
      return;
    }
    closeIdleRoots(connection, idle);
    if (polling) return;
    polling = true;
    const mine = generation;
    connection.request<{ residentBytes?: number | null }>('engine.status', undefined, timing.statusTimeoutMs)
      .then(status => { if (mine === generation) noteStatus(status); }, (error: unknown) => {
        if (mine !== generation || Date.now() - lastAnswerAt < timing.stuckMs) return;
        fail(`The engine did not answer engine.status for ${Math.round((Date.now() - lastAnswerAt) / 1000)} s: ${message(error)}.`);
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
    void connection.exited.then(reason => {
      if (engine !== connection) return;
      if (state === 'starting') startFailed(`The engine ${reason}.`);
      else fail(`The engine ${reason}.`);
    });
    const answer = await connection.request<{ protocol?: unknown }>('initialize',
      { storageRoot: options.storageRoot, memoryBudgetMb: budgetMb }, timing.stuckMs);
    if (engine !== connection) return;
    const refused = repoIntelEngineProtocolProblem(answer);
    if (refused !== undefined) {
      startFailed(refused);
      return;
    }
    state = 'running';
    lastAnswerAt = Date.now();
    for (const root of roots.keys()) openIn(connection, root);
    poll = setInterval(() => watch(connection), timing.pollMs);
    poll.unref();
  };

  function launch(): void {
    state = 'starting';
    startedAt = Date.now();
    const mine = generation;
    launching = start(mine)
      .catch((error: unknown) => { if (mine === generation) startFailed(`The engine cannot start: ${message(error)}.`); })
      .finally(() => { launching = undefined; });
  }

  const stopIdle = async (): Promise<void> => {
    const idle = drop();
    roots.clear();
    failuresInRow = 0;
    retryAt = 0;
    state = 'idle';
    log('RepoIntel engine: stopped after idling');
    await idle?.stop(timing.statusTimeoutMs).catch((error: unknown) => log(`RepoIntel engine: cannot stop it: ${message(error)}`));
  };

  const open = (root: string): void => {
    if (state === 'closed') return;
    const known = roots.has(root);
    roots.set(root, Date.now());
    if (state === 'running' && engine) {
      if (!known) openIn(engine, root);
    } else if (state === 'idle' && Date.now() >= retryAt) {
      launch();
    }
  };

  return {
    open,
    changed(root, paths) {
      if (state === 'closed') return;
      // Opening a repository sweeps all of it, which covers the edit.
      if (!roots.has(root)) return open(root);
      roots.set(root, Date.now());
      if (state === 'running') engine?.notify('files.changed', { root, paths });
    },
    status: () => ({
      state,
      ...(engine?.pid === undefined ? {} : { pid: engine.pid }),
      ...(residentBytes === undefined ? {} : { residentBytes }),
      roots: [...roots.keys()],
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
