import { Command } from 'commander';
import {
  parseEffortOption,
  parsePermissionModeOption,
  parseReasoningModeOption,
  parseRepoIntelligenceModeOption,
  mergeCommandOptionsWithGlobals,
} from '../cli_option_helpers.js';
import { KodaXReasoningMode } from '@kodax-ai/coding';
import type { AcpPermissionMode } from '../acp_server.js';
import { loadAcpServer } from '../cli-lazy-components.js';
import { HELP_EFFORT, HELP_REPO_INTELLIGENCE, HELP_THINKING } from './root.js';

const ACP_SERVE_HELP_FOOTER = `
Sessions, streaming, cancellation and permission prompts follow the same rules as the REPL.

Environment:
  KODAX_ACP_LOG=<level>  stderr log level: off, error, info, debug

Examples:
  kodax acp serve
  kodax acp serve --cwd C:\\repo --permission-mode accept-edits
  kodax acp serve -m openai --model gpt-5.4 --effort medium
`;

export function configureKodaXAcpCommand(program: Command, version: string): Command {
  const acpCommand = program
    .command('acp')
    .description('Run KodaX as an ACP server for editors and IDEs')
    .helpOption('-h, --help', 'Show ACP server help');

  acpCommand
    .command('serve')
    .description('Run KodaX as a stdio ACP server for editors and IDEs')
    .option('--cwd <dir>', 'Working directory exposed to ACP sessions')
    .option('-m, --provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    // prettier-ignore
    .option('--effort <level>', HELP_EFFORT, parseEffortOption)
    .option('-t, --thinking', HELP_THINKING)
    .option(
      '--reasoning <mode>',
      'Reasoning mode: off, auto, quick, balanced, deep',
      parseReasoningModeOption,
    )
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
      '--permission-mode <mode>',
      'Initial permission mode',
      parsePermissionModeOption,
      'accept-edits',
    )
    .action(
      async (
        localOptions: {
          cwd?: string;
          provider?: string;
          model?: string;
          effort?: string;
          thinking?: boolean;
          reasoning?: KodaXReasoningMode;
          repoIntelligence?: string;
          repoIntelligenceTrace?: boolean;
          permissionMode?: AcpPermissionMode;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        if (
          typeof options.repoIntelligence === 'string' &&
          options.repoIntelligence.trim()
        ) {
          process.env.KODAX_REPO_INTELLIGENCE = options.repoIntelligence.trim();
        }
        if (options.repoIntelligenceTrace === true) {
          process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
        }
        const { runAcpServer } = await loadAcpServer();
        await runAcpServer({
          cwd: options.cwd,
          provider: options.provider,
          model: options.model,
          effort: options.effort,
          thinking: options.thinking,
          reasoningMode: options.reasoning,
          permissionMode: options.permissionMode,
          agentVersion: version,
        });
      },
    )
    .addHelpText('after', ACP_SERVE_HELP_FOOTER);

  return acpCommand;
}
