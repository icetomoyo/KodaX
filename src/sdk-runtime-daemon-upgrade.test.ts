import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const upgradeMocks = vi.hoisted(() => ({
  acquireProcessLease: vi.fn(),
  createSocketTransport: vi.fn(),
  enableDaemonOwner: vi.fn(),
  readDaemonState: vi.fn(),
  readDaemonToken: vi.fn(),
  readExitIntent: vi.fn(),
  readLockOwner: vi.fn(),
  settleExit: vi.fn(),
  waitForShutdown: vi.fn(),
}));

vi.mock('./runtime-daemon/process.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./runtime-daemon/process.js')>();
  return {
    ...actual,
    acquireRuntimeDaemonProcessLease: upgradeMocks.acquireProcessLease,
  };
});

vi.mock('./runtime-daemon/state.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./runtime-daemon/state.js')>();
  return {
    ...actual,
    enableRuntimeDaemonOwner: upgradeMocks.enableDaemonOwner,
    readRuntimeDaemonState: upgradeMocks.readDaemonState,
    readRuntimeDaemonToken: upgradeMocks.readDaemonToken,
    readRuntimeDaemonLockOwner: upgradeMocks.readLockOwner,
  };
});

vi.mock('./runtime-daemon/transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime-daemon/transport.js')>();
  return {
    ...actual,
    createRuntimeDaemonSocketClientTransport: upgradeMocks.createSocketTransport,
  };
});

vi.mock('./runtime-daemon/shutdown-verifier.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./runtime-daemon/shutdown-verifier.js')>();
  return {
    ...actual,
    waitForRuntimeDaemonShutdown: upgradeMocks.waitForShutdown,
  };
});

vi.mock('./runtime-daemon/exit-settlement.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime-daemon/exit-settlement.js')>();
  return {
    ...actual,
    readRuntimeExitSettlementIntent: upgradeMocks.readExitIntent,
    settleRuntimeDaemonExit: upgradeMocks.settleExit,
  };
});

import {
  connectKodaXRuntime,
  createKodaXRuntime,
  KODAX_RUNTIME_SDK_CAPABILITIES,
  RuntimeDaemonCapabilityUpgradeError,
  settleKodaXRuntimeExit,
  type RuntimeDaemonManagementState,
  type RuntimeDaemonPreflight,
} from './sdk-runtime.js';
import type { RuntimeDaemonClientTransport } from './runtime-daemon/client.js';
import type { RuntimeDaemonProcessLease } from './runtime-daemon/process.js';
import type { RuntimeDaemonPaths } from './runtime-daemon/state.js';

const PROFILE = 'upgrade-test';
const RUNTIME_ID = 'runtime_legacy';

describe('Runtime daemon capability upgrade', () => {
  beforeEach(() => {
    upgradeMocks.acquireProcessLease.mockReset();
    upgradeMocks.createSocketTransport.mockReset();
    upgradeMocks.enableDaemonOwner.mockReset();
    upgradeMocks.readDaemonState.mockReset();
    upgradeMocks.readDaemonToken.mockReset();
    upgradeMocks.readExitIntent.mockReset();
    upgradeMocks.readLockOwner.mockReset();
    upgradeMocks.settleExit.mockReset();
    upgradeMocks.waitForShutdown.mockReset();
    upgradeMocks.settleExit.mockImplementation(async (input: {
      runtime: {
        daemon: {
          stopForInline(request: {
            expectedRuntimeId: string;
            expectedRevision: number;
            expectedOwnerPolicyRevision: number;
          }): Promise<unknown>;
        };
        close(): Promise<void>;
      };
    }) => {
      await input.runtime.daemon.stopForInline({
        expectedRuntimeId: RUNTIME_ID,
        expectedRevision: 7,
        expectedOwnerPolicyRevision: 3,
      });
      await input.runtime.close();
      return { status: 'clean', repairs: [] } as const;
    });
    upgradeMocks.waitForShutdown.mockResolvedValue({
      status: 'succeeded',
      outcome: {
        version: 1,
        runtimeId: RUNTIME_ID,
        pid: 101,
        status: 'succeeded',
        completedAt: '2026-07-19T00:00:02.000Z',
      },
    });
  });

  it('fences and replaces an idle legacy daemon before returning the current runtime', async () => {
    const calls: string[] = [];
    const oldClose = vi.fn(async () => undefined);
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: oldClose,
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    const newClose = vi.fn(async () => undefined);
    const newTransport = createCurrentTransport(calls, newClose);
    const oldLease = createLease(oldTransport);
    const newLease = createLease(newTransport);
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(oldLease)
      .mockResolvedValueOnce(newLease);
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    const runtime = await connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
    });

    expect(runtime.identity.runtimeId).toBe('runtime_current');
    expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
      'new:initialize',
    ]);
    expect(upgradeMocks.settleExit).toHaveBeenCalledWith({
      configHome: oldLease.paths.configHome,
      profile: PROFILE,
      runtime: expect.any(Object),
    });
    expect(oldClose).toHaveBeenCalled();

    await runtime.close();
    expect(newClose).toHaveBeenCalled();
  });

  it('replaces an idle daemon whose ordinary conversation history contract is still v1', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      capabilities: {
        conversationHistory: { version: 1 },
        daemonManagement: { version: 1 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
        runtimeEventCoalescing: { version: 1 },
        sandboxRuntime: { version: 9 },
      },
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    const newClose = vi.fn(async () => undefined);
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(oldTransport))
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, newClose)));
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    const runtime = await connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
      requirements: { conversationHistory: 2 },
    });

    expect(runtime.identity.runtimeId).toBe('runtime_current');
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
      'new:initialize',
    ]);
    await runtime.close();
    expect(newClose).toHaveBeenCalled();
  });

  it('replaces an idle daemon for inventory only when the embedder explicitly requires it', async () => {
    const calls: string[] = [];
    const currentWithoutInventory = {
      actorSettlementConvergence: { version: 2 },
      crashOutcomeModel: { version: 2 },
      daemonManagement: { version: 1 },
      managedRunDurability: { version: 1 },
      liveOutputSegments: { version: 1 },
      runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
      runtimeEventCoalescing: { version: 1 },
      sandboxRuntime: { version: 9 },
      sessionEventJournal: { version: 1 },
      ...(process.platform === 'win32'
        ? { daemonShutdownVerification: { version: 1 } }
        : {}),
    };
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      capabilities: currentWithoutInventory,
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    const oldLease = createLease(
      oldTransport,
      initializeResult(RUNTIME_ID, currentWithoutInventory),
    );
    const newClose = vi.fn(async () => undefined);
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(oldLease)
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, newClose)));
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    const runtime = await connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
      requirements: { daemonClientInventory: 1 },
    });

    expect(runtime.identity.runtimeId).toBe('runtime_current');
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
      'new:initialize',
    ]);
    await runtime.close();
    expect(newClose).toHaveBeenCalled();
  });

  it('replaces an idle v4 daemon when auto-start requires the v5 sandbox-first contract', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      capabilities: {
        actorSettlementConvergence: { version: 2 },
        crashOutcomeModel: { version: 2 },
        daemonManagement: { version: 1 },
        daemonShutdownVerification: { version: 1 },
        liveOutputSegments: { version: 1 },
        managedRunDurability: { version: 1 },
        runtimeEventCoalescing: { version: 1 },
        sandboxRuntime: { version: 9 },
        sessionEventJournal: { version: 1 },
        sharedSessionSettings: { version: 2 },
        runtimeAutoModeGuardrail: {
          version: 4,
          owner: 'session-runtime',
          fallbackPersistsEngine: true,
        },
      },
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    const newClose = vi.fn(async () => undefined);
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(oldTransport))
      .mockResolvedValueOnce(
        createLease(createCurrentTransport(calls, newClose)),
      );
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    const runtime = await connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
    });

    expect(runtime.identity.runtimeId).toBe('runtime_current');
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
      'new:initialize',
    ]);
    await runtime.close();
    expect(newClose).toHaveBeenCalled();
  });

  it('replaces an idle shared-settings v1 daemon when auto-start requires the four-profile v2 contract', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      capabilities: {
        actorSettlementConvergence: { version: 2 },
        crashOutcomeModel: { version: 2 },
        daemonManagement: { version: 1 },
        daemonShutdownVerification: { version: 1 },
        liveOutputSegments: { version: 1 },
        managedRunDurability: { version: 1 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
        runtimeEventCoalescing: { version: 1 },
        sandboxRuntime: { version: 9 },
        sessionEventJournal: { version: 1 },
        sharedSessionSettings: { version: 1 },
      },
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    const newClose = vi.fn(async () => undefined);
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(oldTransport))
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, newClose)));
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    const runtime = await connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
    });

    expect(runtime.identity.runtimeId).toBe('runtime_current');
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
      'new:initialize',
    ]);
    await runtime.close();
    expect(newClose).toHaveBeenCalled();
  });

  it('enforces v5/v2 upgrade requirements through createKodaXRuntime daemon mode', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      capabilities: {
        actorSettlementConvergence: { version: 2 },
        crashOutcomeModel: { version: 2 },
        daemonManagement: { version: 1 },
        daemonShutdownVerification: { version: 1 },
        liveOutputSegments: { version: 1 },
        managedRunDurability: { version: 1 },
        runtimeAutoModeGuardrail: { version: 4, owner: 'session-runtime' },
        runtimeEventCoalescing: { version: 1 },
        sandboxRuntime: { version: 9 },
        sessionEventJournal: { version: 1 },
        sharedSessionSettings: { version: 2 },
      },
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    const newClose = vi.fn(async () => undefined);
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(oldTransport))
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, newClose)));
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    const runtime = await createKodaXRuntime({
      mode: 'daemon',
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
    });

    expect(runtime.identity.runtimeId).toBe('runtime_current');
    expect(calls).toContain('old:daemon.rollbackToInline');
    await runtime.close();
    expect(newClose).toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32').each([1, 2, 3, 4, 5, 6, 7, 8])(
    'replaces an idle sandbox v%i daemon before exposing sandbox execution v9',
    async (sandboxVersion) => {
      const calls: string[] = [];
      const oldTransport = createLegacyTransport({
        preflight: createPreflight(),
        calls,
        close: vi.fn(async () => undefined),
        capabilities: {
          actorSettlementConvergence: { version: 2 },
          daemonManagement: { version: 1 },
          managedRunDurability: { version: 1 },
          runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
          runtimeEventCoalescing: { version: 1 },
          sandboxRuntime: { version: sandboxVersion, asrtVersion: '0.0.65' },
          sessionEventJournal: { version: 1 },
        },
        onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
      });
      const newClose = vi.fn(async () => undefined);
      const oldLease = createLease(oldTransport);
      upgradeMocks.acquireProcessLease
        .mockResolvedValueOnce(oldLease)
        .mockResolvedValueOnce(createLease(createCurrentTransport(calls, newClose)));
      upgradeMocks.readLockOwner.mockReturnValue({
        runtimeId: RUNTIME_ID,
        pid: 101,
        createdAt: '2026-07-19T00:00:00.000Z',
        kind: 'daemon',
      });

      const runtime = await connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
      });

      expect(runtime.identity.runtimeId).toBe('runtime_current');
      expect(calls).toEqual([
        'old:initialize',
        'old:daemon.management.get',
        'old:daemon.rollbackToInline',
        'old:close',
        'new:initialize',
      ]);
      expect(upgradeMocks.settleExit).toHaveBeenCalledWith(expect.objectContaining({
        configHome: oldLease.paths.configHome,
        profile: PROFILE,
        runtime: expect.any(Object),
      }));
      await runtime.close();
      expect(newClose).toHaveBeenCalled();
    },
  );

  it('replaces an idle crash-outcome v1 daemon before exposing managed terminal v2', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      capabilities: {
        crashOutcomeModel: { version: 1 },
        daemonManagement: { version: 1 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
        runtimeEventCoalescing: { version: 1 },
      },
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    const newClose = vi.fn(async () => undefined);
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(oldTransport))
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, newClose)));
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    const runtime = await connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
    });

    expect(runtime.identity.runtimeId).toBe('runtime_current');
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
      'new:initialize',
    ]);
    await runtime.close();
    expect(newClose).toHaveBeenCalled();
  });

  it.each([
    ['active run', createPreflight({ blockers: ['active_runs'], canStop: false })],
    ['additional client', createPreflight({
      clientCount: 2,
      blockers: ['connected_clients'],
      canStop: false,
    })],
  ])('keeps a crash-outcome v1 daemon fenced while it has an %s', async (_case, preflight) => {
    const calls: string[] = [];
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(createLegacyTransport({
      preflight,
      calls,
      close: vi.fn(async () => undefined),
      capabilities: {
        crashOutcomeModel: { version: 1 },
        daemonManagement: { version: 1 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
        runtimeEventCoalescing: { version: 1 },
      },
    })));

    await expect(connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
    })).rejects.toMatchObject({
      code: 'daemon_capability_upgrade_required',
      capability: 'crashOutcomeModel',
      preflight: expect.objectContaining({ blockers: preflight.blockers }),
    });
    expect(upgradeMocks.enableDaemonOwner).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32').each([1, 2, 3, 4, 5, 6, 7, 8])(
    'keeps a busy sandbox v%i daemon fenced behind the sandbox v9 upgrade requirement',
    async (sandboxVersion) => {
      const calls: string[] = [];
      const oldTransport = createLegacyTransport({
        preflight: createPreflight({ blockers: ['active_runs'], canStop: false }),
        calls,
        close: vi.fn(async () => undefined),
        capabilities: {
          actorSettlementConvergence: { version: 2 },
          daemonManagement: { version: 1 },
          managedRunDurability: { version: 1 },
          runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
          runtimeEventCoalescing: { version: 1 },
          sandboxRuntime: { version: sandboxVersion, asrtVersion: '0.0.65' },
          sessionEventJournal: { version: 1 },
        },
      });
      upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(oldTransport));

      await expect(connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
      })).rejects.toMatchObject({
        code: 'daemon_capability_upgrade_required',
        capability: 'sandboxRuntime',
        preflight: { blockers: ['active_runs'], canStop: false },
      });
      expect(calls).toEqual([
        'old:initialize',
        'old:daemon.management.get',
        'old:close',
      ]);
    },
  );

  it('replaces an idle daemon that lacks Runtime event coalescing', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      capabilities: {
        daemonManagement: { version: 1 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
      },
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    const newClose = vi.fn(async () => undefined);
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(oldTransport))
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, newClose)));
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    const runtime = await connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
    });

    expect(runtime.identity.runtimeId).toBe('runtime_current');
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
      'new:initialize',
    ]);
    await runtime.close();
    expect(newClose).toHaveBeenCalled();
  });

  it('replaces an idle daemon that lacks managed Run durability', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      capabilities: {
        managedRunDurability: undefined,
        daemonManagement: { version: 1 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
        runtimeEventCoalescing: { version: 1 },
      },
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    const newClose = vi.fn(async () => undefined);
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(oldTransport))
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, newClose)));
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    const runtime = await connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
    });

    expect(runtime.identity.runtimeId).toBe('runtime_current');
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
      'new:initialize',
    ]);
    await runtime.close();
    expect(newClose).toHaveBeenCalled();
  });

  it.each([undefined, 1] as const)(
    'replaces an idle daemon with Actor settlement convergence %s',
    async (version) => {
      const calls: string[] = [];
      const oldTransport = createLegacyTransport({
        preflight: createPreflight(),
        calls,
        close: vi.fn(async () => undefined),
        capabilities: {
          actorSettlementConvergence: version === undefined ? undefined : { version },
          daemonManagement: { version: 1 },
          managedRunDurability: { version: 1 },
          runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
          runtimeEventCoalescing: { version: 1 },
        },
        onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
      });
      const newClose = vi.fn(async () => undefined);
      upgradeMocks.acquireProcessLease
        .mockResolvedValueOnce(createLease(oldTransport))
        .mockResolvedValueOnce(createLease(createCurrentTransport(calls, newClose)));
      upgradeMocks.readLockOwner.mockReturnValue({
        runtimeId: RUNTIME_ID,
        pid: 101,
        createdAt: '2026-07-19T00:00:00.000Z',
        kind: 'daemon',
      });

      const runtime = await connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
      });

      expect(runtime.identity.runtimeId).toBe('runtime_current');
      expect(calls).toEqual([
        'old:initialize',
        'old:daemon.management.get',
        'old:daemon.rollbackToInline',
        'old:close',
        'new:initialize',
      ]);
      await runtime.close();
      expect(newClose).toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'requires authoritative shutdown verification for a Windows auto-start daemon',
    async () => {
      const calls: string[] = [];
      const oldTransport = createLegacyTransport({
        preflight: createPreflight(),
        calls,
        close: vi.fn(async () => undefined),
        capabilities: {
          managedRunDurability: { version: 1 },
          daemonManagement: { version: 1 },
          sandboxRuntime: { version: 2 },
          daemonShutdownVerification: undefined,
          runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
          runtimeEventCoalescing: { version: 1 },
        },
        onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
      });
      upgradeMocks.acquireProcessLease
        .mockResolvedValueOnce(createLease(oldTransport));
      upgradeMocks.readLockOwner.mockReturnValue({
        runtimeId: RUNTIME_ID,
        pid: 101,
        createdAt: '2026-07-19T00:00:00.000Z',
        kind: 'daemon',
      });
      upgradeMocks.settleExit.mockResolvedValueOnce({
        status: 'blocked',
        reason: 'owner_unverified',
        nextAction: 'keep-open',
        message: 'Runtime owner lacks a verified process-start identity.',
      });

      await expect(connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
      })).rejects.toThrow(/process-start identity/i);
      expect(calls).toEqual([
        'old:initialize',
        'old:daemon.management.get',
        'old:close',
      ]);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'refuses an explicit in-place migration to authoritative shutdown verification',
    async () => {
      const calls: string[] = [];
      const oldTransport = createLegacyTransport({
        preflight: createPreflight(),
        calls,
        close: vi.fn(async () => undefined),
        capabilities: {
          managedRunDurability: { version: 1 },
          daemonManagement: { version: 1 },
          sandboxRuntime: { version: 2 },
          daemonShutdownVerification: undefined,
          runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
          runtimeEventCoalescing: { version: 1 },
        },
      });
      upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(oldTransport));
      upgradeMocks.readLockOwner.mockReturnValue({
        runtimeId: RUNTIME_ID,
        pid: 101,
        createdAt: '2026-07-19T00:00:00.000Z',
        kind: 'daemon',
      });
      upgradeMocks.settleExit.mockResolvedValueOnce({
        status: 'blocked',
        reason: 'owner_unverified',
        nextAction: 'keep-open',
        message: 'Runtime owner lacks a verified process-start identity.',
      });

      await expect(connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
        requirements: { daemonShutdownVerification: 1 },
      })).rejects.toThrow(/process-start identity/i);
      expect(calls).toEqual([
        'old:initialize',
        'old:daemon.management.get',
        'old:close',
      ]);
    },
  );

  it('publishes the required pre-spawn daemon capabilities', () => {
    expect(KODAX_RUNTIME_SDK_CAPABILITIES).toEqual({
      actorSettlementConvergence: 2,
      conversationHistory: 2,
      crashOutcomeModel: 2,
      daemonOrphanExit: 1,
      daemonShutdownVerification: 1,
      effectiveConfig: 1,
      liveOutputSegments: 1,
      managedRunDurability: 1,
      runtimeExitSettlement: 2,
      runtimeAutoModeGuardrail: 5,
      sandboxRuntime: 9,
      sharedSessionSettings: 2,
      runtimeEventCoalescing: 1,
      sessionEventJournal: 1,
    });
  });

  it('passes orphan idle exit to process startup and replaces a daemon without that lifecycle policy', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      capabilities: {
        daemonManagement: { version: 1 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
      },
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    const newClose = vi.fn(async () => undefined);
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(oldTransport))
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, newClose)));
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    const runtime = await connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
      daemonOrphanExitMs: 30_000,
    });

    expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(2);
    expect(upgradeMocks.acquireProcessLease).toHaveBeenLastCalledWith(
      expect.objectContaining({ orphanExitMs: 30_000 }),
    );
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
      'new:initialize',
    ]);
    await runtime.close();
    expect(newClose).toHaveBeenCalled();
  });

  it('replaces an idle daemon that lacks the live output segment contract', async () => {
    const calls: string[] = [];
    const initializedParams: unknown[] = [];
    const legacyCapabilities = {
      actorSettlementConvergence: { version: 2 },
      daemonManagement: { version: 1 },
      managedRunDurability: { version: 1 },
      runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
      runtimeEventCoalescing: { version: 1 },
      sandboxRuntime: { version: 9 },
      sessionEventJournal: { version: 1 },
      ...(process.platform === 'win32'
        ? { daemonShutdownVerification: { version: 1 } }
        : {}),
    };
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      omitLiveOutputSegments: true,
      capabilities: legacyCapabilities,
      onInitialize: (params) => initializedParams.push(params),
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    const newClose = vi.fn(async () => undefined);
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(
        oldTransport,
        initializeResult(RUNTIME_ID, legacyCapabilities),
      ))
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, newClose)));
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });

    const runtime = await connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
      clientInfo: {
        name: 'space-desktop',
        instanceId: 'space-stable-id',
        instanceSecret: 'space-stable-secret',
      },
    });

    expect(runtime.identity.runtimeId).toBe('runtime_current');
    expect(initializedParams[0]).toMatchObject({
      clientInfo: {
        name: 'kodax-sdk-capability-upgrade',
        instanceId: expect.stringMatching(/^sdk_upgrade_/),
        clientType: 'automation',
      },
    });
    expect(initializedParams[0]).not.toMatchObject({
      clientInfo: { instanceSecret: expect.any(String) },
    });
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
      'new:initialize',
    ]);
    await runtime.close();
    expect(newClose).toHaveBeenCalled();
  });

  it('closes an incompatible legacy transport that cannot perform a fenced upgrade', async () => {
    const calls: string[] = [];
    const oldClose = vi.fn(async () => undefined);
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: oldClose,
      omitLiveOutputSegments: true,
      capabilities: {
        daemonManagement: undefined,
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
        runtimeEventCoalescing: { version: 1 },
        sandboxRuntime: { version: 9 },
      },
    });
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(oldTransport));

    await expect(
      connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
      }),
    ).rejects.toThrow(/too old to perform a fenced in-place upgrade/i);

    expect(calls).toEqual(['old:initialize', 'old:close']);
    expect(oldClose).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform === 'win32')(
    'closes an incompatible Windows transport that lacks authoritative containment',
    async () => {
      const calls: string[] = [];
      const oldClose = vi.fn(async () => undefined);
      const oldTransport = createLegacyTransport({
        preflight: createPreflight(),
        calls,
        close: oldClose,
        omitLiveOutputSegments: true,
        capabilities: {
          daemonManagement: { version: 1 },
          daemonShutdownVerification: undefined,
          runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
          runtimeEventCoalescing: { version: 1 },
          sandboxRuntime: { version: 9 },
        },
      });
      upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(oldTransport));
      upgradeMocks.settleExit.mockResolvedValueOnce({
        status: 'blocked',
        reason: 'containment_unavailable',
        nextAction: 'keep-open',
        message: 'Runtime owner predates authoritative process containment.',
      });

      await expect(
        connectKodaXRuntime({
          autoStart: true,
          profile: PROFILE,
          homeDir: path.join('C:', 'kodax-upgrade-test'),
        }),
      ).rejects.toThrow(/predates authoritative process containment/i);

      expect(calls).toEqual([
        'old:initialize',
        'old:daemon.management.get',
        'old:close',
      ]);
      expect(oldClose).toHaveBeenCalledOnce();
    },
  );

  it('does not replace a live-output-incompatible daemon used by an active old client', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight({
        clientCount: 2,
        blockers: ['connected_clients'],
        canStop: false,
      }),
      calls,
      close: vi.fn(async () => undefined),
      omitLiveOutputSegments: true,
      capabilities: {
        daemonManagement: { version: 1 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
        runtimeEventCoalescing: { version: 1 },
        sandboxRuntime: { version: 9 },
      },
    });
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(oldTransport));

    await expect(
      connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
      }),
    ).rejects.toMatchObject({
      code: 'daemon_capability_upgrade_required',
      capability: 'liveOutputSegments',
      preflight: {
        clientCount: 2,
        blockers: ['connected_clients'],
        canStop: false,
      },
    });
    expect(calls).toEqual(['old:initialize', 'old:daemon.management.get', 'old:close']);
    expect(upgradeMocks.enableDaemonOwner).not.toHaveBeenCalled();
  });

  it('reports when both temporary capability-upgrade close attempts fail', async () => {
    const calls: string[] = [];
    const closeFailure = new Error('socket close rejected');
    const oldClose = vi.fn(async () => Promise.reject(closeFailure));
    const oldTransport = createLegacyTransport({
      preflight: createPreflight({
        blockers: ['active_runs'],
        canStop: false,
      }),
      calls,
      close: oldClose,
      omitLiveOutputSegments: true,
    });
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(oldTransport));

    await expect(connectKodaXRuntime({
      autoStart: true,
      profile: PROFILE,
      homeDir: path.join('C:', 'kodax-upgrade-test'),
    })).rejects.toMatchObject({
      code: 'daemon_capability_upgrade_required',
      capability: 'runtimeAutoModeGuardrail',
      message: expect.stringMatching(/temporary.*client.*could not be closed/i),
    });
    expect(oldClose).toHaveBeenCalledTimes(2);
  });

  it('resumes one exact prepared exit ticket through an ephemeral management-only client', async () => {
    const configHome = path.join('C:', 'kodax-upgrade-test', '.kodax');
    const owner = {
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon' as const,
    };
    const prepared = {
      version: 1 as const,
      settlementId: 'settlement_exact',
      owner,
      phase: 'prepared' as const,
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:01.000Z',
    };
    const calls: string[] = [];
    const initializedParams: unknown[] = [];
    const transport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      omitLiveOutputSegments: true,
      capabilities: {
        daemonManagement: { version: 1 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
      },
      onInitialize: (params) => initializedParams.push(params),
    });
    upgradeMocks.createSocketTransport.mockResolvedValueOnce(transport);
    upgradeMocks.readDaemonState.mockReturnValue({
      runtimeId: RUNTIME_ID,
      profile: PROFILE,
      pid: owner.pid,
      startedAt: owner.createdAt,
      endpoint: '\\\\.\\pipe\\kodax-upgrade-test',
      version: '0.7.90',
      status: 'ready',
      configHome,
    });
    upgradeMocks.readDaemonToken.mockReturnValue('daemon-token');
    upgradeMocks.readLockOwner.mockReturnValue(owner);
    upgradeMocks.readExitIntent.mockReturnValue(prepared);
    upgradeMocks.settleExit
      .mockResolvedValueOnce({
        status: 'blocked',
        reason: 'stop_not_accepted',
        nextAction: 'relaunch-space',
        message: 'Resume the retained prepared ticket.',
      })
      .mockResolvedValueOnce({ status: 'clean', repairs: [] });

    await expect(settleKodaXRuntimeExit({ configHome, profile: PROFILE })).resolves.toEqual({
      status: 'clean',
      repairs: [],
    });
    expect(initializedParams).toHaveLength(1);
    expect(initializedParams[0]).toMatchObject({
      connectionPurpose: 'client',
      autoStart: false,
      token: 'daemon-token',
      clientInfo: {
        name: 'kodax-sdk-exit-settlement',
        instanceId: expect.stringMatching(/^sdk_exit_/),
      },
    });
    expect(initializedParams[0]).not.toMatchObject({
      clientInfo: { instanceSecret: expect.any(String) },
    });
    expect(upgradeMocks.settleExit).toHaveBeenNthCalledWith(2, {
      configHome,
      profile: PROFILE,
      runtime: expect.objectContaining({
        identity: expect.objectContaining({ runtimeId: RUNTIME_ID }),
      }),
    });
  });

  it.each([
    ['kind', { kind: 'inline' as const }],
    ['process containment', { processContainment: undefined }],
    ['supervisor PID', { supervisorPid: 202 }],
    ['supervisor process identity', { supervisorProcessStartIdentity: 'replacement-102' }],
  ])('rejects a prepared exit ticket whose %s identity changed before attach', async (
    _label,
    changedOwner,
  ) => {
    const configHome = path.join('C:', 'kodax-upgrade-test', '.kodax');
    const owner = {
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon' as const,
      processStartIdentity: 'process-start-101',
      processContainment: 'windows-job' as const,
      supervisorPid: 102,
      supervisorProcessStartIdentity: 'process-start-102',
    };
    upgradeMocks.readExitIntent.mockReturnValue({
      version: 1,
      settlementId: 'settlement_changed_owner',
      owner,
      phase: 'prepared',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:01.000Z',
    });
    upgradeMocks.readLockOwner.mockReturnValue({ ...owner, ...changedOwner });
    upgradeMocks.readDaemonState.mockReturnValue({
      runtimeId: RUNTIME_ID,
      profile: PROFILE,
      pid: owner.pid,
      startedAt: owner.createdAt,
      endpoint: '\\\\.\\pipe\\kodax-upgrade-test',
      version: '0.7.90',
      status: 'ready',
      configHome,
    });
    upgradeMocks.readDaemonToken.mockReturnValue('daemon-token');
    upgradeMocks.createSocketTransport.mockResolvedValue(createLegacyTransport({
      preflight: createPreflight(),
      calls: [],
      close: vi.fn(async () => undefined),
      omitLiveOutputSegments: true,
      capabilities: { daemonManagement: { version: 1 } },
    }));
    upgradeMocks.settleExit.mockResolvedValueOnce({
      status: 'blocked',
      reason: 'stop_not_accepted',
      nextAction: 'relaunch-space',
      message: 'Resume the retained prepared ticket.',
    });

    await expect(settleKodaXRuntimeExit({ configHome, profile: PROFILE })).resolves.toEqual({
      status: 'blocked',
      reason: 'owner_changed',
      nextAction: 'relaunch-space',
      message: 'The prepared Runtime exit ticket no longer matches the exact daemon owner.',
    });
    expect(upgradeMocks.createSocketTransport).not.toHaveBeenCalled();
    expect(upgradeMocks.settleExit).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary attach-only clients behind the full execution contract', async () => {
    const calls: string[] = [];
    const transport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      omitLiveOutputSegments: true,
      capabilities: {
        daemonManagement: { version: 1 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
      },
    });

    await expect(connectKodaXRuntime({
      autoStart: false,
      profile: PROFILE,
      transport,
    })).rejects.toMatchObject({
      code: 'daemon_capability_upgrade_required',
      capability: 'liveOutputSegments',
    });
  });

  it('returns a recoverable error without stopping a busy legacy daemon', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight({
        blockers: ['queued_runs'],
        canStop: false,
      }),
      calls,
      close: vi.fn(async () => undefined),
    });
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(
      createLease(oldTransport),
    );

    let failure: unknown;
    try {
      await connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RuntimeDaemonCapabilityUpgradeError);
    expect(failure).toMatchObject({
      code: 'daemon_capability_upgrade_required',
      recoverable: true,
      restartRequired: true,
      capability: 'runtimeAutoModeGuardrail',
      preflight: {
        blockers: ['queued_runs'],
        canStop: false,
      },
    });
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:close',
    ]);
    expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(1);
    expect(upgradeMocks.enableDaemonOwner).not.toHaveBeenCalled();
  });

  it('fails closed instead of replacing a busy daemon whose conversation history is v1', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight({
        blockers: ['active_runs'],
        canStop: false,
      }),
      calls,
      close: vi.fn(async () => undefined),
      capabilities: {
        conversationHistory: { version: 1 },
        daemonManagement: { version: 1 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
        runtimeEventCoalescing: { version: 1 },
        sandboxRuntime: { version: 9 },
      },
    });
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(oldTransport));

    await expect(
      connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
        requirements: { conversationHistory: 2 },
      }),
    ).rejects.toMatchObject({
      code: 'daemon_capability_upgrade_required',
      recoverable: true,
      restartRequired: true,
      capability: 'conversationHistory',
      preflight: {
        blockers: ['active_runs'],
        canStop: false,
      },
    });
    expect(calls).toEqual(['old:initialize', 'old:daemon.management.get', 'old:close']);
    expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(1);
    expect(upgradeMocks.enableDaemonOwner).not.toHaveBeenCalled();
  });

  it('refuses to replace a busy daemon that only lacks Runtime event coalescing', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight({
        blockers: ['active_runs'],
        canStop: false,
      }),
      calls,
      close: vi.fn(async () => undefined),
      capabilities: {
        daemonManagement: { version: 1 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
      },
    });
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(
      createLease(oldTransport),
    );

    let failure: unknown;
    try {
      await connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RuntimeDaemonCapabilityUpgradeError);
    expect(failure).toMatchObject({
      code: 'daemon_capability_upgrade_required',
      recoverable: true,
      restartRequired: true,
      capability: 'runtimeEventCoalescing',
      preflight: {
        blockers: ['active_runs'],
        canStop: false,
      },
    });
    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:close',
    ]);
    expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(1);
    expect(upgradeMocks.enableDaemonOwner).not.toHaveBeenCalled();
  });

  it('keeps daemon ownership disabled when a stopped Windows daemon does not prove shutdown', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
    });
    const oldLease = createLease(oldTransport);
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(oldLease);
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });
    upgradeMocks.settleExit.mockImplementationOnce(async (input: {
      runtime: {
        daemon: { stopForInline(request: Record<string, unknown>): Promise<unknown> };
        close(): Promise<void>;
      };
    }) => {
      await input.runtime.daemon.stopForInline({
        expectedRuntimeId: RUNTIME_ID,
        expectedRevision: 7,
        expectedOwnerPolicyRevision: 3,
      });
      await input.runtime.close();
      return {
        status: 'blocked',
        reason: 'cleanup_unverified',
        nextAction: 'relaunch-space',
        message: 'Runtime daemon is still active.',
      } as const;
    });

    await expect(
      connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
        daemonStartupTimeoutMs: 1,
      }),
    ).rejects.toMatchObject({
      code: 'daemon_capability_upgrade_required',
      restartRequired: true,
    });

    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
    ]);
    expect(upgradeMocks.settleExit).toHaveBeenCalledWith({
      configHome: oldLease.paths.configHome,
      profile: PROFILE,
      runtime: expect.any(Object),
    });
  });

  it('points recovery failures to the public SDK owner API', async () => {
    const calls: string[] = [];
    const oldTransport = createLegacyTransport({
      preflight: createPreflight(),
      calls,
      close: vi.fn(async () => undefined),
      onRollback: () => upgradeMocks.readLockOwner.mockReturnValue(undefined),
    });
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(
      createLease(oldTransport),
    );
    upgradeMocks.readLockOwner.mockReturnValue({
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
    });
    upgradeMocks.settleExit.mockImplementationOnce(async (input: {
      runtime: {
        daemon: { stopForInline(request: Record<string, unknown>): Promise<unknown> };
        close(): Promise<void>;
      };
    }) => {
      await input.runtime.daemon.stopForInline({
        expectedRuntimeId: RUNTIME_ID,
        expectedRevision: 7,
        expectedOwnerPolicyRevision: 3,
      });
      await input.runtime.close();
      return {
        status: 'blocked',
        reason: 'cleanup_failed',
        nextAction: 'relaunch-space',
        message: 'Owner policy recovery failed; relaunch to resume the durable settlement.',
      } as const;
    });

    await expect(
      connectKodaXRuntime({
        autoStart: true,
        profile: PROFILE,
        homeDir: path.join('C:', 'kodax-upgrade-test'),
      }),
    ).rejects.toThrow('relaunch to resume the durable settlement');

    expect(calls).toEqual([
      'old:initialize',
      'old:daemon.management.get',
      'old:daemon.rollbackToInline',
      'old:close',
    ]);
  });
});

function createLegacyTransport(input: {
  readonly preflight: RuntimeDaemonPreflight;
  readonly calls: string[];
  readonly close: () => Promise<void>;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly omitLiveOutputSegments?: boolean;
  readonly onInitialize?: (params: unknown) => void;
  readonly onRollback?: () => void;
}): RuntimeDaemonClientTransport {
  return {
    async request(method, params) {
      input.calls.push(`old:${method}`);
      if (method === 'initialize') {
        input.onInitialize?.(params);
        return initializeResult(
          RUNTIME_ID,
          {
            actorSettlementConvergence: { version: 2 },
            crashOutcomeModel: { version: 2 },
            managedRunDurability: { version: 1 },
            sessionEventJournal: { version: 1 },
            sharedSessionSettings: { version: 2 },
            ...(input.omitLiveOutputSegments
              ? {}
              : { liveOutputSegments: { version: 1 } }),
            ...(process.platform === 'win32'
              ? { daemonShutdownVerification: { version: 1 } }
              : {}),
            ...(input.capabilities ?? {
              daemonManagement: { version: 1 },
              runtimeAutoModeGuardrail: { version: 1, owner: 'session-runtime' },
            }),
          },
        );
      }
      if (method === 'daemon.management.get') {
        return createManagementState(input.preflight);
      }
      if (method === 'daemon.rollbackToInline') {
        input.onRollback?.();
        return {
          accepted: true,
          runtimeId: RUNTIME_ID,
          revision: 8,
          ownerPolicy: {
            mode: 'inline',
            revision: 4,
            updatedAt: '2026-07-19T00:00:01.000Z',
          },
        };
      }
      throw new Error(`Unexpected legacy daemon request: ${method}`);
    },
    subscribe() {
      return { close() {} };
    },
    async close() {
      input.calls.push('old:close');
      await input.close();
    },
  };
}

function createCurrentTransport(
  calls: string[],
  close: () => Promise<void>,
): RuntimeDaemonClientTransport {
  return {
    async request(method) {
      calls.push(`new:${method}`);
      if (method !== 'initialize') {
        throw new Error(`Unexpected current daemon request: ${method}`);
      }
      return initializeResult('runtime_current', {
        actorSettlementConvergence: { version: 2 },
        conversationHistory: { version: 2 },
        crashOutcomeModel: { version: 2 },
        daemonClientInventory: { version: 1 },
        daemonManagement: { version: 1 },
        managedRunDurability: { version: 1 },
        liveOutputSegments: { version: 1 },
        sandboxRuntime: { version: 9 },
        sessionEventJournal: { version: 1 },
        sharedSessionSettings: { version: 2 },
        runtimeAutoModeGuardrail: { version: 5, owner: 'session-runtime' },
        runtimeEventCoalescing: { version: 1 },
        ...(process.platform === 'win32'
          ? { daemonShutdownVerification: { version: 1 } }
          : {}),
        daemonOrphanExit: {
          version: 1,
          idleOnly: true,
          bootstrapGrace: true,
        },
      });
    },
    subscribe() {
      return { close() {} };
    },
    async close() {
      calls.push('new:close');
      await close();
    },
  };
}

function initializeResult(
  runtimeId: string,
  capabilities: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    identity: {
      runtimeId,
      mode: 'daemon',
      profile: PROFILE,
      startedAt: '2026-07-19T00:00:00.000Z',
      version: runtimeId === RUNTIME_ID ? '0.7.85' : '0.7.86',
      isolation: 'process',
    },
    capabilities,
  };
}

function createManagementState(
  preflight: RuntimeDaemonPreflight,
): RuntimeDaemonManagementState {
  return {
    runtimeId: RUNTIME_ID,
    revision: 7,
    ownerPolicy: {
      mode: 'daemon',
      revision: 3,
      updatedAt: '2026-07-19T00:00:00.000Z',
    },
    owner: {
      runtimeId: RUNTIME_ID,
      pid: 101,
      createdAt: '2026-07-19T00:00:00.000Z',
      kind: 'daemon',
      ...(process.platform === 'win32'
        ? { processContainment: 'windows-job' as const, supervisorPid: 102 }
        : {}),
    },
    preflight,
  };
}

function createPreflight(
  overrides: Partial<RuntimeDaemonPreflight> = {},
): RuntimeDaemonPreflight {
  const activeAgentTurns: RuntimeDaemonPreflight['activeAgentTurns'] = [];
  return {
    runtimeId: RUNTIME_ID,
    clientCount: 1,
    activeRuns: [],
    queuedRuns: [],
    activeWorkflows: [],
    activeAgentTurns,
    activeAgentTasks: activeAgentTurns,
    pendingPermissions: [],
    pendingUserInputs: [],
    blockers: [],
    canStop: true,
    ...overrides,
  };
}

function createLease(
  transport: RuntimeDaemonClientTransport,
  probeInitialization?: unknown,
): RuntimeDaemonProcessLease {
  const rootDir = path.join(
    'C:',
    'kodax-upgrade-test',
    '.kodax',
    'runtime',
    PROFILE,
  );
  const paths: RuntimeDaemonPaths = {
    profile: PROFILE,
    configHome: path.join('C:', 'kodax-upgrade-test', '.kodax'),
    rootDir,
    stateFile: path.join(rootDir, 'daemon.json'),
    lockFile: path.join(rootDir, 'daemon.lock'),
    tokenFile: path.join(rootDir, 'daemon.token'),
    logFile: path.join(rootDir, 'daemon.log'),
    runsDir: path.join(rootDir, 'runs'),
    eventsDir: path.join(rootDir, 'events'),
    ownerPolicyFile: path.join(rootDir, 'owner-policy.json'),
    ownerPolicyLockFile: path.join(rootDir, 'owner-policy.lock'),
  };
  return {
    transport,
    paths,
    endpoint: { kind: 'pipe', path: '\\\\.\\pipe\\kodax-upgrade-test' },
    ownsHost: false,
    ...(probeInitialization === undefined ? {} : { probeInitialization }),
    async close() {
      await transport.close?.();
    },
    async shutdown() {
      await transport.close?.();
    },
  };
}
