import { Command, CommanderError, Option } from 'commander';
import {
  parseAgentModeOption,
  parseWorkModeOption,
  parseEffortOption,
  parseOutputModeOption,
  parseReasoningModeOption,
  parseRepoIntelligenceModeOption,
} from '../cli_option_helpers.js';
import { prepareLazyIntegrationCommand } from '../integration-cli-lazy.js';
import { loadProviderAuth } from '../cli-lazy-components.js';

export const HELP_WORKSPACE_ROOT = "Workspace root to inspect (defaults to current directory)";
export const HELP_DAEMON_HOME = "Base directory whose .kodax holds the Host state";
export const EFFORT_LEVELS = ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const HELP_EFFORT = `Reasoning effort: ${EFFORT_LEVELS.join(', ')}, or model-supported value`;
export const HELP_REPO_INTELLIGENCE = "Repo intelligence mode: auto, full, light, off";
export const HELP_SESSION = "Use this session ID (resume = most recent); list, delete and the other operations moved to `kodax sessions`";
export const HELP_THINKING = "Compatibility alias for --reasoning auto";

/** The command `name` (or one of its aliases) names, if any. */
export function findKodaXCommand(program: Command, name: string): Command | undefined {
  return program.commands.find((command) => command.name() === name || command.aliases().includes(name));
}

/** Lazy groups register their subcommands on first use; help and completion need them registered. */
export async function loadLazyCommand(root: Command, command: Command): Promise<void> {
  await prepareLazyIntegrationCommand(command);
  if (command.name() === 'auth' && command.commands.length === 0) {
    (await loadProviderAuth()).configureProviderAuthCommand(root, command);
  }
}

/** Removed root flags. Each still parses so the user gets a pointer instead of "unknown option". */
const REMOVED_ROOT_OPTIONS = [
  { flags: '-n, --new', pointer: 'a new session is already the default, so drop the flag' },
  { flags: '-y, --auto', pointer: 'set permissionMode in ~/.kodax/config.json, or use /mode in the REPL' },
  { flags: '--extension <path>', pointer: 'register the extension with `kodax extensions add <path>`' },
] as const;

/** Commander's parse errors that mean "you typed it wrong" rather than "it ran and failed". */
const USAGE_ERROR_CODES = new Set([
  'commander.unknownOption',
  'commander.unknownCommand',
  'commander.missingArgument',
  'commander.optionMissingArgument',
  'commander.missingMandatoryOptionValue',
  'commander.conflictingOption',
  'commander.excessArguments',
  'commander.invalidArgument',
]);

/**
 * Commander exits 1 for every parse error. Usage errors exit 2 so a script can
 * tell a mistyped command from one that ran and failed. Set it on the root
 * before adding commands: `.command()` copies it to each child it creates.
 */
export function exitWithUsageCode(error: CommanderError): never {
  process.exit(USAGE_ERROR_CODES.has(error.code) ? 2 : error.exitCode);
}

export function configureKodaXRootCommand(program: Command): Command {
  const configured = (
    program
      // `-h [topic]` replaces Commander's help option: a topic can name a command or a guide.
      .helpOption(false)
      .argument('[prompt...]', 'Prompt text for a single CLI run')
      .option('-h, --help [topic]', 'Show help, or detailed help for a topic')
      .option('-p, --print <text>', 'Print mode: run single task and exit')
      .option('--mode <mode>', 'Output mode: json', parseOutputModeOption)
      .option(
        '-c, --continue',
        'Continue most recent non-empty conversation in current directory',
      )
      .option(
        '-r, --resume [id-or-title]',
        'Resume session by ID or exact title (no value = open searchable session picker)',
      )
      .option('-m, --provider <name>', 'LLM provider')
      .option('--model <name>', 'Model override')
      .option('-t, --thinking', HELP_THINKING)
      .option(
        '--effort <level>',
        HELP_EFFORT,
        parseEffortOption,
      )
      .option(
        '--reasoning <mode>',
        'Reasoning mode: off, auto, quick, balanced, deep',
        parseReasoningModeOption,
      )
      .addOption(new Option('--agent-mode <mode>').argParser(parseAgentModeOption).hideHelp())
      .option('--work-mode <mode>', 'Session work mode: agent, coding (default), script', parseWorkModeOption)
      .option(
        '--repo-intelligence <mode>',
        HELP_REPO_INTELLIGENCE,
        parseRepoIntelligenceModeOption,
      )
      .option(
        '--repo-intelligence-trace',
        'Enable repo intelligence trace metadata/logging',
      )
      .option(
        '-s, --session <op>',
        HELP_SESSION,
      )
      // Only the old `-s cleanup-acp` form reads it; `kodax sessions cleanup-acp --apply` replaces both.
      .addOption(new Option('--apply-session-cleanup').hideHelp())
      .option('--no-session', 'Disable session persistence (print mode only)')
      .option(
        '--max-iter <n>',
        'Max iterations (default: 200 from coding package)',
      )
      .allowUnknownOption(false)
      // Keep the root command executable even when subcommands like `skill` exist.
      .action(() => {})
  );
  for (const removed of REMOVED_ROOT_OPTIONS) {
    const option = new Option(removed.flags).hideHelp();
    configured.addOption(option).on(`option:${option.name()}`, () => {
      configured.error(`error: ${option.flags} was removed; ${removed.pointer}`, {
        exitCode: 2,
        code: 'kodax.removedOption',
      });
    });
  }
  // Topic help is a root option, consumed before subcommand dispatch.
  // Stop before any nested action or argument validation can run.
  configured.hook('preSubcommand', async (root, command) => {
    if (root.opts().help === undefined) return;
    await loadLazyCommand(root, command);
    let target = command;
    for (const name of root.args.slice(1)) {
      const child = target.commands.find(candidate => candidate.name() === name || candidate.aliases().includes(name));
      if (!child) break;
      target = child;
    }
    target.help();
  });
  return configured;
}
