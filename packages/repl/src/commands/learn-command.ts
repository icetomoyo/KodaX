import chalk from 'chalk';

import type { Command } from './types.js';

function writeOutput(line = ''): void {
  console.log(line);
}

function printHelp(): void {
  writeOutput(chalk.cyan('\n/learn - Inspect and control learned capabilities'));
  writeOutput(chalk.dim('  /learn                      Open the Learning Center'));
  writeOutput(chalk.dim('  /learn list [search]        List learned capabilities'));
  writeOutput(chalk.dim('  /learn ready [search]       List capabilities ready for review/control'));
  writeOutput(chalk.dim('  /learn pending [search]     Compatibility alias for `/learn ready`'));
  writeOutput(chalk.dim('  /learn show <name|slug>     Inspect a capability'));
  writeOutput(chalk.dim('  /learn trust|reject|disable|rollback <name|slug>'));
  writeOutput(chalk.dim('  /learn promote <name|slug|capability-id> [--scope user]'));
  writeOutput(chalk.dim('  /learn promote --help       Explain formal user-catalog promotion'));
  writeOutput(chalk.dim('  Compatibility: diff, approve and reject remain accepted.'));
  writeOutput(chalk.dim('  /learn help\n'));
}

interface LearnPromoteInvocation {
  readonly target?: string;
  readonly scope: 'user';
  readonly help: boolean;
  readonly error?: string;
}

function invalidPromoteInvocation(
  error: string,
  target?: string,
): LearnPromoteInvocation {
  return { ...(target === undefined ? {} : { target }), scope: 'user', help: false, error };
}

function parsePromoteOptions(
  target: string,
  options: readonly string[],
): LearnPromoteInvocation {
  let scope: string = 'user';
  let scopeSeen = false;
  for (let index = 0; index < options.length; index += 1) {
    const value = options[index]!;
    if (value === '--scope') {
      if (scopeSeen) return invalidPromoteInvocation('duplicate --scope option', target);
      const requestedScope = options[index + 1];
      if (!requestedScope) return invalidPromoteInvocation('missing value for --scope', target);
      scope = requestedScope;
      scopeSeen = true;
      index += 1;
      continue;
    }
    if (value.startsWith('--scope=')) {
      if (scopeSeen) return invalidPromoteInvocation('duplicate --scope option', target);
      scope = value.slice('--scope='.length);
      if (!scope) return invalidPromoteInvocation('missing value for --scope', target);
      scopeSeen = true;
      continue;
    }
    const error = value.startsWith('-')
      ? `unknown promote option: ${value}`
      : `unexpected promote argument: ${value}`;
    return invalidPromoteInvocation(error, target);
  }
  if (scope !== 'user') {
    return invalidPromoteInvocation(
      `unsupported promote scope: ${scope}; only user is supported`,
      target,
    );
  }
  return { target, scope: 'user', help: false };
}

function parseLearnPromoteInvocation(args: readonly string[]): LearnPromoteInvocation {
  const operands = args.slice(1);
  if (operands.some((value) => value === '--help' || value === '-h')
    || operands[0]?.toLowerCase() === 'help') {
    return { scope: 'user', help: true };
  }
  const target = operands[0];
  if (!target) {
    return invalidPromoteInvocation('missing learned Skill name, slug, or capability ID');
  }
  if (target.startsWith('-')) {
    return invalidPromoteInvocation(`unknown promote option: ${target}`);
  }
  return parsePromoteOptions(target, operands.slice(1));
}

function printPromoteHelp(): void {
  writeOutput(chalk.cyan('\n/learn promote - Move one learned Skill into the formal user catalog'));
  writeOutput(chalk.bold('\nUsage:'));
  writeOutput(chalk.dim('  /learn promote <name|slug|capability-id> [--scope user]'));
  writeOutput(chalk.dim('  /learn promote --help'));
  writeOutput(chalk.dim('  /help learn promote'));
  writeOutput(chalk.bold('\nWhat it does:'));
  writeOutput(chalk.dim('  Promote is an explicit ownership transfer, not automatic canary activation.'));
  writeOutput(chalk.dim('  Automatic evidence: testing -> active_learned inside the project Learned Area.'));
  writeOutput(chalk.dim('  Explicit promote: reviewed ready or active_learned -> promoted_user.'));
  writeOutput(chalk.dim('  The exact fingerprinted revision is copied to the configured KodaX'));
  writeOutput(chalk.dim('  user Skill directory (normally ~/.kodax/skills/<slug>/SKILL.md).'));
  writeOutput(chalk.dim('  Promotion never overwrites different formal Skill content.'));
  writeOutput(chalk.bold('\nBefore promoting:'));
  writeOutput(chalk.dim('  Use /learn show <name|slug> to inspect the exact revision and lifecycle.'));
  writeOutput(chalk.dim('  The Learning Center offers this action for active_learned Skills.'));
  writeOutput(chalk.bold('\nExamples:'));
  writeOutput(chalk.dim('  /learn promote normalize-release-notes'));
  writeOutput(chalk.dim('  /learn promote normalize-release-notes --scope user\n'));
}

async function runLearningCenterCommand(
  args: readonly string[],
  callbacks: Parameters<Command['handler']>[2],
): Promise<boolean> {
  const learning = callbacks.learning;
  if (!learning) return false;
  const subcommand = (args[0] ?? '').toLowerCase();
  if (subcommand === '' && callbacks.openLearningCenter) {
    const preview = await learning.list({ limit: 1 });
    if (preview.items.length === 0) {
      writeOutput(chalk.cyan('\n[learn] Learning Center'));
      writeOutput(chalk.dim('  Learning Center has no learned capabilities.\n'));
      return true;
    }
    await callbacks.openLearningCenter();
    return true;
  }
  if (
    subcommand === ''
    || subcommand === 'list'
    || subcommand === 'ready'
    || subcommand === 'pending'
  ) {
    if (subcommand === 'pending') {
      writeOutput(chalk.dim(
        '[learn] `pending` is a compatibility alias for /learn ready; '
        + 'Memory pipeline health: /memory doctor.',
      ));
    }
    const page = await learning.list({
      search: args.slice(1).join(' ').trim() || undefined,
      ...(subcommand === 'ready' || subcommand === 'pending'
        ? { lifecycle: 'ready' as const }
        : {}),
      limit: 200,
    });
    writeOutput(chalk.cyan('\n[learn] Learning Center'));
    if (page.items.length === 0) writeOutput(chalk.dim('  (none)'));
    const slugCounts = new Map<string, number>();
    for (const item of page.items) {
      slugCounts.set(item.slug, (slugCounts.get(item.slug) ?? 0) + 1);
    }
    for (const item of page.items) {
      const exactId = (slugCounts.get(item.slug) ?? 0) > 1
        ? ` ${chalk.dim(`id=${item.capabilityId}`)}`
        : '';
      writeOutput(`  ${chalk.cyan(item.slug)}${exactId} ${chalk.dim(`[${item.carrier}/${item.lifecycle}]`)} ${item.displayName}`);
    }
    writeOutput();
    return true;
  }
  const promoteInvocation = subcommand === 'promote'
    ? parseLearnPromoteInvocation(args)
    : undefined;
  const requestedName = promoteInvocation?.target ?? args[1];
  const capabilityId = requestedName
    ? await resolveLearningCapabilityId(learning, requestedName)
    : undefined;
  if ((subcommand === 'show' || subcommand === 'diff') && capabilityId) {
    if (callbacks.openLearningCenter) await callbacks.openLearningCenter(capabilityId);
    else writeOutput(`${JSON.stringify(await learning.get(capabilityId), null, 2)}\n`);
    return true;
  }
  if (!capabilityId) return false;
  if (subcommand === 'trust' || subcommand === 'approve') await learning.trust(capabilityId);
  else if (subcommand === 'reject') await learning.reject(capabilityId);
  else if (subcommand === 'disable') await learning.disable(capabilityId);
  else if (subcommand === 'rollback') await learning.rollback(capabilityId);
  else if (subcommand === 'promote') {
    if (!promoteInvocation || promoteInvocation.help || promoteInvocation.error) return false;
    await learning.promote(capabilityId, promoteInvocation.scope);
  }
  else if (subcommand === 'review') await learning.review(capabilityId);
  else return false;
  const displayTarget = requestedName ?? capabilityId;
  writeOutput(subcommand === 'promote'
    ? chalk.green(`\n[learn] promoted ${displayTarget} to the formal user Skill catalog.\n`)
    : chalk.dim(`\n[learn] ${subcommand} accepted for ${displayTarget}.\n`));
  return true;
}

async function resolveLearningCapabilityId(
  learning: NonNullable<Parameters<Command['handler']>[2]['learning']>,
  nameOrSlugOrLegacyId: string,
): Promise<string> {
  try {
    return (await learning.get(nameOrSlugOrLegacyId)).capabilityId;
  } catch (error: unknown) {
    const page = await learning.list({ limit: 200 });
    const legacyMatch = page.items.find((item) => (
      item.source.kind === 'f224_proposal'
      && item.source.proposalId === nameOrSlugOrLegacyId
    ));
    if (legacyMatch) return legacyMatch.capabilityId;
    throw error;
  }
}

export const learnCommand: Command = {
  name: 'learn',
  description: 'Inspect and control the Learning Center',
  usage: '/learn [list|ready|pending|show|review|trust|reject|disable|rollback|promote|help] [name|slug|capability-id] [--scope user]',
  argumentHint: 'list [search] | ready [search] | pending [search] | show <slug> | trust <slug> | disable <slug> | promote <slug> [--scope user] | help [promote]',
  handler: async (args, _context, callbacks) => {
    const subcommand = (args[0] ?? 'pending').toLowerCase();

    if (subcommand === 'help' || subcommand === '-h' || subcommand === '--help') {
      if (args[1]?.toLowerCase() === 'promote') printPromoteHelp();
      else printHelp();
      return;
    }

    if (subcommand === 'promote') {
      const invocation = parseLearnPromoteInvocation(args);
      if (invocation.help) {
        printPromoteHelp();
        return;
      }
      if (invocation.error) {
        writeOutput(chalk.yellow(`\n[learn] ${invocation.error}.\n`));
        printPromoteHelp();
        return;
      }
    }

    if (await runLearningCenterCommand(args, callbacks)) return;

    if (!callbacks.learning) {
      // FEATURE_298 T23 — without a Learning Center binding every control
      // reports unavailable; the command never touches another learning store.
      writeOutput(chalk.yellow('\n[learn] Learning Center controls are unavailable in this runtime.\n'));
      return;
    }
    writeOutput(chalk.yellow(`\n[learn] unknown subcommand or missing target: ${subcommand}\n`));
    printHelp();
  },
  detailedHelp: (args = []) => {
    if (args[0]?.toLowerCase() === 'promote') printPromoteHelp();
    else printHelp();
  },
};
