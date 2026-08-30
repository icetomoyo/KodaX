import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  ELECTRON_RUN_AS_NODE_ENV,
  killChildProcessTree,
  isChildProcessExited,
  prepareInternalNodeLaunch,
  rememberChildProcessTree,
} from "@kodax-ai/agent";
import {
  parseExecPolicy,
  type ExecPolicyRuleInput,
} from "@kodax-ai/coding";

import type { RuntimeDaemonClientTransport } from "./client.js";
import {
  observeRuntimeDaemonHealth,
  runtimeDaemonEndpointFromState,
  type RuntimeDaemonHealthCheckOptions,
} from "./lifecycle.js";
import {
  assertRuntimeDaemonOwnerAllowed,
  classifyRuntimeDaemonHealth,
  ensureRuntimeDaemonDirectories,
  readRuntimeDaemonLockOwner,
  resolveRuntimeDaemonEndpointScope,
  resolveRuntimeDaemonPathsFromConfigHome,
  type RuntimeDaemonHealthObservation,
  type RuntimeDaemonPaths,
} from "./state.js";
import {
  createRuntimeDaemonSocketClientTransport,
  defaultRuntimeDaemonEndpoint,
  type RuntimeDaemonEndpoint,
} from "./transport.js";
import { spawnWindowsJobContainedProcess } from "./windows-job-supervisor.js";

export interface RuntimeDaemonProcessLeaseOptions {
  readonly homeDir?: string;
  readonly configHome?: string;
  readonly profile?: string;
  readonly endpoint?: RuntimeDaemonEndpoint;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly sessionsDir?: string;
  readonly permissionTimeoutMs?: number;
  readonly userInputTimeoutMs?: number;
  /** Passed only to a newly spawned daemon; ignored when attaching an existing owner. */
  readonly orphanExitMs?: number;
  readonly connectTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly startupSignal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly healthCheck?: RuntimeDaemonHealthCheckOptions;
  /** Trusted host policy installed only while creating a new daemon owner. */
  readonly ownerBootstrap?: RuntimeDaemonOwnerBootstrap;
}

export interface RuntimeDaemonOwnerBootstrap {
  readonly execPolicy?: {
    readonly adminRules?: readonly ExecPolicyRuleInput[];
    readonly trustedProjectRoots?: readonly string[];
  };
  readonly autoReview?: {
    readonly administratorPolicy?: string;
    readonly modelGuidance?: string;
  };
}

export interface RuntimeDaemonProcessLease {
  readonly transport: RuntimeDaemonClientTransport;
  readonly endpoint: RuntimeDaemonEndpoint;
  readonly paths: RuntimeDaemonPaths;
  readonly ownsHost: boolean;
  /** Result of the read-only health probe performed before this lease attached. */
  readonly probeInitialization?: unknown;
  close(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface RuntimeDaemonStartupExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RuntimeDaemonStartupProcess {
  readonly pid: number | undefined;
  readonly exit: Promise<RuntimeDaemonStartupExit>;
  hasExited?(): boolean;
  unref(): void;
  terminate(): Promise<void>;
}

export class RuntimeDaemonProcessCleanupIncompleteError extends Error {
  readonly code = "process_tree_cleanup_incomplete" as const;

  constructor(readonly pid: number | undefined) {
    super(
      `Runtime daemon child ${pid ?? "unknown"} process-tree cleanup could not be verified.`,
    );
    this.name = "RuntimeDaemonProcessCleanupIncompleteError";
  }
}

const CLEAN_EXIT_OWNER_PUBLICATION_GRACE_MS = 1_000;
export const RUNTIME_DAEMON_BOOTSTRAP_LOG_MAX_BYTES = 256 * 1024;
export const RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV =
  "KODAX_INTERNAL_DAEMON_OWNER_BOOTSTRAP";
const RUNTIME_DAEMON_OWNER_BOOTSTRAP_MAX_BYTES = 1024 * 1024;
const RUNTIME_DAEMON_OWNER_BOOTSTRAP_BASENAME =
  /^owner-bootstrap-[0-9a-f-]{36}\.json$/u;

export function createRuntimeDaemonOwnerBootstrapFile(
  paths: RuntimeDaemonPaths,
  input: RuntimeDaemonOwnerBootstrap,
): string {
  ensureRuntimeDaemonDirectories(paths);
  const bootstrap = parseRuntimeDaemonOwnerBootstrap(
    JSON.parse(JSON.stringify(input)) as unknown,
  );
  const file = path.join(
    paths.rootDir,
    `owner-bootstrap-${randomUUID()}.json`,
  );
  writeFileSync(file, JSON.stringify(bootstrap), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return file;
}

export function consumeRuntimeDaemonOwnerBootstrap(input: {
  readonly configHome: string;
  readonly profile: string;
  readonly environment: NodeJS.ProcessEnv;
}): RuntimeDaemonOwnerBootstrap | undefined {
  const configured = input.environment[RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV];
  delete input.environment[RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV];
  if (configured === undefined) return undefined;

  const paths = resolveRuntimeDaemonPathsFromConfigHome(
    path.resolve(input.configHome),
    input.profile,
  );
  const file = path.resolve(configured);
  const relative = path.relative(path.resolve(paths.rootDir), file);
  if (
    path.dirname(relative) !== "."
    || !RUNTIME_DAEMON_OWNER_BOOTSTRAP_BASENAME.test(path.basename(relative))
  ) {
    throw new Error(
      "Runtime daemon owner bootstrap must be a one-shot file in the selected daemon root.",
    );
  }

  try {
    const metadata = statSync(file);
    if (!metadata.isFile() || metadata.size > RUNTIME_DAEMON_OWNER_BOOTSTRAP_MAX_BYTES) {
      throw new Error("Runtime daemon owner bootstrap is not a bounded regular file.");
    }
    return parseRuntimeDaemonOwnerBootstrap(
      JSON.parse(readFileSync(file, "utf8")) as unknown,
    );
  } finally {
    if (existsSync(file)) unlinkSync(file);
  }
}

export function runtimeDaemonBootstrapLogPath(
  paths: RuntimeDaemonPaths,
): string {
  return path.join(paths.rootDir, "bootstrap.log");
}

export function openRuntimeDaemonBootstrapLog(
  paths: RuntimeDaemonPaths,
  maxBytes = RUNTIME_DAEMON_BOOTSTRAP_LOG_MAX_BYTES,
): number {
  ensureRuntimeDaemonDirectories(paths);
  const file = runtimeDaemonBootstrapLogPath(paths);
  const boundedMaxBytes = Math.max(1, maxBytes);
  const previous = `${file}.1`;
  capFileToTail(previous, boundedMaxBytes);
  if (existsSync(file) && statSync(file).size >= boundedMaxBytes) {
    capFileToTail(file, boundedMaxBytes);
    if (existsSync(previous)) unlinkSync(previous);
    renameSync(file, previous);
  }
  return openSync(file, "a", 0o600);
}

export function capRuntimeDaemonBootstrapLog(
  paths: RuntimeDaemonPaths,
  maxBytes = RUNTIME_DAEMON_BOOTSTRAP_LOG_MAX_BYTES,
): void {
  capFileToTail(runtimeDaemonBootstrapLogPath(paths), Math.max(1, maxBytes));
}

/**
 * The detached child inherits a file descriptor only for bootstrap. Once the
 * daemon is healthy, replace inherited raw writes with a bounded writer.
 * Governed runtime events continue in daemon.log while incidental process
 * output remains useful without allowing bootstrap.log to grow forever.
 */
export function detachRuntimeDaemonBootstrapOutput(
  paths: RuntimeDaemonPaths,
  maxBytes = RUNTIME_DAEMON_BOOTSTRAP_LOG_MAX_BYTES,
): void {
  const boundedWrite = ((
    chunk: unknown,
    encodingOrCallback?: unknown,
    callback?: unknown,
  ): boolean => {
    const completion =
      typeof callback === "function"
        ? (callback as () => void)
        : typeof encodingOrCallback === "function"
          ? (encodingOrCallback as () => void)
          : undefined;
    try {
      const encoding =
        typeof encodingOrCallback === "string"
          ? (encodingOrCallback as BufferEncoding)
          : undefined;
      const content = Buffer.isBuffer(chunk)
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : Buffer.from(String(chunk), encoding);
      appendFileSync(runtimeDaemonBootstrapLogPath(paths), content, {
        mode: 0o600,
      });
      capRuntimeDaemonBootstrapLog(paths, maxBytes);
    } catch {
      // Diagnostic output is best-effort and cannot define daemon health.
    }
    if (completion) queueMicrotask(completion);
    return true;
  }) as typeof process.stdout.write;
  try {
    Object.defineProperty(process.stdout, "write", {
      configurable: true,
      writable: true,
      value: boundedWrite,
    });
    Object.defineProperty(process.stderr, "write", {
      configurable: true,
      writable: true,
      value: boundedWrite,
    });
  } catch {
    // Startup has already succeeded. A stream that cannot be detached must
    // not make the otherwise healthy daemon unavailable.
  }
  try {
    capRuntimeDaemonBootstrapLog(paths, maxBytes);
  } catch {
    // Diagnostics retention is best-effort and never part of daemon health.
  }
}

function capFileToTail(file: string, maxBytes: number): void {
  if (!existsSync(file)) return;
  const size = statSync(file).size;
  if (size <= maxBytes) return;
  const descriptor = openSync(file, "r+");
  try {
    const retained = Buffer.allocUnsafe(maxBytes);
    let offset = 0;
    while (offset < retained.length) {
      const count = readSync(
        descriptor,
        retained,
        offset,
        retained.length - offset,
        size - maxBytes + offset,
      );
      if (count === 0) break;
      offset += count;
    }
    ftruncateSync(descriptor, 0);
    if (offset > 0) writeSync(descriptor, retained, 0, offset, 0);
  } finally {
    closeSync(descriptor);
  }
}

export type RuntimeDaemonStartupFailureReason =
  "cancelled" | "child_exit" | "identity_mismatch" | "timeout";

export class RuntimeDaemonStartupError extends Error {
  constructor(
    message: string,
    readonly reason: RuntimeDaemonStartupFailureReason,
  ) {
    super(message);
    this.name = "RuntimeDaemonStartupError";
  }
}

type RuntimeDaemonHealthObserver = (
  paths: RuntimeDaemonPaths,
  options?: RuntimeDaemonHealthCheckOptions,
) => Promise<RuntimeDaemonHealthObservation>;

export async function acquireRuntimeDaemonProcessLease(
  options: RuntimeDaemonProcessLeaseOptions,
): Promise<RuntimeDaemonProcessLease> {
  if (
    options.orphanExitMs !== undefined
    && (!Number.isSafeInteger(options.orphanExitMs) || options.orphanExitMs <= 0)
  ) {
    throw new Error("orphanExitMs must be a positive safe integer.");
  }
  const profile = options.profile ?? "default";
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const configHome = path.resolve(
    options.configHome ?? path.join(homeDir, ".kodax"),
  );
  const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, profile);
  assertRuntimeDaemonOwnerAllowed(paths);
  const expectedEndpoint = defaultRuntimeDaemonEndpoint(
    paths.profile,
    resolveRuntimeDaemonEndpointScope(homeDir, configHome),
  );
  if (options.endpoint && options.endpoint.path !== expectedEndpoint.path) {
    throw new Error(
      "SDK daemon auto-start only supports the profile default endpoint; use attach-only mode for custom endpoints.",
    );
  }

  const initial = await observeRuntimeDaemonHealth(paths, options.healthCheck);
  const initialHealth = classifyRuntimeDaemonHealth(initial);
  if (initialHealth === "healthy" && initial.state) {
    if (options.ownerBootstrap !== undefined) {
      throw new Error(
        "Trusted daemon owner policy cannot be applied to an existing daemon. Stop that owner and retry the bootstrap.",
      );
    }
    const observation =
      initial.state.status === "ready"
        ? { ...initial, state: initial.state }
        : await waitForReadyRuntimeDaemonOwner(paths, options, initial);
    return connectProcessLease(
      paths,
      runtimeDaemonEndpointFromState(observation.state),
      false,
      options,
      observation.initialization,
    );
  }
  if (initialHealth === "unhealthy" || initialHealth === "mismatch") {
    throw new Error(
      `Runtime daemon is ${initialHealth}; refusing to start a competing owner.`,
    );
  }

  const ownerBootstrapFile = options.ownerBootstrap === undefined
    ? undefined
    : createRuntimeDaemonOwnerBootstrapFile(paths, options.ownerBootstrap);
  try {
    const child = await spawnRuntimeDaemonServeProcess({
      profile: paths.profile,
      homeDir,
      configHome,
      defaultProvider: options.defaultProvider,
      defaultModel: options.defaultModel,
      sessionsDir: options.sessionsDir,
      permissionTimeoutMs: options.permissionTimeoutMs,
      userInputTimeoutMs: options.userInputTimeoutMs,
      orphanExitMs: options.orphanExitMs,
      startupTimeoutMs: options.startupTimeoutMs,
      ownerBootstrapFile,
    });
    const observation = await waitForHealthyDaemonStartup(paths, options, child);
    const ownsHost = observation.state.pid === child.pid;
    if (options.ownerBootstrap !== undefined && !ownsHost) {
      throw new Error(
        "Trusted daemon owner policy lost a concurrent startup race and was not applied. Retry after the current owner stops.",
      );
    }
    const endpoint = runtimeDaemonEndpointFromState(observation.state);
    return connectProcessLease(
      paths,
      endpoint,
      ownsHost,
      options,
      observation.initialization,
    );
  } finally {
    if (ownerBootstrapFile !== undefined && existsSync(ownerBootstrapFile)) {
      unlinkSync(ownerBootstrapFile);
    }
  }
}

async function connectProcessLease(
  paths: RuntimeDaemonPaths,
  endpoint: RuntimeDaemonEndpoint,
  ownsHost: boolean,
  options: RuntimeDaemonProcessLeaseOptions,
  probeInitialization?: unknown,
): Promise<RuntimeDaemonProcessLease> {
  const transport = await createRuntimeDaemonSocketClientTransport(endpoint, {
    connectTimeoutMs: options.connectTimeoutMs,
  });
  let transportClosed = false;
  let closeAttempt: Promise<void> | undefined;
  let shutdownRequested = false;
  let shutdownAttempt: Promise<void> | undefined;
  const closeTransport = (): Promise<void> => {
    if (transportClosed) return Promise.resolve();
    if (closeAttempt) return closeAttempt;
    const attempt = (async () => {
      await transport.close?.();
      transportClosed = true;
    })();
    closeAttempt = attempt;
    void attempt.finally(() => {
      if (closeAttempt === attempt) closeAttempt = undefined;
    }).catch(() => undefined);
    return attempt;
  };
  return {
    transport,
    endpoint,
    paths,
    ownsHost,
    ...(probeInitialization === undefined ? {} : { probeInitialization }),
    close: closeTransport,
    shutdown() {
      if (shutdownAttempt) return shutdownAttempt;
      const attempt = (async () => {
        if (!shutdownRequested) {
          // Keep the transport open when the request fails so a later close()
          // call can retry the owned-host shutdown.
          await transport.request("runtime.shutdown");
          shutdownRequested = true;
        }
        await closeTransport();
      })();
      shutdownAttempt = attempt;
      void attempt.finally(() => {
        if (shutdownAttempt === attempt) shutdownAttempt = undefined;
      }).catch(() => undefined);
      return attempt;
    },
  };
}

export async function waitForHealthyDaemonStartup(
  paths: RuntimeDaemonPaths,
  options: RuntimeDaemonProcessLeaseOptions,
  child: RuntimeDaemonStartupProcess,
  observe: RuntimeDaemonHealthObserver = observeRuntimeDaemonHealth,
): Promise<
  RuntimeDaemonHealthObservation & {
    readonly state: NonNullable<RuntimeDaemonHealthObservation["state"]>;
  }
> {
  const deadline = Date.now() + (options.startupTimeoutMs ?? 60_000);
  try {
    while (true) {
      const observation = await observeStartupHealth(
        paths,
        options,
        child,
        observe,
      );
      const health = classifyRuntimeDaemonHealth(observation);
      if (health === "healthy" && observation.state?.status === "ready") {
        if (observation.state.pid === child.pid) child.unref();
        else await terminateCompetingStartupChild(child);
        return { ...observation, state: observation.state };
      }
      if (health === "mismatch") {
        throw new RuntimeDaemonStartupError(
          "Runtime daemon endpoint identity does not match its persisted owner state.",
          "identity_mismatch",
        );
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw runtimeDaemonStartupTimeout(paths);
      await waitForStartupPoll(
        Math.min(Math.max(1, options.pollIntervalMs ?? 100), remainingMs),
        paths,
        child,
        options.startupSignal,
      );
    }
  } catch (error: unknown) {
    try {
      await child.terminate();
    } catch (terminationError: unknown) {
      throw new AggregateError(
        [error, terminationError],
        "Runtime daemon startup failed and its child process could not be reclaimed.",
      );
    }
    try {
      capRuntimeDaemonBootstrapLog(paths);
    } catch {
      // Preserve the startup failure as the actionable error.
    }
    throw error;
  }
}

export async function waitForReadyRuntimeDaemonOwner(
  paths: RuntimeDaemonPaths,
  options: RuntimeDaemonProcessLeaseOptions,
  initial: RuntimeDaemonHealthObservation,
  observe: RuntimeDaemonHealthObserver = observeRuntimeDaemonHealth,
): Promise<
  RuntimeDaemonHealthObservation & {
    readonly state: NonNullable<RuntimeDaemonHealthObservation["state"]>;
  }
> {
  const deadline = Date.now() + (options.startupTimeoutMs ?? 60_000);
  const expectedOwner = initial.state;
  if (expectedOwner === undefined) {
    throw new RuntimeDaemonStartupError(
      "Runtime daemon owner state disappeared before it reached ready.",
      "identity_mismatch",
    );
  }
  let observation = initial;
  while (true) {
    const health = classifyRuntimeDaemonHealth(observation);
    if (
      observation.state !== undefined &&
      (observation.state.runtimeId !== expectedOwner.runtimeId ||
        observation.state.pid !== expectedOwner.pid ||
        observation.state.profile !== expectedOwner.profile ||
        observation.state.endpoint !== expectedOwner.endpoint)
    ) {
      throw new RuntimeDaemonStartupError(
        "Runtime daemon owner identity changed before it reached ready.",
        "identity_mismatch",
      );
    }
    if (health === "healthy" && observation.state?.status === "ready") {
      return { ...observation, state: observation.state };
    }
    if (health === "mismatch") {
      throw new RuntimeDaemonStartupError(
        "Runtime daemon endpoint identity does not match its persisted owner state.",
        "identity_mismatch",
      );
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw runtimeDaemonStartupTimeout(paths);
    await raceRuntimeDaemonStartupStep(
      delay(Math.min(Math.max(1, options.pollIntervalMs ?? 100), remainingMs)),
      options.startupSignal,
    );
    observation = await raceRuntimeDaemonStartupStep(
      observe(paths, options.healthCheck),
      options.startupSignal,
    );
  }
}

async function observeStartupHealth(
  paths: RuntimeDaemonPaths,
  options: RuntimeDaemonProcessLeaseOptions,
  child: RuntimeDaemonStartupProcess,
  observe: RuntimeDaemonHealthObserver,
): Promise<RuntimeDaemonHealthObservation> {
  const outcome = await raceRuntimeDaemonStartupStep(
    Promise.race([
      observe(paths, options.healthCheck).then((observation) => ({
        kind: "health" as const,
        observation,
      })),
      child.exit.then((exit) => ({ kind: "exit" as const, exit })),
    ]),
    options.startupSignal,
  );
  if (outcome.kind === "exit") {
    if (hasCompetingStartupOwner(paths, child)) {
      return observe(paths, options.healthCheck);
    }
    if (outcome.exit.code === 0 && outcome.exit.signal === null) {
      const graceMs = Math.min(
        CLEAN_EXIT_OWNER_PUBLICATION_GRACE_MS,
        options.startupTimeoutMs ?? CLEAN_EXIT_OWNER_PUBLICATION_GRACE_MS,
      );
      const deadline = Date.now() + graceMs;
      while (Date.now() <= deadline) {
        const observation = await raceRuntimeDaemonStartupStep(
          observe(paths, options.healthCheck),
          options.startupSignal,
        );
        if (
          classifyRuntimeDaemonHealth(observation) !== "missing" ||
          hasCompetingStartupOwner(paths, child)
        ) {
          return observation;
        }
        await raceRuntimeDaemonStartupStep(
          delay(
            Math.min(
              options.pollIntervalMs ?? 100,
              Math.max(1, deadline - Date.now()),
            ),
          ),
          options.startupSignal,
        );
      }
    }
    throw runtimeDaemonExitedEarly(paths, outcome.exit);
  }
  return outcome.observation;
}

async function waitForStartupPoll(
  pollIntervalMs: number,
  paths: RuntimeDaemonPaths,
  child: RuntimeDaemonStartupProcess,
  signal?: AbortSignal,
): Promise<void> {
  const outcome = await raceRuntimeDaemonStartupStep(
    Promise.race([delay(pollIntervalMs).then(() => undefined), child.exit]),
    signal,
  );
  if (outcome === undefined) return;
  if (outcome.code === 0 && outcome.signal === null) return;
  if (hasCompetingStartupOwner(paths, child)) {
    await raceRuntimeDaemonStartupStep(delay(pollIntervalMs), signal);
    return;
  }
  throw runtimeDaemonExitedEarly(paths, outcome);
}

function hasCompetingStartupOwner(
  paths: RuntimeDaemonPaths,
  child: RuntimeDaemonStartupProcess,
): boolean {
  const owner = readRuntimeDaemonLockOwner(paths.lockFile);
  return owner !== undefined && owner.pid !== child.pid;
}

function runtimeDaemonExitedEarly(
  paths: RuntimeDaemonPaths,
  exit: RuntimeDaemonStartupExit,
): RuntimeDaemonStartupError {
  const status =
    exit.signal !== null
      ? `signal ${exit.signal}`
      : `code ${exit.code ?? "unknown"}`;
  return new RuntimeDaemonStartupError(
    `Runtime daemon child exited before becoming healthy (${status}). ` +
      `See daemon bootstrap log: ${runtimeDaemonBootstrapLogPath(paths)}`,
    "child_exit",
  );
}

function runtimeDaemonStartupTimeout(
  paths: RuntimeDaemonPaths,
): RuntimeDaemonStartupError {
  const electronHint =
    process.versions.electron === undefined
      ? ""
      : " Packaged Electron auto-start requires the RunAsNode fuse to remain enabled.";
  return new RuntimeDaemonStartupError(
    `Timed out waiting for runtime daemon profile "${paths.profile}" to become ready.${electronHint} ` +
      `See daemon bootstrap log: ${runtimeDaemonBootstrapLogPath(paths)}`,
    "timeout",
  );
}

export interface RuntimeDaemonServeProcessInput {
  readonly profile: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly sessionsDir?: string;
  readonly permissionTimeoutMs?: number;
  readonly userInputTimeoutMs?: number;
  readonly orphanExitMs?: number;
  readonly startupTimeoutMs?: number;
  /** @internal One-shot owner-only policy file; never emitted on the command line. */
  readonly ownerBootstrapFile?: string;
}

export function buildRuntimeDaemonServeArgs(
  input: RuntimeDaemonServeProcessInput,
  entry: string | undefined,
  execArgv: readonly string[] = process.execArgv,
): string[] {
  const args = [
    ...(entry !== undefined
      ? daemonServeExecArgv(execArgv, entry.endsWith(".ts"))
      : []),
    ...(entry !== undefined ? [entry] : []),
    "daemon",
    "serve",
    "--profile",
    input.profile,
    "--home",
    input.homeDir,
    "--config-home",
    input.configHome,
  ];
  if (input.defaultProvider !== undefined)
    args.push("--provider", input.defaultProvider);
  if (input.defaultModel !== undefined)
    args.push("--model", input.defaultModel);
  if (input.sessionsDir !== undefined)
    args.push("--sessions-dir", input.sessionsDir);
  if (input.permissionTimeoutMs !== undefined) {
    args.push("--permission-timeout-ms", String(input.permissionTimeoutMs));
  }
  if (input.userInputTimeoutMs !== undefined) {
    args.push("--user-input-timeout-ms", String(input.userInputTimeoutMs));
  }
  if (input.orphanExitMs !== undefined) {
    args.push("--orphan-exit-ms", String(input.orphanExitMs));
  }
  return args;
}

export async function spawnRuntimeDaemonServeProcess(
  input: RuntimeDaemonServeProcessInput,
): Promise<RuntimeDaemonStartupProcess> {
  const entry = resolveDaemonCliEntry();
  assertRuntimeDaemonCliEntryAvailable(entry);
  const args = buildRuntimeDaemonServeArgs(input, entry);
  const launch = prepareInternalNodeLaunch({
    args,
    env: createRuntimeDaemonServeEnvironment({
      homeDir: input.homeDir,
      configHome: input.configHome,
      parentEnv: process.env,
      ownerBootstrapFile: input.ownerBootstrapFile,
    }),
    isElectron: process.versions.electron !== undefined,
  });
  const paths = resolveRuntimeDaemonPathsFromConfigHome(
    input.configHome,
    input.profile,
  );
  const bootstrapLog = openRuntimeDaemonBootstrapLog(paths);
  let child: ChildProcess;
  let daemonPid: number | undefined;
  let terminateContainedProcess: (() => Promise<void>) | undefined;
  let releaseContainedProcess: (() => void) | undefined;
  try {
    if (process.platform === "win32") {
      const contained = await spawnWindowsJobContainedProcess({
        executable: process.execPath,
        args: launch.args,
        cwd: process.cwd(),
        env: launch.env,
        logFile: runtimeDaemonBootstrapLogPath(paths),
        startupTimeoutMs: input.startupTimeoutMs,
      });
      child = contained.supervisor;
      daemonPid = contained.processPid;
      terminateContainedProcess = contained.terminate;
      releaseContainedProcess = contained.release;
    } else {
      child = spawn(process.execPath, launch.args, {
        detached: true,
        stdio: ["ignore", bootstrapLog, bootstrapLog],
        windowsHide: true,
        env: launch.env,
      });
    }
  } finally {
    closeSync(bootstrapLog);
  }
  const exit = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise<RuntimeDaemonStartupExit>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
  if (daemonPid === undefined) {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }
  rememberChildProcessTree(child);
  return createRuntimeDaemonStartupProcess(
    child,
    exit,
    daemonPid,
    terminateContainedProcess,
    releaseContainedProcess,
  );
}

async function terminateCompetingStartupChild(
  child: RuntimeDaemonStartupProcess,
): Promise<void> {
  if (child.hasExited?.() === true) return;
  try {
    await child.terminate();
  } catch (error: unknown) {
    // A lock loser exits before host initialization. On Windows, that exit can
    // land between the liveness check and exact process-tree capture.
    if (
      !(error instanceof RuntimeDaemonProcessCleanupIncompleteError)
      || !(await didExitWithin(child.exit, 1_000))
    ) throw error;
  }
}

export function createRuntimeDaemonStartupProcess(
  child: ChildProcess,
  exit: Promise<RuntimeDaemonStartupExit>,
  processPid = child.pid,
  terminateContainedProcess?: () => Promise<void>,
  releaseContainedProcess?: () => void,
): RuntimeDaemonStartupProcess {
  return {
    pid: processPid,
    exit,
    hasExited() {
      return isChildProcessExited(child);
    },
    unref() {
      if (releaseContainedProcess !== undefined) releaseContainedProcess();
      else child.unref();
    },
    async terminate() {
      if (terminateContainedProcess !== undefined) {
        await terminateContainedProcess();
        if (!(await didExitWithin(exit, 1_000))) {
          throw new Error(
            `Runtime daemon Job supervisor ${child.pid ?? "unknown"} did not exit after termination.`,
          );
        }
        return;
      }
      const rootAlreadyExited = isChildProcessExited(child);
      const result = await killChildProcessTree(child);
      if (result.status === "unknown" && !rootAlreadyExited) {
        throw new RuntimeDaemonProcessCleanupIncompleteError(processPid);
      }
      if (!(await didExitWithin(exit, 1_000))) {
        throw new Error(
          `Runtime daemon child ${processPid ?? "unknown"} did not exit after termination.`,
        );
      }
    },
  };
}

async function didExitWithin(
  exit: Promise<RuntimeDaemonStartupExit>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function assertRuntimeDaemonCliEntryAvailable(
  entry: string | undefined,
): void {
  if (entry !== undefined && !existsSync(entry)) {
    throw new Error(
      `Runtime daemon CLI entry is unavailable at "${entry}". ` +
        "Keep the published KodaX dist files external to the embedder bundle.",
    );
  }
}

export function createRuntimeDaemonServeEnvironment(input: {
  readonly homeDir: string;
  readonly configHome?: string;
  readonly parentEnv: NodeJS.ProcessEnv;
  readonly ownerBootstrapFile?: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...input.parentEnv,
    KODAX_DAEMON_SERVE: "1",
    KODAX_HOME: input.configHome ?? path.join(input.homeDir, ".kodax"),
  };
  delete env[ELECTRON_RUN_AS_NODE_ENV];
  delete env[RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV];
  if (input.ownerBootstrapFile !== undefined) {
    env[RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV] = input.ownerBootstrapFile;
  }
  return env;
}

function parseRuntimeDaemonOwnerBootstrap(
  value: unknown,
): RuntimeDaemonOwnerBootstrap {
  if (!isRecord(value)) {
    throw new Error("Runtime daemon owner bootstrap must be an object.");
  }
  assertOnlyFields(value, ["execPolicy", "autoReview"], "owner bootstrap");
  return {
    ...(value.execPolicy === undefined
      ? {}
      : { execPolicy: parseRuntimeDaemonExecPolicy(value.execPolicy) }),
    ...(value.autoReview === undefined
      ? {}
      : { autoReview: parseRuntimeDaemonAutoReview(value.autoReview) }),
  };
}

function parseRuntimeDaemonExecPolicy(
  value: unknown,
): NonNullable<RuntimeDaemonOwnerBootstrap["execPolicy"]> {
  if (!isRecord(value)) {
    throw new Error("Runtime daemon owner execPolicy must be an object.");
  }
  assertOnlyFields(
    value,
    ["adminRules", "trustedProjectRoots"],
    "owner execPolicy",
  );
  const roots = value.trustedProjectRoots;
  if (
    roots !== undefined
    && (!Array.isArray(roots) || !roots.every((root) => typeof root === "string"))
  ) {
    throw new Error("Runtime daemon owner trustedProjectRoots must be strings.");
  }
  return {
    ...(value.adminRules === undefined
      ? {}
      : { adminRules: parseRuntimeDaemonAdminRules(value.adminRules) }),
    ...(roots === undefined ? {} : { trustedProjectRoots: roots as string[] }),
  };
}

function parseRuntimeDaemonAdminRules(value: unknown): readonly ExecPolicyRuleInput[] {
  if (!Array.isArray(value)) {
    throw new Error("Runtime daemon owner adminRules must be an array.");
  }
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`Runtime daemon owner adminRules[${index}] must be an object.`);
    }
    assertOnlyFields(
      candidate,
      [
        "prefix",
        "decision",
        "justification",
        "match",
        "notMatch",
        "hostExecutable",
        "network",
        "compound",
      ],
      `owner adminRules[${index}]`,
    );
    const parsed = parseExecPolicy(JSON.stringify({
      rules: [{
        prefix: candidate.prefix,
        decision: candidate.decision,
        justification: candidate.justification,
        match: candidate.match,
        notMatch: candidate.notMatch,
        hostExecutable: candidate.hostExecutable,
        network: candidate.network,
        compound: candidate.compound,
      }],
    }), "host:admin", "admin");
    if (!parsed.ok || parsed.rules[0] === undefined) {
      throw new Error(
        `Invalid Runtime daemon owner adminRules[${index}]: ${parsed.ok ? "missing rule" : parsed.error}`,
      );
    }
    const { source, sourcePath, ...input } = parsed.rules[0];
    void source;
    void sourcePath;
    return input;
  });
}

function parseRuntimeDaemonAutoReview(
  value: unknown,
): NonNullable<RuntimeDaemonOwnerBootstrap["autoReview"]> {
  if (!isRecord(value)) {
    throw new Error("Runtime daemon owner autoReview must be an object.");
  }
  assertOnlyFields(
    value,
    ["administratorPolicy", "modelGuidance"],
    "owner autoReview",
  );
  if (
    value.administratorPolicy !== undefined
    && typeof value.administratorPolicy !== "string"
  ) {
    throw new Error("Runtime daemon owner administratorPolicy must be a string.");
  }
  if (value.modelGuidance !== undefined && typeof value.modelGuidance !== "string") {
    throw new Error("Runtime daemon owner modelGuidance must be a string.");
  }
  return {
    ...(typeof value.administratorPolicy === "string"
      ? { administratorPolicy: value.administratorPolicy }
      : {}),
    ...(typeof value.modelGuidance === "string"
      ? { modelGuidance: value.modelGuidance }
      : {}),
  };
}

function assertOnlyFields(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const known = new Set(allowed);
  const unknownField = Object.keys(value).find((field) => !known.has(field));
  if (unknownField !== undefined) {
    throw new Error(`Runtime daemon ${label}.${unknownField} is not supported.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveDaemonCliEntry(): string | undefined {
  if (process.env.KODAX_BUNDLED === "true") return undefined;
  const current = fileURLToPath(import.meta.url);
  if (current.endsWith(".ts"))
    return path.resolve(path.dirname(current), "..", "kodax_cli.ts");
  const currentDir = path.dirname(current);
  const distDir =
    path.basename(currentDir) === "chunks"
      ? path.dirname(currentDir)
      : currentDir;
  return path.join(distDir, "kodax_cli.js");
}

export function daemonServeExecArgv(
  execArgv: readonly string[],
  needsTsx: boolean,
): string[] {
  const keep: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index] ?? "";
    const normalized = arg.toLowerCase();
    if (normalized === "--require" || normalized === "-r") {
      const value = execArgv[index + 1];
      if (value !== undefined) {
        if (isKodaXProductionEnvPreload(value)) keep.push(arg, value);
        index += 1;
      }
    } else if (normalized.startsWith("--require=")) {
      const value = arg.slice("--require=".length);
      if (isKodaXProductionEnvPreload(value)) keep.push(arg);
    } else if (
      normalized.startsWith("--max-old-space-size") ||
      normalized === "--enable-source-maps"
    ) {
      keep.push(arg);
    }
  }
  if (needsTsx) keep.push("--import", "tsx");
  return keep;
}

function isKodaXProductionEnvPreload(value: string): boolean {
  return path.resolve(value) === path.resolve("scripts", "production-env.cjs");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceRuntimeDaemonStartupStep<T>(
  step: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return step;
  if (signal.aborted) throw runtimeDaemonStartupCancelled();
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      step,
      new Promise<never>((_, reject) => {
        cancel = () => reject(runtimeDaemonStartupCancelled());
        signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    if (cancel) signal.removeEventListener("abort", cancel);
  }
}

function runtimeDaemonStartupCancelled(): RuntimeDaemonStartupError {
  return new RuntimeDaemonStartupError(
    "Runtime daemon startup cancelled.",
    "cancelled",
  );
}
