import { Command } from 'commander';
import { RUNTIME_HOST_SLOT } from '../runtime-daemon/state.js';
import { KODAX_DIR } from '@kodax-ai/repl';
import { configureLazyIntegrationCommands } from '../integration-cli-lazy.js';
import { loadProviderAuth, loadIntegrationCli } from '../cli-lazy-components.js';
import { configureKodaXRootCommand, exitWithUsageCode } from './root.js';
import { serveDaemonCommand } from './host-serve.js';
import { resolveCliRuntimeDaemonLocation, configureKodaXHostCommand } from './host.js';
import { configureKodaXSessionsCommand } from './sessions.js';
import { configureKodaXSetupCommand } from './setup.js';
import { configureKodaXMemoryCommand } from './memory.js';
import { configureKodaXCompletionCommand } from './completion.js';
import { configureKodaXDoctorCommand } from './doctor.js';
import { configureKodaXSkillCommand } from './skill.js';
import { configureKodaXAcpCommand } from './acp.js';
import { configureKodaXToolsCommands } from './tools.js';

/** What the command actions need from the CLI entry. */
export interface KodaXProgramDeps {
  readonly version: string;
}

/** The whole `kodax` tree, plus the groups whose help the entry still prints by hand. */
export interface KodaXProgram {
  readonly program: Command;
  readonly skillCommand: Command;
  readonly acpCommand: Command;
}

/** Builds the whole `kodax` Commander tree, in registration order, without running anything. */
export function createKodaXProgram(deps: KodaXProgramDeps): KodaXProgram {
  const { version } = deps;
  const program = configureKodaXRootCommand(
    new Command()
      .name('kodax')
      .description('KodaX - Intelligent Coding Agent')
      .version(version)
      .exitOverride(exitWithUsageCode),
  );
  configureLazyIntegrationCommands(program, {
    version,
    serveDaemonHost: (input) => serveDaemonCommand({
      profile: RUNTIME_HOST_SLOT,
      ...resolveCliRuntimeDaemonLocation(input.homeDir, KODAX_DIR),
      provider: input.provider,
      model: input.model,
    }),
  }, loadIntegrationCli);

  configureKodaXSetupCommand(program);
  const auth = program.command('auth').description('Save API keys, login, inspect or revoke provider credentials');
  program.hook('preSubcommand', async (_parent, command) => {
    if (command === auth && auth.commands.length === 0) (await loadProviderAuth()).configureProviderAuthCommand(program, auth);
  });
  configureKodaXMemoryCommand(program);
  configureKodaXCompletionCommand(program);
  configureKodaXSessionsCommand(program, version);
  configureKodaXDoctorCommand(program, version);
  configureKodaXHostCommand(program);
  const skillCommand = configureKodaXSkillCommand(program);
  const acpCommand = configureKodaXAcpCommand(program, version);
  configureKodaXToolsCommands(program);
  return { program, skillCommand, acpCommand };
}
