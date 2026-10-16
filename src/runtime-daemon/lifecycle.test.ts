import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeDaemonClientTransport } from './client.js';
import {
  observeRuntimeDaemonHealth,
  resolveRuntimeDaemonOwnership,
  runtimeDaemonEndpointFromState,
} from './lifecycle.js';
import {
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonState,
  resolveRuntimeDaemonPaths,
  tryAcquireRuntimeDaemonLock,
  writeRuntimeDaemonState,
  writeRuntimeDaemonToken,
  type RuntimeDaemonLockOwner,
  type RuntimeDaemonState,
} from './state.js';
import { RuntimeDaemonTransportError } from './transport.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime daemon lifecycle health checks', () => {
  it('holds temporary client admission before checking a startup owner identity and always closes it', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const current = state();
    writeRuntimeDaemonState(paths, current);
    expect(tryAcquireRuntimeDaemonLock(paths, owner(current.runtimeId, current.pid))).toBeDefined();
    const calls: string[] = [];
    const observation = await observeRuntimeDaemonHealth(paths, {
      connectionPurpose: 'client',
      isPidAlive: () => {
        expect(calls).toEqual(['client:initialize']);
        calls.push('check:identity');
        return true;
      },
      createTransport: async () => ({
        async request(_method, params) {
          expect(params).toMatchObject({ connectionPurpose: 'client' });
          calls.push('client:initialize');
          return { identity: { runtimeId: current.runtimeId, profile: current.profile } };
        },
        subscribe() { return { close() {} }; },
        close() { calls.push('client:close'); },
      }),
    });
    expect(observation).toMatchObject({ pidAlive: true, endpointReachable: true, identityMatches: true });
    expect(calls).toEqual(['client:initialize', 'check:identity', 'client:close']);
  });

  it('observes a healthy daemon through initialize handshake identity', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const current = state();
    writeRuntimeDaemonState(paths, current);
    writeRuntimeDaemonToken(paths, 'token-health');
    expect(tryAcquireRuntimeDaemonLock(paths, owner(current.runtimeId, current.pid))).toBeDefined();
    let initializeParams: unknown;

    const observation = await observeRuntimeDaemonHealth(paths, {
      isPidAlive: () => true,
      createTransport: async () => fakeTransport({
        identity: {
          runtimeId: current.runtimeId,
          profile: current.profile,
        },
      }, (_method, params) => {
        initializeParams = params;
      }),
    });

    expect(observation).toMatchObject({
      state: current,
      pidAlive: true,
      endpointReachable: true,
      identityMatches: true,
    });
    expect(initializeParams).toMatchObject({
      profile: 'default',
      token: 'token-health',
    });
  });

  it('marks endpoint identity mismatch without deleting ownership', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const current = state({ runtimeId: 'runtime-expected' });
    writeRuntimeDaemonState(paths, current);

    const decision = await resolveRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      isPidAlive: () => true,
      createTransport: async () => fakeTransport({
        identity: {
          runtimeId: 'runtime-other',
          profile: current.profile,
        },
      }),
    });

    expect(decision).toMatchObject({ kind: 'unhealthy', health: 'mismatch' });
    expect(readRuntimeDaemonState(paths)).toEqual(current);
  });

  it('marks initialize token mismatch as a reachable daemon mismatch', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const current = state({ runtimeId: 'runtime-expected', pid: 7070 });
    writeRuntimeDaemonState(paths, current);
    writeRuntimeDaemonToken(paths, 'stale-token');
    expect(tryAcquireRuntimeDaemonLock(paths, owner('runtime-expected', 7070))).toBeDefined();

    const decision = await resolveRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      isPidAlive: () => true,
      createTransport: async () => fakeTransport({
        error: new RuntimeDaemonTransportError(
          'Runtime daemon initialize token is invalid.',
          'unauthorized',
        ),
      }),
    });

    expect(decision).toMatchObject({ kind: 'unhealthy', health: 'mismatch' });
    expect(readRuntimeDaemonState(paths)).toEqual(current);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-expected' });
  });

  it('claims ownership when no daemon state exists', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');

    const decision = await resolveRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      isPidAlive: () => false,
      createTransport: async () => fakeTransport({}),
    });

    expect(decision.kind).toBe('claim');
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-next' });
  });

  it('reclaims a missing-state lock when the lock owner process is gone', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    expect(tryAcquireRuntimeDaemonLock(paths, owner('runtime-stale', 9090))).toBeDefined();

    const decision = await resolveRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      isPidAlive: () => false,
      createTransport: async () => {
        throw new Error('endpoint unavailable');
      },
    });

    expect(decision.kind).toBe('claim');
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-next' });
  });

  it('cleans stale state only after pid and endpoint are both unavailable', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const current = state({ runtimeId: 'runtime-stale', pid: 9090 });
    writeRuntimeDaemonState(paths, current);
    expect(tryAcquireRuntimeDaemonLock(paths, owner('runtime-stale', 9090))).toBeDefined();

    const decision = await resolveRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      isPidAlive: () => false,
      createTransport: async () => {
        throw new Error('endpoint unavailable');
      },
    });

    expect(decision.kind).toBe('claim');
    expect(readRuntimeDaemonState(paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-next' });
  });

  it('does not claim a live pid with an unreachable endpoint', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const current = state({ runtimeId: 'runtime-live', pid: 8080 });
    writeRuntimeDaemonState(paths, current);
    expect(tryAcquireRuntimeDaemonLock(paths, owner('runtime-live', 8080))).toBeDefined();

    const decision = await resolveRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      isPidAlive: () => true,
      createTransport: async () => {
        throw new Error('endpoint unavailable');
      },
    });

    expect(decision).toMatchObject({ kind: 'unhealthy', health: 'unhealthy' });
    expect(readRuntimeDaemonState(paths)).toEqual(current);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-live' });
  });

  it('maps persisted endpoint paths back to transport endpoints', () => {
    expect(runtimeDaemonEndpointFromState({ endpoint: '\\\\.\\pipe\\kodax-runtime-default' })).toEqual({
      kind: 'pipe',
      path: '\\\\.\\pipe\\kodax-runtime-default',
    });
    expect(runtimeDaemonEndpointFromState({ endpoint: '/tmp/kodax-runtime-default.sock' })).toEqual({
      kind: process.platform === 'win32' ? 'pipe' : 'unix',
      path: '/tmp/kodax-runtime-default.sock',
    });
  });
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-lifecycle-'));
  tempRoots.push(dir);
  return dir;
}

function state(overrides: Partial<RuntimeDaemonState> = {}): RuntimeDaemonState {
  return {
    runtimeId: 'runtime-1',
    profile: 'default',
    pid: 1234,
    startedAt: '2026-07-09T00:00:00.000Z',
    endpoint: process.platform === 'win32'
      ? '\\\\.\\pipe\\kodax-runtime-default'
      : '/tmp/kodax-runtime-default.sock',
    version: '0.7.66',
    status: 'ready',
    ...overrides,
  };
}

function owner(runtimeId: string, pid = 111): RuntimeDaemonLockOwner {
  return {
    runtimeId,
    pid,
    createdAt: '2026-07-09T00:00:00.000Z',
  };
}

function fakeTransport(
  response: unknown | { readonly error: Error },
  onRequest?: (method: string, params: unknown) => void,
): RuntimeDaemonClientTransport {
  return {
    async request(method, params) {
      onRequest?.(method, params);
      if (isErrorResponse(response)) {
        throw response.error;
      }
      return response;
    },
    subscribe() {
      return { close() {} };
    },
    close() {},
  };
}

function isErrorResponse(value: unknown): value is { readonly error: Error } {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'error' in value
    && value.error instanceof Error;
}
