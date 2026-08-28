import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
              activeRuns: [{}] as RuntimeDaemonPreflight['activeRuns'],
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
