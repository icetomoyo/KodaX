import {
  _resetMessageQueueForTests,
  createAgentActorController,
  getMessageQueue,
  type AgentActorClient,
  type AgentActorController,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentTurnExecutor,
} from '@kodax-ai/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';

import type { KodaXToolExecutionContext } from '../types.js';
import { actorQueueId } from '../agent-runtime/actor-queue.js';
import {
  _resetAgentResolverForTesting,
  registerConstructedAgent,
} from '../construction/agent-resolver.js';
import { executeTool, getToolDefinition } from './registry.js';
import { commitActorNotificationReceipts } from './agent-collaboration.js';

function committedToolResultMessage(content: string): KodaXMessage {
  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'test-call',
      content,
    }],
  };
}

interface PendingExecution {
  readonly input: AgentExecutionInput;
  readonly resolve: (result: AgentExecutionResult) => void;
}

class DeferredExecutor implements AgentTurnExecutor {
  readonly pending: PendingExecution[] = [];

  execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    return new Promise((resolve) => this.pending.push({ input, resolve }));
  }
}

class ProgressingDeferredExecutor extends DeferredExecutor {
  override async execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    await input.reportProgress({
      kind: 'status',
      summary: `Started ${input.actor.taskName}`,
    });
    return super.execute(input);
  }
}

async function context(
  executor = new DeferredExecutor(),
  sessionId?: string,
): Promise<{
  readonly ctx: KodaXToolExecutionContext;
  readonly executor: DeferredExecutor;
  readonly controller: AgentActorController;
}> {
  const controller = await createAgentActorController({ executor });
  return {
    ctx: {
      backups: new Map(),
      actorControl: controller.bind('/root'),
      actorTurnRef: { actorPath: '/root', turnId: 'root-turn-1' },
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
    executor,
    controller,
  };
}

describe('F270 canonical collaboration tools', () => {
  afterEach(() => {
    vi.useRealTimers();
    _resetMessageQueueForTests();
    _resetAgentResolverForTesting();
  });

  it('offers only the canonical model-visible names', () => {
    for (const name of [
      'spawn_agent', 'send_message', 'followup_task', 'wait_agent',
      'interrupt_agent', 'list_agents', 'agent_output',
    ]) {
      expect(getToolDefinition(name), name).toBeDefined();
    }
    for (const retired of ['dispatch_child_task', 'task_stop', 'task_output']) {
      expect(getToolDefinition(retired), retired).toBeUndefined();
    }
  });

  it('spawns a named actor with structured metadata and lists the canonical path', async () => {
    const { ctx, executor } = await context();

    const spawned = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'reviewer',
      objective: 'Review the actor boundary.',
      read_only: true,
      scope: 'packages/agent',
      evidence_refs: ['file:packages/agent/src/index.ts'],
      fork_turns: 'none',
    }, ctx)) as Record<string, unknown>;
    await executor.pending[0]?.input.reportProgress({ kind: 'tool', summary: 'Reading actor types' });
    const listed = JSON.parse(await executeTool('list_agents', {}, ctx)) as {
      readonly actors: readonly {
        readonly path: string;
        readonly latestTurn?: { readonly recentActivity: readonly { readonly summary: string }[] };
      }[];
    };

    expect(spawned).toMatchObject({ ok: true, actorPath: '/root/reviewer' });
    expect(listed.actors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '/root/reviewer',
        latestTurn: expect.objectContaining({
          recentActivity: [expect.objectContaining({ summary: 'Reading actor types' })],
        }),
      }),
    ]));
    expect(executor.pending[0]?.input.turn.metadata).toMatchObject({
      readOnly: true,
      scope: 'packages/agent',
      evidenceRefs: ['file:packages/agent/src/index.ts'],
    });
  });

  it('stamps valid quality_strategy telemetry and ignores invalid optional metadata', async () => {
    const { ctx, executor } = await context();
    const qualityStrategy = {
      schemaVersion: 1,
      stageId: 'review-auth',
      pattern: 'fan-out-and-synthesize',
      role: 'investigator',
      laneRelation: 'coverage',
      targetEvidenceRefs: ['file:packages/agent/src/actors/controller.ts'],
    };

    const spawned = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'strategy-reviewer',
      objective: 'Review the actor boundary.',
      quality_strategy: qualityStrategy,
    }, ctx)) as Record<string, unknown>;

    expect(spawned).toMatchObject({ ok: true });
    expect(executor.pending[0]?.input.turn.metadata?.qualityStrategy).toEqual({
      ...qualityStrategy,
      ownerTurnRef: { actorPath: '/root', turnId: 'root-turn-1' },
    });

    const invalid = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'invalid-strategy',
      objective: 'Try an invented pattern.',
      quality_strategy: { ...qualityStrategy, pattern: 'majority-vote' },
    }, ctx)) as Record<string, unknown>;
    expect(invalid).toMatchObject({ ok: true, actorPath: '/root/invalid-strategy' });
    expect(executor.pending[1]?.input.turn.metadata?.qualityStrategy).toBeUndefined();
  });

  it('does not misclassify host policy failures as optional metadata errors', async () => {
    const { ctx } = await context();
    const policyCtx: KodaXToolExecutionContext = {
      ...ctx,
      assertReadablePath: () => {
        throw new Error('host policy denied evidence access');
      },
    };

    const result = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'policy-denied',
      objective: 'Must not start.',
      quality_strategy: {
        schemaVersion: 1,
        stageId: 'policy-check',
        pattern: 'adversarial-verification',
        role: 'challenger',
        laneRelation: 'opposition',
        targetEvidenceRefs: ['file:packages/coding/src/index.ts'],
      },
    }, policyCtx)) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: false,
      error: { message: 'host policy denied evidence access' },
    });
    expect(ctx.actorControl?.list().actors.some((actor) => (
      actor.path === '/root/policy-denied'
    ))).toBe(false);
  });

  it('admits a full parallel strategy wave while children report startup progress', async () => {
    const { ctx } = await context(new ProgressingDeferredExecutor());
    const names = ['review-agent', 'review-core', 'review-commits'];

    const results = await Promise.all(names.map(async (taskName) => JSON.parse(await executeTool(
      'spawn_agent',
      {
        task_name: taskName,
        objective: `Review ${taskName}.`,
        quality_strategy: {
          schemaVersion: 1,
          stageId: `stage-${taskName}`,
          pattern: 'fan-out-and-synthesize',
          role: 'investigator',
          laneRelation: 'coverage',
        },
      },
      ctx,
    )) as Record<string, unknown>));

    expect(results).toEqual(names.map(() => expect.objectContaining({ ok: true })));
    expect(ctx.actorControl?.list().activeNonRootTurns).toBe(3);
  });

  it('coordinates parallel strategy admissions across separate clients for one Actor tree', async () => {
    const executor = new ProgressingDeferredExecutor();
    const { ctx, controller } = await context(executor);
    const names = ['bound-review-agent', 'bound-review-core', 'bound-review-commits'];
    const contexts = names.map(() => ({
      ...ctx,
      actorControl: controller.bind('/root'),
    }));

    const results = await Promise.all(names.map(async (taskName, index) => JSON.parse(
      await executeTool('spawn_agent', {
        task_name: taskName,
        objective: `Review ${taskName}.`,
        quality_strategy: {
          schemaVersion: 1,
          stageId: `stage-${taskName}`,
          pattern: 'fan-out-and-synthesize',
          role: 'investigator',
          laneRelation: 'coverage',
        },
      }, contexts[index]),
    ) as Record<string, unknown>));

    expect(results).toEqual(names.map(() => expect.objectContaining({ ok: true })));
    expect(controller.list('/root').activeNonRootTurns).toBe(3);
  });

  it('does not make ordinary spawn admission depend on strategy metadata fences', async () => {
    const { ctx, executor } = await context();
    const current = ctx.actorControl;
    if (!current) throw new Error('Expected Actor control.');
    const observedOptions: Array<Parameters<AgentActorClient['spawn']>[1]> = [];
    const legacyControl: AgentActorClient = {
      ...current,
      list: () => {
        const { admissionRevision: ignored, ...snapshot } = current.list();
        void ignored;
        return snapshot;
      },
      spawn: (input, options) => {
        observedOptions.push(options);
        return current.spawn(input, options);
      },
    };
    const legacyCtx = { ...ctx, actorControl: legacyControl };

    const result = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'legacy-strategy',
      objective: 'Use the legacy revision fence.',
      quality_strategy: {
        schemaVersion: 1,
        stageId: 'legacy-stage',
        pattern: 'fan-out-and-synthesize',
        role: 'investigator',
        laneRelation: 'coverage',
      },
    }, legacyCtx)) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true });
    expect(observedOptions).toEqual([undefined]);
    expect(executor.pending).toHaveLength(1);
  });

  it('admits parallel attributed follow-ups on idle actors while they restart progress', async () => {
    const executor = new ProgressingDeferredExecutor();
    const { ctx } = await context(executor);
    const names = ['followup-agent', 'followup-core', 'followup-commits'];
    for (const taskName of names) {
      await executeTool('spawn_agent', {
        task_name: taskName,
        objective: `Initial ${taskName}.`,
      }, ctx);
    }
    await vi.waitFor(() => {
      expect(executor.pending).toHaveLength(names.length);
    });
    for (const pending of executor.pending.slice(0, names.length)) {
      pending.resolve({ output: 'Initial pass complete.' });
    }
    await vi.waitFor(() => {
      expect(ctx.actorControl?.list().activeNonRootTurns).toBe(0);
    });
    ctx.actorTurnRef = { actorPath: '/root', turnId: 'root-turn-2' };

    const results = await Promise.all(names.map(async (target) => JSON.parse(await executeTool(
      'followup_task',
      {
        target,
        objective: `Continue ${target}.`,
        quality_strategy: {
          schemaVersion: 1,
          stageId: `followup-${target}`,
          pattern: 'fan-out-and-synthesize',
          role: 'investigator',
          laneRelation: 'coverage',
        },
      },
      ctx,
    )) as Record<string, unknown>));

    expect(results).toEqual(names.map(() => expect.objectContaining({
      ok: true,
      delivery: 'started_turn',
    })));
    expect(ctx.actorControl?.list().activeNonRootTurns).toBe(3);
  });

  it('ignores invalid provenance refs while still creating ordinary legal Actors', async () => {
    const { ctx } = await context();
    const base = {
      schemaVersion: 1,
      stageId: 'invalid-target',
      pattern: 'adversarial-verification',
      role: 'challenger',
      laneRelation: 'opposition',
    };
    const unknown = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'unknown-target',
      objective: 'Inspect without optional strategy telemetry.',
      quality_strategy: {
        ...base,
        targetEvidenceRefs: ['tool-result:not-visible'],
      },
    }, ctx)) as Record<string, unknown>;
    const missing = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'missing-target',
      objective: 'Inspect without optional strategy telemetry.',
      quality_strategy: {
        ...base,
        targetEvidenceRefs: ['file:packages/coding/src/does-not-exist.ts'],
      },
    }, ctx)) as Record<string, unknown>;

    expect(unknown).toMatchObject({ ok: true, actorPath: '/root/unknown-target' });
    expect(missing).toMatchObject({ ok: true, actorPath: '/root/missing-target' });
    expect(ctx.actorControl?.list().actors.map((actor) => actor.path))
      .toEqual(expect.arrayContaining(['/root/unknown-target', '/root/missing-target']));
  });

  it('ignores unknown and stale exact Actor Turn refs without blocking legal spawns', async () => {
    const baseStrategy = {
      schemaVersion: 1,
      pattern: 'adversarial-verification',
      role: 'challenger',
      laneRelation: 'opposition',
    };

    const unknownCase = await context();
    const unknown = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'unknown-exact-target',
      objective: 'Inspect without stale optional strategy telemetry.',
      quality_strategy: {
        ...baseStrategy,
        stageId: 'unknown-exact-target',
        targetEvidenceRefs: ['agent-turn:/root/not-visible#turn=turn-missing'],
      },
    }, unknownCase.ctx)) as Record<string, unknown>;

    expect(unknown).toMatchObject({
      ok: true,
      actorPath: '/root/unknown-exact-target',
    });
    expect(unknownCase.executor.pending[0]?.input.turn.metadata?.qualityStrategy)
      .toBeUndefined();

    const staleCase = await context();
    await executeTool('spawn_agent', {
      task_name: 'known-source',
      objective: 'Provide an Actor path with one current turn.',
    }, staleCase.ctx);
    const stale = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'stale-exact-target',
      objective: 'Inspect without stale optional strategy telemetry.',
      quality_strategy: {
        ...baseStrategy,
        stageId: 'stale-exact-target',
        targetEvidenceRefs: ['agent-turn:/root/known-source#turn=turn-stale'],
      },
    }, staleCase.ctx)) as Record<string, unknown>;

    expect(stale).toMatchObject({
      ok: true,
      actorPath: '/root/stale-exact-target',
    });
    expect(staleCase.executor.pending[1]?.input.turn.metadata?.qualityStrategy)
      .toBeUndefined();
  });

  it('drops a hidden Actor evidence target without blocking an otherwise legal spawn', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      maxConcurrentThreadsPerSession: 8,
    });
    const caller = await controller.spawn('/root', {
      taskName: 'caller',
      objective: 'Coordinate one private branch.',
    });
    await controller.spawn('/root', {
      taskName: 'peer',
      objective: 'Own a separate private branch.',
    });
    const privateTurn = await controller.spawn('/root/peer', {
      taskName: 'private-child',
      objective: 'Produce evidence hidden from the caller branch.',
    });
    executor.pending[2]?.resolve({ output: 'terminal private evidence' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.bind('/root/peer').output(
      privateTurn.actorPath,
      privateTurn.turnId,
    ).state).toBe('completed');
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root/caller'),
      actorTurnRef: { actorPath: '/root/caller', turnId: caller.turnId },
    };

    const result = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'unauthorized-evidence-reader',
      objective: 'Must not start with forbidden evidence telemetry.',
      quality_strategy: {
        schemaVersion: 1,
        stageId: 'forbidden-evidence',
        pattern: 'adversarial-verification',
        role: 'challenger',
        laneRelation: 'opposition',
        targetEvidenceRefs: [
          `agent-turn:${privateTurn.actorPath}#turn=${privateTurn.turnId}`,
        ],
      },
    }, ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      actorPath: '/root/caller/unauthorized-evidence-reader',
    });
    expect(executor.pending[3]?.input.turn.metadata?.qualityStrategy).toBeUndefined();
  });

  it('accepts terminal exact-Turn provenance from a visible same-parent Actor', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({
      executor,
      maxConcurrentThreadsPerSession: 8,
    });
    const caller = await controller.spawn('/root', {
      taskName: 'caller',
      objective: 'Coordinate one peer review.',
    });
    const peer = await controller.spawn('/root', {
      taskName: 'peer',
      objective: 'Produce visible peer evidence.',
    });
    executor.pending[1]?.resolve({ output: 'terminal peer evidence' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root/caller'),
      actorTurnRef: { actorPath: '/root/caller', turnId: caller.turnId },
    };

    const result = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'peer-challenger',
      objective: 'Challenge the visible peer evidence.',
      quality_strategy: {
        schemaVersion: 1,
        stageId: 'peer-challenge',
        pattern: 'adversarial-verification',
        role: 'challenger',
        laneRelation: 'opposition',
        targetEvidenceRefs: [
          `agent-turn:${peer.actorPath}#turn=${peer.turnId}`,
        ],
      },
    }, ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      actorPath: '/root/caller/peer-challenger',
    });
    expect(executor.pending[2]?.input.turn.metadata?.qualityStrategy).toMatchObject({
      targetEvidenceRefs: [`agent-turn:${peer.actorPath}#turn=${peer.turnId}`],
    });
  });

  it('preserves running same-strategy follow-up and drops a conflicting telemetry switch', async () => {
    const { ctx, executor } = await context();
    const qualityStrategy = {
      schemaVersion: 1,
      stageId: 'coverage-round-1',
      pattern: 'fan-out-and-synthesize',
      role: 'investigator',
      laneRelation: 'coverage',
    };
    await executeTool('spawn_agent', {
      task_name: 'coverage-lane',
      objective: 'Inspect one bounded scope.',
      quality_strategy: qualityStrategy,
    }, ctx);

    const same = JSON.parse(await executeTool('followup_task', {
      target: 'coverage-lane',
      objective: 'Also inspect the adjacent test.',
      quality_strategy: qualityStrategy,
    }, ctx)) as Record<string, unknown>;
    expect(same).toMatchObject({ ok: true, delivery: 'current_turn' });

    const switched = JSON.parse(await executeTool('followup_task', {
      target: 'coverage-lane',
      objective: 'Become a challenger.',
      quality_strategy: {
        ...qualityStrategy,
        pattern: 'adversarial-verification',
        role: 'challenger',
        laneRelation: 'opposition',
        targetEvidenceRefs: ['finding:coverage candidate'],
      },
    }, ctx)) as Record<string, unknown>;
    expect(switched).toMatchObject({ ok: true, delivery: 'current_turn' });
    await expect(executor.pending[0]?.input.drainMailbox()).resolves.toMatchObject([
      { content: 'Also inspect the adjacent test.', kind: 'followup' },
      { content: 'Become a challenger.', kind: 'followup' },
    ]);
  });

  it('lets an idle actor start a new attributed stage', async () => {
    const { ctx, executor } = await context();
    await executeTool('spawn_agent', {
      task_name: 'reusable',
      objective: 'Generate a candidate.',
      quality_strategy: {
        schemaVersion: 1,
        stageId: 'candidate-1',
        pattern: 'generate-and-filter',
        role: 'generator',
      },
    }, ctx);
    executor.pending[0]?.resolve({ output: 'candidate' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    ctx.actorTurnRef = { actorPath: '/root', turnId: 'root-turn-2' };
    const followup = JSON.parse(await executeTool('followup_task', {
      target: 'reusable',
      objective: 'Challenge the candidate.',
      quality_strategy: {
        schemaVersion: 1,
        stageId: 'challenge-1',
        pattern: 'adversarial-verification',
        role: 'challenger',
        laneRelation: 'opposition',
        targetEvidenceRefs: ['finding:candidate'],
      },
    }, ctx)) as Record<string, unknown>;

    expect(followup).toMatchObject({ ok: true, delivery: 'started_turn' });
    expect(executor.pending[1]?.input.turn.metadata?.qualityStrategy).toMatchObject({
      stageId: 'challenge-1',
      ownerTurnRef: { actorPath: '/root', turnId: 'root-turn-2' },
    });
  });

  it('starts an idle follow-up after dropping stale optional provenance', async () => {
    const { ctx, executor } = await context();
    await executeTool('spawn_agent', {
      task_name: 'reusable-with-stale-ref',
      objective: 'Complete the first turn.',
    }, ctx);
    executor.pending[0]?.resolve({ output: 'first turn complete' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const followup = JSON.parse(await executeTool('followup_task', {
      target: 'reusable-with-stale-ref',
      objective: 'Start a legal follow-up without stale telemetry.',
      quality_strategy: {
        schemaVersion: 1,
        stageId: 'stale-followup-ref',
        pattern: 'adversarial-verification',
        role: 'challenger',
        laneRelation: 'opposition',
        targetEvidenceRefs: [
          'agent-turn:/root/reusable-with-stale-ref#turn=turn-stale',
        ],
      },
    }, ctx)) as Record<string, unknown>;

    expect(followup).toMatchObject({ ok: true, delivery: 'started_turn' });
    expect(executor.pending[1]?.input.turn.metadata?.qualityStrategy).toBeUndefined();
  });

  it('does not gate ordinary spawn when optional telemetry reuses a terminal stage id', async () => {
    const { ctx, executor } = await context();
    const qualityStrategy = {
      schemaVersion: 1,
      stageId: 'closed-stage',
      pattern: 'fan-out-and-synthesize',
      role: 'investigator',
      laneRelation: 'coverage',
    };
    await executeTool('spawn_agent', {
      task_name: 'first-lane',
      objective: 'Complete the first lane.',
      quality_strategy: qualityStrategy,
    }, ctx);
    executor.pending[0]?.resolve({ output: 'done' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const reopened = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'late-lane',
      objective: 'Try to reopen it.',
      quality_strategy: qualityStrategy,
    }, ctx)) as Record<string, unknown>;

    expect(reopened).toMatchObject({ ok: true, actorPath: '/root/late-lane' });
  });

  it('returns a stable structured capacity fact without creating a ghost actor', async () => {
    const { ctx } = await context();
    for (const taskName of ['a', 'b', 'c']) {
      await executeTool('spawn_agent', { task_name: taskName, objective: taskName }, ctx);
    }

    const rejected = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'd',
      objective: 'D',
      quality_strategy: { pattern: 'invented-and-invalid' },
    }, ctx)) as Record<string, unknown>;
    const listed = JSON.parse(await executeTool('list_agents', {}, ctx)) as {
      readonly actors: readonly { readonly path: string }[];
    };

    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: 'agent_limit_reached',
        maxConcurrentThreads: 4,
        activeNonRootTurns: 3,
        availableNonRootSlots: 0,
        retryable: true,
      },
    });
    expect(listed.actors.some((actor) => actor.path === '/root/d')).toBe(false);
  });

  it('keeps lifecycle admission fail-closed when optional strategy metadata is invalid', async () => {
    const { ctx, controller } = await context();
    await executeTool('spawn_agent', {
      task_name: 'closed-child',
      objective: 'Initial work.',
    }, ctx);
    await controller.close('/root', '/root/closed-child');

    const result = JSON.parse(await executeTool('followup_task', {
      target: 'closed-child',
      objective: 'Must remain closed.',
      quality_strategy: { pattern: 'invented-and-invalid' },
    }, ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'actor_closed' },
    });
  });

  it('exposes mailbox-driven wait without raw Actor event controls', () => {
    const definition = getToolDefinition('wait_agent');

    expect(definition?.input_schema.properties).toEqual({
      timeout_ms: expect.objectContaining({ type: 'number' }),
    });
    expect(definition?.description).toContain('mailbox');
    expect(definition?.description).not.toContain('return_on');
  });

  it('does not wake the parent model for progress and wakes once mailbox input arrives', async () => {
    const sessionId = 'session-mailbox-wait';
    const { ctx, executor } = await context(new DeferredExecutor(), sessionId);
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Inspect.' }, ctx);

    let settled = false;
    const waiting = executeTool('wait_agent', {
      timeout_ms: 10_000,
      return_on: 'event',
      after_sequence: 0,
    }, ctx).then((value) => {
      settled = true;
      return JSON.parse(value) as Record<string, unknown>;
    });
    for (let index = 0; index < 100; index += 1) {
      await executor.pending[0]?.input.reportProgress({
        kind: 'tool',
        summary: `Progress ${index}`,
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    getMessageQueue().enqueue({
      agentId: actorQueueId(sessionId, '/root'),
      priority: 'background',
      mode: 'system-reminder',
      content: '<system-reminder>Reconcile the plan.</system-reminder>',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    getMessageQueue().enqueue({
      agentId: actorQueueId(sessionId, '/root'),
      priority: 'background',
      mode: 'task-notification',
      content: '<agent-completed turn_id="turn-1">done</agent-completed>',
    });

    await expect(waiting).resolves.toEqual({ ok: true, status: 'mailbox' });
  });

  it('lists and spawns a local constructed specialist without an external executor plane', async () => {
    registerConstructedAgent({
      kind: 'agent',
      name: 'repo-explorer',
      version: '1.0.0',
      createdAt: '2026-07-22T00:00:00.000Z',
      content: {
        instructions: 'Explore repositories without modifying them.',
        tools: [{ ref: 'builtin:read' }, { ref: 'builtin:spawn_agent' }],
        description: 'Read-only repository explorer',
      },
      testedAt: '2026-07-22T00:00:00.000Z',
      testReport: { passed: true, results: [] },
    }, { source: 'built-in' });
    const { ctx, executor, controller } = await context();

    const listed = JSON.parse(await executeTool('list_dispatchable_agents', {}, ctx)) as {
      readonly agents?: readonly { readonly agent_id: string; readonly origin: string }[];
    };
    const specialist = listed.agents?.find((agent) => agent.origin === 'constructed');
    expect(specialist?.agent_id).toContain('repo-explorer');

    const shortAlias = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'short-alias',
      objective: 'Inspect the repository.',
      agent_id: 'repo-explorer',
    }, ctx)) as Record<string, unknown>;
    expect(shortAlias).toMatchObject({ ok: true, actorPath: '/root/short-alias' });
    expect(executor.pending[0]?.input.actor.kind).toBe('constructed');
    expect(executor.pending[0]?.input.actor.capabilities.tools).toEqual([
      'read',
      'spawn_agent',
    ]);
    expect(executor.pending[0]?.input.turn.metadata).toMatchObject({
      agentId: 'repo-explorer',
      specialistName: 'repo-explorer',
    });

    const canonical = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'canonical-id',
      objective: 'Inspect another boundary.',
      agent_id: specialist?.agent_id,
    }, ctx)) as Record<string, unknown>;
    expect(canonical).toMatchObject({ ok: true, actorPath: '/root/canonical-id' });
    expect(executor.pending[1]?.input.actor.kind).toBe('constructed');

    const nested = await controller.bind('/root/short-alias').spawn({
      taskName: 'nested-reader',
      objective: 'Inspect one nested boundary.',
    });
    expect(controller.get('/root', nested.actorPath).actor.capabilities.tools).toEqual([
      'read',
      'spawn_agent',
    ]);
  });

  it('preserves an explicit empty specialist tool ceiling instead of inheriting wildcard tools', async () => {
    registerConstructedAgent({
      kind: 'agent',
      name: 'no-tools-reviewer',
      version: '1.0.0',
      createdAt: '2026-07-26T00:00:00.000Z',
      content: {
        instructions: 'Return a text-only review.',
        tools: [],
        description: 'No-tools reviewer',
      },
      testedAt: '2026-07-26T00:00:00.000Z',
      testReport: { passed: true, results: [] },
    });
    const { ctx, executor } = await context();

    const spawned = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'no-tools',
      objective: 'Review without tools.',
      agent_id: 'no-tools-reviewer',
    }, ctx)) as Record<string, unknown>;

    expect(spawned).toMatchObject({ ok: true });
    expect(executor.pending[0]?.input.actor.capabilities.tools).toEqual([]);
  });

  it('filters and paginates only the caller-visible actor projection', async () => {
    const { ctx } = await context();
    for (const taskName of ['a', 'b', 'c']) {
      await executeTool('spawn_agent', { task_name: taskName, objective: taskName }, ctx);
    }

    const first = JSON.parse(await executeTool('list_agents', {
      path_prefix: '/root/',
      state: 'running',
      limit: 2,
    }, ctx)) as {
      readonly actors: readonly { readonly path: string }[];
      readonly hasMore?: boolean;
      readonly nextAfterPath?: string;
    };
    const second = JSON.parse(await executeTool('list_agents', {
      path_prefix: '/root/',
      state: 'running',
      limit: 2,
      after_path: first.nextAfterPath,
    }, ctx)) as {
      readonly actors: readonly { readonly path: string }[];
      readonly hasMore?: boolean;
    };

    expect(first).toMatchObject({
      hasMore: true,
      nextAfterPath: '/root/b',
      actors: [{ path: '/root/a' }, { path: '/root/b' }],
    });
    expect(second).toMatchObject({ hasMore: false, actors: [{ path: '/root/c' }] });
  });

  it('applies list filters after authorization without leaking a peer descendant count', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'caller', objective: 'Caller.' });
    await controller.spawn('/root', { taskName: 'peer', objective: 'Peer.' });
    await controller.spawn('/root/peer', { taskName: 'private-child', objective: 'Private.' });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root/caller'),
    };

    const listed = JSON.parse(await executeTool('list_agents', {
      path_prefix: '/root/peer/private-child',
    }, ctx)) as Record<string, unknown>;

    expect(listed).toMatchObject({ ok: true, matchedActorCount: 0, actors: [] });
  });

  it('rejects model wait windows outside the Runtime-owned bounds', async () => {
    const { ctx } = await context();

    const listResult = JSON.parse(
      await executeTool('list_agents', { limit: 51 }, ctx),
    ) as Record<string, unknown>;
    const waitResult = JSON.parse(await executeTool('wait_agent', {
      timeout_ms: 9_999,
    }, ctx)) as Record<string, unknown>;
    const longWaitResult = JSON.parse(await executeTool('wait_agent', {
      timeout_ms: 3_600_001,
    }, ctx)) as Record<string, unknown>;

    expect(listResult).toMatchObject({
      ok: false,
      error: { message: 'limit must be an integer between 1 and 50.' },
    });
    expect(waitResult).toMatchObject({
      ok: false,
      error: { message: 'timeout_ms must be an integer between 10000 and 3600000.' },
    });
    expect(longWaitResult).toMatchObject({
      ok: false,
      error: { message: 'timeout_ms must be an integer between 10000 and 3600000.' },
    });
  });

  it('cannot escalate a read-only Actor to a write child', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', {
      taskName: 'reader',
      objective: 'Read only.',
      capabilities: { filesystem: 'read' },
    });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root/reader'),
    };

    const result = JSON.parse(await executeTool('spawn_agent', {
      task_name: 'writer',
      objective: 'Attempt a write.',
      read_only: false,
      quality_strategy: { pattern: 'invented-and-invalid' },
    }, ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_capabilities' },
    });
    expect(controller.list('/root').actors.some((actor) => (
      actor.path === '/root/reader/writer'
    ))).toBe(false);
  });

  it('keeps send_message dormant and uses followup_task to start the next turn', async () => {
    const { ctx, executor } = await context();
    await executeTool('spawn_agent', { task_name: 'reviewer', objective: 'First.' }, ctx);
    executor.pending[0]?.resolve({ output: 'first' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await executeTool('send_message', { to: 'reviewer', content: 'New evidence.' }, ctx);
    expect(executor.pending).toHaveLength(1);
    const followup = JSON.parse(await executeTool('followup_task', {
      target: 'reviewer', objective: 'Second.',
    }, ctx)) as Record<string, unknown>;

    expect(followup).toMatchObject({ ok: true, delivery: 'started_turn' });
    expect(executor.pending).toHaveLength(2);
    await expect(executor.pending[1]?.input.drainMailbox()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'New evidence.' }),
    ]));
  });

  it('uses Runtime message ids for forwarding and keeps the model schema free of seen_by', async () => {
    const { ctx } = await context();
    const definition = getToolDefinition('send_message');
    expect(definition?.input_schema.properties).toHaveProperty('forwarded_message_id');
    expect(definition?.input_schema.properties).not.toHaveProperty('seen_by');
    expect(definition?.input_schema.properties).toHaveProperty('classification');

    await executeTool('spawn_agent', { task_name: 'a', objective: 'A' }, ctx);
    await executeTool('spawn_agent', { task_name: 'b', objective: 'B' }, ctx);
    const aControl = ctx.actorControl?.get('/root/a');
    expect(aControl).toBeDefined();

    const sent = JSON.parse(await executeTool('send_message', {
      to: 'a', content: 'Fresh evidence.', classification: 'sensitive',
    }, ctx)) as Record<string, unknown>;
    expect(sent).toMatchObject({ ok: true, messageId: expect.any(String) });
    expect(ctx.actorControl?.get('/root/a').mailbox.at(-1)).toMatchObject({
      classification: 'sensitive',
      lineage: ['/root'],
    });
  });

  it('enforces the root per-turn send cap before mutating any mailbox', async () => {
    const { ctx } = await context();
    await executeTool('spawn_agent', { task_name: 'a', objective: 'A' }, ctx);
    ctx.sendMessageTurnCounter = { count: 19 };

    const accepted = JSON.parse(await executeTool('send_message', {
      to: 'a', content: 'Last accepted message.',
    }, ctx)) as Record<string, unknown>;
    const mailboxSize = ctx.actorControl?.get('/root/a').mailbox.length;
    const rejected = JSON.parse(await executeTool('send_message', {
      to: 'a', content: 'Storm message.',
    }, ctx)) as Record<string, unknown>;

    expect(accepted).toMatchObject({ ok: true });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'message_rate_limited', limit: 20, sent: 20 },
    });
    expect(ctx.actorControl?.get('/root/a').mailbox).toHaveLength(mailboxSize ?? -1);
  });

  it('rejects an over-budget broadcast before delivering to any recipient', async () => {
    const { ctx } = await context();
    await executeTool('spawn_agent', { task_name: 'a', objective: 'A' }, ctx);
    await executeTool('spawn_agent', { task_name: 'b', objective: 'B' }, ctx);
    ctx.sendMessageTurnCounter = { count: 19 };
    const aSize = ctx.actorControl?.get('/root/a').mailbox.length;
    const bSize = ctx.actorControl?.get('/root/b').mailbox.length;

    const rejected = JSON.parse(await executeTool('send_message', {
      to: '*', content: 'Do not partially deliver.',
    }, ctx)) as Record<string, unknown>;

    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'message_rate_limited', limit: 20, sent: 19 },
    });
    expect(ctx.actorControl?.get('/root/a').mailbox).toHaveLength(aSize ?? -1);
    expect(ctx.actorControl?.get('/root/b').mailbox).toHaveLength(bSize ?? -1);
    expect(ctx.sendMessageTurnCounter.count).toBe(19);
  });

  it('broadcasts once per visible recipient and returns Runtime message ids', async () => {
    const { ctx } = await context();
    ctx.sendMessageTurnCounter = { count: 0 };
    await executeTool('spawn_agent', { task_name: 'a', objective: 'A' }, ctx);
    await executeTool('spawn_agent', { task_name: 'b', objective: 'B' }, ctx);

    const delivered = JSON.parse(await executeTool('send_message', {
      to: '*', content: 'Shared evidence.',
    }, ctx)) as { readonly messageIds?: readonly string[] } & Record<string, unknown>;

    expect(delivered).toMatchObject({
      ok: true,
      delivery: 'broadcast',
      recipients: ['/root/a', '/root/b'],
    });
    expect(delivered.messageIds).toHaveLength(2);
    expect(ctx.actorControl?.get('/root/a').mailbox.at(-1)?.content).toBe('Shared evidence.');
    expect(ctx.actorControl?.get('/root/b').mailbox.at(-1)?.content).toBe('Shared evidence.');
    expect(ctx.sendMessageTurnCounter?.count).toBe(2);
  });

  it('uses the smaller per-turn send cap for non-root Agents', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'a', objective: 'A' });
    await controller.spawn('/root', { taskName: 'b', objective: 'B' });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root/a'),
      sendMessageTurnCounter: { count: 4 },
    };

    const accepted = JSON.parse(await executeTool('send_message', {
      to: 'b', content: 'Last child message.',
    }, ctx)) as Record<string, unknown>;
    const rejected = JSON.parse(await executeTool('send_message', {
      to: 'b', content: 'Child storm message.',
    }, ctx)) as Record<string, unknown>;

    expect(accepted).toMatchObject({ ok: true });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'message_rate_limited', limit: 5, sent: 5 },
    });
  });

  it('reports an interrupted wait when the owning root round is canceled', async () => {
    const { ctx } = await context();
    const abort = new AbortController();
    ctx.abortSignal = abort.signal;
    abort.abort('new user input');
    const result = JSON.parse(await executeTool('wait_agent', {
      timeout_ms: 10_000,
    }, ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, status: 'interrupted' });
  });

  it('returns immediately for pre-existing scoped user input without consuming it', async () => {
    const { ctx } = await context(new DeferredExecutor(), 'session-1');
    const queue = getMessageQueue();
    queue.enqueue({
      agentId: 'actor:session-1:/root',
      priority: 'user',
      mode: 'prompt',
      content: 'answer the user first',
    });

    const result = JSON.parse(await executeTool('wait_agent', {
      timeout_ms: 10_000,
    }, ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, status: 'user_input_pending' });
    expect(queue.peek({
      agentId: 'actor:session-1:/root',
      maxPriority: 'user',
      mode: 'prompt',
    }).map((message) => message.content)).toEqual(['answer the user first']);
  });

  it('settles a pure mailbox wait for Host suspension without aborting its Actor', async () => {
    const { ctx } = await context(new DeferredExecutor(), 'session-1');
    let wake: (() => void) | undefined;
    const unregister = vi.fn();
    ctx.parentEvents = { registerGenerationWait: callback => { wake = callback; return unregister; } };
    const waiting = executeTool('wait_agent', { timeout_ms: 10_000 }, ctx);
    await vi.waitFor(() => expect(wake).toBeDefined());
    wake!();
    expect(JSON.parse(await waiting)).toMatchObject({ ok: true, status: 'interrupted' });
    expect(unregister).toHaveBeenCalledOnce();
    expect(ctx.abortSignal?.aborted).not.toBe(true);
  });

  it('wakes when scoped user input arrives after the Actor waiter is registered', async () => {
    const { ctx } = await context(new DeferredExecutor(), 'session-1');
    const waiting = executeTool('wait_agent', { timeout_ms: 10_000 }, ctx);
    await Promise.resolve();

    getMessageQueue().enqueue({
      agentId: 'actor:session-1:/root',
      priority: 'user',
      mode: 'prompt',
      content: 'queued while waiting',
    });

    await expect(waiting.then((value) => JSON.parse(value))).resolves.toMatchObject({
      ok: true,
      status: 'user_input_pending',
    });
  });

  it('mailbox wait returns only an acknowledgement and completion commits once', async () => {
    const executor = new DeferredExecutor();
    const sessionId = 'session-terminal';
    const queueAgentId = `actor:${sessionId}:/root`;
    const controller = await createAgentActorController({
      executor,
      onMessageCommitted: (message) => {
        if (message.kind !== 'completion' || message.recipientPath !== '/root' || !message.turnId) return;
        getMessageQueue().enqueue({
          agentId: queueAgentId,
          priority: 'background',
          mode: 'task-notification',
          content: `<agent-completed turn_id="${message.turnId}">${message.content}</agent-completed>`,
          taskResult: {
            type: 'task_result',
            source: 'child_task',
            taskId: message.turnId,
            status: 'completed',
            summary: message.content,
          },
        });
      },
    });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root'),
      sessionId,
    };
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    let settled = false;
    const waiting = executeTool('wait_agent', {
      timeout_ms: 10_000,
    }, ctx).then((value) => {
      settled = true;
      return JSON.parse(value) as Record<string, unknown>;
    });

    await executor.pending[0]?.input.reportProgress({ kind: 'tool', summary: 'First read.' });
    await executor.pending[0]?.input.reportProgress({ kind: 'tool', summary: 'Second read.' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    executor.pending[0]?.resolve({ output: 'terminal evidence' });

    const result = await waiting;
    expect(result).toEqual({ ok: true, status: 'mailbox' });
    expect(result).not.toHaveProperty('events');
    expect(result).not.toHaveProperty('terminalOutputs');
    expect(getMessageQueue().count({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(1);

    await commitActorNotificationReceipts(ctx, [
      committedToolResultMessage(JSON.stringify(result)),
    ]);
    expect(getMessageQueue().count({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(1);

    const notification = getMessageQueue().peek({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })[0];
    expect(notification?.taskResult).toBeDefined();
    await commitActorNotificationReceipts(ctx, [{
      role: 'user',
      content: notification?.content ?? '',
      _synthetic: true,
      _source: 'agent-completed',
      _taskResult: notification?.taskResult,
    }]);
    expect(getMessageQueue().count({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(0);
  });

  it('an explicit Actor message wakes the parent while the child remains active', async () => {
    const executor = new DeferredExecutor();
    const controller = await createAgentActorController({ executor });
    await controller.spawn('/root', { taskName: 'parent', objective: 'Coordinate.' });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root/parent'),
      sessionId: 'physical-worker-session',
      contextIdentitySessionId: 'session-nested-terminal',
    };
    await executeTool('spawn_agent', { task_name: 'child', objective: 'Inspect.' }, ctx);
    const waiting = executeTool('wait_agent', { timeout_ms: 10_000 }, ctx);
    await Promise.resolve();
    getMessageQueue().enqueue({
      agentId: actorQueueId('session-nested-terminal', '/root/parent'),
      priority: 'background',
      mode: 'agent-message',
      content: '<agent-message>Important evidence.</agent-message>',
    });

    await expect(waiting.then((value) => JSON.parse(value))).resolves.toEqual({
      ok: true,
      status: 'mailbox',
    });
    expect(controller.output('/root', '/root/parent/child').state).toBe('running');
  });

  it('agent_output consumes the matching terminal banner only after commit', async () => {
    const executor = new DeferredExecutor();
    const sessionId = 'session-output';
    const queueAgentId = `actor:${sessionId}:/root`;
    const controller = await createAgentActorController({
      executor,
      onMessageCommitted: (message) => {
        if (message.kind !== 'completion' || message.recipientPath !== '/root' || !message.turnId) return;
        getMessageQueue().enqueue({
          agentId: queueAgentId,
          priority: 'background',
          mode: 'task-notification',
          content: message.content,
          taskResult: {
            type: 'task_result',
            source: 'child_task',
            taskId: message.turnId,
            status: 'completed',
            summary: message.content,
          },
        });
      },
    });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      actorControl: controller.bind('/root'),
      sessionId,
    };
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    executor.pending[0]?.resolve({ output: 'terminal evidence' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(getMessageQueue().count({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(1);

    const outputText = await executeTool('agent_output', { target: 'worker' }, ctx);
    const output = JSON.parse(outputText) as {
      readonly output?: string;
    };
    expect(output.output).toBe('terminal evidence');
    expect(getMessageQueue().count({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(1);

    await commitActorNotificationReceipts(ctx, [committedToolResultMessage(outputText)]);
    expect(getMessageQueue().count({
      agentId: queueAgentId,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(0);
  });

  it('acknowledges a host-delivered child result after its synthetic message commits', async () => {
    const { ctx, executor } = await context();
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    const cursor = ctx.actorControl?.eventSnapshot().at(-1)?.sequence ?? 0;
    const turnId = ctx.actorControl?.get('/root/worker').actor.currentTurnId;
    executor.pending[0]?.resolve({ output: 'terminal evidence' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await commitActorNotificationReceipts(ctx, [{
      role: 'user',
      content: '<agent-completed>terminal evidence</agent-completed>',
      _synthetic: true,
      _source: 'agent-completed',
      _taskResult: {
        type: 'task_result',
        source: 'child_task',
        taskId: turnId ?? '',
        status: 'completed',
        summary: 'terminal evidence',
      },
    }]);

    expect(ctx.actorControl?.eventSnapshot(cursor).some((event) => (
      event.turnId === turnId
    ))).toBe(false);
  });

  it('retains raw event replay and long-poll semantics on the Runtime client', async () => {
    const { ctx } = await context();
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    const cursor = ctx.actorControl?.eventSnapshot().at(-1)?.sequence ?? 0;
    await ctx.actorControl?.send('/root/worker', 'First update.');
    await ctx.actorControl?.send('/root/worker', 'Second update.');

    const events = ctx.actorControl?.eventSnapshot(cursor) ?? [];
    expect(events).toHaveLength(2);
    await expect(ctx.actorControl?.wait(cursor, 0)).resolves.toEqual(events[0]);
  });

  it('interrupts an invalidated actor branch without permanently closing its identities', async () => {
    const { ctx, controller } = await context();
    await executeTool('spawn_agent', { task_name: 'parent', objective: 'Parent.' }, ctx);
    await controller.bind('/root/parent').spawn({ taskName: 'child', objective: 'Child.' });

    const result = JSON.parse(await executeTool('interrupt_agent', {
      target: 'parent',
      scope: 'subtree',
      reason: 'premise invalidated',
    }, ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, scope: 'subtree' });
    expect(controller.output('/root', '/root/parent')).toMatchObject({ state: 'interrupted' });
    expect(controller.output('/root', '/root/parent/child')).toMatchObject({ state: 'interrupted' });
    expect(controller.get('/root', '/root/parent').actor.state).toBe('idle');
  });

  it('renders an Actor owner conflict with actionable Runtime diagnostics', async () => {
    const { ctx } = await context();
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    if (!ctx.actorControl) throw new Error('Expected Actor control.');
    const conflictedContext: KodaXToolExecutionContext = {
      ...ctx,
      actorControl: {
        ...ctx.actorControl,
        async interrupt() {
          throw Object.assign(
            new Error('Actor tree is owned by live Runtime rt_other.'),
            {
              code: 'actor_owner_conflict',
              retryable: false,
              ownerRuntimeId: 'rt_other',
              currentRevision: 16,
              localExecutionsAborted: true,
            },
          );
        },
      },
    };

    const result = JSON.parse(await executeTool('interrupt_agent', {
      target: 'worker',
      reason: 'stop',
    }, conflictedContext)) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'actor_owner_conflict',
        retryable: false,
        ownerRuntimeId: 'rt_other',
        currentRevision: 16,
        localExecutionsAborted: true,
        hint: expect.stringContaining('owns this Session'),
      },
    });
  });

  it('reports a mailbox wait timeout without consulting Actor events', async () => {
    vi.useFakeTimers();
    const { ctx } = await context();
    await executeTool('spawn_agent', { task_name: 'worker', objective: 'Work.' }, ctx);
    const waiting = executeTool('wait_agent', { timeout_ms: 10_000 }, ctx);

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(waiting.then((value) => JSON.parse(value))).resolves.toEqual({
      ok: true,
      status: 'wait_expired',
    });
  });
});
