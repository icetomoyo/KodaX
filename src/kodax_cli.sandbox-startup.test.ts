import { describe, expect, it, vi } from 'vitest';

import { prepareInteractiveSandboxStartup } from './kodax_cli.js';

describe('interactive sandbox startup recovery', () => {
  it('runs the existing setup boundary once for an interactive Windows startup', async () => {
    const report = {
      status: 'ready' as const,
      attempted: true,
      lines: ['KodaX sandbox is active.'],
    };
    const prepare = vi.fn(async () => report);

    await expect(prepareInteractiveSandboxStartup({
      platform: 'win32',
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }, prepare)).resolves.toEqual(report);

    expect(prepare).toHaveBeenCalledOnce();
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
