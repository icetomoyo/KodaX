import { createHostOwnedExtensionRuntime } from "../host-integrations.js";
import { reportDaemonStartupPhase } from '../runtime-daemon/startup-progress.js';
import chalk from 'chalk';
import path from 'path';
import { createKodaXHostRuntime, type KodaXRuntime } from '../sdk-runtime.js';
import { isRuntimeDaemonPidAlive, observeRuntimeDaemonHealth } from '../runtime-daemon/lifecycle.js';
import {
  appendRuntimeDaemonLog,
  isSameRuntimeDaemonPath,
  mirrorRuntimeDaemonLog,
  resolveRuntimeDaemonPathsFromConfigHome,
  writeRuntimeDaemonShutdownOutcome,
} from '../runtime-daemon/state.js';
import { acquireRuntimeDaemonLease } from '../runtime-daemon/manager.js';
import { captureRuntimeDaemonStartupHandoff } from '../runtime-daemon/startup-handoff.js';
import {
  consumeRuntimeDaemonOwnerBootstrap,
  detachRuntimeDaemonBootstrapOutput,
  RUNTIME_DAEMON_BOOTSTRAP_LOG_MAX_BYTES,
} from '../runtime-daemon/process.js';
import { createExtensionRuntime } from '@kodax-ai/coding';
import { emitKodaXDiagnostic, tryAcquireStorageFileLock } from '@kodax-ai/agent';
import { prepareRuntimeConfig, IntegrationConfigController } from '@kodax-ai/repl';
import { type IntegrationHotReloadHandle } from '../integration-hot-reload.js';
import {
  createConfiguredA2ARuntimeIntegration,
  type ConfiguredA2ARuntimeHandle,
} from '../a2a/runtime-config.js';
import {
  classifyA2AServerChange,
  type A2AIntegrationDocument,
  parseA2AIntegrationDocument,
  readA2AIntegration,
} from '../a2a/config.js';
import {
  createA2AServerHotOptions,
  createA2AServerOptionsFromConfig,
} from '../a2a/product.js';
import type { prepareKodaXA2AServer } from '../a2a/server.js';
import { loadA2AServer } from '../cli-lazy-components.js';
import { delay, normalizeCliError } from './util.js';
import { cleanupDaemonServeProcessResources } from './process-cleanup.js';

export async function serveDaemonCommand(input: {
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
  const commitStartup = captureRuntimeDaemonStartupHandoff();
  const daemonPaths = resolveRuntimeDaemonPathsFromConfigHome(
    daemonConfigHome,
    input.profile,
  );
  const ownerBootstrap = process.env.KODAX_DAEMON_SERVE === '1'
    ? consumeRuntimeDaemonOwnerBootstrap({
        configHome: daemonConfigHome,
        profile: input.profile,
        environment: process.env,
      })
    : undefined;
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
  // Run by an operator rather than the SDK, stdout is the service log a container or service manager collects.
  const stopLogMirror = process.env.KODAX_DAEMON_SERVE === '1'
    ? undefined
    : mirrorRuntimeDaemonLog(daemonPaths, process.stdout);
  reportDaemonStartupPhase('extensions');
  const extensions = await createDaemonOwnedExtensionRuntime(daemonConfigHome);
  const a2aIntegration = createConfiguredA2ARuntimeIntegration({
    configHome: daemonConfigHome,
    onEvent: (message) => console.error(chalk.dim(`[integrations] ${message}`)),
  });
  let ownedRuntime: KodaXRuntime | undefined;
  let a2aHandle: ConfiguredA2ARuntimeHandle | undefined;
  let hostedA2AServer: Awaited<ReturnType<typeof prepareKodaXA2AServer>> | undefined;
  let hostedA2AConfigController: IntegrationConfigController<A2AIntegrationDocument> | undefined;
  // Shared teardown for the hosted A2A serving pair; watcher close is best
  // effort so a failing close cannot skip the server and outbound cleanup.
  const closeHostedA2AServing = async (): Promise<void> => {
    try {
      hostedA2AConfigController?.close();
    } catch {
      // Watcher teardown is best effort before process-level cleanup.
    }
    hostedA2AConfigController = undefined;
    await hostedA2AServer?.close().catch(() => undefined);
    hostedA2AServer = undefined;
    a2aHandle?.close();
    a2aHandle = undefined;
  };
  let completedNormally = false;
  let ownedRuntimeId: string | undefined;
  let primaryError: Error | undefined;
  try {
    const lease = await acquireRuntimeDaemonLease({
      profile: input.profile,
      homeDir: input.homeDir,
      configHome: daemonConfigHome,
      sessionsDir: input.sessionsDir,
      // The host is created only after createRuntime returns, so this trusted
      // fact is never observable until reconcile and watcher startup succeed.
      ownsA2AConfigReconciler: true,
      keepAlive: () => hostedA2AServer !== undefined,
      // `host.json` in the same config home may ask this Host to serve v2 over the network.
      networkConfigHome: daemonConfigHome,
      commitStartup,
      integrationStatuses: () => [
        ...extensions.hotReload.statuses(),
        ...(a2aHandle ? [a2aHandle.status()] : []),
      ],
      ...(input.orphanExitMs !== undefined ? { orphanExitMs: input.orphanExitMs } : {}),
      createRuntime: async (runtimeId, host) => {
        const usesCanonicalHome = isSameRuntimeDaemonPath(
          daemonConfigHome,
          path.join(input.homeDir, '.kodax'),
        );
        const runtime = await createKodaXHostRuntime({
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
          onStartupProgress: progress => {
            if (progress.stage === 'initializing') reportDaemonStartupPhase(progress.phase);
          },
          externalAgents: a2aIntegration.runtimeOptions,
          execPolicy: ownerBootstrap?.execPolicy,
          autoReview: ownerBootstrap?.autoReview,
          ...host,
        });
        ownedRuntime = runtime;
        try {
          reportDaemonStartupPhase('a2a');
          a2aHandle = await a2aIntegration.start(runtime);
          // FEATURE_298 T21 — restricted local-Agent preparation, workspace
          // binding, and A2A serving all execute in this Host process when
          // the bootstrap config names a listen address; live config changes
          // to serving require an explicit Host restart. An invalid config
          // keeps the Host's existing degraded-domain behavior — serving
          // simply does not start.
          let serverConfig: A2AIntegrationDocument['server'];
          try {
            serverConfig = readA2AIntegration(daemonConfigHome).document.server;
          } catch {
            serverConfig = undefined;
          }
          if (serverConfig?.listen) {
            const { hostname, port } = serverConfig.listen;
            // A busy listen port fails the whole Host startup: serving was
            // explicitly enabled by bootstrap config, so silently serving
            // nowhere would hide the misconfiguration.
            const { prepareKodaXA2AServer } = await loadA2AServer();
            hostedA2AServer = await prepareKodaXA2AServer(
              createA2AServerOptionsFromConfig({
                runtime,
                config: serverConfig,
                listenBaseUrl: `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`,
              }),
              { emitDiagnostic: emitKodaXDiagnostic, acquireStorageLock: tryAcquireStorageFileLock },
            );
            commitStartup();
            const baseUrl = await hostedA2AServer.listen({
              hostname,
              port,
              ...(serverConfig.publicBaseUrl
                ? { publicBaseUrl: serverConfig.publicBaseUrl }
                : {}),
            });
            console.error(chalk.dim(`[integrations] A2A serving on ${baseUrl}`));
            // Hot fields (published/auth/limits) apply live; binding, store,
            // and listen changes stay restart-required by classification.
            let appliedServer = serverConfig;
            hostedA2AConfigController = new IntegrationConfigController({
              domain: 'a2a',
              configHome: daemonConfigHome,
              validate: parseA2AIntegrationDocument,
              read: () => readA2AIntegration(daemonConfigHome),
            });
            hostedA2AConfigController.subscribe((snapshot) => {
              const next = snapshot.document.server;
              if (!next) {
                console.error(chalk.yellow(
                  '[integrations] A2A server block removed; serving continues until Host restart.',
                ));
                return;
              }
              const change = classifyA2AServerChange(appliedServer, next);
              if (change.kind === 'restart-required') {
                console.error(chalk.yellow(
                  `[integrations] A2A config change pending Host restart: ${change.fields.join(', ')}`,
                ));
                return;
              }
              if (change.kind === 'hot' && hostedA2AServer) {
                hostedA2AServer.updateHot(
                  createA2AServerHotOptions({ config: next, listenBaseUrl: baseUrl }),
                );
                appliedServer = next;
                console.error(chalk.dim(
                  `[integrations] A2A serving hot-reloaded: ${change.fields.join(', ')}`,
                ));
              }
            });
            hostedA2AConfigController.startWatching();
          }
          reportDaemonStartupPhase('listener');
          return runtime;
        } catch (error: unknown) {
          await closeHostedA2AServing();
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
      const ownerPid = observation.state?.pid ?? 'unknown';
      if (process.env.KODAX_DAEMON_SERVE !== '1') {
        // Run by an operator (a shell, systemd, Kubernetes), a second Host on
        // one home is a misconfiguration; exit 0 would read as a finished service.
        throw new Error(
          `This home is already served by a Host (PID ${ownerPid}). `
          + 'One home can have only one Host, so this one did not start.',
        );
      }
      // An SDK auto-start child that lost the startup race must exit cleanly:
      // its spawner gives only a clean exit the grace to see the winner.
      console.log(
        chalk.yellow(
          `KodaX runtime daemon already owned by PID ${ownerPid}.`,
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
    // Taken when the stop signal arrives: past it the Host is abandoned to the
    // bounded process cleanup below, so a stuck close cannot hold the process.
    const withinHostClose = createDaemonHostCloseDeadline();
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      shutdownPromise ??= withinHostClose(lease.shutdown());
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
      try {
        await withinHostClose(closeHostedA2AServing());
      } finally {
        await shutdown();
      }
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
        void closeHostedA2AServing();
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
  stopLogMirror?.();

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

// The Host-close slice of a daemon stop; process cleanup keeps its own window
// after it. A healthy close needs far less: its longest bounded steps are the
// 10-second Run quiesce and the 30-second Agent executor drain.
const DAEMON_HOST_CLOSE_TIMEOUT_MS = 90_000;

/** Bounds every Host-close step by one deadline, taken when the first step starts. */
function createDaemonHostCloseDeadline(): <T>(step: Promise<T>) => Promise<T> {
  let deadline: number | undefined;
  return async <T>(step: Promise<T>): Promise<T> => {
    deadline ??= Date.now() + DAEMON_HOST_CLOSE_TIMEOUT_MS;
    const remainingMs = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        step,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(
            `Runtime daemon Host did not finish closing within ${DAEMON_HOST_CLOSE_TIMEOUT_MS / 1_000} seconds. `
            + 'Process cleanup continued without it.',
          )), remainingMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

async function createDaemonOwnedExtensionRuntime(configHome: string): Promise<{
  readonly runtime: ReturnType<typeof createExtensionRuntime>;
  readonly hotReload: IntegrationHotReloadHandle;
}> {
  const owned = await createHostOwnedExtensionRuntime(
    configHome,
    prepareRuntimeConfig(),
    (message) => console.error(chalk.dim(`[integrations] ${message}`)),
    progress => { if (progress.stage === 'initializing') reportDaemonStartupPhase(progress.phase); },
  );
  owned.runtime.activate();
  return owned;
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
