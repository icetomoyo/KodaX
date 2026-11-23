import { describe, expect, it, vi } from 'vitest';

import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import type { KodaXRuntime } from './sdk-runtime.js';
import { createReplRuntimeAutoModeControl } from '../tests/repl-v1-auto-mode-control.js';

describe('one-shot runtime option shaping and auto-mode settings', () => {
  it('synchronizes Auto reviewer settings without writing an engine selector', async () => {
    const updateSettings = vi.fn<KodaXProductClient['sessions']['updateSettings']>(async () => ({ permissionMode: 'auto' }));
    const runtime = {
      sessions: {
        read: vi.fn(async () => ({ id: 'session-1' })),
        getSettings: vi.fn(async () => ({ permissionMode: 'auto' })),
        updateSettings,
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
      },
    } as unknown as KodaXProductClient;

    const control = createReplRuntimeAutoModeControl(runtime);
    await control.syncSettings?.('new-session', 'auto', {});

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
