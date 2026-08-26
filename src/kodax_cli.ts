#!/usr/bin/env node

// ── Runtime environment defaults ──
// NODE_ENV must be set BEFORE any ESM static import is evaluated, otherwise
// React loads its development reconciler (~100 MB/turn profiling leak).
// This is handled by the CJS shim/preload upstream of this file:
//   - bin entry:        scripts/kodax-bin.cjs requires production-env.cjs
//                       then imports the lightweight bootstrap (ESM)
//   - npm run dev/start: --require ./scripts/production-env.cjs flag
// The bootstrap dynamically imports this full module after optional resume
// selection, so production mode is still fixed before React is evaluated.
// The inline fallback below only covers `node dist/kodax_cli.js` invoked
// directly; in that path we cannot guarantee React is still in production
// mode, but setting NODE_ENV here keeps downstream NODE_ENV checks sane.
const nodeEnvKey = ['NODE', 'ENV'].join('_') as 'NODE_ENV';
if (!process.env[nodeEnvKey]) {
  process.env[nodeEnvKey] =
    process.env.KODAX_DEV === '1' ? 'development' : 'production';
}

// Propagate a sensible V8 heap limit to child processes (sub-agents, forks).
// The main process heap limit is set via --max-old-space-size in the
// package.json scripts or shell wrapper. NODE_OPTIONS set here at runtime
// only affects children. Default 4 GB; override via KODAX_HEAP_LIMIT.
if (
  !process.execArgv.some((a) => a.includes('max-old-space-size')) &&
  !process.env.NODE_OPTIONS?.includes('max-old-space-size')
) {
  const limit = process.env.KODAX_HEAP_LIMIT ?? '4096';
  process.env.NODE_OPTIONS =
    `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${limit}`.trim();
}

/**
 * KodaX CLI — Command-line entry point.
 * UI module: Ink-based interactive REPL with managed task lifecycle.
 */
import { Command, Option } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  createKodaXRuntime,
  handleRuntimePermissionRequest,
  type KodaXRuntime,
  type RuntimeEvent,
  type RuntimeKodaXOptions,
} from './sdk-runtime.js';
import {
  isRuntimeDaemonPidAlive,
  observeRuntimeDaemonHealth,
  runtimeDaemonEndpointFromState,
} from './runtime-daemon/lifecycle.js';
import {
  appendRuntimeDaemonLog,
  classifyRuntimeDaemonHealth,
  readRuntimeDaemonShutdownOutcome,
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonToken,
  removeRuntimeDaemonOwnershipIfUnchanged,
  isSameRuntimeDaemonPath,
  resolveRuntimeDaemonPaths,
  resolveRuntimeDaemonPathsFromConfigHome,
  writeRuntimeDaemonShutdownOutcome,
  type RuntimeDaemonHealth,
  type RuntimeDaemonState,
} from './runtime-daemon/state.js';
import { createRuntimeDaemonSocketClientTransport } from './runtime-daemon/transport.js';
import { acquireRuntimeDaemonLease } from './runtime-daemon/manager.js';
import {
  detachRuntimeDaemonBootstrapOutput,
  RUNTIME_DAEMON_BOOTSTRAP_LOG_MAX_BYTES,
  RuntimeDaemonStartupError,
  spawnRuntimeDaemonServeProcess,
  waitForHealthyDaemonStartup,
  waitForReadyRuntimeDaemonOwner,
} from './runtime-daemon/process.js';
import { runDoctor } from './kodax_doctor.js';
import {
  getDefaultCommandDir,
  KODAX_COMMANDS_DIR,
  loadCommands,
  parseCommandCall,
  processCommandCall,
  type KodaXCommand,
  type KodaXCommandContext,
} from './cli_commands.js';
import {
  ACP_PERMISSION_MODES,
  createKodaXOptions,
  parseAgentModeOption,
  parseEffortOption,
  parseOptionalNonNegativeInt,
  parseOutputModeOption,
  parsePermissionModeOption,
  parseReasoningModeOption,
  parseRepoIntelligenceModeOption,
  parseRuntimeModeOption,
  mergeCommandOptionsWithGlobals,
  normalizeCliSessionFlags,
  resolveCliAgentMode,
  resolveCliEffort,
  resolveCliModelSelection,
  resolveCliProviderSelection,
  resolveCliReasoningMode,
  resolveCliRuntimeMode,
  findSessionTitleMatches,
  type CliOutputMode,
  type CliOptions,
  validateCliModeSelection,
} from './cli_option_helpers.js';
import {
  consumeInternalSkillDispatchFlag,
  runSkillCreatorTool,
} from './skill_cli.js';
import {
  dispatchSkillCreatorTool,
  isSkillCreatorDispatchAction,
} from '@kodax-ai/agent/capabilities/skills';
import {
  archiveAcpPollutionCandidates,
  findAcpPollutionCandidates,
} from './acp_session_cleanup.js';

// Read the CLI version from the binary build define first, then package.json.
const packageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../package.json',
);
const version =
  process.env.KODAX_VERSION ??
  (fsSync.existsSync(packageJsonPath)
    ? JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8')).version
    : '0.0.0');

import {
  runKodaX,
  runManagedTask,
  KodaXClient,
  KodaXEvents,
  type KodaXOptions,
  KodaXReasoningMode,
  createExtensionRuntime,
  dedupeExtensionPathsByEntrypoint,
  discoverDefaultExtensions,
  excludeExtensionPathsByEntrypoint,
  registerConfiguredMcpCapabilityProvider,
  buildMcpReverseCapabilities,
  KODAX_DEFAULT_PROVIDER,
  checkPromiseSignal,
  getProvider,
  getAvailableProviderNames,
  KODAX_TOOLS,
  KodaXTerminalError,
  bootstrapTracing,
  estimateTokens,
  shutdownDefaultLspService,
  generateSessionId,
  awaitLatestCodingMemoryReviewDrain,
  deriveCodingMemoryIdentity,
  drainCodingMemoryReviewInbox,
  installProductionLearningReviewer,
  resolveProvider,
} from '@kodax-ai/coding';
import {
  cleanupRegisteredManagedChildren,
  createMemoryControlPlane,
  emitKodaXDiagnostic,
  isCurrentProcessWindowsJobContained,
  killPidTree,
  readProcessStartIdentity,
  shutdownTracing,
  applyProcessHardening,
} from '@kodax-ai/agent';
import {
  getGitRoot,
  loadConfig,
  prepareRuntimeConfig,
  readExtensionsIntegration,
  readMcpIntegration,
  FileSessionStorage,
  dedupeSessions,
  KODAX_CONFIG_FILE,
  KODAX_DIR,
  ensureExampleConfigFiles,
  resolveInteractiveSurfacePreference,
  resolveUserSkillInvocation,
  prepareInvocationExecution,
  runInteractiveMode,
  runInkInteractiveMode,
  runSessionPicker,
  findMostRecentResumableSession,
  getProviderSetupCatalog,
  inspectProviderSetupReadiness,
  providerSetupRestartInstructions,
  runProviderSetupWizard,
  initializeSetupConfiguration,
  renderSetupGuide,
  type ReplRuntimeAutoModeControl,
  type ReplRuntimeAutoModeSettings,
  type ReplRuntimePermissionGrantSuggestion,
  type ReplRuntimePermissionPrompt,
  type PreparedInvocation,
  type SessionPickerItem,
  type SessionDedupeReport,
} from '@kodax-ai/repl';
import type { AcpPermissionMode } from './acp_server.js';
import { configureIntegrationCommands } from './integration-cli.js';
import {
  createIntegrationEventBridge,
  startIntegrationHotReload,
  type IntegrationHotReloadHandle,
} from './integration-hot-reload.js';
import {
  createConfiguredA2ARuntimeIntegration,
  type ConfiguredA2ARuntimeHandle,
} from './a2a/runtime-config.js';
import { parseA2AIntegrationDocument } from './a2a/config.js';
import { createReplLearningBinding } from './repl-learning-binding.js';
import {
  hasProviderCredentialEnvironment,
  renderMissingProviderCredentialGuide,
  shouldAutoLaunchProviderSetup,
} from './provider-setup-cli.js';
export {
  ACP_PERMISSION_MODES,
  getDefaultCommandDir,
  KODAX_COMMANDS_DIR,
  loadCommands,
  parseCommandCall,
  parseAgentModeOption,
  parsePermissionModeOption,
  parseReasoningModeOption,
  parseRepoIntelligenceModeOption,
  parseRuntimeModeOption,
  processCommandCall,
  resolveCliAgentMode,
};

type SandboxRuntimeModule = typeof import('./sandbox-runtime.js');
let sandboxRuntimeModulePromise: Promise<SandboxRuntimeModule> | undefined;

function loadSandboxRuntimeModule(): Promise<SandboxRuntimeModule> {
  sandboxRuntimeModulePromise ??= import('./sandbox-runtime.js');
  return sandboxRuntimeModulePromise;
}
export type { KodaXCommand, KodaXCommandContext };

function hasConfiguredMcpServers(config: {
  mcpServers?: Record<string, { connect?: string }>;
}): boolean {
  return Object.values(config.mcpServers ?? {}).some(
    (server) => (server.connect ?? 'lazy') !== 'disabled',
  );
}

function resolveDefaultRuntimeDaemonHomeDir(): string {
  return os.homedir();
}

function resolveCliRuntimeDaemonLocation(
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

async function discoverCliDefaultExtensions(): Promise<string[]> {
  try {
    return await discoverDefaultExtensions();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      chalk.yellow(
        '[extensions] Failed to discover default extensions: ' + message,
      ),
    );
    return [];
  }
}

function printSessionDedupeReport(
  report: SessionDedupeReport,
  applied: boolean,
): void {
  const action = applied ? 'Applied' : 'Dry run';
  console.log(chalk.cyan(`\nSession dedupe ${action}\n`));
  console.log(`Scanned: ${report.scanned}`);
  console.log(`Runner candidates: ${report.runnerCandidates}`);
  console.log(`Matched: ${report.matches.length}`);
  console.log(`Moved: ${report.moved.length}`);
  if (report.archiveDir) {
    console.log(`Archive: ${report.archiveDir}`);
  }

  if (report.matches.length > 0) {
    console.log(chalk.bold('\nMatches:'));
    for (const match of report.matches) {
      const marker = report.moved.some(
        (move) => move.runnerId === match.runnerId,
      )
        ? 'moved'
        : 'candidate';
      console.log(
        `  ${match.runnerId} -> ${match.canonicalId} (${marker}, score=${match.score})`,
      );
    }
  }

  if (report.skipped.length > 0) {
    const reasonCounts = new Map<string, number>();
    for (const skipped of report.skipped) {
      reasonCounts.set(
        skipped.reason,
        (reasonCounts.get(skipped.reason) ?? 0) + 1,
      );
    }
    console.log(chalk.bold('\nSkipped:'));
    for (const [reason, count] of reasonCounts.entries()) {
      console.log(`  ${reason}: ${count}`);
    }
  }

  if (!applied) {
    console.log(
      chalk.dim(
        '\nRun `kodax sessions dedupe --apply` to move uniquely matched runner ghosts.',
      ),
    );
  }
}

interface DaemonStartResult {
  readonly started: boolean;
  readonly reason?: 'already_running';
  readonly pid?: number | null;
  readonly health?: RuntimeDaemonHealth;
  readonly error?: string;
  readonly state: RuntimeDaemonState | null;
}

interface DaemonStopResult {
  readonly stopped: boolean;
  readonly reason?:
    | RuntimeDaemonHealth
    | 'unverified_owner'
    | 'cleanup_failed'
    | 'cleanup_unverified'
    | 'replacement_running';
  readonly forced?: boolean;
  /** A distinct live owner was observed after the requested daemon exited. */
  readonly replacementRunning?: boolean;
  readonly health?: RuntimeDaemonHealth;
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

interface DaemonRuntimeStatusSummary {
  readonly sessions: number;
  readonly runs: number;
  readonly activeRuns: number;
  readonly queuedRuns: number;
  readonly pendingPermissions: number;
  readonly workflows: number;
}

type DaemonRuntimeStatusProbe =
  | { readonly ok: true; readonly summary: DaemonRuntimeStatusSummary }
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
  const health = classifyRuntimeDaemonHealth(observation);
  const runtimeStatus = await readDaemonRuntimeStatusSummary(
    paths,
    observation.state,
    health,
  );
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
  if (input.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  console.log(chalk.cyan('\nKodaX Runtime Daemon\n'));
  console.log(`Profile: ${snapshot.profile}`);
  console.log(`Health: ${formatDaemonHealth(health)}`);
  console.log(`State: ${snapshot.state ? snapshot.state.status : 'missing'}`);
  if (snapshot.state) {
    console.log(`Runtime: ${snapshot.state.runtimeId}`);
    console.log(
      `PID: ${snapshot.state.pid} (${snapshot.pidAlive ? 'alive' : 'not alive'})`,
    );
    console.log(
      `Endpoint: ${snapshot.state.endpoint} (${snapshot.endpointReachable ? 'reachable' : 'unreachable'})`,
    );
  }
  if (runtimeStatus?.ok === true) {
    console.log(`Sessions: ${runtimeStatus.summary.sessions}`);
    console.log(
      `Runs: ${runtimeStatus.summary.runs} (${runtimeStatus.summary.activeRuns} active, ${runtimeStatus.summary.queuedRuns} queued)`,
    );
    console.log(
      `Pending permissions: ${runtimeStatus.summary.pendingPermissions}`,
    );
    console.log(`Workflows: ${runtimeStatus.summary.workflows}`);
  } else if (runtimeStatus?.ok === false) {
    console.log(
      chalk.yellow(`Runtime status: unavailable (${runtimeStatus.error})`),
    );
  }
  console.log(chalk.dim(`State file: ${snapshot.stateFile}`));
}

async function readDaemonRuntimeStatusSummary(
  paths: ReturnType<typeof resolveRuntimeDaemonPaths>,
  state: RuntimeDaemonState | undefined,
  health: RuntimeDaemonHealth,
): Promise<DaemonRuntimeStatusProbe | null> {
  if (health !== 'healthy' || state === undefined) return null;
  const transport = await createRuntimeDaemonSocketClientTransport(
    runtimeDaemonEndpointFromState(state),
    { connectTimeoutMs: 1_000 },
  );
  try {
    const token = readRuntimeDaemonToken(paths);
    await transport.request('initialize', {
      profile: paths.profile,
      connectionPurpose: 'probe',
      ...(token !== undefined ? { token } : {}),
      clientInfo: { name: 'kodax-cli', title: 'KodaX CLI' },
      capabilities: { configAdmin: true },
    });
    return {
      ok: true,
      summary: summarizeDaemonRuntimeStatus(
        await transport.request('daemon.status'),
      ),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: normalizeCliError(error).message,
    };
  } finally {
    await transport.close?.();
  }
}

function summarizeDaemonRuntimeStatus(
  value: unknown,
): DaemonRuntimeStatusSummary {
  const record = isRecord(value) ? value : {};
  const runs = Array.isArray(record.runs) ? record.runs : [];
  return {
    sessions: arrayLength(record.sessions),
    runs: runs.length,
    activeRuns: runs.filter(isActiveDaemonRunStatus).length,
    queuedRuns: runs.filter(isQueuedDaemonRunStatus).length,
    pendingPermissions: arrayLength(record.pendingPermissions),
    workflows: arrayLength(record.workflows),
  };
}

async function getInteractiveRuntimeStatus(input: {
  readonly runtime: KodaXRuntime;
  readonly configHome: string;
  readonly profile: string;
}): Promise<CliRuntimeSurfaceStatus> {
  const snapshot = await input.runtime.status.snapshot();
  let endpoint: string | undefined;
  let health: string | undefined;
  if (input.runtime.identity.mode === 'daemon') {
    const paths = resolveRuntimeDaemonPathsFromConfigHome(
      input.configHome,
      input.profile,
    );
    const observation = await observeRuntimeDaemonHealth(paths);
    health = classifyRuntimeDaemonHealth(observation);
    endpoint = observation.state?.endpoint;
  }
  const runs = snapshot.runs as readonly unknown[];
  return {
    mode: input.runtime.identity.mode,
    runtimeId: input.runtime.identity.runtimeId,
    profile: input.runtime.identity.profile,
    startedAt: input.runtime.identity.startedAt,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(health !== undefined ? { health } : {}),
    sessions: snapshot.sessions.length,
    runs: snapshot.runs.length,
    activeRuns: runs.filter(isActiveDaemonRunStatus).length,
    queuedRuns: runs.filter(isQueuedDaemonRunStatus).length,
    pendingPermissions: snapshot.pendingPermissions.length,
    workflows: snapshot.workflows.length,
  };
}

interface InteractiveRuntimeRunnerInput {
  readonly options: KodaXOptions;
  readonly prompt: string;
  readonly sessionId: string;
  readonly permissionMode?: string;
  readonly autoModeSettings?: ReplRuntimeAutoModeSettings;
  readonly surface?: 'cli' | 'repl';
  readonly requestPermission?: ReplRuntimePermissionPrompt;
  /** True only for the REPL-owned legacy permission callback. */
  readonly legacyPermissionHook?: true;
}

export function createReplRuntimeAutoModeControl(
  runtime: KodaXRuntime,
): ReplRuntimeAutoModeControl {
  const initializedSessions = new Set<string>();
  const pendingSettingsUpdates = new Map<string, Promise<unknown>>();
  const enqueueSettingsUpdate = <T>(
    sessionId: string,
    update: () => Promise<T>,
  ): Promise<T> => {
    const previous = pendingSettingsUpdates.get(sessionId) ?? Promise.resolve();
    const next = previous.then(update, update);
    let tracked: Promise<T>;
    tracked = next.finally(() => {
      if (pendingSettingsUpdates.get(sessionId) === tracked) {
        pendingSettingsUpdates.delete(sessionId);
      }
    });
    pendingSettingsUpdates.set(sessionId, tracked);
    return tracked;
  };
  const readStats = async (sessionId: string) => {
    try {
      return await runtime.sessions.getAutoModeStats(sessionId);
    } catch (error: unknown) {
      emitKodaXDiagnostic({
        source: 'cli:runtime-auto-mode',
        level: 'warn',
        message: 'Runtime auto-mode status is temporarily unavailable.',
        detail: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };
  return {
    getStats(sessionId) {
      return readStats(sessionId);
    },
    async setEngine(sessionId, engine) {
      return enqueueSettingsUpdate(sessionId, async () => {
        await ensureCliRuntimeSession(runtime, sessionId, 'repl', '');
        await runtime.sessions.updateSettings(sessionId, {
          autoModeEngine: engine,
        });
        initializedSessions.add(sessionId);
        return runtime.sessions.getAutoModeStats(sessionId);
      });
    },
    async syncSettings(sessionId, permissionMode, settings) {
      return enqueueSettingsUpdate(sessionId, async () => {
        try {
          await runtime.sessions.load(sessionId);
        } catch (error: unknown) {
          if (
            error instanceof Error &&
            error.message.startsWith('Session not found:')
          ) {
            return undefined;
          }
          throw error;
        }
        const initializeEngine =
          !initializedSessions.has(sessionId) &&
          (await runtime.sessions.getSettings(sessionId)).autoModeEngine ===
            undefined;
        await runtime.sessions.updateSettings(sessionId, {
          permissionMode,
          ...(initializeEngine ? { autoModeEngine: settings.engine } : {}),
          autoModeClassifierModel: settings.classifierModel ?? null,
          autoModeTimeoutMs: settings.timeoutMs ?? null,
          autoModeSpeculativeWindowMs: settings.speculativeWindowMs ?? null,
        });
        initializedSessions.add(sessionId);
        return readStats(sessionId);
      });
    },
    subscribe(sessionId, listener) {
      let active = true;
      const subscription = runtime.events.subscribe(
        { sessionId, type: 'session.settings.updated' },
        () => {
          void readStats(sessionId).then((stats) => {
            if (active) listener(stats);
          });
        },
      );
      return {
        close() {
          active = false;
          subscription.close();
        },
      };
    },
  };
}

interface RuntimeReplEventBridge {
  setRunId(runId: string): void;
  close(): Promise<void>;
}

export function createInteractiveRuntimeRunner(
  runtime: KodaXRuntime,
  autoModeControl: ReplRuntimeAutoModeControl = createReplRuntimeAutoModeControl(
    runtime,
  ),
) {
  return async (
    input: InteractiveRuntimeRunnerInput,
  ): Promise<Awaited<ReturnType<typeof runManagedTask>>> => {
    // Validate transport-isolated options before any durable Session write.
    // An impossible Run must not leave an empty Session or changed settings.
    const transportIsolated =
      runtime.identity.mode === 'daemon' ||
      runtime.identity.isolation === 'worker';
    const workerHosted = runtime.identity.isolation === 'worker';
    const invocationPolicy = input.options.context?.skillInvocation?.runtimePolicy;
    const policyOptions: KodaXOptions = transportIsolated && invocationPolicy
      ? {
          ...input.options,
          context: {
            ...input.options.context,
            skillInvocation: {
              ...input.options.context?.skillInvocation,
              runtimePolicy: { ...invocationPolicy, enforceAtRuntime: true },
            },
          },
        }
      : input.options;
    const runtimeOptions = toRuntimeOwnedInteractiveOptions(policyOptions, {
      // Only Worker isolation strips callbacks the outer CLI has already
      // rejected. Daemon mode keeps host bindings for loud validation below.
      omitLegacyBeforeToolExecute:
        input.legacyPermissionHook === true || workerHosted ||
        (transportIsolated && invocationPolicy !== undefined),
      omitExtensionRuntime: workerHosted,
    });
    const startOptions = transportIsolated
      ? toDaemonRuntimeRunOptions(runtimeOptions)
      : runtimeOptions;

    await ensureCliRuntimeSession(
      runtime,
      input.sessionId,
      input.surface ?? 'repl',
      input.prompt,
    );
    if (
      input.permissionMode !== undefined &&
      input.autoModeSettings !== undefined &&
      autoModeControl.syncSettings !== undefined
    ) {
      await autoModeControl.syncSettings(
        input.sessionId,
        input.permissionMode,
        input.autoModeSettings,
      );
    } else if (input.permissionMode !== undefined) {
      await runtime.sessions.updateSettings(input.sessionId, {
        permissionMode: input.permissionMode,
      });
    }
    const bridge = createRuntimeReplEventBridge(runtime, input);
    const abortSignal = input.options.abortSignal;
    let abortRun: (() => void) | undefined;
    try {
      const handle = await runtime.runs.start({
        sessionId: input.sessionId,
        prompt: input.prompt,
        mode: 'managed_task',
        permissionBroker:
          input.requestPermission === undefined ? 'runtime' : 'client',
        options: startOptions,
      });
      bridge.setRunId(handle.runId);
      abortRun = () => {
        void runtime.runs.abort(handle.runId).catch(() => undefined);
      };
      if (abortSignal?.aborted) {
        abortRun();
      } else {
        abortSignal?.addEventListener('abort', abortRun, { once: true });
      }

      const result = await handle.result;
      if (result.error) throw normalizeCliError(result.error);
      if (!result.result) {
        if (result.phase === 'cancelled' || result.phase === 'interrupted') {
          return interruptedRuntimeResult(input.sessionId);
        }
        throw new Error(`Runtime run ${handle.runId} ended without a result.`);
      }
      return result.result;
    } finally {
      if (abortRun) abortSignal?.removeEventListener('abort', abortRun);
      await bridge.close();
    }
  };
}

/** Keep the shared Session Runtime as the sole owner of Auto receipts. */
export function toRuntimeOwnedInteractiveOptions(
  options: KodaXOptions,
  sanitization: {
    readonly omitLegacyBeforeToolExecute?: boolean;
    readonly omitExtensionRuntime?: boolean;
  } = {},
): KodaXOptions {
  const guardrails = options.guardrails?.filter(
    (guardrail) => guardrail.kind !== 'tool' || guardrail.name !== 'auto-mode',
  );
  const events = sanitization.omitLegacyBeforeToolExecute
    ? omitBeforeToolExecute(options.events)
    : options.events;
  return {
    ...options,
    ...(sanitization.omitExtensionRuntime
      ? { extensionRuntime: undefined }
      : {}),
    ...(guardrails !== undefined
      ? { guardrails: guardrails.length > 0 ? guardrails : undefined }
      : {}),
    ...(events !== undefined ? { events } : {}),
  };
}

function omitBeforeToolExecute(
  events: KodaXOptions['events'],
): KodaXOptions['events'] {
  if (events === undefined) return undefined;
  const { beforeToolExecute: _beforeToolExecute, ...rest } = events;
  return rest;
}

async function ensureCliRuntimeSession(
  runtime: KodaXRuntime,
  sessionId: string,
  surface: 'cli' | 'repl',
  prompt: string,
): Promise<void> {
  try {
    await runtime.sessions.load(sessionId);
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith('Session not found:')
    ) {
      throw error;
    }
    await runtime.sessions.create({
      sessionId,
      title: surface === 'repl' ? 'REPL Session' : prompt.slice(0, 50),
      projectPath: process.cwd(),
      gitRoot: (await getGitRoot()) ?? process.cwd(),
      surface,
    });
  }
}

async function runCliTaskWithRuntime(
  runtime: KodaXRuntime,
  options: KodaXOptions,
  prompt: string,
): Promise<Awaited<ReturnType<typeof runManagedTask>>> {
  const sessionId = await resolveCliTaskSessionId(options);
  const transientSession = options.session === undefined;
  const runOptions: KodaXOptions =
    options.session === undefined
      ? options
      : {
          ...options,
          session: { ...options.session, id: sessionId },
        };
  try {
    return await createInteractiveRuntimeRunner(runtime)({
      options: runOptions,
      prompt,
      sessionId,
      surface: 'cli',
    });
  } finally {
    if (transientSession) {
      await runtime.sessions.delete(sessionId);
    }
  }
}

export async function prepareCliSkillInvocation(
  userPrompt: string,
  options: KodaXOptions,
  emit: (message: string) => void = () => {},
): Promise<PreparedInvocation | undefined> {
  const invocation = await resolveUserSkillInvocation(userPrompt, {
    workingDirectory: options.context?.executionCwd ?? process.cwd(),
    projectRoot: options.context?.gitRoot ?? (await getGitRoot()) ?? process.cwd(),
    environment: {},
    executeDynamicContext: options.skillDynamicContext?.execute,
    disableDynamicContext: options.skillDynamicContext?.disable,
  });
  return invocation
    ? prepareInvocationExecution(options, invocation, userPrompt, emit)
    : undefined;
}

async function resolveCliTaskSessionId(options: KodaXOptions): Promise<string> {
  if (options.session?.id) return options.session.id;
  if (
    (options.session?.resume || options.session?.autoResume) &&
    options.session.storage?.list
  ) {
    const storage = options.session.storage;
    const list = storage.list;
    const recent = await findMostRecentResumableSession(
      {
        list: (gitRoot, listOptions) =>
          list.call(storage, gitRoot, listOptions),
      },
      options.context?.gitRoot ?? undefined,
    );
    if (recent) return recent.id;
  }
  return generateSessionId();
}

function interruptedRuntimeResult(
  sessionId: string,
): Awaited<ReturnType<typeof runManagedTask>> {
  return {
    success: false,
    lastText: '',
    messages: [],
    sessionId,
    interrupted: true,
    signal: 'BLOCKED',
    signalReason: 'Runtime run cancelled.',
  };
}

export function toDaemonRuntimeRunOptions(
  options: KodaXOptions,
): RuntimeKodaXOptions {
  assertDaemonHostBindingsAbsent(options);
  const {
    events,
    session,
    context,
    abortSignal: _abortSignal,
    extensionRuntime: _extensionRuntime,
    sessionControl: _sessionControl,
    memoryReviewer: _memoryReviewer,
    learningReviewer: _learningReviewer,
    memoryRecallRunner: _memoryRecallRunner,
    guardrails: _guardrails,
    skillDynamicContext,
    ...wireOptions
  } = options;
  const { storage: _storage, ...wireSession } = session ?? {};
  const {
    configHome: _configHome,
    memoryIdentity: _memoryIdentity,
    agentScope: _agentScope,
    mutationTracker: _mutationTracker,
    toolVisibilityPolicy: _toolVisibilityPolicy,
    planModeBlockCheck: _planModeBlockCheck,
    goalRuntime: _goalRuntime,
    lspService: _lspService,
    skillRegistry: _skillRegistry,
    ...wireContext
  } = context ?? {};
  const candidate: RuntimeKodaXOptions = {
    ...wireOptions,
    ...(Object.keys(wireSession).length > 0 ? { session: wireSession } : {}),
    ...(Object.keys(wireContext).length > 0 ? { context: wireContext } : {}),
    ...(events?.workflowCorrelation !== undefined
      ? { events: { workflowCorrelation: events.workflowCorrelation } }
      : {}),
    ...(skillDynamicContext?.disable !== undefined
      ? { skillDynamicContext: { disable: skillDynamicContext.disable } }
      : {}),
  };
  try {
    const encoded = JSON.stringify(candidate);
    const cloned: unknown = JSON.parse(encoded);
    if (!isRecord(cloned)) throw new Error('expected an object');
    return cloned as RuntimeKodaXOptions;
  } catch (error: unknown) {
    throw new Error(
      `Daemon runtime options are not JSON serializable: ${normalizeCliError(error).message}`,
    );
  }
}

function assertDaemonHostBindingsAbsent(options: KodaXOptions): void {
  const unsupported: Array<readonly [string, unknown]> = [
    ['extensionRuntime', options.extensionRuntime],
    ['sessionControl', options.sessionControl],
    ['memoryReviewer', options.memoryReviewer],
    ['learningReviewer', options.learningReviewer],
    ['memoryRecallRunner', options.memoryRecallRunner],
    ['guardrails', options.guardrails],
    ['events.beforeToolExecute', options.events?.beforeToolExecute],
    ['skillDynamicContext.execute', options.skillDynamicContext?.execute],
    ['context.agentScope', options.context?.agentScope],
    ['context.mutationTracker', options.context?.mutationTracker],
    ['context.toolVisibilityPolicy', options.context?.toolVisibilityPolicy],
    ['context.planModeBlockCheck', options.context?.planModeBlockCheck],
    ['context.goalRuntime', options.context?.goalRuntime],
    ['context.lspService', options.context?.lspService],
  ];
  const binding = unsupported.find(([, value]) => value !== undefined);
  if (!binding) return;
  throw new Error(
    `KodaX daemon run option '${binding[0]}' cannot cross the process boundary. ` +
      'Configure the capability in the daemon owner or use embedded mode.',
  );
}

function createRuntimeReplEventBridge(
  runtime: KodaXRuntime,
  input: InteractiveRuntimeRunnerInput,
): RuntimeReplEventBridge {
  const buffered: RuntimeEvent[] = [];
  const toolInputs = new Map<string, Record<string, unknown>>();
  let activeRunId: string | undefined;
  let eventChain = Promise.resolve();
  const enqueue = (event: RuntimeEvent): void => {
    eventChain = eventChain
      .then(() => forwardRuntimeReplEvent(runtime, input, event, toolInputs))
      .catch((error: unknown) => {
        try {
          input.options.events?.onError?.(normalizeCliError(error));
        } catch {
          // A UI observer cannot be allowed to break the daemon permission bridge.
        }
      });
  };
  const subscription = runtime.events.subscribe(
    { sessionId: input.sessionId },
    (event) => {
      if (activeRunId === undefined) {
        buffered.push(event);
      } else if (event.runId === activeRunId) {
        enqueue(event);
      }
    },
  );
  return {
    setRunId(runId) {
      activeRunId = runId;
      for (const event of buffered.splice(0)) {
        if (event.runId === runId) enqueue(event);
      }
    },
    async close() {
      subscription.close();
      await eventChain;
    },
  };
}

async function forwardRuntimeReplEvent(
  runtime: KodaXRuntime,
  input: InteractiveRuntimeRunnerInput,
  event: RuntimeEvent,
  toolInputs: Map<string, Record<string, unknown>>,
): Promise<void> {
  const payload = isRecord(event.payload) ? event.payload : {};
  if (event.type === 'permission.requested') {
    await respondToRuntimePermission(
      runtime,
      input.requestPermission,
      event,
      payload,
      toolInputs,
    );
    return;
  }
  if (runtime.identity.mode !== 'daemon') return;
  const events = input.options.events;
  if (forwardDaemonStreamEvent(events, event, payload, toolInputs)) return;
  if (forwardDaemonLifecycleEvent(events, event, payload)) return;
  forwardDaemonDiagnosticEvent(events, event, payload);
}

function forwardDaemonStreamEvent(
  events: KodaXOptions['events'],
  event: RuntimeEvent,
  payload: Record<string, unknown>,
  toolInputs: Map<string, Record<string, unknown>>,
): boolean {
  const meta = payload.meta as Parameters<
    NonNullable<KodaXEvents['onTextDelta']>
  >[1];
  if (event.type === 'assistant.delta' && typeof payload.text === 'string') {
    events?.onTextDelta?.(payload.text, meta);
  } else if (
    event.type === 'thinking.delta' &&
    typeof payload.text === 'string'
  ) {
    events?.onThinkingDelta?.(payload.text, meta);
  } else if (
    event.type === 'thinking.finished' &&
    typeof payload.thinking === 'string'
  ) {
    events?.onThinkingEnd?.(payload.thinking, meta);
  } else if (event.type === 'tool.started' && isRecord(payload.tool)) {
    const tool = payload.tool as Parameters<
      NonNullable<KodaXEvents['onToolUseStart']>
    >[0];
    if (typeof tool.id === 'string' && isRecord(tool.input))
      toolInputs.set(tool.id, tool.input);
    events?.onToolUseStart?.(
      tool,
      payload.meta as Parameters<NonNullable<KodaXEvents['onToolUseStart']>>[1],
    );
  } else if (event.type === 'tool.progress') {
    forwardDaemonToolProgress(events, payload);
  } else if (event.type === 'tool.sandbox' && isRecord(payload.update)) {
    events?.onToolSandboxObservation?.(
      payload.update as Parameters<
        NonNullable<KodaXEvents['onToolSandboxObservation']>
      >[0],
      payload.meta as Parameters<
        NonNullable<KodaXEvents['onToolSandboxObservation']>
      >[1],
    );
  } else if (event.type === 'tool.finished' && isRecord(payload.result)) {
    const result = payload.result as Parameters<
      NonNullable<KodaXEvents['onToolResult']>
    >[0];
    if (typeof result.id === 'string') toolInputs.delete(result.id);
    events?.onToolResult?.(
      result,
      payload.meta as Parameters<NonNullable<KodaXEvents['onToolResult']>>[1],
    );
  } else {
    return false;
  }
  return true;
}

function forwardDaemonToolProgress(
  events: KodaXOptions['events'],
  payload: Record<string, unknown>,
): void {
  if (isRecord(payload.update)) {
    events?.onToolProgress?.(
      payload.update as Parameters<
        NonNullable<KodaXEvents['onToolProgress']>
      >[0],
      payload.meta as Parameters<NonNullable<KodaXEvents['onToolProgress']>>[1],
    );
  } else if (
    typeof payload.toolName === 'string' &&
    typeof payload.partialJson === 'string'
  ) {
    events?.onToolInputDelta?.(
      payload.toolName,
      payload.partialJson,
      payload.meta as Parameters<
        NonNullable<KodaXEvents['onToolInputDelta']>
      >[2],
    );
  }
}

function forwardDaemonLifecycleEvent(
  events: KodaXOptions['events'],
  event: RuntimeEvent,
  payload: Record<string, unknown>,
): boolean {
  if (event.type === 'session.loaded') {
    events?.onSessionStart?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onSessionStart']>
      >[0],
    );
  } else if (event.type === 'turn.started') {
    events?.onTurnStarted?.(
      event.payload as Parameters<NonNullable<KodaXEvents['onTurnStarted']>>[0],
    );
  } else if (event.type === 'turn.completed') {
    events?.onTurnCompleted?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onTurnCompleted']>
      >[0],
    );
  } else if (event.type === 'turn.failed') {
    events?.onTurnFailed?.(
      event.payload as Parameters<NonNullable<KodaXEvents['onTurnFailed']>>[0],
    );
  } else if (event.type === 'run.progress') {
    forwardDaemonRunProgress(events, payload);
  } else if (event.type.startsWith('context.compaction.')) {
    forwardDaemonCompactionEvent(events, event, payload);
  } else if (event.type === 'child_activity.finished') {
    events?.onChildActivityEnd?.(
      payload.meta as Parameters<
        NonNullable<KodaXEvents['onChildActivityEnd']>
      >[0],
    );
  } else {
    return false;
  }
  return true;
}

function forwardDaemonRunProgress(
  events: KodaXOptions['events'],
  payload: Record<string, unknown>,
): void {
  if (payload.kind === 'stream_end') {
    events?.onStreamEnd?.(
      payload.meta as Parameters<NonNullable<KodaXEvents['onStreamEnd']>>[0],
    );
  } else if (
    payload.kind === 'iteration_start' &&
    typeof payload.iter === 'number' &&
    typeof payload.maxIter === 'number'
  ) {
    events?.onIterationStart?.(
      payload.iter,
      payload.maxIter,
      payload.meta as Parameters<
        NonNullable<KodaXEvents['onIterationStart']>
      >[2],
    );
  } else if (payload.kind === 'iteration_end' && isRecord(payload.info)) {
    events?.onIterationEnd?.(
      payload.info as Parameters<NonNullable<KodaXEvents['onIterationEnd']>>[0],
    );
  } else if (
    payload.kind === 'mid_turn_user_messages' &&
    Array.isArray(payload.contents)
  ) {
    events?.onMidTurnUserMessages?.(
      payload.contents.filter(
        (item): item is string => typeof item === 'string',
      ),
      payload.meta as Parameters<
        NonNullable<KodaXEvents['onMidTurnUserMessages']>
      >[1],
    );
  } else if (
    payload.kind === 'managed_task_status' &&
    isRecord(payload.status)
  ) {
    events?.onManagedTaskStatus?.(
      payload.status as unknown as Parameters<
        NonNullable<KodaXEvents['onManagedTaskStatus']>
      >[0],
    );
  } else if (payload.kind === 'complete') {
    events?.onComplete?.(
      payload.meta as Parameters<NonNullable<KodaXEvents['onComplete']>>[0],
    );
  }
}

export function forwardDaemonCompactionEvent(
  events: KodaXOptions['events'],
  event: RuntimeEvent,
  payload: Record<string, unknown>,
): void {
  const meta = payload.meta as Parameters<
    NonNullable<KodaXEvents['onCompactStart']>
  >[0];
  if (event.type === 'context.compaction.started') {
    events?.onCompactStart?.(meta);
  } else if (
    event.type === 'context.compaction.finished' &&
    typeof payload.tokensAfter === 'number'
  ) {
    if (payload.committed === true) {
      events?.onCompact?.(payload.tokensAfter, meta);
    }
    events?.onContextCompactionFinished?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onContextCompactionFinished']>
      >[0],
    );
  } else if (event.type === 'context.compaction.stats') {
    events?.onCompactStats?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onCompactStats']>
      >[0],
    );
  } else if (event.type === 'context.compaction.ended') {
    const { meta: _meta, ...result } = payload;
    events?.onCompactEnd?.(
      meta,
      (typeof result.outcome === 'string'
        ? result
        : undefined) as Parameters<
          NonNullable<KodaXEvents['onCompactEnd']>
        >[1],
    );
  } else if (event.type === 'context.compaction.skipped') {
    events?.onContextCompactionSkipped?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onContextCompactionSkipped']>
      >[0],
    );
  }
}

function forwardDaemonDiagnosticEvent(
  events: KodaXOptions['events'],
  event: RuntimeEvent,
  payload: Record<string, unknown>,
): void {
  if (event.type === 'provider.retry') {
    forwardDaemonRetryEvent(events, payload);
  } else if (event.type === 'provider.recovery') {
    forwardDaemonRecoveryEvent(events, payload);
  } else if (event.type === 'repo_intelligence.trace') {
    events?.onRepoIntelligenceTrace?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onRepoIntelligenceTrace']>
      >[0],
    );
  } else if (event.type === 'context.budget.snapshot') {
    events?.onContextBudgetSnapshot?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onContextBudgetSnapshot']>
      >[0],
    );
  } else if (event.type === 'provider.cache.diagnostics') {
    events?.onPromptCacheDiagnostics?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onPromptCacheDiagnostics']>
      >[0],
    );
  } else if (event.type === 'tool.exposure.planned') {
    events?.onToolExposurePlanned?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onToolExposurePlanned']>
      >[0],
    );
  } else if (event.type === 'sidecar.message') {
    events?.onSidecarMessage?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onSidecarMessage']>
      >[0],
    );
  } else if (event.type === 'todo.updated' && Array.isArray(payload.items)) {
    events?.onTodoUpdate?.(
      payload.items as Parameters<NonNullable<KodaXEvents['onTodoUpdate']>>[0],
      payload.meta as Parameters<NonNullable<KodaXEvents['onTodoUpdate']>>[1],
    );
  } else if (event.type === 'todo.warning') {
    events?.onTodoDriftWarning?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onTodoDriftWarning']>
      >[0],
    );
  } else if (event.type === 'config.effective') {
    events?.onEffectiveConfig?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onEffectiveConfig']>
      >[0],
    );
  } else if (event.type.startsWith('workflow.')) {
    events?.onWorkflowProcessEvent?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onWorkflowProcessEvent']>
      >[0],
    );
  } else if (
    event.type === 'runtime.warning' &&
    typeof payload.message === 'string'
  ) {
    events?.onError?.(new Error(payload.message));
  }
}

function forwardDaemonRetryEvent(
  events: KodaXOptions['events'],
  payload: Record<string, unknown>,
): void {
  if (isRecord(payload.retryAfter)) {
    events?.onRetryAfter?.(
      payload.retryAfter as Parameters<
        NonNullable<KodaXEvents['onRetryAfter']>
      >[0],
      payload.meta as Parameters<NonNullable<KodaXEvents['onRetryAfter']>>[1],
    );
  } else if (
    payload.reason === 'rate_limit' &&
    typeof payload.attempt === 'number' &&
    typeof payload.maxAttempts === 'number' &&
    typeof payload.delayMs === 'number'
  ) {
    events?.onProviderRateLimit?.(
      payload.attempt,
      payload.maxAttempts,
      payload.delayMs,
    );
  } else if (
    typeof payload.reason === 'string' &&
    typeof payload.attempt === 'number' &&
    typeof payload.maxAttempts === 'number'
  ) {
    events?.onRetry?.(payload.reason, payload.attempt, payload.maxAttempts);
  }
}

function forwardDaemonRecoveryEvent(
  events: KodaXOptions['events'],
  payload: Record<string, unknown>,
): void {
  if (payload.kind === 'reasoning_effort_rejected' && isRecord(payload.event)) {
    events?.onReasoningEffortRejected?.(
      payload.event as Parameters<
        NonNullable<KodaXEvents['onReasoningEffortRejected']>
      >[0],
    );
  } else if (isRecord(payload.event)) {
    events?.onProviderRecovery?.(
      payload.event as unknown as Parameters<
        NonNullable<KodaXEvents['onProviderRecovery']>
      >[0],
      payload.meta as Parameters<
        NonNullable<KodaXEvents['onProviderRecovery']>
      >[1],
    );
  }
}

async function respondToRuntimePermission(
  runtime: KodaXRuntime,
  requestPermission: ReplRuntimePermissionPrompt | undefined,
  event: RuntimeEvent,
  payload: Record<string, unknown>,
  toolInputs: ReadonlyMap<string, Record<string, unknown>>,
): Promise<void> {
  if (typeof payload.id !== 'string' || typeof payload.toolName !== 'string')
    return;
  const toolCallId =
    typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
  const input =
    toolCallId !== undefined
      ? (toolInputs.get(toolCallId) ??
        parsePermissionInput(payload.inputPreview))
      : parsePermissionInput(payload.inputPreview);
  const grantSuggestions = parseRuntimeGrantSuggestions(
    payload.grantSuggestions,
  );
  const request = {
    id: payload.id,
    sessionId: event.sessionId,
    runId: event.runId,
    toolName: payload.toolName,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    input,
    ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    ...(isRuntimePermissionRisk(payload.risk) ? { risk: payload.risk } : {}),
    ...(typeof payload.executionCwd === 'string'
      ? { executionCwd: payload.executionCwd }
      : {}),
    ...(grantSuggestions.length > 0 ? { grantSuggestions } : {}),
    createdAt:
      typeof payload.createdAt === 'string' ? payload.createdAt : event.time,
    ...(typeof payload.expiresAt === 'string' ? { expiresAt: payload.expiresAt } : {}),
  };
  await handleRuntimePermissionRequest(
    runtime,
    request,
    requestPermission
      ? async (_runtimeRequest, context) => requestPermission(request, context)
      : async () => ({
          type: 'reject',
          reason: 'Interactive permission handler unavailable.',
        }),
  );
}

function isRuntimePermissionRisk(
  value: unknown,
): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high';
}

function parseRuntimeGrantSuggestions(
  value: unknown,
): ReplRuntimePermissionGrantSuggestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      (candidate.kind !== 'session' && candidate.kind !== 'persistent') ||
      typeof candidate.label !== 'string'
    )
      return [];
    return [{ id: candidate.id, kind: candidate.kind, label: candidate.label }];
  });
}

function parsePermissionInput(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { _inputPreview: value };
  } catch {
    return { _inputPreview: value };
  }
}

function isActiveDaemonRunStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.phase === 'running' ||
    value.phase === 'waiting_permission' ||
    value.phase === 'waiting_user_input'
  );
}

function isQueuedDaemonRunStatus(value: unknown): boolean {
  return isRecord(value) && value.phase === 'queued';
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

async function startDaemonCommand(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly json: boolean;
}): Promise<void> {
  const paths = resolveRuntimeDaemonPathsFromConfigHome(
    input.configHome,
    input.profile,
  );
  const result = await getDaemonStartResult(input);
  if (input.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.reason === 'already_running') {
    console.log(
      chalk.green(
        `KodaX runtime daemon already running for profile "${paths.profile}".`,
      ),
    );
    return;
  }
  if (result.health !== 'healthy') {
    throw new Error(
      result.error ??
        `KodaX runtime daemon did not become healthy within ${input.timeoutMs}ms.`,
    );
  }
  console.log(
    chalk.green(`KodaX runtime daemon started for profile "${paths.profile}".`),
  );
  if (result.state) {
    console.log(chalk.dim(`PID: ${result.state.pid}`));
    console.log(chalk.dim(`Endpoint: ${result.state.endpoint}`));
  }
}

async function getDaemonStartResult(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
}): Promise<DaemonStartResult> {
  const paths = resolveRuntimeDaemonPathsFromConfigHome(
    input.configHome,
    input.profile,
  );
  const before = await observeRuntimeDaemonHealth(paths);
  const beforeHealth = classifyRuntimeDaemonHealth(before);
  if (beforeHealth === 'healthy' && before.state?.status === 'ready') {
    return {
      started: false,
      reason: 'already_running',
      state: before.state,
    };
  }
  if (beforeHealth === 'healthy' && before.state) {
    const cancellation = createDaemonStartupCancellation();
    try {
      const ready = await waitForReadyRuntimeDaemonOwner(
        paths,
        {
          startupTimeoutMs: input.timeoutMs,
          startupSignal: cancellation.signal,
        },
        before,
      );
      return {
        started: false,
        reason: 'already_running',
        state: ready.state,
      };
    } finally {
      cancellation.close();
    }
  }
  if (beforeHealth === 'unhealthy' || beforeHealth === 'mismatch') {
    return {
      started: false,
      health: beforeHealth,
      error: `Runtime daemon is ${beforeHealth}; refusing to start a competing owner.`,
      state: before.state ?? null,
    };
  }

  const cancellation = createDaemonStartupCancellation();
  try {
    const child = await spawnRuntimeDaemonServeProcess({
      profile: paths.profile,
      homeDir: input.homeDir,
      configHome: input.configHome,
      defaultProvider: input.provider,
      defaultModel: input.model,
      startupTimeoutMs: input.timeoutMs,
    });
    try {
      const observation = await waitForHealthyDaemonStartup(
        paths,
        {
          startupTimeoutMs: input.timeoutMs,
          startupSignal: cancellation.signal,
        },
        child,
      );
      return {
        started: true,
        pid: child.pid ?? null,
        health: 'healthy',
        state: observation.state,
      };
    } catch (error: unknown) {
      if (
        !(error instanceof RuntimeDaemonStartupError) ||
        error.reason === 'cancelled'
      ) {
        throw error;
      }
      const observation = await observeRuntimeDaemonHealth(paths);
      return {
        started: false,
        pid: child.pid ?? null,
        health: classifyRuntimeDaemonHealth(observation),
        error: error.message,
        state: observation.state ?? null,
      };
    }
  } finally {
    cancellation.close();
  }
}

async function serveDaemonCommand(input: {
  readonly profile: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly provider?: string;
  readonly model?: string;
  readonly sessionsDir?: string;
  readonly permissionTimeoutMs?: number;
  readonly userInputTimeoutMs?: number;
  readonly orphanExitMs?: number;
}): Promise<void> {
  const daemonConfigHome = path.resolve(input.configHome);
  const daemonPaths = resolveRuntimeDaemonPathsFromConfigHome(
    daemonConfigHome,
    input.profile,
  );
  if (process.env.KODAX_DAEMON_SERVE === '1') {
    detachRuntimeDaemonBootstrapOutput(
      daemonPaths,
    );
    const internalBootstrapBytes = Number.parseInt(
      process.env.KODAX_INTERNAL_DAEMON_TEST_BOOTSTRAP_BYTES ?? '',
      10,
    );
    if (Number.isSafeInteger(internalBootstrapBytes) && internalBootstrapBytes > 0) {
      process.stderr.write(
        Buffer.alloc(
          Math.min(internalBootstrapBytes, RUNTIME_DAEMON_BOOTSTRAP_LOG_MAX_BYTES * 4),
          'x',
        ),
      );
    }
  }
  const extensions = await createDaemonOwnedExtensionRuntime(daemonConfigHome);
  const a2aIntegration = createConfiguredA2ARuntimeIntegration({
    configHome: daemonConfigHome,
    onEvent: (message) => console.error(chalk.dim(`[integrations] ${message}`)),
  });
  let ownedRuntime: KodaXRuntime | undefined;
  let a2aHandle: ConfiguredA2ARuntimeHandle | undefined;
  let completedNormally = false;
  let ownedRuntimeId: string | undefined;
  let primaryError: Error | undefined;
  try {
    const lease = await acquireRuntimeDaemonLease({
      profile: input.profile,
      homeDir: input.homeDir,
      configHome: daemonConfigHome,
      // The host is created only after createRuntime returns, so this trusted
      // fact is never observable until reconcile and watcher startup succeed.
      ownsA2AConfigReconciler: true,
      integrationStatuses: () => [
        ...extensions.hotReload.statuses(),
        ...(a2aHandle ? [a2aHandle.status()] : []),
      ],
      ...(input.orphanExitMs !== undefined ? { orphanExitMs: input.orphanExitMs } : {}),
      createRuntime: async (runtimeId) => {
        const usesCanonicalHome = isSameRuntimeDaemonPath(
          daemonConfigHome,
          path.join(input.homeDir, '.kodax'),
        );
        const runtime = await createKodaXRuntime({
          mode: 'embedded',
          profile: input.profile,
          ...(usesCanonicalHome ? { homeDir: input.homeDir } : {}),
          sessionsDir:
            input.sessionsDir ?? path.join(daemonConfigHome, 'sessions'),
          defaultProvider: input.provider,
          defaultModel: input.model,
          permissionTimeoutMs: input.permissionTimeoutMs,
          userInputTimeoutMs: input.userInputTimeoutMs,
          sharedDaemonHost: true,
          daemonHostRuntimeId: runtimeId,
          externalAgents: a2aIntegration.runtimeOptions,
        });
        ownedRuntime = runtime;
        try {
          a2aHandle = await a2aIntegration.start(runtime);
          return runtime;
        } catch (error: unknown) {
          try {
            await runtime.close();
          } catch (cleanupError: unknown) {
            throw new AggregateError(
              [error, cleanupError],
              'Runtime daemon A2A initialization failed and Runtime cleanup also failed.',
            );
          } finally {
            ownedRuntime = undefined;
          }
          throw error;
        }
      },
    });
    if (!lease.ownsHost) {
      await lease.close();
      const observation = await observeRuntimeDaemonHealth(lease.paths);
      console.log(
        chalk.yellow(
          `KodaX runtime daemon already owned by PID ${observation.state?.pid ?? 'unknown'}.`,
        ),
      );
      completedNormally = true;
      return;
    }
    if (!ownedRuntime) throw new Error('Runtime daemon owner was not created.');
    ownedRuntimeId = ownedRuntime.identity.runtimeId;
    const hostClosed = lease.hostClosed;
    if (!hostClosed) {
      await lease.shutdown();
      throw new Error(
        'Owned Runtime daemon lease did not expose its close signal.',
      );
    }
    const testParentWatch = watchRuntimeDaemonTestParent(
      process.env.KODAX_INTERNAL_DAEMON_TEST_PARENT_PID,
    );
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      shutdownPromise ??= lease.shutdown();
      return shutdownPromise;
    };
    const externallyClosed =
      testParentWatch === undefined
        ? hostClosed
        : Promise.race([hostClosed, testParentWatch.exited.then(shutdown)]);
    try {
      await waitForShutdownSignal(shutdown, externallyClosed);
    } finally {
      testParentWatch?.close();
      a2aHandle?.close();
      a2aHandle = undefined;
      await shutdown();
    }
    completedNormally = true;
  } catch (error: unknown) {
    primaryError = normalizeCliError(error);
  }

  await applyDaemonFinalCleanupTestPause();

  let cleanupError: Error | undefined;
  try {
    await cleanupDaemonServeProcessResources({
      closeA2A: () => {
        a2aHandle?.close();
        a2aHandle = undefined;
      },
      closeHotReload: () => extensions.hotReload.close(),
      disposeExtensions: () => extensions.runtime.dispose(),
    });
  } catch (error: unknown) {
    cleanupError = normalizeCliError(error);
  }

  let finalError = combineDaemonShutdownErrors(primaryError, cleanupError);
  if (ownedRuntimeId !== undefined) {
    const succeeded = completedNormally && finalError === undefined;
    try {
      const pruneErrors = writeRuntimeDaemonShutdownOutcome(daemonPaths, {
        version: 1,
        runtimeId: ownedRuntimeId,
        pid: process.pid,
        status: succeeded ? 'succeeded' : 'failed',
        completedAt: new Date().toISOString(),
        ...(succeeded ? {} : {
          error: 'Runtime daemon shutdown did not complete successfully. See daemon.log.',
        }),
      });
      for (const error of pruneErrors) {
        emitKodaXDiagnostic({
          source: 'runtime.daemon',
          level: 'warn',
          message: 'Failed to prune an older daemon shutdown outcome.',
          detail: error.message,
        });
      }
    } catch (error: unknown) {
      finalError = combineDaemonShutdownErrors(
        finalError,
        new Error('Runtime daemon shutdown outcome could not be persisted.', { cause: error }),
      );
    }
    try {
      appendRuntimeDaemonLog(
        daemonPaths,
        finalError === undefined ? 'info' : 'error',
        finalError === undefined
          ? 'Runtime daemon stopped.'
          : 'Runtime daemon process cleanup failed.',
      );
    } catch {
      // The durable outcome is the stop success fence; logging is best-effort here.
    }
  }

  const ownsDaemonServeProcess =
    process.env.KODAX_DAEMON_SERVE === '1' || process.env.VITEST !== 'true';
  if (finalError !== undefined) {
    if (ownsDaemonServeProcess) {
      console.error(chalk.red(`[Error] ${finalError.message}`));
      process.exit(1);
    }
    throw finalError;
  }
  if (completedNormally && ownsDaemonServeProcess) {
    process.exit(process.exitCode ?? 0);
  }
}

async function applyDaemonFinalCleanupTestPause(): Promise<void> {
  const delayMs = parseInternalDaemonTestDuration(
    process.env.KODAX_INTERNAL_DAEMON_TEST_FINAL_CLEANUP_DELAY_MS,
  );
  if (delayMs > 0) await delay(delayMs);
  const blockMs = parseInternalDaemonTestDuration(
    process.env.KODAX_INTERNAL_DAEMON_TEST_FINAL_CLEANUP_BLOCK_MS,
  );
  if (blockMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
  }
}

function parseInternalDaemonTestDuration(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 30_000)
    : 0;
}

function combineDaemonShutdownErrors(
  primary: Error | undefined,
  cleanup: Error | undefined,
): Error | undefined {
  if (primary === undefined) return cleanup;
  if (cleanup === undefined) return primary;
  return new AggregateError(
    [primary, cleanup],
    `Runtime daemon shutdown and process cleanup both failed: ${primary.message}; ${cleanup.message}`,
  );
}

// A daemon may legitimately spend up to 130 seconds draining the shared ASRT
// workspace queue, followed by the 15-second memory review durability window.
const DEFAULT_DAEMON_FINAL_CLEANUP_TIMEOUT_MS = 160_000;
const DEFAULT_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS = 5_000;
const MEMORY_REVIEW_DRAIN_TIMEOUT_MS = 15_000;
const MEMORY_REVIEW_CLEANUP_GUARD_TIMEOUT_MS = MEMORY_REVIEW_DRAIN_TIMEOUT_MS + 1_000;

function daemonFinalCleanupTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.KODAX_INTERNAL_DAEMON_FINAL_CLEANUP_TIMEOUT_MS ?? '',
    10,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_DAEMON_FINAL_CLEANUP_TIMEOUT_MS;
}

function interactiveFinalCleanupTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.KODAX_INTERNAL_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS ?? '',
    10,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS;
}

async function cleanupInteractiveProcessResources(input: {
  readonly closeA2A: () => void;
  readonly closeRuntime: () => Promise<void>;
  readonly closeHotReload: () => void;
  readonly disposeExtensions: () => Promise<void>;
}): Promise<void> {
  const errors: Error[] = [];
  // FEATURE_289: preserve the independent durability window before closing
  // any Runtime/provider resource the active reviewer may still need.
  await awaitLatestCodingMemoryReviewDrain(MEMORY_REVIEW_DRAIN_TIMEOUT_MS);
  const totalTimeoutMs = interactiveFinalCleanupTimeoutMs();
  const deadline = Date.now() + totalTimeoutMs;
  const phaseTimeoutMs = Math.max(1, Math.min(1_000, Math.floor(totalTimeoutMs / 5)));
  const attempt = async (
    label: string,
    operation: () => void | Promise<void>,
    maximumMs = phaseTimeoutMs,
    reserveMs = 0,
  ): Promise<void> => {
    const availableMs = Math.max(0, deadline - Date.now() - reserveMs);
    const timeoutMs = Math.max(1, Math.min(availableMs, maximumMs));
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operationPromise = Promise.resolve().then(operation);
      await Promise.race([
        operationPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`${label} cleanup timed out after ${timeoutMs}ms.`));
          }, timeoutMs);
        }),
      ]);
    } catch (error: unknown) {
      const normalized = normalizeCliError(error);
      if (timedOut) {
        process.emitWarning(normalized.message, { code: 'KODAX_INTERACTIVE_CLEANUP' });
      } else {
        errors.push(normalized);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  // Preserve one bounded slot for the final managed-child sweep even when an
  // earlier Runtime/MCP/LSP phase hangs during shutdown.
  const managedChildReserveMs = phaseTimeoutMs;
  await attempt('A2A', input.closeA2A, phaseTimeoutMs, managedChildReserveMs);
  await attempt('Runtime', input.closeRuntime, phaseTimeoutMs, managedChildReserveMs);
  await attempt('integration hot-reload', input.closeHotReload, phaseTimeoutMs, managedChildReserveMs);
  await attempt('extension Runtime', input.disposeExtensions, phaseTimeoutMs, managedChildReserveMs);
  await attempt('LSP', shutdownDefaultLspService, phaseTimeoutMs, managedChildReserveMs);
  await attempt('managed child process', async () => {
    await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });
  });
  await attempt('tracing', shutdownTracing);

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Interactive process cleanup failed.');
  }
}

async function cleanupDaemonServeProcessResources(input: {
  readonly closeA2A: () => void;
  readonly closeHotReload: () => void;
  readonly disposeExtensions: () => Promise<void>;
}): Promise<void> {
  const errors: Error[] = [];
  const totalTimeoutMs = daemonFinalCleanupTimeoutMs();
  const deadline = Date.now() + totalTimeoutMs;
  const phaseTimeoutMs = Math.max(1, Math.min(2_000, Math.floor(totalTimeoutMs / 4)));
  const attempt = async (
    label: string,
    operation: () => void | Promise<void>,
    maximumMs = phaseTimeoutMs,
  ): Promise<void> => {
    const remainingMs = Math.max(0, deadline - Date.now());
    const timeoutMs = Math.min(remainingMs, maximumMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operationPromise = Promise.resolve().then(operation);
      await Promise.race([
        operationPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${label} cleanup timed out after ${timeoutMs}ms.`));
          }, timeoutMs);
        }),
      ]);
    } catch (error: unknown) {
      const normalized = normalizeCliError(error);
      errors.push(new Error(
        `Daemon ${label} cleanup failed. ${normalized.message}`,
        { cause: normalized },
      ));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  await attempt('A2A', input.closeA2A);
  await attempt('integration hot-reload', input.closeHotReload);
  await attempt('extension Runtime', input.disposeExtensions);
  await attempt(
    'memory review drain',
    () => awaitLatestCodingMemoryReviewDrain(MEMORY_REVIEW_DRAIN_TIMEOUT_MS),
    // The drain installs its own 15-second timer after this outer guard timer.
    // Leave headroom so the bounded drain wins the race at its documented limit.
    MEMORY_REVIEW_CLEANUP_GUARD_TIMEOUT_MS,
  );
  await attempt('LSP', shutdownDefaultLspService);
  await attempt('managed child process', async () => {
    await cleanupRegisteredManagedChildren({
      includeCurrentOwner: true,
      requireCurrentOwnerCleanup: true,
      currentOwnerJobContained: isCurrentProcessWindowsJobContained(),
    });
  }, Math.max(0, deadline - Date.now()));
  await attempt('tracing', shutdownTracing);
  if (process.env.KODAX_INTERNAL_DAEMON_TEST_FINAL_CLEANUP_ERROR === '1') {
    await attempt('injected final', () => {
      throw new Error('Injected daemon final cleanup failure.');
    });
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Runtime daemon process cleanup failed.');
  }
}

async function createDaemonOwnedExtensionRuntime(configHome: string): Promise<{
  readonly runtime: ReturnType<typeof createExtensionRuntime>;
  readonly hotReload: IntegrationHotReloadHandle;
}> {
  const config = prepareRuntimeConfig();
  let configuredPaths: readonly string[] = [];
  let configuredMcpServers: Parameters<
    typeof registerConfiguredMcpCapabilityProvider
  >[1] = {};
  try {
    configuredPaths = readExtensionsIntegration(configHome).document.paths;
  } catch {
    // Invalid optional integration config is represented by the controller's
    // cold-start diagnostic and must not make the daemon unavailable.
  }
  try {
    configuredMcpServers = readMcpIntegration(configHome).document.servers;
  } catch {
    // See the Extension-domain note above.
  }
  const configured = Array.isArray(configuredPaths)
    ? configuredPaths
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
        .map((value) =>
          path.isAbsolute(value) ? value : path.resolve(configHome, value),
        )
    : [];
  const discovered = await discoverDefaultExtensions();
  const active = await excludeExtensionPathsByEntrypoint(
    await dedupeExtensionPathsByEntrypoint(discovered),
    await dedupeExtensionPathsByEntrypoint(configured),
  );
  const configuredOnly = await dedupeExtensionPathsByEntrypoint(configured);
  const runtime = createExtensionRuntime({
    config: {
      ...config,
      extensions: configured,
      mcpServers: configuredMcpServers,
    },
  });
  await registerConfiguredMcpCapabilityProvider(runtime, configuredMcpServers, {
    reverse: buildMcpReverseCapabilities({
      cwd: process.cwd(),
      enableElicitation: false,
    }),
  });
  const loader = runtime as typeof runtime & {
    loadExtensions(
      paths: string[],
      options?: {
        continueOnError?: boolean;
        loadSource?: 'discovery' | 'config';
      },
    ): Promise<void>;
  };
  await loader.loadExtensions(active, {
    continueOnError: true,
    loadSource: 'discovery',
  });
  await loader.loadExtensions(configuredOnly, {
    continueOnError: true,
    loadSource: 'config',
  });
  runtime.activate();
  const hotReload = await startIntegrationHotReload({
    runtime,
    configHome,
    mcpOptions: {
      reverse: buildMcpReverseCapabilities({
        cwd: process.cwd(),
        enableElicitation: false,
      }),
    },
    onEvent: (message) => console.error(chalk.dim(`[integrations] ${message}`)),
  });
  return { runtime, hotReload };
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
      result.error ?? `KodaX runtime daemon stop ${result.reason.replace('_', ' ')}.`,
    );
  }
  if (result.reason === 'replacement_running') {
    throw new Error(
      `The requested daemon exited, but a replacement owns profile "${paths.profile}".`,
    );
  }
  if (result.reason === 'unverified_owner') {
    throw new Error(
      `Refusing to force stop daemon profile "${paths.profile}" because ownership could not be verified.`,
    );
  }
  if (result.reason !== undefined) {
    console.log(
      chalk.yellow(
        `No healthy KodaX runtime daemon for profile "${paths.profile}" (${result.reason}).`,
      ),
    );
    return;
  }
  if (!result.stopped) {
    throw new Error(
      `KodaX runtime daemon did not stop within ${input.timeoutMs}ms.`,
    );
  }
  console.log(
    chalk.green(`KodaX runtime daemon stopped for profile "${paths.profile}".`),
  );
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
      reason: health,
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
  await delayDaemonStopAfterObservationForTest();
  const endpoint = runtimeDaemonEndpointFromState(stoppedState);
  const transport = await createRuntimeDaemonSocketClientTransport(endpoint, {
    connectTimeoutMs: input.timeoutMs,
  });
  let transportCloseError: Error | undefined;
  let stopAcceptedAt: number | undefined;
  try {
    const token = readRuntimeDaemonToken(paths);
    const initialized = await transport.request('initialize', {
      profile: paths.profile,
      ...(token !== undefined ? { token } : {}),
      clientInfo: { name: 'kodax-cli', title: 'KodaX CLI' },
      capabilities: { configAdmin: true },
    });
    if (!daemonStopTargetMatches(initialized, stoppedState)) {
      throw new Error(
        'Runtime daemon owner changed before the stop request; refusing to stop the replacement.',
      );
    }
    await transport.request('daemon.stop');
    stopAcceptedAt = Date.now();
  } finally {
    const closeDeadline = (stopAcceptedAt ?? Date.now()) + input.timeoutMs;
    transportCloseError = await closeDaemonStopTransportWithin(
      () => transport.close?.(),
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
    && isRuntimeDaemonPidAlive(currentLockOwner.pid)
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
    health: afterHealth,
    state: after.state ?? null,
  };
  return result;
}

async function delayDaemonStopAfterObservationForTest(): Promise<void> {
  const markerFile = process.env.KODAX_INTERNAL_DAEMON_TEST_STOP_OBSERVED_FILE;
  if (markerFile !== undefined) {
    fsSync.writeFileSync(markerFile, `${process.pid}\n`, 'utf8');
  }
  const delayMs = parseInternalDaemonTestDuration(
    process.env.KODAX_INTERNAL_DAEMON_TEST_STOP_AFTER_OBSERVATION_DELAY_MS,
  );
  if (delayMs > 0) await delay(delayMs);
}

function daemonStopTargetMatches(
  initialized: unknown,
  expected: RuntimeDaemonState,
): boolean {
  const record = isRecord(initialized) ? initialized : {};
  const identity = isRecord(record.identity) ? record.identity : record;
  return identity.runtimeId === expected.runtimeId
    && identity.profile === expected.profile;
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
    if (lockOwner && isRuntimeDaemonPidAlive(lockOwner.pid)) {
      return {
        stopped: false,
        forced: true,
        reason: 'unverified_owner',
        health,
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
        health,
        state,
      };
    }
    return {
      stopped: true,
      forced: true,
      health: 'missing',
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
        health,
        state,
      };
    }
    return {
      stopped: true,
      forced: true,
      health: 'missing',
      state: null,
    };
  }
  return {
    stopped: false,
    forced: true,
    reason: 'unverified_owner',
    health,
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
      `KodaX runtime daemon restart failed for profile "${paths.profile}".`,
    );
  }
  console.log(
    chalk.green(
      `KodaX runtime daemon restarted for profile "${paths.profile}".`,
    ),
  );
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
  if (stop.health === 'healthy') {
    return {
      restarted: false,
      stop,
      start: {
        started: false,
        reason: 'already_running',
        state: stop.state,
      },
    };
  }
  if (!stop.stopped) {
    return {
      restarted: false,
      stop,
      start: {
        started: false,
        health: stop.health,
        state: stop.state,
      },
    };
  }
  if (stop.reason === 'unhealthy' || stop.reason === 'mismatch') {
    return {
      restarted: false,
      stop,
      start: {
        started: false,
        health: stop.reason,
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
}): Promise<void> {
  const result = readDaemonLogs(input);
  if (input.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(chalk.cyan(`KodaX runtime daemon log (${result.profile})`));
  console.log(chalk.dim(result.logFile));
  if (!result.exists) {
    console.log(chalk.yellow('No daemon log file exists yet.'));
    return;
  }
  for (const line of result.lines) {
    console.log(line);
  }
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
    lines: tailTextFile(paths.logFile, input.lines),
  };
}

function tailTextFile(file: string, lineCount: number): readonly string[] {
  if (lineCount <= 0) return [];
  const content = fsSync.readFileSync(file, 'utf8');
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-lineCount);
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

function waitForShutdownSignal(
  onShutdown: () => Promise<void>,
  hostClosed?: Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let closing = false;
    const cleanup = (): void => {
      process.off('SIGINT', close);
      process.off('SIGTERM', close);
    };
    const finish = (): void => {
      cleanup();
      resolve();
    };
    const fail = (error: unknown): void => {
      cleanup();
      reject(error);
    };
    const close = (): void => {
      if (closing) return;
      closing = true;
      void onShutdown().then(finish, fail);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    void hostClosed?.then(finish, fail);
  });
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

function watchRuntimeDaemonTestParent(parentPidValue: string | undefined):
  | {
      readonly exited: Promise<void>;
      close(): void;
    }
  | undefined {
  const parentPid = Number(parentPidValue);
  if (
    !Number.isInteger(parentPid) ||
    parentPid <= 0 ||
    parentPid === process.pid
  )
    return undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const poll = (): void => {
    if (isRuntimeDaemonPidAlive(parentPid)) return;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    resolveExit?.();
    resolveExit = undefined;
  };
  poll();
  if (resolveExit !== undefined) {
    timer = setInterval(poll, 1_000);
    timer.unref?.();
  }
  return {
    exited,
    close() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      resolveExit = undefined;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCliError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatDaemonHealth(
  health: ReturnType<typeof classifyRuntimeDaemonHealth>,
): string {
  if (health === 'healthy') return chalk.green(health);
  if (health === 'missing') return chalk.dim(health);
  if (health === 'stale') return chalk.yellow(health);
  return chalk.red(health);
}
// ============== CLI Help Topics ==============

const CLI_HELP_TOPICS: Record<string, () => void> = {
  acp: () => {
    console.log(chalk.cyan('\nACP Server\n'));
    console.log(chalk.bold('Overview:'));
    console.log(
      chalk.dim(
        '  Run KodaX as a stdio ACP server so editors and IDEs can connect directly.',
      ),
    );
    console.log(
      chalk.dim(
        '  Session creation, prompt streaming, cancellation, and permission prompts reuse KodaX runtime semantics.\n',
      ),
    );
    console.log(chalk.bold('Command:'));
    console.log(chalk.dim('  kodax acp serve [options]\n'));
    console.log(chalk.bold('Options:'));
    console.log(
      chalk.dim('  --cwd <dir>                  ') +
        'Working directory exposed to ACP sessions',
    );
    console.log(
      chalk.dim('  -m, --provider <name>        ') + 'Provider to use',
    );
    console.log(
      chalk.dim('  --model <name>               ') + 'Model override',
    );
    console.log(
      chalk.dim('  --effort <level>             ') +
        'Reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value',
    );
    console.log(
      chalk.dim('  --reasoning <mode>           ') +
        'Compatibility mode: off, auto, quick, balanced, deep',
    );
    console.log(
      chalk.dim('  --repo-intelligence <mode>   ') +
        'Repo intelligence mode: auto, full, light, off',
    );
    console.log(
      chalk.dim('  --repo-intelligence-trace    ') +
        'Emit repo intelligence trace metadata/logging',
    );
    console.log(
      chalk.dim('  -t, --thinking               ') +
        'Compatibility alias for --reasoning auto',
    );
    console.log(
      chalk.dim('  --permission-mode <mode>     ') +
        'Initial mode: plan, accept-edits, auto-in-project',
    );
    console.log(
      chalk.dim('  KODAX_ACP_LOG=<level>        ') +
        'stderr log level: off, error, info, debug\n',
    );
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax acp serve'));
    console.log(
      chalk.dim(
        '  kodax acp serve --cwd C:\\repo --permission-mode accept-edits',
      ),
    );
    console.log(
      chalk.dim(
        '  kodax acp serve -m openai --model gpt-5.4 --reasoning balanced\n',
      ),
    );
  },
  skill: () => {
    console.log(chalk.cyan('\nSkill Utilities\n'));
    console.log(chalk.bold('Overview:'));
    console.log(
      chalk.dim(
        '  Use built-in skill packaging commands without starting an agent session.',
      ),
    );
    console.log(
      chalk.dim(
        '  These commands are thin wrappers around the builtin skill-creator tools.\n',
      ),
    );
    console.log(chalk.bold('Commands:'));
    console.log(
      chalk.dim('  kodax skill init <name> [options]   ') +
        'Create a new skill scaffold',
    );
    console.log(
      chalk.dim('  kodax skill validate <dir>          ') +
        'Validate a skill directory',
    );
    console.log(
      chalk.dim('  kodax skill eval --skill-path ...   ') +
        'Run end-to-end eval workspace generation',
    );
    console.log(
      chalk.dim('  kodax skill grade <workspace>       ') +
        'Grade eval runs into grading.json files',
    );
    console.log(
      chalk.dim('  kodax skill analyze <workspace>     ') +
        'Analyze benchmark variance and failures',
    );
    console.log(
      chalk.dim('  kodax skill compare <workspace>     ') +
        'Blind-compare two configs across runs',
    );
    console.log(
      chalk.dim('  kodax skill package <dir> [options] ') +
        'Package a skill as .skill',
    );
    console.log(
      chalk.dim('  kodax skill install <input> [opts]  ') +
        'Install a skill from dir or .skill',
    );
    console.log(chalk.bold('Examples:'));
    console.log(
      chalk.dim('  kodax skill init release-notes --dest ./.kodax/skills'),
    );
    console.log(chalk.dim('  kodax skill validate ./.kodax/skills/my-skill'));
    console.log(
      chalk.dim(
        '  kodax skill eval --skill-path ./.kodax/skills/my-skill --evals ./.kodax/skills/my-skill/evals/evals.json --workspace ./iteration-1',
      ),
    );
    console.log(chalk.dim('  kodax skill grade ./iteration-1'));
    console.log(chalk.dim('  kodax skill analyze ./iteration-1'));
    console.log(
      chalk.dim(
        '  kodax skill compare ./iteration-1 --config-a with_skill --config-b without_skill',
      ),
    );
    console.log(
      chalk.dim(
        '  kodax skill package ./.kodax/skills/my-skill --output ./my-skill.skill',
      ),
    );
    console.log(
      chalk.dim(
        '  kodax skill install ./my-skill.skill --dest ~/.kodax/skills --force\n',
      ),
    );
  },
  sessions: () => {
    console.log(chalk.cyan('\nSession Management\n'));
    console.log(chalk.bold('Overview:'));
    console.log(
      chalk.dim(
        '  KodaX automatically saves conversation sessions, allowing you to',
      ),
    );
    console.log(
      chalk.dim(
        '  resume work later or switch between different conversations.\n',
      ),
    );
    console.log(chalk.bold('Options:'));
    console.log(
      chalk.dim('  -c, --continue       ') +
        'Continue most recent non-empty conversation',
    );
    console.log(
      chalk.dim('  -r, --resume [value] ') +
        'Resume by ID or exact title (no value = searchable picker)',
    );
    console.log(
      chalk.dim('  -n, --new            ') +
        'Legacy no-op; current CLI already starts a fresh session by default',
    );
    console.log(
      chalk.dim('  -s, --session <op>   ') +
        'Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID',
    );
    console.log(
      chalk.dim('  --no-session         ') +
        'Disable session persistence (print mode only)\n',
    );
    console.log(chalk.bold('Examples:'));
    console.log(
      chalk.dim('  kodax                      ') +
        '# Start new session (interactive)',
    );
    console.log(
      chalk.dim('  kodax -c                   ') +
        '# Continue recent conversation',
    );
    console.log(
      chalk.dim('  kodax -r                   ') +
        '# Search and select a saved session',
    );
    console.log(
      chalk.dim('  kodax -r 20260219_143052   ') + '# Resume specific session',
    );
    console.log(
      chalk.dim('  kodax -r "Review runtime"  ') +
        '# Resume a unique exact title; duplicates open the picker',
    );
    console.log(
      chalk.dim('  kodax -s list              ') + '# List all sessions',
    );
    console.log(
      chalk.dim('  kodax -s delete 20260219   ') + '# Delete a session',
    );
    console.log(
      chalk.dim('  kodax -p "task" --no-session') + ' # Run without saving\n',
    );
  },
  project: () => {
    console.log(chalk.cyan('\nProject Mode\n'));
    console.log(chalk.bold('Overview:'));
    console.log(
      chalk.dim(
        '  Project mode spans two surfaces: non-REPL bootstrap commands and REPL /project commands.',
      ),
    );
    console.log(
      chalk.dim(
        '  Current workflow includes planning, quality review, brainstorm sessions, harness-verified execution, and runtime artifacts under .agent/project/.\n',
      ),
    );
    console.log(chalk.bold('REPL /project Commands:'));
    console.log(
      chalk.dim('  /project status [prompt] [--features|--progress]') +
        '  Status + guided analysis',
    );
    console.log(
      chalk.dim('  /project plan [#index|topic]                 ') +
        '  Generate project or feature planning truth',
    );
    console.log(
      chalk.dim('  /project quality                             ') +
        '  Deterministic workflow health + release review',
    );
    console.log(
      chalk.dim('  /project brainstorm                          ') +
        '  UI-driven discovery flow',
    );
    console.log(
      chalk.dim('  /project next [prompt|#index] [--no-confirm] ') +
        '  Harness-verified feature execution',
    );
    console.log(
      chalk.dim('  /project auto [prompt] [--max=N|--confirm]   ') +
        '  REPL-side auto-continue with pause support',
    );
    console.log(
      chalk.dim('  /project pause                               ') +
        '  Stop /project auto',
    );
    console.log(
      chalk.dim('  /project verify [#index|--last]              ') +
        '  Rerun deterministic harness verification',
    );
    console.log(
      chalk.dim('  /project edit <prompt>                       ') +
        '  Edit current-stage truth',
    );
    console.log(
      chalk.dim('  /project analyze [prompt]                    ') +
        '  AI project analysis',
    );
    console.log(
      chalk.dim('  /project reset [--all]                       ') +
        '  Clear progress or remove project truth files\n',
    );
    console.log(chalk.bold('Current Semantics:'));
    console.log(
      chalk.dim(
        '  - /project next and /project auto are verifier-gated, not self-declared completion',
      ),
    );
    console.log(
      chalk.dim(
        '  - /project plan writes the latest plan to .agent/project/session_plan.md',
      ),
    );
    console.log(
      chalk.dim(
        '  - /project quality combines deterministic checks with optional model-generated guidance',
      ),
    );
    console.log(
      chalk.dim(
        '  - /project brainstorm aligns requirements into .agent/project/alignment.md\n',
      ),
    );
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -h project'));
    console.log(
      chalk.dim(
        '  kodax  # then: /project brainstorm -> /project plan -> /project next',
      ),
    );
    console.log(
      chalk.dim(
        '  kodax  # then: /project quality | /project verify --last | /project auto --max=3\n',
      ),
    );
  },
  auto: () => {
    console.log(chalk.cyan('\nAuto Mode\n'));
    console.log(chalk.bold('Auto Mode (-y, --auto):'));
    console.log(chalk.dim('  Backward-compatibility alias kept for scripts.'));
    console.log(
      chalk.dim(
        '  Non-REPL CLI already runs in auto mode by default, so this flag currently has no additional effect.\n',
      ),
    );
    console.log(chalk.bold('Options:'));
    console.log(
      chalk.dim('  -y, --auto             ') +
        'Backward-compat alias (no-op in non-REPL CLI)\n',
    );
    console.log(chalk.bold('Examples:'));
    console.log(
      chalk.dim('  kodax -y "refactor code"          ') +
        '# Legacy alias; same as plain non-REPL run\n',
    );
  },
  provider: () => {
    const providerNames = getAvailableProviderNames();
    console.log(chalk.cyan('\nLLM Providers\n'));
    console.log(chalk.bold('Overview:'));
    console.log(
      chalk.dim(
        '  KodaX supports multiple LLM providers. Configure via -m option',
      ),
    );
    console.log(
      chalk.dim(
        '  or set default in ~/.kodax/config.json. Use --model to override the default model.\n',
      ),
    );
    console.log(chalk.bold('Available Providers:'));
    providerNames.forEach((name) => {
      const detail =
        name === 'gemini-cli' || name === 'codex-cli'
          ? 'CLI bridge provider (latest-user-message only, MCP unavailable)'
          : 'Native provider';
      console.log(chalk.dim(`  ${name.padEnd(15)} `) + detail);
    });
    console.log();
    console.log(chalk.bold('Key Options:'));
    console.log(chalk.dim('  -m, --provider <name> ') + 'Provider to use');
    console.log(
      chalk.dim('  --model <name>        ') +
        'Model override for the selected provider\n',
    );
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -m anthropic "task"     ') + '# Use Claude');
    console.log(
      chalk.dim('  kodax -m openai --model gpt-5.4 "task"') +
        '# Override model',
    );
    console.log(
      chalk.dim('  /model                        ') +
        '# Switch in REPL (saves to config)\n',
    );
  },
  thinking: () => {
    console.log(chalk.cyan('\nReasoning Effort\n'));
    console.log(chalk.bold('Overview:'));
    console.log(
      chalk.dim(
        '  Reasoning controls how much deliberate analysis KodaX should apply.',
      ),
    );
    console.log(
      chalk.dim(
        '  Use --effort for new configs; --reasoning remains as a compatibility alias.\n',
      ),
    );
    console.log(chalk.bold('Options:'));
    console.log(
      chalk.dim('  --effort <level>     ') +
        'Set reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value',
    );
    console.log(
      chalk.dim('  --reasoning <mode>   ') +
        'Compatibility mode: off, auto, quick, balanced, deep',
    );
    console.log(
      chalk.dim('  --agent-mode <mode>  ') + 'Set agent mode: ama, sa',
    );
    console.log(
      chalk.dim('  -t, --thinking       ') +
        'Compatibility alias for --reasoning auto\n',
    );
    console.log(chalk.bold('Examples:'));
    console.log(
      chalk.dim('  kodax --effort high "design the architecture"     ') +
        '# High effort',
    );
    console.log(
      chalk.dim('  kodax --reasoning deep "design the architecture"   ') +
        '# Legacy alias for high effort',
    );
    console.log(
      chalk.dim('  kodax --reasoning balanced -p "analyze this bug"   ') +
        '# Medium-depth reasoning',
    );
    console.log(
      chalk.dim('  kodax -t "review this PR"                           ') +
        '# Alias for auto',
    );
    console.log(
      chalk.dim('  /reasoning balanced                                 ') +
        '# Set in REPL\n',
    );
  },
  print: () => {
    console.log(chalk.cyan('\nPrint Mode\n'));
    console.log(chalk.bold('Overview:'));
    console.log(
      chalk.dim(
        '  Run a single task and exit. Useful for scripting and CI/CD.\n',
      ),
    );
    console.log(
      chalk.dim(
        '  `--mode json` is a scripting surface, not the ACP server protocol.\n',
      ),
    );
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  -p, --print <text>  ') + 'Run task and exit');
    console.log(
      chalk.dim('  --mode json         ') +
        'Emit newline-delimited JSON events to stdout for scripts/CI',
    );
    console.log(
      chalk.dim('  --model <name>      ') +
        'Override the selected provider model',
    );
    console.log(
      chalk.dim('  --no-session        ') + 'Disable session saving\n',
    );
    console.log(chalk.bold('Examples:'));
    console.log(
      chalk.dim('  kodax -p "fix the bug in auth.ts"   ') + '# Quick fix',
    );
    console.log(
      chalk.dim('  kodax -p "generate tests" --reasoning balanced') +
        ' # With reasoning',
    );
    console.log(
      chalk.dim('  kodax -p "task" -m openai --model gpt-5.4') +
        ' # Provider + model override',
    );
    console.log(
      chalk.dim('  kodax -p "task" --no-session        ') + '# Stateless run',
    );
    console.log(
      chalk.dim('  kodax --mode json "inspect auth flow"') +
        ' # Structured JSONL output',
    );
    console.log(
      chalk.dim('  kodax -p "task" -m anthropic --reasoning deep') +
        ' # Explicit provider selection\n',
    );
  },
};

const CLI_SUBCOMMAND_NAMES = new Set([
  'acp',
  'skill',
  'tools',
  'sessions',
  'constructed',
  'doctor',
  'daemon',
  'completion',
  'config',
  'integrations',
  'mcp',
  'extensions',
  'a2a',
  'sandbox',
  'setup',
  'memory',
]);

function collectRepeatedOption(
  value: string,
  previous: string[] = [],
): string[] {
  return [...previous, value];
}

export function configureKodaXRootCommand(program: Command): Command {
  return (
    program
      // Disable commander default help so the custom topic help can take over.
      .helpOption(false)
      .argument('[prompt...]', 'Prompt text for a single CLI run')
      .option('-h, --help [topic]', 'Show help, or detailed help for a topic')
      .option('-p, --print <text>', 'Print mode: run single task and exit')
      .option('--mode <mode>', 'Output mode: json', parseOutputModeOption)
      .option(
        '--runtime-mode <mode>',
        'Interactive runtime mode: embedded, daemon',
        parseRuntimeModeOption,
      )
      .option(
        '-c, --continue',
        'Continue most recent non-empty conversation in current directory',
      )
      .option(
        '-n, --new',
        'Legacy no-op; current CLI already starts a fresh session by default',
      )
      .option(
        '-r, --resume [id-or-title]',
        'Resume session by ID or exact title (no value = open searchable session picker)',
      )
      .option('-m, --provider <name>', 'LLM provider')
      .option('--model <name>', 'Model override')
      .option('-t, --thinking', 'Compatibility alias for --reasoning auto')
      .option(
        '--effort <level>',
        'Reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value',
        parseEffortOption,
      )
      .option(
        '--reasoning <mode>',
        'Reasoning mode: off, auto, quick, balanced, deep',
        parseReasoningModeOption,
      )
      .option(
        '--agent-mode <mode>',
        'Agent mode: ama, sa',
        parseAgentModeOption,
      )
      .option(
        '--repo-intelligence <mode>',
        'Repo intelligence mode: auto, full, light, off',
        parseRepoIntelligenceModeOption,
      )
      .option(
        '--repo-intelligence-trace',
        'Enable repo intelligence trace metadata/logging',
      )
      .option('-y, --auto', 'Backward-compat alias; no effect in non-REPL CLI')
      .option(
        '-s, --session <op>',
        'Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID',
      )
      .option(
        '--apply-session-cleanup',
        'Archive strictly matched empty ACP test sessions (with -s cleanup-acp)',
      )
      .option(
        '--extension <path>',
        'Load local extension module (.js/.mjs/.cjs/.ts/.mts/.cts)',
        collectRepeatedOption,
        [],
      )
      .option('--no-session', 'Disable session persistence (print mode only)')
      .option(
        '--max-iter <n>',
        'Max iterations (default: 200 from coding package)',
      )
      .allowUnknownOption(false)
      // Keep the root command executable even when subcommands like `skill` exist.
      .action(() => {})
  );
}

function showCliHelpTopic(topic: string): boolean {
  const helpFn = CLI_HELP_TOPICS[topic.toLowerCase()];
  if (helpFn) {
    helpFn();
    return true;
  }
  return false;
}

function showCliHelpTopics(): void {
  console.log(chalk.cyan('\nDetailed Help Topics:\n'));
  console.log(
    chalk.dim('  kodax -h acp        ') +
      'ACP server mode for editors and IDEs',
  );
  console.log(
    chalk.dim('  kodax -h sessions   ') +
      'Session management (-c, -r, -s options)',
  );
  console.log(
    chalk.dim('  kodax -h skill      ') +
      'Skill packaging and installation helpers',
  );
  console.log(
    chalk.dim('  kodax -h project    ') +
      'Project mode workflow across CLI and /project',
  );
  console.log(
    chalk.dim('  kodax -h auto       ') + 'Auto mode backward-compat alias',
  );
  console.log(chalk.dim('  kodax -h provider   ') + 'LLM provider options');
  console.log(
    chalk.dim('  kodax -h thinking   ') + 'Reasoning modes and depth control',
  );
  console.log(
    chalk.dim('  kodax -h print      ') + 'Print mode for scripting\n',
  );
}

type CliRunResultEvent = {
  type: 'run.result';
  success: boolean;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  sessionId: string;
  interrupted?: boolean;
  limitReached?: boolean;
};

function writeJsonStdout(value: CliRunResultEvent): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitJsonRunResultIfNeeded(
  outputMode: CliOutputMode,
  result: Awaited<ReturnType<typeof runKodaX>>,
): void {
  if (outputMode !== 'json') {
    return;
  }

  writeJsonStdout({
    type: 'run.result',
    success: result.success,
    signal: result.signal,
    signalReason: result.signalReason,
    sessionId: result.sessionId,
    interrupted: result.interrupted,
    limitReached: result.limitReached,
  });
}

function printAcpSubcommandHelp(name: string): boolean {
  if (name === 'serve') {
    console.log('Usage: kodax acp serve [options]');
    console.log();
    console.log('Run KodaX as a stdio ACP server for editors and IDEs.');
    console.log();
    console.log('Options:');
    console.log(
      '  --cwd <dir>                  Working directory exposed to ACP sessions',
    );
    console.log('  -m, --provider <name>        Provider to use');
    console.log('  --model <name>               Model override');
    console.log(
      '  --effort <level>             Reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value',
    );
    console.log(
      '  -t, --thinking               Compatibility alias for --reasoning auto',
    );
    console.log(
      '  --reasoning <mode>           Reasoning mode: off, auto, quick, balanced, deep',
    );
    console.log(
      '  --repo-intelligence <mode>   Repo intelligence mode: auto, full, light, off',
    );
    console.log(
      '  --repo-intelligence-trace    Emit repo intelligence trace metadata/logging',
    );
    console.log('  --permission-mode <mode>     Initial permission mode');
    console.log(
      '  KODAX_ACP_LOG=<level>        stderr log level: off, error, info, debug',
    );
    return true;
  }

  return false;
}

function printSkillSubcommandHelp(name: string): boolean {
  if (name === 'init') {
    console.log('Usage: kodax skill init [options] <name>');
    console.log();
    console.log('Initialize a new skill scaffold.');
    console.log();
    console.log('Options:');
    console.log('  -d, --dest <dir>         Base skills directory');
    console.log('  --description <text>     Initial skill description');
    console.log(
      '  -f, --force              Allow writing into an existing target directory',
    );
    console.log('  --no-evals               Skip creating evals/evals.json');
    return true;
  }

  if (name === 'validate') {
    console.log('Usage: kodax skill validate <skillDir>');
    console.log();
    console.log('Validate a skill directory using builtin skill-creator.');
    return true;
  }

  if (name === 'eval') {
    console.log('Usage: kodax skill eval [options]');
    console.log();
    console.log(
      'Run end-to-end skill evals and write a benchmark/review workspace.',
    );
    console.log();
    console.log('Required Options:');
    console.log('  --skill-path <dir>       Skill directory to evaluate');
    console.log('  --evals <file>           Evals JSON file');
    console.log('  --workspace <dir>        Workspace output directory');
    console.log();
    console.log('Options:');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --runs <n>               Runs per config');
    console.log('  --max-iter <n>           Max iterations per run');
    console.log('  --reasoning <mode>       Reasoning mode');
    console.log('  --cwd <dir>              Working directory for the runs');
    console.log(
      '  --configs <list>         Comma-separated configs, e.g. with_skill,without_skill',
    );
    console.log('  -o, --output <file>      Optional JSON summary output');
    return true;
  }

  if (name === 'grade') {
    console.log('Usage: kodax skill grade [options] <workspace>');
    console.log();
    console.log('Grade eval runs into grading.json files.');
    console.log();
    console.log('Options:');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --reasoning <mode>       Reasoning mode');
    console.log('  --max-iter <n>           Max iterations per grading run');
    console.log(
      '  --configs <list>         Comma-separated configs, e.g. with_skill,without_skill',
    );
    console.log(
      '  --overwrite              Re-grade runs that already have grading.json',
    );
    return true;
  }

  if (name === 'analyze') {
    console.log('Usage: kodax skill analyze [options] <workspace>');
    console.log();
    console.log(
      'Analyze benchmark variance and write analysis.json + analysis.md.',
    );
    console.log();
    console.log('Options:');
    console.log('  --benchmark <file>       Optional benchmark.json path');
    console.log('  --output <file>          JSON output path');
    console.log('  --markdown <file>        Markdown output path');
    console.log(
      '  --skill-name <name>      Skill name if benchmark.json must be regenerated',
    );
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --reasoning <mode>       Reasoning mode');
    return true;
  }

  if (name === 'compare') {
    console.log('Usage: kodax skill compare [options] <workspace>');
    console.log();
    console.log('Blind-compare two configs across eval run pairs.');
    console.log();
    console.log('Options:');
    console.log(
      '  --config-a <name>        Primary config (default: with_skill)',
    );
    console.log(
      '  --config-b <name>        Baseline config (default: without_skill)',
    );
    console.log('  --output <file>          JSON output path');
    console.log('  --markdown <file>        Markdown output path');
    console.log('  --max-pairs <n>          Limit pairs per eval');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --reasoning <mode>       Reasoning mode');
    return true;
  }

  if (name === 'package') {
    console.log('Usage: kodax skill package [options] <skillDir>');
    console.log();
    console.log('Package a skill directory as a .skill archive.');
    console.log();
    console.log('Options:');
    console.log('  -o, --output <file>      Output .skill file path');
    return true;
  }

  if (name === 'install') {
    console.log('Usage: kodax skill install [options] <input>');
    console.log();
    console.log(
      'Install a skill directory or .skill archive into a skills directory.',
    );
    console.log();
    console.log('Options:');
    console.log('  -d, --dest <dir>         Destination skills directory');
    console.log(
      '  -f, --force              Overwrite an existing target skill',
    );
    return true;
  }

  return false;
}

function showBasicHelp(): void {
  const providerNames = getAvailableProviderNames().join(', ');
  console.log('KodaX - Intelligent Coding Agent\n');
  console.log('Usage: kodax [options] [prompt]');
  console.log('       kodax "your task"');
  console.log('       kodax /command_name\n');
  console.log('Options:');
  console.log(
    '  -h, --help [TOPIC]      Show help, or detailed help for a topic',
  );
  console.log('  -p, --print TEXT        Print mode: run single task and exit');
  console.log(
    '  --mode json             Emit newline-delimited JSON events to stdout for scripts/CI',
  );
  console.log(
    '  -c, --continue          Continue most recent non-empty conversation',
  );
  console.log(
    '  -r, --resume [value]    Resume by ID or exact title (no value = searchable picker)',
  );
  console.log(
    '  -n, --new               Legacy no-op; current CLI already starts a fresh session by default',
  );
  console.log(`  -m, --provider NAME     LLM provider (${providerNames})`);
  console.log(
    '  --model NAME            Model override for the selected provider',
  );
  console.log(
    '  -t, --thinking          Compatibility alias for --reasoning auto',
  );
  console.log(
    '  --effort LEVEL          Reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value',
  );
  console.log(
    '  --reasoning MODE        Compatibility mode: off, auto, quick, balanced, deep',
  );
  console.log('  --agent-mode MODE       Agent mode: ama, sa');
  console.log(
    '  -y, --auto              Backward-compat alias; no effect in non-REPL CLI',
  );
  console.log(
    '  -s, --session OP        Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID',
  );
  console.log(
    '  --no-session            Disable session persistence (print mode only)',
  );
  console.log(
    '  --max-iter N            Max iterations per session (default: 200)\n',
  );
  process.stdout.write(
    '  kodax setup             Configure provider/model metadata (never stores an API key)\n\n',
  );
  console.log('Help Topics (use -h <topic>):');
  console.log(
    '  acp, skill, sessions, project, auto, provider, thinking, print\n',
  );
  console.log('Interactive Commands (in REPL mode):');
  console.log('  /help, /h               Show all commands');
  console.log('  /exit, /quit            Exit interactive mode');
  console.log('  /clear                  Clear conversation history');
  console.log('  /status                 Show session status');
  console.log('  /mode [plan|accept-edits|auto]  Switch permission mode');
  console.log('  /project ...            Project workflow commands');
  console.log('  /sessions               List saved sessions\n');
  console.log('Examples:');
  console.log('  kodax                             # Enter interactive mode');
  process.stdout.write(
    '  kodax setup                       # Configure provider/model, then restart terminal\n',
  );
  console.log(
    '  kodax "create a component"        # Run single task (with session)',
  );
  console.log('  kodax acp serve                   # Start ACP stdio server');
  console.log('  kodax skill init my-skill         # Scaffold a new skill');
  console.log(
    '  kodax skill package ./my-skill    # Package a skill without starting the agent',
  );
  console.log(
    '  kodax -h project                 # Project mode workflow across CLI and REPL',
  );
  console.log(
    '  kodax -p "quick fix" --reasoning balanced  # Quick task with reasoning',
  );
  console.log(
    '  kodax -c                          # Continue recent conversation',
  );
  console.log('  kodax -c "finish this"            # Continue with new task');
  console.log(
    '  kodax -r                          # Search and select a saved session',
  );
  console.log(
    '  kodax -r "Review runtime"         # Resume by unique exact title',
  );
  console.log(
    '  kodax -p "task" --model gpt-5.4   # Override model for a one-off run',
  );
  console.log(
    '  kodax -p "task" --no-session      # Run without saving session',
  );
  console.log(
    '  kodax -h sessions                 # Detailed help on sessions\n',
  );
}

async function loadResumableSessions(
  maxSessions = 1000,
): Promise<SessionPickerItem[]> {
  const { listCliResumeSessions } = await import('@kodax-ai/repl/cli-resume');
  return listCliResumeSessions({
    projectRoot: process.cwd(),
    limit: maxSessions,
  });
}

function printProviderSetupCompletion(selection: {
  readonly provider: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly configPath: string;
}): void {
  process.stdout.write(
    `${chalk.green(`\nProvider setup saved: ${selection.provider}/${selection.model}`)}\n`,
  );
  process.stdout.write(`${chalk.dim(`Config: ${selection.configPath}`)}\n`);
  for (const line of providerSetupRestartInstructions({
    apiKeyEnv: selection.apiKeyEnv,
  })) {
    process.stdout.write(`  ${line}\n`);
  }
}

async function prepareSetupSandboxReport(): Promise<{
  readonly status: 'ready' | 'cancelled' | 'unavailable';
  readonly lines: readonly string[];
}> {
  const { prepareSandboxRuntimeForSetup } = await loadSandboxRuntimeModule();
  const outcome = await prepareSandboxRuntimeForSetup({
    allowElevation: process.stdin.isTTY === true && process.stdout.isTTY === true,
  });
  const details = [
    ...outcome.guidance,
    ...outcome.doctor.diagnostics.map((diagnostic) => `Diagnostic: ${diagnostic}`),
    ...(outcome.error ? [`Setup result: ${outcome.error}`] : []),
    ...(outcome.status === 'unavailable'
      ? ['KodaX will use the normal permission policy; sandbox containment remains off until activated.']
      : []),
  ];
  return { status: outcome.status, lines: [...new Set(details)] };
}

async function inspectSandboxReport(): Promise<{
  readonly ready: boolean;
  readonly platform: string;
  readonly version: string;
  readonly backend: string;
  readonly diagnostics: readonly string[];
  readonly guidance: readonly string[];
}> {
  const {
    doctorSandboxRuntime,
    sandboxRuntimeCapability,
    sandboxSetupGuidance,
  } = await loadSandboxRuntimeModule();
  const doctor = await doctorSandboxRuntime({ refresh: true });
  return {
    ready: doctor.ready,
    platform: doctor.platform,
    version: doctor.version,
    backend: sandboxRuntimeCapability().backend,
    diagnostics: doctor.diagnostics,
    guidance: sandboxSetupGuidance(doctor),
  };
}

async function executeProviderSetup(
  input: { readonly customOnly?: boolean } = {},
): Promise<void> {
  process.stdout.write(`\n${renderSetupGuide()}\n\n`);
  const sandbox = await prepareSetupSandboxReport();
  const sandboxLabel = sandbox.status === 'ready'
    ? chalk.green('active')
    : sandbox.status === 'cancelled'
      ? chalk.yellow('cancelled')
      : chalk.yellow('not active');
  process.stdout.write(`Sandbox: [${sandboxLabel}]\n`);
  for (const line of sandbox.lines) process.stdout.write(`  ${line}\n`);
  process.stdout.write('\n');
  const initialized = initializeSetupConfiguration({
    validateA2A: parseA2AIntegrationDocument,
  });
  for (const file of initialized.files) {
    const marker =
      file.status === 'created'
        ? chalk.green('created')
        : file.status === 'invalid'
          ? chalk.red('invalid')
          : file.status === 'missing'
            ? chalk.yellow('missing')
            : chalk.dim('existing');
    process.stdout.write(`  [${marker}] ${file.path}\n`);
    if (file.diagnostic)
      process.stdout.write(`      ${chalk.red(file.diagnostic)}\n`);
  }
  process.stdout.write('\n');
  if (initialized.files.some((file) => file.status === 'invalid')) {
    process.stderr.write(
      `${chalk.red('Setup stopped: fix the invalid active configuration above, then run `kodax setup` again.')}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const result = await runProviderSetupWizard({ customOnly: input.customOnly });
  if (result.status === 'cancelled') {
    process.stdout.write(
      `${chalk.dim(
        'Provider setup cancelled. Configuration files remain initialized; run `kodax setup` when ready.',
      )}\n`,
    );
    return;
  }
  printProviderSetupCompletion(result.selection);
}

export function configureKodaXSetupCommand(program: Command): Command {
  const setupCommand = program
    .command('setup')
    .description(
      'Initialize configuration and configure a provider without storing an API key',
    )
    .helpOption(
      '-h, --help',
      'Show the complete setup guide without changing files',
    )
    .option(
      '--custom',
      'Interactively configure a custom OpenAI/Anthropic-compatible provider',
    )
    .action((options: { readonly custom?: boolean }) =>
      executeProviderSetup({
        customOnly: options.custom === true,
      }),
    );
  setupCommand.addHelpText('after', () => `\n${renderSetupGuide()}\n`);
  return setupCommand;
}

export function showKodaXSetupHelpIfRequested(
  argv: readonly string[],
  setupCommand: Command,
): boolean {
  if (
    argv[0] !== 'setup' ||
    !argv.slice(1).some((arg) => arg === '-h' || arg === '--help')
  ) {
    return false;
  }
  setupCommand.outputHelp();
  return true;
}

/**
 * FEATURE_289 (v0.7.85) §3.4 — `kodax memory review-drain`.
 *
 * Foreground, synchronous drain of the persisted episode-review inbox.
 * The background drain processes at most 2 jobs per run and is never
 * awaited, so the accumulated backlog can only be cleared here: this
 * command loops the same `drainCodingMemoryReviewInbox` path the runtime
 * uses until a pass makes no progress (or `--max` is reached). The
 * production reviewer is auto-installed with the same binding as
 * run-substrate.ts startup.
 */
export function configureKodaXMemoryCommand(program: Command): Command {
  const memoryCommand = program
    .command('memory')
    .description('Inspect and maintain governed memory review')
    .action(() => {
      console.log(chalk.cyan('\nKodaX Memory\n'));
      console.log(chalk.bold('Commands:'));
      console.log(
        chalk.dim('  kodax memory review-drain [--max N]  ') +
          'Drain pending memory review jobs in the foreground',
      );
      console.log();
    });

  memoryCommand
    .command('review-drain')
    .description('Drain pending memory review jobs in the foreground')
    .option(
      '--max <n>',
      'Maximum number of review jobs to process (default: unbounded)',
      parseOptionalNonNegativeInt,
    )
    .action(
      async (
        localOptions: { max?: number; provider?: string; model?: string },
        command: Command,
      ) => {
        await runMemoryReviewDrain(
          mergeCommandOptionsWithGlobals(localOptions, command),
        );
      },
    );

  return memoryCommand;
}

async function runMemoryReviewDrain(input: {
  readonly max?: number;
  readonly provider?: string;
  readonly model?: string;
}): Promise<void> {
  const config = loadConfig();
  const providerOverride = input.provider ?? process.env.KODAX_PROVIDER;
  const providerName = resolveCliProviderSelection(
    input.provider,
    process.env.KODAX_PROVIDER,
    config.provider,
    KODAX_DEFAULT_PROVIDER,
  );
  const provider = resolveProvider(providerName);
  if (!provider.isConfigured()) {
    console.error(
      chalk.red(`\n[memory review-drain] provider is not configured: ${providerName}`),
    );
    console.error(
      chalk.dim('  Run `kodax setup` or pass --provider <name> with configured credentials.\n'),
    );
    process.exitCode = 1;
    return;
  }
  const model = resolveCliModelSelection(
    providerOverride,
    input.model,
    config.provider,
    config.model,
  );
  const cwd = process.cwd();
  const sessionId = generateSessionId();
  const baseOptions: KodaXOptions = {
    provider: providerName,
    ...(model === undefined ? {} : { model }),
    session: { storage: new FileSessionStorage({ cwd }), scope: 'user' },
  };
  // Same production-reviewer binding as run-substrate.ts startup.
  const options = installProductionLearningReviewer(baseOptions, provider, model);
  const identity = deriveCodingMemoryIdentity(options, cwd, sessionId);
  const controller = createMemoryControlPlane({
    cwd,
    identity,
    projectDocs: [],
    discoverSkills: false,
  });

  console.log(chalk.cyan('\n[memory review-drain] draining pending memory review jobs'));
  console.log(
    chalk.dim(
      `  provider: ${providerName}${model === undefined ? '' : `, model: ${model}`}` +
        `, max: ${input.max === undefined ? 'unbounded' : input.max}`,
    ),
  );

  const totals = { reviewed: 0, discarded: 0, failed: 0, deferred: 0 };
  // Each pass is capped at the background-drain budget (2 entries), so
  // loop until a pass makes no progress. A pass with zero reviewed and zero
  // discarded terminates the loop: the remaining jobs are not completable
  // right now — deferred entries are in backoff / fenced / recovering, and
  // failed-only passes must NOT count as progress, because legacy v1
  // failures carry no backoff and would loop forever while burning judge
  // tokens. Re-run after the v2 backoff window to retry failures.
  for (;;) {
    const processed = totals.reviewed + totals.discarded + totals.failed;
    if (input.max !== undefined && processed >= input.max) break;
    const result = await drainCodingMemoryReviewInbox(
      options,
      identity,
      controller,
      sessionId,
    );
    if (result === undefined) {
      console.log(
        chalk.yellow('[memory review-drain] drain unavailable: reviewer or session storage missing.'),
      );
      break;
    }
    totals.reviewed += result.reviewed;
    totals.discarded += result.discarded;
    totals.failed += result.failed;
    totals.deferred += result.deferred;
    if (result.reviewed + result.discarded === 0) break;
  }
  console.log(chalk.cyan('\n[memory review-drain] summary'));
  console.log(`  reviewed : ${totals.reviewed}`);
  console.log(`  discarded: ${totals.discarded}`);
  console.log(`  failed   : ${totals.failed}`);
  console.log(`  deferred : ${totals.deferred}`);
  console.log();
  if (totals.failed > 0) {
    process.exitCode = 1;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (
    argv[0] === 'setup' &&
    argv.slice(1).some((arg) => arg === '-h' || arg === '--help')
  ) {
    const helpProgram = new Command().name('kodax');
    const helpCommand = configureKodaXSetupCommand(helpProgram);
    showKodaXSetupHelpIfRequested(argv, helpCommand);
    return;
  }
  const isDaemonManagementCommand = argv[0] === 'daemon' && argv[1] !== 'serve';

  // FEATURE_208 (v0.7.45): strip dynamic-linker preload env vars
  // (LD_PRELOAD / DYLD_*) before anything spawns children or loads native
  // addons. Opt-out: KODAX_DISABLE_HARDENING=1. Debug-preserving (no
  // PR_SET_DUMPABLE). No-op on Windows.
  applyProcessHardening();
  if (argv[0] === '__skill-tool') {
    if (!consumeInternalSkillDispatchFlag()) {
      throw new Error('Internal skill tool entry is not available directly.');
    }
    if (!isSkillCreatorDispatchAction(argv[1])) {
      throw new Error(`Unknown internal skill tool: ${argv[1] ?? '(missing)'}`);
    }
    await dispatchSkillCreatorTool(argv[1], argv.slice(2), {
      estimateTokens,
      runKodaX,
    });
    return;
  }
  if (argv[0] === '__asrt-broker') {
    if (process.platform === 'win32') {
      throw new Error('Windows legacy ASRT broker execution is retired; use the native v2 shell sandbox.');
    }
    if (!argv[1]) throw new Error('Missing internal ASRT broker request.');
    process.exitCode = await (await loadSandboxRuntimeModule()).runAsrtBrokerProcess(argv[1]);
    return;
  }
  if (argv[0] === '__asrt-windows-network-broker') {
    if (!argv[1]) throw new Error('Missing Windows network broker request file.');
    process.exitCode = await (await loadSandboxRuntimeModule())
      .runAsrtWindowsNetworkBrokerProcess(argv[1]);
    return;
  }
  if (!isDaemonManagementCommand) {
    await cleanupRegisteredManagedChildren();
  }

  // FEATURE_209 (v0.7.45): activate tracing so Runner spans persist to
  // ~/.kodax/.traces/<traceId>.jsonl. FileTracingProcessor flushes per-trace
  // on completion, so completed traces are durable without the beforeExit
  // handler; that handler only flushes a trace still in flight when the event
  // loop drains naturally (it does NOT fire on process.exit()). Opt-out via
  // KODAX_TRACING=0.
  if (!isDaemonManagementCommand) {
    bootstrapTracing();
    process.once('beforeExit', () => {
      void shutdownTracing();
    });
  }

  // Session retention: opt-in best-effort background prune of session files
  // older than KODAX_SESSION_RETENTION_DAYS. DEFAULT OFF (0) — auto-deleting a
  // user's accumulated history is destructive and surprising, so it must be
  // explicitly enabled (e.g. KODAX_SESSION_RETENTION_DAYS=30). The `list()`
  // head-read path already keeps `kodax -c` + the picker fast regardless of
  // file count, so retention is a housekeeping convenience, not a perf
  // requirement. Fire-and-forget never blocks startup, but cleanup failures
  // are reported because cached message bodies must remain attached to a
  // retryable Session lifecycle operation.
  // Read from env (shell override) then config.json (persistent). This runs at
  // startup before prepareRuntimeConfig's bridge, so it reads config directly.
  if (!isDaemonManagementCommand) {
    const sessionRetentionDays = Number(
      process.env.KODAX_SESSION_RETENTION_DAYS ??
        loadConfig().sessionRetentionDays ??
        0,
    );
    void new FileSessionStorage().cleanupOldSessions(sessionRetentionDays).catch((error: unknown) => {
      emitKodaXDiagnostic({
        source: 'cli:session-retention',
        level: 'warn',
        message: 'Session retention cleanup was incomplete and will be retried later.',
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  }

  const program = configureKodaXRootCommand(
    new Command()
      .name('kodax')
      .description('KodaX - Intelligent Coding Agent')
      .version(version),
  );
  configureIntegrationCommands(program, { version });

  configureKodaXSetupCommand(program);
  configureKodaXMemoryCommand(program);

  // ============== completion subcommand ==============
  program
    .command('completion')
    .description('Generate shell completion script')
    .argument('<shell>', 'Shell type: bash, zsh, or fish')
    .action((shell: string) => {
      const providerNames = getAvailableProviderNames().join(' ');
      const reasoningModes = 'off auto quick balanced deep';
      const effortModes = 'off auto low medium high xhigh max';
      const agentModes = 'ama sa';
      const repoModes = 'auto full light off';
      const rootSubcommands =
        'setup acp skill tools sessions constructed doctor daemon completion config integrations mcp extensions a2a sandbox';
      const allOptions = [
        '-p',
        '-c',
        '-r',
        '-n',
        '-m',
        '-t',
        '-s',
        '-y',
        '-h',
        '--help',
        '--print',
        '--mode',
        '--runtime-mode',
        '--continue',
        '--resume',
        '--new',
        '--provider',
        '--model',
        '--thinking',
        '--effort',
        '--reasoning',
        '--agent-mode',
        '--repo-intelligence',
        '--repo-intelligence-trace',
        '--auto',
        '--session',
        '--extension',
        '--no-session',
        '--max-iter',
        '--version',
        '--json',
        '--ping',
        '--cwd',
        '--permission-mode',
        '--dest',
        '--description',
        '--force',
        '--no-evals',
        '--skill-path',
        '--evals',
        '--workspace',
        '--config-a',
        '--config-b',
        '--output',
        '--apply',
        '--all',
        '--custom',
      ].join(' ');
      const skillSubcommands =
        'init validate eval grade analyze compare package install';
      const toolsSubcommands = 'list inspect revoke';
      const sessionsSubcommands = 'dedupe';
      const constructedSubcommands =
        'reset-self-modify-budget audit disable-self-modify rollback';

      if (shell === 'bash') {
        console.log(`# KodaX bash completion — add to ~/.bashrc:
#   eval "$(kodax completion bash)"
_kodax_complete() {
  local cur prev opts subcmds
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  subcmds="${rootSubcommands}"
  opts="${allOptions}"

  case "\${prev}" in
    --provider|-m) COMPREPLY=( $(compgen -W "${providerNames}" -- "\${cur}") ); return 0 ;;
    --mode) COMPREPLY=( $(compgen -W "json" -- "\${cur}") ); return 0 ;;
    --runtime-mode) COMPREPLY=( $(compgen -W "embedded daemon" -- "\${cur}") ); return 0 ;;
    --effort) COMPREPLY=( $(compgen -W "${effortModes}" -- "\${cur}") ); return 0 ;;
    --reasoning) COMPREPLY=( $(compgen -W "${reasoningModes}" -- "\${cur}") ); return 0 ;;
    --agent-mode) COMPREPLY=( $(compgen -W "${agentModes}" -- "\${cur}") ); return 0 ;;
    --repo-intelligence) COMPREPLY=( $(compgen -W "${repoModes}" -- "\${cur}") ); return 0 ;;
    --session|-s) COMPREPLY=( $(compgen -W "list resume delete delete-all" -- "\${cur}") ); return 0 ;;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") ); return 0 ;;
    acp) COMPREPLY=( $(compgen -W "serve" -- "\${cur}") ); return 0 ;;
    daemon) COMPREPLY=( $(compgen -W "start stop restart status logs serve" -- "\${cur}") ); return 0 ;;
    skill) COMPREPLY=( $(compgen -W "${skillSubcommands}" -- "\${cur}") ); return 0 ;;
    tools) COMPREPLY=( $(compgen -W "${toolsSubcommands}" -- "\${cur}") ); return 0 ;;
    sessions) COMPREPLY=( $(compgen -W "${sessionsSubcommands}" -- "\${cur}") ); return 0 ;;
    constructed) COMPREPLY=( $(compgen -W "${constructedSubcommands}" -- "\${cur}") ); return 0 ;;
    config) COMPREPLY=( $(compgen -W "template paths" -- "\${cur}") ); return 0 ;;
    integrations) COMPREPLY=( $(compgen -W "status validate reload migrate" -- "\${cur}") ); return 0 ;;
    mcp) COMPREPLY=( $(compgen -W "list add remove" -- "\${cur}") ); return 0 ;;
    extensions) COMPREPLY=( $(compgen -W "list add remove reload" -- "\${cur}") ); return 0 ;;
    a2a) COMPREPLY=( $(compgen -W "list add remove test call expose serve" -- "\${cur}") ); return 0 ;;
    sandbox) COMPREPLY=( $(compgen -W "doctor setup" -- "\${cur}") ); return 0 ;;
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "\${opts}" -- "\${cur}") )
  elif [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${subcmds}" -- "\${cur}") )
  fi
}
complete -F _kodax_complete kodax`);
      } else if (shell === 'zsh') {
        console.log(`# KodaX zsh completion — add to ~/.zshrc:
#   eval "$(kodax completion zsh)"
_kodax() {
  local -a subcmds opts providers reasoning_modes agent_modes repo_modes
  subcmds=(${rootSubcommands})
  providers=(${providerNames.replace(/ /g, ' ')})
  reasoning_modes=(off auto quick balanced deep)
  effort_modes=(off auto low medium high xhigh max)
  agent_modes=(ama sa)
  repo_modes=(${repoModes})

  _arguments -C \\
    '-p[Print mode]+:text:' \\
    '--print+[Print mode]:text:' \\
    '--mode+[Output mode]:mode:(json)' \\
    '--runtime-mode+[Interactive runtime mode]:mode:(embedded daemon)' \\
    '-c[Continue most recent non-empty conversation]' \\
    '--continue[Continue most recent non-empty conversation]' \\
    '-n[Start fresh session]' \\
    '--new[Start fresh session]' \\
    '-r[Resume session by ID or exact title]::id-or-title:' \\
    '--resume[Resume session by ID or exact title]::id-or-title:' \\
    '-m[LLM provider]+:provider:($providers)' \\
    '--provider+[LLM provider]:provider:($providers)' \\
    '--model+[Model override]:model:' \\
    '-t[Enable thinking]' \\
    '--thinking[Enable thinking]' \\
    '--effort+[Reasoning effort]:level:($effort_modes)' \\
    '--reasoning+[Compatibility reasoning mode]:mode:($reasoning_modes)' \\
    '--agent-mode+[Agent mode]:mode:($agent_modes)' \\
    '--repo-intelligence+[Repo intelligence mode]:mode:($repo_modes)' \\
    '--repo-intelligence-trace[Enable repo intelligence trace]' \\
    '-s[Legacy session operation]+:operation:(list resume delete delete-all)' \\
    '--session+[Legacy session operation]:operation:(list resume delete delete-all)' \\
    '--extension+[Load local extension]:path:_files' \\
    '--no-session[Disable session persistence in print mode]' \\
    '--max-iter+[Max iterations]:n:' \\
    '--version[Show version]' \\
    '-h[Show help]::topic:' \\
    '--help[Show help]::topic:' \\
    '1:subcommand:($subcmds)' \\
    '*::arg:->args'
}
compdef _kodax kodax`);
      } else if (shell === 'fish') {
        console.log(`# KodaX fish completion — add to ~/.config/fish/completions/kodax.fish:
#   kodax completion fish > ~/.config/fish/completions/kodax.fish
complete -c kodax -n '__fish_use_subcommand' -a '${rootSubcommands}' -d 'Subcommands'
complete -c kodax -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish' -d 'Shell'
complete -c kodax -n '__fish_seen_subcommand_from acp' -a 'serve' -d 'ACP subcommand'
complete -c kodax -n '__fish_seen_subcommand_from daemon' -a 'start stop restart status logs serve' -d 'Daemon subcommand'
complete -c kodax -n '__fish_seen_subcommand_from skill' -a '${skillSubcommands}' -d 'Skill subcommand'
complete -c kodax -n '__fish_seen_subcommand_from tools' -a '${toolsSubcommands}' -d 'Tools subcommand'
complete -c kodax -n '__fish_seen_subcommand_from sessions' -a '${sessionsSubcommands}' -d 'Sessions subcommand'
complete -c kodax -n '__fish_seen_subcommand_from constructed' -a '${constructedSubcommands}' -d 'Constructed subcommand'
complete -c kodax -n '__fish_seen_subcommand_from config' -a 'template paths' -d 'Config subcommand'
complete -c kodax -n '__fish_seen_subcommand_from integrations' -a 'status validate reload migrate' -d 'Integration subcommand'
complete -c kodax -n '__fish_seen_subcommand_from mcp' -a 'list add remove' -d 'MCP subcommand'
complete -c kodax -n '__fish_seen_subcommand_from extensions' -a 'list add remove reload' -d 'Extension subcommand'
complete -c kodax -n '__fish_seen_subcommand_from a2a' -a 'list add remove test call expose serve' -d 'A2A subcommand'
complete -c kodax -n '__fish_seen_subcommand_from sandbox' -a 'doctor setup' -d 'Sandbox subcommand'
complete -c kodax -s h -l help -d 'Show help'
complete -c kodax -s p -l print -d 'Print mode' -r
complete -c kodax -l mode -d 'Output mode' -xa 'json'
complete -c kodax -l runtime-mode -d 'Interactive runtime mode' -xa 'embedded daemon'
complete -c kodax -s c -l continue -d 'Continue most recent conversation'
complete -c kodax -s n -l new -d 'Start fresh session'
complete -c kodax -s r -l resume -d 'Resume session by ID or exact title' -r
complete -c kodax -s m -l provider -d 'LLM provider' -xa '${providerNames}'
complete -c kodax -l model -d 'Model override' -r
complete -c kodax -s t -l thinking -d 'Enable thinking'
complete -c kodax -l effort -d 'Reasoning effort' -xa 'off auto low medium high xhigh max'
complete -c kodax -l reasoning -d 'Reasoning mode' -xa '${reasoningModes}'
complete -c kodax -l agent-mode -d 'Agent mode' -xa '${agentModes}'
complete -c kodax -l repo-intelligence -d 'Repo intelligence mode' -xa '${repoModes}'
complete -c kodax -l repo-intelligence-trace -d 'Enable repo intelligence trace'
complete -c kodax -s y -l auto -d 'Backward-compatible no-op'
complete -c kodax -s s -l session -d 'Legacy session operation' -xa 'list resume delete delete-all'
complete -c kodax -l extension -d 'Load local extension' -r
complete -c kodax -l no-session -d 'Disable session persistence in print mode'
complete -c kodax -l max-iter -d 'Max iterations' -r
complete -c kodax -l version -d 'Show version'`);
      } else {
        console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
        process.exit(1);
      }
    });

  // ============== sessions subcommands ==============
  const sessionsCommand = program
    .command('sessions')
    .description('Manage saved KodaX sessions')
    .action(() => {
      console.log(chalk.cyan('\nKodaX Sessions\n'));
      console.log(chalk.bold('Commands:'));
      console.log(
        chalk.dim('  kodax sessions dedupe          ') +
          'Dry-run historical runner ghost cleanup',
      );
      console.log(
        chalk.dim('  kodax sessions dedupe --apply  ') +
          'Move uniquely matched runner ghosts to .dedupe-archive',
      );
      console.log(chalk.dim('\nLegacy:'));
      console.log(
        chalk.dim('  kodax -s list                  ') + 'List saved sessions',
      );
    });

  sessionsCommand
    .command('dedupe')
    .description(
      'Find and optionally move historical runner ghost session files',
    )
    .option(
      '--apply',
      'Move uniquely matched runner ghost files into .dedupe-archive',
    )
    .action(async (subOpts: { apply?: boolean }) => {
      const applied = subOpts.apply === true;
      const report = await dedupeSessions({ apply: applied });
      printSessionDedupeReport(report, applied);
    });

  // ============== doctor subcommand (FEATURE_204) ==============
  program
    .command('doctor')
    .description(
      'Print environment diagnostics (runtime, providers, session/trace disk usage)',
    )
    .option('--json', 'Output machine-readable JSON')
    .option(
      '--ping',
      'Live-probe each configured provider (network + small token cost)',
    )
    .option(
      '--native-text',
      'Load and hash-check the trusted text native binding',
    )
    .action(async (opts: { json?: boolean; ping?: boolean; nativeText?: boolean }) => {
      await runDoctor(version, Boolean(opts?.json), {
        ping: Boolean(opts?.ping),
        nativeText: Boolean(opts?.nativeText),
      });
    });

  const daemonCommand = program
    .command('daemon')
    .description('Inspect and manage the local KodaX runtime daemon')
    .helpOption('-h, --help', 'Show daemon help');

  daemonCommand
    .command('start')
    .description('Start the runtime daemon in a detached background process')
    .option('--profile <name>', 'Daemon profile', 'default')
    .option(
      '--home <dir>',
      'Base directory that owns the .kodax runtime daemon state',
    )
    .option('-m, --provider <name>', 'Default provider for hosted runs')
    .option('--model <name>', 'Default model for hosted runs')
    .option(
      '--timeout-ms <n>',
      'Milliseconds to wait for daemon health',
      parseOptionalNonNegativeInt,
      5_000,
    )
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (
        localOptions: {
          profile?: string;
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
          profile: options.profile ?? 'default',
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
    .description('Stop a healthy runtime daemon')
    .option('--profile <name>', 'Daemon profile', 'default')
    .option(
      '--home <dir>',
      'Base directory that owns the .kodax runtime daemon state',
    )
    .option(
      '--timeout-ms <n>',
      'Milliseconds to wait for daemon shutdown',
      parseOptionalNonNegativeInt,
      5_000,
    )
    .option(
      '--force',
      'Clean verified stale daemon ownership without killing unverified live processes',
    )
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (subOpts: {
        profile?: string;
        home?: string;
        timeoutMs?: number;
        force?: boolean;
        json?: boolean;
      }) => {
        await stopDaemonCommand({
          profile: subOpts.profile ?? 'default',
          ...resolveCliRuntimeDaemonLocation(subOpts.home),
          timeoutMs: subOpts.timeoutMs ?? 5_000,
          force: subOpts.force === true,
          json: subOpts.json === true,
        });
      },
    );

  daemonCommand
    .command('restart')
    .description('Restart the runtime daemon')
    .option('--profile <name>', 'Daemon profile', 'default')
    .option(
      '--home <dir>',
      'Base directory that owns the .kodax runtime daemon state',
    )
    .option('-m, --provider <name>', 'Default provider for hosted runs')
    .option('--model <name>', 'Default model for hosted runs')
    .option(
      '--timeout-ms <n>',
      'Milliseconds to wait for daemon shutdown/startup',
      parseOptionalNonNegativeInt,
      5_000,
    )
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (
        localOptions: {
          profile?: string;
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
          profile: options.profile ?? 'default',
          ...resolveCliRuntimeDaemonLocation(options.home),
          provider: options.provider,
          model: options.model,
          timeoutMs: options.timeoutMs ?? 5_000,
          json: options.json === true,
        });
      },
    );

  daemonCommand
    .command('logs')
    .description('Print the daemon log path and recent lines')
    .option('--profile <name>', 'Daemon profile', 'default')
    .option(
      '--home <dir>',
      'Base directory that owns the .kodax runtime daemon state',
    )
    .option(
      '--lines <n>',
      'Number of log lines to print',
      parseOptionalNonNegativeInt,
      80,
    )
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (subOpts: {
        profile?: string;
        home?: string;
        lines?: number;
        json?: boolean;
      }) => {
        await printDaemonLogs({
          profile: subOpts.profile ?? 'default',
          ...resolveCliRuntimeDaemonLocation(subOpts.home),
          lines: subOpts.lines ?? 80,
          json: subOpts.json === true,
        });
      },
    );

  daemonCommand
    .command('serve')
    .description('Run the runtime daemon host in the foreground')
    .option('--profile <name>', 'Daemon profile', 'default')
    .option(
      '--home <dir>',
      'Base directory that owns the .kodax runtime daemon state',
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
      'User-input request timeout',
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
          profile?: string;
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
          profile: options.profile ?? 'default',
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
    .description('Inspect daemon state and endpoint health')
    .option('--profile <name>', 'Daemon profile', 'default')
    .option(
      '--home <dir>',
      'Base directory that owns the .kodax runtime daemon state',
    )
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (subOpts: { profile?: string; home?: string; json?: boolean }) => {
        await printDaemonStatus({
          profile: subOpts.profile ?? 'default',
          ...resolveCliRuntimeDaemonLocation(subOpts.home),
          json: subOpts.json === true,
        });
      },
    );

  const skillCommand = program
    .command('skill')
    .description('Built-in skill packaging and installation helpers')
    .helpOption('-h, --help', 'Show skill utility help');

  const acpCommand = program
    .command('acp')
    .description('Run KodaX as an ACP server for editors and IDEs')
    .helpOption('-h, --help', 'Show ACP server help');

  acpCommand
    .command('serve')
    .description('Run the ACP stdio server')
    .option('--cwd <dir>', 'Working directory exposed to ACP sessions')
    .option('-m, --provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    // prettier-ignore
    .option('--effort <level>', 'Reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value', parseEffortOption)
    .option('-t, --thinking', 'Compatibility alias for --reasoning auto')
    .option(
      '--reasoning <mode>',
      'Reasoning mode: off, auto, quick, balanced, deep',
      parseReasoningModeOption,
    )
    .option(
      '--repo-intelligence <mode>',
      'Repo intelligence mode: auto, full, light, off',
      parseRepoIntelligenceModeOption,
    )
    .option(
      '--repo-intelligence-trace',
      'Enable repo intelligence trace metadata/logging',
    )
    .option(
      '--permission-mode <mode>',
      'Initial permission mode',
      parsePermissionModeOption,
      'accept-edits',
    )
    .action(
      async (
        localOptions: {
          cwd?: string;
          provider?: string;
          model?: string;
          effort?: string;
          thinking?: boolean;
          reasoning?: KodaXReasoningMode;
          repoIntelligence?: string;
          repoIntelligenceTrace?: boolean;
          permissionMode?: AcpPermissionMode;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        if (
          typeof options.repoIntelligence === 'string' &&
          options.repoIntelligence.trim()
        ) {
          process.env.KODAX_REPO_INTELLIGENCE = options.repoIntelligence.trim();
        }
        if (options.repoIntelligenceTrace === true) {
          process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
        }
        const { runAcpServer } = await import('./acp_server.js');
        await runAcpServer({
          cwd: options.cwd,
          provider: options.provider,
          model: options.model,
          effort: options.effort,
          thinking: options.thinking,
          reasoningMode: options.reasoning,
          permissionMode: options.permissionMode,
          agentVersion: version,
        });
      },
    );

  skillCommand
    .command('init <name>')
    .description('Initialize a new skill scaffold')
    .option('-d, --dest <dir>', 'Base skills directory')
    .option('--description <text>', 'Initial skill description')
    .option('-f, --force', 'Allow writing into an existing target directory')
    .option('--no-evals', 'Skip creating evals/evals.json')
    .action(
      async (
        name: string,
        subcommandOptions: {
          dest?: string;
          description?: string;
          force?: boolean;
          evals?: boolean;
        },
      ) => {
        const args = [name];
        if (subcommandOptions.dest) {
          args.push('--dest', subcommandOptions.dest);
        }
        if (subcommandOptions.description) {
          args.push('--description', subcommandOptions.description);
        }
        if (subcommandOptions.force) {
          args.push('--force');
        }
        if (subcommandOptions.evals === false) {
          args.push('--no-evals');
        }
        await runSkillCreatorTool('init', args);
      },
    );

  skillCommand
    .command('validate <skillDir>')
    .description('Validate a skill directory using builtin skill-creator')
    .action(async (skillDir: string) => {
      await runSkillCreatorTool('validate', [skillDir]);
    });

  skillCommand
    .command('eval')
    .description(
      'Run end-to-end skill evals and write a benchmark/review workspace',
    )
    .requiredOption('--skill-path <dir>', 'Skill directory to evaluate')
    .requiredOption('--evals <file>', 'Evals JSON file')
    .requiredOption('--workspace <dir>', 'Workspace output directory')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--runs <n>', 'Runs per config')
    .option('--max-iter <n>', 'Max iterations per run')
    .option('--reasoning <mode>', 'Reasoning mode', parseReasoningModeOption)
    .option('--cwd <dir>', 'Working directory for the runs')
    .option(
      '--configs <list>',
      'Comma-separated configs, e.g. with_skill,without_skill',
    )
    .option('-o, --output <file>', 'Optional JSON summary output')
    .action(
      async (
        localOptions: {
          skillPath: string;
          evals: string;
          workspace: string;
          provider?: string;
          model?: string;
          runs?: string;
          maxIter?: string;
          reasoning?: string;
          cwd?: string;
          configs?: string;
          output?: string;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        const args = [
          '--skill-path',
          options.skillPath,
          '--evals',
          options.evals,
          '--workspace',
          options.workspace,
        ];
        if (options.provider) {
          args.push('--provider', options.provider);
        }
        if (options.model) {
          args.push('--model', options.model);
        }
        if (options.runs) {
          args.push('--runs', options.runs);
        }
        if (options.maxIter) {
          args.push('--max-iter', options.maxIter);
        }
        if (options.reasoning) {
          args.push('--reasoning', options.reasoning);
        }
        if (options.cwd) {
          args.push('--cwd', options.cwd);
        }
        if (options.configs) {
          args.push('--configs', options.configs);
        }
        if (options.output) {
          args.push('--output', options.output);
        }
        await runSkillCreatorTool('eval', args);
      },
    );

  skillCommand
    .command('grade <workspace>')
    .description('Grade eval runs into grading.json files')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--reasoning <mode>', 'Reasoning mode', parseReasoningModeOption)
    .option('--max-iter <n>', 'Max iterations per grading run')
    .option(
      '--configs <list>',
      'Comma-separated configs, e.g. with_skill,without_skill',
    )
    .option('--overwrite', 'Re-grade runs that already have grading.json')
    .action(
      async (
        workspace: string,
        localOptions: {
          provider?: string;
          model?: string;
          reasoning?: string;
          maxIter?: string;
          configs?: string;
          overwrite?: boolean;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        const args = [workspace];
        if (options.provider) {
          args.push('--provider', options.provider);
        }
        if (options.model) {
          args.push('--model', options.model);
        }
        if (options.reasoning) {
          args.push('--reasoning', options.reasoning);
        }
        if (options.maxIter) {
          args.push('--max-iter', options.maxIter);
        }
        if (options.configs) {
          args.push('--configs', options.configs);
        }
        if (options.overwrite) {
          args.push('--overwrite');
        }
        await runSkillCreatorTool('grade', args);
      },
    );

  skillCommand
    .command('analyze <workspace>')
    .description('Analyze benchmark variance and write analysis artifacts')
    .option('--benchmark <file>', 'Optional benchmark.json path')
    .option('--output <file>', 'JSON output path')
    .option('--markdown <file>', 'Markdown output path')
    .option(
      '--skill-name <name>',
      'Skill name if benchmark.json must be regenerated',
    )
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--reasoning <mode>', 'Reasoning mode', parseReasoningModeOption)
    .action(
      async (
        workspace: string,
        localOptions: {
          benchmark?: string;
          output?: string;
          markdown?: string;
          skillName?: string;
          provider?: string;
          model?: string;
          reasoning?: string;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        const args = [workspace];
        if (options.benchmark) {
          args.push('--benchmark', options.benchmark);
        }
        if (options.output) {
          args.push('--output', options.output);
        }
        if (options.markdown) {
          args.push('--markdown', options.markdown);
        }
        if (options.skillName) {
          args.push('--skill-name', options.skillName);
        }
        if (options.provider) {
          args.push('--provider', options.provider);
        }
        if (options.model) {
          args.push('--model', options.model);
        }
        if (options.reasoning) {
          args.push('--reasoning', options.reasoning);
        }
        await runSkillCreatorTool('analyze', args);
      },
    );

  skillCommand
    .command('compare <workspace>')
    .description('Blind-compare two configs across eval run pairs')
    .option('--config-a <name>', 'Primary config', 'with_skill')
    .option('--config-b <name>', 'Baseline config', 'without_skill')
    .option('--output <file>', 'JSON output path')
    .option('--markdown <file>', 'Markdown output path')
    .option('--max-pairs <n>', 'Limit pairs per eval')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--reasoning <mode>', 'Reasoning mode', parseReasoningModeOption)
    .action(
      async (
        workspace: string,
        localOptions: {
          configA: string;
          configB: string;
          output?: string;
          markdown?: string;
          maxPairs?: string;
          provider?: string;
          model?: string;
          reasoning?: string;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        const args = [
          workspace,
          '--config-a',
          options.configA,
          '--config-b',
          options.configB,
        ];
        if (options.output) {
          args.push('--output', options.output);
        }
        if (options.markdown) {
          args.push('--markdown', options.markdown);
        }
        if (options.maxPairs) {
          args.push('--max-pairs', options.maxPairs);
        }
        if (options.provider) {
          args.push('--provider', options.provider);
        }
        if (options.model) {
          args.push('--model', options.model);
        }
        if (options.reasoning) {
          args.push('--reasoning', options.reasoning);
        }
        await runSkillCreatorTool('compare', args);
      },
    );

  skillCommand
    .command('package <skillDir>')
    .description('Package a skill directory as a .skill archive')
    .option('-o, --output <file>', 'Output .skill file path')
    .action(
      async (skillDir: string, subcommandOptions: { output?: string }) => {
        const args = [skillDir];
        if (subcommandOptions.output) {
          args.push('--output', subcommandOptions.output);
        }
        await runSkillCreatorTool('package', args);
      },
    );

  skillCommand
    .command('install <input>')
    .description(
      'Install a skill directory or .skill archive into a skills directory',
    )
    .option('-d, --dest <dir>', 'Destination skills directory')
    .option('-f, --force', 'Overwrite an existing target skill')
    .action(
      async (
        input: string,
        subcommandOptions: { dest?: string; force?: boolean },
      ) => {
        const args = [input];
        if (subcommandOptions.dest) {
          args.push('--dest', subcommandOptions.dest);
        }
        if (subcommandOptions.force) {
          args.push('--force');
        }
        await runSkillCreatorTool('install', args);
      },
    );

  if (argv[0] === 'skill') {
    if (argv.length === 1 || argv[1] === '-h' || argv[1] === '--help') {
      console.log(skillCommand.helpInformation());
      return;
    }

    const skillSubcommand = argv[1];
    if (skillSubcommand && (argv.includes('-h') || argv.includes('--help'))) {
      if (printSkillSubcommandHelp(skillSubcommand)) {
        return;
      }
    }
  }

  if (argv[0] === 'acp') {
    if (argv.length === 1 || argv[1] === '-h' || argv[1] === '--help') {
      console.log(acpCommand.helpInformation());
      return;
    }

    const acpSubcommand = argv[1];
    if (acpSubcommand && (argv.includes('-h') || argv.includes('--help'))) {
      if (printAcpSubcommandHelp(acpSubcommand)) {
        return;
      }
    }
  }

  // ============== tools subcommand (constructed-tool inventory) ==============
  // Lifecycle helpers for constructed tools — list / inspect / revoke.
  // Activate is intentionally NOT exposed here (must originate from the
  // REPL where a dialog can solicit user approval; see DD §14.5.4).
  const toolsCommand = program
    .command('tools')
    .description('Inspect and manage constructed tools (FEATURE_088, v0.7.28)')
    .helpOption('-h, --help', 'Show tools subcommand help');

  toolsCommand
    .command('list')
    .description('List constructed tools registered in the current workspace')
    .option('--all', 'Also list builtin / extension tools')
    .option(
      '--cwd <dir>',
      'Workspace root to inspect (defaults to current directory)',
    )
    .action(async (subOpts: { all?: boolean; cwd?: string }) => {
      const { runToolsList } = await import('./constructed_cli.js');
      await runToolsList({
        all: subOpts.all,
        cwd: subOpts.cwd ?? process.cwd(),
      });
    });

  toolsCommand
    .command('inspect <spec>')
    .description(
      "Print an artifact manifest. <spec> is '<name>' (active) or '<name>@<version>'.",
    )
    .option(
      '--cwd <dir>',
      'Workspace root to inspect (defaults to current directory)',
    )
    .action(async (spec: string, subOpts: { cwd?: string }) => {
      const { runToolsInspect } = await import('./constructed_cli.js');
      await runToolsInspect(spec, { cwd: subOpts.cwd ?? process.cwd() });
    });

  toolsCommand
    .command('revoke <spec>')
    .description(
      "Revoke a constructed tool. <spec> must be '<name>@<version>'.",
    )
    .option(
      '--cwd <dir>',
      'Workspace root to inspect (defaults to current directory)',
    )
    .action(async (spec: string, subOpts: { cwd?: string }) => {
      const { runToolsRevoke } = await import('./constructed_cli.js');
      await runToolsRevoke(spec, { cwd: subOpts.cwd ?? process.cwd() });
    });

  // ============== constructed subcommand (FEATURE_090, v0.7.32) ==============
  // Self-modify lifecycle helpers for constructed agents — separate
  // command group from `kodax tools` because the surface targets
  // agent governance (budget reset, rollback, audit, disable), not
  // tool inventory. Activate is intentionally NOT exposed here for
  // the same reason as tools — must originate from the REPL where a
  // dialog can render the diff + LLM summary and solicit user
  // approval.
  const constructedCommand = program
    .command('constructed')
    .description(
      'Manage the self-modify lifecycle of constructed agents (FEATURE_090, v0.7.32)',
    )
    .helpOption('-h, --help', 'Show constructed subcommand help');

  constructedCommand
    .command('reset-self-modify-budget <name>')
    .description(
      'Reset the per-agent self-modify counter to zero. Use after a deliberate, audited decision to allow further self-modifications past the default cap. The reset is recorded in `.kodax/constructed/_audit.jsonl`.',
    )
    .option(
      '--cwd <dir>',
      'Workspace root to inspect (defaults to current directory)',
    )
    .action(async (name: string, subOpts: { cwd?: string }) => {
      const { runResetSelfModifyBudget } = await import('./self_modify_cli.js');
      await runResetSelfModifyBudget(name, {
        cwd: subOpts.cwd ?? process.cwd(),
      });
    });

  constructedCommand
    .command('audit <name>')
    .description(
      'Print every recorded self-modify lifecycle event for the named agent (staged / activated / rejected / rolled-back / disabled / budget-reset). Read-only.',
    )
    .option(
      '--cwd <dir>',
      'Workspace root to inspect (defaults to current directory)',
    )
    .action(async (name: string, subOpts: { cwd?: string }) => {
      const { runConstructedAudit } = await import('./self_modify_cli.js');
      await runConstructedAudit(name, { cwd: subOpts.cwd ?? process.cwd() });
    });

  constructedCommand
    .command('disable-self-modify <name>')
    .description(
      'Permanently disable self-modify for the named agent. There is NO re-enable command — to author further changes, stage a separately-named agent. The disable event is recorded in `.kodax/constructed/_audit.jsonl`.',
    )
    .option(
      '--cwd <dir>',
      'Workspace root to inspect (defaults to current directory)',
    )
    .action(async (name: string, subOpts: { cwd?: string }) => {
      const { runDisableSelfModify } = await import('./self_modify_cli.js');
      await runDisableSelfModify(name, { cwd: subOpts.cwd ?? process.cwd() });
    });

  constructedCommand
    .command('rollback <name>')
    .description(
      'Roll the agent back to its previous active version. Revokes the current active manifest and re-registers the next-most-recent active version on disk. Re-runs admission against the rollback target so a target that no longer admits (e.g. system caps tightened) cannot be silently re-registered.',
    )
    .option(
      '--cwd <dir>',
      'Workspace root to inspect (defaults to current directory)',
    )
    .action(async (name: string, subOpts: { cwd?: string }) => {
      const { runConstructedRollback } = await import('./self_modify_cli.js');
      await runConstructedRollback(name, { cwd: subOpts.cwd ?? process.cwd() });
    });

  // ============== constructed-tool direct dispatch ==============
  // BEFORE commander parses, intercept `kodax <constructed-tool-name> ...`
  // and dispatch to the registered handler. The detection bootstraps the
  // ConstructionRuntime and consults TOOL_REGISTRY — only fires when the
  // name matches an activated constructed tool. On no match we fall
  // through to commander, which preserves existing behavior (skill/acp/
  // help topics/REPL).
  if (
    argv.length > 0 &&
    argv[0] &&
    !argv[0].startsWith('-') &&
    !CLI_SUBCOMMAND_NAMES.has(argv[0])
  ) {
    const { detectConstructedToolDispatch, runConstructedToolDispatch } =
      await import('./constructed_cli.js');
    const dispatchTarget = await detectConstructedToolDispatch(
      argv,
      process.cwd(),
    );
    if (dispatchTarget) {
      await runConstructedToolDispatch(
        dispatchTarget,
        argv.slice(1),
        process.cwd(),
      );
      return;
    }
  }

  await program.parseAsync(process.argv);
  if (
    program.args[0] !== undefined &&
    CLI_SUBCOMMAND_NAMES.has(program.args[0])
  ) {
    return;
  }

  const opts = program.opts();
  const outputMode = (opts.mode as CliOutputMode | undefined) ?? 'text';
  // Hydrate login-shell and config-backed environment before first-run
  // readiness inspects credentials. Reuse this same Runtime configuration for
  // startup so the gate and the session cannot observe different environments.
  const config = prepareRuntimeConfig();
  if (
    shouldAutoLaunchProviderSetup({
      outputMode,
      prompt: opts.print ? [String(opts.print)] : program.args,
      print: opts.print !== undefined,
      continue: opts.continue === true,
      resumeRequested: opts.resume !== undefined,
      sessionRequested: opts.session !== undefined,
      helpRequested: opts.help !== undefined,
      extensionRequested:
        Array.isArray(opts.extension) && opts.extension.length > 0,
      isInputTty: process.stdin.isTTY,
      isOutputTty: process.stdout.isTTY,
    })
  ) {
    const readiness = inspectProviderSetupReadiness({
      configPath: KODAX_CONFIG_FILE,
      environment: process.env,
      explicitProvider: opts.provider,
    });
    const credentialEnvironmentNames = [
      ...getProviderSetupCatalog().map((provider) => provider.apiKeyEnv),
      ...(config.customProviders ?? []).map((provider) => provider.apiKeyEnv),
    ];
    if (readiness.status === 'needs-provider') {
      if (!hasProviderCredentialEnvironment(
        credentialEnvironmentNames,
        process.env,
      )) {
        process.stdout.write(
          `\n${renderMissingProviderCredentialGuide(credentialEnvironmentNames)}\n\n`,
        );
        return;
      }
      await executeProviderSetup();
      return;
    }
    if (readiness.status === 'needs-credential') {
      process.stdout.write(
        `\n${renderMissingProviderCredentialGuide(
          readiness.apiKeyEnv
            ? [readiness.apiKeyEnv]
            : credentialEnvironmentNames,
        )}\n\n`,
      );
      return;
    }
    if (readiness.status === 'invalid-config') {
      process.stderr.write(
        `${chalk.yellow(
          `KodaX cannot start first-run setup because ${readiness.configPath} is invalid: ${readiness.reason}`,
        )}\n`,
      );
      process.stderr.write(
        `${chalk.dim(
          'Repair or move that file, then run `kodax setup`. No configuration was changed.',
        )}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }
  const configWithExtensions = config as typeof config & {
    extensions?: string[];
    runtimeMode?: 'embedded' | 'daemon';
  };
  if (
    typeof opts.repoIntelligence === 'string' &&
    opts.repoIntelligence.trim()
  ) {
    process.env.KODAX_REPO_INTELLIGENCE = opts.repoIntelligence.trim();
  }
  if (opts.repoIntelligenceTrace === true) {
    process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
  }
  const reasoningMode = resolveCliReasoningMode(program, opts, config);
  const effort = resolveCliEffort(program, opts, config);
  const agentMode = resolveCliAgentMode(program, opts, config);
  const configuredExtensions = Array.isArray(configWithExtensions.extensions)
    ? configWithExtensions.extensions
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
        .map((value) =>
          path.isAbsolute(value)
            ? value
            : path.resolve(path.dirname(KODAX_CONFIG_FILE), value),
        )
    : [];
  const cliExtensions = Array.isArray(opts.extension)
    ? opts.extension
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
        .map((value) => path.resolve(value))
    : [];
  const discoveredExtensions = await discoverCliDefaultExtensions();
  const dedupedDiscoveredExtensions =
    await dedupeExtensionPathsByEntrypoint(discoveredExtensions);
  const dedupedConfiguredExtensions =
    await dedupeExtensionPathsByEntrypoint(configuredExtensions);
  const dedupedCliExtensions =
    await dedupeExtensionPathsByEntrypoint(cliExtensions);
  const configuredOnlyExtensions = await excludeExtensionPathsByEntrypoint(
    dedupedConfiguredExtensions,
    dedupedCliExtensions,
  );
  const discoveredOnlyExtensions = await excludeExtensionPathsByEntrypoint(
    dedupedDiscoveredExtensions,
    [...dedupedConfiguredExtensions, ...dedupedCliExtensions],
  );
  const activeExtensions = [
    ...discoveredOnlyExtensions,
    ...configuredOnlyExtensions,
    ...dedupedCliExtensions,
  ];
  const providerOverride = opts.provider ?? process.env.KODAX_PROVIDER;
  const selectedProvider = resolveCliProviderSelection(
    opts.provider,
    process.env.KODAX_PROVIDER,
    config.provider,
    KODAX_DEFAULT_PROVIDER,
  );
  const selectedModel = resolveCliModelSelection(
    providerOverride,
    opts.model,
    config.provider,
    config.model,
  );
  const selectedRuntimeMode = resolveCliRuntimeMode(
    opts.runtimeMode,
    process.env.KODAX_RUNTIME_MODE,
    configWithExtensions.runtimeMode,
  );
  const workerHostedEmbedded =
    selectedRuntimeMode === 'embedded'
    && config.worker?.configuredA2A === true;
  const sessionFlags = normalizeCliSessionFlags(opts);
  // -y/--auto is kept for backward compatibility but has no effect in CLI.
  const options: CliOptions = {
    // Priority: CLI args > environment > config file > defaults.
    provider: selectedProvider,
    model: selectedModel,
    effort,
    thinking: reasoningMode !== 'off',
    reasoningMode,
    agentMode,
    outputMode,
    runtimeMode: selectedRuntimeMode,
    extensions: activeExtensions,
    session: sessionFlags.session,
    maxIter: parseOptionalNonNegativeInt(opts.maxIter),
    prompt: opts.print ? [opts.print] : program.args,
    continue: opts.continue ?? false,
    resume: opts.resume,
    noSession: sessionFlags.noSession,
    print: opts.print ? true : false,
  };
  let extensionRuntime: ReturnType<typeof createExtensionRuntime> | undefined;
  let integrationHotReload: IntegrationHotReloadHandle | undefined;
  let a2aRuntimeHandle: ConfiguredA2ARuntimeHandle | undefined;
  let cliRuntime: KodaXRuntime | undefined;
  let shouldHardExitAfterInteractiveCleanup = false;
  const integrationEvents = createIntegrationEventBridge((message) =>
    console.error(chalk.dim(message)),
  );

  const getCliRuntime = async (): Promise<KodaXRuntime> => {
    if (cliRuntime !== undefined) return cliRuntime;
    const mode = options.runtimeMode ?? 'embedded';
    // `worker.configuredA2A` opts a Worker-hosted embedded Runtime into the
    // configured A2A plane: the Worker owner loads and reconciles
    // ~/.kodax/integrations/a2a.json inside the Worker, installing the full
    // list/describe/preflight and external Actor dispatch surface there.
    // Function-valued externalAgents cannot cross the Worker boundary, so the
    // inline parent-side integration is skipped in that mode.
    const a2aIntegration =
      mode === 'embedded' && !workerHostedEmbedded
        ? createConfiguredA2ARuntimeIntegration({
            configHome: KODAX_DIR,
            onEvent: integrationEvents.onEvent,
          })
        : undefined;
    cliRuntime = await createKodaXRuntime({
      mode,
      profile: 'default',
      autoStartDaemon: mode === 'daemon',
      defaultProvider: options.provider,
      ...(options.model !== undefined ? { defaultModel: options.model } : {}),
      ...(workerHostedEmbedded
        ? { isolation: 'worker', worker: { configuredA2A: true } }
        : {}),
      ...(a2aIntegration
        ? { externalAgents: a2aIntegration.runtimeOptions }
        : {}),
    });
    if (a2aIntegration)
      a2aRuntimeHandle = await a2aIntegration.start(cliRuntime);
    return cliRuntime;
  };

  try {
    const isLegacySessionManagement =
      options.session === 'list' ||
      options.session === 'delete' ||
      options.session === 'delete-all' ||
      options.session === 'cleanup-acp' ||
      options.session?.startsWith('delete ');

    if (options.outputMode === 'json' && isLegacySessionManagement) {
      validateCliModeSelection(options, {
        resumeWithoutId: opts.resume === true,
      });
    }

    // Session list: show a bounded preview; bare -r provides searchable navigation.
    if (options.session === 'list') {
      const sessions = await loadResumableSessions();
      const visible = sessions.slice(0, 50);
      const lines = visible.map((session) => {
        const surface = session.surface ? ` ${session.surface}` : '';
        return `  ${session.id} [${session.msgCount}]${surface} ${session.title}`;
      });
      if (sessions.length > visible.length) {
        lines.push(
          `  ... ${sessions.length - visible.length} more; use \`kodax -r\` to search and page.`,
        );
      }
      console.log(
        lines.length > 0
          ? `Sessions:\n${lines.join('\n')}`
          : 'No resumable sessions.',
      );
      return;
    }

    if (options.session === 'cleanup-acp') {
      const storage = new FileSessionStorage({ cwd: process.cwd() });
      const candidates = await findAcpPollutionCandidates(storage);
      console.log(
        `Matched ${candidates.length} empty ACP placeholder sessions in the current project.`,
      );
      for (const candidate of candidates.slice(0, 10)) {
        console.log(
          `  ${candidate.id}${candidate.createdAt ? ` ${candidate.createdAt}` : ''}`,
        );
      }
      if (candidates.length > 10)
        console.log(`  ... ${candidates.length - 10} more`);
      if (opts.applySessionCleanup !== true) {
        console.log(
          'Preview only. Re-run with --apply-session-cleanup to archive these sessions reversibly.',
        );
        return;
      }
      const archived = await archiveAcpPollutionCandidates(storage, candidates);
      console.log(
        `Archived ${archived.length} sessions. Use the session SDK unarchive operation to restore one.`,
      );
      return;
    }

    if (options.session === 'delete-all') {
      const storage = new FileSessionStorage();
      await storage.deleteAll();
      console.log('Deleted all sessions.');
      return;
    }

    const sessionOperation = options.session;
    if (
      sessionOperation === 'delete' ||
      sessionOperation?.startsWith('delete ')
    ) {
      const quotedId = sessionOperation.startsWith('delete ')
        ? sessionOperation.slice('delete '.length).trim()
        : undefined;
      const positionalId =
        sessionOperation === 'delete' ? options.prompt[0]?.trim() : undefined;
      const sessionId = quotedId || positionalId;
      if (!sessionId) {
        throw new Error(
          '`-s delete` requires a session id. Usage: kodax -s delete <id>',
        );
      }
      if (sessionOperation === 'delete' && options.prompt.length > 1) {
        throw new Error('`-s delete` accepts exactly one session id.');
      }
      const storage = new FileSessionStorage();
      await storage.delete(sessionId);
      console.log(`Deleted session: ${sessionId}`);
      return;
    }

    let userPrompt = options.prompt.join(' ');

    // -h / --help [topic]: show basic help or a detailed help topic
    if (opts.help !== undefined) {
      if (typeof opts.help === 'string') {
        const topic = opts.help.toLowerCase();
        if (showCliHelpTopic(topic)) {
          return;
        }
        console.log(chalk.yellow(`\n[Unknown help topic: ${topic}]`));
        showCliHelpTopics();
        return;
      }
      // No topic specified: show basic help overview.
      showBasicHelp();
      return;
    }

    validateCliModeSelection(options, {
      resumeWithoutId: opts.resume === true,
    });

    if (opts.resume === true) {
      const sessions = await loadResumableSessions();
      if (sessions.length === 0) {
        console.log(
          chalk.yellow(
            'No resumable sessions found. Starting a new session...',
          ),
        );
        options.resume = undefined;
      } else {
        const selected = await runSessionPicker(sessions);
        if (!selected) {
          console.log(chalk.dim('Session resume cancelled.'));
          return;
        }
        options.resume = selected.id;
      }
    } else if (typeof opts.resume === 'string') {
      if (!await new FileSessionStorage().has(opts.resume)) {
        const titleMatches = findSessionTitleMatches(
          await loadResumableSessions(),
          opts.resume,
        );
        if (titleMatches.length === 1) {
          options.resume = titleMatches[0]!.id;
        } else if (titleMatches.length > 1) {
          if (options.outputMode === 'json') {
            throw new Error(
              `Multiple sessions have the title "${opts.resume}". Use an exact session ID with --mode json.`,
            );
          }
          console.log(
            chalk.yellow(
              `Multiple sessions have the title "${opts.resume}". Choose the intended session:`,
            ),
          );
          const selected = await runSessionPicker(titleMatches);
          if (!selected) {
            console.log(chalk.dim('Session resume cancelled.'));
            return;
          }
          options.resume = selected.id;
        }
      }
    }

    if (selectedRuntimeMode === 'daemon' && dedupedCliExtensions.length > 0) {
      throw new Error(
        'CLI --extension paths cannot cross the daemon process boundary. ' +
          'Add the extension to the daemon profile config or use --runtime-mode embedded.',
      );
    }
    if (
      workerHostedEmbedded
      && (
        activeExtensions.length > 0
        || Object.keys(configWithExtensions.mcpServers ?? {}).length > 0
      )
    ) {
      throw new Error(
        'worker.configuredA2A cannot preserve configured MCP servers or Extensions ' +
          'across the Runtime Worker boundary. Remove worker.configuredA2A to use ' +
          'the default inline Runtime, which already loads the configured A2A plane.',
      );
    }
    if (selectedRuntimeMode !== 'daemon' && !workerHostedEmbedded) {
      extensionRuntime = createExtensionRuntime({ config });
      // FEATURE_222 — expose the workspace as MCP roots, and (interactive mode)
      // serve elicitation through the REPL's live ask-user dialogs. In print /
      // non-interactive mode no interaction surface registers, so elicitation
      // requests safely decline.
      await registerConfiguredMcpCapabilityProvider(
        extensionRuntime,
        configWithExtensions.mcpServers,
        {
          reverse: buildMcpReverseCapabilities({
            cwd: process.cwd(),
            enableElicitation: true,
          }),
        },
      );
      const extensionLoader = extensionRuntime as typeof extensionRuntime & {
        loadExtensions: (
          paths: string[],
          options?: {
            continueOnError?: boolean;
            loadSource?: 'discovery' | 'config' | 'cli' | 'api';
          },
        ) => Promise<void>;
      };
      await extensionLoader.loadExtensions(discoveredOnlyExtensions, {
        continueOnError: true,
        loadSource: 'discovery',
      });
      await extensionLoader.loadExtensions(configuredOnlyExtensions, {
        continueOnError: true,
        loadSource: 'config',
      });
      await extensionLoader.loadExtensions(dedupedCliExtensions, {
        continueOnError: true,
        loadSource: 'cli',
      });
      options.extensionRuntime = extensionRuntime;
      extensionRuntime.activate();
      integrationHotReload = await startIntegrationHotReload({
        runtime: extensionRuntime,
        mcpOptions: {
          reverse: buildMcpReverseCapabilities({
            cwd: process.cwd(),
            enableElicitation: true,
          }),
        },
        onEvent: integrationEvents.onEvent,
      });
    }

    // Command dispatch for /command-style invocations.
    if (userPrompt.startsWith('/')) {
      const parsed = parseCommandCall(userPrompt);
      if (parsed) {
        const [commandName, args] = parsed;
        const commands = await loadCommands();
        if (commands.has(commandName)) {
          const kodaXOptions = createKodaXOptions(options, false);
          const commandPrompt = await processCommandCall(
            commandName,
            args,
            commands,
            async (prompt: string) =>
              runCliTaskWithRuntime(
                await getCliRuntime(),
                {
                  ...kodaXOptions,
                  context: {
                    ...kodaXOptions.context,
                    taskSurface: 'cli',
                  },
                },
                prompt,
              ),
          );
          if (commandPrompt) {
            const result = await runCliTaskWithRuntime(
              await getCliRuntime(),
              {
                ...kodaXOptions,
                context: {
                  ...kodaXOptions.context,
                  taskSurface: 'cli',
                },
              },
              commandPrompt,
            );
            emitJsonRunResultIfNeeded(options.outputMode, result);
            return;
          }
        }
      }
    }
    // No prompt and not in print mode: enter interactive mode
    if (!userPrompt && !options.print) {
      const kodaXOptions = createKodaXOptions(options, false);
      const interactiveSurface = resolveInteractiveSurfacePreference();
      const useClassicInteractiveMode = interactiveSurface === 'classic';
      // Pass FileSessionStorage for persisted sessions.
      try {
        if (useClassicInteractiveMode) {
          console.error(
            chalk.dim(
              '\n[Terminal compatibility] Using classic REPL because this terminal host cannot safely run the fullscreen TUI.',
            ),
          );
          console.error(
            chalk.dim(
              'Set KODAX_FORCE_INK=1 or KODAX_TUI_RENDERER=owned to override, or KODAX_FORCE_CLASSIC_REPL=1 to keep this mode everywhere.\n',
            ),
          );
        }

        const runtimeProfile = 'default';
        const interactiveRuntime = await getCliRuntime();
        const runtimeAutoModeControl =
          createReplRuntimeAutoModeControl(interactiveRuntime);
        const runtimeRunner = createInteractiveRuntimeRunner(
          interactiveRuntime,
          runtimeAutoModeControl,
        );

        const interactiveOptions = {
          provider: kodaXOptions.provider,
          model: kodaXOptions.model,
          effort: kodaXOptions.effort,
          thinking: kodaXOptions.thinking,
          reasoningMode: kodaXOptions.reasoningMode,
          agentMode: kodaXOptions.agentMode,
          maxIter: kodaXOptions.maxIter,
          sandbox: kodaXOptions.sandbox,
          extensionRuntime: kodaXOptions.extensionRuntime,
          session: kodaXOptions.session,
          storage: new FileSessionStorage({ cwd: process.cwd() }),
          runtimeRunner,
          runtimeAutoModeControl,
          getRuntimeStatus: () =>
            getInteractiveRuntimeStatus({
              runtime: interactiveRuntime,
              configHome: KODAX_DIR,
              profile: runtimeProfile,
            }),
          validateSetupA2AConfig: parseA2AIntegrationDocument,
          prepareSetupSandbox: prepareSetupSandboxReport,
          inspectSandbox: inspectSandboxReport,
          learning: createReplLearningBinding(interactiveRuntime),
          subscribeTransientNotices: integrationEvents.subscribe,
          hardExitOnClose: false,
        };

        // F1 — first launch with no config.json: drop a commented config.example.jsonc
        // reference next to it and point the user at it (one time only).
        const exampleConfigPaths = ensureExampleConfigFiles();
        if (exampleConfigPaths.length > 0) {
          console.error(
            chalk.dim(
              `\n[Configuration] Wrote missing annotated examples:\n` +
                `${exampleConfigPaths.map((file) => `  ${file}`).join('\n')}\n` +
                `Core settings belong in config.json; integrations belong in integrations/*.json.\n`,
            ),
          );
        }

        if (useClassicInteractiveMode) {
          await runInteractiveMode(interactiveOptions);
        } else {
          await runInkInteractiveMode(interactiveOptions);
        }
        shouldHardExitAfterInteractiveCleanup = true;
      } catch (error) {
        if (error instanceof KodaXTerminalError) {
          console.error(chalk.red(`\n[Error] ${error.message}`));
          console.error(
            chalk.dim(
              '\nYour terminal environment does not support interactive mode.',
            ),
          );
          console.error(chalk.dim('\nPlease use CLI mode instead:'));
          for (const suggestion of error.suggestions) {
            console.error(chalk.cyan(`  ${suggestion}`));
          }
          console.error();
          process.exitCode = 1;
        } else {
          throw error;
        }
      }
      return;
    }

    // No prompt + --print: show basic help and exit.
    if (!userPrompt && options.print) {
      showBasicHelp();
      return;
    }

    // Run a single managed task through the selected Runtime and exit.
    const kodaXOptions = createKodaXOptions(options, options.print ?? false);
    const cliOptions: KodaXOptions = {
      ...kodaXOptions,
      context: {
        ...kodaXOptions.context,
        taskSurface: 'cli',
      },
    };
    const prepared = await prepareCliSkillInvocation(
      userPrompt,
      cliOptions,
      (message) => console.error(chalk.dim(message)),
    );
    if (prepared?.mode === 'manual' || (prepared && (!prepared.prompt || !prepared.options))) {
      if (prepared.manualOutput) console.error(prepared.manualOutput);
      await prepared.finalize();
      return;
    }

    try {
      const result = await runCliTaskWithRuntime(
        await getCliRuntime(),
        prepared?.mode === 'fork'
          ? { ...prepared.options!, session: undefined }
          : prepared?.options ?? cliOptions,
        prepared?.prompt ?? userPrompt,
      );
      emitJsonRunResultIfNeeded(options.outputMode, result);
      await prepared?.finalize();
    } catch (error) {
      await prepared?.finalize(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  } finally {
    if (shouldHardExitAfterInteractiveCleanup) {
      const runtime = cliRuntime;
      const hotReload = integrationHotReload;
      const extensions = extensionRuntime;
      const a2a = a2aRuntimeHandle;
      cliRuntime = undefined;
      integrationHotReload = undefined;
      extensionRuntime = undefined;
      a2aRuntimeHandle = undefined;
      await cleanupInteractiveProcessResources({
        closeA2A: () => a2a?.close(),
        closeRuntime: async () => runtime?.close(),
        closeHotReload: () => hotReload?.close(),
        disposeExtensions: async () => extensions?.dispose(),
      });
    } else {
      // Non-interactive callers own their process and receive cleanup errors.
      await awaitLatestCodingMemoryReviewDrain(15_000);
      let runtimeCloseError: unknown;
      a2aRuntimeHandle?.close();
      a2aRuntimeHandle = undefined;
      try {
        await cliRuntime?.close();
      } catch (error: unknown) {
        runtimeCloseError = error;
      }
      cliRuntime = undefined;
      integrationHotReload?.close();
      integrationHotReload = undefined;
      await extensionRuntime?.dispose();
      extensionRuntime = undefined;
      await shutdownDefaultLspService();
      await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });
      await shutdownTracing();
      if (runtimeCloseError !== undefined) throw runtimeCloseError;
    }
    if (
      shouldHardExitAfterInteractiveCleanup &&
      process.env.VITEST !== 'true'
    ) {
      process.exit(process.exitCode ?? 0);
    }
  }
}

/**
 * Entry Point Detection
 *
 * Determines if this module is being run as the main entry point.
 * This is necessary because:
 * 1. When run directly (e.g., `node dist/kodax_cli.js`), we should execute main()
 * 2. When imported for testing, we should NOT execute main()
 * 3. When imported by the lightweight bootstrap, we should NOT execute main()
 * 4. In a Bun standalone bundle, only the bootstrap owns process startup
 *
 * Detection logic:
 * - Direct execution: import.meta.url === pathToFileURL(process.argv[1]).href
 * Global/npm-link execution is owned by scripts/kodax-bin.cjs, which imports
 * the bootstrap and calls main() explicitly after optional resume routing.
 */
const scriptPath = process.argv[1];
const metaUrl = import.meta.url;
const scriptUrl = scriptPath ? pathToFileURL(scriptPath).href : '';

// Only direct execution owns automatic startup. Importers call main() explicitly.
export function shouldAutoStartCli(
  moduleUrl: string,
  entryUrl: string,
  bundled: boolean,
): boolean {
  return !bundled && moduleUrl === entryUrl;
}

const isMainModule = scriptPath && shouldAutoStartCli(
  metaUrl,
  scriptUrl,
  process.env.KODAX_BUNDLED === 'true',
);

if (isMainModule) {
  main().catch((e) => {
    console.error(chalk.red(`[Error] ${e.message}`));
    process.exit(1);
  });
}

// Export for testing
export { main };
