import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newCommand } from './new-command.js';

describe('newCommand', () => {
  const createContext = () => ({
    messages: [{ role: 'user', content: 'hello' }],
  });

  const createCallbacks = () => ({
    saveSession: vi.fn().mockResolvedValue(undefined),
    startNewSession: vi.fn(),
    clearHistory: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the actual conversation context before clearing the UI', async () => {
    const context = createContext();
    const callbacks = createCallbacks();

    await newCommand.handler(
      [],
      context as never,
      callbacks as never,
      {} as never
    );

    expect(callbacks.saveSession).toHaveBeenCalledTimes(1);
    expect(callbacks.startNewSession).toHaveBeenCalledTimes(1);
    expect(context.messages).toEqual([]);
    expect(callbacks.clearHistory).toHaveBeenCalledTimes(1);
  });

  it('does not clear anything when confirmation is rejected', async () => {
    const context = createContext();
    const callbacks = createCallbacks();
    callbacks.confirm.mockResolvedValue(false);

    await newCommand.handler(
      [],
      context as never,
      callbacks as never,
      {} as never
    );

    expect(callbacks.saveSession).not.toHaveBeenCalled();
    expect(callbacks.startNewSession).not.toHaveBeenCalled();
    expect(callbacks.clearHistory).not.toHaveBeenCalled();
    expect(context.messages).toHaveLength(1);
  });

  it('keeps the current conversation and UI until the new Host session is ready', async () => {
    const context = createContext();
    const callbacks = createCallbacks();
    let finishCreate!: () => void;
    callbacks.startNewSession.mockReturnValue(new Promise<void>((resolve) => { finishCreate = resolve; }));
    const pending = newCommand.handler([], context as never, callbacks as never, {} as never);
    try {
      await vi.waitFor(() => expect(callbacks.startNewSession).toHaveBeenCalledOnce());
      expect(context.messages).toEqual([{ role: 'user', content: 'hello' }]);
      expect(callbacks.clearHistory).not.toHaveBeenCalled();
    } finally {
      finishCreate();
      await pending;
    }
    expect(context.messages).toEqual([]);
    expect(callbacks.clearHistory).toHaveBeenCalledOnce();
  });

  it('preserves the conversation and UI when Host session creation fails', async () => {
    const context = createContext();
    const callbacks = createCallbacks();
    callbacks.startNewSession.mockRejectedValue(new Error('Host session could not be persisted'));
    await expect(newCommand.handler([], context as never, callbacks as never, {} as never))
      .rejects.toThrow('Host session could not be persisted');
    expect(context.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(callbacks.clearHistory).not.toHaveBeenCalled();
  });
});
