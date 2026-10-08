import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newCommand } from './new-command.js';
import { applyClientSessionMetadata } from '../session/client-session.js';

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

  it('uses Host messages after loading a session clears the local presentation cache', async () => {
    const context = createContext();
    applyClientSessionMetadata(context as never, { id: 'loaded', title: 'Existing session', msgCount: 2 } as never);
    const callbacks = { ...createCallbacks(), getSessionStatus: vi.fn(async () => ({ messageCount: 2 })) };
    expect(context.messages).toEqual([]);
    await newCommand.handler([], context as never, callbacks as never, {} as never);
    expect(callbacks.getSessionStatus).toHaveBeenCalledOnce();
    expect(callbacks.confirm).toHaveBeenCalledOnce();
    expect(callbacks.startNewSession).toHaveBeenCalledOnce();
    expect(callbacks.clearHistory).toHaveBeenCalledOnce();
  });

  it('treats an empty Host session as empty even when the local cache is stale', async () => {
    const callbacks = { ...createCallbacks(), getSessionStatus: vi.fn(async () => ({ messageCount: 0 })) };
    await newCommand.handler([], createContext() as never, callbacks as never, {} as never);
    expect(callbacks.confirm).not.toHaveBeenCalled();
    expect(callbacks.saveSession).not.toHaveBeenCalled();
    expect(callbacks.startNewSession).not.toHaveBeenCalled();
    expect(callbacks.clearHistory).not.toHaveBeenCalled();
  });

  it('preserves the current session when reading Host status fails', async () => {
    const context = createContext();
    const callbacks = { ...createCallbacks(), getSessionStatus: vi.fn().mockRejectedValue(new Error('Host unavailable')) };
    await expect(newCommand.handler([], context as never, callbacks as never, {} as never))
      .rejects.toThrow('Host unavailable');
    expect(context.messages).toHaveLength(1);
    expect(callbacks.confirm).not.toHaveBeenCalled();
    expect(callbacks.startNewSession).not.toHaveBeenCalled();
    expect(callbacks.clearHistory).not.toHaveBeenCalled();
  });

  it('keeps the empty-session shortcut for standalone REPLs', async () => {
    const callbacks = createCallbacks();
    await newCommand.handler([], { messages: [] } as never, callbacks as never, {} as never);
    expect(callbacks.confirm).not.toHaveBeenCalled();
    expect(callbacks.startNewSession).not.toHaveBeenCalled();
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
