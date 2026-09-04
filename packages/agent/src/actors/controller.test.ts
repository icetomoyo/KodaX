import { describe, expect, it, vi } from 'vitest';

import {
  AgentActorController,
  AgentBudgetExhaustedError,
  AgentControlError,
  AgentExecutionError,
  AgentLimitReachedError,
  createAgentActorController,
  type AgentBudgetPort,
  type AgentActorSaveAttempt,
  type AgentActorSavePhase,
  type AgentActorSnapshot,
  type AgentActorStore,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentTurnExecutor,
} from './index.js';

interface PendingExecution {
  readonly input: AgentExecutionInput;
  readonly resolve: (result: AgentExecutionResult) => void;
  readonly reject: (error: Error) => void;
}

class DeferredExecutor implements AgentTurnExecutor {
  readonly pending: PendingExecution[] = [];

  execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    return new Promise((resolve, reject) => this.pending.push({ input, resolve, reject }));
  }
}

const FIRST_OWNER = {
  ownerId: 'actor-owner-first',
  runtimeId: 'runtime-first',
  pid: 101,
  startedAt: '2026-07-28T00:00:00.000Z',
} as const;

const SECOND_OWNER = {
  ownerId: 'actor-owner-second',
  runtimeId: 'runtime-second',
  pid: 202,
  startedAt: '2026-07-28T00:01:00.000Z',
} as const;

function revisionedActorStore(): {
  readonly store: AgentActorStore;
  read(): AgentActorSnapshot | undefined;
  replace(snapshot: AgentActorSnapshot): void;
  saveCount(): number;
} {
  let snapshot: AgentActorSnapshot | undefined;
  let saves = 0;
  return {
    store: {
      async load() {
        return snapshot === undefined ? undefined : structuredClone(snapshot);
      },
      async save(next, expectedRevision) {
        const currentRevision = snapshot?.revision ?? 0;
        if (currentRevision !== expectedRevision) {
          throw Object.assign(
            new Error(
              `Actor snapshot revision conflict: expected ${expectedRevision}, actual ${currentRevision}.`,
            ),
            {
              code: 'actor_snapshot_conflict' as const,
              expectedRevision,
              currentRevision,
            },
          );
        }
        snapshot = structuredClone(next);
        saves += 1;
      },
    },
    read: () => snapshot === undefined ? undefined : structuredClone(snapshot),
    replace: (next) => { snapshot = structuredClone(next); },
    saveCount: () => saves,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('F270 actor tree and scheduler', () => {
  it('mints canonical recursive paths and keeps Actor and Turn state separate', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });

    const child = await controller.spawn('/root', { taskName: 'scout', objective: 'Inspect.' });
    const grandchild = await controller.spawn('/root/scout', {
      taskName: 'dependency-check', objective: 'Check dependencies.',
    });

    expect(child.actorPath).toBe('/root/scout');
    expect(grandchild.actorPath).toBe('/root/scout/dependency-check');
    expect(controller.get('/root', child.actorPath).actor).toMatchObject({
      state: 'running', currentTurnId: child.turnId,
    });
    expect(controller.get('/root', child.actorPath).turns[0]).toMatchObject({ state: 'running' });

    executor.pending[0]?.resolve({ output: 'done' });
    await settle();
    expect(controller.get('/root', child.actorPath).actor.state).toBe('idle');
    expect(controller.get('/root', child.actorPath).turns[0]?.state).toBe('completed');
  });

  it('completes an artifact-only turn with a non-empty parent notification', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const child = await controller.spawn('/root', { taskName: 'artifact', objective: 'Create it.' });

    executor.pending[0]?.resolve({ output: '', artifacts: ['artifact://report'] });
    await settle();

    expect(controller.output('/root', child.actorPath, child.turnId)).toMatchObject({
      state: 'completed',
      artifacts: ['artifact://report'],
      artifactDetails: [{ name: 'artifact://report' }],
    });
    expect(controller.get('/root', '/root').mailbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ senderPath: child.actorPath, content: 'completed' }),
    ]));
  });

  it('rejects a turn id that does not belong to the requested Actor path', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const first = await controller.spawn('/root', { taskName: 'first', objective: 'First.' });
    const second = await controller.spawn('/root', { taskName: 'second', objective: 'Second.' });

    expect(() => controller.output('/root', first.actorPath, second.turnId)).toThrow(
      expect.objectContaining<Partial<AgentControlError>>({
        code: 'permission_denied',
      }),
    );
  });

  it('durably acknowledges one observed child completion without consuming earlier evidence', async () => {
    let saved: AgentActorSnapshot | undefined;
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store: {
        async load() { return undefined; },
        async save(snapshot) { saved = snapshot; },
      },
    });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Coordinate.' });
    const child = await controller.spawn('/root/parent', {
      taskName: 'child',
      objective: 'Inspect.',
    });
    await controller.send('/root/parent/child', '/root/parent', 'Important evidence.');
    executor.pending[1]?.resolve({ output: 'Child complete.' });
    await settle();

    const parent = controller.bind('/root/parent');
    await expect(parent.acknowledgeCompletions([child.turnId])).resolves.toBe(1);
    await expect(executor.pending[0]?.input.drainMailbox()).resolves.toEqual([
      expect.objectContaining({ kind: 'message', content: 'Important evidence.' }),
    ]);
    expect(saved?.acknowledgedCompletionTurnIds).toContain(child.turnId);

    executor.pending[0]?.resolve({ output: 'Parent complete.' });
    await settle();
    const restoredExecutor = new DeferredExecutor();
    const restored = new AgentActorController({
      executor: restoredExecutor,
      store: {
        async load() { return saved; },
        async save() {},
      },
    });
    await restored.initialize();
    await restored.followup('/root', '/root/parent', 'Continue after restart.');

    await expect(restoredExecutor.pending[0]?.input.drainMailbox()).resolves.toEqual([]);
  });

  it('republishes an unacknowledged root completion once after restart', async () => {
    let saved: AgentActorSnapshot | undefined;
    const store: AgentActorStore = {
      async load() { return saved; },
      async save(snapshot) { saved = snapshot; },
    };
    const executor = new DeferredExecutor();
    const first = await createAgentActorController({ executor, store });
    const child = await first.spawn('/root', { taskName: 'worker', objective: 'Inspect.' });
    executor.pending[0]?.resolve({ output: 'Durable result.' });
    await settle();
    expect(saved?.pendingRootCompletionTurnIds).toContain(child.turnId);

    const restoredMessages: string[] = [];
    const restored = await createAgentActorController({
      store,
      onMessageCommitted(message) {
        restoredMessages.push(message.turnId ?? 'missing');
      },
    });

    expect(restoredMessages).toEqual([child.turnId]);
    await expect(restored.bind('/root').acknowledgeCompletions([child.turnId])).resolves.toBe(1);

    const replayedAfterAcknowledgement: string[] = [];
    await createAgentActorController({
      store,
      onMessageCommitted(message) {
        replayedAfterAcknowledgement.push(message.turnId ?? 'missing');
      },
    });
    expect(replayedAfterAcknowledgement).toEqual([]);
  });

  it('does not infer replayable completions from a legacy snapshot without delivery state', async () => {
    let saved: AgentActorSnapshot | undefined;
    const executor = new DeferredExecutor();
    const first = await createAgentActorController({
      executor,
      store: {
        async load() { return undefined; },
        async save(snapshot) { saved = snapshot; },
      },
    });
    await first.spawn('/root', { taskName: 'legacy', objective: 'Finish.' });
    executor.pending[0]?.resolve({ output: 'Historical result.' });
    await settle();
    if (!saved) throw new Error('Expected a persisted Actor snapshot.');
    const legacy = { ...saved };
    delete legacy.pendingRootCompletionTurnIds;
    const replayed: string[] = [];

    await createAgentActorController({
      store: {
        async load() { return legacy; },
        async save() {},
      },
      onMessageCommitted(message) {
        replayed.push(message.turnId ?? 'missing');
      },
    });

    expect(replayed).toEqual([]);
  });

  it('does not replay an acknowledged direct-child terminal event', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const parent = controller.bind('/root');
    const child = await parent.spawn({ taskName: 'worker', objective: 'Work.' });
    const cursor = parent.eventSnapshot().at(-1)?.sequence ?? 0;

    executor.pending[0]?.resolve({ output: 'done' });
    await settle();
    const terminal = parent.eventSnapshot(cursor).find((event) => event.turnId === child.turnId);
    expect(terminal?.kind).toBe('turn_completed');

    await expect(parent.acknowledgeCompletions([child.turnId])).resolves.toBe(1);
    expect(parent.eventSnapshot(cursor).some((event) => event.turnId === child.turnId)).toBe(false);
    await expect(parent.wait(cursor, 0)).resolves.toBeUndefined();
  });

  it('does not persist an empty mailbox drain', async () => {
    const save = vi.fn(async () => undefined);
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store: { async load() { return undefined; }, save },
    });
    await controller.spawn('/root', { taskName: 'waiting', objective: 'Wait.' });
    const savesAfterSpawn = save.mock.calls.length;

    await expect(executor.pending[0]?.input.drainMailbox()).resolves.toEqual([]);

    expect(save).toHaveBeenCalledTimes(savesAfterSpawn);
  });

  it('publishes mailbox messages only after their durable commit', async () => {
    const committed: string[] = [];
    let rejectNextSave = false;
    const controller = await createAgentActorController({
      executor: new DeferredExecutor(),
      store: {
        async load() { return undefined; },
        async save() {
          if (rejectNextSave) throw new Error('save failed');
        },
      },
      onMessageCommitted(message) {
        committed.push(message.content);
      },
    });
    await controller.spawn('/root', { taskName: 'worker', objective: 'Wait.' });

    await controller.send('/root', '/root/worker', 'committed message');
    rejectNextSave = true;
    await expect(controller.send('/root', '/root/worker', 'rolled back message'))
      .rejects.toThrow('save failed');

    expect(committed).toEqual(['committed message']);
  });

  it('registers trusted Workflow protocol owners without consuming an Agent slot', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });

    const owner = await controller.createProtocolOwner('/root', 'run-1');

    expect(owner.callerPath).toBe('/root/workflow:run-1');
    expect(controller.list('/root')).toMatchObject({ activeNonRootTurns: 0 });
    expect(controller.get('/root', owner.callerPath).actor).toMatchObject({
      taskName: 'workflow:run-1', kind: 'workflow', state: 'running', parentPath: '/root',
    });
    const review = await owner.spawn({ taskName: 'review', objective: 'Review.' });
    expect(review).toMatchObject({
      actorPath: '/root/workflow:run-1/review',
    });
    expect(controller.list('/root').activeNonRootTurns).toBe(1);
    const ownerSignal = controller.protocolOwnerSignal(owner.callerPath);
    expect(ownerSignal.aborted).toBe(false);
    executor.pending[0]?.resolve({ output: 'reviewed' });
    await settle();
    await controller.settleProtocolOwner(owner.callerPath, 'completed', {
      output: '{"status":"completed"}',
      structured: { status: 'completed', coverage: ['review'] },
    });
    expect(controller.output('/root', owner.callerPath)).toMatchObject({
      state: 'completed',
      structured: { status: 'completed', coverage: ['review'] },
    });
    expect(controller.get('/root', '/root').mailbox.filter((message) => (
      message.senderPath === owner.callerPath && message.kind === 'completion'
    ))).toHaveLength(1);
    await expect(controller.settleProtocolOwner(owner.callerPath, 'completed', {
      output: 'duplicate terminal callback',
    })).resolves.toBeUndefined();
  });

  it('aborts a Workflow protocol owner when its parent interrupts it', async () => {
    const controller = await createAgentActorController();
    const owner = await controller.createProtocolOwner('/root', 'run-abort');
    const signal = controller.protocolOwnerSignal(owner.callerPath);

    await controller.interrupt('/root', owner.callerPath, 'goal changed');

    expect(signal).toMatchObject({ aborted: true, reason: 'goal changed' });
    expect(controller.output('/root', owner.callerPath)).toMatchObject({
      state: 'interrupted', error: 'goal changed',
    });
  });

  it('uses four total slots by default and leaves no ghost actor on saturation', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'a', objective: 'A' });
    await controller.spawn('/root', { taskName: 'b', objective: 'B' });
    await controller.spawn('/root', { taskName: 'c', objective: 'C' });

    await expect(controller.spawn('/root', { taskName: 'd', objective: 'D' })).rejects.toEqual(
      expect.objectContaining({
        code: 'agent_limit_reached',
        maxConcurrentThreads: 4,
        activeNonRootTurns: 3,
        availableNonRootSlots: 0,
        retryable: true,
      }),
    );
    expect(controller.list('/root').actors.some((actor) => actor.path === '/root/d')).toBe(false);

    executor.pending[0]?.resolve({ output: 'A done' });
    await settle();
    await expect(controller.spawn('/root', { taskName: 'd', objective: 'D' })).resolves.toMatchObject({
      actorPath: '/root/d',
    });
  });

  it('accepts root-only and high legal limits without clamping', async () => {
    const rootOnly = new AgentActorController({ maxConcurrentThreadsPerSession: 1 });
    await expect(rootOnly.spawn('/root', { taskName: 'blocked', objective: 'No slot.' }))
      .rejects.toBeInstanceOf(AgentLimitReachedError);

    const warn = vi.fn();
    const high = new AgentActorController({ maxConcurrentThreadsPerSession: 8, warn });
    expect(high.list('/root').maxConcurrentThreads).toBe(8);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps idle messages dormant and starts an admitted follow-up with history', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'reviewer', objective: 'First pass.' });
    executor.pending[0]?.resolve({ output: 'first' });
    await settle();

    await controller.send('/root', '/root/reviewer', 'Use the new evidence.');
    expect(executor.pending).toHaveLength(1);
    expect(controller.get('/root', '/root/reviewer').actor.state).toBe('idle');

    const followup = await controller.followup('/root', '/root/reviewer', 'Second pass.');
    expect(followup.delivery).toBe('started_turn');
    expect(executor.pending).toHaveLength(2);
    expect(executor.pending[1]?.input.priorTurns).toHaveLength(1);
    await expect(executor.pending[1]?.input.drainMailbox()).resolves.toMatchObject([
      { content: 'Use the new evidence.', kind: 'message' },
    ]);
  });

  it('joins a running turn for follow-up without consuming another slot', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const first = await controller.spawn('/root', { taskName: 'reviewer', objective: 'First pass.' });

    const followup = await controller.followup('/root', '/root/reviewer', 'Also check tests.');

    expect(followup).toEqual({ delivery: 'current_turn', turn: first });
    expect(controller.list('/root').activeNonRootTurns).toBe(1);
    expect(executor.pending).toHaveLength(1);
    await expect(executor.pending[0]?.input.drainMailbox()).resolves.toMatchObject([
      { content: 'Also check tests.', kind: 'followup' },
    ]);
  });

  it('atomically rejects a strategy switch on a running turn before mailbox delivery', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const ownerTurnRef = { actorPath: '/root', turnId: 'root-turn-1' };
    const firstStrategy = {
      schemaVersion: 1,
      stageId: 'review',
      pattern: 'fan-out-and-synthesize',
      role: 'investigator',
      laneRelation: 'coverage',
      ownerTurnRef,
    };
    await controller.spawn('/root', {
      taskName: 'reviewer',
      objective: 'First pass.',
      metadata: { qualityStrategy: firstStrategy },
    });

    await expect(controller.followup(
      '/root',
      '/root/reviewer',
      'Switch this running lane.',
      {
        qualityStrategy: {
          ...firstStrategy,
          pattern: 'adversarial-verification',
          role: 'challenger',
          laneRelation: 'opposition',
        },
      },
    )).rejects.toMatchObject({ code: 'invalid_message' });
    await expect(executor.pending[0]?.input.drainMailbox()).resolves.toEqual([]);

    await expect(controller.followup(
      '/root',
      '/root/reviewer',
      'Continue the same lane.',
      { qualityStrategy: structuredClone(firstStrategy) },
    )).resolves.toMatchObject({ delivery: 'current_turn' });
    await expect(executor.pending[0]?.input.drainMailbox()).resolves.toMatchObject([
      { content: 'Continue the same lane.', kind: 'followup' },
    ]);
  });

  it('routes completion once to the direct parent rather than the root', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Parent.' });
    await controller.spawn('/root/parent', { taskName: 'child', objective: 'Child.' });

    executor.pending[1]?.resolve({ output: 'grandchild result' });
    await settle();

    const parentMailbox = controller.get('/root', '/root/parent').mailbox;
    expect(parentMailbox.filter((message) => message.content === 'grandchild result')).toHaveLength(1);
    expect(controller.get('/root', '/root').mailbox.some((message) => (
      message.content === 'grandchild result'
    ))).toBe(false);
  });

  it('separates lifecycle control from peer messaging authorization', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'a', objective: 'A' });
    await controller.spawn('/root', { taskName: 'b', objective: 'B' });
    await controller.spawn('/root/a', { taskName: 'a1', objective: 'A1' });

    await controller.send('/root/a', '/root/b', 'Peer evidence.');
    await expect(controller.followup('/root/a', '/root/b', 'Control peer.')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(controller.interrupt('/root', '/root/a/a1')).resolves.toBeUndefined();
    expect(controller.get('/root', '/root/a/a1').actor.state).toBe('idle');
  });

  it('atomically interrupts a controlled subtree while preserving reusable identities', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Parent.' });
    await controller.spawn('/root/parent', { taskName: 'child', objective: 'Child.' });
    await controller.interrupt('/root', '/root/parent', 'branch invalidated', 'subtree');

    expect(controller.output('/root', '/root/parent')).toMatchObject({
      state: 'interrupted', error: 'branch invalidated',
    });
    expect(controller.output('/root', '/root/parent/child')).toMatchObject({
      state: 'interrupted', error: 'branch invalidated',
    });
    expect(controller.eventSnapshot('/root')
      .filter((event) => event.kind === 'turn_interrupted')
      .slice(-2)
      .map((event) => event.actorPath))
      .toEqual(['/root/parent/child', '/root/parent']);
    await expect(controller.followup('/root', '/root/parent', 'Use the corrected premise.'))
      .resolves.toMatchObject({ delivery: 'started_turn' });
  });

  it('quiesces only turns admitted after a preserved active-turn baseline', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const preserved = await controller.spawn('/root', {
      taskName: 'pre-existing',
      objective: 'Remain independent.',
    });
    const owned = await controller.spawn('/root', {
      taskName: 'run-owned',
      objective: 'Stop with the managed Run.',
    });

    await controller.quiesce('runtime run aborted', new Set([preserved.turnId]));

    expect(controller.output('/root', preserved.actorPath, preserved.turnId))
      .toMatchObject({ state: 'running' });
    expect(controller.output('/root', owned.actorPath, owned.turnId))
      .toMatchObject({ state: 'interrupted', error: 'runtime run aborted' });
    expect(executor.pending[0]?.input.signal.aborted).toBe(false);
    expect(executor.pending[1]?.input.signal.aborted).toBe(true);
  });

  it('does not rewrite the durable snapshot when quiesce has no eligible turn', async () => {
    const durable = revisionedActorStore();
    const controller = await createAgentActorController({
      executor: new DeferredExecutor(),
      store: durable.store,
    });
    const saveCountBeforeQuiesce = durable.saveCount();

    await controller.quiesce('runtime run aborted');

    expect(durable.saveCount()).toBe(saveCountBeforeQuiesce);
  });

  it('quiesces a durably pending admission before its executor can start', async () => {
    let releaseStartSave: (() => void) | undefined;
    let startSaveEntered: (() => void) | undefined;
    let saveCount = 0;
    const startSaveStarted = new Promise<void>((resolve) => { startSaveEntered = resolve; });
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store: {
        async load() { return undefined; },
        async save() {
          saveCount += 1;
          if (saveCount !== 1) return;
          startSaveEntered?.();
          await new Promise<void>((resolve) => { releaseStartSave = resolve; });
        },
      },
    });

    const spawning = controller.spawn('/root', {
      taskName: 'racing-quiesce',
      objective: 'Do not start after cancellation.',
    });
    await startSaveStarted;
    const quiescing = controller.quiesce('runtime run aborted');
    releaseStartSave?.();

    const [turn] = await Promise.all([spawning, quiescing]);
    await settle();

    expect(executor.pending).toHaveLength(0);
    expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted', error: 'runtime run aborted',
    });
  });

  it('reports unknown health when a pre-launch quiesce cannot be persisted', async () => {
    let releaseStartSave: (() => void) | undefined;
    let startSaveEntered: (() => void) | undefined;
    let saveCount = 0;
    const startSaveStarted = new Promise<void>((resolve) => { startSaveEntered = resolve; });
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store: {
        async load() { return undefined; },
        async save() {
          saveCount += 1;
          if (saveCount === 1) {
            startSaveEntered?.();
            await new Promise<void>((resolve) => { releaseStartSave = resolve; });
            return;
          }
          throw new Error('quiesce save failed');
        },
      },
    });

    const spawning = controller.spawn('/root', {
      taskName: 'indeterminate-quiesce',
      objective: 'Do not become false healthy work.',
    });
    await startSaveStarted;
    const quiescing = controller.quiesce('runtime run aborted');
    releaseStartSave?.();

    const turn = await spawning;
    await expect(quiescing).rejects.toMatchObject({
      code: 'actor_settlement_not_persisted',
    });
    await settle();

    expect(executor.pending).toHaveLength(0);
    expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
      state: 'running',
    });
    expect(controller.healthSnapshot()).toMatchObject({
      state: 'unknown',
      code: 'actor_settlement_not_persisted',
      turnId: turn.turnId,
    });
  });

  it('rejects subtree interruption atomically when one active descendant cannot interrupt', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Parent.' });
    await controller.spawn('/root/parent', {
      taskName: 'remote-child',
      objective: 'Child.',
      kind: 'external',
      capabilities: {
        control: { followup: true, interrupt: false, streaming: true, artifacts: true },
      },
    });

    await expect(controller.interrupt(
      '/root',
      '/root/parent',
      'branch invalidated',
      'subtree',
    )).rejects.toMatchObject({ code: 'unsupported_operation' });

    expect(controller.output('/root', '/root/parent').state).toBe('running');
    expect(controller.output('/root', '/root/parent/remote-child').state).toBe('running');
  });

  it('derives forwarding lineage from a Runtime message id and rejects cycles and self-send', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'a', objective: 'A' });
    await controller.spawn('/root', { taskName: 'b', objective: 'B' });

    await controller.send('/root/a', '/root/b', 'Evidence from A.');
    const receivedByB = controller.get('/root', '/root/b').mailbox.at(-1);
    expect(receivedByB).toMatchObject({
      senderPath: '/root/a',
      lineage: ['/root/a'],
    });
    if (!receivedByB) throw new Error('Expected B to receive a message.');

    await expect(controller.send(
      '/root/b',
      '/root/a',
      'Forward the evidence back.',
      'internal',
      receivedByB.messageId,
    )).rejects.toMatchObject({ code: 'message_cycle_detected' });
    await expect(controller.send('/root/a', '/root/a', 'Loop.'))
      .rejects.toMatchObject({ code: 'message_cycle_detected' });
  });

  it('rejects forged forwarding references instead of trusting model-supplied lineage', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'a', objective: 'A' });
    await controller.spawn('/root', { taskName: 'b', objective: 'B' });

    await expect(controller.send(
      '/root/a',
      '/root/b',
      'Forged forward.',
      'internal',
      'msg_not_received_by_a',
    )).rejects.toMatchObject({ code: 'invalid_forward_reference' });
  });

  it('caps forwarding depth and never downgrades the source classification', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      maxConcurrentThreadsPerSession: 8,
    });
    for (const taskName of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      await controller.spawn('/root', { taskName, objective: taskName.toUpperCase() });
    }

    let message = await controller.send('/root/a', '/root/b', 'Sensitive evidence.', 'sensitive');
    for (const [sender, target] of [['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f']] as const) {
      message = await controller.send(
        `/root/${sender}`,
        `/root/${target}`,
        'Forwarded evidence.',
        'public',
        message.messageId,
      );
      expect(message.classification).toBe('sensitive');
    }

    await expect(controller.send(
      '/root/f',
      '/root/g',
      'One hop too far.',
      'internal',
      message.messageId,
    )).rejects.toMatchObject({ code: 'message_cycle_detected' });
  });

  it('persists only bounded recent progress and exposes bounded running and terminal summaries', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const child = await controller.spawn('/root', { taskName: 'observer', objective: 'Inspect.' });
    const execution = executor.pending[0]?.input;
    if (!execution) throw new Error('Expected a running child execution.');

    for (let index = 0; index < 8; index += 1) {
      await execution.reportProgress({
        kind: index % 2 === 0 ? 'tool' : 'status',
        summary: `activity-${index} ${'x'.repeat(300)}`,
      });
    }

    const running = controller.output('/root', child.actorPath, child.turnId);
    const listedRunning = controller.list('/root').actors.find((actor) => actor.path === child.actorPath);
    expect(running.progress).toHaveLength(6);
    expect(running.progress[0]?.summary).toMatch(/^activity-2 /u);
    expect(running.progress.every((item) => item.summary.length <= 240)).toBe(true);
    expect(listedRunning?.latestTurn).toMatchObject({
      turnId: child.turnId,
      state: 'running',
      recentActivity: running.progress,
    });
    expect(controller.eventSnapshot('/root').at(-1)).toMatchObject({
      kind: 'turn_progress',
      actorPath: child.actorPath,
      progress: expect.objectContaining({ summary: expect.stringContaining('activity-7') }),
    });

    executor.pending[0]?.resolve({ output: `terminal ${'y'.repeat(10_000)}` });
    await settle();

    const terminal = controller.output('/root', child.actorPath, child.turnId);
    const listedTerminal = controller.list('/root').actors.find((actor) => actor.path === child.actorPath);
    expect(terminal.output).toHaveLength(8_192);
    expect(terminal.output).toContain('... [truncated] ...');
    expect(terminal.output).toMatch(/^terminal y/u);
    expect(terminal.output).toMatch(/y$/u);
    expect(terminal.outputTruncated).toBe(true);
    expect(listedTerminal?.latestTurn.summary.length).toBeLessThanOrEqual(480);
    expect(listedTerminal?.latestTurn.summaryTruncated).toBe(true);
  });

  it('coalesces concurrent durable progress across the entire Actor tree', async () => {
    let latestProgressItems = 0;
    let progressSaveCount = 0;
    let releaseFirstProgressSave: (() => void) | undefined;
    let markFirstProgressSaveStarted: (() => void) | undefined;
    const firstProgressSaveStarted = new Promise<void>((resolve) => {
      markFirstProgressSaveStarted = resolve;
    });
    const firstProgressSave = new Promise<void>((resolve) => {
      releaseFirstProgressSave = resolve;
    });
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      maxConcurrentThreadsPerSession: 5,
      store: {
        async load() { return undefined; },
        async save(snapshot) {
          const progressItems = snapshot.turns.reduce(
            (total, turn) => total + (turn.progress?.length ?? 0),
            0,
          );
          if (progressItems <= latestProgressItems) return;
          latestProgressItems = progressItems;
          progressSaveCount += 1;
          if (progressSaveCount === 1) {
            markFirstProgressSaveStarted?.();
            await firstProgressSave;
          }
        },
      },
    });
    for (let index = 0; index < 4; index += 1) {
      await controller.spawn('/root', {
        taskName: `worker-${index}`,
        objective: `Report progress ${index}.`,
      });
    }

    const reports = executor.pending.map(({ input }, index) => input.reportProgress({
      kind: 'status',
      summary: `Concurrent progress ${index}.`,
    }));
    await firstProgressSaveStarted;
    releaseFirstProgressSave?.();
    await Promise.all(reports);

    expect(progressSaveCount).toBe(1);
  });

  it('rejects an active durable progress waiter when the Actor tree self-fences', async () => {
    vi.useFakeTimers();
    let releaseProgressSave: (() => void) | undefined;
    let markProgressSaveStarted: (() => void) | undefined;
    const progressSaveStarted = new Promise<void>((resolve) => {
      markProgressSaveStarted = resolve;
    });
    const progressSave = new Promise<void>((resolve) => {
      releaseProgressSave = resolve;
    });
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store: {
        async load() { return undefined; },
        async save(snapshot) {
          const worker = snapshot.turns.find((turn) => turn.actorPath === '/root/worker');
          if (worker?.state === 'running' && (worker.progress?.length ?? 0) > 0) {
            markProgressSaveStarted?.();
            await progressSave;
          }
        },
      },
      onBackgroundError: vi.fn(),
    });

    try {
      await controller.spawn('/root', {
        taskName: 'worker',
        objective: 'Wait for durable progress.',
      });
      const progressOutcome = executor.pending[0]!.input.reportProgress({
        kind: 'status',
        summary: 'This save never returns.',
      }).then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      await progressSaveStarted;
      executor.pending[0]?.resolve({ output: 'terminal waits behind progress' });

      await vi.advanceTimersByTimeAsync(30_001);

      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
      });
      await expect(progressOutcome).resolves.toBe('rejected');
    } finally {
      releaseProgressSave?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('repairs a terminal fact that timed out before its mutation reached the durable queue', async () => {
    vi.useFakeTimers();
    let saved: AgentActorSnapshot | undefined;
    let releaseProgressSave: (() => void) | undefined;
    let markProgressSaveStarted: (() => void) | undefined;
    const progressSaveStarted = new Promise<void>((resolve) => {
      markProgressSaveStarted = resolve;
    });
    const progressSave = new Promise<void>((resolve) => {
      releaseProgressSave = resolve;
    });
    let blockedProgress = false;
    const store: AgentActorStore = {
      async load() {
        return saved === undefined ? undefined : structuredClone(saved);
      },
      async save(snapshot, expectedRevision) {
        const actualRevision = saved?.revision ?? 0;
        if (actualRevision !== expectedRevision) {
          throw Object.assign(new Error('synthetic Actor revision conflict'), {
            code: 'actor_snapshot_conflict' as const,
            expectedRevision,
            currentRevision: actualRevision,
          });
        }
        const target = snapshot.turns.find((turn) => turn.actorPath === '/root/target');
        if (!blockedProgress && target?.state === 'running' && target.progress?.length) {
          blockedProgress = true;
          markProgressSaveStarted?.();
          await progressSave;
        }
        saved = structuredClone(snapshot);
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
      onBackgroundError: vi.fn(),
    });

    try {
      const target = await controller.spawn('/root', {
        taskName: 'target',
        objective: 'Complete behind a slow progress save.',
      });
      const sibling = await controller.spawn('/root', {
        taskName: 'sibling',
        objective: 'Be durably quiesced during repair.',
      });
      const progress = executor.pending[0]!.input.reportProgress({
        kind: 'status',
        summary: 'Persisting slowly.',
      }).catch(() => undefined);
      await progressSaveStarted;
      executor.pending[0]?.resolve({ output: 'queued terminal fact' });

      await vi.advanceTimersByTimeAsync(30_001);
      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
      });

      releaseProgressSave?.();
      await vi.runAllTimersAsync();
      await progress;
      await controller.quiesce('repair after queue timeout');

      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      expect(controller.output('/root', target.actorPath, target.turnId)).toMatchObject({
        state: 'completed',
        output: 'queued terminal fact',
      });
      expect(controller.output('/root', sibling.actorPath, sibling.turnId)).toMatchObject({
        state: 'interrupted',
        error: 'repair after queue timeout',
      });
    } finally {
      releaseProgressSave?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('does not fence a terminal mutation behind a legal phase-aware storage wait', async () => {
    vi.useFakeTimers();
    let releaseProgressCompletion: (() => void) | undefined;
    const progressCompletion = new Promise<void>((resolve) => {
      releaseProgressCompletion = resolve;
    });
    let markProgressCanonical: (() => void) | undefined;
    const progressCanonical = new Promise<void>((resolve) => {
      markProgressCanonical = resolve;
    });
    let blockedProgress = false;
    let saved: AgentActorSnapshot | undefined;
    let storageTail = Promise.resolve();
    const store: AgentActorStore = {
      eligibilityTimeoutMs: 65_000,
      async load() { return saved === undefined ? undefined : structuredClone(saved); },
      async save() { throw new Error('legacy save must not be used'); },
      beginSave(snapshot) {
        const dequeued = storageTail.catch(() => undefined);
        const progress = snapshot.turns.some((turn) => (
          turn.state === 'running' && (turn.progress?.length ?? 0) > 0
        ));
        const shouldBlockProgress = !blockedProgress && progress;
        if (shouldBlockProgress) blockedProgress = true;
        let phase: AgentActorSavePhase = 'queued';
        const eligible = dequeued.then(() => { phase = 'precommit'; });
        const canonical = eligible.then(() => {
          saved = structuredClone(snapshot);
          phase = 'committed';
          if (shouldBlockProgress) markProgressCanonical?.();
        });
        const completion = canonical.then(() => (
          shouldBlockProgress ? progressCompletion : undefined
        ));
        storageTail = completion.catch(() => undefined);
        return {
          dequeued,
          eligible,
          canonical,
          completion,
          phase: () => phase,
          cancelBeforeCommit: () => false,
          diagnostics: () => ({ attemptId: 'serialized', phase, timingsMs: {} }),
        };
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store,
      onBackgroundError: vi.fn(),
    });

    try {
      const target = await controller.spawn('/root', {
        taskName: 'target',
        objective: 'Complete after a legal storage wait.',
      });
      const sibling = await controller.spawn('/root', {
        taskName: 'sibling',
        objective: 'Remain active.',
      });
      const progress = executor.pending[0]!.input.reportProgress({
        kind: 'status',
        summary: 'Finishing storage maintenance.',
      });
      await progressCanonical;
      executor.pending[0]?.resolve({ output: 'durable after lock admission' });

      await vi.advanceTimersByTimeAsync(70_000);
      expect(controller.healthSnapshot()).toMatchObject({ state: 'recovering' });
      expect(controller.output('/root', sibling.actorPath, sibling.turnId)).toMatchObject({
        state: 'running',
      });

      releaseProgressCompletion?.();
      await vi.runAllTimersAsync();
      await progress;
      expect(controller.output('/root', target.actorPath, target.turnId)).toMatchObject({
        state: 'completed',
        output: 'durable after lock admission',
      });
      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
    } finally {
      releaseProgressCompletion?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('fences a terminal settlement behind a predecessor canonical commit hang', async () => {
    vi.useFakeTimers();
    let releaseProgressCommit: (() => void) | undefined;
    const progressCommit = new Promise<void>((resolve) => {
      releaseProgressCommit = resolve;
    });
    let markProgressCommitStarted: (() => void) | undefined;
    const progressCommitStarted = new Promise<void>((resolve) => {
      markProgressCommitStarted = resolve;
    });
    let blockedProgress = false;
    let saved: AgentActorSnapshot | undefined;
    const store: AgentActorStore = {
      eligibilityTimeoutMs: 65_000,
      async load() { return saved === undefined ? undefined : structuredClone(saved); },
      async save() { throw new Error('legacy save must not be used'); },
      beginSave(snapshot) {
        const progress = snapshot.turns.some((turn) => (
          turn.state === 'running' && (turn.progress?.length ?? 0) > 0
        ));
        if (!blockedProgress && progress) {
          blockedProgress = true;
          markProgressCommitStarted?.();
          let phase: AgentActorSavePhase = 'commit_inflight';
          const canonical = progressCommit.then(() => {
            saved = structuredClone(snapshot);
            phase = 'committed';
          });
          return {
            dequeued: Promise.resolve(),
            eligible: Promise.resolve(),
            canonical,
            completion: canonical,
            phase: () => phase,
            cancelBeforeCommit: () => false,
            diagnostics: () => ({
              attemptId: 'predecessor-rename-hang',
              phase,
              activeStage: 'rename',
              timingsMs: {},
            }),
          };
        }
        saved = structuredClone(snapshot);
        return {
          dequeued: Promise.resolve(),
          eligible: Promise.resolve(),
          canonical: Promise.resolve(),
          completion: Promise.resolve(),
          phase: () => 'committed',
          cancelBeforeCommit: () => false,
          diagnostics: () => ({ attemptId: 'immediate', phase: 'committed', timingsMs: {} }),
        };
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store,
      onBackgroundError: vi.fn(),
    });

    try {
      const target = await controller.spawn('/root', {
        taskName: 'target',
        objective: 'Complete behind a hung progress commit.',
      });
      await controller.spawn('/root', {
        taskName: 'sibling',
        objective: 'Be interrupted by the durability fence.',
      });
      const progress = executor.pending[0]!.input.reportProgress({
        kind: 'status',
        summary: 'Entering canonical replacement.',
      }).catch(() => undefined);
      await progressCommitStarted;
      executor.pending[0]?.resolve({ output: 'terminal behind predecessor' });

      await vi.advanceTimersByTimeAsync(5_001);
      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
        turnId: target.turnId,
      });
      expect(executor.pending[1]?.input.signal.aborted).toBe(true);

      releaseProgressCommit?.();
      await vi.runAllTimersAsync();
      await progress;
    } finally {
      releaseProgressCommit?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('still watches the terminal save when its predecessor commits at the deadline edge', async () => {
    vi.useFakeTimers();
    let saved: AgentActorSnapshot | undefined;
    let predecessorStarted = false;
    let predecessorCancelCalls = 0;
    let terminalStarted = false;
    let releasePredecessor: (() => void) | undefined;
    let releaseTerminal: (() => void) | undefined;
    const predecessorCanonical = new Promise<void>((resolve) => {
      releasePredecessor = resolve;
    });
    const terminalCanonical = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    let markPredecessorStarted: (() => void) | undefined;
    const predecessorSaveStarted = new Promise<void>((resolve) => {
      markPredecessorStarted = resolve;
    });
    const store: AgentActorStore = {
      eligibilityTimeoutMs: 65_000,
      async load() { return saved === undefined ? undefined : structuredClone(saved); },
      async save() { throw new Error('legacy save must not be used'); },
      beginSave(snapshot) {
        const progress = snapshot.turns.some((turn) => (
          turn.state === 'running' && (turn.progress?.length ?? 0) > 0
        ));
        if (!predecessorStarted && progress) {
          predecessorStarted = true;
          markPredecessorStarted?.();
          let phase: AgentActorSavePhase = 'commit_inflight';
          const canonical = predecessorCanonical.then(() => {
            saved = structuredClone(snapshot);
            phase = 'committed';
          });
          return {
            dequeued: Promise.resolve(),
            eligible: Promise.resolve(),
            canonical,
            completion: canonical,
            phase: () => phase,
            cancelBeforeCommit: () => {
              predecessorCancelCalls += 1;
              void Promise.resolve().then(() => {
                releasePredecessor?.();
              });
              return false;
            },
            diagnostics: () => ({
              attemptId: 'predecessor-deadline-edge', phase, timingsMs: {},
            }),
          };
        }
        const terminal = predecessorStarted && snapshot.turns.some((turn) => (
          turn.actorPath === '/root/target' && turn.state === 'completed'
        ));
        if (!terminalStarted && terminal) {
          terminalStarted = true;
          let phase: AgentActorSavePhase = 'commit_inflight';
          const canonical = terminalCanonical.then(() => {
            saved = structuredClone(snapshot);
            phase = 'committed';
          });
          return {
            dequeued: Promise.resolve(),
            eligible: Promise.resolve(),
            canonical,
            completion: canonical,
            phase: () => phase,
            cancelBeforeCommit: () => false,
            diagnostics: () => ({
              attemptId: 'terminal-after-edge', phase, activeStage: 'rename', timingsMs: {},
            }),
          };
        }
        saved = structuredClone(snapshot);
        return {
          dequeued: Promise.resolve(),
          eligible: Promise.resolve(),
          canonical: Promise.resolve(),
          completion: Promise.resolve(),
          phase: () => 'committed',
          cancelBeforeCommit: () => false,
          diagnostics: () => ({ attemptId: 'immediate', phase: 'committed', timingsMs: {} }),
        };
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor, store });

    try {
      const target = await controller.spawn('/root', {
        taskName: 'target',
        objective: 'Hang only in the terminal replacement.',
      });
      await controller.spawn('/root', {
        taskName: 'sibling',
        objective: 'Be fenced when terminal persistence is ambiguous.',
      });
      const progress = executor.pending[0]!.input.reportProgress({
        kind: 'status',
        summary: 'Commit exactly as the predecessor watchdog expires.',
      }).catch(() => undefined);
      await predecessorSaveStarted;
      executor.pending[0]?.resolve({ output: 'terminal rename hangs' });

      await vi.advanceTimersByTimeAsync(5_001);
      expect(predecessorCancelCalls).toBe(1);
      expect(terminalStarted).toBe(true);
      expect(controller.healthSnapshot().state).toBe('recovering');
      await vi.advanceTimersByTimeAsync(5_001);
      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
        turnId: target.turnId,
      });
      expect(executor.pending[1]?.input.signal.aborted).toBe(true);

      releaseTerminal?.();
      await vi.runAllTimersAsync();
      await progress;
    } finally {
      releasePredecessor?.();
      releaseTerminal?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('rejects progress queued behind a save that loses Actor ownership', async () => {
    let saved: AgentActorSnapshot | undefined;
    let releaseProgressSave: (() => void) | undefined;
    let markProgressSaveStarted: (() => void) | undefined;
    const progressSaveStarted = new Promise<void>((resolve) => {
      markProgressSaveStarted = resolve;
    });
    const progressSave = new Promise<void>((resolve) => {
      releaseProgressSave = resolve;
    });
    let holdFirstProgress = true;
    const store: AgentActorStore = {
      async load() { return saved === undefined ? undefined : structuredClone(saved); },
      async save(snapshot, expectedRevision) {
        if (holdFirstProgress && snapshot.turns.some((turn) => (turn.progress?.length ?? 0) > 0)) {
          holdFirstProgress = false;
          markProgressSaveStarted?.();
          await progressSave;
        }
        const currentRevision = saved?.revision ?? 0;
        if (currentRevision !== expectedRevision) {
          throw Object.assign(new Error('synthetic Actor revision conflict'), {
            code: 'actor_snapshot_conflict' as const,
            expectedRevision,
            currentRevision,
          });
        }
        saved = structuredClone(snapshot);
      },
    };
    const executor = new DeferredExecutor();
    const healthChanges = vi.fn();
    const controller = await createAgentActorController({
      executor,
      store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
      onBackgroundError: vi.fn(),
      onHealthChanged: healthChanges,
    });
    await controller.spawn('/root', { taskName: 'worker', objective: 'Report progress.' });
    const execution = executor.pending[0]?.input;
    if (!execution || saved?.schemaVersion !== 2) throw new Error('Expected a saved running turn.');

    const active = execution.reportProgress({ kind: 'status', summary: 'active progress' })
      .then(() => 'resolved' as const, () => 'rejected' as const);
    await progressSaveStarted;
    const queued = execution.reportProgress({ kind: 'status', summary: 'queued progress' })
      .then(() => 'resolved' as const, () => 'rejected' as const);
    saved = {
      ...saved,
      revision: saved.revision + 1,
      owner: SECOND_OWNER,
    };
    releaseProgressSave?.();

    await expect(active).resolves.toBe('rejected');
    await expect(Promise.race([
      queued,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ])).resolves.toBe('rejected');
    expect(controller.healthSnapshot()).toMatchObject({
      state: 'unknown',
      code: 'actor_settlement_not_persisted',
    });
    expect(healthChanges).toHaveBeenCalledWith(expect.objectContaining({
      state: 'unknown',
      code: 'actor_settlement_not_persisted',
    }));
  });

  it('caps retained events without reusing sequence numbers', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'observer', objective: 'Inspect.' });
    const execution = executor.pending[0]?.input;
    if (!execution) throw new Error('Expected a running child execution.');

    for (let index = 0; index < 2_050; index += 1) {
      await execution.reportProgress({ kind: 'status', summary: `event-${index}` });
    }

    const events = controller.eventSnapshot('/root');
    expect(events).toHaveLength(2_048);
    expect(events[0]?.sequence).toBeGreaterThan(1);
    expect(events.at(-1)?.sequence).toBeGreaterThan(events[0]?.sequence ?? 0);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);
  });

  it('keeps bounded output on complete grapheme boundaries', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const child = await controller.spawn('/root', { taskName: 'unicode', objective: 'Render.' });

    executor.pending[0]?.resolve({ output: `terminal ${'🙂'.repeat(5_000)} tail` });
    await settle();

    const output = controller.output('/root', child.actorPath, child.turnId).output ?? '';
    expect(output.length).toBeLessThanOrEqual(8_192);
    expect(output).toContain('... [truncated] ...');
    expect(output).toMatch(/^terminal /u);
    expect(output).toMatch(/ tail$/u);
    expect(Buffer.from(output, 'utf8').toString('utf8')).toBe(output);
  });

  it('enforces monotonic capabilities and forbids user authority below root', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      rootCapabilities: {
        tools: ['read', 'write'], filesystem: 'read', network: false,
        providers: ['mock'], canAskUser: true,
      },
    });
    await controller.spawn('/root', {
      taskName: 'reader', objective: 'Read.',
      capabilities: { tools: ['read'], filesystem: 'read', network: false, providers: ['mock'] },
    });
    expect(controller.get('/root', '/root/reader').actor.capabilities.canAskUser).toBe(false);
    await expect(controller.spawn('/root/reader', {
      taskName: 'writer', objective: 'Write.', capabilities: { filesystem: 'write' },
    })).rejects.toMatchObject({ code: 'invalid_capabilities' });
  });

  it('rejects budget admission without mutating actor identity or capacity', async () => {
    const budget: AgentBudgetPort = {
      async admit() {
        return {
          admitted: false,
          fact: { code: 'agent_budget_exhausted', retryable: false, reason: 'budget spent' },
        };
      },
    };
    const controller = await createAgentActorController({ budget });

    await expect(controller.spawn('/root', { taskName: 'costly', objective: 'Work.' }))
      .rejects.toBeInstanceOf(AgentBudgetExhaustedError);
    expect(controller.list('/root')).toMatchObject({ activeNonRootTurns: 0 });
    expect(controller.list('/root').actors.some((actor) => actor.path === '/root/costly')).toBe(false);
  });

  it('refunds admitted budget when a trusted spawn launch hook rejects', async () => {
    const refund = vi.fn(async () => {});
    const controller = await createAgentActorController({
      budget: {
        async admit() { return { admitted: true }; },
        refund,
      },
    });

    await expect(controller.spawn(
      '/root',
      { taskName: 'rejected', objective: 'Do not launch.' },
      { beforeLaunch() { throw new Error('trusted launch rejected'); } },
    )).rejects.toThrow('trusted launch rejected');

    expect(refund).toHaveBeenCalledOnce();
    expect(controller.list('/root').actors.some((actor) => actor.path === '/root/rejected')).toBe(false);
  });

  it('refunds admitted budget when a trusted follow-up launch hook rejects', async () => {
    const executor = new DeferredExecutor();
    const refund = vi.fn(async () => {});
    const controller = await createAgentActorController({
      executor,
      budget: {
        async admit() { return { admitted: true }; },
        refund,
      },
    });
    const first = await controller.spawn('/root', {
      taskName: 'reusable',
      objective: 'Finish the first turn.',
    });
    executor.pending[0]?.resolve({ output: 'done' });
    await settle();

    await expect(controller.followup(
      '/root',
      first.actorPath,
      'Do not launch the second turn.',
      undefined,
      { beforeLaunch() { throw new Error('trusted follow-up rejected'); } },
    )).rejects.toThrow('trusted follow-up rejected');

    expect(refund).toHaveBeenCalledOnce();
    expect(controller.get('/root', first.actorPath).actor).toMatchObject({
      state: 'idle',
      currentTurnId: undefined,
    });
  });

  it('rejects unsafe names, sibling collisions, and invalid fork windows', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    for (const taskName of ['../escape', 'workflow-owner', 'root', 'has/slash', 'line\nbreak']) {
      await expect(controller.spawn('/root', { taskName, objective: 'No.' })).rejects.toBeInstanceOf(
        AgentControlError,
      );
    }
    await expect(controller.spawn('/root', {
      taskName: 'valid', objective: 'No.', forkTurns: 0,
    })).rejects.toMatchObject({ code: 'invalid_fork_turns' });
    await controller.spawn('/root', { taskName: 'valid', objective: 'Yes.' });
    await expect(controller.spawn('/root', { taskName: 'valid', objective: 'Again.' }))
      .rejects.toMatchObject({ code: 'name_collision' });
  });

  it('interrupts a turn without deleting the reusable actor identity', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'worker', objective: 'First.' });

    await controller.interrupt('/root', '/root/worker', 'change of plan');

    expect(controller.get('/root', '/root/worker')).toMatchObject({
      actor: { state: 'idle', turnIds: [expect.any(String)] },
      turns: [{ state: 'interrupted', error: 'change of plan' }],
    });
    await expect(controller.followup('/root', '/root/worker', 'Try again.')).resolves.toMatchObject({
      delivery: 'started_turn',
    });
  });

  it('atomically installs cancellation before a durable start becomes launchable', async () => {
    let releaseStartSave: (() => void) | undefined;
    let startSaveEntered: (() => void) | undefined;
    let saveCount = 0;
    const startSaveStarted = new Promise<void>((resolve) => { startSaveEntered = resolve; });
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store: {
        async load() { return undefined; },
        async save() {
          saveCount += 1;
          if (saveCount !== 1) return;
          startSaveEntered?.();
          await new Promise<void>((resolve) => { releaseStartSave = resolve; });
        },
      },
    });

    const spawning = controller.spawn('/root', { taskName: 'racing', objective: 'Race.' });
    await startSaveStarted;
    const interrupting = controller.interrupt('/root', '/root/racing', 'cancel before launch');
    releaseStartSave?.();

    const [turn] = await Promise.all([spawning, interrupting]);
    await settle();

    expect(executor.pending).toHaveLength(1);
    expect(executor.pending[0]?.input.signal.aborted).toBe(true);
    expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted', error: 'cancel before launch',
    });
  });

  it('does not persist a late executor completion after interruption', async () => {
    const save = vi.fn(async () => undefined);
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store: { async load() { return undefined; }, save },
    });
    const turn = await controller.spawn('/root', { taskName: 'late', objective: 'Finish late.' });
    await controller.interrupt('/root', turn.actorPath, 'superseded');
    const savesAfterInterrupt = save.mock.calls.length;
    const revisionAfterInterrupt = controller.list('/root').revision;

    executor.pending[0]?.resolve({ output: 'obsolete result' });
    await settle();
    await settle();

    expect(save).toHaveBeenCalledTimes(savesAfterInterrupt);
    expect(controller.list('/root').revision).toBe(revisionAfterInterrupt);
    expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted', error: 'superseded',
    });
  });

  it('binds caller authority so model-facing inputs cannot forge an actor path', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Parent.' });
    await controller.spawn('/root', { taskName: 'peer', objective: 'Peer.' });
    const parent = controller.bind('/root/parent');

    await expect(parent.spawn({ taskName: 'child', objective: 'Child.' })).resolves.toMatchObject({
      actorPath: '/root/parent/child',
    });
    await expect(parent.interrupt('/root/peer')).rejects.toMatchObject({ code: 'permission_denied' });
    expect(Object.isFrozen(parent)).toBe(true);
  });

  it('preserves revisions and aborts active executions when closing a subtree', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Parent.' });
    await controller.spawn('/root/parent', { taskName: 'child', objective: 'Child.' });
    const before = controller.get('/root', '/root/parent/child').actor.revision;

    await controller.close('/root', '/root/parent');

    const closed = controller.get('/root', '/root/parent/child').actor;
    expect(closed).toMatchObject({ state: 'closed', currentTurnId: undefined });
    expect(closed.revision).toBeGreaterThan(before);
    expect(executor.pending[0]?.input.signal.aborted).toBe(true);
    expect(executor.pending[1]?.input.signal.aborted).toBe(true);
  });

  it('makes a closed actor inert for both mailbox directions', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'closed', objective: 'Wait.' });
    const drainClosedMailbox = executor.pending[0]?.input.drainMailbox;
    await controller.close('/root', '/root/closed');

    await expect(controller.send('/root', '/root/closed', 'Do not queue this.'))
      .rejects.toMatchObject({ code: 'actor_closed' });
    await expect(controller.send('/root/closed', '/root', 'Do not send this.'))
      .rejects.toMatchObject({ code: 'actor_closed' });
    await expect(drainClosedMailbox?.()).rejects.toMatchObject({ code: 'actor_closed' });
    expect(controller.get('/root', '/root/closed').mailbox).toEqual([]);
  });

  it('does not deliver descendant completion into a parent closed by the same subtree commit', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Wait.' });
    await controller.spawn('/root/parent', { taskName: 'child', objective: 'Wait too.' });

    await controller.close('/root', '/root/parent', 'retire branch');

    expect(controller.get('/root', '/root/parent')).toMatchObject({
      actor: { state: 'closed' },
      mailbox: [],
    });
    expect(controller.get('/root', '/root').mailbox).toEqual([
      expect.objectContaining({
        senderPath: '/root/parent',
        recipientPath: '/root',
        kind: 'completion',
        content: 'retire branch',
      }),
    ]);
  });

  it('conflicts a distinct concurrent follow-up submitted against the same idle revision', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const firstTurn = await controller.spawn('/root', { taskName: 'worker', objective: 'First.' });
    executor.pending[0]?.resolve({ output: 'first done' });
    await settle();
    const idleRevision = controller.get('/root', firstTurn.actorPath).actor.revision;

    const accepted = controller.followup(
      '/root',
      firstTurn.actorPath,
      'Accepted follow-up.',
      undefined,
      { expectedRevision: idleRevision },
    );
    const stale = controller.followup(
      '/root',
      firstTurn.actorPath,
      'Distinct stale follow-up.',
      undefined,
      { expectedRevision: idleRevision },
    );

    await expect(accepted).resolves.toMatchObject({ delivery: 'started_turn' });
    await expect(stale).rejects.toMatchObject({
      code: 'revision_conflict',
      expectedRevision: idleRevision,
      currentRevision: idleRevision + 1,
    });
    expect(controller.get('/root', firstTurn.actorPath).mailbox.some((message) => (
      message.content === 'Distinct stale follow-up.'
    ))).toBe(false);
  });

  it('checks the tree revision inside spawn admission', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const expectedTreeRevision = controller.list('/root').revision;
    await controller.spawn('/root', { taskName: 'revision-advance', objective: 'Advance.' });

    await expect(controller.spawn(
      '/root',
      { taskName: 'stale-spawn', objective: 'Must not start.' },
      { expectedTreeRevision },
    )).rejects.toMatchObject({
      code: 'revision_conflict',
      expectedRevision: expectedTreeRevision,
      currentRevision: expectedTreeRevision + 1,
    });
    expect(controller.list('/root').actors.map((actor) => actor.path))
      .not.toContain('/root/stale-spawn');
  });

  it('fences turn admission without treating child progress as an admission change', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'active', objective: 'Stay active.' });
    const expectedAdmissionRevision = controller.list('/root').admissionRevision;
    expect(expectedAdmissionRevision).toEqual(expect.any(Number));
    if (expectedAdmissionRevision === undefined) throw new Error('Missing admission revision.');

    await executor.pending[0]?.input.reportProgress({
      kind: 'status',
      summary: 'Startup progress.',
    });
    expect(controller.list('/root').admissionRevision).toBe(expectedAdmissionRevision);
    await controller.send('/root', '/root/active', 'Mailbox update.');
    expect(controller.list('/root').admissionRevision).toBe(expectedAdmissionRevision);
    await expect(executor.pending[0]?.input.drainMailbox()).resolves.toMatchObject([
      { content: 'Mailbox update.' },
    ]);
    expect(controller.list('/root').admissionRevision).toBe(expectedAdmissionRevision);

    await expect(controller.spawn(
      '/root',
      { taskName: 'accepted', objective: 'Start after progress.' },
      { expectedAdmissionRevision },
    )).resolves.toMatchObject({ actorPath: '/root/accepted' });
    await expect(controller.spawn(
      '/root',
      { taskName: 'stale-admission', objective: 'Must not start.' },
      { expectedAdmissionRevision },
    )).rejects.toMatchObject({
      code: 'revision_conflict',
      expectedRevision: expectedAdmissionRevision,
      currentRevision: expectedAdmissionRevision + 1,
    });
  });

  it('derives and persists an admission revision when loading an older snapshot', async () => {
    const state = revisionedActorStore();
    const executor = new DeferredExecutor();
    const original = await createAgentActorController({ store: state.store, executor });
    await original.spawn('/root', { taskName: 'legacy-target', objective: 'Become idle.' });
    executor.pending[0]?.resolve({ output: 'idle' });
    await settle();
    await original.send('/root', '/root/legacy-target', 'Persist a mailbox-only revision.');
    const saved = state.read();
    if (!saved) throw new Error('Expected a persisted Actor snapshot.');
    const { admissionRevision: ignored, ...legacySnapshot } = saved;
    void ignored;
    state.replace(legacySnapshot);

    const recovered = await createAgentActorController({ store: state.store });
    expect(recovered.list('/root')).toMatchObject({
      revision: saved.revision,
      admissionRevision: saved.revision,
    });
    await recovered.send('/root', '/root/legacy-target', 'Advance only the full revision.');
    expect(recovered.list('/root').admissionRevision).toBe(saved.revision);

    await recovered.spawn(
      '/root',
      { taskName: 'post-upgrade', objective: 'Persist the derived fence.' },
      { expectedAdmissionRevision: saved.revision },
    );
    expect(state.read()).toMatchObject({
      admissionRevision: saved.revision + 1,
    });
  });

  it('merges executor-observed facts into durable turn metadata at completion', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const turn = await controller.spawn('/root', {
      taskName: 'routed',
      objective: 'Observe the effective route.',
      metadata: { requestedProvider: 'primary' },
    });

    executor.pending[0]?.resolve({
      output: 'done',
      turnMetadata: {
        effectiveProvider: 'fallback',
        effectiveModel: 'fallback-model',
      },
    });
    await settle();

    expect(controller.get('/root', turn.actorPath).turns[0]?.metadata).toEqual({
      requestedProvider: 'primary',
      effectiveProvider: 'fallback',
      effectiveModel: 'fallback-model',
    });
  });

  it('merges executor-observed facts into durable turn metadata on failure', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const turn = await controller.spawn('/root', {
      taskName: 'failed-route',
      objective: 'Observe a failed effective route.',
      metadata: { requestedProvider: 'primary' },
    });

    executor.pending[0]?.reject(new AgentExecutionError('Provider rejected the request.', {
      effectiveProvider: 'fallback',
      effectiveModel: 'fallback-model',
      executionFailure: {
        message: 'Provider rejected the request. (HTTP 400)',
        safeMessage: 'Provider rejected the request.',
        errorClass: 'non_retryable_provider_error',
        requestPhase: 'before_first_delta',
        httpStatus: 400,
      },
    }));
    await settle();

    expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
      state: 'failed',
      error: 'Provider rejected the request.',
    });
    expect(controller.get('/root', turn.actorPath).turns[0]?.metadata).toMatchObject({
      requestedProvider: 'primary',
      effectiveProvider: 'fallback',
      effectiveModel: 'fallback-model',
      executionFailure: {
        message: 'Provider rejected the request. (HTTP 400)',
        safeMessage: 'Provider rejected the request.',
        httpStatus: 400,
      },
    });
  });

  it('interrupts unfinished turns on shutdown without permanently closing reusable actors', async () => {
    let snapshot: AgentActorSnapshot | undefined;
    const store: AgentActorStore = {
      async load() { return snapshot; },
      async save(next) { snapshot = next; },
    };
    const firstExecutor = new DeferredExecutor();
    const first = await createAgentActorController({ executor: firstExecutor, store });
    await first.spawn('/root', { taskName: 'worker', objective: 'First pass.' });

    await first.shutdown('runtime stopped');

    expect(firstExecutor.pending[0]?.input.signal.aborted).toBe(true);
    expect(first.get('/root', '/root').actor.state).toBe('running');
    expect(first.get('/root', '/root/worker').actor.state).toBe('idle');
    expect(first.output('/root', '/root/worker')).toMatchObject({
      state: 'interrupted', error: 'runtime stopped',
    });

    const restartedExecutor = new DeferredExecutor();
    const restarted = await createAgentActorController({ executor: restartedExecutor, store });
    await expect(restarted.followup('/root', '/root/worker', 'Resume.')).resolves.toMatchObject({
      delivery: 'started_turn',
      turn: { actorPath: '/root/worker' },
    });
    expect(restartedExecutor.pending).toHaveLength(1);
  });

  it('does not recover an Actor tree while its durable Runtime owner is still alive', async () => {
    const state = revisionedActorStore();
    const firstExecutor = new DeferredExecutor();
    const first = new AgentActorController({
      executor: firstExecutor,
      store: state.store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
    });
    await first.initialize();
    const turn = await first.spawn('/root', {
      taskName: 'worker',
      objective: 'Remain owned by the first Runtime.',
    });

    const contender = new AgentActorController({
      store: state.store,
      owner: SECOND_OWNER,
      isOwnerAlive: async () => true,
    });

    await expect(contender.initialize()).rejects.toMatchObject({
      code: 'actor_owner_conflict',
      ownerRuntimeId: FIRST_OWNER.runtimeId,
    });
    expect(firstExecutor.pending[0]?.input.signal.aborted).toBe(false);
    expect(state.read()?.turns.find((candidate) => candidate.turnId === turn.turnId)).toMatchObject({
      state: 'running',
    });
  });

  it('fails closed when an owner-aware Runtime finds active turns in a legacy snapshot', async () => {
    const state = revisionedActorStore();
    const legacyExecutor = new DeferredExecutor();
    const legacy = new AgentActorController({
      executor: legacyExecutor,
      store: state.store,
    });
    await legacy.initialize();
    const turn = await legacy.spawn('/root', {
      taskName: 'legacy-worker',
      objective: 'May still be executing in a pre-owner Runtime.',
    });
    const savesBeforeUpgrade = state.saveCount();
    const upgraded = new AgentActorController({
      store: state.store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => false,
    });

    await expect(upgraded.initialize()).rejects.toMatchObject({
      code: 'actor_owner_unknown',
      currentRevision: state.read()?.revision,
    });
    expect(state.saveCount()).toBe(savesBeforeUpgrade);
    expect(legacyExecutor.pending[0]?.input.signal.aborted).toBe(false);
    expect(state.read()?.turns.find((candidate) => candidate.turnId === turn.turnId))
      .toMatchObject({ state: 'running' });
  });

  it('upgrades a terminal legacy snapshot to an owned schema-v2 snapshot', async () => {
    const state = revisionedActorStore();
    const legacyExecutor = new DeferredExecutor();
    const legacy = new AgentActorController({
      executor: legacyExecutor,
      store: state.store,
    });
    await legacy.initialize();
    await legacy.spawn('/root', {
      taskName: 'legacy-worker',
      objective: 'Finish before upgrade.',
    });
    legacyExecutor.pending[0]?.resolve({ output: 'done' });
    await settle();

    const upgraded = new AgentActorController({
      store: state.store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => false,
    });
    await upgraded.initialize();

    expect(state.read()).toMatchObject({
      schemaVersion: 2,
      owner: FIRST_OWNER,
    });
  });

  it('requires an owner-aware controller for a released schema-v2 Actor tree', async () => {
    const state = revisionedActorStore();
    const owner = new AgentActorController({
      store: state.store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
    });
    await owner.initialize();
    await owner.shutdown();

    const ownerless = new AgentActorController({ store: state.store });

    await expect(ownerless.initialize()).rejects.toMatchObject({
      code: 'actor_owner_conflict',
      ownerRuntimeId: undefined,
    });
  });

  it('ignores an executor settlement that arrives after owner release', async () => {
    const state = revisionedActorStore();
    const executor = new DeferredExecutor();
    const onBackgroundError = vi.fn();
    const owner = new AgentActorController({
      store: state.store,
      executor,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
      onBackgroundError,
    });
    await owner.initialize();
    await owner.spawn('/root', { taskName: 'worker', objective: 'Stop on shutdown.' });
    await owner.shutdown();

    executor.pending[0]?.reject(new Error('late abort settlement'));
    await settle();
    await settle();

    expect(onBackgroundError).not.toHaveBeenCalled();
  });

  it('disposes local executors after the backing Session has been deleted without writing again', async () => {
    const state = revisionedActorStore();
    const executor = new DeferredExecutor();
    const onBackgroundError = vi.fn();
    const owner = new AgentActorController({
      store: state.store,
      executor,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
      onBackgroundError,
    });
    await owner.initialize();
    const turn = await owner.spawn('/root', {
      taskName: 'worker',
      objective: 'Stop when the Session file is removed.',
    });
    const cursor = owner.eventSnapshot('/root').at(-1)?.sequence ?? 0;
    const waiting = owner.wait('/root', cursor, 30_000);
    const savesBeforeDispose = state.saveCount();

    owner.disposeAfterStoreRemoval('session deleted');

    expect(executor.pending[0]?.input.signal.aborted).toBe(true);
    await expect(waiting).resolves.toBeUndefined();
    executor.pending[0]?.reject(new Error('late deleted-session settlement'));
    await settle();
    await settle();

    expect(state.saveCount()).toBe(savesBeforeDispose);
    expect(onBackgroundError).not.toHaveBeenCalled();
    await expect(owner.followup('/root', turn.actorPath, 'Must stay disposed.'))
      .rejects.toMatchObject({ code: 'actor_owner_conflict' });
  });

  it('makes concurrent owner shutdown calls idempotent', async () => {
    const state = revisionedActorStore();
    const owner = new AgentActorController({
      store: state.store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
    });
    await owner.initialize();

    await expect(Promise.all([
      owner.shutdown('first close'),
      owner.shutdown('second close'),
    ])).resolves.toEqual([undefined, undefined]);
    expect(state.read()).toMatchObject({ schemaVersion: 2 });
    expect(state.read()?.schemaVersion === 2 ? state.read()?.owner : undefined)
      .toBeUndefined();
  });

  it('takes over a dead durable owner before recovering unmatched local turns', async () => {
    const state = revisionedActorStore();
    const first = new AgentActorController({
      executor: new DeferredExecutor(),
      store: state.store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
    });
    await first.initialize();
    const turn = await first.spawn('/root', {
      taskName: 'worker',
      objective: 'Become unmatched after the owner crashes.',
    });

    const recovered = new AgentActorController({
      store: state.store,
      owner: SECOND_OWNER,
      isOwnerAlive: async () => false,
    });
    await recovered.initialize();

    expect(state.read()).toMatchObject({
      schemaVersion: 2,
      owner: SECOND_OWNER,
    });
    expect(recovered.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted',
      error: 'runtime_recovered_without_executor',
    });
  });

  it('releases a newly claimed owner when unmatched-turn recovery fails', async () => {
    const state = revisionedActorStore();
    const first = new AgentActorController({
      executor: new DeferredExecutor(),
      store: state.store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
    });
    await first.initialize();
    const turn = await first.spawn('/root', {
      taskName: 'worker',
      objective: 'Remain recoverable after a transient store failure.',
    });
    let failRecoverySave = true;
    const transientStore: AgentActorStore = {
      load: state.store.load,
      async save(snapshot, expectedRevision) {
        if (
          failRecoverySave
          && snapshot.schemaVersion === 2
          && snapshot.owner?.ownerId === SECOND_OWNER.ownerId
          && snapshot.turns.every((candidate) => (
            candidate.state === 'completed'
            || candidate.state === 'failed'
            || candidate.state === 'interrupted'
          ))
        ) {
          failRecoverySave = false;
          throw new Error('transient recovery write failure');
        }
        await state.store.save(snapshot, expectedRevision);
      },
    };
    const failedRecovery = new AgentActorController({
      store: transientStore,
      owner: SECOND_OWNER,
      isOwnerAlive: async () => false,
    });

    await expect(failedRecovery.initialize()).rejects.toThrow(
      'transient recovery write failure',
    );
    expect(state.read()).toMatchObject({ schemaVersion: 2 });
    expect(state.read()?.schemaVersion === 2 ? state.read()?.owner : undefined)
      .toBeUndefined();

    await expect(failedRecovery.initialize()).resolves.toBeUndefined();
    expect(failedRecovery.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted',
      error: 'runtime_recovered_without_executor',
    });
  });

  it('can clean up its owner after recovery and the first release write both fail', async () => {
    const state = revisionedActorStore();
    const first = new AgentActorController({
      executor: new DeferredExecutor(),
      store: state.store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
    });
    await first.initialize();
    await first.spawn('/root', {
      taskName: 'worker',
      objective: 'Remain active across the simulated crash.',
    });

    let claimed = false;
    let failuresAfterClaim = 0;
    const twiceFailingStore: AgentActorStore = {
      load: state.store.load,
      async save(snapshot, expectedRevision) {
        if (
          !claimed
          && snapshot.schemaVersion === 2
          && snapshot.owner?.ownerId === SECOND_OWNER.ownerId
          && snapshot.turns.some((turn) => ![
            'completed',
            'failed',
            'interrupted',
          ].includes(turn.state))
        ) {
          await state.store.save(snapshot, expectedRevision);
          claimed = true;
          return;
        }
        if (claimed && failuresAfterClaim < 2) {
          failuresAfterClaim += 1;
          throw new Error(`transient owner cleanup failure ${failuresAfterClaim}`);
        }
        await state.store.save(snapshot, expectedRevision);
      },
    };
    const controller = new AgentActorController({
      store: twiceFailingStore,
      owner: SECOND_OWNER,
      isOwnerAlive: async () => false,
    });

    await expect(controller.initialize()).rejects.toBeInstanceOf(AggregateError);
    expect(state.read()).toMatchObject({ schemaVersion: 2, owner: SECOND_OWNER });

    await expect(controller.shutdown('initialization cleanup')).resolves.toBeUndefined();
    expect(state.read()?.schemaVersion === 2 ? state.read()?.owner : undefined)
      .toBeUndefined();
  });

  it('fences a stale owner, aborts its physical execution, and refreshes durable state', async () => {
    const state = revisionedActorStore();
    const executor = new DeferredExecutor();
    const onMessageCommitted = vi.fn();
    const first = new AgentActorController({
      executor,
      store: state.store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
      onMessageCommitted,
    });
    await first.initialize();
    const turn = await first.spawn('/root', {
      taskName: 'worker',
      objective: 'Stop when ownership is lost.',
    });
    const cursor = first.eventSnapshot('/root').at(-1)?.sequence ?? 0;
    const waiting = first.wait('/root', cursor, 1_000);
    const beforeTakeover = state.read();
    if (!beforeTakeover) throw new Error('Expected a durable Actor snapshot.');
    const completedAt = '2026-07-28T00:02:00.000Z';
    const rootMailbox = beforeTakeover.mailboxes['/root'] ?? [];
    const completion = {
      messageId: `msg_${rootMailbox.length + 1}_recovered`,
      sequence: (rootMailbox.at(-1)?.sequence ?? 0) + 1,
      senderPath: turn.actorPath,
      recipientPath: '/root',
      turnId: turn.turnId,
      kind: 'completion',
      classification: 'internal',
      lineage: [turn.actorPath],
      content: 'runtime_recovered_without_executor',
      createdAt: completedAt,
    } as const;
    const supersedingSnapshot = {
      ...beforeTakeover,
      schemaVersion: 2,
      revision: beforeTakeover.revision + 1,
      owner: SECOND_OWNER,
      actors: beforeTakeover.actors.map((actor) => (
        actor.path === turn.actorPath
          ? {
              ...actor,
              state: 'idle',
              currentTurnId: undefined,
              updatedAt: completedAt,
              revision: actor.revision + 1,
            }
          : actor
      )),
      turns: beforeTakeover.turns.map((candidate) => (
        candidate.turnId === turn.turnId
          ? {
              ...candidate,
              state: 'interrupted',
              completedAt,
              error: 'runtime_recovered_without_executor',
              revision: candidate.revision + 1,
            }
          : candidate
      )),
      mailboxes: {
        ...beforeTakeover.mailboxes,
        '/root': [...rootMailbox, completion],
      },
      pendingRootCompletionTurnIds: [
        ...(beforeTakeover.pendingRootCompletionTurnIds ?? []),
        turn.turnId,
      ],
      events: [
        ...beforeTakeover.events,
        {
          sequence: (beforeTakeover.events.at(-1)?.sequence ?? 0) + 1,
          kind: 'turn_interrupted',
          actorPath: turn.actorPath,
          turnId: turn.turnId,
          parentPath: '/root',
          createdAt: completedAt,
        },
      ],
    } as unknown as AgentActorSnapshot;
    state.replace(supersedingSnapshot);

    await expect(first.interrupt('/root', turn.actorPath, 'stop requested')).resolves.toBeUndefined();

    expect(executor.pending[0]?.input.signal.aborted).toBe(true);
    await expect(waiting).resolves.toMatchObject({
      kind: 'turn_interrupted',
      actorPath: turn.actorPath,
      turnId: turn.turnId,
    });
    expect(onMessageCommitted).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'completion',
      turnId: turn.turnId,
    }));
    expect(first.list('/root')).toMatchObject({
      revision: supersedingSnapshot.revision,
      activeNonRootTurns: 0,
    });
    expect(first.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted',
      error: 'runtime_recovered_without_executor',
    });
    const savesAfterFence = state.saveCount();
    await expect(first.spawn('/root', {
      taskName: 'after-loss',
      objective: 'Must not write from the stale owner.',
    })).rejects.toMatchObject({
      code: 'actor_owner_conflict',
    });
    expect(state.saveCount()).toBe(savesAfterFence);
  });

  it('permanently fences a legacy ownerless controller after its first store CAS conflict', async () => {
    const state = revisionedActorStore();
    const winner = new AgentActorController({
      executor: new DeferredExecutor(),
      store: state.store,
    });
    const stale = new AgentActorController({
      executor: new DeferredExecutor(),
      store: state.store,
    });
    await Promise.all([winner.initialize(), stale.initialize()]);
    await winner.spawn('/root', { taskName: 'winner', objective: 'Commit first.' });

    await expect(stale.spawn('/root', {
      taskName: 'stale-first',
      objective: 'Lose the CAS race.',
    })).rejects.toMatchObject({ code: 'actor_owner_conflict' });
    const savesAfterFence = state.saveCount();

    await expect(stale.spawn('/root', {
      taskName: 'stale-second',
      objective: 'Must remain fenced after refresh.',
    })).rejects.toMatchObject({ code: 'actor_owner_conflict' });
    expect(state.saveCount()).toBe(savesAfterFence);
  });

  it('fails an unmatched external turn with an explicit unknown-state recovery error', async () => {
    let snapshot: AgentActorSnapshot | undefined;
    const store: AgentActorStore = {
      async load() { return snapshot; },
      async save(next) { snapshot = next; },
    };
    const executor = new DeferredExecutor();
    const first = await createAgentActorController({ executor, store });
    await first.spawn('/root', {
      taskName: 'remote-review',
      objective: 'Review remotely.',
      kind: 'external',
    });

    const recovered = await createAgentActorController({ store });

    expect(recovered.get('/root', '/root/remote-review').actor.state).toBe('idle');
    expect(recovered.output('/root', '/root/remote-review')).toMatchObject({
      state: 'failed', error: 'external_state_unknown',
    });
  });

  it('fails closed on a newer Actor snapshot schema without overwriting it', async () => {
    let saved: AgentActorSnapshot | undefined;
    const first = await createAgentActorController({
      executor: new DeferredExecutor(),
      store: {
        async load() { return undefined; },
        async save(snapshot) { saved = snapshot; },
      },
    });
    await first.spawn('/root', { taskName: 'worker', objective: 'Persist.' });
    if (!saved) throw new Error('Expected an Actor snapshot to be persisted.');
    const incompatible = { ...saved, schemaVersion: 3 } as unknown as AgentActorSnapshot;
    const save = vi.fn(async () => undefined);
    const recovered = new AgentActorController({
      store: { async load() { return incompatible; }, save },
    });

    await expect(recovered.initialize()).rejects.toThrow('Unsupported actor snapshot schema');
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects pending completion delivery state without a terminal turn', async () => {
    let saved: AgentActorSnapshot | undefined;
    const executor = new DeferredExecutor();
    const first = await createAgentActorController({
      executor,
      store: {
        async load() { return undefined; },
        async save(snapshot) { saved = snapshot; },
      },
    });
    await first.spawn('/root', { taskName: 'worker', objective: 'Persist.' });
    executor.pending[0]?.resolve({ output: 'done' });
    await settle();
    if (!saved) throw new Error('Expected an Actor snapshot to be persisted.');
    const invalid = { ...saved, turns: [] };

    const restored = new AgentActorController({
      store: {
        async load() { return invalid; },
        async save() {},
      },
    });

    await expect(restored.initialize()).rejects.toThrow(
      'root completion turn is missing or non-terminal',
    );
  });

  it('restores abort handles when a durable mutation is rolled back', async () => {
    let failSave = false;
    const store: AgentActorStore = {
      async load() { return undefined; },
      async save(_snapshot: AgentActorSnapshot) {
        if (failSave) throw new Error('disk unavailable');
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor, store });
    await controller.spawn('/root', { taskName: 'worker', objective: 'Work.' });
    failSave = true;

    await expect(controller.interrupt('/root', '/root/worker')).rejects.toThrow('disk unavailable');
    expect(controller.get('/root', '/root/worker').actor.state).toBe('running');
    expect(executor.pending[0]?.input.signal.aborted).toBe(false);

    failSave = false;
    await controller.interrupt('/root', '/root/worker');
    expect(executor.pending[0]?.input.signal.aborted).toBe(true);
  });

  it('retries a failed durable completion commit without duplicating terminal evidence', async () => {
    let saved: AgentActorSnapshot | undefined;
    let completionSaveAttempts = 0;
    const onBackgroundError = vi.fn();
    const onMessageCommitted = vi.fn();
    const store: AgentActorStore = {
      async load() { return undefined; },
      async save(snapshot) {
        const turn = snapshot.turns.find((candidate) => candidate.actorPath === '/root/worker');
        if (turn?.state === 'completed') {
          completionSaveAttempts += 1;
          if (completionSaveAttempts === 1) throw new Error('completion save failed');
        }
        saved = structuredClone(snapshot);
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store,
      onBackgroundError,
      onMessageCommitted,
    });
    const turn = await controller.spawn('/root', { taskName: 'worker', objective: 'Work.' });

    executor.pending[0]?.resolve({ output: 'done' });
    await vi.waitFor(() => {
      expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
        state: 'completed',
        output: 'done',
      });
    });

    expect(completionSaveAttempts).toBe(2);
    expect(saved?.turns.find((candidate) => candidate.turnId === turn.turnId)).toMatchObject({
      state: 'completed',
      output: 'done',
    });
    expect(onBackgroundError).toHaveBeenCalledTimes(1);
    expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'completion save failed',
    }));
    expect(onMessageCommitted).toHaveBeenCalledTimes(1);
    expect(onMessageCommitted).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'completion',
      turnId: turn.turnId,
    }));
    expect(controller.eventSnapshot('/root').filter((event) => (
      event.kind === 'turn_completed' && event.turnId === turn.turnId
    ))).toHaveLength(1);
  });

  it('retries a failed durable executor failure commit without duplicating completion notice', async () => {
    let failedSaveAttempts = 0;
    const onBackgroundError = vi.fn();
    const onMessageCommitted = vi.fn();
    const store: AgentActorStore = {
      async load() { return undefined; },
      async save(snapshot) {
        const turn = snapshot.turns.find((candidate) => candidate.actorPath === '/root/worker');
        if (turn?.state === 'failed') {
          failedSaveAttempts += 1;
          if (failedSaveAttempts === 1) throw new Error('failure save failed');
        }
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store,
      onBackgroundError,
      onMessageCommitted,
    });
    const turn = await controller.spawn('/root', { taskName: 'worker', objective: 'Work.' });

    executor.pending[0]?.reject(new Error('executor failed'));
    await vi.waitFor(() => {
      expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
        state: 'failed',
        error: 'executor failed',
      });
    });

    expect(failedSaveAttempts).toBe(2);
    expect(onBackgroundError).toHaveBeenCalledTimes(1);
    expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'failure save failed',
    }));
    expect(onMessageCommitted).toHaveBeenCalledTimes(1);
    expect(onMessageCommitted).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'completion',
      turnId: turn.turnId,
    }));
    expect(controller.eventSnapshot('/root').filter((event) => (
      event.kind === 'turn_failed' && event.turnId === turn.turnId
    ))).toHaveLength(1);
  });

  it('stops retrying a permanently unpersistable settlement and reports unknown health', async () => {
    vi.useFakeTimers();
    try {
      let completionSaveAttempts = 0;
      const healthChanges = vi.fn();
      const onBackgroundError = vi.fn();
      const store: AgentActorStore = {
        async load() { return undefined; },
        async save(snapshot) {
          const turn = snapshot.turns.find(
            (candidate) => candidate.actorPath === '/root/worker',
          );
          if (turn?.state === 'completed') {
            completionSaveAttempts += 1;
            throw new Error('disk remains unavailable');
          }
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        onBackgroundError,
        onHealthChanged: healthChanges,
      });
      const turn = await controller.spawn('/root', {
        taskName: 'worker',
        objective: 'Persist or become unknown.',
      });

      executor.pending[0]?.resolve({ output: 'not durable' });
      await vi.advanceTimersByTimeAsync(6_000);

      expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
        state: 'running',
      });
      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
        turnId: turn.turnId,
      });
      expect(healthChanges).toHaveBeenCalledWith(expect.objectContaining({
        state: 'recovering',
        turnId: turn.turnId,
      }));
      expect(healthChanges).toHaveBeenCalledWith(expect.objectContaining({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
      }));
      expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({
        code: 'actor_settlement_not_persisted',
      }));
      const attemptsAtDeadline = completionSaveAttempts;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(completionSaveAttempts).toBe(attemptsAtDeadline);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the settlement deadline after storage eligibility and not after full completion', async () => {
    vi.useFakeTimers();
    try {
      let saved: AgentActorSnapshot | undefined;
      let releaseEligibility: (() => void) | undefined;
      let releaseCanonical: (() => void) | undefined;
      let releaseCompletion: (() => void) | undefined;
      const eligibilityGate = new Promise<void>((resolve) => { releaseEligibility = resolve; });
      const canonicalGate = new Promise<void>((resolve) => { releaseCanonical = resolve; });
      const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
      let terminalAttempt: AgentActorSaveAttempt | undefined;
      const store: AgentActorStore = {
        eligibilityTimeoutMs: 65_000,
        async load() { return saved === undefined ? undefined : structuredClone(saved); },
        async save() { throw new Error('legacy save must not be used'); },
        beginSave(snapshot) {
          const terminal = snapshot.turns.some((turn) => turn.state === 'completed');
          if (!terminal) {
            saved = structuredClone(snapshot);
            return {
              dequeued: Promise.resolve(),
              eligible: Promise.resolve(),
              canonical: Promise.resolve(),
              completion: Promise.resolve(),
              phase: () => 'committed',
              cancelBeforeCommit: () => false,
              diagnostics: () => ({ attemptId: 'immediate', phase: 'committed', timingsMs: {} }),
            };
          }
          let phase = 'queued' as const | 'precommit' | 'committed';
          const eligible = eligibilityGate.then(() => { phase = 'precommit'; });
          const canonical = eligible.then(() => canonicalGate).then(() => {
            saved = structuredClone(snapshot);
            phase = 'committed';
          });
          terminalAttempt = {
            dequeued: Promise.resolve(),
            eligible,
            canonical,
            completion: canonical.then(() => completionGate),
            phase: () => phase,
            cancelBeforeCommit: () => false,
            diagnostics: () => ({ attemptId: 'terminal', phase, timingsMs: {} }),
          };
          return terminalAttempt;
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        onBackgroundError: vi.fn(),
      });
      const turn = await controller.spawn('/root', {
        taskName: 'worker',
        objective: 'Wait for storage eligibility.',
      });

      executor.pending[0]?.resolve({ output: 'durable at canonical commit' });
      await vi.advanceTimersByTimeAsync(6_000);

      expect(terminalAttempt?.phase()).toBe('queued');
      expect(controller.healthSnapshot()).toMatchObject({ state: 'recovering' });
      releaseEligibility?.();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(controller.healthSnapshot()).toMatchObject({ state: 'recovering' });

      releaseCanonical?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
        state: 'completed',
        output: 'durable at canonical commit',
      });
      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      expect(terminalAttempt?.phase()).toBe('committed');

      releaseCompletion?.();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a canonical settlement when post-commit maintenance rejects', async () => {
    let saved: AgentActorSnapshot | undefined;
    let terminalAttempts = 0;
    const onBackgroundError = vi.fn();
    const store: AgentActorStore = {
      eligibilityTimeoutMs: 65_000,
      async load() { return saved === undefined ? undefined : structuredClone(saved); },
      async save() { throw new Error('legacy save must not be used'); },
      beginSave(snapshot) {
        const terminal = snapshot.turns.some((turn) => turn.state === 'completed');
        if (!terminal) {
          saved = structuredClone(snapshot);
          return {
            dequeued: Promise.resolve(),
            eligible: Promise.resolve(),
            canonical: Promise.resolve(),
            completion: Promise.resolve(),
            phase: () => 'committed',
            cancelBeforeCommit: () => false,
            diagnostics: () => ({ attemptId: 'immediate', phase: 'committed', timingsMs: {} }),
          };
        }
        terminalAttempts += 1;
        let phase: AgentActorSavePhase = 'precommit';
        const canonical = Promise.resolve().then(() => {
          saved = structuredClone(snapshot);
          phase = 'committed';
        });
        const completion = canonical.then(() => {
          throw new Error('post-commit watermark failed');
        });
        return {
          dequeued: Promise.resolve(),
          eligible: Promise.resolve(),
          canonical,
          completion,
          phase: () => phase,
          cancelBeforeCommit: () => false,
          diagnostics: () => ({
            attemptId: 'postcommit-reject',
            phase,
            timingsMs: { rename: 3, postCommit: 7 },
          }),
        };
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store,
      onBackgroundError,
    });
    const target = await controller.spawn('/root', {
      taskName: 'target',
      objective: 'Commit before maintenance.',
    });
    const sibling = await controller.spawn('/root', {
      taskName: 'sibling',
      objective: 'Remain active.',
    });

    executor.pending[0]?.resolve({ output: 'canonical result' });
    await vi.waitFor(() => {
      expect(controller.output('/root', target.actorPath, target.turnId)).toMatchObject({
        state: 'completed',
        output: 'canonical result',
      });
      expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining(
          'post-commit watermark failed Actor store attempt postcommit-reject committed',
        ),
      }));
    });

    expect(terminalAttempts).toBe(1);
    expect(controller.output('/root', sibling.actorPath, sibling.turnId)).toMatchObject({
      state: 'running',
    });
    expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
    expect(saved?.turns.find((turn) => turn.turnId === target.turnId)).toMatchObject({
      state: 'completed',
      output: 'canonical result',
    });
  });

  it('cancels and retries a precommit timeout without fencing sibling work', async () => {
    vi.useFakeTimers();
    let releaseCancelledCompletion: (() => void) | undefined;
    try {
      let saved: AgentActorSnapshot | undefined;
      let terminalAttempts = 0;
      let cancelledAttempts = 0;
      const cancelledCompletion = new Promise<void>((resolve) => {
        releaseCancelledCompletion = resolve;
      });
      let markTerminalStarted: (() => void) | undefined;
      const terminalStarted = new Promise<void>((resolve) => { markTerminalStarted = resolve; });
      const healthChanges = vi.fn();
      const store: AgentActorStore = {
        eligibilityTimeoutMs: 65_000,
        async load() { return saved === undefined ? undefined : structuredClone(saved); },
        async save() { throw new Error('legacy save must not be used'); },
        beginSave(snapshot) {
          const terminal = snapshot.turns.some((turn) => turn.state === 'completed');
          if (!terminal || terminalAttempts > 0) {
            if (terminal) terminalAttempts += 1;
            saved = structuredClone(snapshot);
            return {
              dequeued: Promise.resolve(),
              eligible: Promise.resolve(),
              canonical: Promise.resolve(),
              completion: Promise.resolve(),
              phase: () => 'committed',
              cancelBeforeCommit: () => false,
              diagnostics: () => ({ attemptId: 'committed', phase: 'committed', timingsMs: {} }),
            };
          }
          terminalAttempts += 1;
          markTerminalStarted?.();
          let phase = 'precommit' as const | 'not_committed';
          let rejectCanonical: ((error: unknown) => void) | undefined;
          const canonical = new Promise<void>((_resolve, reject) => {
            rejectCanonical = reject;
          });
          return {
            dequeued: Promise.resolve(),
            eligible: Promise.resolve(),
            canonical,
            completion: cancelledCompletion.then(() => canonical),
            phase: () => phase,
            cancelBeforeCommit: () => {
              phase = 'not_committed';
              cancelledAttempts += 1;
              rejectCanonical?.(Object.assign(new Error('cancelled before commit'), {
                code: 'actor_snapshot_save_cancelled' as const,
              }));
              return true;
            },
            diagnostics: () => ({ attemptId: 'precommit', phase, timingsMs: {} }),
          };
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        onBackgroundError: vi.fn(),
        onHealthChanged: healthChanges,
      });
      const target = await controller.spawn('/root', {
        taskName: 'target',
        objective: 'Retry a cancelled precommit save.',
      });
      const sibling = await controller.spawn('/root', {
        taskName: 'sibling',
        objective: 'Remain active.',
      });

      executor.pending[0]?.resolve({ output: 'committed on retry' });
      await terminalStarted;
      await vi.advanceTimersByTimeAsync(5_100);

      expect(cancelledAttempts).toBe(1);
      expect(terminalAttempts).toBe(1);
      await vi.advanceTimersByTimeAsync(70_000);
      expect(controller.healthSnapshot()).toMatchObject({ state: 'recovering' });
      expect(terminalAttempts).toBe(1);
      releaseCancelledCompletion?.();
      await vi.runAllTimersAsync();
      expect(terminalAttempts).toBe(2);
      expect(controller.output('/root', target.actorPath, target.turnId)).toMatchObject({
        state: 'completed',
        output: 'committed on retry',
      });
      expect(controller.output('/root', sibling.actorPath, sibling.turnId)).toMatchObject({
        state: 'running',
      });
      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      expect(healthChanges).not.toHaveBeenCalledWith(expect.objectContaining({
        state: 'unknown',
      }));
    } finally {
      releaseCancelledCompletion?.();
      vi.useRealTimers();
    }
  });

  it('does not charge a retry queue wait against the settlement persistence deadline', async () => {
    vi.useFakeTimers();
    try {
      let completionSaveAttempts = 0;
      let releaseQueuedMutation: (() => void) | undefined;
      let markQueuedMutationStarted: (() => void) | undefined;
      let releaseRetrySave: (() => void) | undefined;
      let markRetrySaveStarted: (() => void) | undefined;
      const queuedMutationGate = new Promise<void>((resolve) => {
        releaseQueuedMutation = resolve;
      });
      const queuedMutationStarted = new Promise<void>((resolve) => {
        markQueuedMutationStarted = resolve;
      });
      const retrySaveGate = new Promise<void>((resolve) => {
        releaseRetrySave = resolve;
      });
      const retrySaveStarted = new Promise<void>((resolve) => {
        markRetrySaveStarted = resolve;
      });
      const store: AgentActorStore = {
        async load() { return undefined; },
        async save(snapshot) {
          const completed = snapshot.turns.some((turn) => turn.state === 'completed');
          if (completed) {
            completionSaveAttempts += 1;
            if (completionSaveAttempts === 1) {
              throw new Error('first settlement save failed');
            }
            markRetrySaveStarted?.();
            await retrySaveGate;
            return;
          }
          if (snapshot.mailboxes['/root']?.some((message) => message.content === 'queue blocker')) {
            markQueuedMutationStarted?.();
            await queuedMutationGate;
          }
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        onBackgroundError: vi.fn(),
      });
      await controller.spawn('/root', {
        taskName: 'worker',
        objective: 'Retry after a queued mutation.',
      });

      executor.pending[0]?.resolve({ output: 'durable after retry' });
      await vi.advanceTimersByTimeAsync(0);
      const queuedMutation = controller.send('/root/worker', '/root', 'queue blocker');
      await queuedMutationStarted;
      await vi.advanceTimersByTimeAsync(6_000);

      expect(controller.healthSnapshot()).toMatchObject({ state: 'recovering' });
      releaseQueuedMutation?.();
      await queuedMutation;
      await retrySaveStarted;
      await vi.advanceTimersByTimeAsync(4_989);
      expect(controller.healthSnapshot()).toMatchObject({ state: 'recovering' });

      await vi.advanceTimersByTimeAsync(1);
      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
      });
      releaseRetrySave?.();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps settlement recovery progressing when the background error callback throws', async () => {
    vi.useFakeTimers();
    try {
      let completionSaveAttempts = 0;
      const warnings = vi.fn();
      const onBackgroundError = vi.fn(() => {
        throw new Error('diagnostic callback failed');
      });
      const store: AgentActorStore = {
        async load() { return undefined; },
        async save(snapshot) {
          const turn = snapshot.turns.find(
            (candidate) => candidate.actorPath === '/root/worker',
          );
          if (turn?.state === 'completed') {
            completionSaveAttempts += 1;
            throw new Error('disk remains unavailable');
          }
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        warn: warnings,
        onBackgroundError,
      });
      const turn = await controller.spawn('/root', {
        taskName: 'worker',
        objective: 'Reach an observable unknown state.',
      });

      executor.pending[0]?.resolve({ output: 'not durable' });
      await vi.advanceTimersByTimeAsync(6_000);

      expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
        state: 'running',
      });
      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
        turnId: turn.turnId,
      });
      expect(onBackgroundError).toHaveBeenCalled();
      expect(warnings).toHaveBeenCalledWith(
        expect.stringContaining('diagnostic callback failed'),
      );
      const attemptsAtDeadline = completionSaveAttempts;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(completionSaveAttempts).toBe(attemptsAtDeadline);
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains an asynchronously rejected background error callback', async () => {
    let completionSaveAttempts = 0;
    const warnings = vi.fn();
    const store: AgentActorStore = {
      async load() { return undefined; },
      async save(snapshot) {
        const turn = snapshot.turns.find(
          (candidate) => candidate.actorPath === '/root/worker',
        );
        if (turn?.state === 'completed') {
          completionSaveAttempts += 1;
          if (completionSaveAttempts === 1) {
            throw new Error('completion save failed');
          }
        }
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store,
      warn: warnings,
      onBackgroundError: async () => {
        throw new Error('async diagnostic callback failed');
      },
    });
    const turn = await controller.spawn('/root', {
      taskName: 'worker',
      objective: 'Complete despite diagnostic rejection.',
    });

    executor.pending[0]?.resolve({ output: 'durable' });
    await vi.waitFor(() => {
      expect(controller.output('/root', turn.actorPath, turn.turnId))
        .toMatchObject({ state: 'completed', output: 'durable' });
      expect(warnings).toHaveBeenCalledWith(
        expect.stringContaining('async diagnostic callback failed'),
      );
    });
  });

  it('falls back to a process warning when the warning callback rejects', async () => {
    let completionSaveAttempts = 0;
    const emittedWarning = vi.spyOn(process, 'emitWarning').mockImplementation(
      () => undefined,
    );
    try {
      const store: AgentActorStore = {
        async load() { return undefined; },
        async save(snapshot) {
          const turn = snapshot.turns.find(
            (candidate) => candidate.actorPath === '/root/worker',
          );
          if (turn?.state === 'completed') {
            completionSaveAttempts += 1;
            if (completionSaveAttempts === 1) {
              throw new Error('completion save failed');
            }
          }
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        warn: async () => {
          throw new Error('async warning callback failed');
        },
        onBackgroundError: () => {
          throw new Error('diagnostic callback failed');
        },
      });
      const turn = await controller.spawn('/root', {
        taskName: 'worker',
        objective: 'Complete despite warning rejection.',
      });

      executor.pending[0]?.resolve({ output: 'durable' });
      await vi.waitFor(() => {
        expect(controller.output('/root', turn.actorPath, turn.turnId))
          .toMatchObject({ state: 'completed', output: 'durable' });
        expect(emittedWarning).toHaveBeenCalledWith(
          expect.stringContaining('async warning callback failed'),
          { code: 'KODAX_ACTOR_BACKGROUND_ERROR_CALLBACK_FAILED' },
        );
      });
    } finally {
      emittedWarning.mockRestore();
    }
  });

  it('emits a coded warning when no background error callback is configured', async () => {
    let completionSaveAttempts = 0;
    const emittedWarning = vi.spyOn(process, 'emitWarning').mockImplementation(
      () => undefined,
    );
    try {
      const store: AgentActorStore = {
        async load() { return undefined; },
        async save(snapshot) {
          const turn = snapshot.turns.find(
            (candidate) => candidate.actorPath === '/root/worker',
          );
          if (turn?.state === 'completed') {
            completionSaveAttempts += 1;
            if (completionSaveAttempts === 1) {
              throw new Error('completion save failed');
            }
          }
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({ executor, store });
      const turn = await controller.spawn('/root', {
        taskName: 'worker',
        objective: 'Complete with default diagnostics.',
      });

      executor.pending[0]?.resolve({ output: 'durable' });
      await vi.waitFor(() => {
        expect(controller.output('/root', turn.actorPath, turn.turnId))
          .toMatchObject({ state: 'completed', output: 'durable' });
        expect(emittedWarning).toHaveBeenCalledWith(
          expect.stringContaining('completion save failed'),
          { code: 'KODAX_ACTOR_BACKGROUND_ERROR' },
        );
      });
    } finally {
      emittedWarning.mockRestore();
    }
  });

  it('times out a hung settlement save without accepting a late success', async () => {
    vi.useFakeTimers();
    try {
      let releaseLateSave: (() => void) | undefined;
      const lateSave = new Promise<void>((resolve) => {
        releaseLateSave = resolve;
      });
      const healthChanges = vi.fn();
      const onBackgroundError = vi.fn();
      const store: AgentActorStore = {
        eligibilityTimeoutMs: 65_000,
        async load() { return undefined; },
        async save() { throw new Error('legacy save must not be used'); },
        beginSave(snapshot) {
          const terminal = snapshot.turns.some((turn) => turn.state === 'completed');
          if (!terminal) {
            return {
              dequeued: Promise.resolve(),
              eligible: Promise.resolve(),
              canonical: Promise.resolve(),
              completion: Promise.resolve(),
              phase: () => 'committed',
              cancelBeforeCommit: () => false,
              diagnostics: () => ({ attemptId: 'immediate', phase: 'committed', timingsMs: {} }),
            };
          }
          let phase: AgentActorSavePhase = 'commit_inflight';
          const canonical = lateSave.then(() => { phase = 'committed'; });
          return {
            dequeued: Promise.resolve(),
            eligible: Promise.resolve(),
            canonical,
            completion: canonical,
            phase: () => phase,
            cancelBeforeCommit: () => false,
            diagnostics: () => ({
              attemptId: 'hung-rename',
              phase,
              timingsMs: { storageQueue: 2, fileLock: 3, rename: 5_000 },
            }),
          };
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        onBackgroundError,
        onHealthChanged: healthChanges,
      });
      const turn = await controller.spawn('/root', {
        taskName: 'worker',
        objective: 'Do not hang finalization.',
      });

      executor.pending[0]?.resolve({ output: 'late durable result' });
      await vi.advanceTimersByTimeAsync(6_000);

      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
        turnId: turn.turnId,
      });
      expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
        state: 'running',
      });
      expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({
        cause: expect.objectContaining({
          message: expect.stringContaining('hung-rename stopped in commit_inflight'),
        }),
      }));

      await expect(controller.shutdown()).rejects.toMatchObject({
        code: 'actor_shutdown_not_persisted',
      });
      releaseLateSave?.();
      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
      });
      expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
        state: 'running',
      });
      const unknownCall = healthChanges.mock.calls.findIndex(
        ([health]) => health.state === 'unknown',
      );
      expect(unknownCall).toBeGreaterThanOrEqual(0);
      expect(
        healthChanges.mock.calls
          .slice(unknownCall + 1)
          .some(([health]) => health.state === 'healthy'),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps unknown settlement health sticky across concurrent late settlements', async () => {
    vi.useFakeTimers();
    try {
      let releaseFirstSave: (() => void) | undefined;
      const firstSave = new Promise<void>((resolve) => {
        releaseFirstSave = resolve;
      });
      const healthChanges = vi.fn();
      const store: AgentActorStore = {
        async load() { return undefined; },
        async save(snapshot) {
          if (snapshot.turns.some((turn) => turn.state === 'completed')) {
            await firstSave;
          }
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        onBackgroundError: vi.fn(),
        onHealthChanged: healthChanges,
      });
      await controller.spawn('/root', {
        taskName: 'worker-a',
        objective: 'First concurrent settlement.',
      });
      await controller.spawn('/root', {
        taskName: 'worker-b',
        objective: 'Second concurrent settlement.',
      });

      executor.pending[0]?.resolve({ output: 'first' });
      executor.pending[1]?.resolve({ output: 'second' });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
      });
      const unknownCall = healthChanges.mock.calls.findIndex(
        ([health]) => health.state === 'unknown',
      );

      releaseFirstSave?.();
      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(controller.healthSnapshot().state).toBe('unknown');
      expect(
        healthChanges.mock.calls
          .slice(unknownCall + 1)
          .some(([health]) => health.state !== 'unknown'),
      ).toBe(false);
      await expect(controller.shutdown()).rejects.toMatchObject({
        code: 'actor_shutdown_not_persisted',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays every concurrent terminal fact captured before the durability fence', async () => {
    vi.useFakeTimers();
    let releaseFirstTerminalSave: (() => void) | undefined;
    try {
      let saved: AgentActorSnapshot | undefined;
      const firstTerminalSave = new Promise<void>((resolve) => {
        releaseFirstTerminalSave = resolve;
      });
      let terminalSaveStarted = false;
      const store: AgentActorStore = {
        async load() {
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot, expectedRevision) {
          const actualRevision = saved?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            throw Object.assign(new Error('synthetic Actor revision conflict'), {
              code: 'actor_snapshot_conflict' as const,
              expectedRevision,
              currentRevision: actualRevision,
            });
          }
          if (!terminalSaveStarted && snapshot.turns.some((turn) => turn.state === 'completed')) {
            terminalSaveStarted = true;
            await firstTerminalSave;
          }
          saved = structuredClone(snapshot);
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        owner: FIRST_OWNER,
        isOwnerAlive: async () => true,
        onBackgroundError: vi.fn(),
      });
      const first = await controller.spawn('/root', {
        taskName: 'concurrent-first',
        objective: 'Preserve first output.',
      });
      const second = await controller.spawn('/root', {
        taskName: 'concurrent-second',
        objective: 'Preserve second output.',
      });

      executor.pending[0]?.resolve({ output: 'first exact output' });
      executor.pending[1]?.resolve({ output: 'second exact output' });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(controller.healthSnapshot().state).toBe('unknown');

      releaseFirstTerminalSave?.();
      await vi.runAllTimersAsync();
      await controller.quiesce('repair concurrent terminal facts');

      expect(controller.output('/root', first.actorPath, first.turnId)).toMatchObject({
        state: 'completed',
        output: 'first exact output',
      });
      expect(controller.output('/root', second.actorPath, second.turnId)).toMatchObject({
        state: 'completed',
        output: 'second exact output',
      });
      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
    } finally {
      releaseFirstTerminalSave?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('reconciles a late same-owner settlement before an explicit quiesce', async () => {
    vi.useFakeTimers();
    try {
      let saved: AgentActorSnapshot | undefined;
      let releaseLateSave: (() => void) | undefined;
      const lateSave = new Promise<void>((resolve) => {
        releaseLateSave = resolve;
      });
      let terminalSaveStarted = false;
      const store: AgentActorStore = {
        async load() {
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot, expectedRevision) {
          const actualRevision = saved?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            throw Object.assign(new Error('synthetic Actor revision conflict'), {
              code: 'actor_snapshot_conflict' as const,
              expectedRevision,
              currentRevision: actualRevision,
            });
          }
          if (
            !terminalSaveStarted
            && snapshot.turns.some((turn) => (
              turn.actorPath === '/root/worker-a' && turn.state === 'completed'
            ))
          ) {
            terminalSaveStarted = true;
            await lateSave;
          }
          saved = structuredClone(snapshot);
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        owner: FIRST_OWNER,
        isOwnerAlive: async () => true,
        onBackgroundError: vi.fn(),
      });
      const first = await controller.spawn('/root', {
        taskName: 'worker-a',
        objective: 'Finish while persistence is slow.',
      });
      const second = await controller.spawn('/root', {
        taskName: 'worker-b',
        objective: 'Remain active until the Run is stopped.',
      });

      executor.pending[0]?.resolve({ output: 'durable after the deadline' });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
      });

      releaseLateSave?.();
      await vi.runAllTimersAsync();
      await controller.quiesce('operator stopped the owning Run');

      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      expect(controller.output('/root', first.actorPath, first.turnId)).toMatchObject({
        state: 'completed',
        output: 'durable after the deadline',
      });
      expect(controller.output('/root', second.actorPath, second.turnId)).toMatchObject({
        state: 'interrupted',
        error: 'operator stopped the owning Run',
      });
      expect(controller.list('/root').activeNonRootTurns).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles through long storage waits and ignores repair postcommit failure', async () => {
    vi.useFakeTimers();
    let releaseLateCommit: (() => void) | undefined;
    let releaseRepairDequeue: (() => void) | undefined;
    let releaseRepairEligibility: (() => void) | undefined;
    let releaseRepairMaintenance: (() => void) | undefined;
    const lateCommit = new Promise<void>((resolve) => { releaseLateCommit = resolve; });
    const repairDequeue = new Promise<void>((resolve) => { releaseRepairDequeue = resolve; });
    const repairEligibility = new Promise<void>((resolve) => {
      releaseRepairEligibility = resolve;
    });
    const repairMaintenance = new Promise<void>((resolve) => {
      releaseRepairMaintenance = resolve;
    });
    let markRepairStarted: (() => void) | undefined;
    const repairStarted = new Promise<void>((resolve) => { markRepairStarted = resolve; });
    let saved: AgentActorSnapshot | undefined;
    let terminalCommitStarted = false;
    const onBackgroundError = vi.fn();
    const persist = async (
      snapshot: AgentActorSnapshot,
      expectedRevision: number,
    ): Promise<void> => {
      const actualRevision = saved?.revision ?? 0;
      if (actualRevision !== expectedRevision) {
        throw Object.assign(new Error('synthetic Actor revision conflict'), {
          code: 'actor_snapshot_conflict' as const,
          expectedRevision,
          currentRevision: actualRevision,
        });
      }
      saved = structuredClone(snapshot);
    };
    const store: AgentActorStore = {
      eligibilityTimeoutMs: 65_000,
      async load() { return saved === undefined ? undefined : structuredClone(saved); },
      save: persist,
      beginSave(snapshot, expectedRevision) {
        const firstTerminal = !terminalCommitStarted && snapshot.turns.some((turn) => (
          turn.actorPath === '/root/worker-a' && turn.state === 'completed'
        ));
        if (firstTerminal) {
          terminalCommitStarted = true;
          let phase: AgentActorSavePhase = 'commit_inflight';
          const canonical = lateCommit.then(async () => {
            await persist(snapshot, expectedRevision);
            phase = 'committed';
          });
          return {
            dequeued: Promise.resolve(),
            eligible: Promise.resolve(),
            canonical,
            completion: canonical,
            phase: () => phase,
            cancelBeforeCommit: () => false,
            diagnostics: () => ({ attemptId: 'late-terminal', phase, timingsMs: {} }),
          };
        }
        const repair = snapshot.turns.some((turn) => turn.state === 'interrupted');
        if (repair) {
          markRepairStarted?.();
          let phase: AgentActorSavePhase = 'queued';
          const dequeued = repairDequeue;
          const eligible = dequeued.then(() => repairEligibility).then(() => {
            phase = 'precommit';
          });
          const canonical = eligible.then(async () => {
            await persist(snapshot, expectedRevision);
            phase = 'committed';
          });
          const completion = canonical.then(() => repairMaintenance).then(() => {
            throw new Error('repair postcommit witness failed');
          });
          return {
            dequeued,
            eligible,
            canonical,
            completion,
            phase: () => phase,
            cancelBeforeCommit: () => false,
            diagnostics: () => ({
              attemptId: 'repair-phased-save',
              phase,
              failedStage: phase === 'committed' ? 'postCommit' : undefined,
              timingsMs: {},
            }),
          };
        }
        let phase: AgentActorSavePhase = 'precommit';
        const canonical = persist(snapshot, expectedRevision).then(() => {
          phase = 'committed';
        });
        return {
          dequeued: Promise.resolve(),
          eligible: Promise.resolve(),
          canonical,
          completion: canonical,
          phase: () => phase,
          cancelBeforeCommit: () => false,
          diagnostics: () => ({ attemptId: 'ordinary', phase, timingsMs: {} }),
        };
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
      onBackgroundError,
    });

    try {
      const first = await controller.spawn('/root', {
        taskName: 'worker-a',
        objective: 'Commit after the first deadline.',
      });
      const second = await controller.spawn('/root', {
        taskName: 'worker-b',
        objective: 'Be interrupted by repair.',
      });
      executor.pending[0]?.resolve({ output: 'late canonical result' });
      await vi.advanceTimersByTimeAsync(5_001);
      expect(controller.healthSnapshot().state).toBe('unknown');

      releaseLateCommit?.();
      await vi.advanceTimersByTimeAsync(0);
      let repairSettled = false;
      const reconciliation = controller.quiesce('repair after ambiguity').then(() => {
        repairSettled = true;
      });
      await repairStarted;

      await vi.advanceTimersByTimeAsync(70_000);
      expect(repairSettled).toBe(false);
      expect(controller.healthSnapshot().state).toBe('unknown');
      releaseRepairDequeue?.();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(repairSettled).toBe(false);
      releaseRepairEligibility?.();
      await vi.advanceTimersByTimeAsync(0);
      await reconciliation;

      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      expect(controller.output('/root', first.actorPath, first.turnId)).toMatchObject({
        state: 'completed',
        output: 'late canonical result',
      });
      expect(controller.output('/root', second.actorPath, second.turnId)).toMatchObject({
        state: 'interrupted',
        error: 'repair after ambiguity',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      releaseRepairMaintenance?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('repair postcommit witness failed'),
      }));
    } finally {
      releaseLateCommit?.();
      releaseRepairDequeue?.();
      releaseRepairEligibility?.();
      releaseRepairMaintenance?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('cancels an ineligible repair before late admission and accepts a boundary commit', async () => {
    vi.useFakeTimers();
    let saved: AgentActorSnapshot | undefined;
    let releaseLateCommit: (() => void) | undefined;
    let releaseFirstRepairEligibility: (() => void) | undefined;
    const lateCommit = new Promise<void>((resolve) => { releaseLateCommit = resolve; });
    const firstRepairEligibility = new Promise<void>((resolve) => {
      releaseFirstRepairEligibility = resolve;
    });
    let terminalStarted = false;
    let repairCount = 0;
    const persist = (snapshot: AgentActorSnapshot, expectedRevision: number): void => {
      const currentRevision = saved?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        throw Object.assign(new Error('synthetic Actor revision conflict'), {
          code: 'actor_snapshot_conflict' as const,
          expectedRevision,
          currentRevision,
        });
      }
      saved = structuredClone(snapshot);
    };
    const store: AgentActorStore = {
      eligibilityTimeoutMs: 65_000,
      async load() { return saved === undefined ? undefined : structuredClone(saved); },
      async save() { throw new Error('legacy save must not be used'); },
      beginSave(snapshot, expectedRevision) {
        const terminal = snapshot.turns.some((turn) => turn.state === 'completed');
        const repair = snapshot.turns.some((turn) => turn.state === 'interrupted');
        if (!terminalStarted && terminal && !repair) {
          terminalStarted = true;
          let phase: AgentActorSavePhase = 'commit_inflight';
          const canonical = lateCommit.then(() => {
            persist(snapshot, expectedRevision);
            phase = 'committed';
          });
          return {
            dequeued: Promise.resolve(), eligible: Promise.resolve(), canonical,
            completion: canonical, phase: () => phase, cancelBeforeCommit: () => false,
            diagnostics: () => ({ attemptId: 'late-terminal', phase, timingsMs: {} }),
          };
        }
        if (repair) {
          repairCount += 1;
          if (repairCount === 1) {
            let phase: AgentActorSavePhase = 'queued';
            let cancelled = false;
            const eligible = firstRepairEligibility.then(() => {
              if (cancelled) throw new Error('repair cancelled before admission');
              phase = 'precommit';
            });
            const canonical = eligible.then(() => {
              persist(snapshot, expectedRevision);
              phase = 'committed';
            });
            return {
              dequeued: Promise.resolve(), eligible, canonical, completion: canonical,
              phase: () => phase,
              cancelBeforeCommit: () => {
                if (phase !== 'queued' && phase !== 'precommit') return false;
                cancelled = true;
                phase = 'not_committed';
                return true;
              },
              diagnostics: () => ({
                attemptId: 'repair-before-admission', phase, timingsMs: {},
              }),
            };
          }
          let phase: AgentActorSavePhase = 'commit_inflight';
          setTimeout(() => {
            persist(snapshot, expectedRevision);
            phase = 'committed';
          }, 5_000);
          const canonical = new Promise<void>(() => {});
          return {
            dequeued: Promise.resolve(), eligible: Promise.resolve(), canonical,
            completion: canonical, phase: () => phase, cancelBeforeCommit: () => false,
            diagnostics: () => ({
              attemptId: 'repair-deadline-edge', phase, timingsMs: {},
            }),
          };
        }
        persist(snapshot, expectedRevision);
        return {
          dequeued: Promise.resolve(), eligible: Promise.resolve(), canonical: Promise.resolve(),
          completion: Promise.resolve(), phase: () => 'committed',
          cancelBeforeCommit: () => false,
          diagnostics: () => ({ attemptId: 'ordinary', phase: 'committed', timingsMs: {} }),
        };
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
    });

    try {
      const target = await controller.spawn('/root', {
        taskName: 'repair-target', objective: 'Require a race-safe repair.',
      });
      await controller.spawn('/root', {
        taskName: 'repair-sibling', objective: 'Be interrupted by repair.',
      });
      executor.pending[0]?.resolve({ output: 'late target fact' });
      await vi.advanceTimersByTimeAsync(5_001);
      expect(controller.healthSnapshot().state).toBe('unknown');
      releaseLateCommit?.();
      await vi.advanceTimersByTimeAsync(0);

      const firstRepair = controller.quiesce('first repair attempt');
      void firstRepair.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(65_001);
      expect(saved?.turns.some((turn) => turn.state === 'interrupted')).toBe(false);
      releaseFirstRepairEligibility?.();
      await vi.advanceTimersByTimeAsync(0);
      await expect(firstRepair).rejects.toThrow('did not finish before its deadline');
      expect(saved?.turns.some((turn) => turn.state === 'interrupted')).toBe(false);

      const secondRepair = controller.quiesce('boundary repair commit');
      await vi.advanceTimersByTimeAsync(5_001);
      await secondRepair;
      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      expect(controller.output('/root', target.actorPath, target.turnId)).toMatchObject({
        state: 'completed', output: 'late target fact',
      });
      expect(saved?.turns.some((turn) => turn.state === 'interrupted')).toBe(true);
    } finally {
      releaseLateCommit?.();
      releaseFirstRepairEligibility?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('replays the exact settlement intent when the timed-out same-owner save did not commit', async () => {
    vi.useFakeTimers();
    try {
      let saved: AgentActorSnapshot | undefined;
      let releaseRejectedSave: (() => void) | undefined;
      const rejectedSave = new Promise<void>((resolve) => {
        releaseRejectedSave = resolve;
      });
      let rejectFirstTerminalSave = true;
      const store: AgentActorStore = {
        async load() {
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot, expectedRevision) {
          const actualRevision = saved?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            throw Object.assign(new Error('synthetic Actor revision conflict'), {
              code: 'actor_snapshot_conflict' as const,
              expectedRevision,
              currentRevision: actualRevision,
            });
          }
          if (
            rejectFirstTerminalSave
            && snapshot.turns.some((turn) => turn.state === 'completed')
          ) {
            rejectFirstTerminalSave = false;
            await rejectedSave;
            throw new Error('synthetic late terminal write rejection');
          }
          saved = structuredClone(snapshot);
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        owner: FIRST_OWNER,
        isOwnerAlive: async () => true,
        onBackgroundError: vi.fn(),
      });
      const turn = await controller.spawn('/root', {
        taskName: 'replayed-worker',
        objective: 'Preserve the exact completed result.',
      });

      executor.pending[0]?.resolve({ output: 'exact replayed result', artifacts: ['proof.txt'] });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(controller.healthSnapshot().state).toBe('unknown');

      releaseRejectedSave?.();
      await vi.runAllTimersAsync();
      await controller.quiesce('repair the owning Run');

      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
        state: 'completed',
        output: 'exact replayed result',
        artifacts: ['proof.txt'],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges the exact settlement fact onto a newer same-owner revision', async () => {
    vi.useFakeTimers();
    try {
      let saved: AgentActorSnapshot | undefined;
      let releaseRejectedSave: (() => void) | undefined;
      const rejectedSave = new Promise<void>((resolve) => {
        releaseRejectedSave = resolve;
      });
      let rejectTerminalSave = true;
      const store: AgentActorStore = {
        async load() {
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot, expectedRevision) {
          const actualRevision = saved?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            throw Object.assign(new Error('synthetic Actor revision conflict'), {
              code: 'actor_snapshot_conflict' as const,
              expectedRevision,
              currentRevision: actualRevision,
            });
          }
          if (rejectTerminalSave && snapshot.turns.some((turn) => turn.state === 'completed')) {
            rejectTerminalSave = false;
            await rejectedSave;
            throw new Error('synthetic terminal write rejection');
          }
          saved = structuredClone(snapshot);
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        owner: FIRST_OWNER,
        isOwnerAlive: async () => true,
        onBackgroundError: vi.fn(),
      });
      const turn = await controller.spawn('/root', {
        taskName: 'conflicted-worker',
        objective: 'Do not accept an unrelated revision.',
      });
      executor.pending[0]?.resolve({ output: 'must remain exact' });
      await vi.advanceTimersByTimeAsync(6_000);
      releaseRejectedSave?.();
      await vi.runAllTimersAsync();

      expect(saved).toBeDefined();
      saved = { ...saved!, revision: saved!.revision + 1 };
      await controller.quiesce('attempt repair');
      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
        state: 'completed',
        output: 'must remain exact',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the public Actor fence until repaired siblings are durably quiesced', async () => {
    vi.useFakeTimers();
    try {
      let saved: AgentActorSnapshot | undefined;
      let releaseLateSave: (() => void) | undefined;
      const lateSave = new Promise<void>((resolve) => {
        releaseLateSave = resolve;
      });
      let releaseQuiesceSave: (() => void) | undefined;
      const quiesceSave = new Promise<void>((resolve) => {
        releaseQuiesceSave = resolve;
      });
      let terminalSaveStarted = false;
      let quiesceSaveStarted = false;
      const store: AgentActorStore = {
        async load() {
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot, expectedRevision) {
          const actualRevision = saved?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            throw Object.assign(new Error('synthetic Actor revision conflict'), {
              code: 'actor_snapshot_conflict' as const,
              expectedRevision,
              currentRevision: actualRevision,
            });
          }
          if (!terminalSaveStarted && snapshot.turns.some((turn) => turn.state === 'completed')) {
            terminalSaveStarted = true;
            await lateSave;
          } else if (
            snapshot.turns.some((turn) => turn.state === 'interrupted')
            && !quiesceSaveStarted
          ) {
            quiesceSaveStarted = true;
            await quiesceSave;
          }
          saved = structuredClone(snapshot);
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        owner: FIRST_OWNER,
        isOwnerAlive: async () => true,
        onBackgroundError: vi.fn(),
      });
      await controller.spawn('/root', { taskName: 'done', objective: 'Finish late.' });
      await controller.spawn('/root', { taskName: 'sibling', objective: 'Remain active.' });
      executor.pending[0]?.resolve({ output: 'durable completion' });
      await vi.advanceTimersByTimeAsync(6_000);
      releaseLateSave?.();
      await vi.runAllTimersAsync();

      const repairing = controller.quiesce('durability repair');
      await vi.waitFor(() => expect(quiesceSaveStarted).toBe(true));
      const concurrentSpawn = controller.spawn('/root', {
        taskName: 'must-not-start',
        objective: 'Stay fenced until repair commits.',
      });
      await expect(concurrentSpawn).rejects.toMatchObject({
        code: 'actor_settlement_not_persisted',
      });

      releaseQuiesceSave?.();
      await repairing;
      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries reconciliation after a transient durable load failure', async () => {
    vi.useFakeTimers();
    try {
      let saved: AgentActorSnapshot | undefined;
      let releaseRejectedSave: (() => void) | undefined;
      const rejectedSave = new Promise<void>((resolve) => {
        releaseRejectedSave = resolve;
      });
      let rejectTerminalSave = true;
      let rejectNextLoad = false;
      const store: AgentActorStore = {
        async load() {
          if (rejectNextLoad) {
            rejectNextLoad = false;
            throw new Error('synthetic transient load failure');
          }
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot, expectedRevision) {
          const actualRevision = saved?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            throw Object.assign(new Error('synthetic Actor revision conflict'), {
              code: 'actor_snapshot_conflict' as const,
              expectedRevision,
              currentRevision: actualRevision,
            });
          }
          if (rejectTerminalSave && snapshot.turns.some((turn) => turn.state === 'completed')) {
            rejectTerminalSave = false;
            await rejectedSave;
            throw new Error('synthetic late terminal rejection');
          }
          saved = structuredClone(snapshot);
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        owner: FIRST_OWNER,
        isOwnerAlive: async () => true,
        onBackgroundError: vi.fn(),
      });
      const target = await controller.spawn('/root', {
        taskName: 'load-retry',
        objective: 'Survive a transient repair read failure.',
      });
      executor.pending[0]?.resolve({ output: 'preserved across retry' });
      await vi.advanceTimersByTimeAsync(6_000);
      releaseRejectedSave?.();
      await vi.runAllTimersAsync();

      rejectNextLoad = true;
      await expect(controller.quiesce('first repair')).rejects.toThrow(
        'synthetic transient load failure',
      );
      await Promise.resolve();
      await expect(controller.quiesce('second repair')).resolves.toBeUndefined();

      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      expect(controller.output('/root', target.actorPath, target.turnId)).toMatchObject({
        state: 'completed',
        output: 'preserved across retry',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays a timed-out cancellation intent after its first save does not commit', async () => {
    vi.useFakeTimers();
    let releaseRejectedCancellation: (() => void) | undefined;
    try {
      let saved: AgentActorSnapshot | undefined;
      const rejectedCancellation = new Promise<void>((resolve) => {
        releaseRejectedCancellation = resolve;
      });
      let rejectCancellationSave = true;
      const store: AgentActorStore = {
        async load() {
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot, expectedRevision) {
          const actualRevision = saved?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            throw Object.assign(new Error('synthetic Actor revision conflict'), {
              code: 'actor_snapshot_conflict' as const,
              expectedRevision,
              currentRevision: actualRevision,
            });
          }
          if (rejectCancellationSave && snapshot.turns.some((turn) => (
            turn.state === 'interrupted'
          ))) {
            rejectCancellationSave = false;
            await rejectedCancellation;
            throw new Error('synthetic late cancellation rejection');
          }
          saved = structuredClone(snapshot);
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        owner: FIRST_OWNER,
        isOwnerAlive: async () => true,
        onBackgroundError: vi.fn(),
      });
      const child = await controller.spawn('/root', {
        taskName: 'cancel-repair',
        objective: 'Persist cancellation after a hung save.',
      });

      const firstCancellation = expect(
        controller.quiesce('operator stopped the Run'),
      ).rejects.toMatchObject({
        code: 'actor_settlement_not_persisted',
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await firstCancellation;
      expect(controller.healthSnapshot().state).toBe('unknown');

      releaseRejectedCancellation?.();
      await vi.runAllTimersAsync();
      await controller.quiesce('automatic durability repair');

      expect(controller.output('/root', child.actorPath, child.turnId)).toMatchObject({
        state: 'interrupted',
        error: 'operator stopped the Run',
      });
      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
    } finally {
      releaseRejectedCancellation?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('preserves the exact settlement intent when the first sibling repair save fails', async () => {
    vi.useFakeTimers();
    try {
      let saved: AgentActorSnapshot | undefined;
      let releaseRejectedSave: (() => void) | undefined;
      const rejectedSave = new Promise<void>((resolve) => {
        releaseRejectedSave = resolve;
      });
      let rejectTerminalSave = true;
      let rejectSiblingRepairSave = true;
      const store: AgentActorStore = {
        async load() {
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot, expectedRevision) {
          const actualRevision = saved?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            throw Object.assign(new Error('synthetic Actor revision conflict'), {
              code: 'actor_snapshot_conflict' as const,
              expectedRevision,
              currentRevision: actualRevision,
            });
          }
          const hasCompleted = snapshot.turns.some((turn) => turn.state === 'completed');
          const hasInterrupted = snapshot.turns.some((turn) => turn.state === 'interrupted');
          if (rejectTerminalSave && hasCompleted && !hasInterrupted) {
            rejectTerminalSave = false;
            await rejectedSave;
            throw new Error('synthetic late terminal rejection');
          }
          if (rejectSiblingRepairSave && hasCompleted && hasInterrupted) {
            rejectSiblingRepairSave = false;
            throw new Error('synthetic sibling repair rejection');
          }
          saved = structuredClone(snapshot);
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        owner: FIRST_OWNER,
        isOwnerAlive: async () => true,
        onBackgroundError: vi.fn(),
      });
      const target = await controller.spawn('/root', {
        taskName: 'repair-target',
        objective: 'Keep the exact terminal intent.',
      });
      const sibling = await controller.spawn('/root', {
        taskName: 'repair-sibling',
        objective: 'Be interrupted by repair.',
      });
      executor.pending[0]?.resolve({ output: 'exact after sibling retry' });
      await vi.advanceTimersByTimeAsync(6_000);
      releaseRejectedSave?.();
      await vi.runAllTimersAsync();

      await expect(controller.quiesce('first repair')).rejects.toThrow(
        'synthetic sibling repair rejection',
      );
      expect(controller.healthSnapshot().state).toBe('unknown');
      await Promise.resolve();
      await expect(controller.quiesce('second repair')).resolves.toBeUndefined();

      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      expect(controller.output('/root', target.actorPath, target.turnId)).toMatchObject({
        state: 'completed',
        output: 'exact after sibling retry',
      });
      expect(controller.output('/root', sibling.actorPath, sibling.turnId)).toMatchObject({
        state: 'interrupted',
        error: 'second repair',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restore a preserved turn whose executor was aborted by the durability fence', async () => {
    vi.useFakeTimers();
    try {
      let saved: AgentActorSnapshot | undefined;
      let releaseRejectedSave: (() => void) | undefined;
      const rejectedSave = new Promise<void>((resolve) => {
        releaseRejectedSave = resolve;
      });
      let rejectTerminalSave = true;
      const store: AgentActorStore = {
        async load() {
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot, expectedRevision) {
          const actualRevision = saved?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            throw Object.assign(new Error('synthetic Actor revision conflict'), {
              code: 'actor_snapshot_conflict' as const,
              expectedRevision,
              currentRevision: actualRevision,
            });
          }
          if (rejectTerminalSave && snapshot.turns.some((turn) => turn.state === 'completed')) {
            rejectTerminalSave = false;
            await rejectedSave;
            throw new Error('synthetic late terminal rejection');
          }
          saved = structuredClone(snapshot);
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        owner: FIRST_OWNER,
        isOwnerAlive: async () => true,
        onBackgroundError: vi.fn(),
      });
      const preserved = await controller.spawn('/root', {
        taskName: 'preexisting',
        objective: 'Exist before the owning Run baseline.',
      });
      const target = await controller.spawn('/root', {
        taskName: 'target-after-baseline',
        objective: 'Trigger the durability fence.',
      });
      executor.pending[1]?.resolve({ output: 'target completed' });
      await vi.advanceTimersByTimeAsync(6_000);
      releaseRejectedSave?.();
      await vi.runAllTimersAsync();

      await controller.quiesce(
        'repair cannot revive an aborted executor',
        new Set([preserved.turnId]),
      );

      expect(controller.output('/root', target.actorPath, target.turnId)).toMatchObject({
        state: 'completed',
        output: 'target completed',
      });
      expect(controller.output('/root', preserved.actorPath, preserved.turnId)).toMatchObject({
        state: 'interrupted',
        error: 'repair cannot revive an aborted executor',
      });
      expect(controller.list('/root').activeNonRootTurns).toBe(0);
      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries reconciliation after repair committed but durable verification failed', async () => {
    vi.useFakeTimers();
    try {
      let saved: AgentActorSnapshot | undefined;
      let releaseRejectedSave: (() => void) | undefined;
      const rejectedSave = new Promise<void>((resolve) => {
        releaseRejectedSave = resolve;
      });
      let rejectTerminalSave = true;
      let rejectVerificationLoad = false;
      const store: AgentActorStore = {
        async load() {
          if (rejectVerificationLoad) {
            rejectVerificationLoad = false;
            throw new Error('synthetic verification load failure');
          }
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot, expectedRevision) {
          const actualRevision = saved?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            throw Object.assign(new Error('synthetic Actor revision conflict'), {
              code: 'actor_snapshot_conflict' as const,
              expectedRevision,
              currentRevision: actualRevision,
            });
          }
          if (rejectTerminalSave && snapshot.turns.some((turn) => turn.state === 'completed')) {
            rejectTerminalSave = false;
            await rejectedSave;
            throw new Error('synthetic late terminal rejection');
          }
          saved = structuredClone(snapshot);
          if (snapshot.turns.some((turn) => turn.state === 'completed')) {
            rejectVerificationLoad = true;
          }
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        owner: FIRST_OWNER,
        isOwnerAlive: async () => true,
        onBackgroundError: vi.fn(),
      });
      const target = await controller.spawn('/root', {
        taskName: 'verify-retry',
        objective: 'Survive a failed post-commit verification read.',
      });
      executor.pending[0]?.resolve({ output: 'durable before verification' });
      await vi.advanceTimersByTimeAsync(6_000);
      releaseRejectedSave?.();
      await vi.runAllTimersAsync();

      await expect(controller.quiesce('first repair')).rejects.toThrow(
        'synthetic verification load failure',
      );
      expect(controller.healthSnapshot().state).toBe('unknown');
      await Promise.resolve();
      await expect(controller.quiesce('second repair')).resolves.toBeUndefined();

      expect(controller.healthSnapshot()).toEqual({ state: 'healthy' });
      expect(controller.output('/root', target.actorPath, target.turnId)).toMatchObject({
        state: 'completed',
        output: 'durable before verification',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a conflicting same-owner terminal fact fenced', async () => {
    vi.useFakeTimers();
    try {
      let saved: AgentActorSnapshot | undefined;
      let releaseRejectedSave: (() => void) | undefined;
      const rejectedSave = new Promise<void>((resolve) => {
        releaseRejectedSave = resolve;
      });
      let rejectTerminalSave = true;
      const store: AgentActorStore = {
        async load() {
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot, expectedRevision) {
          const actualRevision = saved?.revision ?? 0;
          if (actualRevision !== expectedRevision) {
            throw Object.assign(new Error('synthetic Actor revision conflict'), {
              code: 'actor_snapshot_conflict' as const,
              expectedRevision,
              currentRevision: actualRevision,
            });
          }
          if (rejectTerminalSave && snapshot.turns.some((turn) => turn.state === 'completed')) {
            rejectTerminalSave = false;
            await rejectedSave;
            throw new Error('synthetic late terminal rejection');
          }
          saved = structuredClone(snapshot);
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        owner: FIRST_OWNER,
        isOwnerAlive: async () => true,
        onBackgroundError: vi.fn(),
      });
      const target = await controller.spawn('/root', {
        taskName: 'conflicting-target',
        objective: 'Reject a conflicting durable terminal fact.',
      });
      executor.pending[0]?.resolve({ output: 'intended completion' });
      await vi.advanceTimersByTimeAsync(6_000);
      releaseRejectedSave?.();
      await vi.runAllTimersAsync();

      expect(saved).toBeDefined();
      saved = structuredClone(saved!);
      const durableTarget = saved.turns.find((turn) => turn.turnId === target.turnId)!;
      durableTarget.state = 'failed';
      durableTarget.error = 'conflicting durable failure';
      saved.revision += 1;

      await expect(controller.quiesce('must stay fenced')).rejects.toMatchObject({
        code: 'actor_settlement_not_persisted',
      });
      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reconcile an ownerless late settlement as same-owner state', async () => {
    vi.useFakeTimers();
    try {
      let saved: AgentActorSnapshot | undefined;
      let releaseLateSave: (() => void) | undefined;
      const lateSave = new Promise<void>((resolve) => {
        releaseLateSave = resolve;
      });
      let terminalSaveStarted = false;
      const store: AgentActorStore = {
        async load() {
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot) {
          if (
            !terminalSaveStarted
            && snapshot.turns.some((turn) => turn.state === 'completed')
          ) {
            terminalSaveStarted = true;
            await lateSave;
          }
          saved = structuredClone(snapshot);
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        onBackgroundError: vi.fn(),
      });
      await controller.spawn('/root', {
        taskName: 'ownerless-worker',
        objective: 'Finish after the settlement deadline.',
      });

      executor.pending[0]?.resolve({ output: 'late ownerless result' });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(controller.healthSnapshot().state).toBe('unknown');
      releaseLateSave?.();
      await vi.runAllTimersAsync();

      await expect(controller.quiesce('operator requested Stop')).rejects.toMatchObject({
        code: 'actor_owner_conflict',
      });
      expect(controller.healthSnapshot().state).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not publish recovering health for executor settlement after shutdown', async () => {
    const executor = new DeferredExecutor();
    const healthChanges = vi.fn();
    const controller = await createAgentActorController({
      executor,
      store: {
        async load() { return undefined; },
        async save() {},
      },
      owner: FIRST_OWNER,
      isOwnerAlive: async () => false,
      onHealthChanged: healthChanges,
    });
    await controller.spawn('/root', {
      taskName: 'late-worker',
      objective: 'Settle after shutdown.',
    });

    await controller.shutdown();
    executor.pending[0]?.resolve({ output: 'too late' });
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.healthSnapshot().state).toBe('healthy');
    expect(healthChanges).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'recovering' }),
    );
  });

  it('reports unknown when an owner conflict interrupts executor settlement', async () => {
    const state = revisionedActorStore();
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store: state.store,
      owner: FIRST_OWNER,
      isOwnerAlive: async () => true,
      onBackgroundError: vi.fn(),
    });
    const turn = await controller.spawn('/root', {
      taskName: 'superseded-worker',
      objective: 'Lose the durable owner before completion.',
    });
    const current = state.read();
    if (current?.schemaVersion !== 2) {
      throw new Error('Expected an owned Actor snapshot.');
    }
    state.replace({
      ...current,
      revision: current.revision + 1,
      owner: SECOND_OWNER,
    });

    executor.pending[0]?.resolve({ output: 'not ours to commit' });
    await vi.waitFor(() => {
      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
        turnId: turn.turnId,
      });
    });
    await expect(controller.shutdown()).rejects.toMatchObject({
      code: 'actor_shutdown_not_persisted',
    });
  });

  it('flushes a known executor settlement before shutdown releases its owner', async () => {
    let saved: AgentActorSnapshot | undefined;
    let completionAttempts = 0;
    let releaseRetry: (() => void) | undefined;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const store: AgentActorStore = {
      async load() { return saved; },
      async save(snapshot) {
        const turn = snapshot.turns.find((candidate) => candidate.actorPath === '/root/worker');
        if (turn?.state === 'completed') {
          completionAttempts += 1;
          if (completionAttempts === 1) throw new Error('completion save failed');
          await retryGate;
        }
        saved = structuredClone(snapshot);
      },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store,
      owner: FIRST_OWNER,
    });
    const turn = await controller.spawn('/root', {
      taskName: 'worker',
      objective: 'Complete before shutdown.',
    });

    executor.pending[0]?.resolve({ output: 'durable result' });
    await vi.waitFor(() => {
      expect(completionAttempts).toBe(2);
    });
    let shutdownSettled = false;
    const shutdown = controller.shutdown().finally(() => {
      shutdownSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(shutdownSettled).toBe(false);

    releaseRetry?.();
    await shutdown;

    expect(saved?.owner).toBeUndefined();
    expect(saved?.turns.find((candidate) => candidate.turnId === turn.turnId)).toMatchObject({
      state: 'completed',
      output: 'durable result',
    });
  });

  it('fences a settlement that was already hung when shutdown began', async () => {
    vi.useFakeTimers();
    try {
      let releaseSettlement: (() => void) | undefined;
      const settlementGate = new Promise<void>((resolve) => {
        releaseSettlement = resolve;
      });
      let markSettlementSaveStarted: (() => void) | undefined;
      const settlementSaveStarted = new Promise<void>((resolve) => {
        markSettlementSaveStarted = resolve;
      });
      const store: AgentActorStore = {
        async load() { return undefined; },
        async save(snapshot) {
          if (snapshot.turns.some((turn) => turn.state === 'completed')) {
            markSettlementSaveStarted?.();
            await settlementGate;
          }
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({
        executor,
        store,
        onBackgroundError: vi.fn(),
      });
      await controller.spawn('/root', {
        taskName: 'worker',
        objective: 'Hang before shutdown starts.',
      });
      executor.pending[0]?.resolve({ output: 'late result' });
      await settlementSaveStarted;

      const shutdown = controller.shutdown();
      const rejected = expect(shutdown).rejects.toMatchObject({
        code: 'actor_shutdown_not_persisted',
      });
      await vi.advanceTimersByTimeAsync(2_001);
      await rejected;
      expect(controller.healthSnapshot()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
      });

      releaseSettlement?.();
      await vi.runAllTimersAsync();
      await expect(controller.shutdown()).rejects.toMatchObject({
        code: 'actor_shutdown_not_persisted',
      });
      expect(controller.healthSnapshot().state).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts local work immediately and reports an indeterminate hung shutdown save', async () => {
    vi.useFakeTimers();
    try {
      let releaseShutdownSave: (() => void) | undefined;
      const shutdownSave = new Promise<void>((resolve) => {
        releaseShutdownSave = resolve;
      });
      const store: AgentActorStore = {
        async load() { return undefined; },
        async save(snapshot) {
          if (snapshot.turns.some((turn) => turn.state === 'interrupted')) {
            await shutdownSave;
          }
        },
      };
      const executor = new DeferredExecutor();
      const controller = await createAgentActorController({ executor, store });
      const turn = await controller.spawn('/root', {
        taskName: 'worker',
        objective: 'Abort locally before durable shutdown blocks.',
      });
      const cursor = controller.eventSnapshot('/root').at(-1)?.sequence ?? 0;
      const waiting = controller.wait('/root', cursor, 30_000);

      const shutdown = controller.shutdown();
      const rejected = expect(shutdown).rejects.toMatchObject({
        code: 'actor_shutdown_not_persisted',
      });
      expect(executor.pending[0]?.input.signal.aborted).toBe(true);
      await expect(waiting).resolves.toBeUndefined();
      await expect(controller.followup('/root', turn.actorPath, 'too late'))
        .rejects.toMatchObject({ code: 'actor_closed' });

      await vi.advanceTimersByTimeAsync(2_001);
      await rejected;
      expect(controller.healthSnapshot().state).toBe('unknown');
      expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({
        state: 'running',
      });

      releaseShutdownSave?.();
      await vi.runAllTimersAsync();
      await expect(controller.shutdown()).rejects.toMatchObject({
        code: 'actor_shutdown_not_persisted',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never exposes a terminal turn before its durable commit succeeds', async () => {
    let rejectCompletion: ((error: Error) => void) | undefined;
    let saveCount = 0;
    const store: AgentActorStore = {
      async load() { return undefined; },
      save() {
        saveCount += 1;
        if (saveCount === 1) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => { rejectCompletion = reject; });
      },
    };
    const executor = new DeferredExecutor();
    const onBackgroundError = vi.fn();
    const controller = await createAgentActorController({ executor, store, onBackgroundError });
    const turn = await controller.spawn('/root', { taskName: 'worker', objective: 'Work.' });

    executor.pending[0]?.resolve({ output: 'uncommitted result' });
    await settle();

    expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({ state: 'running' });
    expect(controller.eventSnapshot('/root').some((event) => event.kind === 'turn_completed')).toBe(false);

    rejectCompletion?.(new Error('completion save failed'));
    await settle();
    await settle();

    expect(controller.output('/root', turn.actorPath, turn.turnId)).toMatchObject({ state: 'running' });
    expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'completion save failed',
    }));
  });

  it('publishes terminal events only after durable commit and isolates callback failures', async () => {
    const order: string[] = [];
    const onBackgroundError = vi.fn();
    const store: AgentActorStore = {
      async load() { return undefined; },
      async save() { order.push('saved'); },
    };
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      store,
      onBackgroundError,
      onEventCommitted(event) {
        if (event.kind !== 'turn_completed') return;
        order.push('published');
        throw new Error('observer failed');
      },
    });
    await controller.spawn('/root', { taskName: 'worker', objective: 'Work.' });
    order.length = 0;

    executor.pending[0]?.resolve({ output: 'done' });
    await settle();
    await settle();

    expect(order).toEqual(['saved', 'published']);
    expect(controller.output('/root', '/root/worker')).toMatchObject({
      state: 'completed', output: 'done',
    });
    expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'observer failed',
    }));
  });

  it('cancels an actor event waiter promptly when its owning round is interrupted', async () => {
    const controller = await createAgentActorController();
    const root = controller.bind('/root');
    const cursor = root.eventSnapshot().at(-1)?.sequence ?? 0;
    const abort = new AbortController();

    const waiting = root.wait(cursor, 30_000, abort.signal);
    abort.abort('user input');

    await expect(waiting).resolves.toBeUndefined();
  });

  it('returns an already committed visible event without installing a waiter', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    const root = controller.bind('/root');
    await controller.spawn('/root', { taskName: 'worker', objective: 'Work.' });
    const existing = root.eventSnapshot()[0];

    expect(existing).toBeDefined();
    await expect(root.wait(0, 30_000)).resolves.toEqual(existing);
  });
});
