/**
 * FEATURE_107 (v0.7.32) — Top-level orchestrator for H2 plan-execute boundary
 * eval. Runs `cases × aliases × variants` cells via `agent-task-runner.ts`,
 * persists transcripts, and aggregates a per-cell result matrix.
 *
 * Usage from a runner script (P4 will live under `tests/h2-plan-execute-boundary.eval.ts`):
 *
 *   import { runH2BoundaryEval } from '../benchmark/harness/h2-boundary-runner.js';
 *   import { H2_BOUNDARY_TASKS, H2_BOUNDARY_VARIANTS } from
 *     '../benchmark/datasets/h2-plan-execute-boundary/cases.js';
 *   import { availableAliases } from '../benchmark/harness/aliases.js';
 *
 *   const aliases = availableAliases('zhipu/glm51', 'kimi', 'ds/v4flash');
 *   const result = await runH2BoundaryEval({
 *     cases: H2_BOUNDARY_TASKS,
 *     aliases,
 *     variants: H2_BOUNDARY_VARIANTS,
 *   });
 *
 * Persistence: each cell's session jsonl + diff is preserved under
 * `benchmark/results/<ISO>/h2-boundary/<caseId>/<alias>/<variant>/` so P5
 * analysis can replay specific cells without rerunning the eval.
 */

import { promises as fs } from 'fs';
import path from 'path';

import {
  cleanupAgentTaskArtifacts,
  runAgentTaskInWorktree,
  type AgentTaskResult,
  type EvalVariant,
} from './agent-task-runner.js';
import type { ModelAlias } from './aliases.js';
import {
  assertPrimaryHeadUnchanged,
  scanAndCleanOrphanWorktrees,
} from './worktree-runner.js';

interface BoundaryCaseShape {
  readonly id: string;
  readonly userMessage: string;
  readonly gitHeadSha: string | null;
  readonly mustTouchFiles: readonly string[];
  readonly mustNotTouchFiles: readonly string[];
}

export interface BoundaryRunInput {
  readonly cases: readonly BoundaryCaseShape[];
  readonly aliases: readonly ModelAlias[];
  readonly variants: readonly EvalVariant[];
  /** Per-cell timeout. Default 10 min (matches agent-task-runner). */
  readonly timeoutMsPerCell?: number;
  /** Where to persist transcripts. Default `benchmark/results/<ISO>/h2-boundary/`. */
  readonly resultsRoot?: string;
  /** Override repo root (test seam). */
  readonly repoRoot?: string;
  /** Skip orphan worktree pre-scan (test seam). */
  readonly skipOrphanScan?: boolean;
  /**
   * Override how `kodax` is invoked per cell. See
   * `AgentTaskInput.binOverride` for shape. Use to point at a freshly built
   * dist (so P2.1 env hooks are present) or at a fake bin for plumbing tests.
   */
  readonly binOverride?: { command: string; args?: readonly string[] };
}

export interface BoundaryCellOutcome {
  readonly caseId: string;
  readonly alias: ModelAlias;
  readonly variant: EvalVariant;
  readonly task: AgentTaskResult;
  /** mustTouchFiles ∩ filesChanged (Pool 1+2: predicted; Pool 3: objective). */
  readonly mustTouchHits: readonly string[];
  /** mustNotTouchFiles ∩ filesChanged — non-empty means scope violation. */
  readonly mustNotTouchViolations: readonly string[];
  /** Path where transcript + diff were persisted. */
  readonly persistedAt: string;
}

export interface BoundaryRunResult {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly resultsDir: string;
  readonly orphanScan: { removed: readonly string[]; failed: readonly { path: string; error: string }[] };
  readonly cells: readonly BoundaryCellOutcome[];
  readonly primaryHeadUntouched: { ok: true } | { ok: false; reason: string };
}

const ISO_SAFE = (iso: string): string => iso.replace(/[:.]/g, '-');

function caseTouchHits(
  filesChanged: readonly string[],
  required: readonly string[],
): string[] {
  const set = new Set(filesChanged);
  return required.filter((p) => set.has(p));
}

function caseTouchViolations(
  filesChanged: readonly string[],
  forbidden: readonly string[],
): string[] {
  // forbidden may be either an exact path or a directory prefix (ending in '/').
  return filesChanged.filter((f) =>
    forbidden.some((rule) => (rule.endsWith('/') ? f.startsWith(rule) : f === rule)),
  );
}

async function persistCell(
  resultsRoot: string,
  task: AgentTaskResult,
): Promise<string> {
  const cellDir = path.join(
    resultsRoot,
    task.caseId,
    task.alias.replace(/[/]/g, '_'),
    task.variant,
  );
  await fs.mkdir(cellDir, { recursive: true });
  const meta = {
    caseId: task.caseId,
    alias: task.alias,
    variant: task.variant,
    exitCode: task.exitCode,
    processOk: task.processOk,
    timedOut: task.timedOut,
    durationMs: task.durationMs,
    filesChanged: task.filesChanged,
  };
  await fs.writeFile(
    path.join(cellDir, 'meta.json'),
    JSON.stringify(meta, null, 2),
    'utf8',
  );
  await fs.writeFile(path.join(cellDir, 'stdout.tail.txt'), task.stdoutTail, 'utf8');
  await fs.writeFile(path.join(cellDir, 'stderr.tail.txt'), task.stderrTail, 'utf8');
  if (task.sessionJsonlPath) {
    try {
      const content = await fs.readFile(task.sessionJsonlPath, 'utf8');
      await fs.writeFile(path.join(cellDir, 'session.jsonl'), content, 'utf8');
    } catch {
      // session jsonl may have been cleaned up early; non-fatal.
    }
  }
  return cellDir;
}

async function resolveHead(repoRoot: string): Promise<string> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
  });
  return stdout.trim();
}

/**
 * Run the full N×M×V eval matrix. Sequential by default (network-bound,
 * provider-rate-limit considerations). Each cell is independent so adding
 * concurrency later is a one-line change.
 */
export async function runH2BoundaryEval(
  input: BoundaryRunInput,
): Promise<BoundaryRunResult> {
  const repoRoot = input.repoRoot ?? process.cwd();
  const startedAt = new Date().toISOString();
  const resultsDir =
    input.resultsRoot ??
    path.join(
      repoRoot,
      'benchmark',
      'results',
      `${ISO_SAFE(startedAt)}-h2-boundary`,
    );
  await fs.mkdir(resultsDir, { recursive: true });

  const headAtStart = await resolveHead(repoRoot);
  const orphanScan = input.skipOrphanScan
    ? { removed: [], failed: [] }
    : await scanAndCleanOrphanWorktrees({ repoRoot });

  const cells: BoundaryCellOutcome[] = [];
  for (const c of input.cases) {
    for (const alias of input.aliases) {
      for (const variant of input.variants) {
        const task = await runAgentTaskInWorktree({
          caseId: c.id,
          userMessage: c.userMessage,
          gitHeadSha: c.gitHeadSha,
          alias,
          variant,
          timeoutMs: input.timeoutMsPerCell,
          repoRoot,
          binOverride: input.binOverride,
        });
        const persistedAt = await persistCell(resultsDir, task);
        await cleanupAgentTaskArtifacts(task);
        cells.push({
          caseId: c.id,
          alias,
          variant,
          task,
          mustTouchHits: caseTouchHits(task.filesChanged, c.mustTouchFiles),
          mustNotTouchViolations: caseTouchViolations(
            task.filesChanged,
            c.mustNotTouchFiles,
          ),
          persistedAt,
        });
      }
    }
  }

  const primaryHeadUntouched = await assertPrimaryHeadUnchanged({
    repoRoot,
    expectedHeadAtStart: headAtStart,
  });

  const finishedAt = new Date().toISOString();
  const result: BoundaryRunResult = {
    startedAt,
    finishedAt,
    resultsDir,
    orphanScan,
    cells,
    primaryHeadUntouched,
  };

  await fs.writeFile(
    path.join(resultsDir, 'matrix.json'),
    JSON.stringify(
      {
        ...result,
        // Strip stdout/stderr tails from rolled-up matrix to keep size small;
        // per-cell stdout.tail.txt has them.
        cells: cells.map((c) => ({
          ...c,
          task: {
            caseId: c.task.caseId,
            alias: c.task.alias,
            variant: c.task.variant,
            exitCode: c.task.exitCode,
            processOk: c.task.processOk,
            timedOut: c.task.timedOut,
            durationMs: c.task.durationMs,
            sessionJsonlPath: c.task.sessionJsonlPath,
            filesChanged: c.task.filesChanged,
          },
        })),
      },
      null,
      2,
    ),
    'utf8',
  );

  return result;
}
