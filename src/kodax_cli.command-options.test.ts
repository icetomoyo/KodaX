import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { mergeCommandOptionsWithGlobals } from './cli_option_helpers.js';
import {
  configureKodaXRootCommand,
  configureKodaXDaemonCommand,
  configureKodaXSetupCommand,
  KODAX_CLI_SUBCOMMAND_NAMES,
  KODAX_COMPLETION_ROOT_SUBCOMMANDS,
  KODAX_EXEC_POLICY_SUBCOMMANDS,
  shouldAutoStartCli,
  showKodaXSetupHelpIfRequested,
} from './kodax_cli.js';

describe('KodaX CLI entry ownership', () => {
  it('leaves bundled startup to the bootstrap without breaking direct Node execution', () => {
    const executableUrl = 'file:///opt/kodax/kodax';

    expect(shouldAutoStartCli(executableUrl, executableUrl, true)).toBe(false);
    expect(shouldAutoStartCli(executableUrl, executableUrl, false)).toBe(true);
    expect(shouldAutoStartCli('file:///opt/kodax/kodax_cli.js', executableUrl, false))
      .toBe(false);
  });

  it('recognizes and completes the execpolicy command', () => {
    expect(KODAX_CLI_SUBCOMMAND_NAMES).toContain('execpolicy');
    expect(KODAX_COMPLETION_ROOT_SUBCOMMANDS).toContain('execpolicy');
    expect(KODAX_EXEC_POLICY_SUBCOMMANDS).toContain('check');
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride());
    expect(program.commands.map((command) => command.name())).toContain('execpolicy');
  });
});

describe('KodaX root/subcommand option ownership', () => {
  it('honors root help before dispatching nested management commands and aliases', async () => {
    let output = '';
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride()
      .configureOutput({ writeOut: text => { output += text; }, writeErr: text => { output += text; } }));
    const action = vi.fn();
    program.command('host').command('reset').alias('clear').action(action);
    const result = await program.parseAsync(['node', 'kodax', 'host', 'clear', '--help'])
      .then(() => undefined, (error: unknown) => error);
    expect(action).not.toHaveBeenCalled();
    expect(result).toMatchObject({ exitCode: 0 });
    expect(output).toContain('Usage: kodax host reset');
  });

  it('prints real daemon start help without invoking any management action', async () => {
    let output = '';
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride()
      .configureOutput({ writeOut: text => { output += text; }, writeErr: text => { output += text; } }));
    const daemon = configureKodaXDaemonCommand(program);
    const action = vi.fn();
    for (const command of daemon.commands) command.action(action);

    const result = await program.parseAsync(['node', 'kodax', 'daemon', 'start', '--help'])
      .then(() => undefined, (error: unknown) => error);
    expect(action).not.toHaveBeenCalled();
    expect(result).toMatchObject({ exitCode: 0 });
    expect(output).toContain('Usage: kodax daemon start');
    expect(output).toContain('--home');
    expect(output).not.toContain('--profile');
  });

  const daemonNames = ['start', 'stop', 'restart', 'logs', 'serve', 'status'] as const;
  const helpCases = daemonNames.flatMap(name => [
    { name, args: ['daemon', name, '--help'] },
    { name, args: ['daemon', name, '-h'] },
    { name, args: ['--provider', 'root-provider', 'daemon', name, '--help'] },
    { name, args: ['daemon', name, '--home', '/help-only', '-h'] },
    { name, args: ['daemon', name, '--help=topic'] },
    { name, args: ['daemon', name, '--help='] },
    { name, args: ['daemon', name, '-yh'] },
    { name, args: ['daemon', name, '--timeout-ms', 'not-a-number', '--help'] },
  ]);
  it.each(helpCases)('keeps daemon $name help read-only: $args', async ({ name, args }) => {
    let output = '';
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride()
      .configureOutput({ writeOut: text => { output += text; }, writeErr: text => { output += text; } }));
    const daemon = configureKodaXDaemonCommand(program);
    const action = vi.fn();
    for (const command of daemon.commands) command.action(action);
    const result = await program.parseAsync(['node', 'kodax', ...args])
      .then(() => undefined, (error: unknown) => error);
    expect(action).not.toHaveBeenCalled();
    expect(result).toMatchObject({ exitCode: 0 });
    expect(output).toContain(`Usage: kodax daemon ${name}`);
  });

  it.each([['daemon', '--help'], ['daemon', '-h'], ['daemon', '--help', 'start']])(
    'shows daemon group help without any management action: %j', async (...args) => {
      let output = '';
      const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride()
        .configureOutput({ writeOut: text => { output += text; }, writeErr: text => { output += text; } }));
      const daemon = configureKodaXDaemonCommand(program);
      const action = vi.fn();
      for (const command of daemon.commands) command.action(action);
      const result = await program.parseAsync(['node', 'kodax', ...args])
        .then(() => undefined, (error: unknown) => error);
      expect(action).not.toHaveBeenCalled();
      expect(result).toMatchObject({ exitCode: 0 });
      expect(output).toContain('Usage: kodax daemon [options] [command]');
    },
  );

  it.each(daemonNames)('preserves normal daemon %s options, including literal help in values', async name => {
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride());
    const daemon = configureKodaXDaemonCommand(program);
    const action = vi.fn();
    for (const command of daemon.commands) command.action(action);
    await program.parseAsync(['node', 'kodax', 'daemon', name, '--home=--help']);
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0]![0]).toMatchObject({ home: '--help' });
  });

  it.each(daemonNames)('rejects the removed daemon %s --profile with migration guidance (FEATURE_305)', async name => {
    let output = '';
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride()
      .configureOutput({ writeOut: text => { output += text; }, writeErr: text => { output += text; } }));
    const daemon = configureKodaXDaemonCommand(program);
    const action = vi.fn();
    for (const command of daemon.commands) command.action(action);
    const result = await program.parseAsync(['node', 'kodax', 'daemon', name, '--profile', 'coder'])
      .then(() => undefined, (error: unknown) => error);
    expect(action).not.toHaveBeenCalled();
    expect(result).toMatchObject({ code: 'commander.invalidArgument', exitCode: 1 });
    expect(output).toContain('no longer accepts --profile');
    expect(output).toContain('--home or KODAX_HOME');
    expect(output).toContain('docs/SDK_MIGRATION.md');
  });

  it('does not interpret a literal help argument after -- as a help option', async () => {
    let output = '';
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride()
      .configureOutput({ writeOut: text => { output += text; }, writeErr: text => { output += text; } }));
    const daemon = configureKodaXDaemonCommand(program);
    const action = vi.fn();
    for (const command of daemon.commands) command.action(action);
    const result = await program.parseAsync(['node', 'kodax', 'daemon', 'start', '--', '--help'])
      .then(() => undefined, (error: unknown) => error);
    expect(result).toMatchObject({ code: 'commander.excessArguments' });
    expect(action).not.toHaveBeenCalled();
    expect(output).not.toContain('Usage:');
  });

  it('gives `kodax setup --help` the shared guide and custom-provider option', () => {
    const program = new Command().name('kodax').exitOverride();
    const setup = configureKodaXSetupCommand(program);
    let help = '';
    setup.configureOutput({
      writeOut: (text) => { help += text; },
      writeErr: (text) => { help += text; },
    });
    setup.outputHelp();

    expect(help).toContain('--custom');
    expect(help).toContain('KodaX setup guide');
    expect(help).toContain('kodax setup --custom');
    expect(help).toContain('mcp.json');
    expect(help).toContain('/agent-mode');
  });

  it('shows setup help without running setup when attached to the real root command', async () => {
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride());
    const setup = configureKodaXSetupCommand(program);
    let help = '';
    let actionCalled = false;
    const output = {
      writeOut: (text: string) => { help += text; },
      writeErr: (text: string) => { help += text; },
    };
    program.configureOutput(output);
    setup.configureOutput(output);
    setup.action(() => {
      actionCalled = true;
    });

    expect(showKodaXSetupHelpIfRequested(['setup', '--help'], setup)).toBe(true);

    expect(actionCalled).toBe(false);
    expect(help).toContain('KodaX setup guide');
  });

  it('makes a duplicated option after the subcommand available to its action', async () => {
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride());
    let receivedProvider: string | undefined;
    program.command('host')
      .option('--provider <name>')
      .action((localOptions: { provider?: string }, command: Command) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        receivedProvider = options.provider;
      });

    await program.parseAsync(['node', 'kodax', 'host', '--provider', 'child-provider']);

    expect(receivedProvider).toBe('child-provider');
  });

  it('keeps a prefixed root option visible to a subcommand through global options', async () => {
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride());
    let receivedProvider: string | undefined;
    program.command('host')
      .option('--provider <name>')
      .action((localOptions: { provider?: string }, command: Command) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        receivedProvider = options.provider;
      });

    await program.parseAsync(['node', 'kodax', '--provider', 'root-provider', 'host']);

    expect(receivedProvider).toBe('root-provider');
    expect(program.args[0]).toBe('host');
  });

  it('preserves root option parsing after a normal prompt argument', async () => {
    const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride());

    await program.parseAsync(['node', 'kodax', 'summarize', '--provider', 'root-provider']);

    expect(program.opts().provider).toBe('root-provider');
    expect(program.args).toEqual(['summarize']);
  });
});
