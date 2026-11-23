import { Command, Option } from 'commander';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import fsSync from 'fs';
import os from 'node:os';
import path from 'path';
import { ensureKodaXRuntime } from '../sdk-runtime.js';
import {
  isRuntimeDaemonOwnerPidAlive,
  isRuntimeDaemonPidAlive,
  observeRuntimeDaemonHealth,
} from '../runtime-daemon/lifecycle.js';
import {
  classifyRuntimeDaemonHealth,
  HOST_STATUS_EXIT_CODES,
  hostHealthState,
  readRuntimeDaemonShutdownOutcome,
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonToken,
  removeRuntimeDaemonOwnershipIfUnchanged,
  isSameRuntimeDaemonPath,
  resolveRuntimeDaemonPaths,
  resolveRuntimeDaemonPathsFromConfigHome,
  resolveRuntimeHostSlot,
  RUNTIME_HOST_SLOT,
  readRuntimeDaemonLogLines,
  followRuntimeDaemonLog,
  type HostHealthState,
  type RuntimeDaemonHealth,
  type RuntimeDaemonPaths,
  type RuntimeDaemonState,
} from '../runtime-daemon/state.js';
import {
  parseOptionalNonNegativeInt,
  mergeCommandOptionsWithGlobals,
  removedHostProfileOption,
} from '../cli_option_helpers.js';
import type { KodaXHostClient } from '../host-protocol/host-client.js';
import { killPidTree, readProcessStartIdentity } from '@kodax-ai/agent';
import { KODAX_DIR } from '@kodax-ai/repl';
import { configureKodaXDeviceCommands, connectHostOwner } from '../device-cli.js';
import type { HostResult } from '../host-protocol/methods.js';
import { version } from '../cli-version.js';
import { delay, normalizeCliError } from './util.js';
import { HELP_DAEMON_HOME } from './root.js';
import { serveDaemonCommand } from './host-serve.js';

function resolveDefaultRuntimeDaemonHomeDir(): string {
  return os.homedir();
}

export function resolveCliRuntimeDaemonLocation(
  homeDir: string | undefined,
  configHome?: string,
): { readonly homeDir: string; readonly configHome: string } {
  const resolvedHome = path.resolve(
    homeDir ?? resolveDefaultRuntimeDaemonHomeDir(),
  );
  return {
    homeDir: resolvedHome,
    configHome: path.resolve(
      configHome ??
        (homeDir === undefined ? KODAX_DIR : path.join(resolvedHome, '.kodax')),
    ),
  };
}

interface DaemonStartResult {
  readonly started: boolean;
  readonly reason?: 'already_running';
  readonly pid?: number | null;
  readonly health?: HostHealthState;
  readonly error?: string;
  readonly state: RuntimeDaemonState | null;
}

interface DaemonStopResult {
  readonly stopped: boolean;
  readonly reason?:
    | HostHealthState
    | 'unverified_owner'
    | 'cleanup_failed'
    | 'cleanup_unverified'
    | 'replacement_running';
  readonly forced?: boolean;
  /** A distinct live owner was observed after the requested daemon exited. */
  readonly replacementRunning?: boolean;
  readonly health?: HostHealthState;
  readonly error?: string;
  readonly state: RuntimeDaemonState | null;
}

interface DaemonRestartResult {
  readonly restarted: boolean;
  readonly stop: DaemonStopResult;
  readonly start: DaemonStartResult;
}

interface DaemonLogsResult {
  readonly profile: string;
  readonly logFile: string;
  readonly exists: boolean;
  readonly lines: readonly string[];
}

interface HostStatusSummary {
  readonly clients: number;
  readonly sessions: number;
  readonly runs: number;
  readonly activeRuns: number;
  readonly queuedRuns: number;
  /** Permission requests and questions waiting for an answer. */
  readonly pendingInteractions: number;
  readonly workflows: number;
}

type HostStatusSummaryProbe =
  | { readonly ok: true; readonly summary: HostStatusSummary }
  | { readonly ok: false; readonly error: string };

interface CliRuntimeSurfaceStatus {
  readonly mode: 'embedded' | 'daemon';
  readonly runtimeId: string;
  readonly profile: string;
  readonly startedAt?: string;
  readonly endpoint?: string;
  readonly health?: string;
  readonly sessions?: number;
  readonly runs?: number;
  readonly activeRuns?: number;
  readonly queuedRuns?: number;
  readonly pendingPermissions?: number;
  readonly workflows?: number;
}

async function printDaemonStatus(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly json: boolean;
}): Promise<void> {
  const paths = resolveRuntimeDaemonPathsFromConfigHome(
    input.configHome,
    input.profile,
  );
  const observation = await observeRuntimeDaemonHealth(paths);
  const health = hostHealthState(classifyRuntimeDaemonHealth(observation), observation.state);
  const runtimeStatus = await readHostStatusSummary(paths, observation.state, health);
  const snapshot = {
    profile: paths.profile,
    health,
    state: observation.state ?? null,
    pidAlive: observation.pidAlive,
    endpointReachable: observation.endpointReachable,
    identityMatches: observation.identityMatches,
    stateFile: paths.stateFile,
    lockFile: paths.lockFile,
    ...(runtimeStatus !== null ? { runtime: runtimeStatus } : {}),
  };
  process.exitCode = HOST_STATUS_EXIT_CODES[health];
  if (input.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  console.log(chalk.cyan('\nKodaX Host\n'));
  console.log(`Health: ${formatHostHealth(health)}`);
  if (snapshot.state) {
    console.log(`Host: ${snapshot.state.runtimeId}`);
    console.log(
      `PID: ${snapshot.state.pid} (${snapshot.pidAlive ? 'alive' : 'not alive'})`,
    );
    console.log(
      `Endpoint: ${snapshot.state.endpoint} (${snapshot.endpointReachable ? 'reachable' : 'unreachable'})`,
    );
  }
  if (runtimeStatus?.ok === true) {
    const summary = runtimeStatus.summary;
    console.log(`Clients: ${summary.clients}`);
    console.log(`Sessions: ${summary.sessions}`);
    console.log(`Runs: ${summary.runs} (${summary.activeRuns} active, ${summary.queuedRuns} queued)`);
    console.log(`Waiting for an answer: ${summary.pendingInteractions}`);
    console.log(`Workflows: ${summary.workflows}`);
  } else if (runtimeStatus?.ok === false) {
    console.log(chalk.yellow(`Counts unavailable: ${runtimeStatus.error}`));
  }
  if (HOST_STATUS_EXIT_CODES[health] === 3) console.log('Start it with `kodax host start`.');
  console.log(chalk.dim(`State file: ${snapshot.stateFile}`));
}

/** The Host's counts over a v2 probe, which neither counts as a client nor keeps an idle Host running. */
async function readHostStatusSummary(
  paths: RuntimeDaemonPaths,
  state: RuntimeDaemonState | undefined,
  health: HostHealthState,
): Promise<HostStatusSummaryProbe | null> {
  if (state === undefined || HOST_STATUS_EXIT_CODES[health] !== 0) return null;
  try {
    const token = readRuntimeDaemonToken(paths);
    if (token === undefined) throw new Error('The Host token file is missing.');
    const rpc = await connectHostOwner(state, token, version, 'probe');
    try {
      const [{ counts }, preflight] = await Promise.all([
        rpc.request('host.get') as Promise<HostResult<'host.get'>>,
        rpc.request('host.preflight') as Promise<HostResult<'host.preflight'>>,
      ]);
      return {
        ok: true,
        summary: { clients: preflight.clients.length, ...counts, pendingInteractions: preflight.pendingInteractions },
      };
    } finally {
      rpc.close();
    }
  } catch (error: unknown) {
    return { ok: false, error: normalizeCliError(error).message };
  }
}

export async function getReplHostStatus(
  client: KodaXHostClient<'local'>,
  configHome: string,
): Promise<CliRuntimeSurfaceStatus> {
  const [{ host, counts }, interactions] = await Promise.all([
    client.call('host.get'),
    client.call('interaction.list', {}),
  ]);
  const observation = await observeRuntimeDaemonHealth(
    resolveRuntimeDaemonPathsFromConfigHome(configHome, host.profile),
  );
  const endpoint = observation.state?.endpoint;
  return {
    mode: host.mode === 'embedded' ? 'embedded' : 'daemon',
    runtimeId: host.id,
    profile: host.profile,
    startedAt: new Date(host.startedAt).toISOString(),
    ...(endpoint !== undefined ? { endpoint } : {}),
    health: hostHealthState(classifyRuntimeDaemonHealth(observation), observation.state),
    sessions: counts.sessions,
    runs: counts.runs,
    activeRuns: counts.activeRuns,
    queuedRuns: counts.queuedRuns,
    pendingPermissions: interactions.items.filter((item) => item.kind === 'permission').length,
    workflows: counts.workflows,
  };
}

async function startDaemonCommand(input: {
  readonly homeDir: string;
  readonly configHome: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly json: boolean;
}): Promise<void> {
  const result = await getDaemonStartResult(input);
  if (input.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  // The serving Host can belong to another profile that owns Session storage (Issue 406).
  const profile = result.state?.profile ?? RUNTIME_HOST_SLOT;
  if (result.reason === 'already_running') {
    console.log(chalk.green(`The KodaX Host is already running${hostSlotNote(profile)}.`));
    return;
  }
  if (result.health !== 'ready') {
    throw new Error(
      result.error ??
        `The KodaX Host did not become ready within ${input.timeoutMs}ms.`,
    );
  }
  console.log(chalk.green(`The KodaX Host started${hostSlotNote(profile)}.`));
  if (result.state) {
    console.log(chalk.dim(`PID: ${result.state.pid}`));
    console.log(chalk.dim(`Endpoint: ${result.state.endpoint}`));
  }
}

async function getDaemonStartResult(input: {
  readonly homeDir: string;
  readonly configHome: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
}): Promise<DaemonStartResult> {
  // Startup follows a live Session storage owner of another profile; snapshot that Host (Issue 406).
  const beforePaths = resolveRuntimeDaemonPathsFromConfigHome(input.configHome, daemonHostSlot(input.configHome));
  const before = await observeRuntimeDaemonHealth(beforePaths);
  // Initial integration reconciliation holds the owner fence before publishing
  // daemon.json. A later authenticated attach to that exact owner is reuse.
  const beforeOwner = before.state === undefined
    ? readRuntimeDaemonLockOwner(beforePaths.lockFile)
    : undefined;
  const cancellation = createDaemonStartupCancellation();
  try {
    const runtime = await ensureKodaXRuntime({
      // Omitted Home retains the existing KODAX_HOME override for the default location.
      homeDir: isSameRuntimeDaemonPath(input.configHome, path.join(input.homeDir, '.kodax')) ? input.homeDir : undefined,
      defaultProvider: input.provider,
      defaultModel: input.model,
      daemonStartupTimeoutMs: input.timeoutMs,
      daemonStartupSignal: cancellation.signal,
      daemonLifecycle: 'persistent',
      clientInfo: { name: 'kodax-daemon-start', clientType: 'automation' },
    });
    try {
      const observation = await observeRuntimeDaemonHealth(
        resolveRuntimeDaemonPathsFromConfigHome(input.configHome, runtime.identity.profile));
      if (!observation.state || observation.state.runtimeId !== runtime.identity.runtimeId
        || observation.state.status !== 'ready' || !observation.identityMatches) {
        throw new Error('The Host owner changed while startup was being verified. Retry startup.');
      }
      const existingOwner = before.state ?? (beforeOwner?.kind === 'daemon' ? beforeOwner : undefined);
      return existingOwner?.runtimeId === runtime.identity.runtimeId
        && existingOwner.pid === observation.state.pid
        ? { started: false, reason: 'already_running', state: observation.state }
        : { started: true, pid: observation.state?.pid ?? null, health: 'ready', state: observation.state };
    } finally { await runtime.close(); }
  } finally {
    cancellation.close();
  }
}

/** Names a legacy-slot Host (Issue 406); the usual slot needs no mention. */
function hostSlotNote(profile: string): string {
  return profile === RUNTIME_HOST_SLOT ? '' : ` (legacy slot "${profile}")`;
}

/** daemon commands act on the Host serving this home, which may be a legacy-slot Host (Issues 406, 407). */
function daemonHostSlot(configHome: string): string {
  return resolveRuntimeHostSlot(configHome, path.join(configHome, 'sessions'));
}

/** stop, status, logs and restart address the Host serving this home, not a requested slot. */
function daemonHostLocation(homeDir: string | undefined): { readonly profile: string; readonly homeDir: string; readonly configHome: string } {
  const location = resolveCliRuntimeDaemonLocation(homeDir);
  return { ...location, profile: daemonHostSlot(location.configHome) };
}

async function stopDaemonCommand(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly timeoutMs: number;
  readonly force: boolean;
  readonly json: boolean;
}): Promise<void> {
  const paths = resolveRuntimeDaemonPathsFromConfigHome(
    input.configHome,
    input.profile,
  );
  const result = await getDaemonStopResult(input);
  if (input.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.reason === 'cleanup_failed' || result.reason === 'cleanup_unverified') {
    throw new Error(
      result.error ?? `KodaX Host stop ${result.reason.replace('_', ' ')}.`,
    );
  }
  if (result.reason === 'replacement_running') {
    throw new Error(`The KodaX Host exited, but another Host now serves this home${hostSlotNote(paths.profile)}.`);
  }
  if (result.reason === 'unverified_owner') {
    throw new Error(
      `Refusing to force stop the KodaX Host${hostSlotNote(paths.profile)}: its ownership could not be verified.`,
    );
  }
  if (result.reason !== undefined) {
    console.log(chalk.yellow(`No running KodaX Host to stop (${result.reason}).`));
    return;
  }
  if (!result.stopped) {
    throw new Error(`The KodaX Host did not stop within ${input.timeoutMs}ms.`);
  }
  console.log(chalk.green(`The KodaX Host stopped${hostSlotNote(paths.profile)}.`));
}

async function getDaemonStopResult(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly timeoutMs: number;
  readonly force?: boolean;
}): Promise<DaemonStopResult> {
  const paths = resolveRuntimeDaemonPathsFromConfigHome(
    input.configHome,
    input.profile,
  );
  const observation = await observeRuntimeDaemonHealth(paths);
  const health = classifyRuntimeDaemonHealth(observation);
  if (health !== 'healthy' || !observation.state) {
    if (input.force === true) {
      return forceStopDaemonOwnership(paths, health, observation.state ?? null);
    }
    return {
      stopped: false,
      reason: hostHealthState(health, observation.state),
      state: observation.state ?? null,
    };
  }

  const stoppedState = observation.state;
  const stoppedOwner = readRuntimeDaemonLockOwner(paths.lockFile);
  if (
    stoppedOwner === undefined
    || stoppedOwner.runtimeId !== stoppedState.runtimeId
    || stoppedOwner.pid !== stoppedState.pid
  ) {
    return {
      stopped: false,
      reason: 'unverified_owner',
      state: stoppedState,
    };
  }
  const expectedProcessStartIdentity = readProcessStartIdentity(stoppedState.pid);
  await waitForDaemonStopObservationReleaseForTest(input.timeoutMs);
  const token = readRuntimeDaemonToken(paths);
  if (token === undefined) throw new Error('The Host token file is missing, so the Host cannot be asked to stop.');
  const rpc = await connectHostOwner(stoppedState, token, version);
  let transportCloseError: Error | undefined;
  let stopAcceptedAt: number | undefined;
  try {
    if (rpc.handshake.host.id !== stoppedState.runtimeId) {
      throw new Error('The Host changed before the stop request; refusing to stop the Host that replaced it.');
    }
    await rpc.request('host.stop', { requestId: randomUUID() });
    stopAcceptedAt = Date.now();
  } finally {
    const closeDeadline = (stopAcceptedAt ?? Date.now()) + input.timeoutMs;
    transportCloseError = await closeDaemonStopTransportWithin(
      async () => { rpc.close(); await rpc.closed; },
      Math.max(0, closeDeadline - Date.now()),
    );
  }
  const deadline = (stopAcceptedAt ?? Date.now()) + input.timeoutMs;
  let processExited = await waitForDaemonProcessExit(
    stoppedState.pid,
    Math.max(0, deadline - Date.now()),
  );
  let watchdogStatus: Awaited<ReturnType<typeof killPidTree>>['status'] | undefined;
  if (!processExited && expectedProcessStartIdentity !== undefined) {
    watchdogStatus = (await killPidTree(stoppedState.pid, {
      expectedProcessStartIdentity,
    })).status;
    processExited = await waitForDaemonProcessExit(stoppedState.pid, 1_000);
  }
  const containmentAvailable = process.platform !== 'win32'
    || stoppedOwner.processContainment === 'windows-job';
  const containmentExited = process.platform !== 'win32'
    || (stoppedOwner.processContainment === 'windows-job'
      && stoppedOwner.supervisorPid !== undefined
      && await waitForDaemonProcessExit(
        stoppedOwner.supervisorPid,
        Math.max(0, deadline - Date.now()),
      ));
  const outcome = processExited
    ? readRuntimeDaemonShutdownOutcome(paths, stoppedState)
    : undefined;
  const outcomeMatches = outcome?.runtimeId === stoppedState.runtimeId
    && outcome.pid === stoppedState.pid;
  const requestedDaemonStopped = processExited
    && containmentAvailable
    && containmentExited
    && outcomeMatches
    && outcome.status === 'succeeded';
  let after = await observeRuntimeDaemonHealth(paths);
  let afterHealth = classifyRuntimeDaemonHealth(after);
  if (
    processExited
    && (afterHealth === 'missing' || afterHealth === 'stale')
    && (after.state === undefined
      || (after.state.runtimeId === stoppedState.runtimeId
        && after.state.pid === stoppedState.pid))
  ) {
    forceStopDaemonOwnership(paths, afterHealth, after.state ?? null);
    after = await observeRuntimeDaemonHealth(paths);
    afterHealth = classifyRuntimeDaemonHealth(after);
  }
  const currentLockOwner = readRuntimeDaemonLockOwner(paths.lockFile);
  const replacementRunning = currentLockOwner !== undefined
    && isRuntimeDaemonOwnerPidAlive(
      currentLockOwner.pid, currentLockOwner.processStartIdentity, currentLockOwner.pidNamespace)
    && (currentLockOwner.runtimeId !== stoppedState.runtimeId
      || currentLockOwner.pid !== stoppedState.pid);
  if (replacementRunning && afterHealth === 'missing') afterHealth = 'unhealthy';
  const cleanupReason = requestedDaemonStopped
    ? undefined
    : outcomeMatches && outcome.status === 'failed'
      ? 'cleanup_failed' as const
      : 'cleanup_unverified' as const;
  const cleanupError = outcomeMatches && outcome.status === 'failed'
    ? outcome.error
    : processExited && !containmentAvailable
      ? 'Runtime daemon exited, but Windows Job containment metadata is unavailable.'
      : processExited && !containmentExited
        ? 'Runtime daemon exited, but its Windows Job containment supervisor did not confirm an empty process tree.'
        : processExited
          ? 'Runtime daemon exited without a verifiable successful cleanup outcome.'
          : expectedProcessStartIdentity === undefined
            ? 'Runtime daemon did not exit and its exact process identity is unavailable.'
            : process.platform === 'win32'
              ? `Runtime daemon did not exit after exact process-tree cleanup (${watchdogStatus ?? 'not-attempted'}).`
              : 'Runtime daemon did not exit; unsafe POSIX cached-PID escalation was refused.';
  const result: DaemonStopResult = {
    stopped: requestedDaemonStopped && !replacementRunning,
    ...(replacementRunning ? { replacementRunning: true } : {}),
    ...(cleanupReason === undefined && !replacementRunning ? {} : {
      reason: cleanupReason ?? 'replacement_running',
    }),
    ...(cleanupReason === undefined ? {} : {
      error: transportCloseError === undefined
        ? cleanupError
        : `${cleanupError} Stop transport cleanup also failed: ${transportCloseError.message}`,
    }),
    health: hostHealthState(afterHealth, after.state),
    state: after.state ?? null,
  };
  return result;
}

async function waitForDaemonStopObservationReleaseForTest(timeoutMs: number): Promise<void> {
  const markerFile = process.env.KODAX_INTERNAL_DAEMON_TEST_STOP_OBSERVED_FILE;
  if (markerFile === undefined) return;
  fsSync.writeFileSync(markerFile, `${process.pid}\n`, 'utf8');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { fsSync.statSync(markerFile); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for test to release daemon stop observation after ${timeoutMs}ms.`);
    }
    await delay(Math.min(50, remaining));
  }
}

async function closeDaemonStopTransportWithin(
  close: () => void | Promise<void> | undefined,
  timeoutMs: number,
): Promise<Error | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = await Promise.race([
      Promise.resolve().then(close).then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    return timedOut
      ? new Error(`Stop transport cleanup timed out after ${timeoutMs}ms.`)
      : undefined;
  } catch (error: unknown) {
    return normalizeCliError(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function forceStopDaemonOwnership(
  paths: ReturnType<typeof resolveRuntimeDaemonPaths>,
  health: RuntimeDaemonHealth,
  state: RuntimeDaemonState | null,
): DaemonStopResult {
  if (health === 'missing') {
    const lockOwner = readRuntimeDaemonLockOwner(paths.lockFile);
    if (lockOwner && isRuntimeDaemonOwnerPidAlive(lockOwner.pid, lockOwner.processStartIdentity, lockOwner.pidNamespace)) {
      return {
        stopped: false,
        forced: true,
        reason: 'unverified_owner',
        health: hostHealthState(health, state ?? undefined),
        state,
      };
    }
    if (
      !removeRuntimeDaemonOwnershipIfUnchanged(paths, {
        ...(lockOwner !== undefined ? { lockOwner } : {}),
      })
    ) {
      return {
        stopped: false,
        forced: true,
        reason: 'unverified_owner',
        health: hostHealthState(health, state ?? undefined),
        state,
      };
    }
    return {
      stopped: true,
      forced: true,
      health: 'stopped',
      state: null,
    };
  }
  if (health === 'stale') {
    const lockOwner = readRuntimeDaemonLockOwner(paths.lockFile);
    if (
      state === null ||
      (lockOwner !== undefined &&
        (lockOwner.runtimeId !== state.runtimeId ||
          lockOwner.pid !== state.pid)) ||
      !removeRuntimeDaemonOwnershipIfUnchanged(paths, {
        state,
        ...(lockOwner !== undefined ? { lockOwner } : {}),
      })
    ) {
      return {
        stopped: false,
        forced: true,
        reason: 'unverified_owner',
        health: hostHealthState(health, state ?? undefined),
        state,
      };
    }
    return {
      stopped: true,
      forced: true,
      health: 'stopped',
      state: null,
    };
  }
  return {
    stopped: false,
    forced: true,
    reason: 'unverified_owner',
    health: hostHealthState(health, state ?? undefined),
    state,
  };
}

async function restartDaemonCommand(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly json: boolean;
}): Promise<void> {
  const result = await getDaemonRestartResult(input);
  if (input.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const paths = resolveRuntimeDaemonPathsFromConfigHome(
    input.configHome,
    input.profile,
  );
  if (!result.restarted) {
    throw new Error(
      result.stop.error ?? `The KodaX Host could not be restarted (${result.stop.reason ?? result.start.health ?? 'not started'}).`,
    );
  }
  console.log(chalk.green(`The KodaX Host restarted${hostSlotNote(paths.profile)}.`));
  if (result.start.state) {
    console.log(chalk.dim(`PID: ${result.start.state.pid}`));
    console.log(chalk.dim(`Endpoint: ${result.start.state.endpoint}`));
  }
}

async function getDaemonRestartResult(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
}): Promise<DaemonRestartResult> {
  const stop = await getDaemonStopResult(input);
  // A Host that is not running, or whose process is gone, is simply started.
  const notRunning = stop.reason === 'stopped' || stop.reason === 'stale';
  if (!stop.stopped && !notRunning) {
    return {
      restarted: false,
      stop,
      start: {
        started: false,
        ...(stop.health !== undefined ? { health: stop.health } : {}),
        state: stop.state,
      },
    };
  }
  const start = await getDaemonStartResult(input);
  return {
    restarted: start.started === true || start.reason === 'already_running',
    stop,
    start,
  };
}

async function printDaemonLogs(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly lines: number;
  readonly json: boolean;
  readonly follow: boolean;
}): Promise<void> {
  if (input.follow && input.json) {
    throw new Error('--follow prints the log lines as they arrive, which are JSON already; leave out --json.');
  }
  const result = readDaemonLogs(input);
  if (input.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(chalk.cyan(`KodaX Host log${hostSlotNote(result.profile)}`));
  console.log(chalk.dim(result.logFile));
  if (!result.exists) console.log(chalk.yellow('The Host has not written a log yet.'));
  for (const line of result.lines) {
    console.log(line);
  }
  if (!input.follow) return;
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  await followRuntimeDaemonLog(
    resolveRuntimeDaemonPathsFromConfigHome(input.configHome, input.profile),
    line => console.log(line),
    stop.signal,
  );
}

function readDaemonLogs(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly lines: number;
}): DaemonLogsResult {
  const paths = resolveRuntimeDaemonPathsFromConfigHome(
    input.configHome,
    input.profile,
  );
  if (!fsSync.existsSync(paths.logFile)) {
    return {
      profile: paths.profile,
      logFile: paths.logFile,
      exists: false,
      lines: [],
    };
  }
  return {
    profile: paths.profile,
    logFile: paths.logFile,
    exists: true,
    lines: input.lines <= 0 ? [] : readRuntimeDaemonLogLines(paths).slice(-input.lines),
  };
}

async function waitForDaemonProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isRuntimeDaemonPidAlive(pid)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await delay(Math.min(100, remainingMs));
  }
  return true;
}

function createDaemonStartupCancellation(): {
  readonly signal: AbortSignal;
  close(): void;
} {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  return {
    signal: controller.signal,
    close() {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    },
  };
}

function formatHostHealth(health: HostHealthState): string {
  if (health === 'ready') return chalk.green(health);
  if (HOST_STATUS_EXIT_CODES[health] === 0 || health === 'stale') return chalk.yellow(health);
  if (health === 'stopped') return chalk.dim(health);
  return chalk.red(health);
}

/** `kodax host`, with `kodax daemon` kept as a hidden alias until 0.7.100 (FEATURE_318). */
export function configureKodaXHostCommand(program: Command): Command {
  const host = configureHostCommandGroup(program.command('host'), 'host');
  configureHostCommandGroup(program.command('daemon', { hidden: true }), 'daemon')
    .hook('preAction', () => {
      process.stderr.write('`kodax daemon` is now `kodax host`; the `daemon` name is removed in 0.7.100.\n');
    });
  return host;
}

function configureHostCommandGroup(daemonCommand: Command, name: string): Command {
  daemonCommand
    .description('Run and manage the local KodaX Host')
    .helpOption('-h, --help', 'Show Host help');

  daemonCommand
    .command('start')
    .description('Start the Host in the background')
    .addOption(removedHostProfileOption(`kodax ${name} start`))
    .option(
      '--home <dir>',
      HELP_DAEMON_HOME,
    )
    .option('-m, --provider <name>', 'Default provider for hosted runs')
    .option('--model <name>', 'Default model for hosted runs')
    .option(
      '--timeout-ms <n>',
      'Milliseconds to wait for the Host to become ready',
      parseOptionalNonNegativeInt,
      5_000,
    )
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (
        localOptions: {
          home?: string;
          provider?: string;
          model?: string;
          timeoutMs?: number;
          json?: boolean;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        await startDaemonCommand({
          ...resolveCliRuntimeDaemonLocation(options.home),
          provider: options.provider,
          model: options.model,
          timeoutMs: options.timeoutMs ?? 5_000,
          json: options.json === true,
        });
      },
    );

  daemonCommand
    .command('stop')
    .description('Stop the Host')
    .addOption(removedHostProfileOption(`kodax ${name} stop`))
    .option(
      '--home <dir>',
      HELP_DAEMON_HOME,
    )
    .option(
      '--timeout-ms <n>',
      'Milliseconds to wait for the Host to stop',
      parseOptionalNonNegativeInt,
      5_000,
    )
    .option(
      '--force',
      'Clean up verified stale Host ownership without killing unverified live processes',
    )
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (subOpts: {
        home?: string;
        timeoutMs?: number;
        force?: boolean;
        json?: boolean;
      }) => {
        await stopDaemonCommand({
          ...daemonHostLocation(subOpts.home),
          timeoutMs: subOpts.timeoutMs ?? 5_000,
          force: subOpts.force === true,
          json: subOpts.json === true,
        });
      },
    );

  daemonCommand
    .command('restart')
    .description('Stop the Host and start it again; start it when it is not running')
    .addOption(removedHostProfileOption(`kodax ${name} restart`))
    .option(
      '--home <dir>',
      HELP_DAEMON_HOME,
    )
    .option('-m, --provider <name>', 'Default provider for hosted runs')
    .option('--model <name>', 'Default model for hosted runs')
    .option(
      '--timeout-ms <n>',
      'Milliseconds to wait for each of stop and start',
      parseOptionalNonNegativeInt,
      5_000,
    )
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (
        localOptions: {
          home?: string;
          provider?: string;
          model?: string;
          timeoutMs?: number;
          json?: boolean;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        await restartDaemonCommand({
          ...daemonHostLocation(options.home),
          provider: options.provider,
          model: options.model,
          timeoutMs: options.timeoutMs ?? 5_000,
          json: options.json === true,
        });
      },
    );

  daemonCommand
    .command('logs')
    .description('Print the Host log path and recent lines')
    .addOption(removedHostProfileOption(`kodax ${name} logs`))
    .option(
      '--home <dir>',
      HELP_DAEMON_HOME,
    )
    .option(
      '--lines <n>',
      'Number of log lines to print',
      parseOptionalNonNegativeInt,
      80,
    )
    .option('--follow', 'Keep printing new lines until Ctrl+C')
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (subOpts: {
        home?: string;
        lines?: number;
        follow?: boolean;
        json?: boolean;
      }) => {
        await printDaemonLogs({
          ...daemonHostLocation(subOpts.home),
          lines: subOpts.lines ?? 80,
          follow: subOpts.follow === true,
          json: subOpts.json === true,
        });
      },
    );

  daemonCommand
    .command('serve')
    .description('Run the Host in the foreground, for service managers')
    .addOption(removedHostProfileOption(`kodax ${name} serve`))
    .option(
      '--home <dir>',
      HELP_DAEMON_HOME,
    )
    .addOption(new Option('--config-home <dir>').hideHelp())
    .option('-m, --provider <name>', 'Default provider for hosted runs')
    .option('--model <name>', 'Default model for hosted runs')
    .option('--sessions-dir <dir>', 'Runtime session storage directory')
    .option(
      '--permission-timeout-ms <n>',
      'Permission request timeout',
      parseOptionalNonNegativeInt,
    )
    .option(
      '--user-input-timeout-ms <n>',
      'Ordinary-question timeout in milliseconds (default: 0, no deadline)',
      parseOptionalNonNegativeInt,
    )
    .addOption(
      new Option('--orphan-exit-ms <n>')
        .argParser(parseOptionalNonNegativeInt)
        .hideHelp(),
    )
    .action(
      async (
        localOptions: {
          home?: string;
          provider?: string;
          model?: string;
          configHome?: string;
          sessionsDir?: string;
          permissionTimeoutMs?: number;
          userInputTimeoutMs?: number;
          orphanExitMs?: number;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        await serveDaemonCommand({
          profile: RUNTIME_HOST_SLOT,
          ...resolveCliRuntimeDaemonLocation(options.home, options.configHome),
          provider: options.provider,
          model: options.model,
          sessionsDir: options.sessionsDir,
          permissionTimeoutMs: options.permissionTimeoutMs,
          userInputTimeoutMs: options.userInputTimeoutMs,
          orphanExitMs: options.orphanExitMs,
        });
      },
    );

  daemonCommand
    .command('status')
    .description('Report whether the Host is running and healthy')
    .addOption(removedHostProfileOption(`kodax ${name} status`))
    .option(
      '--home <dir>',
      HELP_DAEMON_HOME,
    )
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (subOpts: { home?: string; json?: boolean }) => {
        await printDaemonStatus({
          ...daemonHostLocation(subOpts.home),
          json: subOpts.json === true,
        });
      },
    );

  configureKodaXDeviceCommands(daemonCommand, { locate: daemonHostLocation, version, homeHelp: HELP_DAEMON_HOME });
  return daemonCommand;
}
