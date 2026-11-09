import type { Command } from 'commander';
import type { IntegrationCommandOptions } from './integration-cli.js';

export const INTEGRATION_COMMAND_DESCRIPTIONS = {
  config: 'Inspect canonical KodaX configuration templates',
  integrations: 'Validate, migrate, and inspect split integration config',
  mcp: 'Manage MCP servers in integrations/mcp.json',
  extensions: 'Manage extensions in integrations/extensions.json',
  a2a: 'Call third-party A2A Agents or expose KodaX as an A2A Agent',
  sandbox: 'Inspect or provision the ASRT Skill-script isolation backend',
} as const;

const commandLoaders = new WeakMap<Command, () => Promise<void>>();

/** Also used by the CLI's topic-help hook, which precedes subcommand dispatch. */
export async function prepareLazyIntegrationCommand(command: Command): Promise<void> {
  await commandLoaders.get(command)?.();
}

/** Keep root help cheap; configure the selected command before Commander parses it. */
export function configureLazyIntegrationCommands(program: Command, options: IntegrationCommandOptions,
  load: () => Promise<Pick<typeof import('./integration-cli.js'), 'configureIntegrationCommand'>>): void {
  for (const [name, description] of Object.entries(INTEGRATION_COMMAND_DESCRIPTIONS)) {
    const command = program.command(name).description(description);
    commandLoaders.set(command, async () => {
      if (command.commands.length === 0) (await load()).configureIntegrationCommand(command, options);
    });
  }
  program.hook('preSubcommand', async (_parent, command) => prepareLazyIntegrationCommand(command));
}
