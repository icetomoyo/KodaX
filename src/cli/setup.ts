import { Command } from 'commander';
import chalk from 'chalk';
import {
  providerSetupRestartInstructions,
  runProviderSetupWizard,
  initializeSetupConfiguration,
  renderSetupGuide,
} from '@kodax-ai/repl';
import { parseA2AIntegrationDocument } from '../a2a/config.js';
import { prepareSetupSandboxReport } from './interactive-sandbox.js';

function printProviderSetupCompletion(selection: {
  readonly provider: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly configPath: string;
}, credentialSource?: 'file'): void {
  process.stdout.write(
    `${chalk.green(`\nProvider setup saved: ${selection.provider}/${selection.model}`)}\n`,
  );
  process.stdout.write(`${chalk.dim(`Config: ${selection.configPath}`)}\n`);
  for (const line of providerSetupRestartInstructions({
    apiKeyEnv: selection.apiKeyEnv, credentialSource,
  })) {
    process.stdout.write(`  ${line}\n`);
  }
}

export async function executeProviderSetup(
  input: { readonly customOnly?: boolean } = {},
): Promise<void> {
  process.stdout.write(`\n${renderSetupGuide()}\n\n`);
  const sandbox = await prepareSetupSandboxReport();
  const sandboxLabel = sandbox.status === 'ready'
    ? chalk.green('active')
    : sandbox.status === 'cancelled'
      ? chalk.yellow('cancelled')
      : chalk.yellow('not active');
  process.stdout.write(`Sandbox: [${sandboxLabel}]\n`);
  for (const line of sandbox.lines) process.stdout.write(`  ${line}\n`);
  process.stdout.write('\n');
  const initialized = initializeSetupConfiguration({
    validateA2A: parseA2AIntegrationDocument,
  });
  for (const file of initialized.files) {
    const marker =
      file.status === 'created'
        ? chalk.green('created')
        : file.status === 'invalid'
          ? chalk.red('invalid')
          : file.status === 'missing'
            ? chalk.yellow('missing')
            : chalk.dim('existing');
    process.stdout.write(`  [${marker}] ${file.path}\n`);
    if (file.diagnostic)
      process.stdout.write(`      ${chalk.red(file.diagnostic)}\n`);
  }
  process.stdout.write('\n');
  if (initialized.files.some((file) => file.status === 'invalid')) {
    process.stderr.write(
      `${chalk.red('Setup stopped: fix the invalid active configuration above, then run `kodax setup` again.')}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const result = await runProviderSetupWizard({ customOnly: input.customOnly });
  if (result.status === 'cancelled') {
    process.stdout.write(
      `${chalk.dim(
        'Provider setup cancelled. Configuration files remain initialized; run `kodax setup` when ready.',
      )}\n`,
    );
    return;
  }
  printProviderSetupCompletion(result.selection, result.credentialSource);
}

export function configureKodaXSetupCommand(program: Command): Command {
  const setupCommand = program
    .command('setup')
    .description(
      'Initialize configuration and configure provider credentials',
    )
    .helpOption(
      '-h, --help',
      'Show the complete setup guide without changing files',
    )
    .option(
      '--custom',
      'Interactively configure a custom OpenAI/Anthropic-compatible provider',
    )
    .action((options: { readonly custom?: boolean }) =>
      executeProviderSetup({
        customOnly: options.custom === true,
      }),
    );
  setupCommand.addHelpText('after', () => `\n${renderSetupGuide()}\n`);
  return setupCommand;
}

export function showKodaXSetupHelpIfRequested(
  argv: readonly string[],
  setupCommand: Command,
): boolean {
  if (
    argv[0] !== 'setup' ||
    !argv.slice(1).some((arg) => arg === '-h' || arg === '--help')
  ) {
    return false;
  }
  setupCommand.outputHelp();
  return true;
}
