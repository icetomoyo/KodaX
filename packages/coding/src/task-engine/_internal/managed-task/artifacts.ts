/**
 * Managed-task snapshot artifacts.
 *
 * Ported 1:1 from the legacy `task-engine.ts` helpers:
 *   - `writeManagedTaskSnapshotArtifacts` (legacy 5153) — writes 9 snapshot
 *     files to `workspaceDir` describing the task contract, evidence, and
 *     runtime state.
 *   - `writeManagedTaskArtifacts` (legacy 5204) — delegates the snapshot
 *     writes and adds `continuation.json` + `result.json`.
 *   - `buildManagedTaskArtifactRecords` (legacy 4324) — returns the 10
 *     `KodaXTaskEvidenceArtifact` records pointing at the files above so
 *     `task.evidence.artifacts` can surface them to downstream consumers.
 *   - `mergeEvidenceArtifacts` (legacy 4096) — dedupe artifact lists by
 *     resolved path.
 *   - `buildManagedTaskRoundHistory` (legacy 4444) — group evidence entries
 *     by round for the `round-history.json` snapshot.
 *   - `buildRuntimeExecutionGuide` (legacy _internal/prompts/runtime-
 *     execution-guide.ts, deleted in Shard 6d-b) — markdown guide for
 *     driving live verification against the declared runtime.
 *
 * The Runner-driven AMA path (FEATURE_084) lost all of this in Shard 6d-b;
 * Shard 6d-h restores it here so `evidence.artifacts` is populated and the
 * workspaceDir contains the same snapshot files the legacy path produced.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  KodaXManagedTask,
  KodaXResult,
  KodaXTaskEvidenceArtifact,
  KodaXTaskEvidenceEntry,
  KodaXTaskRole,
  KodaXTaskStatus,
  KodaXTaskVerificationContract,
} from '../../../types.js';

export function mergeEvidenceArtifacts(
  ...artifactSets: Array<readonly KodaXTaskEvidenceArtifact[] | undefined>
): KodaXTaskEvidenceArtifact[] {
  const merged = new Map<string, KodaXTaskEvidenceArtifact>();
  for (const artifactSet of artifactSets) {
    for (const artifact of artifactSet ?? []) {
      merged.set(path.resolve(artifact.path), artifact);
    }
  }
  return Array.from(merged.values());
}

export function buildManagedTaskRoundHistory(task: KodaXManagedTask): Array<{
  round: number;
  entries: Array<{
    assignmentId: string;
    title?: string;
    role: KodaXTaskRole;
    status: KodaXTaskStatus;
    summary?: string;
    sessionId?: string;
    signal?: KodaXTaskEvidenceEntry['signal'];
    signalReason?: string;
  }>;
}> {
  const rounds = new Map<number, Array<{
    assignmentId: string;
    title?: string;
    role: KodaXTaskRole;
    status: KodaXTaskStatus;
    summary?: string;
    sessionId?: string;
    signal?: KodaXTaskEvidenceEntry['signal'];
    signalReason?: string;
  }>>();

  for (const entry of task.evidence.entries) {
    const round = entry.round ?? 1;
    const roundEntries = rounds.get(round) ?? [];
    roundEntries.push({
      assignmentId: entry.assignmentId,
      title: entry.title,
      role: entry.role,
      status: entry.status,
      summary: entry.summary,
      sessionId: entry.sessionId,
      signal: entry.signal,
      signalReason: entry.signalReason,
    });
    rounds.set(round, roundEntries);
  }

  return Array.from(rounds.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([round, entries]) => ({
      round,
      entries,
    }));
}

export function buildRuntimeExecutionGuide(
  verification: KodaXTaskVerificationContract | undefined,
): string | undefined {
  const runtime = verification?.runtime;
  if (!runtime) {
    return undefined;
  }

  const lines = [
    '# Runtime Execution Guide',
    '',
    'Use this guide to drive live verification against the runtime under test.',
    '',
    runtime.cwd ? `- Working directory: ${runtime.cwd}` : undefined,
    runtime.startupCommand ? `- Startup command: ${runtime.startupCommand}` : undefined,
    runtime.readySignal ? `- Ready signal: ${runtime.readySignal}` : undefined,
    runtime.baseUrl ? `- Base URL: ${runtime.baseUrl}` : undefined,
    runtime.env && Object.keys(runtime.env).length > 0
      ? `- Environment keys: ${Object.keys(runtime.env).join(', ')}`
      : undefined,
    '',
    'Execution protocol:',
    runtime.startupCommand
      ? '1. Start or confirm the runtime using the declared startup command before accepting the task.'
      : '1. Confirm the target runtime is available before accepting the task.',
    runtime.readySignal || runtime.baseUrl
      ? '2. Wait until the runtime is ready, using the ready signal or base URL when available.'
      : '2. Confirm runtime readiness using the strongest observable signal you have.',
    runtime.uiFlows?.length
      ? ['3. Execute the declared UI flows:', ...runtime.uiFlows.map((flow, index) => `   ${index + 1}. ${flow}`)].join('\n')
      : '3. Execute the critical user-facing flow when browser verification is required.',
    runtime.apiChecks?.length
      ? ['4. Run the declared API checks:', ...runtime.apiChecks.map((check, index) => `   ${index + 1}. ${check}`)].join('\n')
      : undefined,
    runtime.dbChecks?.length
      ? ['5. Run the declared DB checks:', ...runtime.dbChecks.map((check, index) => `   ${index + 1}. ${check}`)].join('\n')
      : undefined,
    runtime.fixtures?.length
      ? ['6. Account for the declared fixtures:', ...runtime.fixtures.map((fixture, index) => `   ${index + 1}. ${fixture}`)].join('\n')
      : undefined,
    '',
    'Evidence requirements:',
    '- Capture concrete evidence for every hard-threshold criterion before accepting the task.',
    '- Reject completion if the runtime cannot be started, cannot reach readiness, or any declared flow/check fails.',
  ].filter((line): line is string => Boolean(line));

  return `${lines.join('\n')}\n`;
}

export function buildManagedTaskArtifactRecords(
  workspaceDir: string,
): KodaXTaskEvidenceArtifact[] {
  return [
    {
      kind: 'json',
      path: path.join(workspaceDir, 'contract.json'),
      description: 'Managed task contract snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'managed-task.json'),
      description: 'Managed task contract and evidence snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'result.json'),
      description: 'Managed task final result snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'round-history.json'),
      description: 'Managed task round history ledger',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'budget.json'),
      description: 'Managed task budget snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'memory-strategy.json'),
      description: 'Managed task memory strategy snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'runtime-contract.json'),
      description: 'Managed task runtime-under-test contract',
    },
    {
      kind: 'markdown',
      path: path.join(workspaceDir, 'runtime-execution.md'),
      description: 'Managed task runtime execution guide',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'scorecard.json'),
      description: 'Managed task verification scorecard',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'continuation.json'),
      description: 'Managed task continuation checkpoint',
    },
  ];
}

export async function writeManagedTaskSnapshotArtifacts(
  workspaceDir: string,
  task: KodaXManagedTask,
): Promise<void> {
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, 'contract.json'),
    `${JSON.stringify(task.contract, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'managed-task.json'),
    `${JSON.stringify(task, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'round-history.json'),
    `${JSON.stringify(buildManagedTaskRoundHistory(task), null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'budget.json'),
    `${JSON.stringify(task.runtime?.budget ?? null, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'memory-strategy.json'),
    `${JSON.stringify({
      strategies: task.runtime?.memoryStrategies ?? {},
      notes: task.runtime?.memoryNotes ?? {},
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'runtime-contract.json'),
    `${JSON.stringify(task.contract.verification?.runtime ?? null, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'runtime-execution.md'),
    buildRuntimeExecutionGuide(task.contract.verification) ?? 'No explicit runtime-under-test contract.\n',
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'scorecard.json'),
    `${JSON.stringify(task.runtime?.scorecard ?? null, null, 2)}\n`,
    'utf8',
  );
}

export async function writeManagedTaskArtifacts(
  workspaceDir: string,
  task: KodaXManagedTask,
  result: Pick<KodaXResult, 'success' | 'lastText' | 'sessionId' | 'signal' | 'signalReason' | 'signalDebugReason'>,
): Promise<void> {
  await writeManagedTaskSnapshotArtifacts(workspaceDir, task);
  // Match legacy `task-engine.ts:5216` continuation inference, but also
  // honour `task.verdict.continuationSuggested` — the Runner-driven path
  // populates that field directly from the Evaluator handoff shape and
  // does not set `verdict.disposition`, so the disposition-only check
  // would miss the revise → generator handoff case.
  const continuationSuggested = Boolean(
    task.verdict.continuationSuggested
      || task.verdict.disposition === 'needs_continuation'
      || (task.verdict.status === 'blocked' && task.verdict.signal === 'BLOCKED'),
  );
  const nextRound = (buildManagedTaskRoundHistory(task).at(-1)?.round ?? 0) + 1;
  const latestFeedbackArtifact = task.evidence.artifacts
    .filter((artifact) => artifact.path.endsWith(`${path.sep}feedback.json`)
      || artifact.path.endsWith('/feedback.json'))
    .at(-1)?.path;
  await writeFile(
    path.join(workspaceDir, 'continuation.json'),
    `${JSON.stringify({
      continuationSuggested,
      taskId: task.contract.taskId,
      status: task.contract.status,
      nextRound,
      signal: task.verdict.signal ?? null,
      signalReason: task.verdict.signalReason ?? null,
      signalDebugReason: task.verdict.signalDebugReason ?? null,
      disposition: task.verdict.disposition ?? null,
      latestFeedbackArtifact: latestFeedbackArtifact ?? null,
      roundHistoryPath: path.join(workspaceDir, 'round-history.json'),
      contractPath: path.join(workspaceDir, 'contract.json'),
      managedTaskPath: path.join(workspaceDir, 'managed-task.json'),
      scorecardPath: path.join(workspaceDir, 'scorecard.json'),
      runtimeContractPath: path.join(workspaceDir, 'runtime-contract.json'),
      runtimeExecutionGuidePath: path.join(workspaceDir, 'runtime-execution.md'),
      budgetPath: path.join(workspaceDir, 'budget.json'),
      harnessTransitions: task.runtime?.harnessTransitions ?? [],
      // Legacy `task-engine.ts:5240` shaped this field from the evaluator
      // directive + `buildManagedRoundPrompt`. The Runner-driven path has
      // no equivalent directive; leave the slot in place so the JSON shape
      // stays identical for downstream consumers.
      suggestedPrompt: null,
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
}
