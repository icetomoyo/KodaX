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
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { ensureKodaXHostClient } from '../local-host-client.js';
import type { CliHost } from './cli-host.js';
import { reported, withJsonOption } from './output.js';

/** What the session commands need from a Host connection. */
type SessionHost = Pick<CliHost, 'client'>;

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

export async function loadResumableSessions(host: SessionHost): Promise<SessionPickerItem[]> {
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

/** The newest sessions as lines; `kodax -r` searches and pages the rest. */
function renderSessionList(sessions: readonly SessionPickerItem[]): string {
  if (sessions.length === 0) return 'No resumable sessions.';
  const visible = sessions.slice(0, 50);
  const lines = visible.map((session) => {
    const surface = session.surface ? ` ${session.surface}` : '';
    return `  ${formatSessionTimestamp(session.lastMessageAt ?? session.createdAt)}  ${session.id} [${session.msgCount}]${surface} ${session.title}`;
  });
  if (sessions.length > visible.length) {
    lines.push(`  ... ${sessions.length - visible.length} more; use \`kodax -r\` to search and page.`);
  }
  return `Sessions:\n${lines.join('\n')}`;
}

/** A short-lived Host connection for one query; a Host it starts stops once idle. */
async function withHostClient<T>(version: string, use: (host: SessionHost) => Promise<T>): Promise<T> {
  const client = await ensureKodaXHostClient({
    client: { name: 'kodax-cli', version },
    exitWhenIdle: true,
    onError: (error: unknown) => emitKodaXDiagnostic({
      source: 'cli:sessions',
      level: 'warn',
      message: 'The Host connection reported an error.',
      detail: error instanceof Error ? error.message : String(error),
    }),
  });
  try {
    return await use({ client });
  } finally {
    client.close();
  }
}

async function deleteSession(sessionId: string): Promise<void> {
  await new FileSessionStorage().delete(sessionId);
  console.log(`Deleted session: ${sessionId}`);
}

async function deleteAllSessions(): Promise<void> {
  await new FileSessionStorage().deleteAll();
  console.log('Deleted all sessions.');
}

/** Previews, or with `apply` archives, the empty ACP placeholder sessions of this project. */
async function cleanupAcpSessions(apply: boolean, applyFlag: string): Promise<void> {
  const storage = new FileSessionStorage({ cwd: process.cwd() });
  const candidates = await findAcpPollutionCandidates(storage);
  console.log(`Matched ${candidates.length} empty ACP placeholder sessions in the current project.`);
  for (const candidate of candidates.slice(0, 10)) {
    console.log(`  ${candidate.id}${candidate.createdAt ? ` ${candidate.createdAt}` : ''}`);
  }
  if (candidates.length > 10) console.log(`  ... ${candidates.length - 10} more`);
  if (!apply) {
    console.log(`Preview only. Re-run with ${applyFlag} to archive these sessions reversibly.`);
    return;
  }
  const archived = await archiveAcpPollutionCandidates(storage, candidates);
  console.log(`Archived ${archived.length} sessions. Use the session SDK unarchive operation to restore one.`);
}

/** `-s` values that are operations rather than a Session ID to use. */
function legacyOperation(session: string | undefined): 'list' | 'delete' | 'delete-all' | 'cleanup-acp' | undefined {
  if (session === 'delete' || session?.startsWith('delete ')) return 'delete';
  return session === 'list' || session === 'delete-all' || session === 'cleanup-acp' ? session : undefined;
}

/** The legacy `-s list|delete <id>|delete-all|cleanup-acp` operations; `true` when one ran. */
export async function runLegacySessionOperation(
  options: CliOptions,
  opts: { readonly resume?: unknown; readonly applySessionCleanup?: unknown },
  getCliHost: () => Promise<SessionHost>,
): Promise<boolean> {
  const operation = legacyOperation(options.session);
  if (operation === undefined) return false;
  if (options.outputMode === 'json') {
    validateCliModeSelection(options, { resumeWithoutId: opts.resume === true });
  }
  const replacement = `kodax sessions ${operation}${operation === 'delete' ? ' <id>' : ''}`;
  process.stderr.write(`\`kodax -s ${operation}\` is now \`${replacement}\`; the -s form is removed in 0.7.100.\n`);

  if (operation === 'list') {
    console.log(renderSessionList(await loadResumableSessions(await getCliHost())));
  } else if (operation === 'cleanup-acp') {
    await cleanupAcpSessions(opts.applySessionCleanup === true, '--apply-session-cleanup');
  } else if (operation === 'delete-all') {
    await deleteAllSessions();
  } else {
    const quotedId = options.session?.startsWith('delete ') ? options.session.slice('delete '.length).trim() : undefined;
    const sessionId = quotedId || (options.session === 'delete' ? options.prompt[0]?.trim() : undefined);
    if (!sessionId) throw new Error('`-s delete` requires a session id. Usage: kodax sessions delete <id>');
    if (options.session === 'delete' && options.prompt.length > 1) {
      throw new Error('`-s delete` accepts exactly one session id.');
    }
    await deleteSession(sessionId);
  }
  return true;
}

export function configureKodaXSessionsCommand(program: Command, version: string): void {
  const listSessions = (): Promise<SessionPickerItem[]> => withHostClient(version, loadResumableSessions);
  const sessionsCommand = program
    .command('sessions')
    .description('List, delete and clean up saved KodaX sessions');

  withJsonOption(sessionsCommand
    .command('list', { isDefault: true })
    .description('List resumable sessions in the current project, newest first (the default)'))
    .action(reported(listSessions, renderSessionList));

  sessionsCommand
    .command('delete')
    .description('Delete one saved session')
    .argument('<id>', 'Session ID')
    .action(deleteSession);

  sessionsCommand
    .command('delete-all')
    .description('Delete every saved session')
    .action(deleteAllSessions);

  sessionsCommand
    .command('cleanup-acp')
    .description('Find empty ACP placeholder sessions in the current project; archive them with --apply')
    .option('--apply', 'Archive the matched sessions (reversible)')
    .action((subOpts: { apply?: boolean }) => cleanupAcpSessions(subOpts.apply === true, '--apply'));

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
