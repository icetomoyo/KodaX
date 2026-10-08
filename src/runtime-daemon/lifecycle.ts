import { readFileSync } from 'node:fs';
import type { RuntimeDaemonClientTransport } from './client.js';
import {
  claimRuntimeDaemonOwnership,
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonState,
  readRuntimeDaemonToken,
  type RuntimeDaemonHealthObservation,
  type RuntimeDaemonLockOwner,
  type RuntimeDaemonOwnershipDecision,
  type RuntimeDaemonPaths,
  type RuntimeDaemonState,
} from './state.js';
import {
  createRuntimeDaemonSocketClientTransport,
  isRuntimeDaemonTransportError,
  type RuntimeDaemonEndpoint,
} from './transport.js';

export interface RuntimeDaemonHealthCheckOptions {
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly createTransport?: (
    endpoint: RuntimeDaemonEndpoint,
  ) => Promise<RuntimeDaemonClientTransport>;
}

export async function observeRuntimeDaemonHealth(
  paths: RuntimeDaemonPaths,
  options: RuntimeDaemonHealthCheckOptions = {},
): Promise<RuntimeDaemonHealthObservation> {
  const state = readRuntimeDaemonState(paths);
  if (!state) {
    return {
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
    };
  }

  const lockOwner = readRuntimeDaemonLockOwner(paths.lockFile);
  const pidAlive = (options.isPidAlive ?? isRuntimeDaemonPidAlive)(state.pid);
  const endpoint = runtimeDaemonEndpointFromState(state);
  const token = readRuntimeDaemonToken(paths);
  let transport: RuntimeDaemonClientTransport | undefined;
  try {
    transport = await (
      options.createTransport
        ? options.createTransport(endpoint)
        : createRuntimeDaemonSocketClientTransport(endpoint, {
            connectTimeoutMs: options.connectTimeoutMs ?? 1_000,
          })
    );
    const request = transport.request('initialize', {
      profile: state.profile,
      connectionPurpose: 'probe',
      ...(token !== undefined ? { token } : {}),
    });
    request.catch(() => undefined);
    const initialized = await withTimeout(
      request,
      options.handshakeTimeoutMs ?? 1_000,
      'Timed out waiting for runtime daemon handshake.',
    );
    return {
      state,
      initialization: initialized,
      pidAlive,
      endpointReachable: true,
      identityMatches: daemonIdentityMatchesState(initialized, state)
        && runtimeDaemonLockMatchesState(lockOwner, state),
      ...(lockOwner !== undefined ? { observedLockOwner: lockOwner } : {}),
    };
  } catch (error: unknown) {
    if (isRuntimeDaemonTransportError(error) && error.code === 'unauthorized') {
      return {
        state,
        pidAlive,
        endpointReachable: true,
        identityMatches: false,
        ...(lockOwner !== undefined ? { observedLockOwner: lockOwner } : {}),
      };
    }
    return {
      state,
      pidAlive,
      endpointReachable: false,
      identityMatches: false,
      ...(lockOwner !== undefined ? { observedLockOwner: lockOwner } : {}),
    };
  } finally {
    await transport?.close?.();
  }
}

export async function resolveRuntimeDaemonOwnership(
  paths: RuntimeDaemonPaths,
  owner: RuntimeDaemonLockOwner,
  options: RuntimeDaemonHealthCheckOptions = {},
): Promise<RuntimeDaemonOwnershipDecision> {
  const observation = await observeRuntimeDaemonHealth(paths, options);
  const lockOwner = observation.state ? undefined : readRuntimeDaemonLockOwner(paths.lockFile);
  const enriched = lockOwner
    ? {
        ...observation,
        observedLockOwner: lockOwner,
        lockOwnerPidAlive: (options.isPidAlive ?? isRuntimeDaemonPidAlive)(lockOwner.pid),
      }
    : observation;
  return claimRuntimeDaemonOwnership(paths, owner, enriched);
}

export function runtimeDaemonEndpointFromState(
  state: Pick<RuntimeDaemonState, 'endpoint'>,
): RuntimeDaemonEndpoint {
  return {
    kind: process.platform === 'win32' || state.endpoint.startsWith('\\\\.\\pipe\\')
      ? 'pipe'
      : 'unix',
    path: state.endpoint,
  };
}

export function isRuntimeDaemonPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'linux' && isZombiePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isNodeProcessError(error) && error.code === 'EPERM';
  }
}

// A zombie child answers kill(pid, 0) until its parent reaps it, but it can
// never serve the endpoint again; treating it as dead lets crash recovery
// claim ownership instead of refusing a "competing" owner forever.
function isZombiePid(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(') ') + 2).trimStart();
    return state.startsWith('Z');
  } catch {
    return false;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function daemonIdentityMatchesState(value: unknown, state: RuntimeDaemonState): boolean {
  const record = asRecord(value);
  const identity = asRecord(record?.identity) ?? record;
  return identity?.runtimeId === state.runtimeId
    && identity.profile === state.profile;
}

function runtimeDaemonLockMatchesState(
  lockOwner: RuntimeDaemonLockOwner | undefined,
  state: RuntimeDaemonState,
): boolean {
  return lockOwner?.runtimeId === state.runtimeId && lockOwner.pid === state.pid;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isNodeProcessError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
