/**
 * v0.7.43 — session-snapshot middleware tests focused on the
 * "caller supplied session.id but forgot storage" trap. KodaX Space
 * embedder hit this — silent no-op meant runs completed successfully
 * but ~/.kodax/sessions/<id>.jsonl never appeared.
 *
 * The middleware adds a one-shot diagnostic keyed by session.id
 * so the same id firing terminal save multiple times only warns
 * once, but legitimately new runs (different ids) each get their
 * own onboarding warning.
 */

import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setKodaXDiagnosticSink,
  type KodaXDiagnostic,
  type KodaXSessionData,
  type KodaXSessionStorage,
} from '@kodax-ai/agent';
import type { KodaXOptions } from '../../types.js';
import { buildRuntimeSessionState } from '../runtime-session-state.js';
import {
  markStartKodaXGeneratedSessionId,
  saveRequiredSessionSnapshot,
  saveSessionSnapshot,
} from './session-snapshot.js';

let warnSpy: ReturnType<typeof vi.spyOn>;
let diagnostics: KodaXDiagnostic[];
let restoreDiagnosticSink: (() => void) | undefined;

beforeEach(() => {
  diagnostics = [];
  restoreDiagnosticSink = setKodaXDiagnosticSink((diagnostic) => {
    diagnostics.push(diagnostic);
  });
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  restoreDiagnosticSink?.();
  restoreDiagnosticSink = undefined;
});

const minimalData = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  title: 'test',
  gitRoot: '/repo',
};

describe('saveRequiredSessionSnapshot', () => {
  it('rejects when canonical storage is unavailable', async () => {
    const opts = {
      provider: 'anthropic',
      session: { id: 'runtime-owned-without-storage', persistedByHost: false },
    } as KodaXOptions;

    await expect(
      saveRequiredSessionSnapshot(opts, opts.session!.id!, minimalData),
    ).rejects.toThrow('requires session.storage');
  });

  it('surfaces canonical storage failures after emitting a diagnostic', async () => {
    const failure = new Error('disk full');
    const opts = {
      provider: 'anthropic',
      session: {
        id: 'runtime-owned-save-failure',
        persistedByHost: false,
        storage: { save: vi.fn().mockRejectedValue(failure) } as never,
      },
    } as KodaXOptions;

    await expect(
      saveRequiredSessionSnapshot(opts, opts.session!.id!, minimalData),
    ).rejects.toBe(failure);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      source: 'coding:session-snapshot',
      level: 'error',
    }));
  });
});

describe('saveSessionSnapshot — silent no-op when no storage', () => {
  it('returns early without throwing when options.session is undefined', async () => {
    const opts = { provider: 'anthropic' } as KodaXOptions;
    await expect(saveSessionSnapshot(opts, 'sess-1', minimalData)).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when only id is missing — no embedder mistake to signal', async () => {
    const opts = { provider: 'anthropic', session: {} } as unknown as KodaXOptions;
    await saveSessionSnapshot(opts, 'sess-2', minimalData);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn for a startKodaX-generated handle id without storage', async () => {
    const session = markStartKodaXGeneratedSessionId({
      id: `sdk-start-generated-${Date.now()}`,
    });
    const opts = { provider: 'anthropic', session } as KodaXOptions;
    await saveSessionSnapshot(opts, session.id!, minimalData);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);
  });
});

describe('saveSessionSnapshot — v0.7.43 diagnostic for id-without-storage trap', () => {
  it('warns once when session.id is set but storage is undefined', async () => {
    const opts = {
      provider: 'anthropic',
      session: { id: `sdk-trap-warn-${Date.now()}-1` },
    } as KodaXOptions;
    await saveSessionSnapshot(opts, opts.session!.id!, minimalData);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(diagnostics.length).toBe(1);
    const msg = diagnostics[0]?.message ?? '';
    expect(msg).toContain('[KodaX SDK]');
    expect(msg).toContain('session.storage is undefined');
    expect(msg).toContain('createSessionManager');
    expect(msg).toContain('public_docs/sdk/embedder-guide.md');
  });

  it('does not double-warn for the same session id across multiple terminal sites', async () => {
    const id = `sdk-trap-warn-${Date.now()}-2`;
    const opts = { provider: 'anthropic', session: { id } } as KodaXOptions;
    // SA loop calls saveSessionSnapshot at 4 sites (mid-flow / success /
    // error / limit). They all hit the same id — only the first should warn.
    await saveSessionSnapshot(opts, id, minimalData);
    await saveSessionSnapshot(opts, id, minimalData);
    await saveSessionSnapshot(opts, id, minimalData);
    await saveSessionSnapshot(opts, id, minimalData);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(diagnostics.length).toBe(1);
  });

  it('warns separately for distinct session ids', async () => {
    const id1 = `sdk-trap-warn-${Date.now()}-3a`;
    const id2 = `sdk-trap-warn-${Date.now()}-3b`;
    await saveSessionSnapshot(
      { provider: 'anthropic', session: { id: id1 } } as KodaXOptions,
      id1,
      minimalData,
    );
    await saveSessionSnapshot(
      { provider: 'anthropic', session: { id: id2 } } as KodaXOptions,
      id2,
      minimalData,
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(diagnostics.length).toBe(2);
  });
});

describe('saveSessionSnapshot — happy path with storage', () => {
  it('calls storage.save and does NOT emit the embedder warning', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const opts = {
      provider: 'anthropic',
      session: {
        id: `sdk-happy-${Date.now()}`,
        scope: 'user' as const,
        storage: { save: saveMock } as never,
      },
    } as unknown as KodaXOptions;
    await saveSessionSnapshot(opts, opts.session!.id!, minimalData);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('persists session.tag in the storage.save payload', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const opts = {
      provider: 'anthropic',
      session: {
        id: `sdk-tag-${Date.now()}`,
        tag: 'partner',
        scope: 'user' as const,
        storage: { save: saveMock } as never,
      },
    } as unknown as KodaXOptions;

    await saveSessionSnapshot(opts, opts.session!.id!, minimalData);

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]?.[1]?.tag).toBe('partner');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // FEATURE_173 dual-writer fix — persistedByHost ownership gate.
  it('persistedByHost: skips ROUTINE save (host owns persistence)', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const opts = {
      provider: 'anthropic',
      session: {
        id: `host-routine-${Date.now()}`,
        scope: 'user' as const,
        storage: { save: saveMock } as never,
        persistedByHost: true,
      },
    } as unknown as KodaXOptions;
    await saveSessionSnapshot(opts, opts.session!.id!, minimalData);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('persistedByHost: STILL persists error-recovery save (carries errorMetadata)', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const opts = {
      provider: 'anthropic',
      session: {
        id: `host-error-${Date.now()}`,
        scope: 'user' as const,
        storage: { save: saveMock } as never,
        persistedByHost: true,
      },
    } as unknown as KodaXOptions;
    await saveSessionSnapshot(opts, opts.session!.id!, {
      ...minimalData,
      errorMetadata: { lastError: 'boom', lastErrorTime: 1, consecutiveErrors: 1 },
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it('error snapshot keeps a valid user-starting transcript authoritative', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const loadMock = vi.fn().mockResolvedValue(null);
    const opts = {
      provider: 'anthropic',
      session: {
        id: `safe-error-${Date.now()}`,
        storage: { save: saveMock, load: loadMock } as KodaXSessionStorage,
      },
    } as unknown as KodaXOptions;
    const messages = [
      { role: 'user' as const, content: 'please continue' },
    ];

    await saveSessionSnapshot(opts, opts.session!.id!, {
      messages,
      title: 't',
      errorMetadata: { lastError: 'provider 500', lastErrorTime: 1, consecutiveErrors: 1 },
    });

    expect(loadMock).not.toHaveBeenCalled();
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]?.[1]?.messages).toBe(messages);
  });

  it('error snapshot never replaces an existing transcript with an empty carrier', async () => {
    const existingMessages = [
      { role: 'user' as const, content: 'previous prompt' },
      { role: 'assistant' as const, content: 'previous answer' },
    ];
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const loadMock = vi.fn().mockResolvedValue({
      messages: existingMessages,
      title: 'old',
      gitRoot: '/repo',
    } satisfies KodaXSessionData);
    const opts = {
      provider: 'anthropic',
      session: {
        id: `empty-error-${Date.now()}`,
        storage: { save: saveMock, load: loadMock } as KodaXSessionStorage,
      },
    } as unknown as KodaXOptions;

    await saveSessionSnapshot(opts, opts.session!.id!, {
      messages: [],
      title: 'errored',
      errorMetadata: { lastError: 'capacity', lastErrorTime: 1, consecutiveErrors: 1 },
    });

    expect(loadMock).toHaveBeenCalledOnce();
    expect(saveMock.mock.calls[0]?.[1]?.messages).toBe(existingMessages);
  });

  it('error snapshot rejects headless assistant tool_use fragments as authoritative history', async () => {
    const existingLineage: KodaXSessionData['lineage'] = {
      version: 2,
      activeEntryId: 'entry_good',
      entries: [],
    };
    const existingMessages = [
      { role: 'user' as const, content: 'previous clean prompt' },
      { role: 'assistant' as const, content: 'previous clean answer' },
    ];
    const existing: KodaXSessionData = {
      messages: existingMessages,
      title: 'old',
      gitRoot: '/repo',
      lineage: existingLineage,
    };
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const loadMock = vi.fn().mockResolvedValue(existing);
    const opts = {
      provider: 'zhipu-coding',
      session: {
        id: `bad-error-${Date.now()}`,
        storage: { save: saveMock, load: loadMock } as KodaXSessionStorage,
      },
    } as unknown as KodaXOptions;

    await saveSessionSnapshot(opts, opts.session!.id!, {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'skill', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }],
        },
      ],
      title: 'errored',
      errorMetadata: { lastError: 'zhipu 1214', lastErrorTime: 2, consecutiveErrors: 1 },
    });

    expect(loadMock).toHaveBeenCalledWith(opts.session!.id!);
    expect(saveMock).toHaveBeenCalledTimes(1);
    const persisted = saveMock.mock.calls[0]?.[1] as KodaXSessionData;
    expect(persisted.messages).toBe(existingMessages);
    expect(persisted.lineage).toBe(existingLineage);
    expect(persisted.errorMetadata?.lastError).toBe('zhipu 1214');
  });

  it('error snapshot with unsafe transcript preserves the existing extension snapshot', async () => {
    const existing: KodaXSessionData = {
      messages: [{ role: 'user', content: 'previous clean prompt' }],
      title: 'old',
      gitRoot: '/repo',
      extensionState: { 'ext:sample': { visits: 1, phase: 'clean' } },
      extensionRecords: [
        {
          id: 'record-clean',
          extensionId: 'ext:sample',
          type: 'hydrate',
          ts: 1,
        },
      ],
    };
    const runtimeSessionState = buildRuntimeSessionState({
      loadedExtensionState: existing.extensionState,
      loadedExtensionRecords: existing.extensionRecords,
      activeTools: [],
      modelSelection: {},
    });
    runtimeSessionState.extensionState.get('ext:sample')?.set('phase', 'crash');
    runtimeSessionState.extensionStateDirty = true;
    runtimeSessionState.extensionRecords.push({
      id: 'record-crash',
      extensionId: 'ext:sample',
      type: 'crash',
      ts: 2,
    });
    runtimeSessionState.extensionRecordsDirty = true;
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const loadMock = vi.fn().mockResolvedValue(existing);
    const opts = {
      provider: 'zhipu-coding',
      session: {
        id: `bad-error-ext-${Date.now()}`,
        storage: { save: saveMock, load: loadMock } as KodaXSessionStorage,
      },
    } as unknown as KodaXOptions;

    await saveSessionSnapshot(opts, opts.session!.id!, {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'skill', input: {} }],
        },
      ],
      title: 'errored',
      errorMetadata: { lastError: 'provider 500', lastErrorTime: 2, consecutiveErrors: 1 },
      runtimeSessionState,
    });

    const persisted = saveMock.mock.calls[0]?.[1] as KodaXSessionData;
    expect(persisted.messages).toBe(existing.messages);
    expect(persisted.extensionState).toEqual(existing.extensionState);
    expect(persisted.extensionRecords).toEqual(existing.extensionRecords);
  });

  it('error snapshot with no clean existing session records error without inventing lineage', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const loadMock = vi.fn().mockResolvedValue(null);
    const opts = {
      provider: 'zhipu-coding',
      session: {
        id: `bad-first-error-${Date.now()}`,
        storage: { save: saveMock, load: loadMock } as KodaXSessionStorage,
      },
    } as unknown as KodaXOptions;

    await saveSessionSnapshot(opts, opts.session!.id!, {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'skill', input: {} }],
        },
      ],
      title: 'errored',
      errorMetadata: { lastError: 'zhipu 1214', lastErrorTime: 2, consecutiveErrors: 1 },
    });

    expect(loadMock).toHaveBeenCalledWith(opts.session!.id!);
    expect(saveMock).toHaveBeenCalledTimes(1);
    const persisted = saveMock.mock.calls[0]?.[1] as KodaXSessionData;
    expect(persisted.messages).toEqual([]);
    expect(persisted.lineage).toBeUndefined();
    expect(persisted.errorMetadata?.lastError).toBe('zhipu 1214');
  });

  it('absorbs storage.save errors via diagnostics (does NOT throw to caller)', async () => {
    const saveMock = vi.fn().mockRejectedValue(new Error('disk full'));
    const opts = {
      provider: 'anthropic',
      session: {
        id: `sdk-err-${Date.now()}`,
        storage: { save: saveMock } as never,
      },
    } as unknown as KodaXOptions;
    await expect(saveSessionSnapshot(opts, opts.session!.id!, minimalData)).resolves.toBeUndefined();
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]?.source).toBe('coding:session-snapshot');
    expect(diagnostics[0]?.level).toBe('error');
    expect(diagnostics[0]?.message).toContain('storage.save failed');
  });
});

/**
 * v0.7.45 fix — gitRoot 3-tier resolution.
 *
 * Bug: in-process embedders (KodaX Space ADR-003) serve multiple projects
 * from a single runtime. Pre-fix, the middleware only honored
 * `data.gitRoot` and fell through to `process.cwd()`-bound `git rev-parse`,
 * tagging every session with the host process's startup directory rather
 * than the user-opened project.
 *
 * Fix: resolution order is
 *   1. `data.gitRoot` (explicit, highest)
 *   2. `options.context.gitRoot` (SDK context — closes the bug independently
 *      of the call-site fix)
 *   3. `getGitRoot(options.context.executionCwd)` (runs in correct cwd)
 *   4. `''` (legacy default)
 */
describe('saveSessionSnapshot — v0.7.45 gitRoot 3-tier resolution', () => {
  it('tier 1: data.gitRoot wins over options.context.gitRoot', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const opts = {
      provider: 'anthropic',
      session: {
        id: `gr-tier1-${Date.now()}`,
        storage: { save: saveMock } as never,
      },
      context: { gitRoot: '/from-context' },
    } as unknown as KodaXOptions;
    await saveSessionSnapshot(opts, opts.session!.id!, {
      messages: [{ role: 'user' as const, content: 'hi' }],
      title: 't',
      gitRoot: '/from-data',
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]?.[1]?.gitRoot).toBe('/from-data');
  });

  it('tier 2: falls through to options.context.gitRoot when data.gitRoot absent', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const opts = {
      provider: 'anthropic',
      session: {
        id: `gr-tier2-${Date.now()}`,
        storage: { save: saveMock } as never,
      },
      context: { gitRoot: '/user-opened-project' },
    } as unknown as KodaXOptions;
    await saveSessionSnapshot(opts, opts.session!.id!, {
      messages: [{ role: 'user' as const, content: 'hi' }],
      title: 't',
      // no data.gitRoot — must fall through to context
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]?.[1]?.gitRoot).toBe('/user-opened-project');
  });

  it('tier 2: explicit null context.gitRoot still falls through to git rev-parse fallback', async () => {
    // null is documented as "explicitly no gitRoot known" (distinct from
    // undefined "never set"). The ?? operator treats both the same way
    // for the purposes of this fallback chain.
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const opts = {
      provider: 'anthropic',
      session: {
        id: `gr-tier2-null-${Date.now()}`,
        storage: { save: saveMock } as never,
      },
      context: { gitRoot: null as unknown as string },
    } as unknown as KodaXOptions;
    await saveSessionSnapshot(opts, opts.session!.id!, {
      messages: [{ role: 'user' as const, content: 'hi' }],
      title: 't',
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    // Whatever git rev-parse returns (likely the KodaX repo root since
    // we're running in it) or '' — the key assertion is the bug doesn't
    // produce undefined / throw.
    const persisted = saveMock.mock.calls[0]?.[1]?.gitRoot;
    expect(typeof persisted).toBe('string');
  });

  it('regression — context.gitRoot is NOT silently dropped (the actual reported bug)', async () => {
    // Pre-fix: this test would fail — the persisted gitRoot would be
    // whatever `git rev-parse --show-toplevel` returned from
    // process.cwd(), NOT the value the embedder passed in context.
    // Post-fix: context.gitRoot is honored, sessions get tagged with
    // the user-opened project as the embedder intended.
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const HOST_INDEPENDENT = '/dev/embedder-passed/project-A';
    const opts = {
      provider: 'anthropic',
      session: {
        id: `gr-regress-${Date.now()}`,
        storage: { save: saveMock } as never,
      },
      context: { gitRoot: HOST_INDEPENDENT },
    } as unknown as KodaXOptions;
    await saveSessionSnapshot(opts, opts.session!.id!, {
      messages: [{ role: 'user' as const, content: 'hi' }],
      title: 't',
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]?.[1]?.gitRoot).toBe(HOST_INDEPENDENT);
  });

  it('persists runtimeInfo.executionCwd when no git root is available', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const executionCwd = path.join('tmp', 'kodax-non-git-cwd');
    const normalizedExecutionCwd = path.resolve(executionCwd).replace(/\\/g, '/');
    const opts = {
      provider: 'anthropic',
      session: {
        id: `sdk-gitroot-${Date.now()}-5`,
        storage: { save: saveMock } as never,
      },
      context: { executionCwd },
    } as KodaXOptions;

    await saveSessionSnapshot(opts, opts.session!.id!, {
      messages: [{ role: 'user', content: 'non-git cwd' }],
      title: 'non-git',
    });

    expect(saveMock).toHaveBeenCalledTimes(1);
    const persisted = saveMock.mock.calls[0]?.[1] as KodaXSessionData;
    expect(persisted.gitRoot).toBe('');
    expect(persisted.runtimeInfo).toEqual({
      executionCwd: normalizedExecutionCwd,
      workspaceKind: 'detected',
    });
  });
});
