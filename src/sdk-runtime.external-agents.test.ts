import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createReferenceAgentExecutorFactory } from '@kodax-ai/agent';
import type {
  AgentExecutorFactory,
  AgentTaskState,
  ExternalAgentRegistration,
} from '@kodax-ai/agent';
import {
  connectKodaXRuntime,
  createKodaXRuntime,
  type KodaXRuntime,
} from './sdk-runtime.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import { createRuntimeDaemonClient } from './runtime-daemon/client.js';
import {
  createRuntimeDaemonRequest,
  isRuntimeDaemonSuccessResponse,
  type RuntimeDaemonMethod,
} from './runtime-daemon/protocol.js';
import { createRuntimeDaemonDispatcher } from './runtime-daemon/server.js';

let homeDir: string | undefined;

afterEach(() => {
  if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

function registration(): ExternalAgentRegistration {
  return {
    agentId: 'external:runtime-reference',
    displayName: 'Runtime Reference',
    enabled: true,
    executorId: 'reference-http',
    protocol: 'http',
    configurationRevision: 'rev-1',
    endpointIdentityHash: 'sha256:runtime-reference',
    executorConfig: { output: 'runtime-ok', privateEndpoint: 'https://private.invalid' },
    capabilities: {
      streaming: 'supported',
      durableTasks: 'supported',
      inputRequired: 'supported',
      cancellation: 'supported',
      artifacts: 'supported',
    },
    effects: { remote: 'read', workspace: 'proposal' },
  };
}

function externalAgentOptions() {
  return {
    factories: [createReferenceAgentExecutorFactory({
      executorId: 'reference-http',
      protocol: 'http' as const,
    })],
    policy: async () => ({ allowed: true }),
    defaultContext: { actorId: 'runtime-host' },
  };
}

function deferredExternalAgentFixture() {
  let state: AgentTaskState = 'unknown';
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const factory: AgentExecutorFactory = {
    executorId: 'deferred-http',
    protocol: 'http',
    async create() {
      return {
        async start(input) {
          return { idempotencyKey: input.idempotencyKey ?? 'deferred-task' };
        },
        async *events() {
          yield { state: 'unknown' as const };
          await finished;
          state = 'completed';
          yield { state, output: 'deferred-complete' };
        },
        async get() { return { state }; },
        async sendInput() {},
        async cancel() {
          state = 'canceled';
          finish?.();
          return { state };
        },
        async reconcile() { return { state }; },
        async dispose() { finish?.(); },
      };
    },
  };
  const deferredRegistration: ExternalAgentRegistration = {
    ...registration(),
    agentId: 'external:deferred-runtime',
    displayName: 'Deferred Runtime',
    executorId: factory.executorId,
    protocol: factory.protocol,
    configurationRevision: 'deferred-rev-1',
    endpointIdentityHash: 'sha256:deferred-runtime',
  };
  return {
    registration: deferredRegistration,
    options: {
      factories: [factory],
      policy: async () => ({ allowed: true }),
      defaultContext: { actorId: 'runtime-host' },
    },
    finish() { finish?.(); },
  };
}

async function assertRuntimeAgentServiceConformance(
  runtime: KodaXRuntime,
  actorId: string,
  _parentTaskId: string,
): Promise<{
  readonly sessionId: string;
  readonly actorPath: string;
  readonly turnId: string;
  readonly registrationJson: string;
}> {
  const summary = await runtime.admin.agentRegistrations.upsert(registration());
  expect(summary.credentialConfigured).toBe(false);
  const listed = await runtime.agents.listDispatchable({ actorId });
  expect(listed.map((entry) => entry.descriptor.agentId)).toEqual(expect.arrayContaining([
    'external:runtime-reference',
    'native:kodax-child',
  ]));
  expect((await runtime.agents.preflight({
    agentId: 'external:runtime-reference',
    query: { actorId, readOnly: true },
  })).ok).toBe(true);

  const session = await runtime.sessions.create({
    sessionId: `external-${actorId.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
    title: 'External Agent conformance',
  });
  const started = await runtime.agents.spawn(session.id, {
    taskName: 'reference',
    kind: 'external',
    objective: 'Run reference conformance',
    metadata: { agentId: 'external:runtime-reference' },
  });
  const output = await waitForActorTerminal(
    runtime, session.id, '/root/reference', started.turnId,
  );
  expect(output).toMatchObject({
    state: 'completed', output: 'runtime-ok',
  });
  expect(await runtime.agents.events(session.id, 0)).not.toHaveLength(0);
  return {
    sessionId: session.id,
    actorPath: '/root/reference',
    turnId: started.turnId,
    registrationJson: JSON.stringify(summary),
  };
}

describe('FEATURE_258 Embedded Runtime agent services', () => {
  it('blocks stop preflight while an external Actor turn is active', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-agent-preflight-'));
    const fixture = deferredExternalAgentFixture();
    const runtime = await createKodaXRuntime({
      homeDir,
      externalAgents: fixture.options,
    });
    try {
      await runtime.admin.agentRegistrations.upsert(fixture.registration);
      const session = await runtime.sessions.create({
        sessionId: 'external-preflight', title: 'External preflight',
      });
      const started = await runtime.agents.spawn(session.id, {
        taskName: 'deferred',
        kind: 'external',
        objective: 'Remain active during stop preflight',
        metadata: { agentId: fixture.registration.agentId },
      });

      await expect(runtime.status.preflight()).resolves.toMatchObject({
        activeWorkflows: [],
        activeAgentTurns: [expect.objectContaining({
          sessionId: session.id,
          actorPath: '/root/deferred',
          turnId: started.turnId,
        })],
        blockers: expect.arrayContaining(['active_agent_turns']),
        canStop: false,
      });

      fixture.finish();
      await expect(waitForActorTerminal(
        runtime, session.id, '/root/deferred', started.turnId,
      )).resolves.toMatchObject({ state: 'completed' });
      const settled = await runtime.status.preflight();
      expect(settled.activeAgentTurns).toEqual([]);
      expect(settled.blockers).not.toContain('active_agent_turns');
    } finally {
      fixture.finish();
      await runtime.close();
    }
  });

  it('provides redacted registration, shared catalog and durable task services', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-agents-'));
    const runtime = await createKodaXRuntime({
      homeDir,
      requirements: { externalAgents: true },
      externalAgents: externalAgentOptions(),
    });
    const result = await assertRuntimeAgentServiceConformance(runtime, 'runtime-host', 'parent-1');
    expect(result.registrationJson).not.toContain('private.invalid');
    await runtime.close();

    const reopened = await createKodaXRuntime({
      homeDir,
      externalAgents: externalAgentOptions(),
    });
    expect(await reopened.admin.agentRegistrations.list()).toHaveLength(1);
    await reopened.sessions.load(result.sessionId);
    expect(await reopened.agents.output(result.sessionId, result.actorPath, result.turnId)).toMatchObject({
      state: 'completed', output: 'runtime-ok',
    });
    await reopened.close();
  });

  it('publishes externalAgentAdmin capability metadata on the embedded runtime facade', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-agent-caps-'));
    const runtime = await createKodaXRuntime({
      homeDir,
      requirements: { externalAgents: true, externalAgentAdmin: 1 },
      externalAgents: externalAgentOptions(),
    });
    expect(runtime.capabilities).toMatchObject({
      externalAgents: true,
      externalAgentAdmin: { version: 1 },
    });
    await runtime.close();

    const plain = await createKodaXRuntime({ homeDir });
    expect(plain.capabilities?.externalAgentAdmin).toBeUndefined();
    await plain.close();
  });
  it('installs executor factories inside a public in-process daemon host', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-hosted-agents-'));
    const profile = `external-agent-${process.pid}-${Date.now()}`;
    const runtime = await createKodaXRuntime({
      mode: 'daemon',
      homeDir,
      profile,
      capabilities: { configAdmin: true },
      requirements: { externalAgents: true },
      externalAgents: externalAgentOptions(),
    });
    expect(runtime.identity).toMatchObject({ mode: 'daemon', isolation: 'inline' });
    expect(runtime.agents.enabled).toBe(true);
    expect(runtime.capabilities?.a2aConfigReconciler).toBeUndefined();
    const configOwnerRequirement = await connectKodaXRuntime({
      homeDir,
      profile,
      autoStart: false,
      requirements: { externalAgentAdmin: 1, a2aConfigReconciler: 1 },
    }).then(
      async (connected) => {
        await connected.close();
        return undefined;
      },
      (error: unknown) => error,
    );
    expect(configOwnerRequirement).toBeInstanceOf(Error);
    expect((configOwnerRequirement as Error).message).toMatch(/a2aConfigReconciler/i);
    await assertRuntimeAgentServiceConformance(runtime, 'daemon-sdk-host', 'daemon-sdk-parent');
    await expect(createKodaXRuntime({
      mode: 'daemon',
      homeDir,
      profile,
      capabilities: { configAdmin: true },
      externalAgents: externalAgentOptions(),
    })).rejects.toThrow(/already-running daemon profile/i);
    await runtime.close();
  });

  it('fails closed when the executor plane is not enabled', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-no-agents-'));
    await expect(createKodaXRuntime({
      homeDir,
      requirements: { externalAgents: true, externalAgentAdmin: 1 },
    })).rejects.toThrow(/required externalAgents capability/i);
    await expect(createKodaXRuntime({
      homeDir,
      requirements: { externalAgentAdmin: 1 },
    })).rejects.toThrow(/externalAgentAdmin capability/i);
    const runtime = await createKodaXRuntime({ homeDir });
    expect((await runtime.agents.listDispatchable({ actorId: 'runtime-host' }))
      .map((entry) => entry.descriptor.agentId)).toEqual(['native:kodax-child']);
    const session = await runtime.sessions.create({ sessionId: 'no-plane', title: 'No plane' });
    const failed = await runtime.agents.spawn(session.id, {
      taskName: 'missing',
      kind: 'external',
      objective: 'No plane',
      metadata: { agentId: 'external:missing' },
    });
    await expect(runtime.agents.wait(session.id, 2, 1_000)).resolves.toMatchObject({
      kind: 'turn_failed', turnId: failed.turnId,
    });
    await expect(runtime.agents.output(session.id, '/root/missing', failed.turnId)).resolves.toMatchObject({
      state: 'failed', error: expect.stringMatching(/only supports external actors|not attached|not bound/i),
    });
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    const initialized = await dispatcher.handle(createRuntimeDaemonRequest(
      'disabled-init',
      'initialize',
      { profile: 'default' },
    ));
    expect(isRuntimeDaemonSuccessResponse(initialized)).toBe(true);
    const listed = await dispatcher.handle(createRuntimeDaemonRequest(
      'disabled-list',
      'agents.listDispatchable',
      { actorId: 'runtime-host' },
    ));
    expect(isRuntimeDaemonSuccessResponse(listed)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(listed)) {
      expect(listed.result).toEqual([
        expect.objectContaining({ descriptor: expect.objectContaining({ agentId: 'native:kodax-child' }) }),
      ]);
    }
    dispatcher.close();
    await runtime.close();
  });

  it('exposes the same services through the daemon client facade', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-daemon-agents-'));
    const host = await createKodaXRuntime({
      homeDir,
      externalAgents: externalAgentOptions(),
    });
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: host,
      allowAgentRegistrationAdmin: true,
    });
    let requestSequence = 0;
    const request = async (method: RuntimeDaemonMethod, params?: unknown): Promise<unknown> => {
      requestSequence += 1;
      const response = await dispatcher.handle(createRuntimeDaemonRequest(
        `agent-daemon-${requestSequence}`,
        method,
        params,
      ));
      if (!isRuntimeDaemonSuccessResponse(response)) {
        throw new Error(`${response.error.code}: ${response.error.message}`);
      }
      return response.result;
    };

    const initialized = await request('initialize', {
      profile: 'default',
      capabilities: { configAdmin: true },
    });
    expect(initialized).toMatchObject({ capabilities: { externalAgents: true } });
    const daemon = createRuntimeDaemonClient({
      identity: host.identity,
      capabilities: initializedCapabilities(initialized),
      transport: {
        request,
        subscribe() { return { close() {} }; },
      },
    });

    expect(daemon.agents.enabled).toBe(true);
    await assertRuntimeAgentServiceConformance(daemon, 'daemon-host', 'daemon-parent');

    dispatcher.close();
    await daemon.close();
    await host.close();
  });

  it('drives registration lifecycle and Actor collaboration through the product client face (T30)', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-product-agents-'));
    let disposed = false;
    const factory: AgentExecutorFactory = {
      executorId: 'product-face-http',
      protocol: 'http',
      async create() {
        return {
          async start(input) {
            return { idempotencyKey: input.idempotencyKey ?? 'product-face-task' };
          },
          async *events() {
            yield { state: 'unknown' as const };
          },
          async get() { return { state: 'unknown' as const }; },
          async sendInput() {},
          async cancel() { return { state: 'canceled' as const }; },
          async reconcile() { return { state: 'unknown' as const }; },
          async dispose() { disposed = true; },
        };
      },
    };
    const runtime = await createKodaXRuntime({
      homeDir,
      externalAgents: {
        factories: [createReferenceAgentExecutorFactory({
          executorId: 'reference-http',
          protocol: 'http' as const,
        }), factory],
        policy: async () => ({ allowed: true }),
        defaultContext: { actorId: 'runtime-host' },
      },
    });
    const client = toKodaXProductClient(runtime);
    const session = await runtime.sessions.create({
      sessionId: 'product-face', title: 'Product face agents',
    });
    try {
      // 配置远端 Agent through the product face.
      const summary = await client.registrations.upsert(registration());
      expect(summary.agentId).toBe('external:runtime-reference');
      expect((await client.registrations.list()).map((entry) => entry.agentId))
        .toContain('external:runtime-reference');

      // 实际 dispatch: the reference executor completes in-process.
      const started = await client.agents.spawn(session.id, {
        taskName: 'reference',
        kind: 'external',
        objective: 'Dispatch through the product client face',
        metadata: { agentId: 'external:runtime-reference' },
      });
      const output = await clientFaceTerminal(client, session.id, '/root/reference', started.turnId);
      expect(output).toMatchObject({ state: 'completed', output: 'runtime-ok' });
      expect((await client.agents.tree(session.id)).actors.map((actor) => actor.path))
        .toContain('/root/reference');
      expect(await client.agents.detail(session.id, '/root/reference'))
        .toMatchObject({ actor: { path: '/root/reference' } });

      // 停用阻止新 admission.
      await client.registrations.setEnabled('external:runtime-reference', false);
      expect((await runtime.agents.listDispatchable({ actorId: 'runtime-host' }))
        .map((entry) => entry.descriptor.agentId))
        .not.toContain('external:runtime-reference');
      const blocked = await client.agents.spawn(session.id, {
        taskName: 'blocked',
        kind: 'external',
        objective: 'Must not admit while disabled',
        metadata: { agentId: 'external:runtime-reference' },
      });
      const blockedOutput = await clientFaceTerminal(client, session.id, '/root/blocked', blocked.turnId);
      expect(blockedOutput).toMatchObject({ state: 'failed' });

      // Local Actor messages and cancellation stay Host-controlled.
      await client.registrations.upsert({
        ...registration(),
        agentId: 'external:product-face',
        displayName: 'Product Face Agent',
        executorId: factory.executorId,
        configurationRevision: 'product-face-rev-1',
        endpointIdentityHash: 'sha256:product-face',
      });
      const active = await client.agents.spawn(session.id, {
        taskName: 'controlled',
        kind: 'external',
        objective: 'Stay active until cancelled',
        metadata: { agentId: 'external:product-face' },
      });
      await client.agents.send(session.id, '/root/controlled', 'status update', 'internal');
      await client.agents.interrupt(session.id, '/root/controlled', 'operator cancelled');
      const cancelled = await clientFaceTerminal(client, session.id, '/root/controlled', active.turnId);
      expect(cancelled.state).toBe('interrupted');

      // Host 退出关 watcher: executor resources dispose with the Host.
      await runtime.close();
      const disposeDeadline = Date.now() + 2_000;
      while (!disposed && Date.now() < disposeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(disposed).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});

function initializedCapabilities(result: unknown): Readonly<Record<string, unknown>> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('daemon initialize result is invalid');
  }
  const capabilities = (result as Record<string, unknown>).capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new Error('daemon initialize capabilities are invalid');
  }
  return capabilities as Readonly<Record<string, unknown>>;
}

async function waitForActorTerminal(
  runtime: KodaXRuntime,
  sessionId: string,
  actorPath: string,
  turnId: string,
): Promise<Awaited<ReturnType<KodaXRuntime['agents']['output']>>> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const output = await runtime.agents.output(sessionId, actorPath, turnId);
    if (output.state !== 'accepted' && output.state !== 'running') return output;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for Actor turn ${turnId}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function clientFaceTerminal(
  client: ReturnType<typeof toKodaXProductClient>,
  sessionId: string,
  actorPath: string,
  turnId: string,
): Promise<Awaited<ReturnType<typeof client.agents.output>>> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const output = await client.agents.output(sessionId, actorPath, turnId);
    if (output.state !== 'accepted' && output.state !== 'running') return output;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for Actor turn ${turnId}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
