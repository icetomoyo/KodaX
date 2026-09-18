import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverCommand } from './recover-command.js';

describe('recoverCommand', () => {
  const createContext = () => ({
    messages: [{ role: 'user', content: 'hello' }],
  });

  const createCallbacks = () => ({
    confirm: vi.fn().mockResolvedValue(true),
    recoverSession: vi.fn().mockResolvedValue('recovered'),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses handoff as an alias for recover', () => {
    expect(recoverCommand.aliases).toContain('handoff');
  });

  it('creates a recovery session with the provided prompt', async () => {
    const context = createContext();
    const callbacks = createCallbacks();

    await recoverCommand.handler(
      ['keep', 'going'],
      context as never,
      callbacks as never,
      {} as never,
    );

    expect(callbacks.confirm).toHaveBeenCalledTimes(1);
    expect(callbacks.recoverSession).toHaveBeenCalledExactlyOnceWith('keep going');
  });

  it('does not recover when confirmation is rejected', async () => {
    const context = createContext();
    const callbacks = createCallbacks();
    callbacks.confirm.mockResolvedValue(false);

    await recoverCommand.handler(
      [],
      context as never,
      callbacks as never,
      {} as never,
    );

    expect(callbacks.recoverSession).not.toHaveBeenCalled();
  });

  it('handles recover callback failures without throwing', async () => {
    const context = createContext();
    const callbacks = createCallbacks();
    callbacks.recoverSession.mockRejectedValue(new Error('storage failed'));

    await expect(recoverCommand.handler(
      [],
      context as never,
      callbacks as never,
      {} as never,
    )).resolves.toMatchObject({ success: false, message: '[Recover failed] storage failed' });
  });
});
