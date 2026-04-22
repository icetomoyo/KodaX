/**
 * Managed-task repository-intelligence capture.
 *
 * Ported 1:1 from the legacy `task-engine.ts` helpers:
 *   - `shouldEmitRepoIntelligenceTrace` (legacy 293) — gate emission on
 *     `options.context.repoIntelligenceTrace === true` or the env flag
 *     `KODAX_REPO_INTELLIGENCE_TRACE=1`.
 *   - `emitManagedRepoIntelligenceTrace` (legacy 298) — fires
 *     `events.onRepoIntelligenceTrace` with a structured trace event.
 *   - `captureManagedTaskRepoIntelligence` (legacy 4132) — writes up to
 *     five artifacts into `<workspaceDir>/repo-intelligence/`:
 *       `repo-overview.json` / `changed-scope.json` / `active-module.json`
 *       / `impact-estimate.json` / `summary.md` (the first surviving output
 *       also becomes the "summary" artifact record).
 *   - `scheduleManagedTaskRepoIntelligenceCapture` (legacy 4290) —
 *     queues the capture as a microtask so the main task flow is not
 *     blocked by repo-intel IO.
 *   - `attachManagedTaskRepoIntelligence` (legacy 4302) — synchronous
 *     capture whose artifacts are merged into `task.evidence.artifacts`
 *     so downstream consumers (resume, evaluator reshape, REPL transcript
 *     dump) see the snapshot set.
 *
 * Runner-driven AMA path (FEATURE_084) lost all of this in Shard 6d-b;
 * Shard 6d-i restores it here and the task terminal path calls
 * `attachManagedTaskRepoIntelligence` before the snapshot write.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  KodaXEvents,
  KodaXManagedTask,
  KodaXOptions,
  KodaXRepoIntelligenceCarrier,
  KodaXRepoIntelligenceMode,
  KodaXTaskEvidenceArtifact,
} from '../../../types.js';
import { debugLogRepoIntelligence } from '../../../repo-intelligence/internal.js';
import { createRepoIntelligenceTraceEvent } from '../../../repo-intelligence/trace-events.js';
import {
  getRepoOverview,
  renderRepoOverview,
  analyzeChangedScope,
  renderChangedScope,
} from '../../../repo-intelligence/index.js';
import {
  getImpactEstimate,
  getModuleContext,
  getRepoPreturnBundle,
  renderImpactEstimate,
  renderModuleContext,
  resolveKodaXAutoRepoMode,
} from '../../../repo-intelligence/runtime.js';
import { mergeEvidenceArtifacts } from './artifacts.js';

export interface ManagedTaskRepoIntelligenceContext {
  executionCwd?: string;
  gitRoot?: string;
  repoIntelligenceMode?: KodaXRepoIntelligenceMode;
}

export interface ManagedTaskRepoIntelligenceSnapshot {
  artifacts: KodaXTaskEvidenceArtifact[];
}

export function shouldEmitRepoIntelligenceTrace(options: KodaXOptions): boolean {
  return options.context?.repoIntelligenceTrace === true
    || process.env.KODAX_REPO_INTELLIGENCE_TRACE === '1';
}

export function emitManagedRepoIntelligenceTrace(
  events: KodaXEvents | undefined,
  options: KodaXOptions,
  stage: 'routing' | 'preturn' | 'module' | 'impact' | 'task-snapshot',
  carrier: KodaXRepoIntelligenceCarrier | null | undefined,
  detail?: string,
): void {
  if (!events?.onRepoIntelligenceTrace || !shouldEmitRepoIntelligenceTrace(options) || !carrier) {
    return;
  }
  const traceEvent = createRepoIntelligenceTraceEvent(stage, carrier, detail);
  if (traceEvent) {
    events.onRepoIntelligenceTrace(traceEvent);
  }
}

export function resolveManagedTaskRepoIntelligenceContext(
  options: KodaXOptions,
): ManagedTaskRepoIntelligenceContext {
  return {
    executionCwd: options.context?.executionCwd?.trim() || undefined,
    gitRoot: options.context?.gitRoot?.trim() || undefined,
    repoIntelligenceMode: options.context?.repoIntelligenceMode,
  };
}

export async function captureManagedTaskRepoIntelligence(
  context: ManagedTaskRepoIntelligenceContext,
  workspaceDir: string,
  options?: KodaXOptions,
): Promise<ManagedTaskRepoIntelligenceSnapshot> {
  const executionCwd = context.executionCwd;
  const gitRoot = context.gitRoot;
  if (!executionCwd && !gitRoot) {
    return { artifacts: [] };
  }

  const repoContext = {
    executionCwd: executionCwd ?? gitRoot ?? process.cwd(),
    gitRoot: gitRoot ?? undefined,
  };
  const autoRepoMode = resolveKodaXAutoRepoMode(context.repoIntelligenceMode);
  if (autoRepoMode === 'off') {
    return { artifacts: [] };
  }
  const repoSnapshotDir = path.join(workspaceDir, 'repo-intelligence');
  await mkdir(repoSnapshotDir, { recursive: true });

  const artifacts: KodaXTaskEvidenceArtifact[] = [];
  const summarySections: string[] = [];

  const activeModuleTargetPath = executionCwd ? '.' : undefined;
  let preturnBundle: Awaited<ReturnType<typeof getRepoPreturnBundle>> | null = null;

  try {
    const overview = await getRepoOverview(repoContext, { refresh: false });
    const overviewPath = path.join(repoSnapshotDir, 'repo-overview.json');
    await writeFile(overviewPath, `${JSON.stringify(overview, null, 2)}\n`, 'utf8');
    artifacts.push({
      kind: 'json',
      path: overviewPath,
      description: 'Task-scoped repository overview snapshot',
    });
    summarySections.push('## Repository Overview', renderRepoOverview(overview));
  } catch (error) {
    debugLogRepoIntelligence('Skipping task-scoped repo overview snapshot.', error);
  }

  try {
    const changedScope = await analyzeChangedScope(repoContext, {
      scope: 'all',
      refreshOverview: false,
    });
    const changedScopePath = path.join(repoSnapshotDir, 'changed-scope.json');
    await writeFile(changedScopePath, `${JSON.stringify(changedScope, null, 2)}\n`, 'utf8');
    artifacts.push({
      kind: 'json',
      path: changedScopePath,
      description: 'Task-scoped changed-scope snapshot',
    });
    summarySections.push('## Changed Scope', renderChangedScope(changedScope));
  } catch (error) {
    debugLogRepoIntelligence('Skipping task-scoped changed-scope snapshot.', error);
  }

  if (activeModuleTargetPath) {
    if (autoRepoMode === 'premium-native') {
      preturnBundle = await getRepoPreturnBundle(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: false,
        mode: autoRepoMode,
      }).catch(() => null);
      if (preturnBundle && options) {
        emitManagedRepoIntelligenceTrace(
          options.events,
          options,
          'preturn',
          preturnBundle,
          preturnBundle.summary,
        );
      }
    }

    try {
      const moduleContext = preturnBundle?.moduleContext ?? await getModuleContext(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: false,
        mode: autoRepoMode,
      });
      if (options) {
        const moduleId = (moduleContext as { module?: { moduleId?: string } })?.module?.moduleId
          ?? activeModuleTargetPath;
        emitManagedRepoIntelligenceTrace(
          options.events,
          options,
          'module',
          moduleContext,
          `module=${moduleId}`,
        );
      }
      const moduleContextPath = path.join(repoSnapshotDir, 'active-module.json');
      await writeFile(moduleContextPath, `${JSON.stringify(moduleContext, null, 2)}\n`, 'utf8');
      artifacts.push({
        kind: 'json',
        path: moduleContextPath,
        description: 'Task-scoped active module capsule',
      });
      summarySections.push('## Active Module', renderModuleContext(moduleContext));
    } catch (error) {
      debugLogRepoIntelligence('Skipping task-scoped active-module snapshot.', error);
    }

    try {
      const impactEstimate = preturnBundle?.impactEstimate ?? await getImpactEstimate(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: false,
        mode: autoRepoMode,
      });
      if (options) {
        const impactTarget = (impactEstimate as { target?: { label?: string } })?.target?.label
          ?? activeModuleTargetPath;
        emitManagedRepoIntelligenceTrace(
          options.events,
          options,
          'impact',
          impactEstimate,
          `target=${impactTarget}`,
        );
      }
      const impactEstimatePath = path.join(repoSnapshotDir, 'impact-estimate.json');
      await writeFile(impactEstimatePath, `${JSON.stringify(impactEstimate, null, 2)}\n`, 'utf8');
      artifacts.push({
        kind: 'json',
        path: impactEstimatePath,
        description: 'Task-scoped impact estimate capsule',
      });
      summarySections.push('## Impact Estimate', renderImpactEstimate(impactEstimate));
    } catch (error) {
      debugLogRepoIntelligence('Skipping task-scoped impact snapshot.', error);
    }
  }

  if (summarySections.length > 0) {
    const summaryPath = path.join(repoSnapshotDir, 'summary.md');
    await writeFile(summaryPath, `${summarySections.join('\n\n')}\n`, 'utf8');
    if (options) {
      emitManagedRepoIntelligenceTrace(
        options.events,
        options,
        'task-snapshot',
        preturnBundle?.moduleContext ?? preturnBundle?.impactEstimate ?? null,
        `workspace_dir=${repoSnapshotDir}`,
      );
    }
    artifacts.unshift({
      kind: 'markdown',
      path: summaryPath,
      description: 'Task-scoped repository intelligence summary',
    });
  }

  return { artifacts };
}

export function scheduleManagedTaskRepoIntelligenceCapture(
  context: ManagedTaskRepoIntelligenceContext,
  workspaceDir: string,
  options?: KodaXOptions,
): void {
  queueMicrotask(() => {
    void captureManagedTaskRepoIntelligence(context, workspaceDir, options).catch((error) => {
      debugLogRepoIntelligence('Background task-scoped repo intelligence capture failed.', error);
    });
  });
}

export async function attachManagedTaskRepoIntelligence(
  options: KodaXOptions,
  task: KodaXManagedTask,
): Promise<KodaXManagedTask> {
  const snapshot = await captureManagedTaskRepoIntelligence(
    resolveManagedTaskRepoIntelligenceContext(options),
    task.evidence.workspaceDir,
    options,
  );
  if (snapshot.artifacts.length === 0) {
    return task;
  }

  return {
    ...task,
    evidence: {
      ...task.evidence,
      artifacts: mergeEvidenceArtifacts(task.evidence.artifacts, snapshot.artifacts),
    },
  };
}
