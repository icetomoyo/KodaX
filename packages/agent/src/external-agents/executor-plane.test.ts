import { describe, expect, it } from 'vitest';

import {
  AgentCancellationUncertainError,
  ExternalAgentRegistrationConflictError,
  AgentStartUncertainError,
  createAgentExecutorPlane,
  createMemoryAgentExecutorPlaneStore,
} from './executor-plane.js';
import type {
  AgentDispatchPolicy,
  AgentExecutor,
  AgentExecutorEvent,
  AgentExecutorFactory,
  AgentExecutorFactoryContext,
  AgentExecutorPlaneStore,
  AgentExecutorTaskReference,
  AgentExecutorTaskSnapshot,
  AgentTaskSnapshot,
  AgentTaskStartInput,
  ExternalAgentRegistration,
} from './types.js';

const CAPABILITIES = {
  streaming: 'supported',
  durableTasks: 'supported',
  inputRequired: 'supported',
  cancellation: 'supported',
  artifacts: 'supported',
} as const;

const EFFECTS = {
  remote: 'read',
  workspace: 'proposal',
} as const;

function registration(
  patch: Partial<ExternalAgentRegistration> = {},
): ExternalAgentRegistration {
  return {
    agentId: 'external:risk-reviewer',
    displayName: 'Risk Reviewer',
    description: 'Reviews customer risk.',
    enabled: true,
    executorId: 'fake-http',
    protocol: 'http',
    configurationRevision: 'rev-1',
    endpointIdentityHash: 'sha256:endpoint-a',
    credentialRef: 'credential:risk',
    skills: ['risk-review'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    capabilities: CAPABILITIES,
    effects: EFFECTS,
    health: { status: 'healthy', checkedAt: '2026-07-10T00:00:00.000Z' },
    ...patch,
  };
}

function taskInput(
  patch: Partial<AgentTaskStartInput> = {},
): AgentTaskStartInput {
  return {
    agentId: 'external:risk-reviewer',
    objective: 'Assess account risk',
    context: { actorId: 'actor-1', projectId: 'project-1', parentTaskId: 'parent-1' },
    readOnly: true,
    ...patch,
  };
}

function allowAllPolicy(): AgentDispatchPolicy {
  return async () => ({ allowed: true });
}

class FakeExecutor implements AgentExecutor {
  readonly starts: AgentTaskStartInput[] = [];
  readonly sent: string[] = [];
  snapshot: AgentExecutorTaskSnapshot = {
    state: 'working',
    progress: { message: 'started', percent: 10 },
  };
  startReference: AgentExecutorTaskReference | undefined;
  cancelSnapshot: AgentExecutorTaskSnapshot | undefined;
  startError: Error | undefined;
  cancelError: Error | undefined;
  startEntered: ((input: AgentTaskStartInput) => void) | undefined;
  startGate: ((input: AgentTaskStartInput) => Promise<void>) | undefined;
  preflightGate: (() => Promise<void>) | undefined;
  preflightMutation: ((input: AgentTaskStartInput) => void) | undefined;
  eventGate: (() => Promise<void>) | undefined;
  eventExitEntered: (() => void) | undefined;
  eventExitGate: (() => Promise<void>) | undefined;
  readonly emittedEvents: AgentExecutorEvent[] = [];
  sendInputEntered: (() => void) | undefined;
  sendInputGate: (() => Promise<void>) | undefined;
  cancelCalls = 0;
  disposeCalls = 0;
  disposeError: Error | undefined;
  disposeEntered: (() => void) | undefined;
  disposeGate: (() => Promise<void>) | undefined;

  async preflight(input: AgentTaskStartInput): Promise<{ readonly ok: true }> {
    await this.preflightGate?.();
    this.preflightMutation?.(input);
    return { ok: true };
  }

  async start(input: AgentTaskStartInput): Promise<AgentExecutorTaskReference> {
    this.starts.push(input);
    this.startEntered?.(input);
    await this.startGate?.(input);
    if (this.startError) throw this.startError;
    return this.startReference
      ?? { idempotencyKey: input.idempotencyKey!, remoteTaskId: 'remote-1' };
  }

  async *events(): AsyncIterable<AgentExecutorEvent> {
    try {
      await this.eventGate?.();
      for (const event of this.emittedEvents) yield event;
    } finally {
      this.eventExitEntered?.();
      await this.eventExitGate?.();
    }
  }

  async get(): Promise<AgentExecutorTaskSnapshot> {
    return this.snapshot;
  }

  async sendInput(_reference: AgentExecutorTaskReference, input: { readonly content: string }): Promise<void> {
    this.sent.push(input.content);
    this.sendInputEntered?.();
    await this.sendInputGate?.();
  }

  async cancel(): Promise<AgentExecutorTaskSnapshot> {
    this.cancelCalls += 1;
    if (this.cancelError) throw this.cancelError;
    return this.cancelSnapshot ?? this.snapshot;
  }

  async reconcile(): Promise<AgentExecutorTaskSnapshot> {
    return this.snapshot;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.disposeEntered?.();
    await this.disposeGate?.();
    if (this.disposeError) throw this.disposeError;
  }
}

function factory(executor: FakeExecutor): AgentExecutorFactory {
  return {
    executorId: 'fake-http',
    protocol: 'http',
    async create(
      _registration: ExternalAgentRegistration,
      _context: AgentExecutorFactoryContext,
    ) {
      return executor;
    },
  };
}

describe('FEATURE_258 AgentExecutorPlane', () => {
  it('registers, filters, dispatches and freezes the selected registration revision', async () => {
    const executor = new FakeExecutor();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      credentialBroker: {
        async withCredential(_ref, use) {
          return use('credential-secret');
        },
      },
      store: createMemoryAgentExecutorPlaneStore(),
      createTaskId: () => 'agent-task-1',
      createIdempotencyKey: () => 'idem-1',
    });

    await plane.registrations.upsert(registration({
      health: {
        status: 'healthy',
        checkedAt: '2026-07-10T00:00:00.000Z',
        diagnostic: 'TOP-SECRET',
      },
    }));
    const listed = await plane.listDispatchable({
      actorId: 'actor-1',
      projectId: 'project-1',
      requiredSkills: ['risk-review'],
      requiredCapabilities: { cancellation: true },
      readOnly: true,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.descriptor.agentId).toBe('external:risk-reviewer');
    expect(JSON.stringify(listed)).not.toContain('credential-secret');

    const started = await plane.tasks.start(taskInput());
    expect(started.taskId).toBe('agent-task-1');
    expect(started.parentTaskId).toBe('parent-1');
    expect(started.registration.configurationRevision).toBe('rev-1');
    expect(started.remoteTaskId).toBe('remote-1');

    await plane.registrations.upsert(registration({ configurationRevision: 'rev-2' }));
    expect((await plane.tasks.get('agent-task-1')).registration.configurationRevision).toBe('rev-1');
    await expect(plane.tasks.sendInput('agent-task-1', { content: 'continue' }))
      .resolves.toMatchObject({ state: 'working' });
    await plane.registrations.upsert(registration({ configurationRevision: 'rev-2', enabled: false }));
    await expect(plane.tasks.start(taskInput({ taskId: 'disabled-new-task' })))
      .rejects.toThrow(/disabled/i);
    await expect(plane.tasks.sendInput('agent-task-1', { content: 'finish existing' }))
      .resolves.toMatchObject({ state: 'working' });
    expect(executor.sent).toEqual(['continue', 'finish existing']);
    expect(executor.starts).toHaveLength(1);
    expect(executor.starts[0]?.idempotencyKey).toBe('idem-1');
  });

  it('atomically changes only enabled while preserving the full durable registration', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const credentialBroker = {
      async withCredential<T>(_reference: string, use: (credential: string) => Promise<T>): Promise<T> {
        return use('credential-secret');
      },
    };
    const firstExecutor = new FakeExecutor();
    firstExecutor.snapshot = { state: 'input-required' };
    const strictFactory = (executor: FakeExecutor): AgentExecutorFactory => ({
      executorId: 'fake-http',
      protocol: 'http',
      async create(input) {
        if (input.credentialRef !== 'credential:risk'
          || input.executorConfig?.interfaceUrl !== 'https://agent.example/a2a') {
          throw new Error('Durable registration details are unavailable.');
        }
        return executor;
      },
    });
    const plane = await createAgentExecutorPlane({
      factories: [strictFactory(firstExecutor)],
      policy: allowAllPolicy(),
      credentialBroker,
      store,
    });
    const complete = registration({
      executorConfig: {
        agentCardUrl: 'https://agent.example/.well-known/agent-card.json',
        interfaceUrl: 'https://agent.example/a2a',
        authentication: { type: 'http-bearer', scheme: 'bearer' },
      },
    });
    await plane.registrations.upsert(complete);
    const task = await plane.tasks.start(taskInput({ taskId: 'durable-disable-task' }));
    await expect(plane.tasks.reconcile(task.taskId)).resolves.toMatchObject({
      state: 'input-required',
    });

    await expect(plane.registrations.setEnabled(complete.agentId, false)).resolves.toEqual(
      expect.objectContaining({ agentId: complete.agentId, enabled: false }),
    );
    expect(await store.loadRegistrations()).toEqual([{ ...complete, enabled: false }]);
    await plane.close();

    const recoveredExecutor = new FakeExecutor();
    recoveredExecutor.snapshot = { state: 'input-required' };
    const reopened = await createAgentExecutorPlane({
      factories: [strictFactory(recoveredExecutor)],
      policy: allowAllPolicy(),
      credentialBroker,
      store,
    });
    await expect(reopened.tasks.sendInput(task.taskId, { content: 'continue durable task' }))
      .resolves.toMatchObject({ state: 'working' });
    expect(recoveredExecutor.sent).toEqual(['continue durable task']);
    await reopened.close();
  });

  it('returns detached registration summaries that cannot mutate the live catalog', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const plane = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const listed = (await plane.registrations.list())[0]!;
    Object.assign(listed.capabilities, { cancellation: 'unsupported' as const });
    Object.assign(listed.effects, { remote: 'write' as const });

    await expect(plane.registrations.list()).resolves.toEqual([
      expect.objectContaining({
        capabilities: expect.objectContaining({ cancellation: 'supported' }),
        effects: expect.objectContaining({ remote: 'read' }),
      }),
    ]);
    await plane.registrations.setEnabled(listed.agentId, false);
    await expect(store.loadRegistrations()).resolves.toEqual([
      expect.objectContaining({
        capabilities: expect.objectContaining({ cancellation: 'supported' }),
        effects: expect.objectContaining({ remote: 'read' }),
      }),
    ]);
    await plane.close();
  });

  it('captures registration input before waiting for the serialized mutation', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const plane = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });
    const candidate = registration({
      credentialRef: undefined,
      executorConfig: { interfaceUrl: 'https://original.example/a2a' },
    });

    const pending = plane.registrations.upsert(candidate);
    Object.assign(candidate, {
      configurationRevision: 'caller-mutated-revision',
      endpointIdentityHash: 'sha256:caller-mutated-endpoint',
      executorConfig: { interfaceUrl: 'https://mutated.example/a2a' },
    });
    await pending;

    await expect(store.loadRegistrations()).resolves.toEqual([
      expect.objectContaining({
        configurationRevision: 'rev-1',
        endpointIdentityHash: 'sha256:endpoint-a',
        executorConfig: { interfaceUrl: 'https://original.example/a2a' },
      }),
    ]);
    await plane.close();
  });

  it('captures and JSON-validates task start input at the public boundary', async () => {
    let releasePolicy: (() => void) | undefined;
    let policyEntered: (() => void) | undefined;
    const policyGate = new Promise<void>((resolve) => { releasePolicy = resolve; });
    const entered = new Promise<void>((resolve) => { policyEntered = resolve; });
    const executor = new FakeExecutor();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: async () => {
        policyEntered?.();
        await policyGate;
        return { allowed: true };
      },
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({
      agentId: 'external:alpha',
      credentialRef: undefined,
    }));
    await plane.registrations.upsert(registration({
      agentId: 'external:beta',
      credentialRef: undefined,
    }));
    const input = taskInput({
      taskId: 'captured-start',
      agentId: 'external:alpha',
      context: { actorId: 'actor-1', projectId: 'original-project' },
    });

    const pending = plane.tasks.start(input);
    await entered;
    Object.assign(input, { taskId: 'caller-mutated-task', agentId: 'external:beta' });
    Object.assign(input.context, { projectId: 'caller-mutated-project' });
    releasePolicy?.();

    await expect(pending).resolves.toMatchObject({
      taskId: 'captured-start',
      agentId: 'external:alpha',
    });
    expect(executor.starts).toEqual([
      expect.objectContaining({
        taskId: 'captured-start',
        agentId: 'external:alpha',
        context: expect.objectContaining({ projectId: 'original-project' }),
      }),
    ]);

    const unsafe = taskInput({
      taskId: 'unsafe-start',
      agentId: 'external:alpha',
      context: {
        actorId: 'actor-1',
        dataClassifications: [new Date('2026-07-16T00:00:00.000Z') as unknown as string],
      },
    });
    await expect(plane.tasks.start(unsafe)).rejects.toThrow(/JSON-safe/i);
    expect(executor.starts).toHaveLength(1);
    await plane.close();
  });

  it('rejects non-JSON-safe executorConfig values before persistence', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const plane = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });
    const unsafeConfig = {
      createdAt: new Date('2026-07-16T00:00:00.000Z'),
    } as unknown as ExternalAgentRegistration['executorConfig'];

    await expect(plane.registrations.upsert(registration({
      credentialRef: undefined,
      executorConfig: unsafeConfig,
    }))).rejects.toThrow(/executorConfig.*JSON-safe/i);
    await expect(plane.registrations.upsert(registration({
      credentialRef: undefined,
      executorConfig: 'not-an-object' as unknown as ExternalAgentRegistration['executorConfig'],
    }))).rejects.toThrow(/executorConfig.*JSON-safe object/i);
    await expect(store.loadRegistrations()).resolves.toEqual([]);
    await plane.close();
  });

  it('does not expose the admitted input object to a mutating executor preflight', async () => {
    const executor = new FakeExecutor();
    executor.preflightMutation = (input) => {
      Object.assign(input, { taskId: 'executor-mutated-task', agentId: 'external:beta' });
      Object.assign(input.context, { projectId: 'executor-mutated-project' });
    };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({
      agentId: 'external:alpha',
      credentialRef: undefined,
    }));
    await plane.registrations.upsert(registration({
      agentId: 'external:beta',
      credentialRef: undefined,
    }));

    await expect(plane.tasks.start(taskInput({
      taskId: 'executor-preflight-captured',
      agentId: 'external:alpha',
      context: { actorId: 'actor-1', projectId: 'original-project' },
    }))).resolves.toMatchObject({
      taskId: 'executor-preflight-captured',
      agentId: 'external:alpha',
    });
    expect(executor.starts[0]).toMatchObject({
      taskId: 'executor-preflight-captured',
      agentId: 'external:alpha',
      context: expect.objectContaining({ projectId: 'original-project' }),
    });
    await plane.close();
  });

  it('recovers non-terminal tasks from an immutable full registration after update and removal', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const createdRegistrations: ExternalAgentRegistration[] = [];
    const executors: FakeExecutor[] = [];
    const snapshotFactory: AgentExecutorFactory = {
      executorId: 'fake-http',
      protocol: 'http',
      async create(input) {
        createdRegistrations.push(input);
        const executor = new FakeExecutor();
        executor.snapshot = { state: 'input-required' };
        executors.push(executor);
        return executor;
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [snapshotFactory],
      policy: allowAllPolicy(),
      credentialBroker: {
        async withCredential(_reference, use) { return use('credential-secret'); },
      },
      store,
    });
    const original = registration({
      credentialRef: 'credential:original',
      executorConfig: { interfaceUrl: 'https://original.example/a2a' },
    });
    await plane.registrations.upsert(original);
    const updatedTask = await plane.tasks.start(taskInput({ taskId: 'survives-update' }));
    const reconciledTask = await plane.tasks.start(taskInput({ taskId: 'reconciles-after-removal' }));
    const canceledTask = await plane.tasks.start(taskInput({ taskId: 'cancels-after-removal' }));
    await plane.registrations.upsert(registration({
      configurationRevision: 'rev-2',
      credentialRef: 'credential:replacement',
      executorConfig: { interfaceUrl: 'https://replacement.example/a2a' },
    }));
    await plane.registrations.remove(original.agentId, {
      expectedConfigurationRevision: 'rev-2',
    });
    await plane.close();

    createdRegistrations.length = 0;
    executors.length = 0;
    const reopened = await createAgentExecutorPlane({
      factories: [snapshotFactory],
      policy: allowAllPolicy(),
      credentialBroker: {
        async withCredential(_reference, use) { return use('credential-secret'); },
      },
      store,
    });
    await expect(reopened.tasks.sendInput(updatedTask.taskId, { content: 'after update' }))
      .resolves.toMatchObject({ state: 'working' });
    await expect(reopened.tasks.reconcile(reconciledTask.taskId))
      .resolves.toMatchObject({ state: 'input-required' });
    await expect(reopened.tasks.cancel(canceledTask.taskId, 'operator canceled'))
      .resolves.toMatchObject({ state: 'input-required', cancellation: 'requested' });
    expect(createdRegistrations).not.toHaveLength(0);
    expect(createdRegistrations.every((input) => (
      input.configurationRevision === 'rev-1'
      && input.credentialRef === 'credential:original'
      && input.executorConfig?.interfaceUrl === 'https://original.example/a2a'
    ))).toBe(true);
    expect(executors.flatMap((executor) => executor.sent)).toEqual(['after update']);
    await reopened.close();
  });

  it('rejects registration revision reuse while referenced and reclaims unreferenced terminal snapshots', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const executor = new FakeExecutor();
    executor.snapshot = { state: 'input-required' };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const task = await plane.tasks.start(taskInput({ taskId: 'snapshot-lifecycle' }));

    await expect(plane.registrations.upsert(registration({
      credentialRef: undefined,
      endpointIdentityHash: 'sha256:different-endpoint',
    }))).rejects.toThrow(/revision.*reused|immutable/i);

    executor.snapshot = { state: 'completed', output: 'done' };
    await expect(plane.tasks.reconcile(task.taskId)).resolves.toMatchObject({ state: 'completed' });
    const snapshotStore = store as typeof store & {
      loadTaskRegistrationSnapshots(): Promise<readonly ExternalAgentRegistration[]>;
    };
    await expect(snapshotStore.loadTaskRegistrationSnapshots()).resolves.toEqual([]);
    await plane.registrations.remove('external:risk-reviewer');
    await expect(plane.registrations.upsert(registration({
      credentialRef: undefined,
      endpointIdentityHash: 'sha256:reused-after-remove',
      executorConfig: { interfaceUrl: 'https://reused.example/a2a' },
    }))).rejects.toThrow(/revision.*reused/i);
    await plane.close();
  });

  it('bounds remembered registration revisions while retaining recent reuse protection', async () => {
    const plane = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    const historyLimit = 4_096;
    for (let index = 0; index <= historyLimit; index += 1) {
      await plane.registrations.upsert(registration({
        credentialRef: undefined,
        configurationRevision: `bounded-revision-${index}`,
        endpointIdentityHash: `sha256:endpoint-${index}`,
      }));
    }
    await plane.registrations.remove('external:risk-reviewer');

    await expect(plane.registrations.upsert(registration({
      credentialRef: undefined,
      configurationRevision: 'bounded-revision-0',
      endpointIdentityHash: 'sha256:reused-after-history-eviction',
    }))).resolves.toMatchObject({ configurationRevision: 'bounded-revision-0' });
    await expect(plane.registrations.upsert(registration({
      credentialRef: undefined,
      configurationRevision: `bounded-revision-${historyLimit}`,
      endpointIdentityHash: 'sha256:recent-revision-reused',
    }))).rejects.toThrow(/revision.*reused/i);
    await plane.close();
  });

  it('serializes concurrent cross-agent snapshot persistence without losing either revision', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const plane = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });
    const alpha = registration({
      agentId: 'external:alpha',
      credentialRef: undefined,
      configurationRevision: 'alpha-rev-1',
    });
    const beta = registration({
      agentId: 'external:beta',
      credentialRef: undefined,
      configurationRevision: 'beta-rev-1',
    });
    await plane.registrations.upsert(alpha);
    await plane.registrations.upsert(beta);

    await Promise.all([
      plane.tasks.start(taskInput({ taskId: 'alpha-task', agentId: alpha.agentId })),
      plane.tasks.start(taskInput({ taskId: 'beta-task', agentId: beta.agentId })),
    ]);

    const snapshots = await store.loadTaskRegistrationSnapshots?.();
    expect(snapshots?.map((entry) => [entry.agentId, entry.configurationRevision]).sort())
      .toEqual([
        ['external:alpha', 'alpha-rev-1'],
        ['external:beta', 'beta-rev-1'],
      ]);
    await plane.close();
  });

  it('admits a globally unique task ID only once across concurrent agents', async () => {
    const executor = new FakeExecutor();
    let arrivals = 0;
    let releasePreflights: (() => void) | undefined;
    const bothArrived = new Promise<void>((resolve) => { releasePreflights = resolve; });
    executor.preflightGate = async () => {
      arrivals += 1;
      if (arrivals === 2) releasePreflights?.();
      await bothArrived;
    };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    const alpha = registration({
      agentId: 'external:alpha',
      credentialRef: undefined,
      configurationRevision: 'alpha-rev-1',
    });
    const beta = registration({
      agentId: 'external:beta',
      credentialRef: undefined,
      configurationRevision: 'beta-rev-1',
    });
    await plane.registrations.upsert(alpha);
    await plane.registrations.upsert(beta);

    const results = await Promise.allSettled([
      plane.tasks.start(taskInput({ taskId: 'shared-task-id', agentId: alpha.agentId })),
      plane.tasks.start(taskInput({ taskId: 'shared-task-id', agentId: beta.agentId })),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(executor.starts).toHaveLength(1);
    await expect(plane.tasks.list()).resolves.toHaveLength(1);
    await plane.close();
  });

  it('fails closed when a custom store loads duplicate durable task IDs', async () => {
    const base = createMemoryAgentExecutorPlaneStore();
    const first = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store: base,
    });
    await first.registrations.upsert(registration({ credentialRef: undefined }));
    await first.tasks.start(taskInput({ taskId: 'duplicate-on-restart' }));
    await first.close();
    const persisted = await base.loadTasks();
    const duplicateStore: AgentExecutorPlaneStore = {
      ...base,
      async loadTasks() {
        return [...persisted, ...persisted];
      },
    };

    await expect(createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store: duplicateStore,
    })).rejects.toThrow(/duplicate.*task ID/i);
  });

  it('fails closed when a custom store loads duplicate durable registration IDs', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    await store.saveRegistrations([
      registration({ credentialRef: undefined }),
      registration({ credentialRef: undefined, configurationRevision: 'rev-2' }),
    ]);

    await expect(createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    })).rejects.toThrow(/duplicate.*registration ID/i);
  });

  it('uses an unambiguous executor cache key for delimiter-bearing identities', async () => {
    const created: string[] = [];
    const started: string[] = [];
    const collisionFactory: AgentExecutorFactory = {
      executorId: 'collision-http',
      protocol: 'http',
      async create(route) {
        created.push(route.agentId);
        return {
          async start(input) {
            started.push(route.agentId);
            return {
              idempotencyKey: input.idempotencyKey!,
              remoteTaskId: `remote:${route.agentId}`,
            };
          },
          async *events(): AsyncIterable<never> { return; },
          async get() { return { state: 'working' as const }; },
          async sendInput() {},
          async cancel() { return { state: 'working' as const }; },
          async reconcile() { return { state: 'working' as const }; },
          async dispose() {},
        };
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [collisionFactory],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    const alpha = registration({
      agentId: 'external:a',
      executorId: collisionFactory.executorId,
      configurationRevision: 'b\0external:c\0d',
      credentialRef: undefined,
    });
    const beta = registration({
      agentId: 'external:a\0b',
      executorId: collisionFactory.executorId,
      configurationRevision: 'external:c\0d',
      credentialRef: undefined,
    });
    await plane.registrations.upsert(alpha);
    await plane.registrations.upsert(beta);

    await plane.tasks.start(taskInput({ taskId: 'cache-key-alpha', agentId: alpha.agentId }));
    await plane.tasks.start(taskInput({ taskId: 'cache-key-beta', agentId: beta.agentId }));

    expect(created).toEqual([alpha.agentId, beta.agentId]);
    expect(started).toEqual([alpha.agentId, beta.agentId]);
    await plane.close();
  });

  it('coalesces concurrent executor creation for the same recovered route', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const initialExecutor = new FakeExecutor();
    const first = await createAgentExecutorPlane({
      factories: [factory(initialExecutor)],
      policy: allowAllPolicy(),
      store,
    });
    await first.registrations.upsert(registration({ credentialRef: undefined }));
    const task = await first.tasks.start(taskInput({ taskId: 'single-flight-route' }));
    await first.close();

    let createCalls = 0;
    let creationEntered: (() => void) | undefined;
    let releaseCreation: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { creationEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const recoveredExecutor = new FakeExecutor();
    const recoveringFactory: AgentExecutorFactory = {
      executorId: 'fake-http',
      protocol: 'http',
      async create() {
        createCalls += 1;
        if (createCalls === 1) throw new Error('executor bootstrap unavailable');
        creationEntered?.();
        await gate;
        return recoveredExecutor;
      },
    };
    const reopened = await createAgentExecutorPlane({
      factories: [recoveringFactory],
      policy: allowAllPolicy(),
      store,
    });
    await expect(reopened.tasks.get(task.taskId)).resolves.toMatchObject({ state: 'unknown' });

    const reconciling = reopened.tasks.reconcile(task.taskId);
    const sending = reopened.tasks.sendInput(task.taskId, { content: 'resume' });
    await entered;
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(createCalls).toBe(2);
    releaseCreation?.();
    await Promise.all([reconciling, sending]);
    expect(recoveredExecutor.sent).toEqual(['resume']);
    await reopened.close();
    expect(recoveredExecutor.disposeCalls).toBe(1);
  });

  it('disposes an old revision executor only after its last active task terminates', async () => {
    const executors = new Map<string, FakeExecutor>();
    const revisionFactory: AgentExecutorFactory = {
      executorId: 'fake-http',
      protocol: 'http',
      async create(route) {
        const executor = new FakeExecutor();
        executors.set(route.configurationRevision, executor);
        return executor;
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [revisionFactory],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({
      credentialRef: undefined,
      configurationRevision: 'rev-1',
    }));
    const task = await plane.tasks.start(taskInput({ taskId: 'old-revision-active' }));
    const oldExecutor = executors.get('rev-1')!;

    await plane.registrations.upsert(registration({
      credentialRef: undefined,
      configurationRevision: 'rev-2',
    }));
    expect(oldExecutor.disposeCalls).toBe(0);

    oldExecutor.snapshot = { state: 'completed', output: 'old route complete' };
    await expect(plane.tasks.reconcile(task.taskId)).resolves.toMatchObject({ state: 'completed' });
    expect(oldExecutor.disposeCalls).toBe(1);
    await plane.close();
    expect(oldExecutor.disposeCalls).toBe(1);
  });

  it('does not hold the registration mutation lane while disposing an obsolete executor', async () => {
    let disposalEntered: (() => void) | undefined;
    let releaseDisposal: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { disposalEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseDisposal = resolve; });
    const executor = new FakeExecutor();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const task = await plane.tasks.start(taskInput({ taskId: 'registration-dispose-lane' }));
    executor.snapshot = { state: 'completed' };
    await plane.tasks.reconcile(task.taskId);
    executor.disposeEntered = disposalEntered;
    executor.disposeGate = async () => gate;

    const replacing = plane.registrations.upsert(registration({
      credentialRef: undefined,
      configurationRevision: 'rev-2',
    }));
    await entered;
    let independentMutationResolved = false;
    const independentMutation = plane.registrations.upsert(registration({
      agentId: 'external:independent',
      credentialRef: undefined,
      configurationRevision: 'independent-rev-1',
    })).then(() => { independentMutationResolved = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const resolvedBeforeDisposal = independentMutationResolved;
    releaseDisposal?.();
    await Promise.all([replacing, independentMutation]);

    expect(resolvedBeforeDisposal).toBe(true);
    await plane.close();
  });

  it('coalesces close with an in-flight unused-executor disposal', async () => {
    let disposalEntered: (() => void) | undefined;
    let releaseDisposal: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { disposalEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseDisposal = resolve; });
    const executors = new Map<string, FakeExecutor>();
    const revisionFactory: AgentExecutorFactory = {
      executorId: 'fake-http',
      protocol: 'http',
      async create(route) {
        const executor = new FakeExecutor();
        executors.set(route.configurationRevision, executor);
        return executor;
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [revisionFactory],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const task = await plane.tasks.start(taskInput({ taskId: 'dispose-close-race' }));
    const oldExecutor = executors.get('rev-1')!;
    await plane.registrations.upsert(registration({
      credentialRef: undefined,
      configurationRevision: 'rev-2',
    }));
    oldExecutor.snapshot = { state: 'completed' };
    oldExecutor.disposeEntered = disposalEntered;
    oldExecutor.disposeGate = async () => gate;

    const completing = plane.tasks.reconcile(task.taskId);
    await entered;
    const closing = plane.close();
    await Promise.resolve();
    expect(oldExecutor.disposeCalls).toBe(1);
    releaseDisposal?.();

    await expect(completing).resolves.toMatchObject({ state: 'completed' });
    await expect(closing).resolves.toBeUndefined();
    expect(oldExecutor.disposeCalls).toBe(1);
  });

  it('coalesces concurrent close callers until executor disposal completes', async () => {
    let enteredDisposal: (() => void) | undefined;
    let releaseDisposal: (() => void) | undefined;
    const disposalEntered = new Promise<void>((resolve) => { enteredDisposal = resolve; });
    const disposalGate = new Promise<void>((resolve) => { releaseDisposal = resolve; });
    const executor = new FakeExecutor();
    executor.disposeEntered = () => { enteredDisposal?.(); };
    executor.disposeGate = async () => disposalGate;
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    await plane.tasks.start(taskInput({ taskId: 'concurrent-close' }));

    const firstClose = plane.close();
    await disposalEntered;
    let secondResolved = false;
    const secondClose = plane.close().then(() => { secondResolved = true; });
    await Promise.resolve();

    expect(secondResolved).toBe(false);
    expect(executor.disposeCalls).toBe(1);
    releaseDisposal?.();
    await Promise.all([firstClose, secondClose]);
  });

  it('rejects close within its configured bound when executor disposal never settles', async () => {
    let disposalEntered: (() => void) | undefined;
    let releaseDisposal: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { disposalEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseDisposal = resolve; });
    const executor = new FakeExecutor();
    executor.disposeEntered = disposalEntered;
    executor.disposeGate = async () => gate;
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
      closeTimeoutMs: 20,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    await plane.tasks.start(taskInput({ taskId: 'bounded-close' }));

    const closing = plane.close();
    await entered;
    const closeResult = await Promise.race([
      closing.then(
        () => new Error('close unexpectedly resolved'),
        (error: unknown) => error,
      ),
      new Promise<Error>((resolve) => {
        setTimeout(() => resolve(new Error('close remained pending')), 200);
      }),
    ]);
    releaseDisposal?.();
    await closing.catch(() => undefined);
    expect(closeResult).toBeInstanceOf(Error);
    expect((closeResult as Error).message).toMatch(/timed out.*20 ms/i);
    await expect(plane.close()).resolves.toBeUndefined();
    expect(executor.disposeCalls).toBe(1);
  });

  it('surfaces persistent executor disposal failure and allows close to retry it', async () => {
    const executor = new FakeExecutor();
    executor.disposeError = new Error('executor cleanup denied');
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    await plane.tasks.start(taskInput({ taskId: 'retry-dispose-close' }));

    await expect(plane.close()).rejects.toThrow(/could not be disposed/i);
    expect(executor.disposeCalls).toBe(2);

    executor.disposeError = undefined;
    await expect(plane.close()).resolves.toBeUndefined();
    expect(executor.disposeCalls).toBe(3);
  });

  it('drains a short executor operation before disposal on close', async () => {
    let enteredSend: (() => void) | undefined;
    let releaseSend: (() => void) | undefined;
    const sendEntered = new Promise<void>((resolve) => { enteredSend = resolve; });
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const executor = new FakeExecutor();
    executor.sendInputEntered = () => { enteredSend?.(); };
    executor.sendInputGate = async () => sendGate;
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const task = await plane.tasks.start(taskInput({ taskId: 'close-during-send' }));

    const sending = plane.tasks.sendInput(task.taskId, { content: 'finish read' });
    await sendEntered;
    let closeResolved = false;
    const closing = plane.close().then(() => { closeResolved = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(closeResolved).toBe(false);
    expect(executor.disposeCalls).toBe(0);
    releaseSend?.();
    await Promise.all([sending, closing]);
    expect(executor.disposeCalls).toBe(1);
  });

  it('does not resolve close while an admitted registration write is still in flight', async () => {
    let saveEntered: (() => void) | undefined;
    let releaseSave: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { saveEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const base = createMemoryAgentExecutorPlaneStore();
    const store: AgentExecutorPlaneStore = {
      ...base,
      async saveRegistrations(registrations) {
        saveEntered?.();
        await gate;
        await base.saveRegistrations(registrations);
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });

    const writing = plane.registrations.upsert(registration({ credentialRef: undefined }));
    await entered;
    let closeResolved = false;
    const closing = plane.close().then(() => { closeResolved = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(closeResolved).toBe(false);
    releaseSave?.();
    await Promise.all([writing, closing]);
    await expect(base.loadRegistrations()).resolves.toHaveLength(1);
  });

  it('does not resolve close before an admitted task mutation is durable', async () => {
    let saveEntered: (() => void) | undefined;
    let releaseSave: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { saveEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const base = createMemoryAgentExecutorPlaneStore();
    let blockSave = false;
    const store: AgentExecutorPlaneStore = {
      ...base,
      async saveTask(task) {
        if (blockSave) {
          saveEntered?.();
          await gate;
        }
        await base.saveTask(task);
      },
    };
    const executor = new FakeExecutor();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const task = await plane.tasks.start(taskInput({ taskId: 'close-during-task-save' }));
    blockSave = true;

    const sending = plane.tasks.sendInput(task.taskId, { content: 'persist before close' });
    await entered;
    let closeResolved = false;
    const closing = plane.close().then(() => { closeResolved = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(closeResolved).toBe(false);
    releaseSave?.();
    await Promise.all([sending, closing]);
    await expect(base.loadTasks()).resolves.toEqual([
      expect.objectContaining({ taskId: task.taskId, state: 'working' }),
    ]);
  });

  it('disposes to stop an event stream and waits for its iterator to exit', async () => {
    let releaseEvents: (() => void) | undefined;
    let enteredEventExit: (() => void) | undefined;
    let releaseEventExit: (() => void) | undefined;
    const eventGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
    const eventExitEntered = new Promise<void>((resolve) => { enteredEventExit = resolve; });
    const eventExitGate = new Promise<void>((resolve) => { releaseEventExit = resolve; });
    const executor = new FakeExecutor();
    executor.eventGate = async () => eventGate;
    executor.eventExitEntered = () => { enteredEventExit?.(); };
    executor.eventExitGate = async () => eventExitGate;
    executor.disposeEntered = () => { releaseEvents?.(); };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    await plane.tasks.start(taskInput({ taskId: 'close-event-stream' }));

    let closeResolved = false;
    const closing = plane.close().then(() => { closeResolved = true; });
    await eventExitEntered;
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(closeResolved).toBe(false);
    expect(executor.disposeCalls).toBe(1);
    releaseEventExit?.();
    await closing;
  });

  it('does not evict an old revision executor while a task operation is in flight', async () => {
    let enteredSend: (() => void) | undefined;
    let releaseSend: (() => void) | undefined;
    let releaseTerminalEvent: (() => void) | undefined;
    const sendEntered = new Promise<void>((resolve) => { enteredSend = resolve; });
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const terminalEventGate = new Promise<void>((resolve) => { releaseTerminalEvent = resolve; });
    const executor = new FakeExecutor();
    executor.sendInputEntered = () => { enteredSend?.(); };
    executor.sendInputGate = async () => sendGate;
    executor.eventGate = async () => terminalEventGate;
    executor.emittedEvents.push({ state: 'completed', output: 'done' });
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const task = await plane.tasks.start(taskInput({ taskId: 'lease-old-executor' }));
    await plane.registrations.upsert(registration({
      credentialRef: undefined,
      configurationRevision: 'rev-2',
      endpointIdentityHash: 'sha256:endpoint-b',
    }));

    const sending = plane.tasks.sendInput(task.taskId, { content: 'still reading' });
    await sendEntered;
    releaseTerminalEvent?.();
    await expect(plane.tasks.wait(task.taskId)).resolves.toMatchObject({ state: 'completed' });
    expect(executor.disposeCalls).toBe(0);

    releaseSend?.();
    await expect(sending).resolves.toMatchObject({ state: 'completed' });
    expect(executor.disposeCalls).toBe(1);
    await plane.close();
  });

  it('allows management-only changes without reusing a revision for different execution content', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const executor = new FakeExecutor();
    executor.snapshot = { state: 'input-required' };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    const original = registration({ credentialRef: undefined });
    await plane.registrations.upsert(original);
    await plane.tasks.start(taskInput({ taskId: 'management-change-existing' }));

    await expect(plane.registrations.upsert({
      ...original,
      managementOwner: 'runtime-config-test',
      health: { status: 'degraded', checkedAt: '2026-07-16T00:00:00.000Z' },
    })).resolves.toEqual(expect.objectContaining({ managementOwner: 'runtime-config-test' }));
    await plane.registrations.setEnabled(original.agentId, false, {
      expectedConfigurationRevision: original.configurationRevision,
      expectedManagementOwner: 'runtime-config-test',
    });
    await plane.registrations.setEnabled(original.agentId, true, {
      expectedConfigurationRevision: original.configurationRevision,
      expectedManagementOwner: 'runtime-config-test',
    });
    await expect(plane.tasks.start(taskInput({ taskId: 'management-change-new' })))
      .resolves.toMatchObject({ state: 'input-required' });
    const persistedRoute = (await store.loadTaskRegistrationSnapshots?.())?.[0];
    expect(persistedRoute).not.toHaveProperty('managementOwner');
    expect(persistedRoute).not.toHaveProperty('health');
    expect(persistedRoute?.enabled).toBe(true);
    await plane.close();
  });

  it('treats omitted and explicit undefined optional execution fields as the same revision content', async () => {
    const plane = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    const original = registration({
      credentialRef: undefined,
      executorConfig: { interfaceUrl: 'https://agent.example/a2a' },
    });
    const { credentialRef: _omittedCredentialRef, ...withoutCredential } = original;
    await plane.registrations.upsert(withoutCredential);

    await expect(plane.registrations.upsert({
      ...withoutCredential,
      credentialRef: undefined,
      executorConfig: {
        interfaceUrl: 'https://agent.example/a2a',
        optionalTransportHint: undefined,
      },
    })).resolves.toMatchObject({ configurationRevision: original.configurationRevision });
    await plane.close();
  });

  it('accepts rediscovered registration arrays with the same JSON content after store hydration', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const original = registration({ credentialRef: undefined, executorConfig: { routes: [{ tags: ['risk', 'review'] }] } });
    await store.saveRegistrations(JSON.parse(JSON.stringify([original])) as ExternalAgentRegistration[]);
    const executor = new FakeExecutor();
    const plane = await createAgentExecutorPlane({ factories: [factory(executor)], policy: allowAllPolicy(), store });
    // Fully populated arrays can retain V8's holey representation after construction.
    const tags = new Array<string>(2);
    tags[0] = 'risk';
    tags[1] = 'review';
    const skills = new Array<string>(1);
    skills[0] = 'risk-review';
    const rediscovered = { ...original, skills, executorConfig: { routes: [{ tags }] } };
    expect(JSON.stringify(rediscovered)).toBe(JSON.stringify(original));
    try {
      // Cross V8's optimization threshold: binary serialization must not make
      // an unchanged route become a revision conflict after repeated discovery.
      for (let discovery = 0; discovery < 2_000; discovery += 1) {
        await expect(plane.registrations.upsert(rediscovered)).resolves.toMatchObject({ configurationRevision: 'rev-1' });
      }
      await expect(plane.tasks.start(taskInput())).resolves.toMatchObject({ state: 'working' });
      expect(executor.starts).toHaveLength(1);
    } finally {
      await plane.close();
    }
  });

  it.each([
    { endpointIdentityHash: 'sha256:changed-endpoint' },
    { credentialRef: 'credential:changed' },
    { skills: ['review', 'risk'] },
    { executorConfig: { routes: [{ tags: ['review', 'risk'] }] } },
    { executorConfig: { routes: [{ tags: ['risk', 'changed'] }] } },
  ] satisfies Partial<ExternalAgentRegistration>[])(
    'rejects changed execution content under the same revision: %j', async (patch) => {
      const plane = await createAgentExecutorPlane({
        factories: [factory(new FakeExecutor())], policy: allowAllPolicy(),
        store: createMemoryAgentExecutorPlaneStore(),
      });
      const original = registration({ skills: ['risk', 'review'],
        executorConfig: { routes: [{ tags: ['risk', 'review'] }] } });
      try {
        await plane.registrations.upsert(original);
        // Exercise remembered fingerprints even after removal of the current route.
        await plane.registrations.remove(original.agentId);
        await expect(plane.registrations.upsert({ ...original, ...patch })).rejects.toThrow(/revision.*reused/);
        await expect(plane.registrations.upsert({ ...original, ...patch, configurationRevision: 'rev-2' }))
          .resolves.toMatchObject({ configurationRevision: 'rev-2' });
      } finally {
        await plane.close();
      }
    },
  );

  it('normalizes a legacy current-registration backfill before persisting its task route', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const executor = new FakeExecutor();
    executor.snapshot = { state: 'input-required' };
    const first = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await first.registrations.upsert(registration({
      credentialRef: undefined,
      managementOwner: 'runtime-config-test',
      health: {
        status: 'healthy',
        checkedAt: '2026-07-16T00:00:00.000Z',
        diagnostic: 'must-not-enter-task-route',
      },
    }));
    const task = await first.tasks.start(taskInput({ taskId: 'legacy-route-backfill' }));
    await first.close();
    await store.saveTaskRegistrationSnapshots?.([]);

    const reopened = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });
    await expect(reopened.tasks.get(task.taskId)).resolves.toMatchObject({
      registration: { configurationRevision: 'rev-1' },
    });
    const persistedRoute = (await store.loadTaskRegistrationSnapshots?.())?.[0];
    expect(persistedRoute).not.toHaveProperty('managementOwner');
    expect(persistedRoute).not.toHaveProperty('health');
    expect(persistedRoute?.enabled).toBe(true);
    await reopened.close();
  });

  it('fails closed instead of backfilling a legacy task from a mismatched route', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const current = registration({ credentialRef: undefined });
    const legacyTask: AgentTaskSnapshot = {
      taskId: 'legacy-route-mismatch',
      route: 'external',
      agentId: current.agentId,
      objective: 'resume safely',
      state: 'working',
      cancellation: 'none',
      registration: {
        agentId: current.agentId,
        origin: 'external',
        executorId: current.executorId,
        protocol: current.protocol,
        configurationRevision: current.configurationRevision,
        endpointIdentityHash: 'sha256:different-endpoint',
        capabilities: current.capabilities,
        effects: current.effects,
      },
      idempotencyKey: 'legacy-idempotency',
      dispatchAttempt: 1,
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:01.000Z',
    };
    await store.saveRegistrations([current]);
    await store.saveTask(legacyTask);

    const plane = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });
    await expect(plane.tasks.get(legacyTask.taskId)).resolves.toMatchObject({ state: 'unknown' });
    await expect(store.loadTaskRegistrationSnapshots?.()).resolves.toEqual([]);
    await plane.close();
  });

  it('rejects a persisted full snapshot that disagrees with the task route summary', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const first = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });
    await first.registrations.upsert(registration({ credentialRef: undefined }));
    const task = await first.tasks.start(taskInput({ taskId: 'corrupt-full-snapshot' }));
    await first.close();
    const captured = (await store.loadTaskRegistrationSnapshots?.())?.[0]!;
    await store.saveTaskRegistrationSnapshots?.([{
      ...captured,
      endpointIdentityHash: 'sha256:corrupt-route',
      executorConfig: { interfaceUrl: 'https://corrupt.example/a2a' },
    }]);

    const reopened = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });
    await expect(reopened.tasks.get(task.taskId)).resolves.toMatchObject({ state: 'unknown' });
    await expect(store.loadTaskRegistrationSnapshots?.()).resolves.toEqual([]);
    await reopened.close();
  });

  it('requires custom snapshot hooks as a pair', async () => {
    const complete = createMemoryAgentExecutorPlaneStore();
    const { saveTaskRegistrationSnapshots: _save, ...loadOnly } = complete;
    await expect(createAgentExecutorPlane({
      factories: [],
      policy: allowAllPolicy(),
      store: loadOnly,
    })).rejects.toThrow(/both task registration snapshot hooks/i);
  });

  it('persists a terminal task before surfacing snapshot GC failure and cleans the orphan on restart', async () => {
    const base = createMemoryAgentExecutorPlaneStore();
    let rejectGc = true;
    const store: AgentExecutorPlaneStore = {
      ...base,
      async saveTaskRegistrationSnapshots(registrations) {
        if (rejectGc && registrations.length === 0) throw new Error('snapshot GC unavailable');
        await base.saveTaskRegistrationSnapshots?.(registrations);
      },
    };
    const executor = new FakeExecutor();
    executor.snapshot = { state: 'input-required' };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const task = await plane.tasks.start(taskInput({ taskId: 'terminal-before-gc' }));
    const waiting = plane.tasks.wait(task.taskId, 1_000);
    executor.snapshot = { state: 'completed', output: 'durable terminal' };

    await expect(plane.tasks.reconcile(task.taskId)).rejects.toThrow(/snapshot GC unavailable/i);
    await expect(waiting).resolves.toMatchObject({ state: 'completed', output: 'durable terminal' });
    await expect(plane.tasks.get(task.taskId))
      .resolves.toMatchObject({ state: 'completed', output: 'durable terminal' });
    expect(await base.loadTaskRegistrationSnapshots?.()).toHaveLength(1);
    await plane.close();

    rejectGc = false;
    const reopened = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });
    await expect(reopened.tasks.get(task.taskId))
      .resolves.toMatchObject({ state: 'completed', output: 'durable terminal' });
    await expect(base.loadTaskRegistrationSnapshots?.()).resolves.toEqual([]);
    await reopened.close();
  });

  it('retains a shared revision until its last non-terminal task becomes terminal', async () => {
    const store = createMemoryAgentExecutorPlaneStore();
    const executor = new FakeExecutor();
    executor.snapshot = { state: 'input-required' };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const first = await plane.tasks.start(taskInput({ taskId: 'shared-revision-1' }));
    const second = await plane.tasks.start(taskInput({ taskId: 'shared-revision-2' }));
    executor.snapshot = { state: 'completed' };

    await plane.tasks.reconcile(first.taskId);
    expect(await store.loadTaskRegistrationSnapshots?.()).toHaveLength(1);
    await plane.tasks.reconcile(second.taskId);
    await expect(store.loadTaskRegistrationSnapshots?.()).resolves.toEqual([]);
    await plane.close();
  });

  it('cleans a snapshot-before-task crash orphan on the next startup', async () => {
    const base = createMemoryAgentExecutorPlaneStore();
    let rejectTaskWrite = true;
    const store: AgentExecutorPlaneStore = {
      ...base,
      async saveTask(task) {
        if (rejectTaskWrite) throw new Error('task snapshot unavailable');
        await base.saveTask(task);
      },
    };
    const first = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });
    await first.registrations.upsert(registration({ credentialRef: undefined }));
    await expect(first.tasks.start(taskInput({ taskId: 'snapshot-before-task' })))
      .rejects.toThrow(/task snapshot unavailable/i);
    await expect(first.tasks.list()).resolves.toEqual([]);
    expect(await base.loadTaskRegistrationSnapshots?.()).toHaveLength(1);
    expect(await base.loadTasks()).toEqual([]);
    await first.close();

    rejectTaskWrite = false;
    const reopened = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });
    await expect(base.loadTaskRegistrationSnapshots?.()).resolves.toEqual([]);
    await reopened.close();
  });

  it('keeps a durable terminal task observable when its event append fails', async () => {
    const base = createMemoryAgentExecutorPlaneStore();
    let rejectEvents = false;
    const store: AgentExecutorPlaneStore = {
      ...base,
      async appendEvent(event) {
        if (rejectEvents) throw new Error('terminal event unavailable');
        await base.appendEvent(event);
      },
    };
    const executor = new FakeExecutor();
    executor.snapshot = { state: 'input-required' };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const task = await plane.tasks.start(taskInput({ taskId: 'terminal-event-failure' }));
    const waiting = plane.tasks.wait(task.taskId, 1_000);
    executor.snapshot = { state: 'completed', output: 'terminal is authoritative' };
    rejectEvents = true;

    await expect(plane.tasks.reconcile(task.taskId)).rejects.toThrow(/terminal event unavailable/i);
    await expect(waiting).resolves.toMatchObject({
      state: 'completed',
      output: 'terminal is authoritative',
    });
    await expect(plane.tasks.get(task.taskId)).resolves.toMatchObject({ state: 'completed' });
    await expect(base.loadTaskRegistrationSnapshots?.()).resolves.toEqual([]);
    await plane.close();
  });

  it('returns an observable failed task when its submitted event cannot be appended', async () => {
    const base = createMemoryAgentExecutorPlaneStore();
    const backgroundErrors: Error[] = [];
    const store: AgentExecutorPlaneStore = {
      ...base,
      async appendEvent() {
        throw new Error('submitted event unavailable');
      },
    };
    const executor = new FakeExecutor();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
      onBackgroundError(error) {
        backgroundErrors.push(error);
      },
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const task = await plane.tasks.start(taskInput({ taskId: 'submitted-event-failure' }));

    expect(task).toMatchObject({
      taskId: 'submitted-event-failure',
      state: 'failed',
      error: expect.stringMatching(/submitted event unavailable/i),
    });
    expect(executor.starts).toEqual([]);
    await expect(plane.tasks.get(task.taskId)).resolves.toEqual(task);
    await expect(base.loadTasks()).resolves.toEqual([task]);
    await expect(base.loadTaskRegistrationSnapshots?.()).resolves.toEqual([]);
    expect(backgroundErrors).toHaveLength(1);
    await plane.close();
  });

  it('serializes cancellation behind admission so a canceled task is never restarted', async () => {
    let enteredSubmittedAppend: (() => void) | undefined;
    let releaseSubmittedAppend: (() => void) | undefined;
    const submittedAppendEntered = new Promise<void>((resolve) => {
      enteredSubmittedAppend = resolve;
    });
    const submittedAppendGate = new Promise<void>((resolve) => {
      releaseSubmittedAppend = resolve;
    });
    const base = createMemoryAgentExecutorPlaneStore();
    const store: AgentExecutorPlaneStore = {
      ...base,
      async appendEvent(event) {
        if (event.type === 'submitted') {
          enteredSubmittedAppend?.();
          await submittedAppendGate;
        }
        await base.appendEvent(event);
      },
    };
    const executor = new FakeExecutor();
    executor.cancelSnapshot = { state: 'canceled' };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const starting = plane.tasks.start(taskInput({ taskId: 'cancel-during-admission' }));
    await submittedAppendEntered;
    const canceling = plane.tasks.cancel('cancel-during-admission', 'operator canceled');
    await Promise.resolve();
    releaseSubmittedAppend?.();
    await Promise.all([starting, canceling]);

    await expect(plane.tasks.get('cancel-during-admission')).resolves.toMatchObject({
      state: 'canceled',
      cancellation: 'confirmed',
    });
    expect(executor.starts).toHaveLength(1);
    expect(executor.cancelCalls).toBe(1);
    await plane.close();
  });

  it('returns cancellation promptly and aborts an executor start that has not returned', async () => {
    let enteredStart: (() => void) | undefined;
    const startEntered = new Promise<void>((resolve) => { enteredStart = resolve; });
    let observedSignal: AbortSignal | undefined;
    const executor: AgentExecutor = {
      async start(input, signal) {
        observedSignal = signal;
        enteredStart?.();
        return new Promise<AgentExecutorTaskReference>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new Error(String(signal.reason ?? 'start aborted')));
          }, { once: true });
        });
      },
      async *events() {},
      async get() { return { state: 'working' }; },
      async sendInput() {},
      async cancel() { return { state: 'canceled' }; },
      async reconcile() { return { state: 'unknown' }; },
      async dispose() {},
    };
    const plane = await createAgentExecutorPlane({
      factories: [{
        executorId: 'fake-http',
        protocol: 'http',
        async create() { return executor; },
      }],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const starting = plane.tasks.start(taskInput({ taskId: 'cancel-pending-start' }));
    await startEntered;
    const requested = await plane.tasks.cancel('cancel-pending-start', 'operator canceled');

    expect(requested).toMatchObject({
      state: 'submitted',
      cancellation: 'requested',
    });
    expect(observedSignal?.aborted).toBe(true);
    await expect(starting).resolves.toMatchObject({
      state: 'unknown',
      cancellation: 'unknown',
      cancellationError: expect.stringMatching(/operator canceled/i),
    });
    await plane.close();
  });

  it('records a start aborted by plane close as ambiguous instead of failed', async () => {
    let enteredStart: (() => void) | undefined;
    const startEntered = new Promise<void>((resolve) => { enteredStart = resolve; });
    const executor: AgentExecutor = {
      async start(input, signal) {
        enteredStart?.();
        return new Promise<AgentExecutorTaskReference>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new Error(String(signal.reason ?? 'plane closed')));
          }, { once: true });
        });
      },
      async *events() {},
      async get() { return { state: 'working' }; },
      async sendInput() {},
      async cancel() { return { state: 'canceled' }; },
      async reconcile() { return { state: 'unknown' }; },
      async dispose() {},
    };
    const plane = await createAgentExecutorPlane({
      factories: [{
        executorId: 'fake-http',
        protocol: 'http',
        async create() { return executor; },
      }],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const starting = plane.tasks.start(taskInput({ taskId: 'close-pending-start' }));
    await startEntered;
    const closing = plane.close();

    await expect(starting).resolves.toMatchObject({
      state: 'unknown',
      cancellation: 'unknown',
      cancellationError: expect.stringMatching(/executor plane is closed/i),
    });
    await expect(closing).resolves.toBeUndefined();
  });

  it('aborts a caller start during executor preflight without dispatching remote work', async () => {
    const executor = new FakeExecutor();
    let enterPreflight: (() => void) | undefined;
    let releasePreflight: (() => void) | undefined;
    const preflightEntered = new Promise<void>((resolve) => { enterPreflight = resolve; });
    const preflightReleased = new Promise<void>((resolve) => { releasePreflight = resolve; });
    executor.preflightGate = async () => {
      enterPreflight?.();
      await preflightReleased;
    };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const controller = new AbortController();

    const starting = plane.tasks.start(
      taskInput({ taskId: 'abort-during-preflight' }),
      controller.signal,
    );
    await preflightEntered;
    controller.abort(new Error('stop during preflight'));

    await expect(starting).rejects.toThrow(/stop during preflight/i);
    expect(executor.starts).toHaveLength(0);
    expect(await plane.tasks.list()).toHaveLength(0);
    releasePreflight?.();
    await plane.close();
  });

  it('keeps later same-agent starts queued when an earlier queued caller aborts', async () => {
    const executor = new FakeExecutor();
    let enterFirstStart: (() => void) | undefined;
    let releaseFirstStart: (() => void) | undefined;
    const firstStartEntered = new Promise<void>((resolve) => { enterFirstStart = resolve; });
    const firstStartReleased = new Promise<void>((resolve) => { releaseFirstStart = resolve; });
    executor.startEntered = (input) => {
      if (input.taskId === 'queued-start-a') enterFirstStart?.();
    };
    executor.startGate = async (input) => {
      if (input.taskId === 'queued-start-a') await firstStartReleased;
    };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const first = plane.tasks.start(taskInput({ taskId: 'queued-start-a' }));
    await firstStartEntered;
    const controller = new AbortController();
    const aborted = plane.tasks.start(
      taskInput({ taskId: 'queued-start-b' }),
      controller.signal,
    );
    controller.abort(new Error('drop queued start b'));
    await expect(aborted).rejects.toThrow(/drop queued start b/i);
    const third = plane.tasks.start(taskInput({ taskId: 'queued-start-c' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(executor.starts.map((input) => input.taskId)).toEqual(['queued-start-a']);
    releaseFirstStart?.();
    await Promise.all([first, third]);
    expect(executor.starts.map((input) => input.taskId)).toEqual([
      'queued-start-a',
      'queued-start-c',
    ]);
    await plane.close();
  });

  it('coalesces caller abort and task cancellation after a start reference is durable', async () => {
    let enterAcceptedEvent: (() => void) | undefined;
    let releaseAcceptedEvent: (() => void) | undefined;
    const acceptedEventEntered = new Promise<void>((resolve) => { enterAcceptedEvent = resolve; });
    const acceptedEventReleased = new Promise<void>((resolve) => { releaseAcceptedEvent = resolve; });
    const base = createMemoryAgentExecutorPlaneStore();
    const store: AgentExecutorPlaneStore = {
      ...base,
      async appendEvent(event) {
        if (event.type === 'state' && event.state === 'working' && event.cancellation === 'none') {
          enterAcceptedEvent?.();
          await acceptedEventReleased;
        }
        await base.appendEvent(event);
      },
    };
    const executor = new FakeExecutor();
    executor.cancelSnapshot = { state: 'canceled' };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const controller = new AbortController();
    const starting = plane.tasks.start(
      taskInput({ taskId: 'coalesced-start-cancel' }),
      controller.signal,
    );
    await acceptedEventEntered;

    controller.abort(new Error('stop after accepted reference'));
    const canceling = plane.tasks.cancel('coalesced-start-cancel', 'stop after accepted reference');
    releaseAcceptedEvent?.();
    const [started, canceled] = await Promise.all([starting, canceling]);

    expect(started).toMatchObject({ state: 'canceled', cancellation: 'confirmed' });
    expect(canceled).toMatchObject({ state: 'canceled', cancellation: 'confirmed' });
    expect(executor.cancelCalls).toBe(1);
    await plane.close();
  });

  it('drains admission on close and never starts through a disposed executor', async () => {
    let enteredSnapshotSave: (() => void) | undefined;
    let releaseSnapshotSave: (() => void) | undefined;
    const snapshotSaveEntered = new Promise<void>((resolve) => { enteredSnapshotSave = resolve; });
    const snapshotSaveGate = new Promise<void>((resolve) => { releaseSnapshotSave = resolve; });
    const base = createMemoryAgentExecutorPlaneStore();
    let blockSnapshotSave = false;
    const store: AgentExecutorPlaneStore = {
      ...base,
      async saveTaskRegistrationSnapshots(registrations) {
        if (blockSnapshotSave && registrations.length > 0) {
          enteredSnapshotSave?.();
          await snapshotSaveGate;
        }
        await base.saveTaskRegistrationSnapshots?.(registrations);
      },
    };
    const executor = new FakeExecutor();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    blockSnapshotSave = true;

    const starting = plane.tasks.start(taskInput({ taskId: 'close-during-admission' }));
    await snapshotSaveEntered;
    let closeResolved = false;
    const closing = plane.close().then(() => { closeResolved = true; });
    await Promise.resolve();

    expect(closeResolved).toBe(false);
    expect(executor.disposeCalls).toBe(0);
    releaseSnapshotSave?.();
    const [task] = await Promise.all([starting, closing]);

    expect(task).toMatchObject({ state: 'failed', error: expect.stringMatching(/closed/i) });
    expect(executor.starts).toHaveLength(0);
    expect(executor.disposeCalls).toBe(1);
  });

  it('fails an uncertain start safely when an executor returns non-JSON reference metadata', async () => {
    const executor = new FakeExecutor();
    executor.startReference = {
      idempotencyKey: 'invalid-reference',
      metadata: { attempt: 1n },
    } as unknown as AgentExecutorTaskReference;
    const store = createMemoryAgentExecutorPlaneStore();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const task = await plane.tasks.start(taskInput({ taskId: 'invalid-reference-metadata' }));

    expect(task).toMatchObject({
      state: 'unknown',
      error: expect.stringMatching(/reference.*JSON-safe/i),
    });
    expect(task.executorReference).toBeUndefined();
    await expect(store.loadTasks()).resolves.toEqual([task]);
    await plane.close();
  });

  it('reports a terminal stream event whose ledger append fails', async () => {
    let releaseEvents: (() => void) | undefined;
    const eventGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
    const base = createMemoryAgentExecutorPlaneStore();
    const store: AgentExecutorPlaneStore = {
      ...base,
      async appendEvent(event) {
        if (event.state === 'completed') throw new Error('terminal event ledger unavailable');
        await base.appendEvent(event);
      },
    };
    const executor = new FakeExecutor();
    executor.eventGate = async () => eventGate;
    executor.emittedEvents.push({ state: 'completed', output: 'done' });
    const backgroundErrors: Error[] = [];
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
      onBackgroundError(error, context) {
        if (context.operation === 'event-pump-recovery') backgroundErrors.push(error);
      },
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const task = await plane.tasks.start(taskInput({ taskId: 'terminal-event-ledger-failure' }));
    releaseEvents?.();

    await expect(plane.tasks.wait(task.taskId)).resolves.toMatchObject({ state: 'completed' });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(backgroundErrors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/terminal event ledger unavailable/i) }),
    ]);
    await plane.close();
  });

  it('reports a persistent event-pump recovery failure without an unhandled rejection', async () => {
    let releaseEvents: (() => void) | undefined;
    const eventGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
    const base = createMemoryAgentExecutorPlaneStore();
    let rejectEvents = false;
    const store: AgentExecutorPlaneStore = {
      ...base,
      async appendEvent(event) {
        if (rejectEvents) throw new Error('stream event store unavailable');
        await base.appendEvent(event);
      },
    };
    const executor = new FakeExecutor();
    executor.eventGate = async () => eventGate;
    executor.emittedEvents.push({ progress: { message: 'streamed update' } });
    let reportError: ((error: Error) => void) | undefined;
    const reported = new Promise<Error>((resolve) => { reportError = resolve; });
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
      onBackgroundError(error, context) {
        if (context.operation === 'event-pump-recovery') reportError?.(error);
      },
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const task = await plane.tasks.start(taskInput({ taskId: 'event-pump-recovery-failure' }));
    rejectEvents = true;
    releaseEvents?.();

    await expect(reported).resolves.toMatchObject({
      message: expect.stringMatching(/stream event store unavailable/i),
    });
    await expect(plane.tasks.get(task.taskId)).resolves.toMatchObject({
      state: 'unknown',
      error: expect.stringMatching(/stream event store unavailable/i),
    });
    await plane.close();
  });

  it('uses registration revision and owner CAS for upsert, enabled mutation, and removal', async () => {
    const plane = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({
      credentialRef: undefined,
      managementOwner: 'owner-a',
    }));

    await expect(plane.registrations.setEnabled('external:risk-reviewer', false, {
      expectedConfigurationRevision: 'rev-1',
      expectedManagementOwner: 'owner-b',
      claimOwner: 'runtime-config-test',
    })).resolves.toBeUndefined();
    await expect(plane.registrations.remove('external:risk-reviewer', {
      expectedConfigurationRevision: 'rev-1',
      expectedManagementOwner: null,
    })).resolves.toBe(false);
    const conflict = await plane.registrations.upsert(registration({
      configurationRevision: 'rev-2',
      credentialRef: undefined,
    }), {
      expectedConfigurationRevision: 'rev-1',
      expectedManagementOwner: null,
    }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ExternalAgentRegistrationConflictError);
    expect(conflict).toMatchObject({
      code: 'external_agent_registration_conflict',
      agentId: 'external:risk-reviewer',
    });
    expect(await plane.registrations.list()).toEqual([
      expect.objectContaining({
        agentId: 'external:risk-reviewer',
        configurationRevision: 'rev-1',
        enabled: true,
      }),
    ]);
    await plane.close();
  });

  it('preserves the accepted remote handle when ledger persistence fails after start', async () => {
    const executor = new FakeExecutor();
    const memoryStore = createMemoryAgentExecutorPlaneStore();
    let appendCalls = 0;
    const store: AgentExecutorPlaneStore = {
      ...memoryStore,
      async appendEvent(event) {
        appendCalls += 1;
        if (appendCalls === 2) throw new Error('event store unavailable');
        await memoryStore.appendEvent(event);
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const started = await plane.tasks.start(taskInput({ taskId: 'accepted-ledger-failure' }));

    expect(started).toMatchObject({
      state: 'unknown',
      remoteTaskId: 'remote-1',
      executorReference: { remoteTaskId: 'remote-1' },
    });
    expect(executor.starts).toHaveLength(1);
    expect((await store.loadTasks()).find((task) => task.taskId === started.taskId))
      .toMatchObject({
        state: 'unknown',
        remoteTaskId: 'remote-1',
        executorReference: { remoteTaskId: 'remote-1' },
      });
  });

  it('rejects pending waiters and service calls after the plane closes', async () => {
    const executor = new FakeExecutor();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const started = await plane.tasks.start(taskInput({ taskId: 'close-pending' }));
    const waiting = plane.tasks.wait(started.taskId);

    await plane.close();

    await expect(waiting).rejects.toThrow(/executor plane is closed/i);
    await expect(plane.tasks.list()).rejects.toThrow(/executor plane is closed/i);
    await expect(plane.tasks.start(taskInput())).rejects.toThrow(/executor plane is closed/i);
    await expect(plane.registrations.list()).rejects.toThrow(/executor plane is closed/i);
    await expect(plane.listDispatchable({ actorId: 'actor-1' }))
      .rejects.toThrow(/executor plane is closed/i);
    await expect(plane.close()).resolves.toBeUndefined();
  });

  it('disposes an executor created concurrently with close instead of leaking it', async () => {
    let factoryEntered: (() => void) | undefined;
    let releaseFactory: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { factoryEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFactory = resolve; });
    const executor = new FakeExecutor();
    const delayedFactory: AgentExecutorFactory = {
      executorId: 'fake-http',
      protocol: 'http',
      async create() {
        factoryEntered?.();
        await gate;
        return executor;
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [delayedFactory],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const starting = plane.tasks.start(taskInput({ taskId: 'close-during-create' }));
    await entered;

    const closing = plane.close();
    releaseFactory?.();

    await expect(starting).rejects.toThrow(/executor plane is closed/i);
    await expect(closing).resolves.toBeUndefined();
    expect(executor.disposeCalls).toBe(1);
  });

  it('close drains executor creation left behind by an aborted caller start', async () => {
    let factoryEntered: (() => void) | undefined;
    let releaseFactory: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { factoryEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFactory = resolve; });
    const executor = new FakeExecutor();
    const delayedFactory: AgentExecutorFactory = {
      executorId: 'fake-http',
      protocol: 'http',
      async create() {
        factoryEntered?.();
        await gate;
        return executor;
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [delayedFactory],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const controller = new AbortController();
    const starting = plane.tasks.start(
      taskInput({ taskId: 'abort-during-create' }),
      controller.signal,
    );
    await entered;
    controller.abort(new Error('stop during executor creation'));
    await expect(starting).rejects.toThrow(/stop during executor creation/i);

    let closeResolved = false;
    const closing = plane.close().then(() => { closeResolved = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(closeResolved).toBe(false);

    releaseFactory?.();
    await expect(closing).resolves.toBeUndefined();
    expect(executor.disposeCalls).toBe(1);
  });

  it('does not let a stale continuation overwrite a concurrently completed task', async () => {
    let releaseEvent: (() => void) | undefined;
    let enterSend: (() => void) | undefined;
    let releaseSend: (() => void) | undefined;
    const eventReleased = new Promise<void>((resolve) => { releaseEvent = resolve; });
    const sendEntered = new Promise<void>((resolve) => { enterSend = resolve; });
    const sendReleased = new Promise<void>((resolve) => { releaseSend = resolve; });
    const executor: AgentExecutor = {
      async start(input) {
        return { idempotencyKey: input.idempotencyKey!, remoteTaskId: 'remote-race' };
      },
      async *events() {
        await eventReleased;
        yield { state: 'completed', output: 'done' };
      },
      async get() {
        return { state: 'input-required' };
      },
      async sendInput() {
        enterSend?.();
        await sendReleased;
      },
      async cancel() {
        return { state: 'canceled' };
      },
      async reconcile() {
        return { state: 'working' };
      },
      async dispose() {},
    };
    const plane = await createAgentExecutorPlane({
      factories: [{
        executorId: 'fake-http',
        protocol: 'http',
        async create() { return executor; },
      }],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const started = await plane.tasks.start(taskInput({ taskId: 'continuation-race' }));

    const sending = plane.tasks.sendInput(started.taskId, { content: 'continue' });
    await sendEntered;
    const completed = plane.tasks.wait(started.taskId, 1_000);
    releaseEvent?.();
    await expect(completed).resolves.toMatchObject({ state: 'completed', output: 'done' });
    releaseSend?.();
    await expect(sending).resolves.toMatchObject({ state: 'completed', output: 'done' });
    await expect(plane.tasks.get(started.taskId))
      .resolves.toMatchObject({ state: 'completed', output: 'done' });
  });

  it('advances to terminal after sendInput without a host reconcile when the event stream ended at input-required', async () => {
    // A2A-style executor: the event stream closes when the task pauses for input,
    // so the plane must restart the event pump after a successful sendInput.
    let sent = false;
    let streams = 0;
    const executor: AgentExecutor = {
      async start(input) {
        return { idempotencyKey: input.idempotencyKey!, remoteTaskId: 'remote-input' };
      },
      async *events() {
        streams += 1;
        if (!sent) {
          yield { state: 'input-required' as const };
          return;
        }
        yield { state: 'working' as const };
        yield { state: 'completed' as const, output: 'continued' };
      },
      async get() {
        return sent
          ? { state: 'completed' as const, output: 'continued' }
          : { state: 'input-required' as const };
      },
      async sendInput() { sent = true; },
      async cancel() { return { state: 'canceled' as const }; },
      async reconcile() {
        return sent
          ? { state: 'completed' as const, output: 'continued' }
          : { state: 'input-required' as const };
      },
      async dispose() {},
    };
    const plane = await createAgentExecutorPlane({
      factories: [{
        executorId: 'fake-http',
        protocol: 'http',
        async create() { return executor; },
      }],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const started = await plane.tasks.start(taskInput({ taskId: 'send-input-restarts-pump' }));
    await expect(plane.tasks.get(started.taskId)).resolves.toMatchObject({ state: 'input-required' });

    await plane.tasks.sendInput(started.taskId, { content: 'continue' });

    await expect(plane.tasks.wait(started.taskId, 1_000))
      .resolves.toMatchObject({ state: 'completed', output: 'continued' });
    expect(streams).toBe(2);
    await plane.close();
  });

  it('does not start a duplicate event pump when one is still consuming after sendInput', async () => {
    // Reference-style executor: its stream stays open across input-required, so the
    // original pump is still alive and sendInput must not fork a second consumer.
    let streams = 0;
    let releaseContinuation: (() => void) | undefined;
    const continuation = new Promise<void>((resolve) => { releaseContinuation = resolve; });
    const executor: AgentExecutor = {
      async start(input) {
        return { idempotencyKey: input.idempotencyKey!, remoteTaskId: 'remote-held' };
      },
      async *events() {
        streams += 1;
        yield { state: 'input-required' as const };
        await continuation;
        yield { state: 'completed' as const, output: 'held-continued' };
      },
      async get() { return { state: 'input-required' as const }; },
      async sendInput() {},
      async cancel() { return { state: 'canceled' as const }; },
      async reconcile() { return { state: 'input-required' as const }; },
      async dispose() {},
    };
    const plane = await createAgentExecutorPlane({
      factories: [{
        executorId: 'fake-http',
        protocol: 'http',
        async create() { return executor; },
      }],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const started = await plane.tasks.start(taskInput({ taskId: 'send-input-keeps-pump' }));

    const sending = plane.tasks.sendInput(started.taskId, { content: 'continue' });
    releaseContinuation?.();

    await sending;
    await expect(plane.tasks.wait(started.taskId, 1_000))
      .resolves.toMatchObject({ state: 'completed', output: 'held-continued' });
    expect(streams).toBe(1);
    await plane.close();
  });
  it('persists the accepted remote handle before refreshing remote state', async () => {
    const executor = new FakeExecutor();
    let enterGet: (() => void) | undefined;
    let releaseGet: (() => void) | undefined;
    const getEntered = new Promise<void>((resolve) => { enterGet = resolve; });
    const getReleased = new Promise<void>((resolve) => { releaseGet = resolve; });
    executor.get = async () => {
      enterGet?.();
      await getReleased;
      return { state: 'working' };
    };
    const store = createMemoryAgentExecutorPlaneStore();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const starting = plane.tasks.start(taskInput({ taskId: 'accepted-before-get' }));
    await getEntered;
    expect((await store.loadTasks()).find((task) => task.taskId === 'accepted-before-get'))
      .toMatchObject({ remoteTaskId: 'remote-1', state: 'working' });
    releaseGet?.();
    await starting;
  });

  it('fails closed before start for policy, credential, health, capability and read-only mismatches', async () => {
    const executor = new FakeExecutor();
    const denied = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: async () => ({ allowed: false, reasons: ['policy denied'] }),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await denied.registrations.upsert(registration({ credentialRef: undefined }));
    expect(await denied.listDispatchable({ actorId: 'actor-1' })).toEqual([]);
    await expect(denied.tasks.start(taskInput())).rejects.toThrow(/policy denied/i);

    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({
      health: { status: 'unhealthy', checkedAt: '2026-07-10T00:00:00.000Z' },
      capabilities: { ...CAPABILITIES, cancellation: 'unsupported' },
      effects: { remote: 'write', workspace: 'proposal' },
    }));
    const preflight = await plane.preflight({
      agentId: 'external:risk-reviewer',
      query: {
        actorId: 'actor-1',
        readOnly: true,
        requiredCapabilities: { cancellation: true },
      },
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.reasons.join(' ')).toMatch(/credential|unhealthy|cancellation|read-only/i);
    expect(executor.starts).toHaveLength(0);
  });

  it('rejects a registration revision changed during asynchronous preflight', async () => {
    const executor = new FakeExecutor();
    let enterPolicy: (() => void) | undefined;
    let releasePolicy: (() => void) | undefined;
    const policyEntered = new Promise<void>((resolve) => { enterPolicy = resolve; });
    const policyReleased = new Promise<void>((resolve) => { releasePolicy = resolve; });
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: async () => {
        enterPolicy?.();
        await policyReleased;
        return { allowed: true };
      },
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const starting = plane.tasks.start(taskInput());
    await policyEntered;
    await plane.registrations.upsert(registration({
      credentialRef: undefined,
      configurationRevision: 'rev-2',
    }));
    releasePolicy?.();

    await expect(starting).rejects.toThrow(/changed during preflight/i);
    expect(executor.starts).toHaveLength(0);
  });

  it('rejects a registration disabled during asynchronous preflight', async () => {
    const executor = new FakeExecutor();
    let enterPolicy: (() => void) | undefined;
    let releasePolicy: (() => void) | undefined;
    const policyEntered = new Promise<void>((resolve) => { enterPolicy = resolve; });
    const policyReleased = new Promise<void>((resolve) => { releasePolicy = resolve; });
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: async () => {
        enterPolicy?.();
        await policyReleased;
        return { allowed: true };
      },
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const starting = plane.tasks.start(taskInput());
    await policyEntered;
    await plane.registrations.upsert(registration({ credentialRef: undefined, enabled: false }));
    releasePolicy?.();

    await expect(starting).rejects.toThrow(/disabled during preflight/i);
    expect(executor.starts).toHaveLength(0);
  });

  it('uses the final post-executor-preflight enabled check as the admission boundary', async () => {
    const executor = new FakeExecutor();
    let enterPreflight: (() => void) | undefined;
    let releasePreflight: (() => void) | undefined;
    const preflightEntered = new Promise<void>((resolve) => { enterPreflight = resolve; });
    const preflightReleased = new Promise<void>((resolve) => { releasePreflight = resolve; });
    executor.preflightGate = async () => {
      enterPreflight?.();
      await preflightReleased;
    };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const starting = plane.tasks.start(taskInput({ taskId: 'executor-preflight-disable' }));
    await preflightEntered;
    await plane.registrations.setEnabled('external:risk-reviewer', false);
    releasePreflight?.();

    await expect(starting).rejects.toThrow(/disabled during executor preflight/i);
    expect(executor.starts).toHaveLength(0);
    expect(await plane.tasks.list()).toEqual([]);
    await plane.close();
  });

  it('fails final admission when health becomes unhealthy during executor preflight', async () => {
    const executor = new FakeExecutor();
    let enterPreflight: (() => void) | undefined;
    let releasePreflight: (() => void) | undefined;
    const preflightEntered = new Promise<void>((resolve) => { enterPreflight = resolve; });
    const preflightReleased = new Promise<void>((resolve) => { releasePreflight = resolve; });
    executor.preflightGate = async () => {
      enterPreflight?.();
      await preflightReleased;
    };
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    const original = registration({ credentialRef: undefined });
    await plane.registrations.upsert(original);

    const starting = plane.tasks.start(taskInput({ taskId: 'executor-preflight-unhealthy' }));
    await preflightEntered;
    await plane.registrations.upsert({
      ...original,
      health: { status: 'unhealthy', checkedAt: '2026-07-16T00:00:00.000Z' },
    });
    releasePreflight?.();

    await expect(starting).rejects.toThrow(/unhealthy during executor preflight/i);
    expect(executor.starts).toHaveLength(0);
    expect(await plane.tasks.list()).toEqual([]);
    await plane.close();
  });

  it('keeps registration memory unchanged when persistence fails', async () => {
    const base = createMemoryAgentExecutorPlaneStore();
    let rejectWrites = false;
    const store: AgentExecutorPlaneStore = {
      ...base,
      async saveRegistrations(registrations) {
        if (rejectWrites) throw new Error('registration store unavailable');
        await base.saveRegistrations(registrations);
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [factory(new FakeExecutor())],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    rejectWrites = true;

    await expect(plane.registrations.upsert(registration({
      credentialRef: undefined,
      enabled: false,
    }))).rejects.toThrow(/store unavailable/i);
    expect(await plane.registrations.list()).toEqual([
      expect.objectContaining({ agentId: 'external:risk-reviewer', enabled: true }),
    ]);

    await expect(plane.registrations.setEnabled('external:risk-reviewer', false))
      .rejects.toThrow(/store unavailable/i);
    expect(await plane.registrations.list()).toEqual([
      expect.objectContaining({ agentId: 'external:risk-reviewer', enabled: true }),
    ]);

    await expect(plane.registrations.remove('external:risk-reviewer'))
      .rejects.toThrow(/store unavailable/i);
    expect(await plane.registrations.list()).toHaveLength(1);
  });

  it('enforces budget, data classification and concurrency before start', async () => {
    const executor = new FakeExecutor();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({
      credentialRef: undefined,
      maxConcurrency: 1,
      minimumBudget: 10,
      allowedDataClassifications: ['public'],
    }));

    const resourceMismatch = await plane.preflight({
      agentId: 'external:risk-reviewer',
      query: {
        actorId: 'actor-1',
        budget: 9,
        dataClassifications: ['restricted'],
      },
    });
    expect(resourceMismatch.reasons.join(' ')).toMatch(/budget.*classification/i);

    const eligibleContext = {
      actorId: 'actor-1',
      projectId: 'project-1',
      parentTaskId: 'parent-1',
      dataClassifications: ['public'],
      budget: 10,
    } as const;
    const concurrent = await Promise.allSettled([
      plane.tasks.start(taskInput({ taskId: 'concurrent-1', context: eligibleContext })),
      plane.tasks.start(taskInput({ taskId: 'concurrent-2', context: eligibleContext })),
    ]);
    expect(concurrent.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const busy = await plane.preflight({
      agentId: 'external:risk-reviewer',
      query: { actorId: 'actor-1', budget: 10, dataClassifications: ['public'] },
    });
    expect(busy.ok).toBe(false);
    expect(busy.reasons.join(' ')).toMatch(/concurrency/i);
    expect(executor.starts).toHaveLength(1);
  });

  it('keeps cancel requested separate from confirmed, unsupported and failed', async () => {
    const executor = new FakeExecutor();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const started = await plane.tasks.start(taskInput());
    executor.snapshot = { state: 'working' };
    expect((await plane.tasks.cancel(started.taskId, 'stop')).cancellation).toBe('requested');

    executor.snapshot = {
      state: 'canceled',
      artifacts: [{ name: 'report.pdf', uri: 'https://remote.example/report.pdf' }],
    };
    const confirmed = await plane.tasks.cancel(started.taskId, 'stop');
    expect(confirmed.cancellation).toBe('confirmed');
    expect(confirmed.artifacts).toEqual([expect.objectContaining({
      producingAgentId: 'external:risk-reviewer',
      remoteTaskId: 'remote-1',
    })]);

    const unsupported = await plane.registrations.upsert(registration({
      agentId: 'external:no-cancel',
      configurationRevision: 'rev-1',
      credentialRef: undefined,
      capabilities: { ...CAPABILITIES, cancellation: 'unsupported' },
    }));
    executor.snapshot = { state: 'working' };
    const unsupportedTask = await plane.tasks.start(taskInput({ agentId: unsupported.agentId }));
    expect((await plane.tasks.cancel(unsupportedTask.taskId, 'stop')).cancellation).toBe('unsupported');

    executor.cancelError = new AgentCancellationUncertainError('cancel response lost');
    const unknown = await plane.tasks.start(taskInput({ taskId: 'cancel-unknown' }));
    expect((await plane.tasks.cancel(unknown.taskId, 'stop')).cancellation).toBe('unknown');

    executor.cancelError = new Error('remote cancellation failed');
    const failed = await plane.tasks.start(taskInput({ taskId: 'cancel-failed' }));
    expect((await plane.tasks.cancel(failed.taskId, 'stop')).cancellation).toBe('failed');
  });

  it('reconciles an ambiguous start without issuing a second start', async () => {
    const executor = new FakeExecutor();
    executor.startError = new AgentStartUncertainError('response lost');
    const store = createMemoryAgentExecutorPlaneStore();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
      createTaskId: () => 'uncertain-task',
      createIdempotencyKey: () => 'uncertain-idem',
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));

    const started = await plane.tasks.start(taskInput());
    expect(started.state).toBe('unknown');
    expect(executor.starts).toHaveLength(1);

    await plane.close();
    executor.startError = undefined;
    executor.snapshot = { state: 'completed', output: 'recovered' };
    const reopened = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    const recovered = await reopened.tasks.get(started.taskId);
    expect(recovered.state).toBe('completed');
    expect(recovered.output).toBe('recovered');
    expect(executor.starts).toHaveLength(1);
  });

  it('recovers as unknown instead of failing Runtime startup when a captured factory is absent', async () => {
    const executor = new FakeExecutor();
    const store = createMemoryAgentExecutorPlaneStore();
    const plane = await createAgentExecutorPlane({
      factories: [factory(executor)],
      policy: allowAllPolicy(),
      store,
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    const started = await plane.tasks.start(taskInput({ taskId: 'missing-factory-task' }));
    expect(started.state).toBe('working');
    await plane.close();

    const reopened = await createAgentExecutorPlane({
      factories: [],
      policy: allowAllPolicy(),
      store,
    });
    expect(await reopened.tasks.get(started.taskId)).toMatchObject({
      state: 'unknown',
      error: expect.stringMatching(/executor is unavailable/i),
    });
    expect(executor.starts).toHaveLength(1);
  });

  it('redacts credential content from failures and mirrors local tasks into the same ledger', async () => {
    const executor = new FakeExecutor();
    const secretFactory: AgentExecutorFactory = {
      executorId: 'fake-http',
      protocol: 'http',
      async create(_registration, context) {
        return {
          ...executor,
          async start(input) {
            return context.withCredential('credential:risk', async (secret) => {
              throw new Error(`upstream rejected ${secret}`);
            });
          },
        } as AgentExecutor;
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [secretFactory],
      policy: allowAllPolicy(),
      credentialBroker: {
        async withCredential(_ref, use) {
          return use('TOP-SECRET');
        },
      },
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({
      health: {
        status: 'healthy',
        checkedAt: '2026-07-10T00:00:00.000Z',
        diagnostic: 'TOP-SECRET',
      },
    }));
    const failed = await plane.tasks.start(taskInput({ taskId: 'redacted-task' }));
    expect(failed.state).toBe('failed');
    expect(failed.error).toContain('[REDACTED]');
    expect(JSON.stringify(failed)).not.toContain('TOP-SECRET');
    expect(JSON.stringify(await plane.tasks.events(failed.taskId))).not.toContain('TOP-SECRET');
    const registrationJson = JSON.stringify(await plane.registrations.list());
    expect(registrationJson).not.toContain('credential:risk');
    expect(registrationJson).not.toContain('TOP-SECRET');

    await plane.tasks.recordLocal({
      taskId: 'local-task',
      agentId: 'native:kodax-child',
      objective: 'Inspect files',
      parentTaskId: 'parent-1',
      configurationRevision: 'native-v1',
    });
    await plane.tasks.updateLocal('local-task', { state: 'completed', output: 'done' });
    const all = await plane.tasks.list({ parentTaskId: 'parent-1' });
    expect(all.map((task) => [task.taskId, task.route, task.state])).toContainEqual([
      'local-task',
      'local',
      'completed',
    ]);
  });

  it('fails closed when an executor asks to materialize an artifact', async () => {
    const executor = new FakeExecutor();
    let factoryContext: AgentExecutorFactoryContext | undefined;
    const artifactFactory: AgentExecutorFactory = {
      executorId: 'fake-http',
      protocol: 'http',
      async create(_registration, context) {
        factoryContext = context;
        return executor;
      },
    };
    const plane = await createAgentExecutorPlane({
      factories: [artifactFactory],
      policy: allowAllPolicy(),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(registration({ credentialRef: undefined }));
    await plane.tasks.start(taskInput());

    expect(factoryContext).toBeDefined();
    await expect(factoryContext!.authorizeArtifact({
      name: 'report.pdf',
      uri: 'https://remote.example/report.pdf',
    })).rejects.toThrow(/not authorized/i);

    const allowedPlane = await createAgentExecutorPlane({
      factories: [artifactFactory],
      policy: allowAllPolicy(),
      artifactPolicy: ({ artifact }) => ({ allowed: artifact.hash === 'sha256:trusted' }),
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await allowedPlane.registrations.upsert(registration({ credentialRef: undefined }));
    await allowedPlane.tasks.start(taskInput({ taskId: 'artifact-task' }));
    expect(factoryContext).toBeDefined();
    await expect(factoryContext!.authorizeArtifact({
      name: 'trusted.pdf',
      hash: 'sha256:trusted',
    })).resolves.toBeUndefined();
  });
});
