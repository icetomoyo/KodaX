import { Command } from 'commander';
import { HELP_WORKSPACE_ROOT } from './root.js';

export function configureKodaXToolsCommands(program: Command): void {
  // ============== tools subcommand (constructed-tool inventory) ==============
  // Lifecycle helpers for constructed tools — list / inspect / revoke.
  // Activate is intentionally NOT exposed here (must originate from the
  // REPL where a dialog can solicit user approval; see DD §14.5.4).
  const toolsCommand = program
    .command('tools')
    .description('Inspect and manage constructed tools')
    .helpOption('-h, --help', 'Show tools subcommand help');

  toolsCommand
    .command('list')
    .description('List constructed tools registered in the current workspace')
    .option('--all', 'Also list builtin / extension tools')
    .option(
      '--cwd <dir>',
      HELP_WORKSPACE_ROOT,
    )
    .action(async (subOpts: { all?: boolean; cwd?: string }) => {
      const { runToolsList } = await import('../constructed_cli.js');
      await runToolsList({
        all: subOpts.all,
        cwd: subOpts.cwd ?? process.cwd(),
      });
    });

  toolsCommand
    .command('inspect <spec>')
    .description(
      "Print an artifact manifest. <spec> is '<name>' (active) or '<name>@<version>'.",
    )
    .option(
      '--cwd <dir>',
      HELP_WORKSPACE_ROOT,
    )
    .action(async (spec: string, subOpts: { cwd?: string }) => {
      const { runToolsInspect } = await import('../constructed_cli.js');
      await runToolsInspect(spec, { cwd: subOpts.cwd ?? process.cwd() });
    });

  toolsCommand
    .command('revoke <spec>')
    .description(
      "Revoke a constructed tool. <spec> must be '<name>@<version>'.",
    )
    .option(
      '--cwd <dir>',
      HELP_WORKSPACE_ROOT,
    )
    .action(async (spec: string, subOpts: { cwd?: string }) => {
      const { runToolsRevoke } = await import('../constructed_cli.js');
      await runToolsRevoke(spec, { cwd: subOpts.cwd ?? process.cwd() });
    });

  // ============== constructed subcommand (FEATURE_090, v0.7.32) ==============
  // Self-modify lifecycle helpers for constructed agents — separate
  // command group from `kodax tools` because the surface targets
  // agent governance (budget reset, rollback, audit, disable), not
  // tool inventory. Activate is intentionally NOT exposed here for
  // the same reason as tools — must originate from the REPL where a
  // dialog can render the diff + LLM summary and solicit user
  // approval.
  const constructedCommand = program
    .command('constructed')
    .description(
      'Manage the self-modify lifecycle of constructed agents',
    )
    .helpOption('-h, --help', 'Show constructed subcommand help');

  constructedCommand
    .command('reset-self-modify-budget <name>')
    .description(
      'Reset the per-agent self-modify counter to zero. Use after a deliberate, audited decision to allow further self-modifications past the default cap. The reset is recorded in `.kodax/constructed/_audit.jsonl`.',
    )
    .option(
      '--cwd <dir>',
      HELP_WORKSPACE_ROOT,
    )
    .action(async (name: string, subOpts: { cwd?: string }) => {
      const { runResetSelfModifyBudget } = await import('../self_modify_cli.js');
      await runResetSelfModifyBudget(name, {
        cwd: subOpts.cwd ?? process.cwd(),
      });
    });

  constructedCommand
    .command('audit <name>')
    .description(
      'Print every recorded self-modify lifecycle event for the named agent (staged / activated / rejected / rolled-back / disabled / budget-reset). Read-only.',
    )
    .option(
      '--cwd <dir>',
      HELP_WORKSPACE_ROOT,
    )
    .action(async (name: string, subOpts: { cwd?: string }) => {
      const { runConstructedAudit } = await import('../self_modify_cli.js');
      await runConstructedAudit(name, { cwd: subOpts.cwd ?? process.cwd() });
    });

  constructedCommand
    .command('disable-self-modify <name>')
    .description(
      'Permanently disable self-modify for the named agent. There is NO re-enable command — to author further changes, stage a separately-named agent. The disable event is recorded in `.kodax/constructed/_audit.jsonl`.',
    )
    .option(
      '--cwd <dir>',
      HELP_WORKSPACE_ROOT,
    )
    .action(async (name: string, subOpts: { cwd?: string }) => {
      const { runDisableSelfModify } = await import('../self_modify_cli.js');
      await runDisableSelfModify(name, { cwd: subOpts.cwd ?? process.cwd() });
    });

  constructedCommand
    .command('rollback <name>')
    .description(
      'Roll the agent back to its previous active version. Revokes the current active manifest and re-registers the next-most-recent active version on disk. Re-runs admission against the rollback target so a target that no longer admits (e.g. system caps tightened) cannot be silently re-registered.',
    )
    .option(
      '--cwd <dir>',
      HELP_WORKSPACE_ROOT,
    )
    .action(async (name: string, subOpts: { cwd?: string }) => {
      const { runConstructedRollback } = await import('../self_modify_cli.js');
      await runConstructedRollback(name, { cwd: subOpts.cwd ?? process.cwd() });
    });
}
