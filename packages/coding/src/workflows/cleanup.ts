import { existsSync, readFileSync, readdirSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { safeWorkflowArtifactName } from './run-graph.js';
import { writeWorkflowJson } from './persistence.js';
import { sweepWorkflowRunWorktrees, workflowWorktreeBaseDir, type WorktreeSweepDeps, type WorktreeSweepResult } from './worktree-sweep.js';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Workflow evidence.');
  return value as Record<string, unknown>;
}

function normalize(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function strings(value: unknown): string[] {
  // The executor's scope label is provenance, not a retained file reference.
  if (typeof value === 'string') return [normalize(value.replace(/^\[Workflow worktree: [^\]\r\n]+\]\r?\n/gm, ''))];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

/** Trusted Host seam, after its Actor/executor/shell fences and Session final
 * references have committed. A terminal Workflow snapshot alone is not proof.
 * Unknown ownership/evidence is retained; this never replays execution. */
interface WorkflowCleanupInput {
  readonly runId: string;
  readonly runDir: string;
  readonly ownerSessionId: string;
  readonly ownerRunId: string;
  readonly gitRoot: string;
  readonly resourcesStopped: true;
  readonly configHome?: string;
}

function pendingPath(input: WorkflowCleanupInput): string | undefined {
  if (!input.configHome) return undefined;
  const within = relative(realpathSync(join(input.configHome, 'workflow-runs')), realpathSync(input.runDir));
  if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Workflow cleanup path is outside its Host.');
  return join(input.configHome, 'runtime', 'workflow-cleanups', `${createHash('sha256').update(input.runId).digest('hex')}.json`);
}

export async function completeWorkflowRunCleanup(input: WorkflowCleanupInput, deps: WorktreeSweepDeps = {}): Promise<WorktreeSweepResult> {
  const warnings: string[] = [];
  let removed: readonly string[] = [];
  let pending: string | undefined;
  let eligible = false;
  try {
    const read = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const manifest = record(read(join(input.runDir, 'run.json')));
    const owner = record(manifest.hostMetadata);
    if (input.resourcesStopped !== true || manifest.runId !== input.runId
      || !input.ownerSessionId || !input.ownerRunId
      || owner.ownerSessionId !== input.ownerSessionId || owner.ownerRunId !== input.ownerRunId
      || !['completed', 'failed', 'stopped', 'denied', 'cancelled'].includes(String(manifest.status))) {
      throw new Error('Workflow owner settlement is not confirmed.');
    }
    pending = pendingPath(input);
    // Most workflows never allocate a worktree. Keep their completion path off
    // Git and avoid rereading potentially large result/artifact bodies.
    if (!existsSync(workflowWorktreeBaseDir(input.runDir))) {
      if (pending) rmSync(pending, { force: true });
      return { removed, warnings };
    }
    // Register proven owner/resource settlement before scanning evidence or
    // yielding. The Host invokes this before publishing the outer terminal.
    if (pending) {
      mkdirSync(dirname(pending), { recursive: true });
      writeWorkflowJson(pending, { version: 1, ...input });
    }
    eligible = true;
    const references = strings(manifest);
    if (manifest.status === 'completed' && manifest.resultPath !== 'result.json') {
      throw new Error('Complete Workflow result has not been persisted.');
    }
    if (manifest.resultPath === 'result.json') {
      const result = record(read(join(input.runDir, 'result.json')));
      if (result.version !== 1 || (!('value' in result) && result.kind !== 'undefined')) throw new Error('Complete Workflow result is invalid.');
      references.push(...strings(result));
    }
    const events = readFileSync(join(input.runDir, 'events.jsonl'), 'utf8');
    for (const line of events.split(/\r?\n/).filter(Boolean)) references.push(...strings(JSON.parse(line) as unknown));
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.some(name => typeof name !== 'string')) {
      throw new Error('Workflow artifact references are invalid.');
    }
    for (const name of manifest.artifacts as string[]) {
      references.push(...strings(read(join(input.runDir, 'artifacts', `${safeWorkflowArtifactName(name)}.json`))));
    }
    const resultsDir = join(input.runDir, 'results');
    if (existsSync(resultsDir)) for (const file of readdirSync(resultsDir)) {
      if (file.endsWith('.json')) references.push(...strings(read(join(resultsDir, file))));
    }
    const result = await sweepWorkflowRunWorktrees({
      baseDir: workflowWorktreeBaseDir(input.runDir), gitRoot: input.gitRoot,
      isReferenced: path => {
        const absolute = normalize(path);
        const local = normalize(relative(input.runDir, path));
        return references.some(text => text.includes(absolute) || text.includes(local));
      },
    }, deps);
    removed = result.removed;
    warnings.push(...result.warnings);
  } catch (error: unknown) {
    warnings.push(`Workflow cleanup retained resources: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Cleanup is maintenance: preserve business outcome and expose retry evidence.
  // A failed/unknown owner check must not write into another owner's run.
  if (eligible) {
    const target = join(input.runDir, 'cleanup.json');
    try {
      const completed = warnings.every(warning => /: (?:referenced by durable Workflow evidence|worktree has unmerged changes|generation recovery checkpoint owns this worktree|branch revision changed|branch is protected by a current worktree)$/.test(warning));
      writeWorkflowJson(target, { version: 1, runId: input.runId,
        ownerSessionId: input.ownerSessionId, ownerRunId: input.ownerRunId,
        removed, warnings, completed });
      if (completed && pending) rmSync(pending, { force: true });
    } catch (error: unknown) {
      warnings.push(`Workflow cleanup receipt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { removed, warnings };
}

/** Reconcile only previously proven cleanup eligibility, never historical runs
 * or unknown effects. The normally empty queue keeps Host startup bounded. */
export async function recoverWorkflowRunCleanups(configHome: string, deps: WorktreeSweepDeps = {}): Promise<WorktreeSweepResult> {
  const pending = join(configHome, 'runtime', 'workflow-cleanups');
  const removed: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(pending)) return { removed, warnings };
  for (const file of readdirSync(pending)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    try {
      const value = record(JSON.parse(readFileSync(join(pending, file), 'utf8')) as unknown);
      if (value.version !== 1 || value.resourcesStopped !== true
        || typeof value.runId !== 'string' || typeof value.runDir !== 'string'
        || typeof value.ownerSessionId !== 'string' || typeof value.ownerRunId !== 'string'
        || typeof value.gitRoot !== 'string') throw new Error('Invalid Workflow cleanup eligibility receipt.');
      const input: WorkflowCleanupInput = { runId: value.runId, runDir: value.runDir,
        ownerSessionId: value.ownerSessionId, ownerRunId: value.ownerRunId,
        gitRoot: value.gitRoot, resourcesStopped: true, configHome };
      if (pendingPath(input) !== join(pending, file)) throw new Error('Workflow cleanup receipt identity mismatch.');
      const result = await completeWorkflowRunCleanup(input, deps);
      removed.push(...result.removed); warnings.push(...result.warnings);
    } catch (error: unknown) {
      warnings.push(`Workflow cleanup recovery retained ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { removed, warnings };
}
