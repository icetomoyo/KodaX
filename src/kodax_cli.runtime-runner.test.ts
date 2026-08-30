import { describe, expect, it, vi } from 'vitest';

import type { KodaXOptions, KodaXResult } from '@kodax-ai/coding';
import type {
  KodaXRuntime,
  RuntimeEvent,
  RuntimeStartRunInput,
} from './sdk-runtime.js';
import {
  createInteractiveRuntimeRunner,
  createReplRuntimeAutoModeControl,
  forwardDaemonCompactionEvent,
  toDaemonRuntimeRunOptions,
  toRuntimeOwnedInteractiveOptions,
} from './kodax_cli.js';

describe('interactive daemon runtime bridge', () => {
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

  it('forwards daemon stream events and returns the selected Runtime-issued grant', async () => {
    const onTextDelta = vi.fn();
    const onPromptCacheDiagnostics = vi.fn();
    const legacyBeforeToolExecute = vi.fn(async () => true);
    const requestPermission = vi.fn(async () => ({
      type: 'allow_always' as const,
      suggestionId: 'grant-persistent-1',
    }));
    const updateSettings = vi.fn(async () => ({ permissionMode: 'plan' }));
    const respond = vi.fn(async () => true);
    const closeSubscription = vi.fn();
    let eventListener: ((event: RuntimeEvent) => void) | undefined;
    let capturedStart: RuntimeStartRunInput | undefined;
    const start = vi.fn(async (input: RuntimeStartRunInput) => {
      capturedStart = input;
      eventListener?.(runtimeEvent('tool.started', {
        tool: { id: 'tool-1', name: 'write', input: { path: 'C:/workspace/a.ts' } },
      }));
      eventListener?.(runtimeEvent('assistant.delta', { text: 'streamed' }));
      eventListener?.(runtimeEvent('provider.cache.diagnostics', {
        phase: 'response',
        requestId: 'cache-request-1',
        requestedAt: '2026-07-10T00:00:00.000Z',
        completedAt: '2026-07-10T00:00:01.000Z',
        provider: 'zai',
        model: 'glm-5.2',
        wireModel: 'glm-5.2',
        attempt: 1,
        systemPromptHash: 'system-hash',
        toolSchemaHash: 'tool-hash',
        messagePrefixHash: 'prefix-hash',
        messagePrefixCount: 2,
        requestMessagesHash: 'messages-hash',
        messageCount: 3,
        toolCount: 4,
        cachedReadTokens: 19_328,
      }));
      eventListener?.(runtimeEvent('permission.requested', {
        id: 'perm-1',
        toolCallId: 'tool-1',
        toolName: 'write',
        inputPreview: '{"path":"wrong-fallback"}',
        reason: 'Runtime classification requires confirmation.',
        risk: 'medium',
        executionCwd: 'C:/workspace',
        grantSuggestions: [{
          id: 'grant-persistent-1',
          kind: 'persistent',
          label: 'Always allow write for C:/workspace/a.ts',
        }],
      }));
      return {
        runId: 'run-1',
        sessionId: 'session-1',
        result: Promise.resolve({
          runId: 'run-1',
          sessionId: 'session-1',
          phase: 'completed' as const,
          result: successfulResult(),
        }),
      };
    });
    const runtime = {
      identity: {
        runtimeId: 'runtime-1',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-10T00:00:00.000Z',
        version: 'test',
      },
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        getSettings: vi.fn(async () => ({ permissionMode: 'plan' })),
        updateSettings,
      },
      runs: { start },
      events: {
        subscribe: vi.fn((_filter, listener: (event: RuntimeEvent) => void) => {
          eventListener = listener;
          return { close: closeSubscription };
        }),
      },
      permissions: { respond },
    } as unknown as KodaXRuntime;
    const runner = createInteractiveRuntimeRunner(runtime);

    await expect(runner({
      options: {
        provider: 'mock-provider',
        abortSignal: new AbortController().signal,
        events: {
          onTextDelta,
          onPromptCacheDiagnostics,
          beforeToolExecute: legacyBeforeToolExecute,
        },
      } as unknown as KodaXOptions,
      prompt: 'hello',
      sessionId: 'session-1',
      permissionMode: 'plan',
      autoModeSettings: {
        classifierModel: 'qwen-token-plan:qwen3.7-plus',
      },
      requestPermission,
      legacyPermissionHook: true,
    })).resolves.toMatchObject({ success: true, lastText: 'done' });

    expect(updateSettings).toHaveBeenCalledWith('session-1', {
      permissionMode: 'plan',
      autoModeClassifierModel: 'qwen-token-plan:qwen3.7-plus',
    });
    expect(capturedStart?.permissionBroker).toBe('client');
    expect(capturedStart?.options).not.toHaveProperty('abortSignal');
    expect(onTextDelta).toHaveBeenCalledWith('streamed', undefined);
    expect(onPromptCacheDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'cache-request-1',
      cachedReadTokens: 19_328,
    }));
    expect(legacyBeforeToolExecute).not.toHaveBeenCalled();
    expect(requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'perm-1',
        toolName: 'write',
        toolCallId: 'tool-1',
        input: { path: 'C:/workspace/a.ts' },
        reason: 'Runtime classification requires confirmation.',
        risk: 'medium',
        executionCwd: 'C:/workspace',
        grantSuggestions: [{
          id: 'grant-persistent-1',
          kind: 'persistent',
          label: 'Always allow write for C:/workspace/a.ts',
        }],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(respond).toHaveBeenCalledWith(
      'perm-1',
      { type: 'allow_always', suggestionId: 'grant-persistent-1' },
      { runId: 'run-1' },
    );
    expect(closeSubscription).toHaveBeenCalledTimes(2);
  });

  it('finishes after Runtime permission timeout even when the host prompt stays unresolved', async () => {
    const eventListeners = new Set<(event: RuntimeEvent) => void>();
    let promptSignal: AbortSignal | undefined;
    const requestPermission = vi.fn((_request, context: { readonly signal: AbortSignal }) => {
      promptSignal = context.signal;
      return new Promise<{ type: 'allow_once' }>(() => undefined);
    });
    const respond = vi.fn(async () => true);
    const runtime = {
      identity: {
        runtimeId: 'runtime-ordering',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-20T00:00:00.000Z',
        version: 'test',
      },
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        updateSettings: vi.fn(async () => ({ permissionMode: 'auto' })),
      },
      runs: {
        start: vi.fn(async () => {
          for (const listener of eventListeners) listener(runtimeEvent('permission.requested', {
            id: 'permission-before-terminal',
            toolCallId: 'tool-1',
            toolName: 'bash',
            inputPreview: '{"command":"git log -1"}',
            createdAt: '2026-08-17T00:00:00.000Z',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }));
          setTimeout(() => {
            for (const listener of eventListeners) listener(runtimeEvent('permission.resolved', {
              requestId: 'permission-before-terminal',
              decision: {
                type: 'reject',
                reason:
                  'permission request timed out; choose a safer approach that does not require this approval',
                cause: 'approval_timeout',
              },
            }));
          }, 0);
          return {
            runId: 'run-1',
            sessionId: 'session-1',
            result: Promise.resolve({
              runId: 'run-1',
              sessionId: 'session-1',
              phase: 'completed' as const,
              result: successfulResult(),
            }),
          };
        }),
      },
      events: {
        subscribe: vi.fn((_filter, listener: (event: RuntimeEvent) => void) => {
          eventListeners.add(listener);
          return { close: vi.fn(() => eventListeners.delete(listener)) };
        }),
      },
      permissions: { respond },
    } as unknown as KodaXRuntime;
    const run = createInteractiveRuntimeRunner(runtime)({
      options: {} as KodaXOptions,
      prompt: 'review',
      sessionId: 'session-1',
      permissionMode: 'auto',
      requestPermission,
    });
    await expect(run).resolves.toMatchObject({ success: true });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(promptSignal?.aborted).toBe(true);
    expect(respond).not.toHaveBeenCalled();
  });

  it('keeps embedded Runtime as the sole Auto owner and still bridges permission prompts', async () => {
    const autoGuardrail = { kind: 'tool' as const, name: 'auto-mode' };
    const customGuardrail = { kind: 'tool' as const, name: 'custom-policy' };
    const legacyBeforeToolExecute = vi.fn(async () => true);
    const requestPermission = vi.fn(async () => ({ type: 'allow_once' as const }));
    const respond = vi.fn(async () => true);
    let eventListener: ((event: RuntimeEvent) => void) | undefined;
    let capturedStart: RuntimeStartRunInput | undefined;
    const runtime = {
      identity: {
        runtimeId: 'runtime-embedded',
        mode: 'embedded',
        profile: 'default',
        startedAt: '2026-07-10T00:00:00.000Z',
        version: 'test',
      },
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        updateSettings: vi.fn(async () => ({ permissionMode: 'auto' })),
      },
      runs: {
        start: vi.fn(async (input: RuntimeStartRunInput) => {
          capturedStart = input;
          eventListener?.(runtimeEvent('permission.requested', {
            id: 'perm-embedded',
            toolCallId: 'tool-embedded',
            toolName: 'read',
            inputPreview: '{"path":"README.md"}',
            grantSuggestions: [{ id: 'session-1', kind: 'session', label: 'This session' }],
          }));
          return {
            runId: 'run-1',
            sessionId: 'session-1',
            result: Promise.resolve({
              runId: 'run-1',
              sessionId: 'session-1',
              phase: 'completed' as const,
              result: successfulResult(),
            }),
          };
        }),
      },
      events: {
        subscribe: vi.fn((_filter, listener: (event: RuntimeEvent) => void) => {
          eventListener = listener;
          return { close: vi.fn() };
        }),
      },
      permissions: { respond },
    } as unknown as KodaXRuntime;

    await createInteractiveRuntimeRunner(runtime)({
      options: {
        events: { beforeToolExecute: legacyBeforeToolExecute },
        guardrails: [autoGuardrail, customGuardrail],
      } as unknown as KodaXOptions,
      prompt: 'inspect',
      sessionId: 'session-1',
      permissionMode: 'auto',
      requestPermission,
      legacyPermissionHook: true,
    });

    expect(capturedStart?.permissionBroker).toBe('client');
    expect(capturedStart?.options?.guardrails).toEqual([customGuardrail]);
    expect(capturedStart?.options?.events).not.toHaveProperty('beforeToolExecute');
    expect(legacyBeforeToolExecute).not.toHaveBeenCalled();
    expect(requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'perm-embedded',
        input: { path: 'README.md' },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(respond).toHaveBeenCalledWith(
      'perm-embedded',
      { type: 'allow_once' },
      { runId: 'run-1' },
    );
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

  it('keeps the loud daemon host-binding rejection through the runner', async () => {
    const runtime = {
      identity: {
        runtimeId: 'runtime-daemon-bindings',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-20T00:00:00.000Z',
        version: 'test',
      },
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        updateSettings: vi.fn(async () => ({ permissionMode: 'plan' })),
      },
      runs: { start: vi.fn() },
      events: { subscribe: vi.fn(() => ({ close: vi.fn() })) },
      permissions: { respond: vi.fn(async () => true) },
    } as unknown as KodaXRuntime;

    const runner = createInteractiveRuntimeRunner(runtime);
    await expect(runner({
      options: {
        provider: 'mock-provider',
        events: { beforeToolExecute: async () => true },
      } as unknown as KodaXOptions,
      prompt: 'inspect',
      sessionId: 'session-1',
    })).rejects.toThrow(/events\.beforeToolExecute.*cannot cross/i);
    expect(runtime.sessions.load).not.toHaveBeenCalled();
    expect(runtime.sessions.updateSettings).not.toHaveBeenCalled();
    expect(runtime.runs.start).not.toHaveBeenCalled();
  });

  it('serializes explicit Skill policy instead of sending callbacks to a daemon', async () => {
    let capturedOptions: unknown;
    const runtime = {
      identity: {
        runtimeId: 'runtime-daemon-skill-policy',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-20T00:00:00.000Z',
        version: 'test',
      },
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        updateSettings: vi.fn(async () => ({ permissionMode: 'plan' })),
      },
      runs: {
        start: vi.fn(async (input: RuntimeStartRunInput) => {
          capturedOptions = input.options;
          return {
            runId: 'run-1',
            sessionId: 'session-1',
            result: Promise.resolve({
              runId: 'run-1',
              sessionId: 'session-1',
              phase: 'completed' as const,
              result: successfulResult(),
            }),
          };
        }),
      },
      events: { subscribe: vi.fn(() => ({ close: vi.fn() })) },
      permissions: { respond: vi.fn(async () => true) },
    } as unknown as KodaXRuntime;

    await createInteractiveRuntimeRunner(runtime)({
      options: {
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
      },
      prompt: 'inspect',
      sessionId: 'session-1',
    });

    expect(capturedOptions).toMatchObject({
      context: {
        skillInvocation: {
          runtimePolicy: {
            enforceAtRuntime: true,
          },
        },
      },
    });
    expect(JSON.stringify(capturedOptions)).not.toContain('beforeToolExecute');
    expect(JSON.stringify(capturedOptions)).not.toContain('echo pre');
  });

  it('transport-sanitizes run options for a Worker-hosted embedded runtime', async () => {
    let capturedOptions: unknown;
    let eventListener: ((event: RuntimeEvent) => void) | undefined;
    const runtime = {
      identity: {
        runtimeId: 'runtime-worker-a2a',
        mode: 'embedded',
        isolation: 'worker',
        profile: 'default',
        startedAt: '2026-07-20T00:00:00.000Z',
        version: 'test',
      },
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        updateSettings: vi.fn(async () => ({ permissionMode: 'plan' })),
      },
      runs: {
        start: vi.fn(async (input: RuntimeStartRunInput) => {
          capturedOptions = input.options;
          return {
            runId: 'run-1',
            sessionId: 'session-1',
            result: Promise.resolve({
              runId: 'run-1',
              sessionId: 'session-1',
              phase: 'completed' as const,
              result: successfulResult(),
            }),
          };
        }),
      },
      events: {
        subscribe: vi.fn((_filter, listener: (event: RuntimeEvent) => void) => {
          eventListener = listener;
          return { close: vi.fn() };
        }),
      },
      permissions: { respond: vi.fn(async () => true) },
    } as unknown as KodaXRuntime;

    await createInteractiveRuntimeRunner(runtime)({
      options: {
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
      prompt: 'inspect',
      sessionId: 'session-1',
    });

    expect(capturedOptions).toMatchObject({
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
    // Host-only bindings are stripped before the Worker transport boundary.
    const serialized = JSON.stringify(capturedOptions);
    expect(serialized).not.toContain('beforeToolExecute');
    expect(serialized).not.toContain('onTextDelta');
    expect(serialized).not.toContain('storage');
    expect(serialized).not.toContain('memoryIdentity');
    expect((capturedOptions as { extensionRuntime?: unknown }).extensionRuntime)
      .toBeUndefined();
    expect((capturedOptions as { session?: unknown }).session)
      .not.toHaveProperty('storage');
    expect((capturedOptions as { context?: unknown }).context)
      .not.toHaveProperty('memoryIdentity');
  });

  it('keeps run options intact for an inline embedded runtime', async () => {
    let capturedOptions: unknown;
    const runtime = {
      identity: {
        runtimeId: 'runtime-inline',
        mode: 'embedded',
        isolation: 'inline',
        profile: 'default',
        startedAt: '2026-07-20T00:00:00.000Z',
        version: 'test',
      },
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        updateSettings: vi.fn(async () => ({ permissionMode: 'plan' })),
      },
      runs: {
        start: vi.fn(async (input: RuntimeStartRunInput) => {
          capturedOptions = input.options;
          return {
            runId: 'run-1',
            sessionId: 'session-1',
            result: Promise.resolve({
              runId: 'run-1',
              sessionId: 'session-1',
              phase: 'completed' as const,
              result: successfulResult(),
            }),
          };
        }),
      },
      events: {
        subscribe: vi.fn(() => ({ close: vi.fn() })),
      },
      permissions: { respond: vi.fn(async () => true) },
    } as unknown as KodaXRuntime;

    const beforeToolExecute = vi.fn(async () => true);
    const extensionRuntime = { activate: async () => undefined };
    await createInteractiveRuntimeRunner(runtime)({
      options: {
        provider: 'mock-provider',
        extensionRuntime,
        events: { beforeToolExecute },
      } as unknown as KodaXOptions,
      prompt: 'inspect',
      sessionId: 'session-1',
    });

    expect(capturedOptions).toMatchObject({
      provider: 'mock-provider',
      extensionRuntime,
    });
    expect((capturedOptions as { events?: { beforeToolExecute?: unknown } }).events?.beforeToolExecute)
      .toBe(beforeToolExecute);
  });
});

function runtimeEvent(type: RuntimeEvent['type'], payload: unknown): RuntimeEvent {
  return {
    id: `event-${type}`,
    seq: 1,
    time: '2026-07-10T00:00:00.000Z',
    sessionId: 'session-1',
    runId: 'run-1',
    type,
    payload,
  };
}

function successfulResult(): KodaXResult {
  return {
    success: true,
    lastText: 'done',
    messages: [],
    sessionId: 'session-1',
  };
}
