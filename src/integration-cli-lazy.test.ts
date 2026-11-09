import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { configureLazyIntegrationCommands } from './integration-cli-lazy.js';
import type { IntegrationCommandOptions } from './integration-cli.js';

it('lists integration roots without loading their execution dependencies', async () => {
  let help = '';
  const program = new Command().name('kodax').exitOverride()
    .configureOutput({ writeOut: text => { help += text; } });
  const load = vi.fn(async () => { throw new Error('Root help must not load integration execution.'); });
  configureLazyIntegrationCommands(program, { version: 'fixture' }, load);
  await expect(program.parseAsync(['node', 'kodax', '--help'])).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
  for (const name of ['config', 'integrations', 'mcp', 'extensions', 'a2a', 'sandbox']) {
    expect(help).toContain(name);
  }
  expect(load).not.toHaveBeenCalled();
});

it('loads only a selected root before parsing its arguments and preserves owner callbacks', async () => {
  const received: unknown[] = [];
  const serveDaemonHost = vi.fn(async () => {});
  const options: IntegrationCommandOptions = { version: 'fixture', serveDaemonHost };
  const program = new Command().name('kodax').exitOverride();
  const load = vi.fn(async () => ({
    configureIntegrationCommand(command: Command, supplied: typeof options) {
      expect(supplied).toBe(options);
      command.command('call <value>').option('--mode <mode>').action((value, flags) => {
        received.push({ root: command.name(), value, mode: (flags as { mode?: string }).mode });
      });
    },
  }));
  configureLazyIntegrationCommands(program, options, load);
  await program.parseAsync(['node', 'kodax', 'mcp', 'call', 'source', '--mode', 'strict']);
  expect(received).toEqual([{ root: 'mcp', value: 'source', mode: 'strict' }]);
  expect(load).toHaveBeenCalledTimes(1);
  expect(program.commands.find(command => command.name() === 'a2a')!.commands).toHaveLength(0);
  await program.parseAsync(['node', 'kodax', 'mcp', 'call', 'again']);
  expect(load).toHaveBeenCalledTimes(1);
  expect(program.commands.filter(command => command.name() === 'mcp')).toHaveLength(1);
});
