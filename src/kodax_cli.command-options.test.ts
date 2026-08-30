import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { mergeCommandOptionsWithGlobals } from './cli_option_helpers.js';
import {
  configureKodaXRootCommand,
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
