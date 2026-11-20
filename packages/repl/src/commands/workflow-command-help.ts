import chalk from 'chalk';

export function renderWorkflowHelp(): string {
  return [
    `${chalk.bold('/workflow')} - dynamic multi-agent workflow harness`,
    '',
    `${chalk.bold('Subcommands:')}`,
    `  ${chalk.cyan('/workflow list')}                         List built-in, pattern, and saved workflows. Alias: /workflow`,
    `  ${chalk.cyan('/workflow create <request>')}             Build & run a workflow for a request. The Worker investigates first, then authors it (scout-then-author).`,
    `  ${chalk.cyan('/workflow <request>')}                    Shorthand for create when the first word isn't a known workflow name or subcommand.`,
    `  ${chalk.cyan('/workflow <name> [args]')}                Run a built-in or saved workflow by name. Args may be JSON or bare text.`,
    `  ${chalk.cyan('/workflow runs [--all|--limit N]')}       List active and recent workflow runs for this project.`,
    `  ${chalk.cyan('/workflow show [--full] [runId]')}        Show the latest run; use --full for complete result artifacts.`,
    `  ${chalk.cyan('/workflow pause <runId>')}                Pause future child launches for an active run.`,
    `  ${chalk.cyan('/workflow resume <runId>')}               Resume a paused run.`,
    `  ${chalk.cyan('/workflow stop [runId]')}                 Stop an active run through abort propagation. Defaults to the active run.`,
    `  ${chalk.cyan('/workflow delete [--force] [--run|--saved] <runId|savedName>')} Delete one persisted run record or generated saved capsule; --force removes stale non-terminal run records.`,
    `  ${chalk.cyan('/workflow prune --dry-run|--keep N|--older-than Nd')}`,
    `                                            Preview or delete old terminal run records.`,
    `  ${chalk.cyan('/workflow rerun <runId|savedName> [args]')} Rerun a historical generated run, or run the current saved workflow by name.`,
    `  ${chalk.cyan('/workflow save <runId> <name>')}          Save a generated run as a workflow capsule.`,
    `  ${chalk.cyan('/workflow rename <runId|alias|savedName> <newName>')} Rename a run display name or generated saved capsule.`,
    `  ${chalk.cyan('/workflow revise [--replace] <runId|alias|savedName> <change>')} Generate and save a capsule revision.`,
    `  ${chalk.cyan('/workflow help')}                         Show this help. Also available as /help workflow.`,
    '',
    `${chalk.bold('Examples:')}`,
    `  ${chalk.dim('/workflow create Compare three flaky-test hypotheses and verify each one')}`,
    `  ${chalk.dim('/workflow parallel-investigation {"question":"请检查这个竞态在哪里","targets":["packages/agent"]}')}`,
    `  ${chalk.dim('/workflow rerun run-lx3 {"request":"请用同样流程复查 packages/repl"}')}`,
    `  ${chalk.dim('/workflow rerun generated-audit {"request":"reuse the saved workflow for packages/repl"}')}`,
    `  ${chalk.dim('/workflow prune --dry-run')}`,
    `  ${chalk.dim('/workflow save run-lx3 generated-audit')}`,
    '',
    `${chalk.bold('Safety:')}`,
    '  - Generated and workflow capsule (.workflow.json) workflows run in the capability WorkflowApi runner.',
    '  - For rerun, a run id reruns its saved snapshot; a saved name runs the current saved capsule version.',
    '  - For revise --replace, only a saved generated capsule name can move; the previous capsule is archived.',
    '  - Local .ts/.mjs/.js workflows are trusted-local and require explicit confirmation.',
    '  - File, shell, MCP, and web effects still go through child agents and existing permission gates.',
  ].join('\n');
}

export function printWorkflowHelp(): void {
  console.log(`\n${renderWorkflowHelp()}\n`);
}

