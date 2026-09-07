import type {
  KodaXRuntime,
  RuntimeIntegrationDomainStatus,
} from '../sdk-runtime.js';
import path from 'node:path';
import {
  emitKodaXDiagnostic,
  setKodaXDiagnosticSink,
  type KodaXDiagnostic,
} from '@kodax-ai/agent';
import {
  createRuntimeDaemonDispatcher,
  createRuntimeDaemonRunResultStore,
} from './server.js';
import {
  appendRuntimeDaemonLog,
  createRuntimeDaemonToken,
  ensureRuntimeDaemonDirectories,
  readRuntimeDaemonLog,
  readRuntimeDaemonLockOwner,
  releaseRuntimeDaemonOwnership,
  writeRuntimeDaemonToken,
  writeRuntimeDaemonState,
  type RuntimeDaemonLockHandle,
  type RuntimeDaemonPaths,
  type RuntimeDaemonState,
} from './state.js';
import {
  createRuntimeDaemonSocketServer,
  type RuntimeDaemonEndpoint,
  type RuntimeDaemonSocketServer,
} from './transport.js';
import { createRuntimeControlJournal } from './control-journal.js';
import { createRuntimeDaemonReverseBridgeHub } from './reverse-bridge.js';
import { createRuntimeDaemonManagementController } from './management.js';

export interface RuntimeDaemonHostOptions {
  readonly runtime: KodaXRuntime;
  readonly paths: RuntimeDaemonPaths;
  readonly endpoint: RuntimeDaemonEndpoint;
  readonly lock: RuntimeDaemonLockHandle;
  /** Space-managed detached daemons self-stop after their final client leaves and work is idle. */
  readonly orphanExitMs?: number;
  /** Trusted owner fact; never derived from caller-advertised capabilities. */
  readonly ownsA2AConfigReconciler?: boolean;
  readonly integrationStatuses?: () => readonly RuntimeIntegrationDomainStatus[];
}

export interface RuntimeDaemonHost {
  readonly endpoint: RuntimeDaemonEndpoint;
  readonly state: RuntimeDaemonState;
  readonly closed: Promise<void>;
  unref(): void;
  close(): Promise<void>;
}

export async function startRuntimeDaemonHost(
  options: RuntimeDaemonHostOptions,
): Promise<RuntimeDaemonHost> {
  ensureRuntimeDaemonDirectories(options.paths);
  const token = createRuntimeDaemonToken();
  writeRuntimeDaemonToken(options.paths, token);
  const starting = createHostState(options, 'starting');
  writeRuntimeDaemonState(options.paths, starting);
  appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon starting.', {
    runtimeId: options.runtime.identity.runtimeId,
    endpoint: options.endpoint.path,
  });
  const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
    appendRuntimeDiagnostic(options.paths, diagnostic);
  });

  let server: RuntimeDaemonSocketServer | undefined;
  let scheduleStop: (() => void) | undefined;
  let stopPending = false;
  const requestStop = (): void => {
    if (scheduleStop === undefined) {
      stopPending = true;
      return;
    }
    scheduleStop();
  };
  const runResults = createRuntimeDaemonRunResultStore();
  const controlJournal = createRuntimeControlJournal({
    rootDir: path.join(options.paths.rootDir, 'control'),
  });
  const reverseBridgeHub = createRuntimeDaemonReverseBridgeHub({
    invocationStateFile: path.join(options.paths.rootDir, 'host-tool-invocations.json'),
  });
  const management = createRuntimeDaemonManagementController({
    runtime: options.runtime,
    paths: options.paths,
    requestStop,
    ...(options.orphanExitMs !== undefined ? { orphanExitMs: options.orphanExitMs } : {}),
    ...(options.integrationStatuses
      ? { integrationStatuses: options.integrationStatuses }
      : {}),
  });
  let ready: RuntimeDaemonState;
  try {
    server = await createRuntimeDaemonSocketServer({
      endpoint: options.endpoint,
      createDispatcher: (notify, disconnect) => createRuntimeDaemonDispatcher({
        runtime: options.runtime,
        authToken: token,
        ...(options.ownsA2AConfigReconciler === true
          ? { ownsA2AConfigReconciler: true }
          : {}),
        ...(options.orphanExitMs !== undefined ? { orphanExitEnabled: true } : {}),
        allowAgentRegistrationAdmin: true,
        notify,
        disconnect,
        runResults,
        controlJournal,
        reverseBridgeHub,
        management,
        durableHostToolInvocations: true,
        requireOperationEnvelope: true,
        logs: () => ({
          logFile: options.paths.logFile,
          entries: readRuntimeDaemonLog(options.paths),
        }),
      }),
    });
    const internalReadyDelayMs = process.env.KODAX_INTERNAL_DAEMON_TEST_READY_DELAY_MS;
    if (internalReadyDelayMs !== undefined) {
      await delayInternalDaemonReadyForTest(internalReadyDelayMs);
    }
    ready = createHostState(options, 'ready');
    writeRuntimeDaemonState(options.paths, ready);
    // A detached daemon can outlive its launcher between ready-state
    // publication and the first SDK initialize. Arm bootstrap recovery at the
    // same synchronous boundary; a real attach cancels the timer.
    management.armOrphanExitAfterReady();
    appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon ready.', {
      runtimeId: ready.runtimeId,
      endpoint: ready.endpoint,
    });
  } catch (error: unknown) {
    appendRuntimeDaemonLog(options.paths, 'error', 'Runtime daemon failed to start.', {
      error: normalizeHostError(error).message,
    });
    let transportClosed = true;
    try {
      await server?.close();
    } catch (closeError: unknown) {
      transportClosed = false;
      appendRuntimeDaemonLog(options.paths, 'error', 'Runtime daemon transport cleanup failed.', {
        error: normalizeHostError(closeError).message,
      });
    }
    management.close();
    runResults.clear();
    reverseBridgeHub.close();
    restoreDiagnostics();
    if (transportClosed) {
      await releaseHostOwnership(options.paths, options.lock);
    } else {
      writeRuntimeDaemonState(options.paths, {
        ...starting,
        status: 'unhealthy',
        lastError: 'Runtime daemon transport cleanup failed.',
      });
    }
    throw error;
  }
  let closed = false;
  let closeAttempt: Promise<void> | undefined;
  let transportClosed = false;
  let localServicesClosed = false;
  let runtimeClosed = false;
  let ownershipReleased = false;
  let signalClosed: (() => void) | undefined;
  let signalCloseFailed: ((error: unknown) => void) | undefined;
  const closedPromise = new Promise<void>((resolve, reject) => {
    signalClosed = resolve;
    signalCloseFailed = reject;
  });
  // Preserve the rejected lifecycle for callers while preventing embedded
  // hosts that do not observe `closed` from emitting an unhandled rejection.
  void closedPromise.catch(() => undefined);
  const closeHost = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (closeAttempt) return closeAttempt;
    const attempt = (async (): Promise<void> => {
      const failures: string[] = [];
      if (!ownershipReleased) {
        try {
          writeRuntimeDaemonState(options.paths, createHostState(options, 'stopping'));
          appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon stopping.');
        } catch (error: unknown) {
          failures.push(`state transition: ${normalizeHostError(error).message}`);
        }
      }
      if (!transportClosed) {
        try {
          await server?.close();
          transportClosed = true;
        } catch (error: unknown) {
          failures.push(`transport close: ${normalizeHostError(error).message}`);
        }
      }
      if (!localServicesClosed) {
        management.close();
        reverseBridgeHub.close();
        runResults.clear();
        localServicesClosed = true;
      }
      if (!runtimeClosed) {
        try {
          // Test-only fault injection; NODE_ENV prevents an accidentally
          // inherited internal variable from hanging a production host close.
          if (
            process.env.NODE_ENV === 'test'
            && process.env.KODAX_INTERNAL_DAEMON_TEST_HOST_CLOSE_HANG === '1'
          ) {
            await new Promise<void>(() => undefined);
          }
          if (
            process.env.NODE_ENV === 'test'
            && process.env.KODAX_INTERNAL_DAEMON_TEST_HOST_CLOSE_ERROR === '1'
          ) {
            throw new Error('Injected Runtime host close failure.');
          }
          await options.runtime.close();
          runtimeClosed = true;
        } catch (error: unknown) {
          failures.push(`Runtime close: ${normalizeHostError(error).message}`);
        }
      }
      try {
        appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon host stopped.');
      } catch (error: unknown) {
        failures.push(`stop log: ${normalizeHostError(error).message}`);
      }
      restoreDiagnostics();
      if (transportClosed && runtimeClosed && !ownershipReleased) {
        const released = await releaseHostOwnership(options.paths, options.lock);
        const current = readRuntimeDaemonLockOwner(options.lock.file);
        const stillOwned = (
          current?.runtimeId === options.lock.owner.runtimeId
          && current.pid === options.lock.owner.pid
          && current.createdAt === options.lock.owner.createdAt
        );
        if (!released && stillOwned) {
          failures.push('owner release: the daemon still owns its profile lock');
        } else {
          ownershipReleased = true;
        }
      } else if (!transportClosed || !runtimeClosed) {
        try {
          writeRuntimeDaemonState(options.paths, {
            ...createHostState(options, 'unhealthy'),
            lastError: failures.join('; '),
          });
        } catch (error: unknown) {
          failures.push(`unhealthy state: ${normalizeHostError(error).message}`);
        }
      }
      if (failures.length > 0) {
        try {
          appendRuntimeDaemonLog(options.paths, 'error', 'Runtime daemon host stopped with cleanup failures.', {
            failures,
          });
        } catch (error: unknown) {
          failures.push(`failure log: ${normalizeHostError(error).message}`);
        }
        throw new Error(`Runtime daemon cleanup failed: ${failures.join('; ')}`);
      }
      closed = true;
      signalClosed?.();
    })();
    closeAttempt = attempt;
    void attempt.finally(() => {
      if (closeAttempt === attempt) closeAttempt = undefined;
      restoreDiagnostics();
    }).catch(() => undefined);
    return attempt;
  };
  scheduleStop = () => {
    try {
      appendRuntimeDaemonLog(options.paths, 'info', 'Runtime daemon stop requested.');
    } catch (error: unknown) {
      emitKodaXDiagnostic({
        source: 'runtime.daemon.host',
        level: 'warn',
        message: 'Runtime daemon stop request could not be logged.',
        detail: normalizeHostError(error),
      });
    }
    const timer = setTimeout(() => {
      void closeHost().catch((error: unknown) => {
        signalCloseFailed?.(error);
        emitKodaXDiagnostic({
          source: 'runtime.daemon.host',
          level: 'error',
          message: 'Runtime daemon shutdown failed.',
          detail: normalizeHostError(error),
        });
      });
    }, 0);
    timer.unref?.();
  };
  if (stopPending) scheduleStop();

  return {
    endpoint: options.endpoint,
    state: ready,
    closed: closedPromise,
    unref() {
      server?.unref();
    },
    close: closeHost,
  };
}

async function releaseHostOwnership(
  paths: RuntimeDaemonPaths,
  lock: RuntimeDaemonLockHandle,
): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (releaseRuntimeDaemonOwnership(paths, lock)) return true;
    } catch (error: unknown) {
      emitKodaXDiagnostic({
        source: 'runtime.daemon.host',
        level: 'warn',
        message: 'Runtime daemon ownership release attempt failed.',
        detail: normalizeHostError(error),
      });
    }
    const current = readRuntimeDaemonLockOwner(lock.file);
    if (
      current === undefined
      || current.runtimeId !== lock.owner.runtimeId
      || current.pid !== lock.owner.pid
      || current.createdAt !== lock.owner.createdAt
      || current.kind !== lock.owner.kind
    ) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  try {
    appendRuntimeDaemonLog(paths, 'error', 'Runtime daemon ownership release timed out.');
  } catch (error: unknown) {
    emitKodaXDiagnostic({
      source: 'runtime.daemon.host',
      level: 'error',
      message: 'Runtime daemon ownership release timed out and could not be logged.',
      detail: normalizeHostError(error),
    });
  }
  return false;
}

function normalizeDiagnosticDetail(detail: unknown, seen = new Set<unknown>()): unknown {
  // JSON.stringify(new Error(...)) collapses to {}; daemon.log diagnostics must
  // keep the message (and aggregate/cause chain) so cleanup failures stay
  // diagnosable as timeout vs attestation vs deletion errors. The seen-set
  // stops cyclic cause chains from overflowing the stack, which would lose the
  // whole diagnostic to the append catch handler.
  if (detail instanceof Error) {
    if (seen.has(detail)) return "[cyclic]";
    seen.add(detail);
    return {
      name: detail.name,
      message: detail.message,
      ...(detail instanceof AggregateError
        ? { errors: detail.errors.map((error) => normalizeDiagnosticDetail(error, seen)) }
        : {}),
      ...(detail.cause === undefined ? {} : { cause: normalizeDiagnosticDetail(detail.cause, seen) }),
    };
  }
  if (Array.isArray(detail)) return detail.map((entry) => normalizeDiagnosticDetail(entry, seen));
  return detail;
}
function appendRuntimeDiagnostic(paths: RuntimeDaemonPaths, diagnostic: KodaXDiagnostic): void {
  try {
    appendRuntimeDaemonLog(
      paths,
      diagnostic.level === 'error' ? 'error' : diagnostic.level === 'warn' ? 'warn' : 'info',
      `[${diagnostic.source}] ${diagnostic.message}`,
      {
        level: diagnostic.level,
        source: diagnostic.source,
        ...(diagnostic.detail !== undefined
          ? { detail: normalizeDiagnosticDetail(diagnostic.detail) }
          : {}),
      },
    );
  } catch {
    // Diagnostic sinks must never affect the daemon runtime path.
  }
}
function createHostState(
  options: RuntimeDaemonHostOptions,
  status: RuntimeDaemonState['status'],
): RuntimeDaemonState {
  return {
    runtimeId: options.runtime.identity.runtimeId,
    profile: options.paths.profile,
    pid: process.pid,
    startedAt: options.runtime.identity.startedAt,
    endpoint: options.endpoint.path,
    version: options.runtime.identity.version,
    status,
    configHome: options.paths.configHome,
  };
}

async function delayInternalDaemonReadyForTest(rawDelayMs: string | undefined): Promise<void> {
  if (rawDelayMs === undefined) return;
  const delayMs = Number(rawDelayMs);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(delayMs, 30_000));
  });
}

function normalizeHostError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
