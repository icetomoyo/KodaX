import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { isCurrentProcessWindowsJobContained } from '@kodax-ai/agent';

import type {
  KodaXRuntime,
  RuntimeIntegrationDomainStatus,
} from '../sdk-runtime.js';
import type { RuntimeDaemonClientTransport } from './client.js';
import {
  resolveRuntimeDaemonOwnership,
  runtimeDaemonEndpointFromState,
  type RuntimeDaemonHealthCheckOptions,
} from './lifecycle.js';
import { startRuntimeDaemonHost, type RuntimeDaemonHost } from './host.js';
import {
  assertRuntimeDaemonOwnerAllowed,
  readRuntimeOwnerProcessStartIdentity,
  releaseRuntimeDaemonLock,
  resolveRuntimeDaemonEndpointScope,
  resolveRuntimeDaemonPathsFromConfigHome,
  type RuntimeDaemonPaths,
} from './state.js';
import {
  createRuntimeDaemonSocketClientTransport,
  defaultRuntimeDaemonEndpoint,
  type RuntimeDaemonEndpoint,
} from './transport.js';

export interface RuntimeDaemonLeaseOptions {
  readonly homeDir?: string;
  readonly configHome?: string;
  readonly profile?: string;
  readonly endpoint?: RuntimeDaemonEndpoint;
  readonly connectTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly healthCheck?: RuntimeDaemonHealthCheckOptions;
  readonly orphanExitMs?: number;
  /** True only when this host owns the live A2A config reconciler. */
  readonly ownsA2AConfigReconciler?: boolean;
  readonly integrationStatuses?: () => readonly RuntimeIntegrationDomainStatus[];
  /** @internal Commit shared ownership before the daemon endpoint is published. */
  readonly commitStartup?: () => void;
  createRuntime(runtimeId: string): Promise<KodaXRuntime>;
}

export interface RuntimeDaemonLease {
  readonly transport: RuntimeDaemonClientTransport;
  readonly endpoint: RuntimeDaemonEndpoint;
  readonly paths: RuntimeDaemonPaths;
  readonly ownsHost: boolean;
  readonly hostClosed?: Promise<void>;
  close(): Promise<void>;
  shutdown(): Promise<void>;
}

export async function acquireRuntimeDaemonLease(
  options: RuntimeDaemonLeaseOptions,
): Promise<RuntimeDaemonLease> {
  if (
    options.orphanExitMs !== undefined
    && (!Number.isSafeInteger(options.orphanExitMs) || options.orphanExitMs <= 0)
  ) {
    throw new Error('orphanExitMs must be a positive safe integer.');
  }
  const profile = options.profile ?? 'default';
  const homeDir = resolveRuntimeDaemonHomeDir(options.homeDir);
  const configHome = path.resolve(options.configHome ?? path.join(homeDir, '.kodax'));
  const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, profile);
  assertRuntimeDaemonOwnerAllowed(paths);
  const endpoint = options.endpoint ?? defaultRuntimeDaemonEndpoint(
    profile,
    resolveRuntimeDaemonEndpointScope(homeDir, configHome),
  );
  const supervisorPid = Number.parseInt(
    process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID ?? '',
    10,
  );
  const jobContained = isCurrentProcessWindowsJobContained()
    && Number.isSafeInteger(supervisorPid)
    && supervisorPid > 0;
  const processStartIdentity = readRuntimeOwnerProcessStartIdentity(process.pid);
  const supervisorProcessStartIdentity = jobContained
    ? readRuntimeOwnerProcessStartIdentity(supervisorPid)
    : undefined;
  if (jobContained && supervisorProcessStartIdentity === undefined) {
    throw new Error(
      'Could not read the Windows Job supervisor process identity; refusing PID-only ownership.',
    );
  }
  const owner = {
    runtimeId: `rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    kind: 'daemon' as const,
    ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
    ...(jobContained ? {
      processContainment: 'windows-job' as const,
      supervisorPid,
      supervisorProcessStartIdentity: supervisorProcessStartIdentity!,
    } : {}),
  };

  const decision = await resolveRuntimeDaemonOwnership(paths, owner, options.healthCheck);
  if (decision.kind === 'attach') {
    const attachedEndpoint = runtimeDaemonEndpointFromState(decision.state);
    return createAttachedLease(paths, attachedEndpoint, options.connectTimeoutMs);
  }

  if (decision.kind === 'wait') {
    return waitForDaemonLease(paths, endpoint, owner, {
      ...options,
      profile,
    });
  }

  if (decision.kind === 'unhealthy') {
    throw new Error(`Runtime daemon is ${decision.health}; refusing to take ownership.`);
  }

  return createClaimedDaemonLease(paths, endpoint, owner, decision.lock, options);
}

function resolveRuntimeDaemonHomeDir(homeDir: string | undefined): string {
  return path.resolve(homeDir ?? os.homedir());
}

async function waitForDaemonLease(
  paths: RuntimeDaemonPaths,
  endpoint: RuntimeDaemonEndpoint,
  owner: { readonly runtimeId: string; readonly pid: number; readonly createdAt: string },
  options: RuntimeDaemonLeaseOptions & { readonly profile: string },
): Promise<RuntimeDaemonLease> {
  const deadline = Date.now() + (options.startupTimeoutMs ?? 5_000);
  while (Date.now() <= deadline) {
    const decision = await resolveRuntimeDaemonOwnership(paths, owner, options.healthCheck);
    if (decision.kind === 'attach') {
      return createAttachedLease(
        paths,
        runtimeDaemonEndpointFromState(decision.state),
        options.connectTimeoutMs,
      );
    }
    if (decision.kind === 'claim') {
      return createClaimedDaemonLease(paths, endpoint, owner, decision.lock, options);
    }
    if (decision.kind === 'unhealthy') {
      throw new Error(`Runtime daemon is ${decision.health}; refusing to take ownership.`);
    }
    await delay(options.pollIntervalMs ?? 100);
  }
  throw new Error(`Timed out waiting for runtime daemon profile "${options.profile}" to become ready.`);
}

async function createClaimedDaemonLease(
  paths: RuntimeDaemonPaths,
  endpoint: RuntimeDaemonEndpoint,
  owner: { readonly runtimeId: string },
  lock: Parameters<typeof startRuntimeDaemonHost>[0]['lock'],
  options: RuntimeDaemonLeaseOptions,
): Promise<RuntimeDaemonLease> {
  let runtime: KodaXRuntime | undefined;
  let hostStartAttempted = false;
  try {
    runtime = await options.createRuntime(owner.runtimeId);
    if (runtime.identity.runtimeId !== owner.runtimeId) {
      throw new Error('Runtime factory returned an identity that does not match its owner fence.');
    }
    hostStartAttempted = true;
    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint,
      lock,
      ...(options.commitStartup ? { commitStartup: options.commitStartup } : {}),
      ...(options.orphanExitMs !== undefined ? { orphanExitMs: options.orphanExitMs } : {}),
      ...(options.ownsA2AConfigReconciler === true
        ? { ownsA2AConfigReconciler: true }
        : {}),
      ...(options.integrationStatuses
        ? { integrationStatuses: options.integrationStatuses }
        : {}),
    });
    try {
      const transport = await createRuntimeDaemonSocketClientTransport(endpoint, {
        connectTimeoutMs: options.connectTimeoutMs,
      });
      return createOwnedLease(paths, endpoint, transport, host);
    } catch (error: unknown) {
      await host.close();
      throw error;
    }
  } catch (error: unknown) {
    if (!hostStartAttempted) releaseRuntimeDaemonLock(lock);
    await runtime?.close();
    throw error;
  }
}

async function createAttachedLease(
  paths: RuntimeDaemonPaths,
  endpoint: RuntimeDaemonEndpoint,
  connectTimeoutMs: number | undefined,
): Promise<RuntimeDaemonLease> {
  const transport = await createRuntimeDaemonSocketClientTransport(endpoint, {
    connectTimeoutMs,
  });
  let transportClosed = false;
  let closeAttempt: Promise<void> | undefined;
  let shutdownRequested = false;
  let shutdownAttempt: Promise<void> | undefined;
  const closeTransport = (): Promise<void> => {
    if (transportClosed) return Promise.resolve();
    if (closeAttempt) return closeAttempt;
    const attempt = Promise.resolve(transport.close?.()).then(() => {
      transportClosed = true;
    });
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
    ownsHost: false,
    close: closeTransport,
    shutdown() {
      if (shutdownAttempt) return shutdownAttempt;
      const attempt = (async () => {
        if (!shutdownRequested) {
          await transport.request('runtime.shutdown');
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

function createOwnedLease(
  paths: RuntimeDaemonPaths,
  endpoint: RuntimeDaemonEndpoint,
  transport: RuntimeDaemonClientTransport,
  host: RuntimeDaemonHost,
): RuntimeDaemonLease {
  host.unref();
  let transportClosed = false;
  let hostClosed = false;
  let transportCloseAttempt: Promise<void> | undefined;
  let hostCloseAttempt: Promise<void> | undefined;
  return {
    transport,
    endpoint,
    paths,
    ownsHost: true,
    hostClosed: host.closed,
    close() {
      if (transportClosed) return Promise.resolve();
      if (transportCloseAttempt) return transportCloseAttempt;
      const attempt = Promise.resolve(transport.close?.()).then(() => {
        transportClosed = true;
      });
      transportCloseAttempt = attempt;
      void attempt.finally(() => {
        if (transportCloseAttempt === attempt) {
          transportCloseAttempt = undefined;
        }
      }).catch(() => undefined);
      return attempt;
    },
    shutdown() {
      if (hostClosed) return Promise.resolve();
      if (hostCloseAttempt) return hostCloseAttempt;
      const attempt = host.close().then(() => {
        hostClosed = true;
      });
      hostCloseAttempt = attempt;
      void attempt.finally(() => {
        if (hostCloseAttempt === attempt) hostCloseAttempt = undefined;
      }).catch(() => undefined);
      return attempt;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
