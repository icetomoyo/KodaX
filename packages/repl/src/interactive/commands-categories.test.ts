import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS, executeCommand, getCommandRegistry, type CommandCallbacks } from './commands.js';
import { createInteractiveContext } from './context.js';

async function helpOutput(): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const help = BUILTIN_COMMANDS.find((command) => command.name === 'help')!;
  await help.handler([], {} as never, {} as never, {} as never);
  const output = logSpy.mock.calls.flat().join('\n');
  // The command sections end where the syntax notes begin.
  return output.slice(0, output.indexOf('Special syntax:'));
}

describe('REPL command categories', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('gives every user-facing built-in command a /help category', () => {
    const uncategorized = BUILTIN_COMMANDS
      .filter((command) => command.userInvocable !== false && command.category === undefined)
      .map((command) => command.name);
    expect(uncategorized).toEqual([]);
  });

  it('lists each built-in command once, under its category', async () => {
    const output = await helpOutput();
    for (const command of BUILTIN_COMMANDS.filter((entry) => entry.userInvocable !== false)) {
      const heading = `${command.category}:`;
      const section = output.slice(output.indexOf(heading));
      expect(section, `/${command.name} under ${heading}`).toMatch(new RegExp(`/${command.name}\\b`));
      expect(output.match(new RegExp(`/${command.name}(?=[ (])`, 'g'))?.length, `/${command.name} listed once`).toBe(1);
    }
    expect(output).not.toContain('Other Commands:');
    expect(output).not.toMatch(/FEATURE_\d+/);
  });

  it('runs /thinking, /think and /t as aliases of /reasoning', () => {
    const registry = getCommandRegistry();
    for (const alias of ['thinking', 'think', 't']) {
      expect(registry.get(alias)?.name).toBe('reasoning');
    }
    expect(BUILTIN_COMMANDS.some((command) => command.name === 'thinking')).toBe(false);
  });

  it.each([
    ['repointel', '/repo-intel status'],
    ['ri', '/repo-intel status'],
    ['plan', '/mode plan'],
  ])('points the retired /%s at %s', async (command, replacement) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handled = await executeCommand(
      { command, args: [] },
      await createInteractiveContext({}),
      {} as unknown as CommandCallbacks,
      {} as never,
    );
    expect(handled).toBe(false);
    expect(logSpy.mock.calls.flat().join('\n')).toContain(`/${command} was removed; use ${replacement}`);
  });
});
