import { describe, expect, it, vi } from 'vitest';
import type { SessionPickerRunOptions } from '@kodax-ai/repl/cli-resume';

import { resolveBareResume } from './kodax_resume.js';

const session = {
  id: 'session-one',
  title: 'First session',
  msgCount: 3,
};

describe('resolveBareResume', () => {
  it('returns the selected session as an exact resume argument', async () => {
    const notify = vi.fn();
    const beforeSelect = vi.fn(async () => undefined);
    const onDiscoveryComplete = vi.fn();
    const pickSession = vi.fn(async (
      _sessions: readonly typeof session[],
      options?: SessionPickerRunOptions,
    ) => {
      expect(onDiscoveryComplete).toHaveBeenCalledTimes(1);
      await options?.prepareSelection?.(session);
      return session;
    });

    const result = await resolveBareResume({
      cwd: 'C:/repo',
      listSessions: async () => [session],
      pickSession,
      beforeSelect,
      onDiscoveryComplete,
      notify,
    });

    expect(result).toEqual({ kind: 'continue', argv: ['-r', 'session-one'] });
    expect(beforeSelect).toHaveBeenCalledWith(session);
    expect(notify).not.toHaveBeenCalled();
  });

  it('exits without loading the CLI when the user cancels', async () => {
    const notify = vi.fn();

    const result = await resolveBareResume({
      listSessions: async () => [session],
      pickSession: async () => undefined,
      notify,
    });

    expect(result).toEqual({ kind: 'exit' });
    expect(notify).toHaveBeenCalledWith('cancelled');
  });

  it('continues as a new session when no resumable sessions exist', async () => {
    const pickSession = vi.fn();
    const notify = vi.fn();

    const result = await resolveBareResume({
      listSessions: async () => [],
      pickSession,
      notify,
    });

    expect(result).toEqual({ kind: 'continue', argv: [] });
    expect(pickSession).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('empty');
  });
});
