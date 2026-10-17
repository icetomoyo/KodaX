import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  KodaXRuntime,
  RuntimeDaemonClientSnapshot,
  RuntimeDaemonPreflight,
} from '../sdk-runtime.js';
import { createRuntimeDaemonManagementController } from './management.js';
import { resolveRuntimeDaemonPathsFromConfigHome } from './state.js';

const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('Runtime daemon orphan idle exit', () => {
  it('rejects an in-flight Session load before repeatedly scanning preflight state', async () => {
    const preflight = vi.fn(() => idlePreflight());
    let release!: () => void;
    const loading = new Promise<void>((resolve) => { release = resolve; });
    const controller = createController({ orphanExitMs: 10, preflight, requestStop: vi.fn() });
    const mutation = controller.runMutation('session.load', () => loading);
    try {
      await expect(controller.preflight()).rejects.toMatchObject({
        code: 'conflict', message: expect.stringContaining('session.load'),
      });
      expect(preflight).not.toHaveBeenCalled();
      release();
      await mutation;
      await expect(controller.preflight()).resolves.toMatchObject({ canStop: true });
      expect(preflight).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await mutation;
      controller.close();
    }
  });

  it('stops retrying snapshots when a managed mutation starts during the first read', async () => {
    let release!: () => void;
    const reloading = new Promise<void>((resolve) => { release = resolve; });
    let mutation: Promise<void> | undefined;
    let controller!: ReturnType<typeof createController>;
    const preflight = vi.fn(() => {
      mutation ??= controller.runMutation('extension.reload', () => reloading);
      return idlePreflight();
    });
    controller = createController({ orphanExitMs: 10, preflight, requestStop: vi.fn() });
    try {
      await expect(controller.preflight()).rejects.toMatchObject({
        code: 'conflict', message: expect.stringContaining('extension.reload'),
      });
      expect(preflight).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await mutation;
      controller.close();
    }
  });

  it('does not scan historical preflight state between startup admission and the first real client', async () => {
    vi.useFakeTimers();
    const preflight = vi.fn(() => idlePreflight());
    const requestStop = vi.fn();
    const controller = createController({ orphanExitMs: 30_000, preflight, requestStop });
    try {
      controller.armOrphanExitAfterReady();
      controller.attachClient(client('startup'), { persistent: false, startup: true });
      controller.detachClient('startup');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(preflight).not.toHaveBeenCalled();
      controller.attachClient(client('cli'));
      controller.detachClient('cli');
      await vi.advanceTimersByTimeAsync(0);
      expect(preflight).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(requestStop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(requestStop).toHaveBeenCalledTimes(1);
    } finally { controller.close(); vi.useRealTimers(); }
  });

  it('stops only after the final logical client disconnects', async () => {
    let stopRequests = 0;
    const controller = createController({
      orphanExitMs: 10,
      preflight: () => idlePreflight(),
      requestStop: () => {
        stopRequests += 1;
      },
    });

    controller.attachClient(client('space'));
    controller.attachClient(client('other-client'));
    controller.detachClient('space');
    await delay(30);
    expect(stopRequests).toBe(0);
    await expect(controller.preflight()).resolves.toMatchObject({
      clientCount: 1,
      clients: [{ daemonConnectionId: 'other-client' }],
    });

    controller.detachClient('other-client');
    await waitUntil(() => stopRequests === 1);
    controller.close();
  });

  it('waits for governed work to become idle after an orphaned client disconnects', async () => {
    let active = true;
    let stopRequests = 0;
    const controller = createController({
      orphanExitMs: 10,
      preflight: () =>
        active
          ? {
              ...idlePreflight(),
              activeRuns: [{ runId: 'active', sessionId: 'session', phase: 'running', startedAt: new Date(0).toISOString(), provider: 'test' }],
              blockers: ['active_runs'],
              canStop: false,
            }
          : idlePreflight(),
      requestStop: () => {
        stopRequests += 1;
      },
    });

    controller.attachClient(client('space'));
    controller.detachClient('space');
    await delay(35);
    expect(stopRequests).toBe(0);

    active = false;
    await waitUntil(() => stopRequests === 1);
    controller.close();
  });

  it('keeps a serving A2A Host alive without scanning idle preflight state', async () => {
    vi.useFakeTimers();
    const preflight = vi.fn(() => idlePreflight());
    const requestStop = vi.fn();
    const controller = createController({ orphanExitMs: 30_000, preflight, requestStop, keepAlive: () => true });
    try {
      controller.armOrphanExitAfterReady();
      controller.attachClient(client('cli'));
      controller.detachClient('cli');
      await vi.advanceTimersByTimeAsync(90_000);
      expect(requestStop).not.toHaveBeenCalled();
      expect(preflight).not.toHaveBeenCalled();
    } finally { controller.close(); vi.useRealTimers(); }
  });

  it.each(['active_runs', 'background_work'] as const)('gives completed %s a full idle grace before exiting', async (blocker) => {
    vi.useFakeTimers();
    let active = true;
    const requestStop = vi.fn();
    const controller = createController({
      orphanExitMs: 30_000,
      preflight: () => ({ ...idlePreflight(),
        canStop: blocker === 'background_work' || !active,
        blockers: active && blocker === 'active_runs' ? ['active_runs'] : [],
        pendingBackgroundWork: active && blocker === 'background_work' ? 1 : 0,
      }),
      requestStop,
    });
    try {
      controller.attachClient(client('cli'));
      controller.detachClient('cli');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(requestStop).not.toHaveBeenCalled();
      active = false;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(requestStop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(requestStop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(requestStop).toHaveBeenCalledTimes(1);
    } finally { controller.close(); vi.useRealTimers(); }
  });

  it('preserves background work that starts during the final idle-exit preflight', async () => {
    vi.useFakeTimers();
    let checks = 0;
    const requestStop = vi.fn();
    const controller = createController({ orphanExitMs: 30_000, requestStop,
      preflight: () => ({ ...idlePreflight(), pendingBackgroundWork: ++checks >= 2 ? 1 : 0 }),
    });
    try {
      controller.armOrphanExitAfterReady();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(requestStop).not.toHaveBeenCalled();
      expect(() => controller.attachClient(client('replacement'))).not.toThrow();
    } finally { controller.close(); vi.useRealTimers(); }
  });

  it('allows explicit shutdown to cancel and settle optional background work', async () => {
    const requestStop = vi.fn();
    const controller = createController({ orphanExitMs: 30_000, requestStop,
      preflight: () => ({ ...idlePreflight(), pendingBackgroundWork: 1 }),
    });
    try {
      await expect(controller.stop()).resolves.toEqual({ ok: true });
      expect(requestStop).toHaveBeenCalledTimes(1);
    } finally { controller.close(); }
  });

  it('cancels an armed orphan exit when another client attaches during the grace period', async () => {
    let stopRequests = 0;
    const controller = createController({
      orphanExitMs: 20,
      preflight: () => idlePreflight(),
      requestStop: () => {
        stopRequests += 1;
      },
    });

    controller.attachClient(client('space'));
    controller.detachClient('space');
    await delay(5);
    controller.attachClient(client('replacement-client'));
    await delay(30);
    expect(stopRequests).toBe(0);

    controller.detachClient('replacement-client');
    await waitUntil(() => stopRequests === 1);
    controller.close();
  });

  it('gives the latest detach a full grace when attach and detach happen during preflight', async () => {
    let stopRequests = 0;
    let resolvePreflight!: (value: RuntimeDaemonPreflight) => void;
    const preflight = new Promise<RuntimeDaemonPreflight>((resolve) => {
      resolvePreflight = resolve;
    });
    const controller = createController({
      orphanExitMs: 30,
      preflight: () => preflight,
      requestStop: () => {
        stopRequests += 1;
      },
    });

    controller.attachClient(client('space'));
    controller.detachClient('space');
    await delay(35);
    controller.attachClient(client('replacement-client'));
    controller.detachClient('replacement-client');
    resolvePreflight(idlePreflight());
    await delay(10);
    expect(stopRequests).toBe(0);
    await waitUntil(() => stopRequests === 1);
    controller.close();
  });

  it('arms bootstrap orphan exit once an opt-in host becomes ready without a client', async () => {
    let stopRequests = 0;
    const controller = createController({
      orphanExitMs: 5,
      preflight: () => idlePreflight(),
      requestStop: () => {
        stopRequests += 1;
      },
    });

    controller.armOrphanExitAfterReady();
    await waitUntil(() => stopRequests === 1);
    controller.close();
  });

  it('does not arm orphan exit before a real logical client has connected', async () => {
    let stopRequests = 0;
    const controller = createController({
      orphanExitMs: 5,
      preflight: () => idlePreflight(),
      requestStop: () => {
        stopRequests += 1;
      },
    });

    await delay(25);
    expect(stopRequests).toBe(0);
    controller.close();
  });
});

function createController(input: {
  readonly orphanExitMs: number;
  readonly preflight: () => RuntimeDaemonPreflight | Promise<RuntimeDaemonPreflight>;
  readonly requestStop: () => void;
  readonly keepAlive?: () => boolean;
}) {
  const configHome = mkdtempSync(path.join(os.tmpdir(), 'kodax-orphan-exit-'));
  temporaryHomes.push(configHome);
  return createRuntimeDaemonManagementController({
    runtime: {
      identity: {
        runtimeId: 'rt_orphan_exit',
        mode: 'daemon',
        isolation: 'process',
        profile: 'coder',
        startedAt: new Date(0).toISOString(),
        version: 'test',
      },
      events: {
        subscribe() {
          return { close() {} };
        },
      },
      status: {
        async preflight() {
          return input.preflight();
        },
      },
    } as unknown as KodaXRuntime,
    paths: resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder'),
    requestStop: input.requestStop,
    orphanExitMs: input.orphanExitMs,
    keepAlive: input.keepAlive,
  });
}

function idlePreflight(): RuntimeDaemonPreflight {
  return {
    runtimeId: 'rt_orphan_exit',
    clientCount: 0,
    activeRuns: [],
    queuedRuns: [],
    activeWorkflows: [],
    activeAgentTurns: [],
    activeAgentTasks: [],
    pendingPermissions: [],
    pendingUserInputs: [],
    blockers: [],
    canStop: true,
  };
}

function client(daemonConnectionId: string): RuntimeDaemonClientSnapshot {
  return {
    daemonConnectionId,
    principalId: daemonConnectionId,
    name: daemonConnectionId,
    clientType: 'unknown',
    connectedAt: new Date(0).toISOString(),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for orphan exit.');
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
