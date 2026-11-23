import { Command } from 'commander';
import chalk from 'chalk';
import {
  parseOptionalNonNegativeInt,
  mergeCommandOptionsWithGlobals,
  resolveCliModelSelection,
  resolveCliProviderSelection,
} from '../cli_option_helpers.js';
import {
  type KodaXOptions,
  KODAX_DEFAULT_PROVIDER,
  generateSessionId,
  deriveCodingMemoryIdentity,
  drainCodingMemoryReviewInbox,
  installProductionLearningReviewer,
  resolveProvider,
} from '@kodax-ai/coding';
import { createMemoryControlPlane } from '@kodax-ai/agent';
import { loadConfig, FileSessionStorage } from '@kodax-ai/repl';

/**
 * FEATURE_289 (v0.7.85) §3.4 — `kodax memory review-drain`.
 *
 * Foreground, synchronous drain of the persisted episode-review inbox.
 * The background drain processes at most 2 jobs per run and is never
 * awaited, so the accumulated backlog can only be cleared here: this
 * command loops the same `drainCodingMemoryReviewInbox` path the runtime
 * uses until a pass makes no progress (or `--max` is reached). The
 * production reviewer is auto-installed with the same binding as
 * run-substrate.ts startup.
 */
export function configureKodaXMemoryCommand(program: Command): Command {
  const memoryCommand = program
    .command('memory')
    .description('Inspect and maintain governed memory review')
    .action(() => {
      console.log(chalk.cyan('\nKodaX Memory\n'));
      console.log(chalk.bold('Commands:'));
      console.log(
        chalk.dim('  kodax memory review-drain [--max N]  ') +
          'Drain pending memory review jobs in the foreground',
      );
      console.log();
    });

  memoryCommand
    .command('review-drain')
    .description('Drain pending memory review jobs in the foreground')
    .option(
      '--max <n>',
      'Maximum number of review jobs to process (default: unbounded)',
      parseOptionalNonNegativeInt,
    )
    .action(
      async (
        localOptions: { max?: number; provider?: string; model?: string },
        command: Command,
      ) => {
        await runMemoryReviewDrain(
          mergeCommandOptionsWithGlobals(localOptions, command),
        );
      },
    );

  return memoryCommand;
}

async function runMemoryReviewDrain(input: {
  readonly max?: number;
  readonly provider?: string;
  readonly model?: string;
}): Promise<void> {
  const config = loadConfig();
  const providerOverride = input.provider ?? process.env.KODAX_PROVIDER;
  const providerName = resolveCliProviderSelection(
    input.provider,
    process.env.KODAX_PROVIDER,
    config.provider,
    KODAX_DEFAULT_PROVIDER,
  );
  const provider = resolveProvider(providerName);
  if (!provider.isConfigured()) {
    console.error(
      chalk.red(`\n[memory review-drain] provider is not configured: ${providerName}`),
    );
    console.error(
      chalk.dim('  Run `kodax setup` or pass --provider <name> with configured credentials.\n'),
    );
    process.exitCode = 1;
    return;
  }
  const model = resolveCliModelSelection(
    providerOverride,
    input.model,
    config.provider,
    config.model,
  );
  const cwd = process.cwd();
  const sessionId = await generateSessionId();
  const baseOptions: KodaXOptions = {
    provider: providerName,
    ...(model === undefined ? {} : { model }),
    session: { storage: new FileSessionStorage({ cwd }), scope: 'user' },
  };
  // Same production-reviewer binding as run-substrate.ts startup.
  const options = installProductionLearningReviewer(baseOptions, provider, model);
  const identity = deriveCodingMemoryIdentity(options, cwd, sessionId);
  const controller = createMemoryControlPlane({
    cwd,
    identity,
    projectDocs: [],
    discoverSkills: false,
  });

  console.log(chalk.cyan('\n[memory review-drain] draining pending memory review jobs'));
  console.log(
    chalk.dim(
      `  provider: ${providerName}${model === undefined ? '' : `, model: ${model}`}` +
        `, max: ${input.max === undefined ? 'unbounded' : input.max}`,
    ),
  );

  const totals = { reviewed: 0, discarded: 0, failed: 0, deferred: 0 };
  // Each pass is capped at the background-drain budget (2 entries), so
  // loop until a pass makes no progress. A pass with zero reviewed and zero
  // discarded terminates the loop: the remaining jobs are not completable
  // right now — deferred entries are in backoff / fenced / recovering, and
  // failed-only passes must NOT count as progress, because legacy v1
  // failures carry no backoff and would loop forever while burning judge
  // tokens. Re-run after the v2 backoff window to retry failures.
  for (;;) {
    const processed = totals.reviewed + totals.discarded + totals.failed;
    if (input.max !== undefined && processed >= input.max) break;
    const result = await drainCodingMemoryReviewInbox(
      options,
      identity,
      controller,
      sessionId,
    );
    if (result === undefined) {
      console.log(
        chalk.yellow('[memory review-drain] drain unavailable: reviewer or session storage missing.'),
      );
      break;
    }
    totals.reviewed += result.reviewed;
    totals.discarded += result.discarded;
    totals.failed += result.failed;
    totals.deferred += result.deferred;
    if (result.reviewed + result.discarded === 0) break;
  }
  console.log(chalk.cyan('\n[memory review-drain] summary'));
  console.log(`  reviewed : ${totals.reviewed}`);
  console.log(`  discarded: ${totals.discarded}`);
  console.log(`  failed   : ${totals.failed}`);
  console.log(`  deferred : ${totals.deferred}`);
  console.log();
  if (totals.failed > 0) {
    process.exitCode = 1;
  }
}
