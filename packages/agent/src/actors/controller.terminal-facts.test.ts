import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentActorController,
  AgentSettlementPersistenceError,
  createAgentActorController,
  type AgentActorSaveAttempt,
  type AgentActorSavePhase,
  type AgentActorSnapshot,
  type AgentActorStore,
  type AgentControllerHealth,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentTurn,
  type AgentTurnExecutor,
} from './index.js';

const OWNER = {
  ownerId: 'actor-owner-terminal-facts',
  runtimeId: 'runtime-terminal-facts',
  pid: 303,
  startedAt: '2026-11-17T00:00:00.000Z',
} as const;

class DeferredExecutor implements AgentTurnExecutor {
  readonly pending: {
    readonly input: AgentExecutionInput;
    readonly resolve: (result: AgentExecutionResult) => void;
  }[] = [];

  execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    return new Promise((resolve) => this.pending.push({ input, resolve }));
  }
}

/** Rejects as soon as Stop aborts it, like the coding Runtime's child executor. */
const abortAwareExecutor: AgentTurnExecutor = {
  execute: ({ signal }) => new Promise<AgentExecutionResult>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted by Stop')), { once: true });
  }),
};

function conflict(expectedRevision: number, currentRevision: number): Error {
  return Object.assign(new Error('synthetic Actor revision conflict'), {
    code: 'actor_snapshot_conflict' as const,
    expectedRevision,
    currentRevision,
  });
}

function phasedAttempt(
  attemptId: string,
  canonical: Promise<void>,
  initial: AgentActorSavePhase,
): AgentActorSaveAttempt {
  let phase = initial;
  const settled = canonical.then(() => { phase = 'committed'; });
  return {
    dequeued: Promise.resolve(),
    eligible: Promise.resolve(),
    canonical: settled,
    completion: settled,
    phase: () => phase,
    cancelBeforeCommit: () => false,
    diagnostics: () => ({ attemptId, phase, timingsMs: {} }),
  };
}

/** Phase-aware store whose first save matching `isSlow` commits only when released. */
function lateCommitStore(isSlow: (snapshot: AgentActorSnapshot) => boolean) {
  let saved: AgentActorSnapshot | undefined;
  let releaseLateCommit: (() => void) | undefined;
  const lateCommit = new Promise<void>((resolve) => { releaseLateCommit = resolve; });
  let slowStarted = false;
  const history: AgentActorSnapshot[] = [];
  const persist = async (snapshot: AgentActorSnapshot, expectedRevision: number): Promise<void> => {
    const actualRevision = saved?.revision ?? 0;
    if (actualRevision !== expectedRevision) throw conflict(expectedRevision, actualRevision);
    saved = structuredClone(snapshot);
    history.push(saved);
  };
  const store: AgentActorStore = {
    async load() { return saved === undefined ? undefined : structuredClone(saved); },
    save: persist,
    beginSave(snapshot, expectedRevision) {
      if (!slowStarted && isSlow(snapshot)) {
        slowStarted = true;
        return phasedAttempt(
          'slow',
          lateCommit.then(() => persist(snapshot, expectedRevision)),
          'commit_inflight',
        );
      }
      return phasedAttempt('ordinary', persist(snapshot, expectedRevision), 'precommit');
    },
  };
  return {
    store,
    history,
    durableState: (turnId: string) => saved?.turns.find((turn) => turn.turnId === turnId)?.state,
    releaseLateCommit: () => releaseLateCommit?.(),
  };
}

/** Test-only window into live (uncommitted) memory; public reads show committed state. */
interface ControllerInternals {
  readonly turns: ReadonlyMap<string, AgentTurn>;
  readonly pendingSettlementIntents: ReadonlyMap<string, { readonly state: string }>;
}

function liveView(controller: AgentActorController, turnIds: readonly string[]): string {
  const internals = controller as unknown as ControllerInternals;
  const memory = turnIds.map((turnId) => internals.turns.get(turnId)?.state).join(',');
  const intents = turnIds.map((turnId) => internals.pendingSettlementIntents.get(turnId)?.state ?? '-').join(',');
  return `memory=${memory} intents=${intents}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Actor terminal facts are write-once with a single writer', () => {
  it('a Stop-aborted executor never competes with the interruption it caused (Issue 412)', async () => {
    vi.useFakeTimers();
    const storage = lateCommitStore((snapshot) => (
      snapshot.turns.filter((turn) => turn.state === 'interrupted').length === 2
    ));
    const healthChanges: AgentControllerHealth[] = [];
    const onBackgroundError = vi.fn();
    const controller = await createAgentActorController({
      executor: abortAwareExecutor,
      store: storage.store,
      owner: OWNER,
      isOwnerAlive: async () => true,
      onBackgroundError,
      onHealthChanged: (health) => healthChanges.push(health),
    });
    try {
      const first = await controller.spawn('/root', { taskName: 'gen-S1-A', objective: 'Run in parallel.' });
      const second = await controller.spawn('/root', { taskName: 'gen-S1-B', objective: 'Run in parallel.' });
      await vi.advanceTimersByTimeAsync(0);

      const firstStop = controller.quiesce('runtime run aborted').then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await firstStop).toBeInstanceOf(AgentSettlementPersistenceError);
      storage.releaseLateCommit();
      await vi.advanceTimersByTimeAsync(2_000);

      await controller.quiesce('runtime run aborted');

      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      for (const turn of [first, second]) {
        expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
          state: 'interrupted',
          error: 'runtime run aborted',
        });
      }
      // Single writer: the aborted executors never raised a competing `failed` settlement.
      expect(healthChanges.map((health) => health.state)).not.toContain('recovering');
      expect(storage.history.flatMap((snapshot) => snapshot.turns).map((turn) => turn.state))
        .not.toContain('failed');
      expect(onBackgroundError).not.toHaveBeenCalled();
    } finally {
      storage.releaseLateCommit();
      await vi.runAllTimersAsync();
    }
  });

  it('shows the Issue 412 event order: an expired Stop keeps the interrupt its late save committed', async () => {
    vi.useFakeTimers();
    const storage = lateCommitStore((snapshot) => (
      snapshot.turns.filter((turn) => turn.state === 'interrupted').length === 2
    ));
    const controller = await createAgentActorController({
      executor: abortAwareExecutor,
      store: storage.store,
      owner: OWNER,
      isOwnerAlive: async () => true,
      onBackgroundError: vi.fn(),
    });
    try {
      const first = await controller.spawn('/root', { taskName: 'gen-S1-A', objective: 'Run in parallel.' });
      const second = await controller.spawn('/root', { taskName: 'gen-S1-B', objective: 'Run in parallel.' });
      const turnIds = [first.turnId, second.turnId];
      await vi.advanceTimersByTimeAsync(0);
      const log: string[] = [];

      const firstStop = controller.quiesce('runtime run aborted').catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      log.push(`executors aborted, Stop save in flight: ${liveView(controller, turnIds)}`);
      await vi.advanceTimersByTimeAsync(5_001);
      await firstStop;
      log.push(`Stop deadline expired: ${liveView(controller, turnIds)}`);
      storage.releaseLateCommit();
      await vi.advanceTimersByTimeAsync(2_000);
      const durable = turnIds.map((turnId) => storage.durableState(turnId)).join(',');
      log.push(`late commit landed (durable=${durable}): ${liveView(controller, turnIds)}`);

      // Without the single-writer guard both intents read `failed,failed` from the first
      // line on: they are registered while memory already says `interrupted`, so the
      // rollback below is not what creates them.
      expect(log).toEqual([
        'executors aborted, Stop save in flight: memory=interrupted,interrupted intents=-,-',
        'Stop deadline expired: memory=interrupted,interrupted intents=-,-',
        // Combined review: the ambiguous-write outcome keeps the committed interrupt.
        'late commit landed (durable=interrupted,interrupted): memory=interrupted,interrupted intents=-,-',
      ]);
    } finally {
      storage.releaseLateCommit();
      await vi.runAllTimersAsync();
    }
  });

  it('keeps a late-committed interrupt over a normal completion that raced it', async () => {
    vi.useFakeTimers();
    const storage = lateCommitStore((snapshot) => snapshot.turns.some((turn) => turn.state === 'interrupted'));
    const executor = new DeferredExecutor();
    const onBackgroundError = vi.fn();
    const controller = await createAgentActorController({
      executor,
      store: storage.store,
      owner: OWNER,
      isOwnerAlive: async () => true,
      onBackgroundError,
    });
    try {
      const target = await controller.spawn('/root', { taskName: 'worker', objective: 'Finish normally.' });
      await vi.advanceTimersByTimeAsync(0);

      const interrupt = controller.interrupt('/root', target.actorPath, 'parent interrupt')
        .then(() => 'interrupted', (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      // The executor finished before the interrupt aborted it, so its result is a real fact.
      executor.pending[0]?.resolve({ output: 'finished just before the interrupt' });
      await vi.advanceTimersByTimeAsync(5_001);
      expect(controller.healthSnapshot().state).toBe('unknown');

      storage.releaseLateCommit();
      await vi.advanceTimersByTimeAsync(0);
      expect(await interrupt).toBe('interrupted');
      expect(storage.durableState(target.turnId)).toBe('interrupted');
      onBackgroundError.mockClear();

      await controller.quiesce('runtime run aborted');

      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      expect(controller.output('/root', target.actorPath, target.turnId)).toMatchObject({
        state: 'interrupted',
        error: 'parent interrupt',
      });
      expect(onBackgroundError).not.toHaveBeenCalled();
    } finally {
      storage.releaseLateCommit();
      await vi.runAllTimersAsync();
    }
  });

  it('treats a duplicate terminal write after a same-owner revision conflict as a no-op', async () => {
    let saved: AgentActorSnapshot | undefined;
    let throwAfterTerminalWrite = true;
    const store: AgentActorStore = {
      async load() { return saved === undefined ? undefined : structuredClone(saved); },
      async save(snapshot, expectedRevision) {
        const actualRevision = saved?.revision ?? 0;
        if (actualRevision !== expectedRevision) throw conflict(expectedRevision, actualRevision);
        saved = structuredClone(snapshot);
        if (throwAfterTerminalWrite && snapshot.turns.some((turn) => turn.state === 'completed')) {
          throwAfterTerminalWrite = false;
          // The write landed, but the store reports a failure (e.g. fsync after rename).
          throw Object.assign(new Error('EIO after rename'), { code: 'EIO' });
        }
      },
    };
    const executor = new DeferredExecutor();
    const onBackgroundError = vi.fn();
    const controller = await createAgentActorController({
      executor,
      store,
      owner: OWNER,
      isOwnerAlive: async () => true,
      onBackgroundError,
    });
    const target = await controller.spawn('/root', { taskName: 'worker', objective: 'Finish once.' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    executor.pending[0]?.resolve({ output: 'exact output' });
    // Combined review: the ambiguous-write readback proves the landed revision is
    // ours, so the settlement is committed and nothing fences.
    await vi.waitFor(() => {
      expect(saved?.turns.find((turn) => turn.turnId === target.turnId)?.state).toBe('completed');
    });
    expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
    expect(onBackgroundError).not.toHaveBeenCalled();

    await controller.quiesce('runtime run aborted');

    expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
    expect(controller.output('/root', target.actorPath, target.turnId)).toMatchObject({
      state: 'completed',
      output: 'exact output',
    });
    await controller.shutdown();
  });
});
