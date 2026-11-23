import { Command } from 'commander';
import { RUNTIME_HOST_SLOT } from '../runtime-daemon/state.js';
import { KODAX_DIR } from '@kodax-ai/repl';
import { configureLazyIntegrationCommands } from '../integration-cli-lazy.js';
import { loadIntegrationCli } from '../cli-lazy-components.js';
import { configureKodaXRootCommand, exitWithUsageCode, loadLazyCommand } from './root.js';
import { ROOT_HELP_FOOTER } from './help.js';
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
import { configureKodaXExecPolicyCommand } from '../exec-policy-cli.js';

/** What the command actions need from the CLI entry. */
export interface KodaXProgramDeps {
  readonly version: string;
}

/**
 * Builds the whole `kodax` Commander tree without running anything.
 * Registration order is the order `kodax -h` lists commands: everyday ones first.
 */
export function createKodaXProgram(deps: KodaXProgramDeps): Command {
  const { version } = deps;
  const program = configureKodaXRootCommand(
    new Command()
      .name('kodax')
      .description('KodaX - Intelligent Coding Agent')
      .version(version, '-V, --version', 'Print the version')
      .exitOverride(exitWithUsageCode),
  ).addHelpText('after', ROOT_HELP_FOOTER);
  configureKodaXSetupCommand(program);
  const auth = program.command('auth').description('Save API keys, login, inspect or revoke provider credentials');
  program.hook('preSubcommand', async (_parent, command) => {
    if (command === auth) await loadLazyCommand(program, auth);
  });
  configureKodaXHostCommand(program);
  configureKodaXSessionsCommand(program, version);
  configureKodaXDoctorCommand(program, version);
  configureLazyIntegrationCommands(program, {
    version,
    serveDaemonHost: (input) => serveDaemonCommand({
      profile: RUNTIME_HOST_SLOT,
      ...resolveCliRuntimeDaemonLocation(input.homeDir, KODAX_DIR),
      provider: input.provider,
      model: input.model,
    }),
  }, loadIntegrationCli);
  configureKodaXMemoryCommand(program);
  configureKodaXSkillCommand(program);
  configureKodaXAcpCommand(program, version);
  configureKodaXToolsCommands(program);
  configureKodaXExecPolicyCommand(program);
  configureKodaXCompletionCommand(program);
  return program;
}
