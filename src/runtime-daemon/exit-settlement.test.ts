import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  parseDarwinBootIdentity,
  parseLinuxBootIdentity,
  readPosixBootIdentity,
  readRuntimeExitSettlementIntent,
  settleRuntimeDaemonExitForTest,
  type RuntimeExitSettlementDependencies,
  type RuntimeExitSettlementInput,
  type RuntimeExitSettlementRuntime,
} from './exit-settlement.js';
import {
  commitRuntimeDaemonRollbackPolicy,
  readRuntimeDaemonLockOwner,
  readRuntimeOwnerPolicy,
  resolveRuntimeDaemonPathsFromConfigHome,
  tryAcquireRuntimeDaemonLock,
  writeRuntimeDaemonShutdownOutcome,
  writeRuntimeDaemonState,
  type RuntimeDaemonLockOwner,
} from './state.js';

const tempRoots: string[] = [];
const TEST_TRANSACTION_TIMEOUT_MS = 480_000;
const TEST_HUNG_PHASE_TIMEOUT_MS = 250;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempConfigHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-exit-settlement-'));
  tempRoots.push(root);
  return root;
}

function owner(overrides: Partial<RuntimeDaemonLockOwner> = {}): RuntimeDaemonLockOwner {
  return {
    runtimeId: 'runtime-exit-1',
    pid: 4101,
    createdAt: '2026-08-17T00:00:00.000Z',
    kind: 'daemon',
    processStartIdentity: 'process-start-4101',
    processContainment: 'windows-job',
    supervisorPid: 4102,
    ...overrides,
  };
}

function seedDaemon(configHome: string, expectedOwner = owner()): void {
  const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
  writeRuntimeDaemonState(paths, {
    runtimeId: expectedOwner.runtimeId,
    profile: 'coder',
    pid: expectedOwner.pid,
    startedAt: expectedOwner.createdAt,
    endpoint: '\\\\.\\pipe\\kodax-test',
    version: '0.7.88',
    status: 'ready',
    configHome,
  });
  expect(tryAcquireRuntimeDaemonLock(paths, expectedOwner)).toBeDefined();
}

function runtime(
  expectedOwner: RuntimeDaemonLockOwner,
  blockers: readonly string[] = [],
): RuntimeExitSettlementRuntime {
  return {
    identity: { runtimeId: expectedOwner.runtimeId, mode: 'daemon' },
    daemon: {
      inspect: vi.fn(async () => ({
        runtimeId: expectedOwner.runtimeId,
        revision: 7,
        ownerPolicy: { mode: 'daemon', revision: 0, updatedAt: new Date(0).toISOString() },
        owner: expectedOwner,
        preflight: {
          blockers,
          canStop: blockers.length === 0,
        },
      })),
      stopForInline: vi.fn(async () => ({ accepted: true as const })),
    },
    close: vi.fn(async () => undefined),
  };
}

function dependencies(
  overrides: Partial<RuntimeExitSettlementDependencies> = {},
): RuntimeExitSettlementDependencies {
  return {
    platform: 'win32',
    readWindowsBootIdentity: vi.fn(() => 'windows-boot-100'),
    readSystemBootIdentity: vi.fn(() => 'linux-boot-11111111-1111-1111-1111-111111111111'),
    isPidAlive: vi.fn(() => false),
    readProcessStartIdentity: vi.fn(() => undefined),
    waitForProcessExit: vi.fn(async () => true),
    killPidTree: vi.fn(async () => 'already-exited'),
    removeRuntimeExitIntentFile: vi.fn((intentPath) => {
      fs.rmSync(intentPath, { force: true });
    }),
    ...overrides,
  };
}

describe('runtime exit settlement', () => {
  it('parses only canonical Linux and Darwin boot identities', () => {
    expect(parseLinuxBootIdentity('11111111-1111-1111-1111-111111111111\n'))
      .toBe('linux-boot-11111111-1111-1111-1111-111111111111');
    expect(parseLinuxBootIdentity('../../not-a-boot-id')).toBeUndefined();
    expect(parseDarwinBootIdentity('{ sec = 1777777777, usec = 0 }', 0))
      .toBe('darwin-boot-1777777777');
    expect(parseDarwinBootIdentity('{ usec = 0 }', 0)).toBeUndefined();
    expect(parseDarwinBootIdentity('{ sec = 1777777777 }', 1)).toBeUndefined();
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'reads the current POSIX boot identity from the operating system',
    () => {
      expect(readPosixBootIdentity()).toMatch(
        process.platform === 'linux'
          ? /^linux-boot-[0-9a-f-]{36}$/
          : /^darwin-boot-\d+$/,
      );
    },
  );

  it('keeps caller-controlled deadlines and operation identity out of the public input', () => {
    expectTypeOf<RuntimeExitSettlementInput>().not.toHaveProperty('timeoutMs');
    expectTypeOf<RuntimeExitSettlementInput>().not.toHaveProperty('operationId');
  });

  it('treats an empty daemon profile as an already-clean no-op', async () => {
    const configHome = tempConfigHome();

    await expect(settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
    }, dependencies())).resolves.toEqual({ status: 'clean', repairs: [] });

    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('does not persist an intent or stop when daemon preflight is blocked', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const managedRuntime = runtime(expectedOwner, ['active_runs']);

    await expect(settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
    }, dependencies())).resolves.toMatchObject({
      status: 'blocked',
      reason: 'active_work',
      nextAction: 'keep-open',
    });

    expect(managedRuntime.daemon.stopForInline).not.toHaveBeenCalled();
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('does not mutate a Windows owner whose exact containment evidence is unavailable', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner({ processContainment: undefined, supervisorPid: undefined });
    seedDaemon(configHome, expectedOwner);
    const managedRuntime = runtime(expectedOwner);

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
    }, dependencies());

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'containment_unavailable',
      nextAction: 'keep-open',
    });
    expect(managedRuntime.daemon.stopForInline).not.toHaveBeenCalled();
    expect(managedRuntime.close).not.toHaveBeenCalled();
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('does not stop or signal a legacy Windows owner without process identity', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner({ processStartIdentity: undefined });
    seedDaemon(configHome, expectedOwner);
    const managedRuntime = runtime(expectedOwner);
    const killPidTree = vi.fn(async () => 'terminated' as const);

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
    }, dependencies({ killPidTree }));

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'containment_unavailable',
      nextAction: 'keep-open',
    });
    expect(managedRuntime.daemon.stopForInline).not.toHaveBeenCalled();
    expect(killPidTree).not.toHaveBeenCalled();
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('rejects a junctioned durable exit directory instead of following it', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const external = path.join(configHome, 'external-runtime-root');
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, 'exit-settlement.json'), JSON.stringify({
      version: 1,
      settlementId: 'external-ticket',
      owner: expectedOwner,
      windowsBootIdentity: 'windows-boot-100',
      phase: 'stop_accepted',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:01.000Z',
    }));
    fs.mkdirSync(path.dirname(paths.rootDir), { recursive: true });
    fs.symlinkSync(external, paths.rootDir, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => readRuntimeExitSettlementIntent(configHome, 'coder'))
      .toThrow('Runtime exit settlement intent is unreadable.');
  });

  it('rejects a junction in an ancestor of the durable exit directory', () => {
    const configHome = tempConfigHome();
    const external = tempConfigHome();
    const expectedOwner = owner();
    const externalPaths = resolveRuntimeDaemonPathsFromConfigHome(external, 'coder');
    fs.mkdirSync(externalPaths.rootDir, { recursive: true });
    fs.writeFileSync(path.join(externalPaths.rootDir, 'exit-settlement.json'), JSON.stringify({
      version: 1,
      settlementId: 'ancestor-junction-ticket',
      owner: expectedOwner,
      windowsBootIdentity: 'windows-boot-100',
      phase: 'stop_accepted',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:01.000Z',
    }));
    fs.symlinkSync(
      path.join(external, 'runtime'),
      path.join(configHome, 'runtime'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => readRuntimeExitSettlementIntent(configHome, 'coder'))
      .toThrow('Runtime exit settlement intent is unreadable.');
  });

  it('rejects an aliased settlement ticket instead of opening its target', () => {
    const configHome = tempConfigHome();
    const external = tempConfigHome();
    const expectedOwner = owner();
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    fs.mkdirSync(paths.rootDir, { recursive: true });
    const externalTicket = path.join(external, 'external-exit-settlement.json');
    fs.writeFileSync(externalTicket, JSON.stringify({
      version: 1,
      settlementId: 'external-file-ticket',
      owner: expectedOwner,
      windowsBootIdentity: 'windows-boot-100',
      phase: 'stop_accepted',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:01.000Z',
    }));
    const aliasedTicket = path.join(paths.rootDir, 'exit-settlement.json');
    if (process.platform === 'win32') {
      fs.linkSync(externalTicket, aliasedTicket);
    } else {
      fs.symlinkSync(externalTicket, aliasedTicket, 'file');
    }

    expect(() => readRuntimeExitSettlementIntent(configHome, 'coder'))
      .toThrow('Runtime exit settlement intent is unreadable.');
  });

  it('rejects a corrupt Windows boot identity instead of treating it as an earlier boot', () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    seedDaemon(configHome, expectedOwner);
    fs.writeFileSync(path.join(paths.rootDir, 'exit-settlement.json'), JSON.stringify({
      version: 1,
      settlementId: 'corrupt-boot-ticket',
      owner: expectedOwner,
      windowsBootIdentity: 'spoofed-earlier-boot',
      phase: 'stop_accepted',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:01.000Z',
    }));

    expect(() => readRuntimeExitSettlementIntent(configHome, 'coder'))
      .toThrow('Runtime exit settlement intent is unreadable.');
  });

  it('returns a structured block when the durable settlement ticket is corrupt', async () => {
    const configHome = tempConfigHome();
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    fs.mkdirSync(paths.rootDir, { recursive: true });
    fs.writeFileSync(path.join(paths.rootDir, 'exit-settlement.json'), '{corrupt');

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies());

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'owner_unverified',
      nextAction: 'manual-recovery',
    });
  });

  it('settles an orderly cross-platform shutdown only after a successful durable outcome', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner({ processContainment: undefined, supervisorPid: undefined });
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.close = vi.fn(async () => {
      fs.rmSync(paths.lockFile, { force: true });
      fs.rmSync(paths.stateFile, { force: true });
      writeRuntimeDaemonShutdownOutcome(paths, {
        version: 1,
        runtimeId: expectedOwner.runtimeId,
        pid: expectedOwner.pid,
        status: 'succeeded',
        completedAt: '2026-08-17T00:00:01.000Z',
      });
    });

    const waitForProcessExit = vi.fn(async () => true);
    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
    }, dependencies({ platform: 'linux', waitForProcessExit }));

    expect(result).toMatchObject({ status: 'clean', repairs: [] });
    expect(waitForProcessExit.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(160_000);
    expect(readRuntimeOwnerPolicy(paths).mode).toBe('daemon');
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('requires relaunch when ticket removal succeeds but its durability sync fails', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner({ processContainment: undefined, supervisorPid: undefined });
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.close = vi.fn(async () => {
      fs.rmSync(paths.lockFile, { force: true });
      fs.rmSync(paths.stateFile, { force: true });
      writeRuntimeDaemonShutdownOutcome(paths, {
        version: 1,
        runtimeId: expectedOwner.runtimeId,
        pid: expectedOwner.pid,
        status: 'succeeded',
        completedAt: '2026-08-17T00:00:01.000Z',
      });
    });
    const ticketPath = path.join(paths.rootDir, 'exit-settlement.json');

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
    }, dependencies({
      platform: 'linux',
      waitForProcessExit: vi.fn(async () => true),
      removeRuntimeExitIntentFile: vi.fn((intentPath) => {
        fs.rmSync(intentPath, { force: true });
        throw new Error('directory durability sync failed after ticket unlink');
      }),
    }));

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'cleanup_unverified',
      nextAction: 'relaunch-space',
    });
    expect(managedRuntime.close).toHaveBeenCalledOnce();
    expect(fs.existsSync(ticketPath)).toBe(false);
  });

  it('recovers the exact Windows process tree', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const managedRuntime = runtime(expectedOwner);
    const alive = new Set([expectedOwner.pid, expectedOwner.supervisorPid!]);
    const deps = dependencies({
      isPidAlive: vi.fn((pid) => alive.has(pid)),
      readProcessStartIdentity: vi.fn((pid) => (
        pid === expectedOwner.pid ? expectedOwner.processStartIdentity : undefined
      )),
      waitForProcessExit: vi.fn(async (pid) => !alive.has(pid)),
      killPidTree: vi.fn(async (pid, identity) => {
        expect(pid).toBe(expectedOwner.pid);
        expect(identity).toBe(expectedOwner.processStartIdentity);
        alive.clear();
        return 'terminated';
      }),
    });

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, deps);

    expect(result).toMatchObject({ status: 'recovered' });
    expect(result.repairs).toEqual(['windows_process_tree']);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
    expect(fs.existsSync(paths.stateFile)).toBe(false);
    expect(readRuntimeOwnerPolicy(paths).mode).toBe('daemon');
  });

  it('settles a reused Windows PID without sending a destructive signal', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const kill = vi.fn(async () => 'terminated' as const);
    const waitForProcessExit = vi.fn(async (pid: number) => (
      pid === expectedOwner.supervisorPid
    ));

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: runtime(expectedOwner),
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn((pid) => pid === expectedOwner.pid),
      readProcessStartIdentity: vi.fn(() => 'different-process-generation'),
      waitForProcessExit,
      killPidTree: kill,
    }));

    expect(result).toEqual({
      status: 'recovered',
      repairs: [],
    });
    expect(kill).not.toHaveBeenCalled();
    expect(waitForProcessExit).toHaveBeenCalledWith(
      expectedOwner.supervisorPid,
      expect.any(Number),
    );
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('settles when the Windows Job supervisor PID belongs to a replacement generation', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = {
      ...owner(),
      supervisorProcessStartIdentity: 'supervisor-start-4102',
    };
    seedDaemon(configHome, expectedOwner);
    const waitForProcessExit = vi.fn(async () => false);
    const kill = vi.fn(async () => 'terminated' as const);

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: runtime(expectedOwner),
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn((pid) => pid === expectedOwner.supervisorPid),
      readProcessStartIdentity: vi.fn((pid) => (
        pid === expectedOwner.supervisorPid ? 'replacement-supervisor-generation' : undefined
      )),
      waitForProcessExit,
      killPidTree: kill,
    }));

    expect(result).toEqual({
      status: 'recovered',
      repairs: [],
    });
    expect(kill).not.toHaveBeenCalled();
    expect(waitForProcessExit).not.toHaveBeenCalledWith(
      expectedOwner.supervisorPid,
      expect.any(Number),
    );
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('settles when the Windows Job supervisor PID is reused during the bounded wait', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = {
      ...owner(),
      supervisorProcessStartIdentity: 'supervisor-start-4102',
    };
    seedDaemon(configHome, expectedOwner);
    let supervisorIdentityReads = 0;
    const waitForProcessExit = vi.fn(async () => false);
    const kill = vi.fn(async () => 'terminated' as const);

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: runtime(expectedOwner),
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn((pid) => pid === expectedOwner.supervisorPid),
      readProcessStartIdentity: vi.fn((pid) => {
        if (pid !== expectedOwner.supervisorPid) return undefined;
        supervisorIdentityReads += 1;
        return supervisorIdentityReads === 1
          ? expectedOwner.supervisorProcessStartIdentity
          : 'replacement-supervisor-generation';
      }),
      waitForProcessExit,
      killPidTree: kill,
    }));

    expect(result).toEqual({
      status: 'recovered',
      repairs: [],
    });
    expect(waitForProcessExit).toHaveBeenCalledWith(
      expectedOwner.supervisorPid,
      expect.toSatisfy((timeoutMs: number) => timeoutMs <= 250),
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it('persists the exact supervisor generation in the restart-safe settlement intent', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = {
      ...owner(),
      supervisorProcessStartIdentity: 'supervisor-start-4102',
    };
    seedDaemon(configHome, expectedOwner);

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: runtime(expectedOwner),
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn((pid) => pid === expectedOwner.supervisorPid),
      readProcessStartIdentity: vi.fn((pid) => (
        pid === expectedOwner.supervisorPid
          ? expectedOwner.supervisorProcessStartIdentity
          : undefined
      )),
      waitForProcessExit: vi.fn(async () => false),
    }));

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'containment_active',
      nextAction: 'retry-automatically',
    });
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toMatchObject({
      owner: {
        runtimeId: expectedOwner.runtimeId,
        supervisorPid: expectedOwner.supervisorPid,
        supervisorProcessStartIdentity: expectedOwner.supervisorProcessStartIdentity,
      },
    });
  });

  it('keeps legacy PID-only containment safe and converges after the supervisor exits', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const firstWait = vi.fn(async () => false);

    const first = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: runtime(expectedOwner),
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn((pid) => pid === expectedOwner.supervisorPid),
      readProcessStartIdentity: vi.fn(() => 'untrusted-current-generation'),
      waitForProcessExit: firstWait,
    }));

    expect(first).toMatchObject({
      status: 'blocked',
      reason: 'containment_active',
      nextAction: 'retry-automatically',
    });
    expect(firstWait).toHaveBeenCalledWith(expectedOwner.supervisorPid, expect.any(Number));
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toMatchObject({
      owner: {
        runtimeId: expectedOwner.runtimeId,
        supervisorPid: expectedOwner.supervisorPid,
      },
    });
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')?.owner)
      .not.toHaveProperty('supervisorProcessStartIdentity');

    const resumed = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn(() => false),
      waitForProcessExit: vi.fn(async () => true),
    }));

    expect(resumed).toEqual({
      status: 'recovered',
      repairs: [],
    });
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('continues settlement when the retained Windows PID exits before identity verification', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const kill = vi.fn(async () => 'terminated' as const);
    let ownerLivenessChecks = 0;

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: runtime(expectedOwner),
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn((pid) => (
        pid === expectedOwner.pid && ++ownerLivenessChecks === 1
      )),
      readProcessStartIdentity: vi.fn(() => undefined),
      waitForProcessExit: vi.fn(async (pid) => pid === expectedOwner.supervisorPid),
      killPidTree: kill,
    }));

    expect(result).toEqual({
      status: 'recovered',
      repairs: [],
    });
    expect(ownerLivenessChecks).toBe(2);
    expect(kill).not.toHaveBeenCalled();
  });

  it('never escalates a retained POSIX daemon by cached PID', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner({ processContainment: undefined, supervisorPid: undefined });
    seedDaemon(configHome, expectedOwner);
    const kill = vi.fn(async () => 'terminated' as const);

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: runtime(expectedOwner),
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      platform: 'darwin',
      isPidAlive: vi.fn(() => true),
      waitForProcessExit: vi.fn(async () => false),
      killPidTree: kill,
    }));

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'cleanup_unverified',
      nextAction: 'manual-recovery',
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not honor a Windows recovered ticket on POSIX', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    seedDaemon(configHome, expectedOwner);
    fs.writeFileSync(path.join(paths.rootDir, 'exit-settlement.json'), JSON.stringify({
      version: 1,
      settlementId: 'windows-recovered-ticket',
      owner: expectedOwner,
      windowsBootIdentity: 'windows-boot-100',
      phase: 'recovered',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:01.000Z',
    }));

    const result = await settleRuntimeDaemonExitForTest({ configHome, profile: 'coder' }, dependencies({
      platform: 'linux',
    }));

    expect(result).toMatchObject({ status: 'blocked', reason: 'owner_unverified' });
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
      runtimeId: expectedOwner.runtimeId,
      pid: expectedOwner.pid,
    });
  });

  it('does not force a prepared intent that has no durable stop acceptance', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.daemon.stopForInline = vi.fn(async () => {
      throw new Error('transport failed before acceptance');
    });
    const kill = vi.fn(async () => 'terminated' as const);

    await expect(settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
    }, dependencies({ killPidTree: kill }))).resolves.toMatchObject({
      status: 'blocked',
      reason: 'stop_not_accepted',
      nextAction: 'relaunch-space',
    });

    expect(readRuntimeExitSettlementIntent(configHome, 'coder')?.phase).toBe('prepared');
    const resumed = await settleRuntimeDaemonExitForTest({ configHome, profile: 'coder' }, dependencies({
      isPidAlive: vi.fn(() => true),
      killPidTree: kill,
    }));
    expect(resumed).toMatchObject({
      status: 'blocked',
      reason: 'stop_not_accepted',
      nextAction: 'relaunch-space',
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('keeps a timed-out stop fenced until an idempotent management retry converges', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const firstRuntime = runtime(expectedOwner);
    let acceptLateStop: (() => void) | undefined;
    firstRuntime.daemon.stopForInline = vi.fn(() => new Promise((resolve) => {
      acceptLateStop = () => {
        commitRuntimeDaemonRollbackPolicy(paths, expectedOwner.runtimeId, 0);
        resolve({ accepted: true as const });
      };
    }));

    const first = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: firstRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
      managementPhaseTimeoutMs: TEST_HUNG_PHASE_TIMEOUT_MS,
    }, dependencies());
    expect(first).toMatchObject({
      status: 'blocked',
      reason: 'stop_not_accepted',
      nextAction: 'relaunch-space',
    });
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')?.phase).toBe('prepared');

    const unresolved = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies());
    expect(unresolved).toMatchObject({
      status: 'blocked',
      reason: 'stop_not_accepted',
      nextAction: 'relaunch-space',
    });

    expect(acceptLateStop).toBeDefined();
    acceptLateStop!();
    const resumed = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: runtime(expectedOwner),
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies());

    expect(resumed).toEqual({ status: 'recovered', repairs: [] });
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('bounds a hung inspection before mutation', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.daemon.inspect = vi.fn(() => new Promise(() => undefined));

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
      managementPhaseTimeoutMs: TEST_HUNG_PHASE_TIMEOUT_MS,
    }, dependencies());

    expect(result).toMatchObject({ status: 'blocked', reason: 'cleanup_unverified' });
    expect(managedRuntime.daemon.stopForInline).not.toHaveBeenCalled();
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('promotes an exact prepared intent', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.daemon.stopForInline = vi.fn(async () => {
      commitRuntimeDaemonRollbackPolicy(paths, expectedOwner.runtimeId, 0);
      throw new Error('response lost after commit');
    });

    const first = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies());
    expect(first).toEqual({ status: 'recovered', repairs: [] });
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
    expect(managedRuntime.daemon.stopForInline).toHaveBeenCalledWith(expect.objectContaining({
      operation: { operationId: expect.any(String) },
    }));
  });

  it('uses a fresh stop attempt identity after a prepared transport rejection', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const firstRuntime = runtime(expectedOwner);
    const firstStop = vi.fn(async () => {
      throw new Error('transport rejected before commit');
    });
    firstRuntime.daemon.stopForInline = firstStop;

    await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: firstRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies());
    const firstOperationId = firstStop.mock.calls[0]?.[0].operation?.operationId;
    const settlementId = readRuntimeExitSettlementIntent(configHome, 'coder')?.settlementId;
    expect(firstOperationId).toBeDefined();
    expect(firstOperationId).not.toBe(settlementId);

    const retryRuntime = runtime(expectedOwner);
    retryRuntime.daemon.inspect = vi.fn(async () => ({
      runtimeId: expectedOwner.runtimeId,
      revision: 9,
      ownerPolicy: { mode: 'daemon' as const, revision: 0, updatedAt: new Date(0).toISOString() },
      owner: expectedOwner,
      preflight: { blockers: [], canStop: true },
    }));
    retryRuntime.daemon.stopForInline = vi.fn(async (input) => {
      if (input.operation?.operationId === firstOperationId) {
        throw new Error('operation_id_reuse');
      }
      commitRuntimeDaemonRollbackPolicy(paths, expectedOwner.runtimeId, 0);
      return { accepted: true as const };
    });

    const retried = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: retryRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies());

    expect(retried).toEqual({ status: 'recovered', repairs: [] });
    expect(retryRuntime.daemon.stopForInline).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 9,
      operation: { operationId: expect.not.stringMatching(firstOperationId!) },
    }));
  });

  it('bounds a hung stop response and promotes the exact durable inline transition', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.daemon.stopForInline = vi.fn(() => {
      commitRuntimeDaemonRollbackPolicy(paths, expectedOwner.runtimeId, 0);
      return new Promise(() => undefined);
    });

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
      managementPhaseTimeoutMs: TEST_HUNG_PHASE_TIMEOUT_MS,
    }, dependencies());

    expect(result).toMatchObject({ status: 'recovered' });
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('bounds a hung Runtime transport close and continues durable settlement', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner({ processContainment: undefined, supervisorPid: undefined });
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.daemon.stopForInline = vi.fn(async () => {
      fs.rmSync(paths.lockFile, { force: true });
      fs.rmSync(paths.stateFile, { force: true });
      writeRuntimeDaemonShutdownOutcome(paths, {
        version: 1,
        runtimeId: expectedOwner.runtimeId,
        pid: expectedOwner.pid,
        status: 'succeeded',
        completedAt: '2026-08-17T00:00:01.000Z',
      });
      return { accepted: true as const };
    });
    managedRuntime.close = vi.fn(() => new Promise(() => undefined));

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
      runtimeCloseTimeoutMs: TEST_HUNG_PHASE_TIMEOUT_MS,
    }, dependencies({ platform: 'linux' }));

    expect(result).toMatchObject({ status: 'clean' });
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('never downgrades an accepted same-owner intent during a retry', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    commitRuntimeDaemonRollbackPolicy(paths, expectedOwner.runtimeId, 0);
    await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn((pid) => pid === expectedOwner.supervisorPid),
      readProcessStartIdentity: vi.fn((pid) => (
        pid === expectedOwner.supervisorPid
          ? expectedOwner.supervisorProcessStartIdentity
          : undefined
      )),
      waitForProcessExit: vi.fn(async () => false),
    }));
    const accepted = readRuntimeExitSettlementIntent(configHome, 'coder');
    expect(accepted?.phase).toBe('stop_accepted');
    const managedRuntime = runtime(expectedOwner);

    await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn((pid) => pid === expectedOwner.supervisorPid),
      readProcessStartIdentity: vi.fn((pid) => (
        pid === expectedOwner.supervisorPid
          ? expectedOwner.supervisorProcessStartIdentity
          : undefined
      )),
      waitForProcessExit: vi.fn(async () => false),
    }));

    expect(managedRuntime.daemon.stopForInline).not.toHaveBeenCalled();
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')?.phase).toBe('stop_accepted');
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')?.settlementId)
      .toBe(accepted?.settlementId);
  });

  it('clears a stale prepared ticket when a replacement daemon owner is authoritative', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.daemon.stopForInline = vi.fn(async () => {
      throw new Error('not accepted');
    });
    await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies());
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    fs.rmSync(paths.lockFile, { force: true });
    expect(tryAcquireRuntimeDaemonLock(paths, owner({
      runtimeId: 'replacement-runtime',
      pid: 5101,
      processStartIdentity: 'process-start-5101',
    }))).toBeDefined();

    const resumed = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies());

    expect(resumed).toMatchObject({ status: 'blocked', reason: 'owner_changed' });
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('serializes concurrent settlement calls and stops an owner only once', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner({ processContainment: undefined, supervisorPid: undefined });
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.close = vi.fn(async () => {
      fs.rmSync(paths.lockFile, { force: true });
      fs.rmSync(paths.stateFile, { force: true });
      writeRuntimeDaemonShutdownOutcome(paths, {
        version: 1,
        runtimeId: expectedOwner.runtimeId,
        pid: expectedOwner.pid,
        status: 'succeeded',
        completedAt: '2026-08-17T00:00:01.000Z',
      });
    });

    const results = await Promise.all([
      settleRuntimeDaemonExitForTest({ configHome, profile: 'coder', runtime: managedRuntime },
        dependencies({ platform: 'linux' })),
      settleRuntimeDaemonExitForTest({ configHome, profile: 'coder', runtime: managedRuntime },
        dependencies({ platform: 'linux' })),
    ]);

    expect(results.filter((result) => result.status === 'clean')).toHaveLength(1);
    expect(results.filter((result) => (
      result.status === 'blocked' && result.reason === 'owner_changed'
    ))).toHaveLength(1);
    expect(managedRuntime.daemon.stopForInline).toHaveBeenCalledTimes(1);
  });

  it('fails closed when corrupt ownership files remain after a successful outcome', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.close = vi.fn(async () => {
      fs.writeFileSync(paths.lockFile, '{corrupt');
      fs.writeFileSync(paths.stateFile, '{corrupt');
      writeRuntimeDaemonShutdownOutcome(paths, {
        version: 1,
        runtimeId: expectedOwner.runtimeId,
        pid: expectedOwner.pid,
        status: 'succeeded',
        completedAt: '2026-08-17T00:00:01.000Z',
      });
    });

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies());

    expect(result).toMatchObject({ status: 'blocked', reason: 'owner_changed' });
    expect(fs.existsSync(paths.lockFile)).toBe(true);
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeDefined();
  });

  it('recovers a failed Windows lifecycle with an empty Job even when no ACL marker exists', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    writeRuntimeDaemonShutdownOutcome(paths, {
      version: 1,
      runtimeId: expectedOwner.runtimeId,
      pid: expectedOwner.pid,
      status: 'failed',
      completedAt: '2026-08-17T00:00:01.000Z',
      error: 'cleanup deadline exceeded',
    });

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: runtime(expectedOwner),
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies());

    expect(result).toEqual({ status: 'recovered', repairs: [] });
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
    expect(readRuntimeOwnerPolicy(paths).mode).toBe('daemon');
  });

  it('does not spend the orderly shutdown window after a durable Windows cleanup failure', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    writeRuntimeDaemonShutdownOutcome(paths, {
      version: 1,
      runtimeId: expectedOwner.runtimeId,
      pid: expectedOwner.pid,
      status: 'failed',
      completedAt: '2026-08-17T00:00:01.000Z',
      error: 'workspace sandbox cleanup failed',
    });
    const alive = new Set([expectedOwner.pid, expectedOwner.supervisorPid!]);
    const waitBudgets: number[] = [];

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: runtime(expectedOwner),
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn((pid) => alive.has(pid)),
      readProcessStartIdentity: vi.fn(() => expectedOwner.processStartIdentity),
      waitForProcessExit: vi.fn(async (pid, timeoutMs) => {
        waitBudgets.push(timeoutMs);
        return !alive.has(pid);
      }),
      killPidTree: vi.fn(async () => {
        alive.clear();
        return 'terminated';
      }),
    }));

    expect(result).toEqual({
      status: 'recovered',
      repairs: ['windows_process_tree'],
    });
    expect(waitBudgets).not.toContain(170_000);
  });

  it('observes a late durable Windows cleanup failure without waiting for process timeout', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.daemon.stopForInline = vi.fn(async () => {
      setTimeout(() => {
        writeRuntimeDaemonShutdownOutcome(paths, {
          version: 1,
          runtimeId: expectedOwner.runtimeId,
          pid: expectedOwner.pid,
          status: 'failed',
          completedAt: '2026-08-17T00:00:01.000Z',
          error: 'workspace sandbox cleanup failed',
        });
      }, 10);
      return { accepted: true as const };
    });
    const alive = new Set([expectedOwner.pid, expectedOwner.supervisorPid!]);
    const kill = vi.fn(async () => {
      alive.clear();
      return 'terminated' as const;
    });

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn((pid) => alive.has(pid)),
      readProcessStartIdentity: vi.fn(() => expectedOwner.processStartIdentity),
      waitForProcessExit: vi.fn((pid) => (
        alive.has(pid) ? new Promise<boolean>(() => undefined) : Promise.resolve(true)
      )),
      killPidTree: kill,
    }));

    expect(result).toEqual({
      status: 'recovered',
      repairs: ['windows_process_tree'],
    });
    expect(kill).toHaveBeenCalledOnce();
  });

  it('cancels process-exit observation when a durable failure cannot pass identity recovery', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.daemon.stopForInline = vi.fn(async () => {
      setTimeout(() => {
        writeRuntimeDaemonShutdownOutcome(paths, {
          version: 1,
          runtimeId: expectedOwner.runtimeId,
          pid: expectedOwner.pid,
          status: 'failed',
          completedAt: '2026-08-17T00:00:01.000Z',
          error: 'workspace sandbox cleanup failed',
        });
      }, 10);
      return { accepted: true as const };
    });
    let observationAborted = false;

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn(() => true),
      readProcessStartIdentity: vi.fn(() => undefined),
      waitForProcessExit: vi.fn((_pid, _timeoutMs, signal) => new Promise<boolean>((resolve) => {
        signal?.addEventListener('abort', () => {
          observationAborted = true;
          resolve(false);
        }, { once: true });
      })),
    }));

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'owner_identity_mismatch',
    });
    expect(observationAborted).toBe(true);
  });

  it('reserves a Windows Job containment tail after the orderly daemon wait', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    const managedRuntime = runtime(expectedOwner);
    managedRuntime.close = vi.fn(async () => {
      fs.rmSync(paths.lockFile, { force: true });
      fs.rmSync(paths.stateFile, { force: true });
      writeRuntimeDaemonShutdownOutcome(paths, {
        version: 1,
        runtimeId: expectedOwner.runtimeId,
        pid: expectedOwner.pid,
        status: 'succeeded',
        completedAt: '2026-08-17T00:00:01.000Z',
      });
    });
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const budgets: number[] = [];
    const waitForProcessExit = vi.fn(async (pid: number, timeoutMs: number) => {
      budgets.push(timeoutMs);
      if (pid === expectedOwner.pid) now += timeoutMs;
      return true;
    });

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      runtime: managedRuntime,
    }, dependencies({ waitForProcessExit }));

    expect(result).toMatchObject({ status: 'clean' });
    expect(budgets[0]).toBe(170_000);
    expect(budgets[1]).toBeGreaterThanOrEqual(10_000);
  });

  it('resumes a legacy accepted rollback without a pre-existing SDK ticket', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    commitRuntimeDaemonRollbackPolicy(paths, expectedOwner.runtimeId, 0);
    const alive = new Set([expectedOwner.pid, expectedOwner.supervisorPid!]);

    const result = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      isPidAlive: vi.fn((pid) => alive.has(pid)),
      readProcessStartIdentity: vi.fn(() => expectedOwner.processStartIdentity),
      waitForProcessExit: vi.fn(async (pid) => !alive.has(pid)),
      killPidTree: vi.fn(async () => {
        alive.clear();
        return 'terminated';
      }),
    }));

    expect(result.status).toBe('recovered');
    expect(readRuntimeOwnerPolicy(paths).mode).toBe('daemon');
  });

  it('uses a changed Windows boot identity as containment proof without touching reused PIDs', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    commitRuntimeDaemonRollbackPolicy(paths, expectedOwner.runtimeId, 0);
    const first = dependencies({
      readWindowsBootIdentity: vi.fn(() => 'windows-boot-100'),
      isPidAlive: vi.fn((pid) => pid === expectedOwner.supervisorPid),
      waitForProcessExit: vi.fn(async () => false),
    });
    await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, first);

    const kill = vi.fn(async () => 'terminated' as const);
    const resumed = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      readWindowsBootIdentity: vi.fn(() => 'windows-boot-200'),
      isPidAlive: vi.fn(() => true),
      waitForProcessExit: vi.fn(async () => false),
      killPidTree: kill,
    }));

    expect(resumed).toEqual({
      status: 'recovered',
      repairs: [],
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('settles a previous-boot intent without a legacy ACL dependency', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    commitRuntimeDaemonRollbackPolicy(paths, expectedOwner.runtimeId, 0);
    await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      readWindowsBootIdentity: vi.fn(() => 'windows-boot-100'),
      isPidAlive: vi.fn((pid) => pid === expectedOwner.supervisorPid),
      waitForProcessExit: vi.fn(async () => false),
    }));

    const first = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({ readWindowsBootIdentity: vi.fn(() => 'windows-boot-200') }));

    expect(first).toEqual({ status: 'recovered', repairs: [] });
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('uses a changed POSIX boot identity to recover exact retained ownership after reboot', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner({ processContainment: undefined, supervisorPid: undefined });
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    commitRuntimeDaemonRollbackPolicy(paths, expectedOwner.runtimeId, 0);
    const kill = vi.fn(async () => 'terminated' as const);

    const first = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      platform: 'linux',
      readSystemBootIdentity: vi.fn(() => 'linux-boot-11111111-1111-1111-1111-111111111111'),
      isPidAlive: vi.fn(() => true),
      waitForProcessExit: vi.fn(async () => false),
      killPidTree: kill,
    }));
    expect(first).toMatchObject({ status: 'blocked', reason: 'cleanup_unverified' });

    const resumed = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies({
      platform: 'linux',
      readSystemBootIdentity: vi.fn(() => 'linux-boot-22222222-2222-2222-2222-222222222222'),
      isPidAlive: vi.fn(() => true),
      waitForProcessExit: vi.fn(async () => false),
      killPidTree: kill,
    }));

    expect(resumed).toEqual({ status: 'recovered', repairs: [] });
    expect(kill).not.toHaveBeenCalled();
    expect(readRuntimeOwnerPolicy(paths).mode).toBe('daemon');
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });

  it('accepts and clears a historical recovered ticket', async () => {
    const configHome = tempConfigHome();
    const expectedOwner = owner();
    seedDaemon(configHome, expectedOwner);
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'coder');
    commitRuntimeDaemonRollbackPolicy(paths, expectedOwner.runtimeId, 0);
    fs.writeFileSync(path.join(paths.rootDir, 'exit-settlement.json'), JSON.stringify({
      version: 1,
      settlementId: 'historical-recovered-ticket',
      owner: expectedOwner,
      windowsBootIdentity: 'windows-boot-100',
      phase: 'recovered',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:01.000Z',
      repairs: ['windows_sandbox_acl'],
      windowsAclRecoveryScope: 'exact-owner',
    }));
    const resumed = await settleRuntimeDaemonExitForTest({
      configHome,
      profile: 'coder',
      timeoutMs: TEST_TRANSACTION_TIMEOUT_MS,
    }, dependencies());

    expect(resumed).toEqual({
      status: 'recovered',
      repairs: ['windows_sandbox_acl'],
    });
    expect(readRuntimeExitSettlementIntent(configHome, 'coder')).toBeUndefined();
  });
});
