/**
 * v0.7.42 — RunningSession tests (closes gap 6 reported by KodaX Space).
 *
 * Strategy: these tests exercise the `RunningSession` surface in
 * isolation from the substrate by mocking `runManagedTask` to:
 *   1. Capture the `sessionControl` passed in via options.
 *   2. Synthesize `_attach` calls + observe whether setters apply
 *      directly vs queue + replay.
 *   3. Resolve / reject the result Promise on cue so abort + result-
 *      pass-through can be asserted.
 *
 * No real Runner / provider stream is needed — those are covered by
 * the substrate integration tests already.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KodaXMessage, KodaXOptions, KodaXReasoningMode, KodaXResult } from './types.js';

// Hoisted mock — must be defined before any import that pulls in task-engine.ts.
vi.mock('./task-engine.js', () => {
  return {
    runManagedTask: vi.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runKodaXMock: any;

import { runManagedTask } from './task-engine.js';
import {
  startKodaX,
  createSessionControl,
  type RunningSession,
} from './running-session.js';

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runKodaXMock = runManagedTask as unknown as any;
  runKodaXMock.mockReset();
});

function baseOptions(): KodaXOptions {
  return {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    events: {},
  };
}

function fakeKodaXResult(): KodaXResult {
  return {
    messages: [] as KodaXMessage[],
    finalMessage: '',
    finishReason: 'end_turn',
    iterations: 1,
    sessionId: 'sess_test',
    metadata: {},
  } as unknown as KodaXResult;
}

describe('startKodaX — handle properties', () => {
  it('returns a session id (uses options.session.id when supplied)', async () => {
    runKodaXMock.mockResolvedValueOnce(fakeKodaXResult());

    const session = startKodaX(
      { ...baseOptions(), session: { id: 'sess_provided_123' } },
      'hi',
    );
    expect(session.id).toBe('sess_provided_123');
    await session.result;
  });

  it('synthesizes a session id when options.session is omitted', async () => {
    runKodaXMock.mockResolvedValueOnce(fakeKodaXResult());

    const session = startKodaX(baseOptions(), 'hi');
    expect(session.id).toMatch(/^sess_\d+_[a-z0-9]{1,8}$/);
    await session.result;
  });

  it('initialises current* getters from options', async () => {
    runKodaXMock.mockResolvedValueOnce(fakeKodaXResult());

    const session = startKodaX(
      { ...baseOptions(), reasoningMode: 'medium' as KodaXReasoningMode },
      'hi',
    );
    expect(session.currentProvider).toBe('anthropic');
    expect(session.currentModel).toBe('claude-3-5-sonnet');
    expect(session.currentReasoning).toBe('medium');
    await session.result;
  });

  it('prefers modelOverride over model when seeding currentModel', async () => {
    runKodaXMock.mockResolvedValueOnce(fakeKodaXResult());

    const session = startKodaX(
      { ...baseOptions(), modelOverride: 'override-model' },
      'hi',
    );
    expect(session.currentModel).toBe('override-model');
    await session.result;
  });

  it('starts un-attached and not aborted', async () => {
    runKodaXMock.mockResolvedValueOnce(fakeKodaXResult());

    const session = startKodaX(baseOptions(), 'hi');
    expect(session.attached).toBe(false);
    expect(session.aborted).toBe(false);
    await session.result;
  });
});

describe('startKodaX — result Promise', () => {
  it('passes through KodaXResult resolution', async () => {
    const result = fakeKodaXResult();
    runKodaXMock.mockResolvedValueOnce(result);

    const session = startKodaX(baseOptions(), 'hi');
    await expect(session.result).resolves.toBe(result);
  });

  it('passes through rejection', async () => {
    const err = new Error('substrate exploded');
    runKodaXMock.mockRejectedValueOnce(err);

    const session = startKodaX(baseOptions(), 'hi');
    await expect(session.result).rejects.toBe(err);
  });
});

describe('startKodaX — sessionControl wiring', () => {
  function captureControl(): { current: KodaXOptions | undefined } {
    const slot: { current: KodaXOptions | undefined } = { current: undefined };
    runKodaXMock.mockImplementationOnce(async (opts: KodaXOptions) => {
      slot.current = opts;
      return fakeKodaXResult();
    });
    return slot;
  }

  it('injects a sessionControl onto the forwarded options', async () => {
    const captured = captureControl();
    const session = startKodaX(baseOptions(), 'hi');
    await session.result;
    expect(captured.current?.sessionControl).toBeDefined();
    expect(typeof captured.current?.sessionControl?._attach).toBe('function');
  });

  it('forwards an internal AbortSignal (not the user-supplied one verbatim)', async () => {
    const captured = captureControl();
    const externalAbort = new AbortController();
    const session = startKodaX(
      { ...baseOptions(), abortSignal: externalAbort.signal },
      'hi',
    );
    await session.result;
    expect(captured.current?.abortSignal).toBeDefined();
    expect(captured.current?.abortSignal).not.toBe(externalAbort.signal);
  });

  it('threads the generated handle id into the forwarded run options', async () => {
    const captured = captureControl();
    const session = startKodaX(baseOptions(), 'hi');
    await session.result;
    expect(captured.current?.session?.id).toBe(session.id);
  });

  it('treats a null session id from plain JS callers like an omitted id', async () => {
    const captured = captureControl();
    const options = {
      ...baseOptions(),
      session: { id: null },
    } as unknown as KodaXOptions;
    const session = startKodaX(options, 'hi');
    await session.result;
    expect(session.id).toMatch(/^sess_\d+_[a-z0-9]{1,8}$/);
    expect(captured.current?.session?.id).toBe(session.id);
  });

  it('does not override auto-resume discovery with a wrapper-generated id', async () => {
    const captured = captureControl();
    const session = startKodaX(
      { ...baseOptions(), session: { autoResume: true } },
      'hi',
    );
    await session.result;
    expect(session.id).toMatch(/^sess_\d+_[a-z0-9]{1,8}$/);
    expect(captured.current?.session?.id).toBeUndefined();
    expect(captured.current?.session?.autoResume).toBe(true);
  });
});

describe('startKodaX — setters before attach (queue + replay)', () => {
  function trackMutators(): {
    captured: KodaXOptions | undefined;
    log: Array<['provider' | 'model' | 'reasoning', unknown]>;
  } {
    const log: Array<['provider' | 'model' | 'reasoning', unknown]> = [];
    const slot: {
      captured: KodaXOptions | undefined;
      log: typeof log;
    } = { captured: undefined, log };
    runKodaXMock.mockImplementationOnce(async (opts: KodaXOptions) => {
      // Yield a microtask so the test's sync setter calls land in the
      // pre-attach queue rather than racing past `_attach` already-fired.
      await Promise.resolve();
      slot.captured = opts;
      opts.sessionControl?._attach({
        setProvider: (n) => log.push(['provider', n]),
        setModel: (m) => log.push(['model', m]),
        setReasoning: (r) => log.push(['reasoning', r]),
      });
      return fakeKodaXResult();
    });
    return slot;
  }

  it('queues sync setProvider before _attach fires, replays on attach', async () => {
    const tracked = trackMutators();
    const session = startKodaX(baseOptions(), 'hi');
    session.setProvider('openai');
    await session.result;
    expect(tracked.log).toContainEqual(['provider', 'openai']);
    expect(session.currentProvider).toBe('openai');
  });

  it('queues setModel(undefined) explicitly and replays as clear', async () => {
    const tracked = trackMutators();
    const session = startKodaX(baseOptions(), 'hi');
    session.setModel(undefined);
    await session.result;
    expect(tracked.log).toContainEqual(['model', undefined]);
    expect(session.currentModel).toBeUndefined();
  });

  it('queues multiple setters and replays them all on attach', async () => {
    const tracked = trackMutators();
    const session = startKodaX(baseOptions(), 'hi');
    session.setProvider('openai');
    session.setModel('gpt-4o');
    session.setReasoning('high' as KodaXReasoningMode);
    await session.result;
    expect(tracked.log).toContainEqual(['provider', 'openai']);
    expect(tracked.log).toContainEqual(['model', 'gpt-4o']);
    expect(tracked.log).toContainEqual(['reasoning', 'high']);
  });

  it('only the LAST queued value of each field is replayed', async () => {
    const tracked = trackMutators();
    const session = startKodaX(baseOptions(), 'hi');
    session.setProvider('openai');
    session.setProvider('deepseek');
    session.setProvider('kimi');
    await session.result;
    const providerCalls = tracked.log.filter(([k]) => k === 'provider');
    expect(providerCalls).toEqual([['provider', 'kimi']]);
  });
});

describe('startKodaX — setters AFTER attach (live mutation)', () => {
  it('applies setters directly once _attach has fired', async () => {
    const log: Array<['provider' | 'model' | 'reasoning', unknown]> = [];
    let resumeRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      resumeRun = resolve;
    });

    let outerSession: RunningSession;
    runKodaXMock.mockImplementationOnce(async (opts: KodaXOptions) => {
      opts.sessionControl?._attach({
        setProvider: (n) => log.push(['provider', n]),
        setModel: (m) => log.push(['model', m]),
        setReasoning: (r) => log.push(['reasoning', r]),
      });
      // Hand control back to test so it can poke setters AFTER attach,
      // then wait until the test resumes us.
      await runGate;
      return fakeKodaXResult();
    });

    outerSession = startKodaX(baseOptions(), 'hi');
    // Yield a microtask so runKodaXMock body runs up to `await runGate`.
    await new Promise((r) => setImmediate(r));
    expect(outerSession.attached).toBe(true);

    outerSession.setProvider('openai');
    outerSession.setModel('gpt-4o-mini');
    expect(log).toEqual([
      ['provider', 'openai'],
      ['model', 'gpt-4o-mini'],
    ]);

    resumeRun();
    await outerSession.result;
  });
});

describe('startKodaX — abort behavior', () => {
  it('marks aborted and triggers AbortSignal when abort() is called', async () => {
    let capturedSignal: AbortSignal | undefined;
    runKodaXMock.mockImplementationOnce(async (opts: KodaXOptions) => {
      capturedSignal = opts.abortSignal;
      return fakeKodaXResult();
    });

    const session = startKodaX(baseOptions(), 'hi');
    expect(session.aborted).toBe(false);
    session.abort('user pressed Ctrl-C');
    expect(session.aborted).toBe(true);
    await session.result;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('forwards external abort signal to the internal one', async () => {
    let capturedSignal: AbortSignal | undefined;
    runKodaXMock.mockImplementationOnce(async (opts: KodaXOptions) => {
      capturedSignal = opts.abortSignal;
      return fakeKodaXResult();
    });

    const ext = new AbortController();
    const session = startKodaX(
      { ...baseOptions(), abortSignal: ext.signal },
      'hi',
    );
    expect(session.aborted).toBe(false);
    ext.abort('upstream cancelled');
    expect(session.aborted).toBe(true);
    await session.result;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('aborts immediately when external signal is already aborted at construction', async () => {
    runKodaXMock.mockResolvedValueOnce(fakeKodaXResult());

    const ext = new AbortController();
    ext.abort('pre-aborted');
    const session = startKodaX(
      { ...baseOptions(), abortSignal: ext.signal },
      'hi',
    );
    expect(session.aborted).toBe(true);
    await session.result;
  });

  it('abort() is idempotent', async () => {
    runKodaXMock.mockResolvedValueOnce(fakeKodaXResult());

    const session = startKodaX(baseOptions(), 'hi');
    session.abort();
    session.abort();
    session.abort();
    expect(session.aborted).toBe(true);
    await session.result;
  });
});

describe('createSessionControl — direct usage', () => {
  it('returns a control that exposes both _attach and setters', () => {
    const control = createSessionControl();
    expect(typeof control._attach).toBe('function');
    expect(typeof control.setProvider).toBe('function');
    expect(typeof control.setModel).toBe('function');
    expect(typeof control.setReasoning).toBe('function');
  });

  it('queue + replay works when used standalone (no startKodaX wrapper)', () => {
    const control = createSessionControl();
    control.setProvider('zhipu');
    control.setModel('glm-4.5');

    const log: Array<[string, unknown]> = [];
    control._attach({
      setProvider: (n) => log.push(['provider', n]),
      setModel: (m) => log.push(['model', m]),
      setReasoning: (r) => log.push(['reasoning', r]),
    });

    expect(log).toContainEqual(['provider', 'zhipu']);
    expect(log).toContainEqual(['model', 'glm-4.5']);
  });
});
