import { Command } from 'commander';
import chalk from 'chalk';
import { type CliOptions, validateCliModeSelection } from '../cli_option_helpers.js';
import {
  archiveAcpPollutionCandidates,
  findAcpPollutionCandidates,
} from '../acp_session_cleanup.js';
import { toClientSession } from '../repl-host/view.js';
import { HostProtocolError } from '../host-protocol/codec.js';
import {
  FileSessionStorage,
  dedupeSessions,
  type SessionPickerItem,
  type SessionDedupeReport,
  formatSessionTimestamp,
} from '@kodax-ai/repl';
import { CliHost } from './cli-host.js';

function printSessionDedupeReport(
  report: SessionDedupeReport,
  applied: boolean,
): void {
  const action = applied ? 'Applied' : 'Dry run';
  console.log(chalk.cyan(`\nSession dedupe ${action}\n`));
  console.log(`Scanned: ${report.scanned}`);
  console.log(`Runner candidates: ${report.runnerCandidates}`);
  console.log(`Matched: ${report.matches.length}`);
  console.log(`Moved: ${report.moved.length}`);
  if (report.archiveDir) {
    console.log(`Archive: ${report.archiveDir}`);
  }

  if (report.matches.length > 0) {
    console.log(chalk.bold('\nMatches:'));
    for (const match of report.matches) {
      const marker = report.moved.some(
        (move) => move.runnerId === match.runnerId,
      )
        ? 'moved'
        : 'candidate';
      console.log(
        `  ${match.runnerId} -> ${match.canonicalId} (${marker}, score=${match.score})`,
      );
    }
  }

  if (report.skipped.length > 0) {
    const reasonCounts = new Map<string, number>();
    for (const skipped of report.skipped) {
      reasonCounts.set(
        skipped.reason,
        (reasonCounts.get(skipped.reason) ?? 0) + 1,
      );
    }
    console.log(chalk.bold('\nSkipped:'));
    for (const [reason, count] of reasonCounts.entries()) {
      console.log(`  ${reason}: ${count}`);
    }
  }

  if (!applied) {
    console.log(
      chalk.dim(
        '\nRun `kodax sessions dedupe --apply` to move uniquely matched runner ghosts.',
      ),
    );
  }
}

export async function loadResumableSessions(host: CliHost): Promise<SessionPickerItem[]> {
  const sessions: SessionPickerItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await host.client.call('session.list', {
      projectRoot: process.cwd(), limit: 200, ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const session of page.items) {
      const msgCount = session.messageCount ?? 0;
      if (msgCount > 0) sessions.push({ ...toClientSession(session), msgCount });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return sessions;
}

/** The Session to resume, or `undefined` when the Host has none by that id. */
export async function readResumeTarget(host: CliHost, sessionId: string): Promise<{ readonly id: string; readonly archived?: boolean } | undefined> {
  try {
    return (await host.client.call('session.get', { sessionId })).session;
  } catch (error: unknown) {
    if (error instanceof HostProtocolError && error.kodaxCode === 'not_found') return undefined;
    throw error;
  }
}

/** The legacy `-s list|delete <id>|delete-all|cleanup-acp` operations; `true` when one ran. */
export async function runLegacySessionOperation(
  options: CliOptions,
  opts: { readonly resume?: unknown; readonly applySessionCleanup?: unknown },
  getCliHost: () => Promise<CliHost>,
): Promise<boolean> {
  const isLegacySessionManagement =
    options.session === 'list' ||
    options.session === 'delete' ||
    options.session === 'delete-all' ||
    options.session === 'cleanup-acp' ||
    options.session?.startsWith('delete ');

  if (options.outputMode === 'json' && isLegacySessionManagement) {
    validateCliModeSelection(options, {
      resumeWithoutId: opts.resume === true,
    });
  }

  // Session list: show a bounded preview; bare -r provides searchable navigation.
  if (options.session === 'list') {
    const sessions = await loadResumableSessions(await getCliHost());
    const visible = sessions.slice(0, 50);
    const lines = visible.map((session) => {
      const surface = session.surface ? ` ${session.surface}` : '';
      return `  ${formatSessionTimestamp(session.lastMessageAt ?? session.createdAt)}  ${session.id} [${session.msgCount}]${surface} ${session.title}`;
    });
    if (sessions.length > visible.length) {
      lines.push(
        `  ... ${sessions.length - visible.length} more; use \`kodax -r\` to search and page.`,
      );
    }
    console.log(
      lines.length > 0
        ? `Sessions:\n${lines.join('\n')}`
        : 'No resumable sessions.',
    );
    return true;
  }

  if (options.session === 'cleanup-acp') {
    const storage = new FileSessionStorage({ cwd: process.cwd() });
    const candidates = await findAcpPollutionCandidates(storage);
    console.log(
      `Matched ${candidates.length} empty ACP placeholder sessions in the current project.`,
    );
    for (const candidate of candidates.slice(0, 10)) {
      console.log(
        `  ${candidate.id}${candidate.createdAt ? ` ${candidate.createdAt}` : ''}`,
      );
    }
    if (candidates.length > 10)
      console.log(`  ... ${candidates.length - 10} more`);
    if (opts.applySessionCleanup !== true) {
      console.log(
        'Preview only. Re-run with --apply-session-cleanup to archive these sessions reversibly.',
      );
      return true;
    }
    const archived = await archiveAcpPollutionCandidates(storage, candidates);
    console.log(
      `Archived ${archived.length} sessions. Use the session SDK unarchive operation to restore one.`,
    );
    return true;
  }

  if (options.session === 'delete-all') {
    const storage = new FileSessionStorage();
    await storage.deleteAll();
    console.log('Deleted all sessions.');
    return true;
  }

  const sessionOperation = options.session;
  if (
    sessionOperation === 'delete' ||
    sessionOperation?.startsWith('delete ')
  ) {
    const quotedId = sessionOperation.startsWith('delete ')
      ? sessionOperation.slice('delete '.length).trim()
      : undefined;
    const positionalId =
      sessionOperation === 'delete' ? options.prompt[0]?.trim() : undefined;
    const sessionId = quotedId || positionalId;
    if (!sessionId) {
      throw new Error(
        '`-s delete` requires a session id. Usage: kodax -s delete <id>',
      );
    }
    if (sessionOperation === 'delete' && options.prompt.length > 1) {
      throw new Error('`-s delete` accepts exactly one session id.');
    }
    const storage = new FileSessionStorage();
    await storage.delete(sessionId);
    console.log(`Deleted session: ${sessionId}`);
    return true;
  }
  return false;
}

export function configureKodaXSessionsCommand(program: Command): void {
  // ============== sessions subcommands ==============
  const sessionsCommand = program
    .command('sessions')
    .description('Manage saved KodaX sessions')
    .action(() => {
      console.log(chalk.cyan('\nKodaX Sessions\n'));
      console.log(chalk.bold('Commands:'));
      console.log(
        chalk.dim('  kodax sessions dedupe          ') +
          'Dry-run historical runner ghost cleanup',
      );
      console.log(
        chalk.dim('  kodax sessions dedupe --apply  ') +
          'Move uniquely matched runner ghosts to .dedupe-archive',
      );
      console.log(chalk.dim('\nLegacy:'));
      console.log(
        chalk.dim('  kodax -s list                  ') + 'List saved sessions',
      );
    });

  sessionsCommand
    .command('dedupe')
    .description(
      'Find and optionally move historical runner ghost session files',
    )
    .option(
      '--apply',
      'Move uniquely matched runner ghost files into .dedupe-archive',
    )
    .action(async (subOpts: { apply?: boolean }) => {
      const applied = subOpts.apply === true;
      const report = await dedupeSessions({ apply: applied });
      printSessionDedupeReport(report, applied);
    });
}
