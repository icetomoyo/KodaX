import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KodaXEvents, KodaXResult } from '@kodax-ai/coding';

const { askInputMock } = vi.hoisted(() => ({ askInputMock: vi.fn() }));

vi.mock('./readline-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./readline-helpers.js')>();
  return {
    ...actual,
    askInput: (...args: Parameters<typeof actual.askInput>) => askInputMock(...args),
    getPrompt: () => '> ',
  };
});

import { MemorySessionStorage, runInteractiveMode } from './repl.js';

const TEST_EXIT = 'classic-display-test-exit';

function fakeTurnResult(): KodaXResult {
  return {
    success: true,
    lastText: 'assistant reply',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'assistant reply' },
    ],
    sessionId: 'classic-display-test',
  };
}

async function driveOneTurn(events?: KodaXEvents): Promise<KodaXEvents[]> {
  const captured: KodaXEvents[] = [];
  askInputMock.mockReset();
  askInputMock.mockResolvedValueOnce('hello');
  askInputMock.mockRejectedValueOnce(new Error(TEST_EXIT));
  await expect(runInteractiveMode({
    provider: 'openai',
    storage: new MemorySessionStorage(),
    events,
    runtimeRunner: async (input) => {
      captured.push(input.options.events ?? {});
      return fakeTurnResult();
    },
  })).rejects.toThrow(TEST_EXIT);
  return captured;
}

// Regression: since 2026-04-05 the classic REPL ran with no display events at
// all — requests executed but nothing rendered. Turns must carry the CLI
// display events (embedded direct callbacks / daemon bridge alike).
describe('classic REPL display events', () => {
  beforeEach(() => {
    process.env.KODAX_DISABLE_MULTI_INSTANCE = '1';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.KODAX_DISABLE_MULTI_INSTANCE;
  });

  it('wires CLI display events into natural-language turns', async () => {
    const captured = await driveOneTurn();
    expect(captured).toHaveLength(1);
    const events = captured[0]!;
    expect(typeof events.onTextDelta).toBe('function');
    // Permissions stay with the REPL hook / runtime broker, not the CLI YOLO default.
    expect(events.beforeToolExecute).toBeUndefined();
    (events.onTextDelta as (text: string) => void)('stream-chunk');
    expect(process.stdout.write).toHaveBeenCalledWith('stream-chunk');
    // The ask_user_question tool requires the host askUser callbacks; without
    // them the tool degrades to a silent [Tool Error] returned to the model.
    expect(typeof events.askUser).toBe('function');
    expect(typeof events.askUserMulti).toBe('function');
    expect(typeof events.askUserInput).toBe('function');
  });

  it('keeps caller-provided event handlers on top of display events', async () => {
    const onRetry = vi.fn();
    const captured = await driveOneTurn({ onRetry });
    const events = captured[0]!;
    expect(events.onRetry).toBe(onRetry);
    expect(typeof events.onTextDelta).toBe('function');
  });
});
