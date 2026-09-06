import chalk from 'chalk';

import {
  readLearningProposalStore,
  resolveLearningProposalStore,
  type StoredLearningProposal,
} from '@kodax-ai/agent';

export type LearningInboxFilter = 'skill' | 'workflow' | 'memory';

export function resolveLearningCommandCwd(context: { runtimeInfo?: { workspaceRoot?: string; executionCwd?: string } }): string {
  return (
    context.runtimeInfo?.workspaceRoot
    ?? context.runtimeInfo?.executionCwd
    ?? process.cwd()
  );
}

function writeOutput(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function matchesFilter(entry: StoredLearningProposal, filter: LearningInboxFilter): boolean {
  if (filter === 'skill') {
    return entry.proposal.destination === 'skill_patch' || entry.proposal.destination === 'skill_create';
  }
  if (filter === 'workflow') {
    return entry.proposal.destination === 'workflow_handoff';
  }
  return entry.proposal.destination === 'memdir_handoff'
    || entry.proposal.destination === 'reasoning_handoff';
}

function headingForFilter(filter: LearningInboxFilter): string {
  if (filter === 'skill') return 'pending method guides';
  if (filter === 'workflow') return 'pending runnable workflows';
  return 'pending memory handoffs';
}

function proposalLabel(entry: StoredLearningProposal): string {
  const proposal = entry.proposal;
  switch (proposal.destination) {
    case 'skill_patch':
    case 'skill_create':
      return `${proposal.destination} ${proposal.skillName}`;
    case 'workflow_handoff':
      return `${proposal.suggestedAction} ${proposal.evidenceRunIds.join(',')}`;
    case 'memdir_handoff':
      return `${proposal.memoryKind}`;
    case 'reasoning_handoff':
      return proposal.title;
  }
}

export async function printLearningPendingForFilter(cwd: string, filter: LearningInboxFilter): Promise<void> {
  const storePath = resolveLearningProposalStore(cwd);
  const store = await readLearningProposalStore(storePath);
  for (const warning of store.warnings) {
    writeOutput(chalk.yellow(`[learn] ${warning}`));
  }

  const pending = store.proposals
    .filter((entry) => entry.status === 'pending')
    .filter((entry) => matchesFilter(entry, filter));

  writeOutput(chalk.cyan(`\n[learn] ${headingForFilter(filter)}`));
  writeOutput(chalk.dim(`  ${storePath}`));
  if (pending.length === 0) {
    writeOutput(chalk.dim('  (none)\n'));
    return;
  }
  for (const entry of pending) {
    writeOutput(`  ${chalk.cyan(entry.proposalId)} ${chalk.dim(`[${entry.proposal.destination}]`)} ${proposalLabel(entry)}`);
  }
  writeOutput(chalk.dim('\n  Review these in the Learning Center (/learn list, /learn show <id>).\n'));
}
