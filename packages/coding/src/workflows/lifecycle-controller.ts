import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type {
  WorkflowCapsule,
  WorkflowEvent,
  WorkflowProcessEvent,
  WorkflowProcessSnapshot,
} from '@kodax-ai/agent';
import {
  createWorkflowProcessTracker,
  isFinalWorkflowProcessStatus,
  normalizeHostMetadata,
} from '@kodax-ai/agent';
import type {
  DeleteSavedWorkflowInput,
  SavedWorkflowDirs,
  SavedWorkflowRef,
  ReplaceSavedWorkflowInput,
  ReplaceSavedWorkflowResult,
  WorkflowCapsulePreflightEnvironment,
  WorkflowCapsulePreflightResult,
} from './discovery.js';
import {
  deleteSavedWorkflow as deleteSavedWorkflowCapsule,
  preflightWorkflowCapsule as runWorkflowCapsulePreflight,
  replaceSavedWorkflow as replaceSavedWorkflowCapsule,
  renameSavedWorkflow as renameSavedWorkflowCapsule,
} from './discovery.js';
import {
  resolveWorkflowIdentity as resolveWorkflowIdentityTarget,
  type WorkflowIdentityResolution,
} from './identity.js';

import { safeWorkflowArtifactName } from './run-graph.js';
import type { WorkflowRunProcessMetadata } from './run-graph.js';
import type { WorkflowRunManager } from './run-manager.js';

export interface WorkflowRunListOptions {
  readonly activeOnly?: boolean;
  readonly limit?: number;
}

export interface WorkflowRunRetentionOptions {
  readonly keep?: number;
  readonly olderThanDays?: number;
  readonly dryRun?: boolean;
}

export interface WorkflowRunRetentionResult {
  readonly deleted: number;
  readonly protectedRuns: number;
  readonly candidates: readonly string[];
  readonly dryRun: boolean;
}

export interface DeleteWorkflowRunOptions {
  readonly force?: boolean;
}

export interface WorkflowCapsulePreflightInput {
  readonly capsule: WorkflowCapsule;
  readonly env?: WorkflowCapsulePreflightEnvironment;
}

export interface WorkflowLifecycleController {
  subscribeWorkflowProcess(listener: (event: WorkflowProcessEvent) => void): () => void;
  getWorkflowProcessSnapshot(runId: string): WorkflowProcessSnapshot | undefined;
  listWorkflowProcessSnapshots(options?: WorkflowRunListOptions): readonly WorkflowProcessSnapshot[];
  resolveWorkflowIdentity(target: string): Promise<WorkflowIdentityResolution>;
  preflightWorkflowCapsule(input: WorkflowCapsulePreflightInput): Promise<WorkflowCapsulePreflightResult>;
  stopWorkflow(runId: string, reason?: string): Promise<boolean>;
  pauseWorkflow(runId: string): Promise<boolean>;
  resumeWorkflow(runId: string): Promise<boolean>;
  renameWorkflowRun(runId: string, displayName: string): Promise<boolean>;
  renameSavedWorkflow(name: string, newName: string): Promise<SavedWorkflowRef | undefined>;
  deleteSavedWorkflow(
    name: string,
    source?: DeleteSavedWorkflowInput['source'],
  ): Promise<SavedWorkflowRef | undefined>;
  replaceSavedWorkflow(
    input: Omit<ReplaceSavedWorkflowInput, 'dirs'>,
  ): Promise<ReplaceSavedWorkflowResult | undefined>;
  readWorkflowResult(runId: string): Promise<string | undefined>;
  readWorkflowArtifact(runId: string, name: string): Promise<unknown | undefined>;
  deleteWorkflowRun(runId: string, options?: DeleteWorkflowRunOptions): Promise<boolean>;
  pruneWorkflowRuns(options: WorkflowRunRetentionOptions): Promise<WorkflowRunRetentionResult>;
}

export interface CreateWorkflowLifecycleControllerOptions {
  readonly runManager: WorkflowRunManager;
  readonly runBaseDir: string;
  readonly savedWorkflowDirs?: SavedWorkflowDirs;
  readonly now?: () => number;
}

interface PersistedWorkflowRun {
  readonly runId: string;
  readonly workflow: string;
  readonly displayName?: string;
  readonly resultSummary?: string;
  readonly processMetadata?: WorkflowRunProcessMetadata;
  readonly status: string;
  readonly endedAt: number;
  readonly artifacts: readonly string[];
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'stopped', 'denied', 'cancelled']);

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function readRecord(path: string): Record<string, unknown> | undefined {
  const parsed = readJsonFile(path);
  return typeof parsed === 'object' && parsed !== null
    ? parsed as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readWorkflowProcessSource(value: unknown): WorkflowRunProcessMetadata['source'] | undefined {
  // v0.7.72 migration: historical AMAW-authored records remain readable but
  // are normalized to the explicit command provenance used by the owner.
  if (value === 'amaw') return 'command';
  if (
    value === 'command'
    || value === 'review'
    || value === 'sdk'
    || value === 'capsule'
    || value === 'extension'
    || value === 'automation'
  ) {
    return value;
  }
  return undefined;
}

function readRunProcessMetadata(
  data: Record<string, unknown>,
  displayName: string | undefined,
): WorkflowRunProcessMetadata | undefined {
  const goal = readString(data.goal);
  const source = readWorkflowProcessSource(data.source);
  const savedWorkflowName = readString(data.savedWorkflowName);
  const sourceRunId = readString(data.sourceRunId);
  const sourceWorkflowName = readString(data.sourceWorkflowName);
  const revisionOf = readString(data.revisionOf);
  const resumedFromRunId = readString(data.resumedFromRunId);
  const hostMetadata = normalizeHostMetadata(data.hostMetadata);
  const metadata: WorkflowRunProcessMetadata = {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(savedWorkflowName !== undefined ? { savedWorkflowName } : {}),
    ...(sourceRunId !== undefined ? { sourceRunId } : {}),
    ...(sourceWorkflowName !== undefined ? { sourceWorkflowName } : {}),
    ...(revisionOf !== undefined ? { revisionOf } : {}),
    // FEATURE_246 — restore resume lineage so a reconstructed snapshot reports
    // resumedFromRunId AND replays per-agent origin (the tracker treats a run with
    // resumedFromRunId set as a resume, so agent_replayed/agent_spawned events from
    // events.jsonl get their origin).
    ...(resumedFromRunId !== undefined ? { resumedFromRunId } : {}),
    ...(hostMetadata !== undefined ? { hostMetadata } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function isSafeWorkflowRunId(runId: string): boolean {
  return runId !== '.' && /^[a-zA-Z0-9._-]+$/.test(runId) && !runId.includes('..');
}

function runDir(baseDir: string, runId: string): string | undefined {
  if (!isSafeWorkflowRunId(runId)) return undefined;
  const base = resolve(baseDir);
  const target = resolve(base, runId);
  return target.startsWith(`${base}${sep}`) ? target : undefined;
}

function isManagedWorkflowActive(status: string): boolean {
  return status === 'running' || status === 'paused';
}

function isPathWithinBase(baseDir: string, path: string): boolean {
  const base = resolve(baseDir);
  const target = resolve(path);
  return target === base || target.startsWith(`${base}${sep}`);
}

function readPersistedRun(baseDir: string, runId: string): PersistedWorkflowRun | undefined {
  const dir = runDir(baseDir, runId);
  if (!dir) return undefined;
  const data = readRecord(join(dir, 'run.json'));
  if (!data) return undefined;
  const displayName = readRunDisplayName(dir) ?? readString(data.displayName);
  const resultSummary = readString(data.resultSummary);
  const processMetadata = readRunProcessMetadata(data, displayName);
  return {
    runId,
    workflow: readString(data.workflow) ?? '?',
    ...(displayName !== undefined ? { displayName } : {}),
    ...(resultSummary !== undefined ? { resultSummary } : {}),
    ...(processMetadata !== undefined ? { processMetadata } : {}),
    status: readString(data.status) ?? '?',
    endedAt: readNumber(data.endedAt) ?? 0,
    artifacts: readStringArray(data.artifacts),
  };
}

function readRunDisplayName(dir: string): string | undefined {
  const data = readRecord(join(dir, 'workflow-metadata.json'));
  return data ? readString(data.displayName) : undefined;
}

function listPersistedRuns(baseDir: string): readonly PersistedWorkflowRun[] {
  if (!existsSync(baseDir)) return [];
  const runs: PersistedWorkflowRun[] = [];
  for (const entry of readdirSync(baseDir)) {
    const run = readPersistedRun(baseDir, entry);
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => b.endedAt - a.endedAt);
}

function readWorkflowEvents(runPath: string): readonly WorkflowEvent[] {
  const eventsPath = join(runPath, 'events.jsonl');
  if (!existsSync(eventsPath)) return [];
  const events: WorkflowEvent[] = [];
  for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
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
  }
  return events;
}

function snapshotFromPersistedRun(
  baseDir: string,
  run: PersistedWorkflowRun,
): WorkflowProcessSnapshot | undefined {
  const dir = runDir(baseDir, run.runId);
  if (!dir) return undefined;
  const tracker = createWorkflowProcessTracker({
    runId: run.runId,
    workflowName: run.workflow,
    displayName: run.displayName ?? run.processMetadata?.displayName ?? run.workflow,
    ...(run.processMetadata?.goal !== undefined ? { goal: run.processMetadata.goal } : {}),
    ...(run.processMetadata?.source !== undefined ? { source: run.processMetadata.source } : {}),
    ...(run.processMetadata?.savedWorkflowName !== undefined
      ? { savedWorkflowName: run.processMetadata.savedWorkflowName }
      : {}),
    ...(run.processMetadata?.sourceRunId !== undefined
      ? { sourceRunId: run.processMetadata.sourceRunId }
      : {}),
    ...(run.processMetadata?.sourceWorkflowName !== undefined
      ? { sourceWorkflowName: run.processMetadata.sourceWorkflowName }
      : {}),
    ...(run.processMetadata?.revisionOf !== undefined
      ? { revisionOf: run.processMetadata.revisionOf }
      : {}),
    // FEATURE_246 — carry resume lineage into the reconstructed tracker so a
    // restored snapshot reports resumedFromRunId AND stamps per-agent origin
    // (the tracker treats resumedFromRunId-present as a resume run).
    ...(run.processMetadata?.resumedFromRunId !== undefined
      ? { resumedFromRunId: run.processMetadata.resumedFromRunId }
      : {}),
    ...(run.processMetadata?.hostMetadata !== undefined
      ? { hostMetadata: { ...run.processMetadata.hostMetadata } }
      : {}),
    ...(run.resultSummary !== undefined ? { resultSummary: run.resultSummary } : {}),
    artifacts: run.artifacts.map((name) => ({
      name,
      path: join(dir, 'artifacts', `${safeWorkflowArtifactName(name)}.json`),
    })),
  });
  for (const event of readWorkflowEvents(dir)) tracker.applyEvent(event);
  const snapshot = tracker.getSnapshot();
  if (snapshot.status !== 'running' || !TERMINAL_RUN_STATUSES.has(run.status)) {
    return snapshot;
  }
  if (run.status === 'completed') {
    tracker.setStatus('completed');
  } else if (run.status === 'failed') {
    tracker.setStatus('failed');
  } else {
    tracker.setStatus('cancelled');
  }
  return tracker.getSnapshot();
}

function readEventSummary(events: readonly WorkflowEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type === 'workflow_completed') {
      const summary = readString(event.data?.resultSummary);
      if (summary) return summary;
    }
    if (
      event.type !== 'agent_completed' &&
      event.type !== 'agent_unverified' &&
      event.type !== 'agent_failed'
    ) continue;
    const summary = readString(event.data?.summary);
    if (summary) return summary;
    const error = readString(event.data?.error);
    if (error) return error;
  }
  return undefined;
}

function pruneCandidates(
  runs: readonly PersistedWorkflowRun[],
  options: WorkflowRunRetentionOptions,
  now: number,
): readonly PersistedWorkflowRun[] {
  const terminalRuns = runs
    .filter((run) => TERMINAL_RUN_STATUSES.has(run.status))
    .sort((a, b) => b.endedAt - a.endedAt);
  const keep = options.keep;
  const cutoff = options.olderThanDays === undefined
    ? undefined
    : now - options.olderThanDays * 24 * 60 * 60 * 1000;
  const keepProtected = keep === undefined
    ? new Set<string>()
    : new Set(terminalRuns.slice(0, Math.max(0, keep)).map((run) => run.runId));

  if (keep === undefined && cutoff === undefined) return [];

  return terminalRuns.filter((run) => {
    if (keepProtected.has(run.runId)) return false;
    if (cutoff === undefined) return true;
    return run.endedAt > 0 && run.endedAt < cutoff;
  });
}

export function createWorkflowLifecycleController(
  options: CreateWorkflowLifecycleControllerOptions,
): WorkflowLifecycleController {
  const now = options.now ?? (() => Date.now());
  const { runManager, runBaseDir } = options;

  return {
    subscribeWorkflowProcess: (listener) => runManager.subscribeWorkflowProcess(listener),

    getWorkflowProcessSnapshot: (runId) => {
      const live = runManager.getWorkflowProcessSnapshot(runId);
      if (live) return live;
      const persisted = readPersistedRun(runBaseDir, runId);
      return persisted ? snapshotFromPersistedRun(runBaseDir, persisted) : undefined;
    },

    listWorkflowProcessSnapshots: (listOptions) => {
      const active = runManager.listWorkflowProcessSnapshots(listOptions);
      if (listOptions?.activeOnly === true) return active;
      const activeIds = new Set(active.map((snapshot) => snapshot.runId));
      const persisted = listPersistedRuns(runBaseDir)
        .filter((run) => !activeIds.has(run.runId))
        .map((run) => snapshotFromPersistedRun(runBaseDir, run))
        .filter((snapshot): snapshot is WorkflowProcessSnapshot => snapshot !== undefined);
      const combined = [...active, ...persisted];
      return listOptions?.limit === undefined ? combined : combined.slice(0, listOptions.limit);
    },

    resolveWorkflowIdentity: async (target) =>
      resolveWorkflowIdentityTarget({
        target,
        runBaseDir,
        savedWorkflowDirs: options.savedWorkflowDirs,
      }),

    preflightWorkflowCapsule: async (input) =>
      runWorkflowCapsulePreflight(input.capsule, input.env),

    stopWorkflow: async (runId, reason) => runManager.stop(runId, reason),

    pauseWorkflow: async (runId) => runManager.pause(runId),

    resumeWorkflow: async (runId) => runManager.resume(runId),

    renameWorkflowRun: async (runId, displayName) => {
      const trimmed = displayName.trim();
      if (trimmed.length === 0) return false;
      const dir = runDir(runBaseDir, runId);
      if (!dir || !readPersistedRun(runBaseDir, runId)) return false;
      writeFileSync(
        join(dir, 'workflow-metadata.json'),
        `${JSON.stringify({ displayName: trimmed }, null, 2)}\n`,
        'utf8',
      );
      return true;
    },

    renameSavedWorkflow: async (name, newName) => {
      if (!options.savedWorkflowDirs) return undefined;
      return renameSavedWorkflowCapsule({
        dirs: options.savedWorkflowDirs,
        name,
        newName,
      });
    },

    deleteSavedWorkflow: async (name, source) => {
      if (!options.savedWorkflowDirs) return undefined;
      return deleteSavedWorkflowCapsule({
        dirs: options.savedWorkflowDirs,
        name,
        ...(source !== undefined ? { source } : {}),
      });
    },

    replaceSavedWorkflow: async (input) => {
      if (!options.savedWorkflowDirs) return undefined;
      return replaceSavedWorkflowCapsule({
        ...input,
        dirs: options.savedWorkflowDirs,
      });
    },

    readWorkflowResult: async (runId) => {
      const directory = runDir(runBaseDir, runId);
      if (directory && readRecord(join(directory, 'run.json'))?.resultPath === 'result.json') {
        // A declared original must not silently degrade to its lossy summary.
        const original = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')) as unknown;
        if (typeof original !== 'object' || original === null || !('version' in original)
          || original.version !== 1) throw new Error('Workflow final result is invalid.');
        if (!('value' in original)) {
          if ('kind' in original && original.kind === 'undefined') return 'undefined';
          throw new Error('Workflow final result is invalid.');
        }
        return typeof original.value === 'string' ? original.value : JSON.stringify(original.value, null, 2);
      }
      const live = runManager.getWorkflowProcessSnapshot(runId)?.resultSummary;
      if (live) return live;
      const dir = runDir(runBaseDir, runId);
      if (!dir) return undefined;
      const persisted = readPersistedRun(runBaseDir, runId);
      if (!persisted) return undefined;
      if (persisted.resultSummary) return persisted.resultSummary;
      return readEventSummary(readWorkflowEvents(dir));
    },

    readWorkflowArtifact: async (runId, name) => {
      const dir = runDir(runBaseDir, runId);
      if (!dir) return undefined;
      return readJsonFile(join(dir, 'artifacts', `${safeWorkflowArtifactName(name)}.json`));
    },

    deleteWorkflowRun: async (runId, deleteOptions) => {
      const active = runManager
        .listWorkflowProcessSnapshots({ activeOnly: true })
        .some((snapshot) => snapshot.runId === runId);
      if (active) return false;
      const persisted = readPersistedRun(runBaseDir, runId);
      if (!persisted) return false;
      if (!TERMINAL_RUN_STATUSES.has(persisted.status) && deleteOptions?.force !== true) {
        return false;
      }
      const dir = runDir(runBaseDir, runId);
      if (!dir) return false;
      rmSync(dir, { recursive: true, force: true });
      return true;
    },

    pruneWorkflowRuns: async (pruneOptions) => {
      const activeProcessIds = new Set(
        runManager.listWorkflowProcessSnapshots({ activeOnly: true }).map((snapshot) => snapshot.runId),
      );
      const activeManagedIds = new Set(
        runManager.list()
          .filter((run) => isManagedWorkflowActive(run.status))
          .filter((run) => isPathWithinBase(runBaseDir, run.runDir))
          .map((run) => run.runId),
      );
      const activeIds = new Set([...activeProcessIds, ...activeManagedIds]);
      const runs = listPersistedRuns(runBaseDir);
      const protectedRunIds = new Set([
        ...activeManagedIds,
        ...runs.filter((run) => activeProcessIds.has(run.runId)).map((run) => run.runId),
      ]);
      const protectedRuns = protectedRunIds.size;
      const candidates = pruneCandidates(runs, pruneOptions, now())
        .filter((run) => !activeIds.has(run.runId));
      if (pruneOptions.dryRun === true) {
        return {
          deleted: 0,
          protectedRuns,
          candidates: candidates.map((run) => run.runId),
          dryRun: true,
        };
      }
      let deleted = 0;
      for (const run of candidates) {
        const dir = runDir(runBaseDir, run.runId);
        if (!dir) continue;
        rmSync(dir, { recursive: true, force: true });
        deleted += 1;
      }
      return {
        deleted,
        protectedRuns,
        candidates: candidates.map((run) => run.runId),
        dryRun: false,
      };
    },
  };
}
