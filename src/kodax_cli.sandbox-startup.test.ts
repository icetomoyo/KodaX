import { describe, expect, it, vi } from 'vitest';

import { prepareInteractiveSandboxStartup } from './kodax_cli.js';

describe('interactive sandbox startup recovery', () => {
  it('does not enter the slow recovery path when the current setup marker is present', async () => {
    const prepare = vi.fn(async () => ({
      status: 'ready' as const,
      attempted: false,
      lines: [] as readonly string[],
    }));
    const isSetupCurrent = vi.fn(() => true);

    await expect(prepareInteractiveSandboxStartup({
      platform: 'win32',
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }, prepare, isSetupCurrent)).resolves.toBeUndefined();

    expect(isSetupCurrent).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('runs the existing setup boundary once for an interactive Windows startup', async () => {
    const report = {
      status: 'ready' as const,
      attempted: true,
      lines: ['KodaX sandbox is active.'],
    };
    const prepare = vi.fn(async () => report);

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(prepareInteractiveSandboxStartup({
        platform: 'win32',
        stdinIsTTY: true,
        stdoutIsTTY: true,
      }, prepare, () => false)).resolves.toEqual(report);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Preparing Windows sandbox'));
    } finally {
      stderr.mockRestore();
    }

    expect(prepare).toHaveBeenCalledOnce();
  });

  it('keeps the elapsed startup indicator moving while recovery is pending', async () => {
    vi.useFakeTimers();
    const report = {
      status: 'ready' as const,
      attempted: true,
      lines: [] as readonly string[],
    };
    let finishRecovery: ((value: typeof report) => void) | undefined;
    const prepare = vi.fn(() => new Promise<typeof report>((resolve) => {
      finishRecovery = resolve;
    }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const pending = prepareInteractiveSandboxStartup({
        platform: 'win32',
        stdinIsTTY: true,
        stdoutIsTTY: true,
      }, prepare, () => false);
      await vi.advanceTimersByTimeAsync(360);

      const progressFrames = stderr.mock.calls.filter(([text]) => (
        String(text).includes('Preparing Windows sandbox')
      ));
      expect(progressFrames.length).toBeGreaterThanOrEqual(4);

      finishRecovery?.(report);
      await expect(pending).resolves.toEqual(report);
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    { platform: 'linux' as const, stdinIsTTY: true, stdoutIsTTY: true },
    { platform: 'win32' as const, stdinIsTTY: false, stdoutIsTTY: true },
    { platform: 'win32' as const, stdinIsTTY: true, stdoutIsTTY: false },
  ])('does not trigger setup outside an interactive Windows startup', async (input) => {
    const prepare = vi.fn(async () => ({
      status: 'ready' as const,
      attempted: false,
      lines: [] as readonly string[],
    }));

    await expect(prepareInteractiveSandboxStartup(input, prepare)).resolves.toBeUndefined();

    expect(prepare).not.toHaveBeenCalled();
  });
});
