import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import chalk from 'chalk';
import { getAgentConfigPath } from '@kodax-ai/agent';
import type {
  WorkflowApprovalSummary,
  WorkflowArtifactRef,
  WorkflowCapsule,
  WorkflowCapsuleProvenance,
  WorkflowEvent,
  WorkflowMeta,
  WorkflowModule,
  WorkflowProcessSnapshot,
  WorkflowScriptManifest,
} from '@kodax-ai/agent';
import {
  discoverSavedWorkflows,
  loadSavedWorkflowCapsule,
  loadSavedWorkflow,
  preflightWorkflowCapsule,
  resolveWorkflowIdentity,
  safeWorkflowArtifactName,
  type ManagedWorkflowSnapshot,
  type SavedWorkflowDirs,
  type SavedWorkflowRef,
} from '@kodax-ai/coding';

import { KODAX_VERSION } from '../common/utils.js';
import type { WorkflowPruneOptions } from './workflow-command-parse.js';
import {
  detectWorkflowLocale,
  formatArtifactResult,
  formatResult,
  inferWorkflowLocaleFromParts,
  isWorkflowResultPreviewTruncated,
  replaceWorkflowResultTruncationMarker,
} from './workflow-command-results.js';
export { printWorkflowHelp, renderWorkflowHelp } from './workflow-command-help.js';
export {
  createWorkflowAgentDigestLimiter,
  detectWorkflowLocale,
  formatArtifactResult,
  formatFinalEventSummary,
  formatResult,
  formatWorkflowAgentDigest,
  formatWorkflowCompletionAnswer,
  formatWorkflowLaunchAnswer,
  inferWorkflowLocaleFromParts,
  isWorkflowResultPreviewTruncated,
  replaceWorkflowResultTruncationMarker,
  type WorkflowResultFormatOptions,
  type WorkflowRunLocale,
  type WorkflowRunPresentation,
} from './workflow-command-results.js';

const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'stopped', 'denied', 'cancelled']);

export function formatWorkflowList(metas: readonly WorkflowMeta[]): string {
  if (metas.length === 0) return '  (no built-in workflows)';
  return metas.map((m) => `  ${chalk.cyan(m.name)} — ${m.description}`).join('\n');
}

export interface WorkflowApprovalRenderContext {
  readonly source: string;
  readonly sandbox: string;
  readonly mayUseWorktree: boolean;
  readonly rawScriptPath?: string;
  readonly rawScript?: string;
}

const APPROVAL_SCRIPT_PREVIEW_LINES = 6;
const APPROVAL_SCRIPT_PREVIEW_CHARS = 900;

function renderApprovalScriptPreview(source: string): readonly string[] {
  const lines = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const preview: string[] = [];
  let usedChars = 0;
  let truncatedByChars = false;

  for (const line of lines) {
    if (preview.length >= APPROVAL_SCRIPT_PREVIEW_LINES) break;
    const indented = `    ${line}`;
    const remainingChars = APPROVAL_SCRIPT_PREVIEW_CHARS - usedChars;
    if (remainingChars <= 0) {
      truncatedByChars = true;
      break;
    }
    if (indented.length > remainingChars) {
      if (remainingChars > 16) {
        preview.push(`${indented.slice(0, remainingChars - 4)} ...`);
      }
      truncatedByChars = true;
      break;
    }
    preview.push(indented);
    usedChars += indented.length + 1;
  }

  const omittedLines = Math.max(0, lines.length - preview.length);
  if (omittedLines > 0 || truncatedByChars) {
    const omitted = omittedLines > 0
      ? `${omittedLines} more line(s)`
      : 'source truncated';
    preview.push(`    ... (${omitted}; full source omitted from prompt)`);
  }
  return preview;
}

export function renderApprovalPrompt(
  summary: WorkflowApprovalSummary,
  context?: WorkflowApprovalRenderContext,
): string {
  const cap = (n: number | null): string => (n === null ? '∞' : String(n));
  const planned = summary.plannedAgents === undefined ? undefined : String(summary.plannedAgents);
  const agentScale = planned === undefined
    ? `agent total cap: ${cap(summary.maxAgents)}`
    : `planned agents: ${planned} · agent safety cap: ${cap(summary.maxAgents)}`;
  return [
    `Run workflow ${chalk.cyan(summary.name)}?`,
    `  ${summary.description}`,
    `  phases: ${summary.phases.length > 0 ? summary.phases.join(' → ') : '(dynamic)'}`,
    `  ${agentScale} · max concurrency: ${cap(summary.maxConcurrency)} · token budget: ${cap(summary.tokenBudget)}`,
    `  writes files: ${summary.writesFiles ? chalk.yellow('yes') : 'no (read-only)'}`,
    ...(context
      ? [
          `  source: ${context.source}`,
          `  sandbox/trust: ${context.sandbox}`,
          `  worktree isolation: ${context.mayUseWorktree ? 'may request worktree' : 'shared cwd / per-child default'}`,
          ...(context.rawScriptPath
            ? [`  raw script: ${context.rawScriptPath}`]
            : context.rawScript
              ? ['  raw script: preview below']
              : []),
          ...(context.rawScript && !context.rawScriptPath
            ? ['  raw script preview:', ...renderApprovalScriptPreview(context.rawScript)]
            : []),
        ]
      : []),
  ].join('\n');
}

export interface WorkflowRunSummary {
  readonly runId: string;
  readonly workflow: string;
  readonly status: string;
  readonly totalSpawned: number;
  readonly endedAt: number;
}

export interface WorkflowRunDetail {
  readonly runId: string;
  readonly workflow: string;
  readonly status: string;
  readonly totalSpawned: number;
  readonly eventCount: number;
  readonly runDir: string;
  readonly canRerun: boolean;
  readonly scriptSnapshotPath?: string;
  readonly manifestSnapshotPath?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly artifacts: readonly string[];
  readonly events: readonly WorkflowEvent[];
}

/** Read every `<runId>/run.json` under a project's workflow-runs dir. */
export function readWorkflowRuns(baseDir: string): WorkflowRunSummary[] {
  if (!existsSync(baseDir)) return [];
  const runs: WorkflowRunSummary[] = [];
  for (const entry of readdirSync(baseDir)) {
    const runJsonPath = join(baseDir, entry, 'run.json');
    if (!existsSync(runJsonPath)) continue;
    try {
      const data = JSON.parse(readFileSync(runJsonPath, 'utf8')) as Record<string, unknown>;
      runs.push({
        runId: entry,
        workflow: typeof data.workflow === 'string' ? data.workflow : '?',
        status: typeof data.status === 'string' ? data.status : '?',
        totalSpawned: typeof data.totalSpawned === 'number' ? data.totalSpawned : 0,
        endedAt: typeof data.endedAt === 'number' ? data.endedAt : 0,
      });
    } catch {
      // skip malformed run.json
    }
  }
  return runs.sort((a, b) => b.endedAt - a.endedAt);
}

function readWorkflowEvents(runDir: string): WorkflowEvent[] {
  const eventsPath = join(runDir, 'events.jsonl');
  if (!existsSync(eventsPath)) return [];
  const lines = readFileSync(eventsPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const events: WorkflowEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.seq !== 'number' || typeof record.type !== 'string') continue;
      const data = record.data;
      events.push({
        seq: record.seq,
        type: record.type as WorkflowEvent['type'],
        ...(typeof data === 'object' && data !== null
          ? { data: data as Record<string, unknown> }
          : {}),
      });
    } catch {
      // A partially written event line should not make the whole run unreadable.
    }
  }
  return events;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function hasGeneratedWorkflowSnapshot(
  runDir: string,
  data?: Record<string, unknown>,
): boolean {
  const scriptPath = data
    ? readNonEmptyString(data.scriptSnapshotPath)
    : join(runDir, 'script.js');
  const manifestPath = data
    ? readNonEmptyString(data.manifestSnapshotPath)
    : join(runDir, 'manifest.json');
  if (!scriptPath || !manifestPath) return false;
  return existsSync(scriptPath) && existsSync(manifestPath);
}

function hasRerunnableGeneratedWorkflowRun(
  runDir: string,
  data?: Record<string, unknown>,
): boolean {
  if (data) return hasGeneratedWorkflowSnapshot(runDir, data);
  const runJsonPath = join(runDir, 'run.json');
  if (!existsSync(runJsonPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(runJsonPath, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? hasGeneratedWorkflowSnapshot(runDir, parsed as Record<string, unknown>)
      : false;
  } catch {
    return false;
  }
}

function readWorkflowFailure(events: readonly WorkflowEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== 'workflow_failed') continue;
    const error = event.data?.error;
    if (typeof error === 'string' && error.trim().length > 0) return error;
  }
  return undefined;
}

export function readWorkflowRunDetail(baseDir: string, runId: string): WorkflowRunDetail | undefined {
  const runDir = join(baseDir, runId);
  const runJsonPath = join(runDir, 'run.json');
  const events = readWorkflowEvents(runDir);
  const failure = readWorkflowFailure(events);
  if (!existsSync(runJsonPath) && events.length === 0) return undefined;

  if (!existsSync(runJsonPath)) {
    return {
      runId,
      workflow: '?',
      status: failure ? 'failed' : 'running',
      totalSpawned: events.filter((event) => event.type === 'agent_spawned').length,
      eventCount: events.length,
      runDir,
      canRerun: false,
      artifacts: [],
      events,
      ...(failure ? { error: failure } : {}),
    };
  }

  try {
    const data = JSON.parse(readFileSync(runJsonPath, 'utf8')) as Record<string, unknown>;
    const scriptSnapshotPath = readNonEmptyString(data.scriptSnapshotPath);
    const manifestSnapshotPath = readNonEmptyString(data.manifestSnapshotPath);
    return {
      runId,
      workflow: typeof data.workflow === 'string' ? data.workflow : '?',
      status: typeof data.status === 'string' ? data.status : '?',
      totalSpawned: typeof data.totalSpawned === 'number' ? data.totalSpawned : 0,
      eventCount: events.length,
      runDir,
      canRerun: hasRerunnableGeneratedWorkflowRun(runDir, data),
      ...(scriptSnapshotPath ? { scriptSnapshotPath } : {}),
      ...(manifestSnapshotPath ? { manifestSnapshotPath } : {}),
      ...(typeof data.startedAt === 'number' ? { startedAt: data.startedAt } : {}),
      ...(typeof data.endedAt === 'number' ? { endedAt: data.endedAt } : {}),
      ...(failure ? { error: failure } : {}),
      artifacts: readStringArray(data.artifacts),
      events,
    };
  } catch {
    return {
      runId,
      workflow: '?',
      status: failure ? 'failed' : 'unknown',
      totalSpawned: events.filter((event) => event.type === 'agent_spawned').length,
      eventCount: events.length,
      runDir,
      canRerun: false,
      artifacts: [],
      events,
      ...(failure ? { error: failure } : {}),
    };
  }
}

function statusIcon(status: string): string {
  if (status === 'completed') return chalk.green('ok');
  if (status === 'failed') return chalk.red('x');
  if (status === 'running') return chalk.cyan('run');
  if (status === 'paused') return chalk.yellow('pause');
  if (status === 'stopped') return chalk.dim('stop');
  if (status === 'denied') return chalk.dim('deny');
  if (status === 'cancelled') return chalk.dim('cancel');
  return chalk.dim('-');
}

export function isTerminalWorkflowStatus(status: string): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

export interface WorkflowRunsListFormatOptions {
  readonly limit?: number;
  readonly showLimitHint?: boolean;
  readonly processSnapshots?: ReadonlyMap<string, WorkflowProcessSnapshot>;
}

function formatProcessListMeta(snapshot: WorkflowProcessSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  const parts: string[] = [];
  if (snapshot.displayName && snapshot.displayName !== snapshot.workflowName) {
    parts.push(`display: ${snapshot.displayName}`);
  }
  if (snapshot.source) parts.push(`source: ${snapshot.source}`);
  if (snapshot.savedWorkflowName) parts.push(`saved: ${snapshot.savedWorkflowName}`);
  if (snapshot.revisionOf) parts.push(`revision of: ${snapshot.revisionOf}`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export function formatRunsList(
  runs: readonly WorkflowRunSummary[],
  options: WorkflowRunsListFormatOptions = {},
): string {
  if (runs.length === 0) return '  (no workflow runs yet)';
  const limit = options.limit === undefined
    ? undefined
    : Math.max(1, Math.floor(options.limit));
  const visibleRuns = limit === undefined ? runs : runs.slice(0, limit);
  if (options.processSnapshots) {
    const lines = visibleRuns.map((r) => {
      const processMeta = formatProcessListMeta(options.processSnapshots?.get(r.runId));
      return `  ${statusIcon(r.status)} ${chalk.cyan(r.workflow)} ${chalk.dim(r.runId)} - ${r.status} (${r.totalSpawned} agents)${
        processMeta ? chalk.dim(` [${processMeta}]`) : ''
      }`;
    });
    if (options.showLimitHint === true && limit !== undefined && runs.length > visibleRuns.length) {
      lines.push(
        chalk.dim(`  Showing ${visibleRuns.length} of ${runs.length} persisted runs. Use /workflow runs --all to show all.`),
      );
    }
    return lines.join('\n');
  }
  const lines = visibleRuns
    .map(
      (r) =>
        `  ${statusIcon(r.status)} ${chalk.cyan(r.workflow)} ${chalk.dim(r.runId)} — ${r.status} (${r.totalSpawned} agents)`,
    );
  if (options.showLimitHint === true && limit !== undefined && runs.length > visibleRuns.length) {
    lines.push(
      chalk.dim(`  Showing ${visibleRuns.length} of ${runs.length} persisted runs. Use /workflow runs --all to show all.`),
    );
  }
  return lines.join('\n');
}

export function formatManagedRunsList(
  runs: readonly ManagedWorkflowSnapshot[],
  options: { readonly processSnapshots?: ReadonlyMap<string, WorkflowProcessSnapshot> } = {},
): string {
  if (runs.length === 0) return '  (no active workflow runs)';
  if (options.processSnapshots) {
    return runs
      .map((r) => {
        const processMeta = formatProcessListMeta(options.processSnapshots?.get(r.runId));
        return `  ${statusIcon(r.status)} ${chalk.cyan(r.workflow)} ${chalk.dim(r.runId)} - ${r.status} (${r.totalSpawned} agents, ${r.eventCount} events)${
          processMeta ? chalk.dim(` [${processMeta}]`) : ''
        }`;
      })
      .join('\n');
  }
  return runs
    .map(
      (r) =>
        `  ${statusIcon(r.status)} ${chalk.cyan(r.workflow)} ${chalk.dim(r.runId)} - ${r.status} (${r.totalSpawned} agents, ${r.eventCount} events)`,
    )
    .join('\n');
}

export function isActiveManagedWorkflowRun(run: ManagedWorkflowSnapshot): boolean {
  return run.status === 'running' || run.status === 'paused';
}

export interface WorkflowPruneCandidate {
  readonly runId: string;
  readonly workflow: string;
  readonly status: string;
  readonly endedAt: number;
}

export function selectWorkflowPruneCandidates(
  runs: readonly WorkflowRunSummary[],
  options: WorkflowPruneOptions,
  now = Date.now(),
): readonly WorkflowPruneCandidate[] {
  const terminalRuns = runs
    .filter((run) => isTerminalWorkflowStatus(run.status))
    .sort((a, b) => b.endedAt - a.endedAt);
  const keepProtected = options.keep === undefined
    ? new Set<string>()
    : new Set(terminalRuns.slice(0, options.keep).map((run) => run.runId));
  const hasKeepRule = options.keep !== undefined;
  const hasAgeRule = options.olderThanMs !== undefined;
  const cutoff = options.olderThanMs === undefined ? undefined : now - options.olderThanMs;

  if (!hasKeepRule && !hasAgeRule) {
    return [];
  }

  return terminalRuns
    .filter((run) => {
      const keepMatches = hasKeepRule ? !keepProtected.has(run.runId) : true;
      const ageMatches = cutoff === undefined
        ? true
        : run.endedAt > 0 && run.endedAt < cutoff;
      return keepMatches && ageMatches;
    })
    .map((run) => ({
      runId: run.runId,
      workflow: run.workflow,
      status: run.status,
      endedAt: run.endedAt,
    }));
}

export function formatWorkflowPruneCandidates(
  candidates: readonly WorkflowPruneCandidate[],
): string {
  if (candidates.length === 0) return '  (no workflow runs match the cleanup rule)';
  return candidates
    .map((run) =>
      `  ${statusIcon(run.status)} ${chalk.cyan(run.workflow)} ${chalk.dim(run.runId)} - ${run.status}`,
    )
    .join('\n');
}

export function selectDefaultWorkflowRunId(
  managedRuns: readonly ManagedWorkflowSnapshot[],
  persistedRuns: readonly WorkflowRunSummary[],
): string | undefined {
  const active = managedRuns.filter(isActiveManagedWorkflowRun)[0];
  return active?.runId ?? managedRuns[0]?.runId ?? persistedRuns[0]?.runId;
}

export function selectDefaultActiveWorkflowRunId(
  managedRuns: readonly ManagedWorkflowSnapshot[],
): string | undefined {
  return managedRuns.find(isActiveManagedWorkflowRun)?.runId;
}

function formatTime(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? new Date(value).toLocaleString() : value;
}

function formatRecentWorkflowEvents(events: readonly WorkflowEvent[], limit = 10): readonly string[] {
  const rendered = events
    .map(formatWorkflowEvent)
    .filter((line): line is string => line !== undefined);
  return rendered.slice(Math.max(0, rendered.length - limit));
}

export function canRerunWorkflowRun(
  run: ManagedWorkflowSnapshot | undefined,
  detail: WorkflowRunDetail | undefined,
): boolean {
  return detail?.canRerun ?? (run?.runDir ? hasRerunnableGeneratedWorkflowRun(run.runDir) : false);
}

function workflowArtifactRefs(detail: WorkflowRunDetail | undefined): readonly WorkflowArtifactRef[] {
  if (!detail) return [];
  return detail.artifacts.map((name) => ({
    name,
    path: join(detail.runDir, 'artifacts', `${safeWorkflowArtifactName(name)}.json`),
  }));
}

export function formatWorkflowNextActions(runId: string, canRerun: boolean): string {
  return canRerun
    ? `/workflow show ${runId} | /workflow rerun ${runId}`
    : `/workflow show ${runId}`;
}

export function formatWorkflowFailureAction(runId: string, canRerun: boolean): string {
  return canRerun
    ? `Use /workflow show ${runId} for events. /workflow revise ${runId} <change> can repair the saved script; /workflow rerun ${runId} repeats it unchanged.`
    : `Use /workflow show ${runId} for events.`;
}

export interface WorkflowRunSnapshotFormatOptions {
  readonly full?: boolean;
  readonly processSnapshot?: WorkflowProcessSnapshot;
}

export function formatWorkflowRunSnapshot(
  run: ManagedWorkflowSnapshot | undefined,
  detail?: WorkflowRunDetail,
  options: WorkflowRunSnapshotFormatOptions = {},
): string {
  const processSnapshot = options.processSnapshot;
  if (!run && !detail && !processSnapshot) return '  (unknown workflow run)';
  const workflow = processSnapshot?.workflowName ?? run?.workflow ?? detail?.workflow ?? '?';
  const runId = processSnapshot?.runId ?? run?.runId ?? detail?.runId ?? '?';
  const status = processSnapshot?.status ?? run?.status ?? detail?.status ?? '?';
  const totalSpawned = processSnapshot?.progress.spawnedAgents ?? run?.totalSpawned ?? detail?.totalSpawned ?? 0;
  const eventCount = run?.eventCount ?? detail?.eventCount ?? 0;
  const runDir = run?.runDir ?? detail?.runDir ?? '';
  const startedAt = formatTime(run?.startedAt ?? detail?.startedAt ?? processSnapshot?.startedAt);
  const processEndedAt = processSnapshot && processSnapshot.status !== 'running' && processSnapshot.status !== 'paused'
    ? processSnapshot.updatedAt
    : undefined;
  const endedAt = formatTime(run?.endedAt ?? detail?.endedAt ?? processEndedAt);
  const error = processSnapshot?.error ?? run?.error ?? detail?.error;
  const artifacts = detail?.artifacts ?? processSnapshot?.artifacts?.map((artifact) => artifact.name) ?? [];
  const artifactRefs = workflowArtifactRefs(detail);
  const managedResultText = run?.resultText;
  const artifactResult = options.full === true || managedResultText === undefined
    ? formatArtifactResult(artifactRefs, detectWorkflowLocale(workflow), { full: options.full === true })
    : undefined;
  const rawResultText = options.full === true
    ? artifactResult ?? managedResultText ?? processSnapshot?.resultSummary
    : managedResultText !== undefined
      ? formatResult(managedResultText)
      : processSnapshot?.resultSummary !== undefined
        ? formatResult(processSnapshot.resultSummary)
        : artifactResult;
  const resultText = rawResultText
    ? replaceWorkflowResultTruncationMarker(rawResultText, runId, detectWorkflowLocale(rawResultText))
    : undefined;
  const resultLabel = options.full === true || !rawResultText || !isWorkflowResultPreviewTruncated(rawResultText)
    ? 'result:'
    : 'result preview:';
  const recentEvents = detail ? formatRecentWorkflowEvents(detail.events) : [];
  const canRerun = canRerunWorkflowRun(run, detail);
  return [
    `  ${chalk.cyan(workflow)} ${chalk.dim(runId)}`,
    ...(processSnapshot?.displayName && processSnapshot.displayName !== workflow
      ? [`  display name: ${processSnapshot.displayName}`]
      : []),
    `  status: ${status}`,
    ...(processSnapshot?.source ? [`  source: ${processSnapshot.source}`] : []),
    ...(processSnapshot?.savedWorkflowName ? [`  saved workflow: ${processSnapshot.savedWorkflowName}`] : []),
    ...(processSnapshot?.sourceRunId ? [`  source run: ${processSnapshot.sourceRunId}`] : []),
    ...(processSnapshot?.sourceWorkflowName ? [`  source workflow: ${processSnapshot.sourceWorkflowName}`] : []),
    ...(processSnapshot?.revisionOf ? [`  revision of: ${processSnapshot.revisionOf}`] : []),
    `  agents: ${totalSpawned}`,
    `  events: ${eventCount}`,
    ...(startedAt ? [`  started: ${startedAt}`] : []),
    ...(endedAt ? [`  ended: ${endedAt}`] : []),
    ...(runDir ? [`  run dir: ${runDir}`] : []),
    ...(artifacts.length > 0 ? [`  artifacts: ${artifacts.join(', ')}`] : []),
    ...(error ? [`  error: ${error}`] : []),
    ...(resultText ? ['', `  ${resultLabel}`, ...resultText.split('\n').map((line) => `    ${line}`)] : []),
    ...(recentEvents.length > 0
      ? ['', '  recent events:', ...recentEvents.map((event) => `  ${event.trimEnd()}`)]
      : []),
    '',
    `  next: ${formatWorkflowNextActions(runId, canRerun)}`,
  ].join('\n');
}

/**
 * FEATURE_298 T22 — agent count from a Host process snapshot. Matches the
 * managed world's totalSpawned semantics: progress.spawnedAgents first (item
 * counts are skewed by phases/artifacts), counts-sum fallback for
 * daemon-stripped snapshots.
 */
export function totalSpawnedFromProcess(snapshot: WorkflowProcessSnapshot): number {
  return snapshot.progress?.spawnedAgents
    ?? (snapshot.counts === undefined
      ? 0
      : snapshot.counts.pending + snapshot.counts.running + snapshot.counts.completed
        + snapshot.counts.failed + snapshot.counts.cancelled + snapshot.counts.skipped);
}

/** Project + personal saved-workflow directories for the current cwd. */
export function savedWorkflowDirs(cwd: string): SavedWorkflowDirs {
  return {
    project: join(cwd, '.kodax', 'workflows'),
    personal: getAgentConfigPath('workflows'),
  };
}

export async function nextRevisionWorkflowName(
  dirs: SavedWorkflowDirs,
  preferredName: string,
): Promise<string> {
  const existing = new Set((await discoverSavedWorkflows(dirs)).map((ref) => ref.name));
  if (!existing.has(preferredName)) return preferredName;
  return `${preferredName}-revision-${Date.now().toString(36)}`;
}

export function buildWorkflowRevisionProvenance(input: {
  readonly capsule: WorkflowCapsule;
  readonly resolution: Awaited<ReturnType<typeof resolveWorkflowIdentity>>;
  readonly replacesWorkflowName?: string;
}): WorkflowCapsuleProvenance {
  const fromRunId = input.resolution.kind === 'run'
    ? input.resolution.runId
    : input.capsule.provenance?.fromRunId;
  const fromWorkflowName = input.resolution.kind === 'saved'
    ? input.resolution.savedWorkflow.name
    : input.capsule.provenance?.fromWorkflowName;
  const revisionOf = input.resolution.kind === 'run'
    ? input.resolution.runId
    : input.resolution.kind === 'saved'
      ? input.resolution.savedWorkflow.name
      : undefined;

  return {
    ...(fromRunId !== undefined ? { fromRunId } : {}),
    ...(fromWorkflowName !== undefined ? { fromWorkflowName } : {}),
    ...(revisionOf !== undefined ? { revisionOf } : {}),
    ...(input.replacesWorkflowName !== undefined ? { replacesWorkflowName: input.replacesWorkflowName } : {}),
    createdAt: new Date().toISOString(),
    kodaxVersion: KODAX_VERSION,
  };
}

export function formatSavedList(refs: readonly SavedWorkflowRef[]): string {
  if (refs.length === 0) return '  (no saved workflows)';
  return refs
    .map((r) => `  ${chalk.cyan(r.name)} ${chalk.dim(`(${r.source}, ${r.execution}: ${r.path})`)}`)
    .join('\n');
}

export function isSafeWorkflowRunId(runId: string): boolean {
  return (
    /^[a-zA-Z0-9._-]{1,120}$/.test(runId) &&
    !runId.startsWith('.') &&
    !runId.includes('..')
  );
}

export type ConfirmFn = (message: string) => Promise<boolean>;

/**
 * Resolve an interactive confirmation function. Prefers `callbacks.confirm`;
 * falls back to a readline `(y/N)` prompt (the REPL always passes
 * `callbacks.readline`). Returns undefined only in a non-interactive
 * context — callers MUST fail safe (never execute local code) when so.
 */
export function resolveConfirm(callbacks: {
  readonly confirm?: ConfirmFn;
  readonly readline?: { question: (query: string, cb: (answer: string) => void) => void };
}): ConfirmFn | undefined {
  if (callbacks.confirm) return callbacks.confirm;
  const rl = callbacks.readline;
  if (rl) {
    return (message: string) =>
      new Promise<boolean>((resolve) => {
        rl.question(`${message} (y/N) `, (answer) => resolve(/^y(es)?$/i.test(answer.trim())));
      });
  }
  return undefined;
}

function printInvalidRunId(runId: string): void {
  console.log(chalk.red(`\n[workflow] invalid run id: ${runId || '<empty>'}\n`));
}

export function ensureSafeRunId(runId: string): boolean {
  if (isSafeWorkflowRunId(runId)) return true;
  printInvalidRunId(runId);
  return false;
}

export function writeWorkflowRunDisplayName(
  baseDir: string,
  runId: string,
  displayName: string,
): boolean {
  const trimmed = displayName.trim();
  if (!trimmed || !isSafeWorkflowRunId(runId)) return false;
  const detail = readWorkflowRunDetail(baseDir, runId);
  if (!detail) return false;
  writeFileSync(
    join(baseDir, runId, 'workflow-metadata.json'),
    `${JSON.stringify({ displayName: trimmed }, null, 2)}\n`,
    'utf8',
  );
  return true;
}

export function currentWorkflowPreflightEnv(): {
  readonly isGitRepo: boolean;
  readonly worktreeCapable: boolean;
} {
  const gitMarker = hasGitMarker(process.cwd());
  return {
    isGitRepo: gitMarker,
    worktreeCapable: gitMarker,
  };
}

function hasGitMarker(startDir: string): boolean {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function printPreflightFailure(result: ReturnType<typeof preflightWorkflowCapsule>): void {
  console.log(chalk.red('\n[workflow] capsule preflight failed:'));
  for (const issue of result.issues) {
    console.log(chalk.red(`  - ${issue.requirement}: ${issue.message}`));
  }
  console.log();
}

export function printPreflightWarnings(result: ReturnType<typeof preflightWorkflowCapsule>): void {
  const warnings = result.issues.filter((issue) => issue.severity === 'warning');
  if (warnings.length === 0) return;
  console.log(chalk.yellow('\n[workflow] capsule preflight warnings:'));
  for (const issue of warnings) {
    console.log(chalk.yellow(`  - ${issue.requirement}: ${issue.message}`));
  }
  console.log();
}

type WorkflowScriptSnapshot = {
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
};

interface PreparedSavedWorkflow {
  readonly module: WorkflowModule;
  readonly approvalContext: WorkflowApprovalRenderContext;
  readonly scriptSnapshot?: WorkflowScriptSnapshot;
  readonly provenance?: WorkflowCapsuleProvenance;
}

export async function prepareSavedWorkflow(
  ref: SavedWorkflowRef,
  confirm: ConfirmFn,
): Promise<PreparedSavedWorkflow | undefined> {
  if (ref.execution === 'trusted-local') {
    const trusted = await confirm(
      `Run local workflow file? This EXECUTES local code:\n  ${ref.path}`,
    );
    if (!trusted) {
      console.log(chalk.dim('Workflow cancelled.\n'));
      return undefined;
    }
  }

  try {
    let approvalContext: WorkflowApprovalRenderContext = {
      source: `saved:${ref.source}`,
      sandbox: ref.execution,
      mayUseWorktree: false,
    };
    let scriptSnapshot: WorkflowScriptSnapshot | undefined;
    let provenance: WorkflowCapsuleProvenance | undefined;

    if (ref.execution === 'capability-generated') {
      const capsule = await loadSavedWorkflowCapsule(ref.path);
      const preflight = preflightWorkflowCapsule(capsule, currentWorkflowPreflightEnv());
      if (!preflight.ok) {
        printPreflightFailure(preflight);
        return undefined;
      }
      printPreflightWarnings(preflight);
      approvalContext = {
        source: `saved:${ref.source}`,
        sandbox: ref.execution,
        mayUseWorktree: capsule.manifest.mayUseWorktree === true,
        rawScriptPath: ref.path,
        rawScript: capsule.source,
      };
      scriptSnapshot = {
        manifest: capsule.manifest,
        source: capsule.source,
      };
      provenance = capsule.provenance;
    }

    const module = await loadSavedWorkflow(ref.path);
    return {
      module,
      approvalContext,
      ...(scriptSnapshot !== undefined ? { scriptSnapshot } : {}),
      ...(provenance !== undefined ? { provenance } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`\n[workflow] failed to load ${ref.path}: ${message}\n`));
    return undefined;
  }
}

/* ------------------------------- command -------------------------------- */

export function workflowEventStatus(event: WorkflowEvent): string | undefined {
  const status = event.data?.status;
  return typeof status === 'string' ? status : undefined;
}

export function formatWorkflowEvent(event: WorkflowEvent): string | undefined {
  const label = event.data?.name ?? event.data?.taskId ?? '';
  const status = workflowEventStatus(event);
  switch (event.type) {
    case 'phase_started':
      return `  > phase: ${event.data?.name ?? ''}`;
    case 'phase_finished':
      return `    done phase: ${event.data?.name ?? ''}`;
    case 'agent_spawned':
      return `    + ${label}`;
    case 'agent_completed':
      return status === 'failed'
        ? `    failed ${label}`
        : status === 'completed_unverified'
          ? `    unverified ${label}`
        : `    done ${label}`;
    case 'agent_unverified':
      return `    unverified ${label}`;
    case 'agent_failed':
      return `    failed ${label}`;
    case 'agent_stopped':
      return `    stopped ${label}`;
    case 'workflow_log':
      return `    log ${event.data?.message ?? ''}`;
    case 'artifact_written':
      return `    artifact ${event.data?.name ?? ''}`;
    case 'synthesis_completed':
      return '  synthesis complete';
    case 'workflow_completed':
      return '  workflow completed';
    case 'workflow_stopped':
      return '  workflow stopped';
    case 'workflow_failed':
      return `  workflow failed: ${event.data?.error ?? 'unknown error'}`;
    default:
      return undefined;
  }
}

export function renderWorkflowEvent(event: WorkflowEvent): void {
  const text = formatWorkflowEvent(event);
  if (text) console.log(chalk.dim(text));
}
