import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCommand, getCommandRegistry } from './commands.js';

describe('legacy /project shim', () => {
  beforeEach(() => {
    const registry = getCommandRegistry();
    registry.clear();
    getCommandRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const registry = getCommandRegistry();
    registry.clear();
    getCommandRegistry();
  });

  it('prints migration guidance instead of reviving the old project shell', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await executeCommand(
      { command: 'project', args: [] },
      { gitRoot: process.cwd() } as never,
      {} as never,
      {} as never,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(result).toBe(true);
    expect(output).toContain('/project - Legacy Project Surface Retired');
    expect(output).toContain('/agent-mode ama');
    expect(output).toContain('FEATURE_054');
  });
});
