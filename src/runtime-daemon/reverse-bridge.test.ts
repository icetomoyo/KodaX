import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { RuntimeDaemonNotification } from './protocol.js';
import {
  createRuntimeDaemonReverseBridge,
  createRuntimeDaemonReverseBridgeHub,
} from './reverse-bridge.js';

describe('runtime daemon reverse bridge', () => {
  it('recovers a durably dispatched host invocation as unknown without replay', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-host-invocation-'));
    const stateFile = path.join(root, 'invocations.json');
    try {
      const firstHub = createRuntimeDaemonReverseBridgeHub({ invocationStateFile: stateFile });
      const notifications: RuntimeDaemonNotification[] = [];
      const first = firstHub.attach({
        principalId: 'space-client',
        connectionId: 'connection-1',
        instanceSecret: 's'.repeat(32),
        notify: (notification) => notifications.push(notification),
      });
      first.bridge.registerHostTools({
        leaseId: 'space-tools',
        tools: [{
          name: 'space_control',
          description: 'Mutate Space state',
          inputSchema: { type: 'object' },
          sideEffect: 'non_idempotent',
        }],
      });
      const runtime = first.bridge.createHostToolRuntime({
        leaseId: 'space-tools',
        sessionId: 'session-space',
        runId: 'run-space',
      });
      const [descriptor] = await runtime.searchCapabilities('mcp', 'space_control', {
        kind: 'tool',
      }) as Array<{ readonly id: string }>;
      if (!descriptor) throw new Error('expected host tool descriptor');
      const execution = runtime.executeCapability('mcp', descriptor.id, {});
      const invocationId = readString(notifications[0]?.params, 'invocationId');
      expect(first.bridge.getHostToolInvocation(invocationId)).toMatchObject({ state: 'dispatched' });

      const recoveredHub = createRuntimeDaemonReverseBridgeHub({ invocationStateFile: stateFile });
      const recoveredNotifications: RuntimeDaemonNotification[] = [];
      const recovered = recoveredHub.attach({
        principalId: 'space-client',
        connectionId: 'connection-2',
        instanceSecret: 's'.repeat(32),
        notify: (notification) => recoveredNotifications.push(notification),
      });
      expect(recovered.bridge.getHostToolInvocation(invocationId)).toMatchObject({ state: 'unknown' });
      expect(recoveredNotifications).toEqual([]);

      recovered.close();
      recoveredHub.close();
      firstHub.close();
      await expect(execution).rejects.toMatchObject({ code: 'host_tool_unknown' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes a prepared host call for the same authenticated stable client', async () => {
    const hub = createRuntimeDaemonReverseBridgeHub();
    const firstNotifications: RuntimeDaemonNotification[] = [];
    const first = hub.attach({
      principalId: 'space-client',
      connectionId: 'connection-1',
      instanceSecret: 's'.repeat(32),
      notify: (notification) => firstNotifications.push(notification),
    });
    first.bridge.registerHostTools({
      leaseId: 'space-tools',
      tools: [{
        name: 'space_artifact_create',
        description: 'Create an artifact in Space',
        inputSchema: { type: 'object' },
        sideEffect: 'non_idempotent',
      }],
    });
    const runtime = first.bridge.createHostToolRuntime({
      leaseId: 'space-tools',
      sessionId: 'session-space',
      runId: 'run-space',
    });
    await expect(runtime.searchCapabilities('mcp', '', {
      kind: 'tool',
      server: 'db-query-server',
    })).resolves.toEqual([]);
    await expect(runtime.searchCapabilitySnapshot?.('mcp', '', {
      kind: 'tool',
      server: 'host',
    })).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'space_artifact_create', server: 'host' })],
      complete: true,
      freshness: 'live',
    });
    const [descriptor] = await runtime.searchCapabilities('mcp', 'space_artifact_create', {
      kind: 'tool',
      server: 'host',
    }) as Array<{ readonly id: string }>;
    if (!descriptor) throw new Error('expected host tool descriptor');
    expect(hub.getRunRequirements('run-space')).toMatchObject({
      hostTools: { leaseId: 'space-tools', state: 'ready' },
    });
    first.close();
    expect(hub.getRunRequirements('run-space')).toMatchObject({
      hostTools: { leaseId: 'space-tools', state: 'waiting_host' },
    });

    const execution = runtime.executeCapability('mcp', descriptor.id, { title: 'Report' });
    expect(firstNotifications).toEqual([]);
    const resumedNotifications: RuntimeDaemonNotification[] = [];
    const resumed = hub.attach({
      principalId: 'space-client',
      connectionId: 'connection-2',
      instanceSecret: 's'.repeat(32),
      notify: (notification) => resumedNotifications.push(notification),
    });
    expect(resumed.bridge.getHostTools('space-tools')).toMatchObject({ id: 'space-tools' });
    expect(hub.getRunRequirements('run-space')).toMatchObject({
      hostTools: { leaseId: 'space-tools', state: 'ready' },
    });
    const invocationId = readString(resumedNotifications[0]?.params, 'invocationId');
    expect(resumed.bridge.completeHostTool({
      invocationId,
      result: { content: 'artifact-created' },
    })).toBe(true);
    await expect(execution).resolves.toMatchObject({ content: 'artifact-created' });

    const attacker = hub.attach({
      principalId: 'space-client',
      connectionId: 'connection-3',
      instanceSecret: 'x'.repeat(32),
      notify: () => undefined,
    });
    expect(() => attacker.bridge.createHostToolRuntime({
      leaseId: 'space-tools',
      sessionId: 'session-space',
      runId: 'run-space-2',
    })).toThrow(/missing/i);
    attacker.close();
    resumed.close();
    hub.close();
  });

  it('never replays a host call whose dispatch outcome became unknown', async () => {
    const hub = createRuntimeDaemonReverseBridgeHub();
    const notifications: RuntimeDaemonNotification[] = [];
    const first = hub.attach({
      principalId: 'space-client',
      connectionId: 'connection-1',
      instanceSecret: 's'.repeat(32),
      notify: (notification) => notifications.push(notification),
    });
    first.bridge.registerHostTools({
      leaseId: 'space-tools',
      tools: [{
        name: 'space_control',
        description: 'Mutate Space state',
        inputSchema: { type: 'object' },
        sideEffect: 'non_idempotent',
      }],
    });
    const runtime = first.bridge.createHostToolRuntime({
      leaseId: 'space-tools',
      sessionId: 'session-space',
      runId: 'run-space',
    });
    const [descriptor] = await runtime.searchCapabilities('mcp', 'space_control', {
      kind: 'tool',
    }) as Array<{ readonly id: string }>;
    if (!descriptor) throw new Error('expected host tool descriptor');
    const execution = runtime.executeCapability('mcp', descriptor.id, {});
    expect(notifications).toHaveLength(1);

    first.close();
    await expect(execution).rejects.toMatchObject({ code: 'host_tool_unknown' });
    const resumedNotifications: RuntimeDaemonNotification[] = [];
    const resumed = hub.attach({
      principalId: 'space-client',
      connectionId: 'connection-2',
      instanceSecret: 's'.repeat(32),
      notify: (notification) => resumedNotifications.push(notification),
    });
    expect(resumedNotifications).toEqual([]);
    resumed.close();
    hub.close();
  });

  it('delivers scoped credentials in memory and never exposes them in the lease', async () => {
    const notifications: RuntimeDaemonNotification[] = [];
    const bridge = createRuntimeDaemonReverseBridge((notification) => notifications.push(notification));
    const lease = bridge.registerCredential({
      leaseId: 'credential-space',
      providers: ['openai'],
    });

    const acquired = bridge.acquireCredential({
      leaseId: lease.id,
      provider: 'openai',
      sessionId: 'session-1',
      runId: 'run-1',
    });
    const request = notifications[0];
    expect(request?.method).toBe('credential.request');
    const requestId = readString(request?.params, 'requestId');
    expect(JSON.stringify(lease)).not.toContain('secret-value');
    expect(bridge.supplyCredential({ requestId, credential: 'secret-value' })).toBe(true);
    await expect(acquired).resolves.toBe('secret-value');
    expect(bridge.getRunRequirements('run-1')).toMatchObject({
      credential: { leaseId: lease.id, provider: 'openai', state: 'ready' },
    });

    await expect(bridge.acquireCredential({
      leaseId: lease.id,
      provider: 'anthropic',
      sessionId: 'session-1',
      runId: 'run-2',
    })).rejects.toMatchObject({ code: 'credential_unavailable' });
    bridge.close();
  });

  it('does not accept a credential after its lease expires in flight', async () => {
    vi.useFakeTimers();
    try {
      const notifications: RuntimeDaemonNotification[] = [];
      const bridge = createRuntimeDaemonReverseBridge((notification) => notifications.push(notification));
      bridge.registerCredential({
        leaseId: 'credential-expiring',
        providers: ['openai'],
        expiresAt: new Date(Date.now() + 100).toISOString(),
      });
      const acquired = bridge.acquireCredential({
        leaseId: 'credential-expiring',
        provider: 'openai',
        sessionId: 'session-1',
        runId: 'run-1',
      });
      const outcome = acquired.then(
        () => undefined,
        (error: unknown) => error,
      );
      const requestId = readString(notifications[0]?.params, 'requestId');

      await vi.advanceTimersByTimeAsync(101);

      expect(bridge.supplyCredential({ requestId, credential: 'too-late' })).toBe(false);
      await expect(outcome).resolves.toMatchObject({ code: 'credential_unavailable' });
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes ephemeral credentials on disconnect but preserves stable leases for resume', () => {
    const hub = createRuntimeDaemonReverseBridgeHub();
    const ephemeral = hub.attach({
      principalId: 'space-client',
      connectionId: 'ephemeral-1',
      notify: () => undefined,
    });
    ephemeral.bridge.registerCredential({
      leaseId: 'ephemeral-credential',
      providers: ['openai'],
      brokerVersion: 2,
    });
    const ephemeralSignal = ephemeral.bridge.credentialSignal('ephemeral-credential');
    ephemeral.close();
    expect(ephemeralSignal?.aborted).toBe(true);
    expect(ephemeral.bridge.getCredential('ephemeral-credential')).toBeUndefined();

    const stable = hub.attach({
      principalId: 'space-client',
      connectionId: 'stable-1',
      instanceSecret: 's'.repeat(32),
      notify: () => undefined,
    });
    stable.bridge.registerCredential({
      leaseId: 'stable-credential',
      providers: ['openai'],
      brokerVersion: 2,
    });
    const stableSignal = stable.bridge.credentialSignal('stable-credential');
    stable.close();
    expect(stableSignal?.aborted).toBe(false);
    const resumed = hub.attach({
      principalId: 'space-client',
      connectionId: 'stable-2',
      instanceSecret: 's'.repeat(32),
      notify: () => undefined,
    });
    expect(resumed.bridge.getCredential('stable-credential')).toMatchObject({
      id: 'stable-credential',
    });
    resumed.close();
    hub.close();
  });

  it('dispatches v2 credential requests with an operation target and no synthetic run', async () => {
    const notifications: RuntimeDaemonNotification[] = [];
    const bridge = createRuntimeDaemonReverseBridge((notification) => notifications.push(notification));
    const lease = bridge.registerCredential({
      leaseId: 'credential-operation',
      providers: ['openai', 'anthropic'],
      brokerVersion: 2,
    });
    expect(lease).toMatchObject({ brokerVersion: 2 });

    const acquired = bridge.acquireScopedCredential({
      leaseId: lease.id,
      provider: 'anthropic',
      sessionId: 'session-1',
      target: {
        kind: 'operation',
        operation: 'session.compact',
        operationId: 'compact-op-1',
      },
      purpose: 'compaction',
    });
    const request = notifications[0];
    expect(request?.params).toMatchObject({
      brokerVersion: 2,
      leaseId: lease.id,
      provider: 'anthropic',
      sessionId: 'session-1',
      target: {
        kind: 'operation',
        operation: 'session.compact',
        operationId: 'compact-op-1',
      },
      purpose: 'compaction',
    });
    expect(request?.params).not.toHaveProperty('runId');
    expect(bridge.supplyCredential({
      requestId: readString(request?.params, 'requestId'),
      credential: 'operation-secret',
    })).toBe(true);
    await expect(acquired).resolves.toBe('operation-secret');
    await expect(bridge.acquireCredential({
      leaseId: lease.id,
      provider: 'openai',
      sessionId: 'session-1',
      runId: 'run-1',
    })).rejects.toMatchObject({ code: 'credential_unavailable' });
    bridge.close();
  });

  it('does not dispatch a credential request for an already-cancelled operation', async () => {
    const notifications: RuntimeDaemonNotification[] = [];
    const bridge = createRuntimeDaemonReverseBridge((notification) => notifications.push(notification));
    bridge.registerCredential({
      leaseId: 'credential-cancelled-before-acquire',
      providers: ['openai'],
      brokerVersion: 2,
    });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(bridge.acquireScopedCredential({
      leaseId: 'credential-cancelled-before-acquire',
      provider: 'openai',
      sessionId: 'session-1',
      target: {
        kind: 'operation',
        operation: 'session.compact',
        operationId: 'cancelled-op',
      },
      purpose: 'compaction',
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(notifications).toEqual([]);
    bridge.close();
  });

  it('linearizes revocation before a late credential supply', async () => {
    const notifications: RuntimeDaemonNotification[] = [];
    const bridge = createRuntimeDaemonReverseBridge((notification) => notifications.push(notification));
    bridge.registerCredential({
      leaseId: 'credential-revoked-in-flight',
      providers: ['openai'],
    });
    const acquired = bridge.acquireCredential({
      leaseId: 'credential-revoked-in-flight',
      provider: 'openai',
      sessionId: 'session-1',
      runId: 'run-1',
    });
    const outcome = acquired.then(
      () => undefined,
      (error: unknown) => error,
    );
    const requestId = readString(notifications[0]?.params, 'requestId');

    expect(bridge.revokeCredential('credential-revoked-in-flight')).toBe(true);
    expect(bridge.supplyCredential({ requestId, credential: 'too-late' })).toBe(false);
    await expect(outcome).resolves.toMatchObject({ code: 'credential_unavailable' });
    expect(bridge.getRunRequirements('run-1')).toBeUndefined();
    bridge.close();
  });

  it('prunes expired credential leases before registering a replacement', () => {
    vi.useFakeTimers();
    try {
      const bridge = createRuntimeDaemonReverseBridge(() => undefined);
      bridge.registerCredential({
        leaseId: 'credential-renewed',
        providers: ['openai'],
        expiresAt: new Date(Date.now() + 100).toISOString(),
      });
      vi.advanceTimersByTime(101);

      expect(bridge.registerCredential({
        leaseId: 'credential-renewed',
        providers: ['anthropic'],
      })).toMatchObject({ id: 'credential-renewed', providers: ['anthropic'] });
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an active scoped credential signal exactly when the lease expires', async () => {
    vi.useFakeTimers();
    try {
      const bridge = createRuntimeDaemonReverseBridge(() => undefined);
      bridge.registerCredential({
        leaseId: 'credential-active-expiry',
        providers: ['openai'],
        brokerVersion: 2,
        expiresAt: new Date(Date.now() + 100).toISOString(),
      });
      const signal = bridge.credentialSignal('credential-active-expiry');
      expect(signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(101);

      expect(signal?.aborted).toBe(true);
      expect(bridge.getCredential('credential-active-expiry')).toBeUndefined();
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('binds host tools to one run and marks disconnect outcomes unknown', async () => {
    const notifications: RuntimeDaemonNotification[] = [];
    const bridge = createRuntimeDaemonReverseBridge((notification) => notifications.push(notification));
    bridge.registerHostTools({
      leaseId: 'space-tools',
      tools: [{
        name: 'space_artifact_create',
        description: 'Create an artifact in Space',
        inputSchema: { type: 'object' },
        sideEffect: 'non_idempotent',
      }],
    });
    const runtime = bridge.createHostToolRuntime({
      leaseId: 'space-tools',
      sessionId: 'session-space',
      runId: 'run-space',
    });
    const [descriptor] = await runtime.searchCapabilities('mcp', 'space_artifact_create', {
      kind: 'tool',
    }) as Array<{ readonly id: string }>;
    if (!descriptor) throw new Error('expected host tool descriptor');

    const executed = runtime.executeCapability('mcp', descriptor.id, { title: 'Report' });
    const invocation = notifications.find((item) => item.method === 'host_tool.invoke');
    const invocationId = readString(invocation?.params, 'invocationId');
    expect(() => bridge.completeHostTool({
      invocationId,
      result: {} as never,
    })).toThrow(/content/i);
    expect(bridge.completeHostTool({
      invocationId,
      result: { content: 'artifact-1' },
    })).toBe(true);
    await expect(executed).resolves.toMatchObject({ content: 'artifact-1' });

    const uncertain = runtime.executeCapability('mcp', descriptor.id, { title: 'Second' });
    bridge.close();
    await expect(uncertain).rejects.toMatchObject({ code: 'host_tool_unknown' });
  });

  it('rejects lease replacement and classifies post-dispatch transport failures as unknown', async () => {
    const bridge = createRuntimeDaemonReverseBridge(() => {
      throw new Error('transport closed');
    });
    bridge.registerCredential({
      leaseId: 'space-credential',
      providers: ['openai'],
    });
    await expect(bridge.acquireCredential({
      leaseId: 'space-credential',
      provider: 'openai',
      sessionId: 'session-space',
      runId: 'run-space',
    })).rejects.toMatchObject({ code: 'credential_unavailable' });

    bridge.registerHostTools({
      leaseId: 'space-tools',
      tools: [{
        name: 'space_control',
        description: 'Control Space',
        inputSchema: { type: 'object' },
        sideEffect: 'non_idempotent',
      }],
    });
    expect(() => bridge.registerHostTools({
      leaseId: 'space-tools',
      tools: [{
        name: 'space_control',
        description: 'Replace Space control',
        inputSchema: { type: 'object' },
        sideEffect: 'none',
      }],
    })).toThrow(/already registered/i);

    const runtime = bridge.createHostToolRuntime({
      leaseId: 'space-tools',
      sessionId: 'session-space',
      runId: 'run-space',
    });
    const [descriptor] = await runtime.searchCapabilities(
      'mcp',
      'space_control',
      { kind: 'tool' },
    ) as Array<{ readonly id: string }>;
    if (!descriptor) throw new Error('expected host tool descriptor');

    await expect(runtime.executeCapability('mcp', descriptor.id, {}))
      .rejects.toMatchObject({ code: 'host_tool_unknown' });
    bridge.close();
  });

  it('revokes host tools from runs that already captured the lease binding', async () => {
    const notifications: RuntimeDaemonNotification[] = [];
    const bridge = createRuntimeDaemonReverseBridge((notification) => notifications.push(notification));
    bridge.registerHostTools({
      leaseId: 'space-tools',
      tools: [{
        name: 'space_control',
        description: 'Control Space',
        inputSchema: { type: 'object' },
        sideEffect: 'non_idempotent',
      }],
    });
    const runtime = bridge.createHostToolRuntime({
      leaseId: 'space-tools',
      sessionId: 'session-space',
      runId: 'run-space',
    });
    const [descriptor] = await runtime.searchCapabilities('mcp', 'space_control', {
      kind: 'tool',
    }) as Array<{ readonly id: string }>;
    if (!descriptor) throw new Error('expected host tool descriptor');

    expect(bridge.revokeHostTools('space-tools')).toBe(true);
    await expect(runtime.executeCapability('mcp', descriptor.id, {}))
      .rejects.toMatchObject({ code: 'host_tool_unavailable' });
    expect(notifications).toEqual([]);
    bridge.close();
  });

  it('rejects host tool lease ids with reserved characters', () => {
    const bridge = createRuntimeDaemonReverseBridge(() => {});
    expect(() => bridge.registerHostTools({
      leaseId: 'space:tools',
      tools: [{
        name: 'space_tool',
        description: 'Reserved characters must be rejected',
        inputSchema: { type: 'object' },
        sideEffect: 'none',
      }],
    })).toThrow(/lease ID/i);
    bridge.close();
  });

  it('materializes bound host tools as run-scoped definitions with fail-closed metadata', async () => {
    const bridge = createRuntimeDaemonReverseBridge(() => {});
    bridge.registerHostTools({
      leaseId: 'space-tools',
      tools: [
        {
          name: 'space_artifact_create',
          description: 'Create an artifact in Space',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
          sideEffect: 'non_idempotent',
        },
        {
          name: 'space_artifact_read',
          description: 'Read an artifact',
          inputSchema: { type: 'object' },
          sideEffect: 'none',
        },
        {
          name: 'space_verbose',
          description: 'v'.repeat(400),
          inputSchema: { type: 'object' },
          sideEffect: 'idempotent',
        },
      ],
    });
    const runtime = bridge.createHostToolRuntime({
      leaseId: 'space-tools',
      sessionId: 'session-space',
      runId: 'run-space',
    });
    const definitions = runtime.listRunTools?.('mcp') ?? [];
    expect(definitions).toHaveLength(3);
    expect(definitions.find((definition) => definition.name === 'space_artifact_create')).toMatchObject({
      capabilityId: 'host:space-tools:space_artifact_create',
      sideEffect: 'mutates-state',
      planModeAllowed: false,
    });
    expect(definitions.find((definition) => definition.name === 'space_artifact_read')).toMatchObject({
      sideEffect: 'readonly',
      planModeAllowed: true,
    });
    const verbose = definitions.find((definition) => definition.name === 'space_verbose');
    expect(verbose !== undefined && verbose.description.length <= 200).toBe(true);
    expect(runtime.listRunTools?.('github') ?? []).toHaveLength(0);

    // Revoking the lease removes the materialized surface fail-closed across
    // every discovery channel (run tools, prompt context, search, describe).
    expect(bridge.revokeHostTools('space-tools')).toBe(true);
    expect(runtime.listRunTools?.('mcp') ?? []).toHaveLength(0);
    await expect(runtime.getCapabilityPromptContext('mcp')).resolves.toBeUndefined();
    await expect(runtime.searchCapabilities('mcp', 'artifact', { kind: 'tool', server: 'host' }))
      .resolves.toHaveLength(0);
    await expect(runtime.describeCapability('mcp', 'host:space-tools:space_artifact_create'))
      .resolves.toBeUndefined();
    bridge.close();  });

  it('advertises a content-stable host capability catalog line', async () => {
    const bridge = createRuntimeDaemonReverseBridge(() => {});
    const register = () => bridge.registerHostTools({
      leaseId: 'space-tools',
      tools: [{
        name: 'space_artifact_create',
        description: 'Create an artifact in Space',
        inputSchema: { type: 'object' },
        sideEffect: 'non_idempotent',
      }],
    });
    register();
    const runtime = bridge.createHostToolRuntime({
      leaseId: 'space-tools',
      sessionId: 'session-space',
      runId: 'run-space',
    });
    const first = await runtime.getCapabilityPromptContext('mcp');
    expect(first).toBeDefined();
    expect(first).toContain('## Host Capability Provider (run-bound)');
    expect(first).toContain('"host": 1 tools / 0 resources / 0 prompts');
    expect(first).toContain('space_artifact_create');
    const revision = /revision=([0-9a-f]+)/.exec(first ?? '')?.[1];
    expect(revision).toBeDefined();

    // Same tool set under a fresh binding keeps the same revision (the hash
    // covers content, not the per-run lease id).
    bridge.revokeHostTools('space-tools');
    register();
    const second = await bridge.createHostToolRuntime({
      leaseId: 'space-tools',
      sessionId: 'session-space',
      runId: 'run-space-2',
    }).getCapabilityPromptContext('mcp');
    expect(/revision=([0-9a-f]+)/.exec(second ?? '')?.[1]).toBe(revision);
    bridge.close();
  });
});

function readString(value: unknown, key: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== 'string') throw new Error(`expected string ${key}`);
  return candidate;
}
