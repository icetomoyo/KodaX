import { describe, expect, it, vi } from 'vitest';

import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import type { KodaXRuntime, RuntimeEvent } from './sdk-runtime.js';
import {
  createReplRuntimeAutoModeControl,
} from './kodax_cli.js';
import { forwardDaemonCompactionEvent, forwardRunProgressEvent } from './run-progress-events.js';

describe('one-shot runtime option shaping and auto-mode settings', () => {
  it('forwards canonical sandbox updates and rejects an update without its tool identity', () => {
    const onToolSandboxObservation = vi.fn();
    const payload = { update: { id: 'tool-1', observation: { version: 1, state: 'not_selected' } } };
    const event: RuntimeEvent = { id: 'event-1', seq: 1, time: '2026-09-08T00:00:00Z',
      sessionId: 'session-1', runId: 'run-1', type: 'tool.sandbox', payload };
    forwardRunProgressEvent({ onToolSandboxObservation }, event, payload, new Map());
    expect(onToolSandboxObservation).toHaveBeenCalledWith(payload.update, undefined);
    const malformed = { update: { observation: payload.update.observation } };
    expect(() => forwardRunProgressEvent({ onToolSandboxObservation }, { ...event, payload: malformed }, malformed, new Map()))
      .toThrow('tool.sandbox');
    expect(onToolSandboxObservation).toHaveBeenCalledTimes(1);
  });
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
    const updateSettings = vi.fn<KodaXProductClient['sessions']['updateSettings']>(async () => ({ permissionMode: 'auto' }));
    const runtime = {
      sessions: {
        read: vi.fn(async () => ({ id: 'session-1' })),
        getSettings: vi.fn(async () => ({ permissionMode: 'auto' })),
        updateSettings,
        getAutoModeStats: vi.fn(async () => ({
          classifierHealth: 'healthy' as const,
          denials: {},
          breaker: {},
        })),
      },
    } as unknown as KodaXProductClient;
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
    const updateSettings = vi.fn<KodaXProductClient['sessions']['updateSettings']>(async () => ({
      permissionMode: 'auto',
      autoModeEngine: 'rules' as const,
    }));
    const runtime = {
      sessions: {
        read: vi.fn(async () => ({ id: 'session-1' })),
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
    } as unknown as KodaXProductClient;

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
        read: vi.fn(async () => {
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
    } as unknown as KodaXProductClient;

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
        read: vi.fn(async () => ({ id: 'session-1' })),
        getSettings: vi.fn(async () => ({ permissionMode: persistedMode })),
        updateSettings,
        getAutoModeStats: vi.fn(async () => ({
          classifierHealth: 'healthy' as const,
          denials: {},
          breaker: {},
        })),
      },
    } as unknown as KodaXProductClient;
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

});
