import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KODAX_VERSION } from '@kodax-ai/repl';
import { LOCAL_RUNTIME_BUILD, type RuntimeBuildIdentity } from './runtime-build-identity.js';

const upgradeMocks = vi.hoisted(() => ({
  acquireProcessLease: vi.fn(),
  createSocketTransport: vi.fn(),
  enableDaemonOwner: vi.fn(),
  readDaemonState: vi.fn(),
  readDaemonToken: vi.fn(),
  readLockOwner: vi.fn(),
  waitOwnerExit: vi.fn(),
  localBuild: { origin: '/fixture/kodax/dist/kodax_cli.js', fingerprint: 'a'.repeat(64) },
  readBuild: vi.fn(),
}));

vi.mock('./runtime-build-identity.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./runtime-build-identity.js')>(),
  LOCAL_RUNTIME_BUILD: upgradeMocks.localBuild,
  readRuntimeBuildIdentity: upgradeMocks.readBuild,
}));

vi.mock('./runtime-daemon/process.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./runtime-daemon/process.js')>();
  return {
    ...actual,
    acquireRuntimeDaemonProcessLease: upgradeMocks.acquireProcessLease,
    waitForRuntimeDaemonOwnerExit: upgradeMocks.waitOwnerExit,
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

import {
  connectKodaXRuntime,
  ensureKodaXRuntime,
  createKodaXRuntime,
  type RuntimeDaemonManagementState,
  type RuntimeDaemonPreflight,
} from './sdk-runtime.js';
import type { RuntimeDaemonClientTransport } from './runtime-daemon/client.js';
import type { RuntimeDaemonProcessLease } from './runtime-daemon/process.js';
import type { RuntimeDaemonPaths } from './runtime-daemon/state.js';

const PROFILE = 'upgrade-test';
const RUNTIME_ID = 'runtime_legacy';
const CURRENT_VERSION_CORE = /^(\d+)\.(\d+)\.(\d+)/.exec(KODAX_VERSION);
if (CURRENT_VERSION_CORE === null) {
  throw new Error(`Test requires a Semantic Version KODAX_VERSION, received ${KODAX_VERSION}.`);
}
const CURRENT_MAJOR = BigInt(CURRENT_VERSION_CORE[1]!);
const CURRENT_MINOR = BigInt(CURRENT_VERSION_CORE[2]!);
const CURRENT_PATCH = BigInt(CURRENT_VERSION_CORE[3]!);
const CURRENT_NUMBERED_PRERELEASE = /^(\d+)\.(\d+)\.(\d+)-([0-9A-Za-z-]+)\.(\d+)$/.exec(
  KODAX_VERSION,
);
const OLDER_RUNTIME_VERSION = CURRENT_NUMBERED_PRERELEASE !== null
  && BigInt(CURRENT_NUMBERED_PRERELEASE[5]!) > 0n
  ? `${CURRENT_NUMBERED_PRERELEASE[1]}.${CURRENT_NUMBERED_PRERELEASE[2]}`
    + `.${CURRENT_NUMBERED_PRERELEASE[3]}-${CURRENT_NUMBERED_PRERELEASE[4]}`
    + `.${BigInt(CURRENT_NUMBERED_PRERELEASE[5]!) - 1n}`
  : CURRENT_PATCH > 0n
    ? `${CURRENT_MAJOR}.${CURRENT_MINOR}.${CURRENT_PATCH - 1n}+fixture`
    : CURRENT_MINOR > 0n
      ? `${CURRENT_MAJOR}.${CURRENT_MINOR - 1n}.0+fixture`
      : `${CURRENT_MAJOR - 1n}.0.0+fixture`;
const NEWER_RUNTIME_VERSION = `${CURRENT_MAJOR + 1n}.0.0`;

describe('product Host startup and passive connection', () => {
  beforeEach(() => {
    upgradeMocks.readBuild.mockReset().mockReturnValue(upgradeMocks.localBuild);
    upgradeMocks.waitOwnerExit.mockReset().mockResolvedValue(undefined);
    upgradeMocks.acquireProcessLease.mockReset();
    upgradeMocks.createSocketTransport.mockReset();
    upgradeMocks.enableDaemonOwner.mockReset();
    upgradeMocks.readDaemonState.mockReset();
    upgradeMocks.readDaemonToken.mockReset();
    upgradeMocks.readLockOwner.mockReset();

  });

  it('refreshes an idle older Host by normal shutdown and waits for its process before starting', async () => {
    const calls: string[] = [];
    const old = createLegacyTransport({ preflight: createPreflight(), calls, close: async () => undefined });
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(old))
      .mockImplementationOnce(async () => {
        expect(upgradeMocks.waitOwnerExit).toHaveBeenCalledTimes(1);
        return createLease(createCurrentTransport(calls, async () => undefined));
      });
    upgradeMocks.readLockOwner.mockReturnValue(createManagementState(createPreflight()).owner);
    const runtime = await ensureKodaXRuntime({ profile: PROFILE });
    expect(calls).toEqual(['old:initialize', 'old:daemon.management.get', 'old:runtime.shutdown', 'old:close', 'new:initialize']);
    expect(upgradeMocks.enableDaemonOwner).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('reports unconfirmed owner exit when managed shutdown consumes the startup deadline', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const old = createLegacyTransport({ preflight: createPreflight(), calls, close: async () => undefined });
      upgradeMocks.acquireProcessLease.mockResolvedValue(createLease({
        ...old,
        async request(method, params) {
          const result = await old.request(method, params);
          if (method === 'runtime.shutdown') vi.setSystemTime(Date.now() + 500);
          return result;
        },
      }));
      upgradeMocks.readLockOwner.mockReturnValue(createManagementState(createPreflight()).owner);
      await expect(ensureKodaXRuntime({ profile: PROFILE, daemonStartupTimeoutMs: 500 }))
        .rejects.toThrow('Host startup timed out before owner exit could be confirmed');
      expect(upgradeMocks.waitOwnerExit).not.toHaveBeenCalled();
      expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(1);
      expect(calls.filter((call) => call === 'old:close')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('preserves automatic idle refresh for the existing daemon launcher', async () => {
    const calls: string[] = [];
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(createLegacyTransport({ preflight: createPreflight(), calls, close: async () => undefined })))
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, async () => undefined)));
    upgradeMocks.readLockOwner.mockReturnValue(createManagementState(createPreflight()).owner);
    const runtime = await createKodaXRuntime({ mode: 'daemon', profile: PROFILE });
    expect(calls).toContain('old:runtime.shutdown');
    expect(upgradeMocks.waitOwnerExit).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it('refreshes the same version from changed files in the same installation before attaching', async () => {
    const calls: string[] = [];
    const current = await createCurrentTransport([], async () => undefined).request('initialize') as { capabilities: Record<string, unknown> };
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(createLegacyTransport({
        preflight: createPreflight(), calls, close: async () => undefined,
        runtimeVersion: KODAX_VERSION, capabilities: current.capabilities,
        build: { ...LOCAL_RUNTIME_BUILD, fingerprint: '0'.repeat(64) },
      })))
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, async () => undefined)));
    upgradeMocks.readLockOwner.mockReturnValue(createManagementState(createPreflight()).owner);
    const runtime = await ensureKodaXRuntime({ profile: PROFILE });
    try {
      expect(calls).toContain('old:runtime.shutdown');
      expect(upgradeMocks.waitOwnerExit).toHaveBeenCalledTimes(1);
      expect(runtime.identity.runtimeId).toBe('runtime_current');
    } finally { await runtime.close(); }
  });

  it('releases a transient competing connection and retries startup without an upgrade election', async () => {
    const calls: string[] = [];
    const competing = createLegacyTransport({
      preflight: createPreflight({ blockers: ['connected_clients'], canStop: false }), calls, close: async () => undefined,
    });
    const idle = createLegacyTransport({ preflight: createPreflight(), calls, close: async () => undefined });
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(competing))
      .mockResolvedValueOnce(createLease(idle))
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, async () => undefined)));
    upgradeMocks.readLockOwner.mockReturnValue(createManagementState(createPreflight()).owner);
    const runtime = await ensureKodaXRuntime({ profile: PROFILE });
    expect(calls.filter((call) => call === 'old:runtime.shutdown')).toHaveLength(1);
    await runtime.close();
  });

  it.each([
    { name: 'busy changed build', build: { ...LOCAL_RUNTIME_BUILD, fingerprint: '0'.repeat(64) }, busy: true },
    { name: 'another installation', build: { ...LOCAL_RUNTIME_BUILD, origin: '/other/kodax_cli.js' }, busy: false },
    { name: 'legacy missing identity', build: undefined, busy: false },
  ])('does not silently attach or stop a $name', async ({ build, busy }) => {
    const calls: string[] = [];
    const current = await createCurrentTransport([], async () => undefined).request('initialize') as { capabilities: Record<string, unknown> };
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(createLegacyTransport({
      preflight: createPreflight(busy ? { canStop: false, blockers: ['active_runs'] } : {}),
      calls, close: async () => undefined, runtimeVersion: KODAX_VERSION, capabilities: current.capabilities, build,
    })));
    await expect(ensureKodaXRuntime({ profile: PROFILE })).rejects.toMatchObject({
      code: 'daemon_capability_upgrade_required',
      ...(busy ? { preflight: { blockers: ['active_runs'] } } : {}),
    });
    expect(calls).not.toContain('old:runtime.shutdown');
    expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(1);
  });

  it('keeps passive clients compatible with a different build without replacing it', async () => {
    const calls: string[] = [];
    const current = await createCurrentTransport([], async () => undefined).request('initialize') as { capabilities: Record<string, unknown> };
    const runtime = await connectKodaXRuntime({ profile: PROFILE, transport: createLegacyTransport({
      preflight: createPreflight(), calls, close: async () => undefined, runtimeVersion: KODAX_VERSION,
      capabilities: current.capabilities, build: { ...LOCAL_RUNTIME_BUILD, fingerprint: '0'.repeat(64) },
    }) });
    try {
      expect(runtime.identity.runtimeId).toBe(RUNTIME_ID);
      expect(calls).toEqual(['old:initialize']);
      expect(upgradeMocks.acquireProcessLease).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
  });

  it('leaves the old Host alive when installation changes during the shutdown preflight', async () => {
    const calls: string[] = [];
    upgradeMocks.acquireProcessLease.mockResolvedValue(createLease(createLegacyTransport({
      preflight: createPreflight(), calls, close: async () => undefined,
    })));
    upgradeMocks.readLockOwner.mockReturnValue(createManagementState(createPreflight()).owner);
    upgradeMocks.readBuild.mockReturnValueOnce(LOCAL_RUNTIME_BUILD)
      .mockReturnValue({ ...LOCAL_RUNTIME_BUILD, fingerprint: 'b'.repeat(64) });
    await expect(ensureKodaXRuntime({ profile: PROFILE })).rejects.toThrow('Restart the calling process');
    expect(calls).toContain('old:daemon.management.get');
    expect(calls).not.toContain('old:runtime.shutdown');
    expect(upgradeMocks.waitOwnerExit).not.toHaveBeenCalled();
  });

  it.each(['ensure', 'connect'] as const)('bounds initialization conflict retries to the launcher (%s)', async mode => {
    const calls: string[] = [];
    const conflict = Object.assign(new Error('Attach rejected'), { code: 'conflict' });
    const rejected = createCurrentTransport(calls, async () => undefined);
    const conflicting = { ...rejected, request: async () => { throw conflict; } };
    // Draining admission can precede the asynchronous state-file update.
    upgradeMocks.readDaemonState.mockReturnValue({ status: 'ready' });
    upgradeMocks.acquireProcessLease
      .mockResolvedValueOnce(createLease(conflicting))
      .mockResolvedValueOnce(createLease(createCurrentTransport(calls, async () => undefined)));
    if (mode === 'connect') {
      upgradeMocks.createSocketTransport.mockResolvedValue(conflicting);
      await expect(connectKodaXRuntime({ profile: PROFILE })).rejects.toBe(conflict);
      expect(upgradeMocks.acquireProcessLease).not.toHaveBeenCalled();
      expect(upgradeMocks.createSocketTransport).toHaveBeenCalledTimes(1);
    } else {
      const client = await ensureKodaXRuntime({ profile: PROFILE });
      expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(2);
      await client.close();
    }
    expect(calls[0]).toBe('new:close');
  });

  it('refuses an already loaded launcher after its installation changes', async () => {
    upgradeMocks.readBuild.mockReturnValue({ ...LOCAL_RUNTIME_BUILD, fingerprint: '0'.repeat(64) });
    await expect(ensureKodaXRuntime({ profile: PROFILE })).rejects.toMatchObject({ capability: 'launcherBuild' });
    expect(upgradeMocks.acquireProcessLease).not.toHaveBeenCalled();
  });

  it.each(['active_runs', 'queued_runs', 'active_workflows', 'active_agent_turns', 'pending_interactions'] as const)(
    'leaves a Host with %s alive and reports its blocker', async (blocker) => {
      const calls: string[] = [];
      upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(createLegacyTransport({
        preflight: createPreflight({ blockers: [blocker], canStop: false }), calls, close: async () => undefined,
      })));
      await expect(ensureKodaXRuntime({ profile: PROFILE })).rejects.toMatchObject({
        code: 'daemon_capability_upgrade_required', preflight: { blockers: [blocker] },
      });
      expect(calls).toEqual(['old:initialize', 'old:daemon.management.get', 'old:close']);
      expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(1);
      expect(upgradeMocks.waitOwnerExit).not.toHaveBeenCalled();
    },
  );

  it('never starts or replaces a Host through passive connect', async () => {
    await expect(connectKodaXRuntime({ autoStart: true })).rejects.toThrow('ensureKodaXRuntime');
    expect(upgradeMocks.acquireProcessLease).not.toHaveBeenCalled();
  });

  it('bounds competing-client retries by the original startup deadline without shutting down a busy Host', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const calls: string[] = [];
    upgradeMocks.acquireProcessLease.mockImplementation(async () => createLease(createLegacyTransport({
      preflight: createPreflight({ blockers: ['connected_clients'], canStop: false }), calls, close: async () => undefined,
    })));
    try {
      const startedAt = Date.now();
      const pending = ensureKodaXRuntime({ profile: PROFILE, daemonStartupTimeoutMs: 500 })
        .then(() => { throw new Error('Busy Host unexpectedly accepted'); }, error => ({ error, settledAt: Date.now() }));
      await vi.advanceTimersByTimeAsync(500);
      const outcome = await pending;
      expect(outcome.error).toMatchObject({ preflight: { blockers: ['connected_clients'] } });
      expect(outcome.settledAt - startedAt).toBe(500);
      expect(upgradeMocks.acquireProcessLease.mock.calls.length).toBeGreaterThan(3);
      expect(calls.filter(call => call === 'old:close')).toHaveLength(upgradeMocks.acquireProcessLease.mock.calls.length);
      expect(calls).not.toContain('old:runtime.shutdown');
      const budgets = upgradeMocks.acquireProcessLease.mock.calls.map(([options]) => options.startupTimeoutMs as number);
      expect(budgets[0]).toBe(500);
      expect(budgets.at(-1)).toBeLessThan(500);
    } finally { random.mockRestore(); vi.useRealTimers(); }
  });

  it('cancels contention backoff after closing the temporary client without another attach', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const calls: string[] = [];
    upgradeMocks.acquireProcessLease.mockImplementation(async () => createLease(createLegacyTransport({
      preflight: createPreflight({ blockers: ['connected_clients'], canStop: false }), calls,
      close: async () => { setTimeout(() => controller.abort(), 25); },
    })));
    try {
      const pending = ensureKodaXRuntime({ profile: PROFILE, daemonStartupSignal: controller.signal })
        .then(() => { throw new Error('Cancelled launcher unexpectedly accepted'); }, error => error as unknown);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toMatchObject({ name: 'AbortError' });
      expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(1);
      expect(calls.filter(call => call === 'old:close')).toHaveLength(1);
      expect(calls).not.toContain('old:runtime.shutdown');
    } finally { vi.useRealTimers(); }
  });

  it('allows passive connection to an older Host whose execution contract is compatible', async () => {
    const current = createCurrentTransport([], async () => undefined);
    const transport: RuntimeDaemonClientTransport = {
      ...current,
      async request(method, params) {
        const result = await current.request(method, params) as { readonly identity: Record<string, unknown> };
        return { ...result, identity: { ...result.identity, version: OLDER_RUNTIME_VERSION } };
      },
    };
    const runtime = await connectKodaXRuntime({ profile: PROFILE, transport });
    expect(runtime.identity.version).toBe(OLDER_RUNTIME_VERSION);
    expect(upgradeMocks.acquireProcessLease).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('rejects an incompatible passive connection without stopping its Host', async () => {
    const calls: string[] = [];
    const transport = createLegacyTransport({ preflight: createPreflight(), calls, close: async () => undefined });
    await expect(connectKodaXRuntime({ profile: PROFILE, transport })).rejects.toMatchObject({ code: 'daemon_capability_upgrade_required' });
    expect(calls).toEqual(['old:initialize', 'old:close']);
  });

  it.each([NEWER_RUNTIME_VERSION, KODAX_VERSION, 'unversioned-owner'])(
    'never replaces an incompatible Host with version %s', async (runtimeVersion) => {
      const calls: string[] = [];
      upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(createLegacyTransport({
        preflight: createPreflight(), calls, close: async () => undefined, runtimeVersion,
      })));
      await expect(ensureKodaXRuntime({ profile: PROFILE })).rejects.toMatchObject({ code: 'daemon_capability_upgrade_required' });
      expect(calls).not.toContain('old:runtime.shutdown');
      expect(upgradeMocks.waitOwnerExit).not.toHaveBeenCalled();
      expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(1);
    },
  );

  it.each([NEWER_RUNTIME_VERSION, '0.0.0'])(
    'attaches to compatible %s without replacement', async (version) => {
      const current = createCurrentTransport([], async () => undefined);
      const transport: RuntimeDaemonClientTransport = {
        ...current,
        async request(method, params) {
          const result = await current.request(method, params) as { readonly identity: Record<string, unknown> };
          return { ...result, identity: { ...result.identity, version } };
        },
      };
      upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(transport));
      const runtime = await ensureKodaXRuntime({ profile: PROFILE });
      expect(runtime.identity.version).toBe(version);
      expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(1);
      expect(upgradeMocks.waitOwnerExit).not.toHaveBeenCalled();
      await runtime.close();
    },
  );

  it('requires normal management support before stopping an older Host', async () => {
    const calls: string[] = [];
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(createLegacyTransport({
      preflight: createPreflight(), calls, close: async () => undefined, capabilities: {},
    })));
    await expect(ensureKodaXRuntime({ profile: PROFILE })).rejects.toThrow('normal managed shutdown');
    expect(calls).toEqual(['old:initialize', 'old:close']);
  });

  it.each([undefined, { ...createManagementState(createPreflight()).owner, runtimeId: 'replaced' }])(
    'refuses a missing or changed owner before shutdown', async (owner) => {
      const calls: string[] = [];
      upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(createLegacyTransport({ preflight: createPreflight(), calls, close: async () => undefined })));
      upgradeMocks.readLockOwner.mockReturnValue(owner);
      await expect(ensureKodaXRuntime({ profile: PROFILE })).rejects.toThrow('process identity');
      expect(calls).not.toContain('old:runtime.shutdown');
      expect(upgradeMocks.waitOwnerExit).not.toHaveBeenCalled();
    },
  );

  it('does not restart when the old Host process has not exited', async () => {
    const calls: string[] = [];
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(createLegacyTransport({ preflight: createPreflight(), calls, close: async () => undefined })));
    upgradeMocks.readLockOwner.mockReturnValue(createManagementState(createPreflight()).owner);
    upgradeMocks.waitOwnerExit.mockRejectedValueOnce(new Error('Host is still running'));
    await expect(ensureKodaXRuntime({ profile: PROFILE })).rejects.toThrow('still running');
    expect(calls).toContain('old:runtime.shutdown');
    expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(1);
    expect(upgradeMocks.enableDaemonOwner).not.toHaveBeenCalled();
  });

  it('does not restart after shutdown was refused at the draining boundary', async () => {
    const calls: string[] = [];
    const base = createLegacyTransport({ preflight: createPreflight(), calls, close: async () => undefined });
    const transport: RuntimeDaemonClientTransport = {
      ...base,
      async request(method, params) {
        if (method === 'runtime.shutdown') throw new Error('Host became busy');
        return base.request(method, params);
      },
    };
    upgradeMocks.acquireProcessLease.mockResolvedValueOnce(createLease(transport));
    upgradeMocks.readLockOwner.mockReturnValue(createManagementState(createPreflight()).owner);
    await expect(ensureKodaXRuntime({ profile: PROFILE })).rejects.toThrow('Host became busy');
    expect(upgradeMocks.acquireProcessLease).toHaveBeenCalledTimes(1);
    expect(upgradeMocks.waitOwnerExit).not.toHaveBeenCalled();
  });
});

function createLegacyTransport(input: {
  readonly preflight: RuntimeDaemonPreflight;
  readonly calls: string[];
  readonly close: () => Promise<void>;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly runtimeVersion?: string;
  readonly build?: RuntimeBuildIdentity;
  readonly omitLiveOutputSegments?: boolean;
  readonly onInitialize?: (params: unknown) => void;
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
          input.runtimeVersion,
          input.build,
        );
      }
      if (method === 'daemon.management.get') {
        return createManagementState(input.preflight);
      }
      if (method === 'runtime.shutdown') return { ok: true };
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
        sandboxRuntime: { version: 11 },
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
      }, KODAX_VERSION, LOCAL_RUNTIME_BUILD);
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
  version = runtimeId === RUNTIME_ID ? '0.7.85' : '0.7.86',
  build?: RuntimeBuildIdentity,
): Readonly<Record<string, unknown>> {
  return {
    identity: {
      runtimeId,
      mode: 'daemon',
      profile: PROFILE,
      startedAt: '2026-07-19T00:00:00.000Z',
      version,
      ...(build ? { build } : {}),
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
      processStartIdentity: '101',
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
