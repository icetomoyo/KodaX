import { describe, expect, it, vi } from 'vitest';

import type { KodaXOptions } from '@kodax-ai/coding';
import type { KodaXRuntime, RuntimeEvent } from './sdk-runtime.js';
import {
  createReplRuntimeAutoModeControl,
  toDaemonRuntimeRunOptions,
  toPreparedRunStartOptions,
  toRuntimeOwnedInteractiveOptions,
} from './kodax_cli.js';
import { forwardDaemonCompactionEvent } from './run-progress-events.js';

describe('one-shot runtime option shaping and auto-mode settings', () => {
  it('projects only committed daemon compactions as legacy successes', () => {
    const onCompact = vi.fn();
    const onCompactEnd = vi.fn();
    const onContextCompactionFinished = vi.fn();
    const events = { onCompact, onCompactEnd, onContextCompactionFinished };
    const payload = {
      source: 'manual' as const,
      tokensBefore: 80_000,
      tokensAfter: 80_000,
      committed: false,
      elapsedMs: 10,
    };
    const event: RuntimeEvent = {
      id: 'event-1',
      seq: 1,
      time: '2026-08-08T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'context.compaction.finished',
      payload,
    };

    forwardDaemonCompactionEvent(events, event, payload);
    expect(onCompact).not.toHaveBeenCalled();
    expect(onContextCompactionFinished).toHaveBeenCalledWith(payload);

    const committedPayload = { ...payload, tokensAfter: 20_000, committed: true };
    forwardDaemonCompactionEvent(
      events,
      { ...event, id: 'event-2', payload: committedPayload },
      committedPayload,
    );
    expect(onCompact).toHaveBeenCalledWith(20_000, undefined);

    const endedPayload = {
      outcome: 'failed' as const,
      reason: 'summary_generation_failed' as const,
      failurePhase: 'summary_generation' as const,
      currentTokens: 300_000,
      compactableTokens: 280_000,
      consecutiveFailures: 3,
      circuitBreakerLimit: 3,
      circuitBreakerState: 'open' as const,
      cooldownTurnsRemaining: 2,
    };
    forwardDaemonCompactionEvent(
      events,
      { ...event, id: 'event-3', type: 'context.compaction.ended', payload: endedPayload },
      endedPayload,
    );
    expect(onCompactEnd).toHaveBeenCalledWith(undefined, endedPayload);
  });

  it('synchronizes Auto reviewer settings without writing an engine selector', async () => {
    const updateSettings = vi.fn(async () => ({ permissionMode: 'auto' }));
    const runtime = {
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        getSettings: vi.fn(async () => ({ permissionMode: 'auto' })),
        updateSettings,
        getAutoModeStats: vi.fn(async () => ({
          classifierHealth: 'healthy' as const,
          denials: {},
          breaker: {},
        })),
      },
    } as unknown as KodaXRuntime;
    const control = createReplRuntimeAutoModeControl(runtime);

    await control.syncSettings?.('session-1', 'auto', {
      classifierModel: 'review-provider:review-model',
    });

    expect(updateSettings).toHaveBeenCalledOnce();
    expect(updateSettings).toHaveBeenCalledWith('session-1', {
      permissionMode: 'auto',
      autoModeClassifierModel: 'review-provider:review-model',
    });
    expect(updateSettings.mock.calls[0]?.[1]).not.toHaveProperty('autoModeEngine');
  });

  it('ignores a persisted legacy Rules engine when a fresh REPL control synchronizes', async () => {
    const updateSettings = vi.fn(async () => ({
      permissionMode: 'auto',
      autoModeEngine: 'rules' as const,
    }));
    const runtime = {
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        getSettings: vi.fn(async () => ({
          permissionMode: 'auto',
          autoModeEngine: 'rules' as const,
        })),
        updateSettings,
        getAutoModeStats: vi.fn(async () => ({
          classifierHealth: 'healthy' as const,
          denials: {},
          breaker: {},
        })),
      },
    } as unknown as KodaXRuntime;

    const control = createReplRuntimeAutoModeControl(runtime);
    await control.syncSettings?.('session-1', 'auto', {});

    expect(updateSettings).toHaveBeenCalledWith('session-1', {
      permissionMode: 'auto',
      autoModeClassifierModel: null,
    });
    expect(updateSettings.mock.calls[0]?.[1]).not.toHaveProperty('autoModeEngine');
  });

  it('does not persist a new REPL session while synchronizing startup settings', async () => {
    const create = vi.fn(async () => ({ id: 'new-session' }));
    const getSettings = vi.fn(async () => ({ permissionMode: 'auto' }));
    const updateSettings = vi.fn(async () => ({ permissionMode: 'auto' }));
    const runtime = {
      sessions: {
        load: vi.fn(async () => {
          throw new Error('Session not found: new-session');
        }),
        create,
        getSettings,
        updateSettings,
        getAutoModeStats: vi.fn(async () => ({
          classifierHealth: 'healthy' as const,
          denials: {},
          breaker: {},
        })),
      },
    } as unknown as KodaXRuntime;

    const control = createReplRuntimeAutoModeControl(runtime);
    const stats = await control.syncSettings?.('new-session', 'auto', {});

    expect(stats).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('serializes rapid permission-mode changes so the last shortcut wins', async () => {
    let persistedMode = 'accept-edits';
    let releaseFirstUpdate: (() => void) | undefined;
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    let updateCount = 0;
    const updateSettings = vi.fn(async (_sessionId: string, patch: { permissionMode?: string }) => {
      updateCount += 1;
      if (updateCount === 1) await firstUpdateBlocked;
      if (patch.permissionMode !== undefined) persistedMode = patch.permissionMode;
      return { permissionMode: persistedMode };
    });
    const runtime = {
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        getSettings: vi.fn(async () => ({ permissionMode: persistedMode })),
        updateSettings,
        getAutoModeStats: vi.fn(async () => ({
          classifierHealth: 'healthy' as const,
          denials: {},
          breaker: {},
        })),
      },
    } as unknown as KodaXRuntime;
    const control = createReplRuntimeAutoModeControl(runtime);

    const first = control.syncSettings?.('session-1', 'plan', {});
    const second = control.syncSettings?.('session-1', 'auto', {});
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalled());
    await Promise.resolve();
    expect(updateSettings).toHaveBeenCalledTimes(1);
    releaseFirstUpdate?.();
    await Promise.all([first, second]);

    expect(persistedMode).toBe('auto');
  });

  it('builds an explicit JSON-safe run-options DTO for bridged callbacks', () => {
    const controller = new AbortController();
    const options = {
      provider: 'mock-provider',
      model: 'mock-model',
      abortSignal: controller.signal,
      events: {
        workflowCorrelation: { runId: 'workflow-1' },
        onTextDelta: () => undefined,
        beforeToolExecute: async () => true,
      },
      session: {
        id: 'session-1',
        storage: { load: async () => null },
        initialMessages: [{ role: 'user', content: 'hello' }],
      },
      context: {
        executionCwd: 'C:/workspace',
        configHome: 'C:/attacker-controlled-home',
        memoryIdentity: {
          configHome: 'C:/attacker-controlled-home',
          tenantId: 'attacker-tenant',
          agentId: 'attacker-agent',
          projectId: 'attacker-project',
          sessionId: 'attacker-session',
        },
        shellExecution: {
          version: 1,
          shell: { kind: 'pwsh', profile: 'none' },
          environment: { inherit: 'filtered' },
        },
        skillRegistry: {
          has: () => true,
          loadFull: async () => ({ name: 'host-only' }),
        },
      },
      skillDynamicContext: {
        disable: true,
      },
      sandbox: { envPass: ['GH_TOKEN'] },
    } as unknown as KodaXOptions;

    const wire = toDaemonRuntimeRunOptions(toRuntimeOwnedInteractiveOptions(
      options,
      { omitLegacyBeforeToolExecute: true },
    ));
    const encoded = JSON.stringify(wire);

    expect(wire).toMatchObject({
      provider: 'mock-provider',
      model: 'mock-model',
      session: {
        id: 'session-1',
        initialMessages: [{ role: 'user', content: 'hello' }],
      },
      context: {
        executionCwd: 'C:/workspace',
        shellExecution: {
          version: 1,
          shell: { kind: 'pwsh', profile: 'none' },
          environment: { inherit: 'filtered' },
        },
      },
      events: { workflowCorrelation: { runId: 'workflow-1' } },
      skillDynamicContext: { disable: true },
      sandbox: { envPass: ['GH_TOKEN'] },
    });
    expect(encoded).not.toContain('abortSignal');
    expect(encoded).not.toContain('storage');
    expect(encoded).not.toContain('attacker-controlled');
    expect(wire.context).not.toHaveProperty('configHome');
    expect(wire.context).not.toHaveProperty('memoryIdentity');
    expect(wire.context).not.toHaveProperty('skillRegistry');
  });

  it('rejects host-only bindings that the daemon cannot reproduce', () => {
    expect(() => toDaemonRuntimeRunOptions({
      provider: 'mock-provider',
      extensionRuntime: { activate: () => undefined },
    } as unknown as KodaXOptions)).toThrow(/extensionRuntime.*cannot cross/i);

    expect(() => toDaemonRuntimeRunOptions({
      provider: 'mock-provider',
      context: { planModeBlockCheck: () => null },
    } as unknown as KodaXOptions)).toThrow(/context\.planModeBlockCheck.*cannot cross/i);

    expect(() => toDaemonRuntimeRunOptions({
      provider: 'mock-provider',
      memoryRecallRunner: async () => ({ selectedRefIds: [] }),
    } as unknown as KodaXOptions)).toThrow(/memoryRecallRunner.*cannot cross/i);
  });

  it('preserves custom host policy hooks unless the REPL marks its legacy permission hook', () => {
    const beforeToolExecute = vi.fn(async () => true);
    const onTextDelta = vi.fn();
    const customGuardrail = { kind: 'tool' as const, name: 'custom-policy' };
    const preserved = toRuntimeOwnedInteractiveOptions({
      guardrails: [{ kind: 'tool', name: 'auto-mode' }, customGuardrail],
      events: { beforeToolExecute, onTextDelta },
    } as unknown as KodaXOptions);

    expect(preserved.guardrails).toEqual([customGuardrail]);
    expect(preserved.events?.beforeToolExecute).toBe(beforeToolExecute);
    expect(preserved.events?.onTextDelta).toBe(onTextDelta);

    const sanitized = toRuntimeOwnedInteractiveOptions(
      {
        guardrails: [{ kind: 'tool', name: 'auto-mode' }, customGuardrail],
        events: { beforeToolExecute, onTextDelta },
      } as unknown as KodaXOptions,
      { omitLegacyBeforeToolExecute: true },
    );
    expect(sanitized.guardrails).toEqual([customGuardrail]);
    expect(sanitized.events?.beforeToolExecute).toBeUndefined();
    expect(sanitized.events?.onTextDelta).toBe(onTextDelta);
  });

  it('rejects a custom beforeToolExecute policy that cannot cross the daemon boundary', () => {
    expect(() => toDaemonRuntimeRunOptions({
      events: { beforeToolExecute: async () => true },
    } as unknown as KodaXOptions)).toThrow(/events\.beforeToolExecute.*cannot cross/i);

    expect(() => toDaemonRuntimeRunOptions({
      learningReviewer: async () => ({
        schemaVersion: 1,
        summary: 'custom review',
        memoryPlan: { actions: [], warnings: [] },
        skillPlan: { actions: [], warnings: [] },
      }),
    } as unknown as KodaXOptions)).toThrow(/learningReviewer.*cannot cross/i);
  });

  it('wraps Skill policy and strips callbacks for a daemon prepared run', () => {
    const shaped = toPreparedRunStartOptions(
      { mode: 'daemon', isolation: 'process' },
      {
        provider: 'mock-provider',
        events: { beforeToolExecute: async () => true },
        context: {
          skillInvocation: {
            name: 'transport-skill',
            path: 'C:/skills/transport-skill/SKILL.md',
            expandedContent: '<skill name="transport-skill">test</skill>',
            runtimePolicy: {},
          },
        },
      } as unknown as KodaXOptions,
    );

    expect(shaped).toMatchObject({
      context: {
        skillInvocation: {
          runtimePolicy: { enforceAtRuntime: true },
        },
      },
    });
    const serialized = JSON.stringify(shaped);
    expect(serialized).not.toContain('beforeToolExecute');
  });

  it('transport-sanitizes run options for a Worker-hosted embedded runtime', () => {
    const shaped = toPreparedRunStartOptions(
      { mode: 'embedded', isolation: 'worker' },
      {
        provider: 'mock-provider',
        extensionRuntime: { activate: async () => undefined },
        events: {
          beforeToolExecute: async () => true,
          onTextDelta: () => undefined,
          workflowCorrelation: { runId: 'workflow-1' },
        },
        session: {
          id: 'session-1',
          storage: { load: async () => null },
          initialMessages: [{ role: 'user', content: 'hello' }],
        },
        context: {
          executionCwd: 'C:/workspace',
          skillInvocation: {
            name: 'transport-skill',
            path: 'C:/skills/transport-skill/SKILL.md',
            expandedContent: '<skill name="transport-skill">test</skill>',
            runtimePolicy: {},
          },
          memoryIdentity: {
            configHome: 'C:/host-home',
            tenantId: 'host-tenant',
            agentId: 'host-agent',
            projectId: 'host-project',
            sessionId: 'host-session',
          },
        },
      } as unknown as KodaXOptions,
    );

    expect(shaped).toMatchObject({
      provider: 'mock-provider',
      session: { id: 'session-1' },
      context: {
        executionCwd: 'C:/workspace',
        skillInvocation: {
          runtimePolicy: { enforceAtRuntime: true },
        },
      },
      events: { workflowCorrelation: { runId: 'workflow-1' } },
    });
    const serialized = JSON.stringify(shaped);
    expect(serialized).not.toContain('beforeToolExecute');
    expect(serialized).not.toContain('onTextDelta');
    expect(serialized).not.toContain('storage');
    expect(serialized).not.toContain('memoryIdentity');
    expect((shaped as { extensionRuntime?: unknown }).extensionRuntime).toBeUndefined();
  });

  it('keeps run options intact for an inline embedded runtime', () => {
    const beforeToolExecute = vi.fn(async () => true);
    const extensionRuntime = { activate: async () => undefined };
    const options = {
      provider: 'mock-provider',
      extensionRuntime,
      events: { beforeToolExecute },
    } as unknown as KodaXOptions;

    const shaped = toPreparedRunStartOptions(
      { mode: 'embedded', isolation: 'inline' },
      options,
    );

    expect(shaped).toMatchObject({ provider: 'mock-provider', extensionRuntime });
    expect((shaped as { events?: { beforeToolExecute?: unknown } }).events?.beforeToolExecute)
      .toBe(beforeToolExecute);
  });
});
