import type {
  SessionPickerItem,
  SessionPickerRunOptions,
} from '@kodax-ai/repl/cli-resume';
import {
  listCliResumeSessions,
  runCliResumePicker,
} from '@kodax-ai/repl/cli-resume';

export type ResumeNotice = 'empty' | 'cancelled';

export type BareResumeRoute =
  | { readonly kind: 'continue'; readonly argv: readonly string[] }
  | { readonly kind: 'exit' };

export interface ResolveBareResumeOptions {
  readonly cwd?: string;
  readonly listSessions?: (options: {
    readonly projectRoot: string;
    readonly limit: number;
  }) => Promise<SessionPickerItem[]>;
  readonly pickSession?: (
    sessions: readonly SessionPickerItem[],
    options?: SessionPickerRunOptions,
  ) => Promise<SessionPickerItem | undefined>;
  readonly beforeSelect?: (session: SessionPickerItem) => Promise<void>;
  readonly notify?: (notice: ResumeNotice) => void | Promise<void>;
}

async function printResumeNotice(notice: ResumeNotice): Promise<void> {
  const { default: chalk } = await import('chalk');
  if (notice === 'empty') {
    process.stdout.write(`${chalk.yellow('No resumable sessions found. Starting a new session...')}\n`);
    return;
  }
  process.stdout.write(`${chalk.dim('Session resume cancelled.')}\n`);
}

export async function resolveBareResume(
  options: ResolveBareResumeOptions = {},
): Promise<BareResumeRoute> {
  const listSessions = options.listSessions ?? listCliResumeSessions;
  const pickSession = options.pickSession ?? runCliResumePicker;
  const notify = options.notify ?? printResumeNotice;
  const sessions = await listSessions({
    projectRoot: options.cwd ?? process.cwd(),
    limit: Number.MAX_SAFE_INTEGER,
  });
  if (sessions.length === 0) {
    await notify('empty');
    return { kind: 'continue', argv: [] };
  }
  const selected = await pickSession(sessions, {
    prepareSelection: options.beforeSelect,
  });
  if (!selected) {
    await notify('cancelled');
    return { kind: 'exit' };
  }
  return { kind: 'continue', argv: ['-r', selected.id] };
}
