import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentActorController,
  createAgentActorController,
  type AgentActorSaveAttempt,
  type AgentActorSavePhase,
  type AgentActorSnapshot,
  type AgentActorStore,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentTurnExecutor,
} from './index.js';

const OWNER = {
  ownerId: 'actor-owner-ambiguous',
  runtimeId: 'runtime-ambiguous',
  pid: 303,
  startedAt: '2026-11-17T00:00:00.000Z',
} as const;

/** `landed`: the rename reached disk but the store could not prove it. */
type NextSave = 'landed' | 'lost' | 'hang';

class DeferredExecutor implements AgentTurnExecutor {
  readonly inputs: AgentExecutionInput[] = [];

  execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    this.inputs.push(input);
    return new Promise(() => undefined);
  }
}

function conflict(expectedRevision: number, currentRevision: number): Error {
  return Object.assign(new Error('synthetic Actor revision conflict'), {
    code: 'actor_snapshot_conflict' as const,
    expectedRevision,
    currentRevision,
  });
}

/** Phase-aware fake whose next save can end ambiguously in commit_inflight. */
function ambiguousStore() {
  let saved: AgentActorSnapshot | undefined;
  let next: NextSave | undefined;
  let failReadback = false;
  let failedLoads = 0;
  let releaseHang: (() => void) | undefined;
  const beginSave = (snapshot: AgentActorSnapshot, expectedRevision: number): AgentActorSaveAttempt => {
    const mode = next;
    next = undefined;
    let phase: AgentActorSavePhase = 'precommit';
    const hang = new Promise<void>((resolve) => { releaseHang = resolve; });
    const canonical = Promise.resolve().then(async () => {
      const currentRevision = saved?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        phase = 'not_committed';
        throw conflict(expectedRevision, currentRevision);
      }
      phase = 'commit_inflight';
      if (mode === 'hang') {
        await hang;
        phase = 'not_committed';
        throw new Error('slow rename was rolled back');
      }
      if (mode !== 'lost') saved = structuredClone(snapshot);
      if (mode !== undefined) {
        if (failReadback) failedLoads = 1;
        failReadback = false;
        throw new Error('rename failed and canonical readback was unavailable');
      }
      phase = 'committed';
    });
    return {
      dequeued: Promise.resolve(),
      eligible: Promise.resolve(),
      canonical,
      completion: canonical,
      phase: () => phase,
      cancelBeforeCommit: () => false,
      diagnostics: () => ({ attemptId: `fake-${expectedRevision + 1}`, phase, timingsMs: {} }),
    };
  };
  const store: AgentActorStore = {
    async load() {
      if (failedLoads > 0) {
        failedLoads -= 1;
        throw new Error('session file is locked');
      }
      return saved === undefined ? undefined : structuredClone(saved);
    },
    async save(snapshot, expectedRevision) {
      await beginSave(snapshot, expectedRevision).canonical;
    },
    beginSave,
  };
  return {
    store,
    saved: () => saved,
    nextSave: (mode: NextSave, readbackFails = false) => {
      next = mode;
      failReadback = readbackFails;
    },
    releaseHang: () => releaseHang?.(),
  };
}

/** Legacy fake: save() has no phases, so a rejection says nothing about the write. */
function legacyStoreThatLandsThenThrows() {
  let saved: AgentActorSnapshot | undefined;
  let throwAfterWrite = false;
  const store: AgentActorStore = {
    async load() { return saved === undefined ? undefined : structuredClone(saved); },
    async save(snapshot, expectedRevision) {
      const currentRevision = saved?.revision ?? 0;
      if (currentRevision !== expectedRevision) throw conflict(expectedRevision, currentRevision);
      saved = structuredClone(snapshot);
      if (throwAfterWrite) {
        throwAfterWrite = false;
        throw new Error('fsync after rename failed');
      }
    },
  };
  return { store, saved: () => saved, throwAfterNextWrite: () => { throwAfterWrite = true; } };
}

/**
 * Remote store whose client gives up before the server commits. The call
 * rejects, readback still shows the old snapshot, and the write lands later.
 */
function storeThatCommitsAfterClientTimeout(phaseAware: boolean) {
  let saved: AgentActorSnapshot | undefined;
  let timeoutNext = false;
  let lateWrite: AgentActorSnapshot | undefined;
  const save = async (snapshot: AgentActorSnapshot, expectedRevision: number): Promise<void> => {
    const currentRevision = saved?.revision ?? 0;
    if (currentRevision !== expectedRevision) throw conflict(expectedRevision, currentRevision);
    if (timeoutNext) {
      timeoutNext = false;
      lateWrite = structuredClone(snapshot);
      throw new Error('client timed out before the server answered');
    }
    saved = structuredClone(snapshot);
  };
  const beginSave = (snapshot: AgentActorSnapshot, expectedRevision: number): AgentActorSaveAttempt => {
    let phase: AgentActorSavePhase = 'commit_inflight';
    const canonical = Promise.resolve().then(async () => {
      if ((saved?.revision ?? 0) !== expectedRevision) phase = 'not_committed';
      await save(snapshot, expectedRevision);
      phase = 'committed';
    });
    return {
      dequeued: Promise.resolve(),
      eligible: Promise.resolve(),
      canonical,
      completion: canonical,
      phase: () => phase,
      cancelBeforeCommit: () => false,
      diagnostics: () => ({ attemptId: `remote-${expectedRevision + 1}`, phase, timingsMs: {} }),
    };
  };
  const store: AgentActorStore = {
    async load() { return saved === undefined ? undefined : structuredClone(saved); },
    save,
    ...(phaseAware ? { beginSave } : {}),
  };
  return {
    store,
    saved: () => saved,
    overwrite: (snapshot: AgentActorSnapshot) => { saved = structuredClone(snapshot); },
    timeoutNextSave: () => { timeoutNext = true; },
    landLateWrite: () => {
      if (lateWrite !== undefined) saved = lateWrite;
      lateWrite = undefined;
    },
  };
}

function reorderKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reorderKeys) as T;
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value).reverse().map(([key, item]) => [key, reorderKeys(item)]);
  return Object.fromEntries(entries) as T;
}

function durableState(snapshot: AgentActorSnapshot | undefined, turnId: string): string | undefined {
  return snapshot?.turns.find((turn) => turn.turnId === turnId)?.state;
}

describe('Actor writes whose outcome is ambiguous', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps an interrupt whose commit landed and keeps owning the fence', async () => {
    const fixture = ambiguousStore();
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      store: fixture.store,
      owner: OWNER,
      executor,
      isOwnerAlive: async () => true,
    });
    const worker = await controller.spawn('/root', { taskName: 'worker', objective: 'Run.' });
    await Promise.resolve();

    fixture.nextSave('landed');
    const interrupted = await controller.interrupt('/root', worker.actorPath, 'user stop').then(
      () => 'interrupted',
      (error: unknown) => error,
    );
    const next = await controller.spawn('/root', { taskName: 'next', objective: 'Continue.' }).then(
      (ref) => ref.actorPath,
      (error: unknown) => error,
    );

    // Today the rolled-back interrupt makes this save conflict with its own write.
    expect(next).toBe('/root/next');
    expect(controller.ownsDurableFence()).toBe(true);
    expect(interrupted).toBe('interrupted');
    expect(durableState(fixture.saved(), worker.turnId)).toBe('interrupted');
    expect(controller.output('/root', worker.actorPath, worker.turnId).state).toBe('interrupted');
    expect(executor.inputs[0]?.signal.aborted).toBe(true);
    expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
  });

  it('classifies a legacy save that wrote and then threw as committed', async () => {
    const fixture = legacyStoreThatLandsThenThrows();
    const controller = await createAgentActorController({
      store: fixture.store,
      owner: OWNER,
      executor: new DeferredExecutor(),
      isOwnerAlive: async () => true,
    });
    const worker = await controller.spawn('/root', { taskName: 'worker', objective: 'Run.' });

    fixture.throwAfterNextWrite();
    const interrupted = await controller.interrupt('/root', worker.actorPath).then(
      () => 'interrupted',
      (error: unknown) => error,
    );
    const next = await controller.spawn('/root', { taskName: 'next', objective: 'Continue.' }).then(
      (ref) => ref.actorPath,
      (error: unknown) => error,
    );

    expect(next).toBe('/root/next');
    expect(controller.ownsDurableFence()).toBe(true);
    expect(interrupted).toBe('interrupted');
  });

  it('keeps a definitely lost write a plain, retryable failure', async () => {
    const fixture = ambiguousStore();
    const controller = await createAgentActorController({
      store: fixture.store,
      owner: OWNER,
      executor: new DeferredExecutor(),
      isOwnerAlive: async () => true,
    });
    const worker = await controller.spawn('/root', { taskName: 'worker', objective: 'Run.' });

    fixture.nextSave('lost');
    await expect(controller.interrupt('/root', worker.actorPath)).rejects.toThrow('rename failed');
    expect(controller.output('/root', worker.actorPath, worker.turnId).state).toBe('running');
    expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });

    await expect(controller.interrupt('/root', worker.actorPath)).resolves.toBeUndefined();
    expect(durableState(fixture.saved(), worker.turnId)).toBe('interrupted');
  });

  it('fences an undecidable write and converges by re-reading, not replaying', async () => {
    const fixture = ambiguousStore();
    const controller = await createAgentActorController({
      store: fixture.store,
      owner: OWNER,
      executor: new DeferredExecutor(),
      isOwnerAlive: async () => true,
    });
    const worker = await controller.spawn('/root', { taskName: 'worker', objective: 'Run.' });

    fixture.nextSave('landed', true);
    await expect(controller.interrupt('/root', worker.actorPath, 'user stop')).rejects.toMatchObject({
      code: 'actor_settlement_not_persisted',
    });
    expect(controller.healthSnapshot().state).toBe('unknown');
    await expect(controller.spawn('/root', { taskName: 'blocked', objective: 'Wait.' })).rejects.toMatchObject({
      code: 'actor_settlement_not_persisted',
    });

    await controller.quiesce('runtime run aborted');

    expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
    expect(controller.ownsDurableFence()).toBe(true);
    // The landed interrupt wins; reconcile did not overwrite it with its own reason.
    expect(fixture.saved()?.turns.find((turn) => turn.turnId === worker.turnId)).toMatchObject({
      state: 'interrupted',
      error: 'user stop',
    });
    await expect(controller.spawn('/root', { taskName: 'next', objective: 'Continue.' })).resolves.toMatchObject({
      actorPath: '/root/next',
    });
  });

  it('does not cache a shutdown failure past the reconcile that healed it', async () => {
    vi.useFakeTimers();
    const fixture = ambiguousStore();
    const controller = await createAgentActorController({
      store: fixture.store,
      owner: OWNER,
      executor: new DeferredExecutor(),
      isOwnerAlive: async () => true,
    });
    const worker = await controller.spawn('/root', { taskName: 'worker', objective: 'Run.' });

    fixture.nextSave('hang');
    const stop = controller.quiesce('runtime run aborted').then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await stop).toMatchObject({ code: 'actor_settlement_not_persisted' });
    await expect(controller.shutdown('runtime stopped')).rejects.toMatchObject({
      code: 'actor_shutdown_not_persisted',
    });

    fixture.releaseHang();
    await vi.advanceTimersByTimeAsync(0);
    const reconcile = controller.quiesce('runtime run aborted');
    await vi.advanceTimersByTimeAsync(0);
    await reconcile;
    expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
    expect(durableState(fixture.saved(), worker.turnId)).toBe('interrupted');

    const retry = controller.shutdown('runtime stopped');
    await vi.advanceTimersByTimeAsync(0);
    await expect(retry).resolves.toBeUndefined();
    expect(fixture.saved()).not.toHaveProperty('owner');
  });

  it('lets shutdown retry after a reconcile heals its unknown write', async () => {
    vi.useFakeTimers();
    const fixture = ambiguousStore();
    const controller = await createAgentActorController({
      store: fixture.store,
      owner: OWNER,
      executor: new DeferredExecutor(),
      isOwnerAlive: async () => true,
    });
    const worker = await controller.spawn('/root', { taskName: 'worker', objective: 'Run.' });

    fixture.nextSave('hang');
    const firstShutdown = controller.shutdown('runtime stopped').then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await firstShutdown).toMatchObject({ code: 'actor_shutdown_not_persisted' });

    fixture.releaseHang();
    await vi.advanceTimersByTimeAsync(0);
    const reconcile = controller.quiesce('runtime stopped');
    await vi.advanceTimersByTimeAsync(0);
    await reconcile;
    expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
    expect(durableState(fixture.saved(), worker.turnId)).toBe('interrupted');

    const retry = controller.shutdown('runtime stopped');
    await vi.advanceTimersByTimeAsync(0);
    await expect(retry).resolves.toBeUndefined();
    expect(fixture.saved()).not.toHaveProperty('owner');
  });

  it('lets initialize converge by retrying after an undecidable ownership claim', async () => {
    const fixture = ambiguousStore();
    const seed = await createAgentActorController({ store: fixture.store });
    await seed.spawn('/root', { taskName: 'done', objective: 'Seed a v1 snapshot.' }).catch(() => undefined);
    await seed.shutdown();

    const controller = new AgentActorController({
      store: fixture.store,
      owner: OWNER,
      executor: new DeferredExecutor(),
      isOwnerAlive: async () => false,
    });
    fixture.nextSave('landed', true);
    await expect(controller.initialize()).rejects.toMatchObject({
      code: 'actor_settlement_not_persisted',
    });
    expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });

    await controller.initialize();
    expect(controller.ownsDurableFence()).toBe(true);
    await expect(controller.spawn('/root', { taskName: 'next', objective: 'Continue.' })).resolves.toMatchObject({
      actorPath: '/root/next',
    });
  });

  it('[review] classifies a landed legacy write as committed when the store reorders keys', async () => {
    // A document store (for example a jsonb column) returns the same snapshot with
    // its keys in another order. The write is ours: same revision, same owner.
    const fixture = legacyStoreThatLandsThenThrows();
    const load = fixture.store.load.bind(fixture.store);
    fixture.store.load = async () => {
      const snapshot = await load();
      return snapshot === undefined ? undefined : reorderKeys(snapshot);
    };
    const controller = await createAgentActorController({
      store: fixture.store,
      owner: OWNER,
      executor: new DeferredExecutor(),
      isOwnerAlive: async () => true,
    });
    const worker = await controller.spawn('/root', { taskName: 'worker', objective: 'Run.' });

    fixture.throwAfterNextWrite();
    const interrupted = await controller.interrupt('/root', worker.actorPath).then(
      () => 'interrupted',
      (error: unknown) => error,
    );
    const next = await controller.spawn('/root', { taskName: 'next', objective: 'Continue.' }).then(
      (ref) => ref.actorPath,
      (error: unknown) => error,
    );

    expect(interrupted).toBe('interrupted');
    expect(next).toBe('/root/next');
    expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
  });

  it('lets shutdown retry after an undecidable ambiguous write is reconciled', async () => {
    const fixture = ambiguousStore();
    const controller = await createAgentActorController({
      store: fixture.store,
      owner: OWNER,
      executor: new DeferredExecutor(),
      isOwnerAlive: async () => true,
    });
    await controller.spawn('/root', { taskName: 'worker', objective: 'Run.' });

    fixture.nextSave('lost', true);
    await expect(controller.shutdown('runtime stopped')).rejects.toMatchObject({
      code: 'actor_settlement_not_persisted',
    });
    await expect(controller.shutdown('runtime stopped')).rejects.toMatchObject({
      code: 'actor_settlement_not_persisted',
    });

    await controller.quiesce('runtime stopped');
    await expect(controller.shutdown('runtime stopped')).resolves.toBeUndefined();
    expect(fixture.saved()).not.toHaveProperty('owner');
  });

  it.each([
    ['legacy save()', false],
    ['phase-aware beginSave()', true],
  ])('does not mistake its own late-landing %s write for a takeover', async (_store, phaseAware) => {
    const fixture = storeThatCommitsAfterClientTimeout(phaseAware);
    const controller = await createAgentActorController({
      store: fixture.store,
      owner: OWNER,
      executor: new DeferredExecutor(),
      isOwnerAlive: async () => true,
    });
    const worker = await controller.spawn('/root', { taskName: 'worker', objective: 'Run.' });

    fixture.timeoutNextSave();
    await expect(controller.interrupt('/root', worker.actorPath, 'user stop')).rejects.toThrow('client timed out');
    // Readback still saw the old snapshot, so the interrupt was rolled back.
    expect(controller.output('/root', worker.actorPath, worker.turnId).state).toBe('running');
    expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });

    fixture.landLateWrite();
    await expect(controller.spawn('/root', { taskName: 'blocked', objective: 'Wait.' })).rejects.toMatchObject({
      code: 'actor_settlement_not_persisted',
    });
    expect(controller.healthSnapshot().state).toBe('unknown');

    await controller.quiesce('runtime run aborted');

    expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
    expect(controller.ownsDurableFence()).toBe(true);
    expect(fixture.saved()?.turns.find((turn) => turn.turnId === worker.turnId)).toMatchObject({
      state: 'interrupted',
      error: 'user stop',
    });
    await expect(controller.spawn('/root', { taskName: 'next', objective: 'Continue.' })).resolves.toMatchObject({
      actorPath: '/root/next',
    });
  });

  it('bounds and reports the ownership check when a real takeover hangs storage', async () => {
    vi.useFakeTimers();
    const fixture = storeThatCommitsAfterClientTimeout(true);
    const onBackgroundError = vi.fn();
    const controller = await createAgentActorController({
      store: fixture.store,
      owner: OWNER,
      executor: new DeferredExecutor(),
      isOwnerAlive: async () => true,
      onBackgroundError,
    });
    await controller.spawn('/root', { taskName: 'worker', objective: 'Run.' });
    const current = fixture.saved();
    if (current?.schemaVersion !== 2) throw new Error('expected an owned v2 snapshot');
    fixture.overwrite({
      ...current,
      revision: current.revision + 1,
      owner: { ...OWNER, ownerId: 'actor-owner-foreign', runtimeId: 'runtime-foreign' },
    });
    const load = fixture.store.load.bind(fixture.store);
    let hangNextLoad = true;
    fixture.store.load = () => {
      if (!hangNextLoad) return load();
      hangNextLoad = false;
      return new Promise(() => undefined);
    };

    const spawned = controller.spawn('/root', { taskName: 'next', objective: 'Continue.' }).then(
      (ref) => ref.actorPath,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await spawned).toMatchObject({
      code: 'actor_owner_conflict',
      ownerRuntimeId: 'runtime-foreign',
    });
    expect(onBackgroundError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AgentSettlementAttemptTimeoutError' }),
    );
  });

  it('settles a takeover even when every storage reload hangs', async () => {
    vi.useFakeTimers();
    const fixture = storeThatCommitsAfterClientTimeout(true);
    const warn = vi.fn();
    const controller = await createAgentActorController({
      store: fixture.store,
      owner: OWNER,
      executor: new DeferredExecutor(),
      isOwnerAlive: async () => true,
      onBackgroundError: vi.fn(),
      warn,
    });
    await controller.spawn('/root', { taskName: 'worker', objective: 'Run.' });
    const current = fixture.saved();
    if (current?.schemaVersion !== 2) throw new Error('expected an owned v2 snapshot');
    fixture.overwrite({
      ...current,
      revision: current.revision + 1,
      owner: { ...OWNER, ownerId: 'actor-owner-foreign', runtimeId: 'runtime-foreign' },
    });
    fixture.store.load = () => new Promise(() => undefined);

    const spawned = controller.spawn('/root', { taskName: 'next', objective: 'Continue.' }).then(
      (ref) => ref.actorPath,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await Promise.race([spawned, Promise.resolve('still pending')])).toMatchObject({
      code: 'actor_owner_conflict',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Actor owner conflict refresh failed'));
  });
});
