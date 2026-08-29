import {
  _resetMessageQueueForTests,
  getMessageQueue,
  type AgentActorSnapshot,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentExecutorPlaneBinding,
  type AgentTaskSnapshot,
  type AgentTurnExecutor,
} from '@kodax-ai/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProviderCredentialLeaseScope,
  getScopedProviderCredential,
  runWithProviderCredentialLeaseScope,
  withProviderRequestCredential,
} from '@kodax-ai/llm';

import type {
  KodaXChildExecutionResult,
  KodaXActorHost,
  KodaXOptions,
  KodaXToolExecutionContext,
} from '../types.js';
import { executeChildAgents } from '../child-executor.js';
import {
  actorQueueId,
  CodingActorSession,
} from './actor-runtime.js';

vi.mock('../child-executor.js', () => ({
  executeChildAgents: vi.fn(),
}));

const executeChildAgentsMock = vi.mocked(executeChildAgents);

function completedChild(summary: string, structured?: unknown): KodaXChildExecutionResult {
  return {
    results: [{
      childId: '/root/worker',
      fanoutClass: 'evidence-scan',
      status: 'completed',
      disposition: 'valid',
      summary,
      evidenceRefs: [],
      contradictions: [],
      ...(structured === undefined ? {} : { structured }),
    }],
    mergedFindings: [],
    mergedArtifacts: [],
    totalTokensUsed: 0,
    cancelledChildren: [],
  };
}

function externalTask(
  state: AgentTaskSnapshot['state'],
  progress?: AgentTaskSnapshot['progress'],
  artifacts?: AgentTaskSnapshot['artifacts'],
): AgentTaskSnapshot {
  return {
    taskId: 'external-turn',
    route: 'external',
    agentId: 'external:reviewer',
    objective: 'Review.',
    state,
    cancellation: 'none',
    registration: {
      agentId: 'external:reviewer',
      origin: 'external',
      executorId: 'fixture',
      protocol: 'http',
      configurationRevision: 'rev-1',
      capabilities: {
        streaming: 'supported',
        durableTasks: 'supported',
        inputRequired: 'supported',
        cancellation: 'supported',
        artifacts: 'supported',
      },
      effects: { remote: 'read', workspace: 'none' },
    },
    idempotencyKey: 'external-turn',
    dispatchAttempt: 1,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...(progress === undefined ? {} : { progress }),
    ...(state === 'completed' ? { output: 'external done' } : {}),
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}

function environment(): {
  readonly ctx: KodaXToolExecutionContext;
  readonly options: KodaXOptions;
} {
  return {
    ctx: {
      backups: new Map(),
      sessionId: 'session-1',
      parentAgentConfig: { provider: 'anthropic' },
    },
    options: { provider: 'anthropic', agentMode: 'ama' },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

afterEach(() => {
  _resetMessageQueueForTests();
  vi.clearAllMocks();
});

describe('F270 coding Actor runtime adapter', () => {
  it('derives and closes a concrete Provider lease for each native child turn', async () => {
    let delayedRequest: Promise<unknown> | undefined;
    let releaseDelayed: (() => void) | undefined;
    executeChildAgentsMock.mockImplementation(async () => {
      await expect(withProviderRequestCredential(
        'anthropic',
        'agent',
        undefined,
        () => getScopedProviderCredential('anthropic'),
      )).resolves.toBe('anthropic-secret');
      await expect(withProviderRequestCredential(
        'openai',
        'agent',
        undefined,
        () => 'must-not-run',
      )).rejects.toThrow('does not allow provider openai');
      delayedRequest = new Promise<void>((resolve) => {
        releaseDelayed = resolve;
      }).then(() => withProviderRequestCredential(
        'anthropic',
        'agent',
        undefined,
        () => getScopedProviderCredential('anthropic'),
      )).catch((error: unknown) => error);
      return completedChild('native result');
    });
    const parentScope = createProviderCredentialLeaseScope({
      allowedProviders: ['anthropic', 'openai'],
      async acquire(provider) {
        return `${provider}-secret`;
      },
    });
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    const turn = await runWithProviderCredentialLeaseScope(parentScope, () => root.spawn({
      taskName: 'worker',
      objective: 'Use only Anthropic.',
      capabilities: { providers: ['anthropic'] },
    }));
    await settle();
    expect(root.output(turn.actorPath, turn.turnId)).toMatchObject({
      state: 'completed',
      output: 'native result',
    });
    releaseDelayed?.();
    await expect(delayedRequest).resolves.toMatchObject({
      message: expect.stringContaining('no longer active'),
    });
    await session.close();
    parentScope.close();
  });

  it('binds an explicit lazy credential lease to the exact admitted Actor turn', async () => {
    const acquire = vi.fn(async (provider: string) => `${provider}-explicit-secret`);
    executeChildAgentsMock.mockImplementation(async () => {
      await expect(withProviderRequestCredential(
        'anthropic',
        'agent',
        undefined,
        () => getScopedProviderCredential('anthropic'),
      )).resolves.toBe('anthropic-explicit-secret');
      return completedChild('explicit credential result');
    });
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    const turn = await session.spawnRoot(
      {
        taskName: 'worker',
        objective: 'Use the explicit lease.',
        capabilities: { providers: ['anthropic'] },
      },
      undefined,
      ({ actorPath, turnId, providers }) => {
        expect(actorPath).toBe('/root/worker');
        expect(turnId).toMatch(/^turn_/);
        expect(providers).toEqual(['anthropic']);
        return { allowedProviders: ['anthropic'], acquire };
      },
    );
    await settle();

    expect(root.output(turn.actorPath, turn.turnId)).toMatchObject({
      state: 'completed',
      output: 'explicit credential result',
    });
    expect(acquire).toHaveBeenCalledOnce();
    await session.close();
  });

  it('refuses to widen a running Actor turn with a follow-up credential lease', async () => {
    executeChildAgentsMock.mockImplementation((_bundles, _ctx, childOptions) =>
      new Promise((resolve) => {
        childOptions.abortSignal?.addEventListener(
          'abort',
          () => resolve(completedChild('interrupted')),
          { once: true },
        );
      }));
    const credentialFactory = vi.fn(() => ({
      allowedProviders: ['anthropic'],
      async acquire() { return 'must-not-be-requested'; },
    }));
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);
    const turn = await root.spawn({
      taskName: 'worker',
      objective: 'Keep running.',
      capabilities: { providers: ['anthropic'] },
    });

    await expect(session.followupRoot(
      turn.actorPath,
      'Do more with a new lease.',
      undefined,
      credentialFactory,
    )).rejects.toThrow('already has a credential-bound turn');
    expect(credentialFactory).not.toHaveBeenCalled();
    expect(root.get(turn.actorPath).mailbox).toEqual([]);
    await root.interrupt(turn.actorPath);
    await session.close();
  });

  it('atomically requires a daemon credential only when follow-up admits a new internal turn', async () => {
    executeChildAgentsMock.mockResolvedValue(completedChild('first turn complete'));
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);
    const first = await root.spawn({ taskName: 'worker', objective: 'Finish once.' });
    await settle();
    expect(root.output(first.actorPath, first.turnId)).toMatchObject({ state: 'completed' });

    await expect(session.followupRoot(
      first.actorPath,
      'This would start a new unbound turn.',
      undefined,
      undefined,
      true,
    )).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(root.get(first.actorPath).mailbox).toEqual([]);

    executeChildAgentsMock.mockImplementation((_bundles, _ctx, childOptions) =>
      new Promise((resolve) => {
        childOptions.abortSignal?.addEventListener(
          'abort',
          () => resolve(completedChild('interrupted')),
          { once: true },
        );
      }));
    const active = await root.spawn({ taskName: 'active', objective: 'Keep running.' });
    await vi.waitFor(() => expect(executeChildAgentsMock).toHaveBeenCalledTimes(2));
    await expect(session.followupRoot(
      active.actorPath,
      'Continue the already-bound current turn.',
      undefined,
      undefined,
      true,
    )).resolves.toMatchObject({ delivery: 'current_turn' });
    await root.interrupt(active.actorPath);
    await session.close();
  });

  it('closes an Actor credential scope as soon as its turn is interrupted', async () => {
    let postAbortAcquire: Promise<unknown> | undefined;
    let releaseExecutor: (() => void) | undefined;
    executeChildAgentsMock.mockImplementation((_bundles, _ctx, childOptions) => {
      const aborted = new Promise<void>((resolve) => {
        childOptions.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      postAbortAcquire = aborted.then(() => withProviderRequestCredential(
            'anthropic',
            'agent',
            undefined,
            () => getScopedProviderCredential('anthropic'),
          )).catch((error: unknown) => error);
      return new Promise((resolve) => {
        releaseExecutor = () => resolve(completedChild('interrupted'));
      });
    });
    const parentScope = createProviderCredentialLeaseScope({
      allowedProviders: ['anthropic'],
      async acquire() { return 'anthropic-secret'; },
    });
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);
    const turn = await runWithProviderCredentialLeaseScope(parentScope, () => root.spawn({
      taskName: 'worker',
      objective: 'Keep the executor pending after cancellation.',
      capabilities: { providers: ['anthropic'] },
    }));

    await vi.waitFor(() => expect(executeChildAgentsMock).toHaveBeenCalled());
    await root.interrupt(turn.actorPath, 'cancel now');
    await expect(postAbortAcquire).resolves.toMatchObject({
      message: expect.stringContaining('no longer active'),
    });
    releaseExecutor?.();
    await session.close();
    parentScope.close();
  });

  it('never propagates Runtime Provider credentials into an external Agent executor', async () => {
    const acquire = vi.fn(async () => 'must-not-be-resolved');
    const externalExecutor: AgentTurnExecutor = {
      execute: vi.fn(async (): Promise<AgentExecutionResult> => {
        const observed = await withProviderRequestCredential(
          'anthropic',
          'agent',
          undefined,
          () => getScopedProviderCredential('anthropic'),
        ).catch((error: unknown) => error);
        return {
          output: observed instanceof Error ? observed.message : String(observed),
        };
      }),
    };
    const parentScope = createProviderCredentialLeaseScope({
      allowedProviders: ['anthropic'],
      acquire,
    });
    const session = new CodingActorSession({
      executor: externalExecutor,
      sessionId: 'session-1',
    });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    const turn = await runWithProviderCredentialLeaseScope(parentScope, () => root.spawn({
      taskName: 'remote-reviewer',
      objective: 'Use only the external credentialRef broker.',
      kind: 'external',
    }));
    await settle();

    expect(root.output(turn.actorPath, turn.turnId)).toMatchObject({
      state: 'completed',
      output: expect.stringContaining('does not allow provider anthropic'),
    });
    expect(acquire).not.toHaveBeenCalled();
    await expect(session.spawnRoot(
      {
        taskName: 'bound-remote',
        objective: 'Must reject Runtime credentials.',
        kind: 'external',
      },
      undefined,
      () => ({ allowedProviders: ['anthropic'], acquire }),
    )).rejects.toThrow(/external Agent.*credential/i);
    expect(root.list().actors.some((actor) => actor.path === '/root/bound-remote')).toBe(false);
    await session.close();
    parentScope.close();
  });

  it('keeps native turns on the coding executor when an external plane executor exists', async () => {
    executeChildAgentsMock.mockResolvedValue(completedChild('native result'));
    const externalExecutor: AgentTurnExecutor = {
      execute: vi.fn(async (): Promise<AgentExecutionResult> => ({ output: 'external result' })),
    };
    const session = new CodingActorSession({ executor: externalExecutor, sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach({
      ...ctx,
      parentAgentConfig: {
        ...ctx.parentAgentConfig,
        contextDiagnostics: true,
        disablePromptCache: false,
      },
    }, options);

    const turn = await root.spawn({ taskName: 'worker', objective: 'Inspect.' });
    await settle();

    expect(externalExecutor.execute).not.toHaveBeenCalled();
    expect(executeChildAgentsMock).toHaveBeenCalledOnce();
    expect(executeChildAgentsMock.mock.calls[0]?.[2].actorTurnId).toBe(turn.turnId);
    expect(executeChildAgentsMock.mock.calls[0]?.[2].parentOptions).toMatchObject({
      contextDiagnostics: true,
      disablePromptCache: false,
    });
    expect(root.output(turn.actorPath, turn.turnId).output).toBe('native result');
  });

  it('attaches the fixed parse-only result contract and preserves it on the exact Actor Turn', async () => {
    const structured = {
      schemaVersion: 1,
      outcomes: [{
        target: { evidenceRef: 'finding:auth-boundary' },
        disposition: 'confirmed',
        evidenceRefs: ['file:packages/agent/src/actors/controller.ts'],
      }],
      assertedCoverage: ['ownership boundary'],
    };
    executeChildAgentsMock.mockResolvedValue(completedChild('challenged', structured));
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    const turn = await root.spawn({
      taskName: 'challenger',
      objective: 'Challenge the candidate.',
      metadata: {
        qualityStrategy: {
          schemaVersion: 1,
          stageId: 'challenge-1',
          pattern: 'adversarial-verification',
          role: 'challenger',
          laneRelation: 'opposition',
          targetEvidenceRefs: ['finding:auth-boundary'],
          ownerTurnRef: { actorPath: '/root', turnId: 'root-turn-1' },
        },
      },
    });
    await settle();

    expect(executeChildAgentsMock.mock.calls[0]?.[0][0]).toMatchObject({
      structuredOutputContract: 'pattern-disposition-parse-only',
      outputSchema: expect.objectContaining({ type: 'object' }),
      evidenceRefs: ['finding:auth-boundary'],
    });
    expect(root.output(turn.actorPath, turn.turnId).structured).toEqual(structured);
  });

  it('persists the effective child route and drops only invalid disposition outcomes', async () => {
    const child = completedChild('mixed challenge', {
      schemaVersion: 1,
      outcomes: [
        {
          target: { evidenceRef: 'finding:valid' },
          disposition: 'refuted',
          evidenceRefs: ['file:packages/agent/src/actors/controller.ts'],
        },
        {
          target: { evidenceRef: 'finding:invalid' },
          disposition: 'confirmed',
          evidenceRefs: ['unknown:unresolvable'],
        },
      ],
      assertedCoverage: ['must be cleared after invalid provenance'],
    });
    child.results[0]!.provider = 'fallback-provider';
    child.results[0]!.model = 'fallback-model';
    executeChildAgentsMock.mockResolvedValue(child);
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    const turn = await root.spawn({
      taskName: 'mixed-challenger',
      objective: 'Validate two targets.',
      metadata: {
        qualityStrategy: {
          schemaVersion: 1,
          stageId: 'challenge-mixed',
          pattern: 'adversarial-verification',
          role: 'challenger',
          targetEvidenceRefs: ['finding:valid', 'finding:invalid'],
          ownerTurnRef: { actorPath: '/root', turnId: 'root-turn-1' },
        },
      },
    });
    await settle();

    await vi.waitFor(() => expect(root.output(turn.actorPath, turn.turnId).structured).toEqual({
      schemaVersion: 1,
      outcomes: [{
        target: { evidenceRef: 'finding:valid' },
        disposition: 'refuted',
        evidenceRefs: ['file:packages/agent/src/actors/controller.ts'],
      }],
      assertedCoverage: [],
    }));
    expect(root.get(turn.actorPath).turns[0]?.metadata).toMatchObject({
      effectiveProvider: 'fallback-provider',
      effectiveModel: 'fallback-model',
      qualityStrategyDegradedReasons: ['invalid_disposition_evidence'],
    });
  });

  it('accepts a root-validated sibling target delivered to the executing challenger', async () => {
    executeChildAgentsMock.mockResolvedValueOnce(completedChild('candidate result'));
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);
    ctx.actorControl = root;

    const candidate = await root.spawn({
      taskName: 'candidate',
      objective: 'Produce a sibling candidate.',
    });
    await settle();
    const targetRef = `agent-turn:${candidate.actorPath}#turn=${candidate.turnId}`;
    executeChildAgentsMock.mockResolvedValueOnce(completedChild('challenge result', {
      schemaVersion: 1,
      outcomes: [{
        target: {
          actorPath: candidate.actorPath,
          turnId: candidate.turnId,
        },
        disposition: 'confirmed',
        evidenceRefs: [],
      }],
      assertedCoverage: ['sibling output'],
    }));

    const challenger = await root.spawn({
      taskName: 'challenger',
      objective: 'Challenge the sibling candidate.',
      metadata: {
        qualityStrategy: {
          schemaVersion: 1,
          stageId: 'challenge-sibling',
          pattern: 'adversarial-verification',
          role: 'challenger',
          laneRelation: 'opposition',
          targetEvidenceRefs: [targetRef],
          ownerTurnRef: { actorPath: '/root', turnId: 'root-turn-1' },
        },
      },
    });
    await settle();

    expect(root.output(challenger.actorPath, challenger.turnId).structured).toEqual({
      schemaVersion: 1,
      outcomes: [{
        target: {
          actorPath: candidate.actorPath,
          turnId: candidate.turnId,
        },
        disposition: 'confirmed',
        evidenceRefs: [],
      }],
      assertedCoverage: ['sibling output'],
    });
    expect(root.get(challenger.actorPath).turns[0]?.metadata)
      .not.toHaveProperty('qualityStrategyDegradedReasons');
  });

  it('accepts terminal support provenance from a visible same-parent Actor', async () => {
    executeChildAgentsMock.mockResolvedValueOnce(completedChild('sibling result'));
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);
    ctx.actorControl = root;

    const sibling = await root.spawn({
      taskName: 'sibling',
      objective: 'Produce root-visible evidence.',
    });
    await settle();
    const supportRef = `agent-turn:${sibling.actorPath}#turn=${sibling.turnId}`;
    executeChildAgentsMock.mockResolvedValueOnce(completedChild('challenge result', {
      schemaVersion: 1,
      outcomes: [{
        target: { evidenceRef: 'finding:declared' },
        disposition: 'confirmed',
        evidenceRefs: [supportRef],
      }],
      assertedCoverage: ['visible sibling support'],
    }));

    const challenger = await root.spawn({
      taskName: 'support-challenger',
      objective: 'Validate the declared finding.',
      metadata: {
        qualityStrategy: {
          schemaVersion: 1,
          stageId: 'challenge-support',
          pattern: 'adversarial-verification',
          role: 'challenger',
          laneRelation: 'opposition',
          targetEvidenceRefs: ['finding:declared'],
          ownerTurnRef: { actorPath: '/root', turnId: 'root-turn-1' },
        },
      },
    });
    await settle();

    expect(root.output(challenger.actorPath, challenger.turnId).structured).toEqual({
      schemaVersion: 1,
      outcomes: [{
        target: { evidenceRef: 'finding:declared' },
        disposition: 'confirmed',
        evidenceRefs: [supportRef],
      }],
      assertedCoverage: ['visible sibling support'],
    });
    expect(root.get(challenger.actorPath).turns[0]?.metadata)
      .not.toHaveProperty('qualityStrategyDegradedReasons');
  });

  it.each([
    { name: 'session-scoped', sessionId: 'session-1' },
    { name: 'local unscoped', sessionId: undefined },
  ])('projects root child completion into the $name task-notification queue', async ({ sessionId }) => {
    executeChildAgentsMock.mockResolvedValue(completedChild('review complete'));
    const session = new CodingActorSession({ sessionId });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    const turn = await root.spawn({ taskName: 'review', objective: 'Review the patch.' });
    await settle();

    expect(getMessageQueue().peek({
      agentId: actorQueueId(sessionId, '/root'),
      maxPriority: 'background',
      mode: 'task-notification',
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: expect.stringContaining(`<agent-completed`),
        taskResult: expect.objectContaining({
          source: 'child_task',
          taskId: turn.turnId,
          status: 'completed',
          summary: 'review complete',
        }),
      }),
    ]));
  });

  it('restores an unacknowledged root completion into a fresh process queue', async () => {
    let snapshot: AgentActorSnapshot | undefined;
    const store = {
      async load() { return snapshot; },
      async save(next: AgentActorSnapshot) { snapshot = next; },
    };
    executeChildAgentsMock.mockResolvedValue(completedChild('restored result'));
    const first = new CodingActorSession({ sessionId: 'session-1', store });
    await first.initialize();
    const { ctx, options } = environment();
    const root = first.attach(ctx, options);
    const turn = await root.spawn({ taskName: 'restore', objective: 'Survive restart.' });
    await settle();

    const rebuiltInProcess = new CodingActorSession({ sessionId: 'session-1', store });
    await rebuiltInProcess.initialize();
    expect(getMessageQueue().count({
      agentId: actorQueueId('session-1', '/root'),
      maxPriority: 'background',
      mode: 'task-notification',
      predicate: (message) => message.taskResult?.taskId === turn.turnId,
    })).toBe(1);

    _resetMessageQueueForTests();

    const restored = new CodingActorSession({ sessionId: 'session-1', store });
    await restored.initialize();

    expect(getMessageQueue().peek({
      agentId: actorQueueId('session-1', '/root'),
      maxPriority: 'background',
      mode: 'task-notification',
    })).toEqual([
      expect.objectContaining({
        taskResult: expect.objectContaining({
          taskId: turn.turnId,
          status: 'completed',
          summary: 'restored result',
        }),
      }),
    ]);
  });

  it('projects nested child completion with task-result identity into the parent queue', async () => {
    let nestedTurnId: string | undefined;
    executeChildAgentsMock
      .mockImplementationOnce(async (_bundles, _ctx, childOptions) => {
        const actorControl = childOptions.actorControl;
        if (!actorControl) throw new Error('Expected Actor control for native child execution.');
        const nested = await actorControl.spawn({
          taskName: 'nested',
          objective: 'Inspect the nested path.',
        });
        nestedTurnId = nested.turnId;
        await vi.waitFor(() => {
          expect(actorControl.output(nested.actorPath, nested.turnId).state).toBe('completed');
        });
        await vi.waitFor(() => {
          expect(getMessageQueue().peek({
            agentId: actorQueueId('session-1', actorControl.callerPath),
            maxPriority: 'background',
            mode: 'task-notification',
          })).toEqual(expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining(`turn_id="${nested.turnId}"`),
              taskResult: expect.objectContaining({
                source: 'child_task',
                taskId: nested.turnId,
                status: 'completed',
                summary: 'nested complete',
              }),
            }),
          ]));
        });
        return completedChild('parent complete');
      })
      .mockResolvedValueOnce(completedChild('nested complete'));
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    const parent = await root.spawn({ taskName: 'parent', objective: 'Inspect.' });
    await vi.waitFor(() => expect(root.output(parent.actorPath, parent.turnId).state).toBe('completed'));

    expect(nestedTurnId).toBeTypeOf('string');
  });

  it('projects prior turns and dormant mailbox messages into the next native turn', async () => {
    executeChildAgentsMock
      .mockResolvedValueOnce(completedChild('first result'))
      .mockResolvedValueOnce(completedChild('second result'));
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    await root.spawn({ taskName: 'worker', objective: 'First objective.', forkTurns: 'all' });
    await settle();
    await root.send('/root/worker', 'New durable evidence.');
    await root.followup('/root/worker', 'Second objective.');
    await settle();

    const secondOptions = executeChildAgentsMock.mock.calls[1]?.[2];
    expect(secondOptions?.initialMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('First objective.') }),
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('first result') }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('New durable evidence.') }),
    ]));
  });

  it('projects live native mailbox messages into the addressed runner queue', async () => {
    let release: ((value: KodaXChildExecutionResult) => void) | undefined;
    executeChildAgentsMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);
    await root.spawn({ taskName: 'worker', objective: 'Wait for evidence.' });
    await vi.waitFor(() => expect(executeChildAgentsMock).toHaveBeenCalledOnce());

    await root.send('/root/worker', 'Live evidence.');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(getMessageQueue().peek({
      agentId: actorQueueId('session-1', '/root/worker'),
      maxPriority: 'background',
      mode: 'agent-message',
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: expect.stringMatching(/<agent-message id="msg_[^"]+"[^>]*>\nLive evidence\./u),
      }),
    ]));
    release?.(completedChild('done'));
    await settle();
  });

  it('projects native child progress into the Runtime-owned bounded turn view', async () => {
    executeChildAgentsMock.mockImplementation(async (_bundles, _ctx, childOptions) => {
      childOptions.onProgress?.('Reading packages/agent/src/actors/controller.ts');
      childOptions.onProgress?.('Running focused tests');
      return completedChild('done');
    });
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const reportToolProgress = vi.fn();
    ctx.reportToolProgress = reportToolProgress;
    const root = session.attach(ctx, options);

    const turn = await root.spawn({ taskName: 'worker', objective: 'Inspect.' });
    await vi.waitFor(() => {
      expect(root.output(turn.actorPath, turn.turnId).state).toBe('completed');
    });

    expect(root.output(turn.actorPath, turn.turnId).progress).toEqual([
      expect.objectContaining({ kind: 'status', summary: 'Reading packages/agent/src/actors/controller.ts' }),
      expect.objectContaining({ kind: 'status', summary: 'Running focused tests' }),
    ]);
    expect(root.list().actors.find((actor) => actor.path === turn.actorPath)?.latestTurn)
      .toMatchObject({ summary: 'done' });
    expect(reportToolProgress).toHaveBeenNthCalledWith(
      1,
      '[agent /root/worker] Reading packages/agent/src/actors/controller.ts',
    );
    expect(reportToolProgress).toHaveBeenNthCalledWith(
      2,
      '[agent /root/worker] Running focused tests',
    );
  });

  it('does not spend the terminal persistence deadline waiting behind durable progress', async () => {
    vi.useFakeTimers();
    let releaseFirstProgressSave: (() => void) | undefined;
    let markFirstProgressSaveStarted: (() => void) | undefined;
    const firstProgressSaveStarted = new Promise<void>((resolve) => {
      markFirstProgressSaveStarted = resolve;
    });
    const firstProgressSave = new Promise<void>((resolve) => {
      releaseFirstProgressSave = resolve;
    });
    let progressSaveCount = 0;
    let saved: AgentActorSnapshot | undefined;
    const session = new CodingActorSession({
      sessionId: 'session-1',
      owner: {
        ownerId: 'progress-owner',
        runtimeId: 'progress-runtime',
        pid: 101,
        startedAt: '2026-08-06T00:00:00.000Z',
      },
      isOwnerAlive: async () => true,
      store: {
        async load() {
          return saved === undefined ? undefined : structuredClone(saved);
        },
        async save(snapshot) {
          const worker = snapshot.turns.find((turn) => turn.actorPath === '/root/worker');
          if (worker?.state === 'running' && (worker.progress?.length ?? 0) > 0) {
            progressSaveCount += 1;
            if (progressSaveCount === 1) {
              markFirstProgressSaveStarted?.();
              await firstProgressSave;
            }
          }
          saved = structuredClone(snapshot);
        },
      },
    });
    executeChildAgentsMock.mockImplementation(async (_bundles, _ctx, childOptions) => {
      for (let index = 1; index <= 20; index += 1) {
        childOptions.onProgress?.(`Progress ${index}`);
      }
      return completedChild('done');
    });
    const { ctx, options } = environment();
    await session.initialize();
    const root = session.attach(ctx, options);

    try {
      const turn = await root.spawn({ taskName: 'worker', objective: 'Emit progress quickly.' });
      await firstProgressSaveStarted;
      await vi.advanceTimersByTimeAsync(6_000);

      expect(session.health()).toMatchObject({
        state: 'recovering',
      });

      releaseFirstProgressSave?.();
      await vi.runAllTimersAsync();
      await vi.waitFor(() => {
        expect(root.output(turn.actorPath, turn.turnId)).toMatchObject({
          state: 'completed',
          output: 'done',
        });
      });
      expect(progressSaveCount).toBe(1);
      expect(session.health()).toEqual({ state: 'healthy' });
    } finally {
      releaseFirstProgressSave?.();
      vi.useRealTimers();
    }
  });

  it('fails closed when a durable progress predecessor never releases the settlement queue', async () => {
    vi.useFakeTimers();
    let releaseProgressSave: (() => void) | undefined;
    let markProgressSaveStarted: (() => void) | undefined;
    const progressSaveStarted = new Promise<void>((resolve) => {
      markProgressSaveStarted = resolve;
    });
    const progressSave = new Promise<void>((resolve) => {
      releaseProgressSave = resolve;
    });
    const session = new CodingActorSession({
      sessionId: 'session-1',
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
    });
    executeChildAgentsMock.mockImplementation(async (_bundles, _ctx, childOptions) => {
      childOptions.onProgress?.('Started');
      return completedChild('done');
    });
    const { ctx, options } = environment();
    await session.initialize();
    const root = session.attach(ctx, options);

    try {
      const turn = await root.spawn({ taskName: 'worker', objective: 'Block progress storage.' });
      await progressSaveStarted;
      await vi.advanceTimersByTimeAsync(30_001);

      expect(session.health()).toMatchObject({
        state: 'unknown',
        code: 'actor_settlement_not_persisted',
        turnId: turn.turnId,
      });
    } finally {
      releaseProgressSave?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('projects deduplicated external progress into the same Runtime turn view', async () => {
    const tasks = {
      start: vi.fn(async () => externalTask('working', { message: 'Connecting' })),
      get: vi.fn()
        .mockResolvedValueOnce(externalTask('working', { message: 'Connecting' }))
        .mockResolvedValueOnce(externalTask('working', { percent: 60 }))
        .mockResolvedValueOnce(externalTask('completed', { message: 'Finalizing' })),
      sendInput: vi.fn(async () => externalTask('working', { percent: 60 })),
      cancel: vi.fn(async () => externalTask('canceled')),
    };
    const binding = {
      context: { actorId: 'root-actor' },
      plane: { tasks } as unknown as AgentExecutorPlaneBinding['plane'],
    } satisfies AgentExecutorPlaneBinding;
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const onToolProgress = vi.fn();
    const onChildActivityEnd = vi.fn();
    ctx.agentExecutorPlane = binding;
    ctx.parentEvents = { onToolProgress, onChildActivityEnd };
    const root = session.attach(ctx, options);

    const turn = await root.spawn({
      taskName: 'reviewer',
      objective: 'Review.',
      kind: 'external',
      metadata: { agentId: 'external:reviewer' },
    });
    await vi.waitFor(() => expect(root.output(turn.actorPath, turn.turnId).state).toBe('completed'));

    expect(root.output(turn.actorPath, turn.turnId).progress).toEqual([
      expect.objectContaining({ summary: 'Connecting' }),
      expect.objectContaining({ summary: '60% complete' }),
      expect.objectContaining({ summary: 'Finalizing' }),
    ]);
    expect(onToolProgress).toHaveBeenCalledTimes(3);
    expect(onToolProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Finalizing' }),
      expect.objectContaining({
        childAgentId: '/root/reviewer',
        childAgentName: 'reviewer',
        liveOnly: true,
      }),
    );
    expect(onChildActivityEnd).toHaveBeenCalledOnce();
  });

  it('submits external cancellation even while start admission remains pending', async () => {
    const tasks = {
      start: vi.fn(() => new Promise<AgentTaskSnapshot>(() => undefined)),
      get: vi.fn(async () => externalTask('working')),
      sendInput: vi.fn(async () => externalTask('working')),
      cancel: vi.fn(async () => externalTask('canceled')),
    };
    const binding = {
      context: { actorId: 'root-actor' },
      plane: { tasks } as unknown as AgentExecutorPlaneBinding['plane'],
    } satisfies AgentExecutorPlaneBinding;
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    ctx.agentExecutorPlane = binding;
    const root = session.attach(ctx, options);
    const turn = await root.spawn({
      taskName: 'reviewer',
      objective: 'Review.',
      kind: 'external',
      metadata: { agentId: 'external:reviewer' },
    });
    await vi.waitFor(() => expect(tasks.start).toHaveBeenCalledOnce());

    await root.interrupt(turn.actorPath, 'stop requested');
    await vi.waitFor(() => expect(tasks.cancel).toHaveBeenCalledOnce());

    expect(tasks.cancel).toHaveBeenCalledWith(
      expect.any(String),
      'stop requested',
    );
    expect(tasks.get).not.toHaveBeenCalled();
    expect(root.output(turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted',
      error: 'stop requested',
    });
  });

  it('settles an interrupted external turn when pending start becomes cancellation unknown', async () => {
    let enterStart: (() => void) | undefined;
    const startEntered = new Promise<void>((resolve) => { enterStart = resolve; });
    let observedSignal: AbortSignal | undefined;
    const unknownTask = {
      ...externalTask('unknown'),
      cancellation: 'unknown' as const,
      cancellationError: 'remote start cancellation outcome is unknown',
    };
    const tasks = {
      start: vi.fn((_input: unknown, signal?: AbortSignal) => {
        observedSignal = signal;
        enterStart?.();
        return new Promise<AgentTaskSnapshot>((resolve) => {
          const finish = (): void => resolve(unknownTask);
          if (signal?.aborted) finish();
          else signal?.addEventListener('abort', finish, { once: true });
        });
      }),
      get: vi.fn(async () => unknownTask),
      sendInput: vi.fn(async () => externalTask('working')),
      cancel: vi.fn(async () => ({
        ...externalTask('submitted'),
        cancellation: 'requested' as const,
      })),
    };
    const binding = {
      context: { actorId: 'root-actor' },
      plane: { tasks } as unknown as AgentExecutorPlaneBinding['plane'],
    } satisfies AgentExecutorPlaneBinding;
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const onChildActivityEnd = vi.fn();
    ctx.agentExecutorPlane = binding;
    ctx.parentEvents = { onChildActivityEnd };
    const root = session.attach(ctx, options);
    const turn = await root.spawn({
      taskName: 'reviewer',
      objective: 'Review.',
      kind: 'external',
      metadata: { agentId: 'external:reviewer' },
    });
    await startEntered;

    await root.interrupt(turn.actorPath, 'stop requested');
    await vi.waitFor(() => expect(onChildActivityEnd).toHaveBeenCalledOnce());

    expect(observedSignal?.aborted).toBe(true);
    expect(tasks.get.mock.calls.length).toBeLessThanOrEqual(1);
    expect(root.output(turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted',
      error: 'stop requested',
    });
  });

  it('retries an early external cancellation after start admission becomes visible', async () => {
    let finishStart: ((task: AgentTaskSnapshot) => void) | undefined;
    const tasks = {
      start: vi.fn(() => new Promise<AgentTaskSnapshot>((resolve) => {
        finishStart = resolve;
      })),
      get: vi.fn(async () => externalTask('working')),
      sendInput: vi.fn(async () => externalTask('working')),
      cancel: vi.fn()
        .mockRejectedValueOnce(new Error('task is not admitted yet'))
        .mockResolvedValueOnce(externalTask('canceled')),
    };
    const binding = {
      context: { actorId: 'root-actor' },
      plane: { tasks } as unknown as AgentExecutorPlaneBinding['plane'],
    } satisfies AgentExecutorPlaneBinding;
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    ctx.agentExecutorPlane = binding;
    const root = session.attach(ctx, options);
    const turn = await root.spawn({
      taskName: 'reviewer',
      objective: 'Review.',
      kind: 'external',
      metadata: { agentId: 'external:reviewer' },
    });
    await vi.waitFor(() => expect(tasks.start).toHaveBeenCalledOnce());

    await root.interrupt(turn.actorPath, 'stop requested');
    await vi.waitFor(() => expect(tasks.cancel).toHaveBeenCalledTimes(1));
    finishStart?.(externalTask('working'));
    await vi.waitFor(() => expect(tasks.cancel).toHaveBeenCalledTimes(2));

    expect(tasks.get).not.toHaveBeenCalled();
    expect(root.output(turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted',
      error: 'stop requested',
    });
  });

  it('cancels an external task when interruption happens during start admission', async () => {
    let finishStart: ((task: AgentTaskSnapshot) => void) | undefined;
    const tasks = {
      start: vi.fn(() => new Promise<AgentTaskSnapshot>((resolve) => {
        finishStart = resolve;
      })),
      get: vi.fn(async () => externalTask('working')),
      sendInput: vi.fn(async () => externalTask('working')),
      cancel: vi.fn(async () => externalTask('canceled')),
    };
    const binding = {
      context: { actorId: 'root-actor' },
      plane: { tasks } as unknown as AgentExecutorPlaneBinding['plane'],
    } satisfies AgentExecutorPlaneBinding;
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    ctx.agentExecutorPlane = binding;
    const root = session.attach(ctx, options);
    const turn = await root.spawn({
      taskName: 'reviewer',
      objective: 'Review.',
      kind: 'external',
      metadata: { agentId: 'external:reviewer' },
    });
    await vi.waitFor(() => expect(tasks.start).toHaveBeenCalledOnce());

    await root.interrupt(turn.actorPath, 'stop requested');
    finishStart?.(externalTask('working'));
    await vi.waitFor(() => expect(tasks.cancel).toHaveBeenCalledOnce());

    expect(tasks.cancel).toHaveBeenCalledWith(
      expect.any(String),
      'stop requested',
    );
    expect(tasks.get).not.toHaveBeenCalled();
    expect(root.output(turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted',
      error: 'stop requested',
    });
  });

  it('does not forward queued mailbox input after external cancellation is requested', async () => {
    let finishStart: ((task: AgentTaskSnapshot) => void) | undefined;
    const tasks = {
      start: vi.fn(() => new Promise<AgentTaskSnapshot>((resolve) => {
        finishStart = resolve;
      })),
      get: vi.fn(async () => externalTask('canceled')),
      sendInput: vi.fn(async () => externalTask('working')),
      cancel: vi.fn(async () => ({
        ...externalTask('working'),
        cancellation: 'requested' as const,
      })),
    };
    const binding = {
      context: { actorId: 'root-actor' },
      plane: { tasks } as unknown as AgentExecutorPlaneBinding['plane'],
    } satisfies AgentExecutorPlaneBinding;
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    ctx.agentExecutorPlane = binding;
    const root = session.attach(ctx, options);
    const turn = await root.spawn({
      taskName: 'reviewer',
      objective: 'Review.',
      kind: 'external',
      metadata: { agentId: 'external:reviewer' },
    });
    await vi.waitFor(() => expect(tasks.start).toHaveBeenCalledOnce());
    await root.send(turn.actorPath, 'queued before interruption');

    await root.interrupt(turn.actorPath, 'stop requested');
    finishStart?.(externalTask('working'));
    await vi.waitFor(() => expect(tasks.get).toHaveBeenCalledOnce());

    expect(tasks.cancel).toHaveBeenCalledOnce();
    expect(tasks.sendInput).not.toHaveBeenCalled();
    expect(root.output(turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted',
      error: 'stop requested',
    });
  });

  it('attempts cancellation when an interrupted external start has an ambiguous failure', async () => {
    let rejectStart: ((error: Error) => void) | undefined;
    const tasks = {
      start: vi.fn(() => new Promise<AgentTaskSnapshot>((_resolve, reject) => {
        rejectStart = reject;
      })),
      get: vi.fn(async () => externalTask('working')),
      sendInput: vi.fn(async () => externalTask('working')),
      cancel: vi.fn(async () => externalTask('canceled')),
    };
    const binding = {
      context: { actorId: 'root-actor' },
      plane: { tasks } as unknown as AgentExecutorPlaneBinding['plane'],
    } satisfies AgentExecutorPlaneBinding;
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    ctx.agentExecutorPlane = binding;
    const root = session.attach(ctx, options);
    const turn = await root.spawn({
      taskName: 'reviewer',
      objective: 'Review.',
      kind: 'external',
      metadata: { agentId: 'external:reviewer' },
    });
    await vi.waitFor(() => expect(tasks.start).toHaveBeenCalledOnce());

    await root.interrupt(turn.actorPath, 'stop requested');
    rejectStart?.(new Error('start response was lost'));
    await vi.waitFor(() => expect(tasks.cancel).toHaveBeenCalledOnce());

    expect(tasks.cancel).toHaveBeenCalledWith(
      expect.any(String),
      'stop requested',
    );
    expect(tasks.get).not.toHaveBeenCalled();
    expect(root.output(turn.actorPath, turn.turnId)).toMatchObject({
      state: 'interrupted',
      error: 'stop requested',
    });
  });

  it('preserves structured external artifact metadata through agent_output', async () => {
    const tasks = {
      start: vi.fn(async () => externalTask('completed', undefined, [{
        name: 'report.pdf',
        uri: 'https://remote.example/report.pdf',
        mimeType: 'application/pdf',
        size: 42,
        hash: 'sha256:report',
        provenance: 'external:fixture',
        producingAgentId: 'external:reviewer',
        remoteTaskId: 'remote-1',
      }])),
      get: vi.fn(),
      sendInput: vi.fn(),
      cancel: vi.fn(),
    };
    const binding = {
      context: { actorId: 'root-actor' },
      plane: { tasks } as unknown as AgentExecutorPlaneBinding['plane'],
    } satisfies AgentExecutorPlaneBinding;
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    ctx.agentExecutorPlane = binding;
    const root = session.attach(ctx, options);

    const turn = await root.spawn({
      taskName: 'reviewer',
      objective: 'Review.',
      kind: 'external',
      metadata: { agentId: 'external:reviewer' },
    });
    await vi.waitFor(() => expect(root.output(turn.actorPath, turn.turnId).state).toBe('completed'));
    const output = root.output(turn.actorPath, turn.turnId) as unknown as {
      readonly artifactDetails?: readonly Record<string, unknown>[];
    };

    expect(output.artifactDetails).toEqual([{
      name: 'report.pdf',
      uri: 'https://remote.example/report.pdf',
      mimeType: 'application/pdf',
      size: 42,
      hash: 'sha256:report',
      provenance: 'external:fixture',
      producingAgentId: 'external:reviewer',
      remoteTaskId: 'remote-1',
    }]);
  });

  it('exposes permanent subtree close only through the trusted Actor host', async () => {
    const executor: AgentTurnExecutor = {
      execute: () => new Promise<AgentExecutionResult>(() => undefined),
    };
    const session = new CodingActorSession({ executor, sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);
    await root.spawn({ taskName: 'parent', objective: 'Parent.' });
    await session.bindActor('/root/parent').spawn({ taskName: 'child', objective: 'Child.' });
    const trustedHost: KodaXActorHost = session;

    expect('close' in root).toBe(false);
    await trustedHost.closeActor('/root/parent', 'session owner retired branch');

    expect(root.get('/root/parent').actor.state).toBe('closed');
    expect(root.get('/root/parent/child').actor.state).toBe('closed');
  });

  it('derives write authority from Actor capabilities instead of mutable metadata', async () => {
    executeChildAgentsMock.mockResolvedValue(completedChild('done'));
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, options);

    await root.spawn({
      taskName: 'worker',
      objective: 'Do not write.',
      capabilities: { filesystem: 'read' },
      metadata: { readOnly: false },
    });
    await settle();

    expect(executeChildAgentsMock.mock.calls[0]?.[0][0]).toMatchObject({ readOnly: true });
  });

  it('admits Actor turns against the shared managed-run budget', async () => {
    const session = new CodingActorSession({ sessionId: 'session-1' });
    const { ctx, options } = environment();
    const root = session.attach(ctx, {
      ...options,
      context: {
        managedWorkBudget: {
          totalBudget: 1,
          spentBudget: 1,
          currentHarness: 'H0_DIRECT',
        },
      },
    });

    await expect(root.spawn({ taskName: 'worker', objective: 'Over budget.' }))
      .rejects.toMatchObject({ code: 'agent_budget_exhausted' });
    expect(root.list().actors.some((actor) => actor.path === '/root/worker')).toBe(false);
  });
});
