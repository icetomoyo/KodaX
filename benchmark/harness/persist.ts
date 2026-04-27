/**
 * FEATURE_104 v2 — Persistence layer for `BenchmarkResult`.
 *
 * Writes a full bench run to disk under
 * `benchmark/results/<ISO-timestamp>/`:
 *
 *   results.json       Full BenchmarkResult JSON (programmatic re-load).
 *   REPORT.md          Human-readable markdown (renderBenchmarkReport).
 *   codes/             One file per (variant, model, runIndex) raw output.
 *   codes-index.json   (variant, model, runIndex) → filename mapping.
 *
 * Anti-pattern 3 from the LiveCanvas recipe is "not persisting raw
 * outputs" — without `codes/` you can't diff "what did the model
 * actually do differently before vs after the prompt change", only
 * compare aggregate scores. Persistence makes the bench instrumentable.
 *
 * The `benchmark/results/` directory is git-ignored by repo policy
 * (see `benchmark/results/.gitignore`), so committing a results
 * snapshot is opt-in (e.g. as a regression baseline alongside a
 * prompt-change PR). The convention docs (`benchmark/README.md`) and
 * datasets (`benchmark/datasets/`) ARE version-tracked.
 */

import { promises as fs } from 'fs';
import path from 'path';

import type { BenchmarkResult } from './harness.js';
import { renderBenchmarkReport } from './report.js';

const DEFAULT_RESULTS_ROOT = path.join(process.cwd(), 'benchmark', 'results');

function timestampSlug(iso: string): string {
  // Replace ':' / '.' so the path is filesystem-safe across Windows / mac / linux.
  return iso.replace(/[:.]/g, '-');
}

function safeFilename(...parts: string[]): string {
  return parts
    .join('--')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_');
}

export interface PersistOptions {
  /** Directory to write under. Defaults to `benchmark/results/<timestamp>/`. */
  readonly outDir?: string;
  /** Override timestamp slug — useful for tests that need deterministic paths. */
  readonly timestampSlug?: string;
  /** Skip writing raw `codes/` directory (when outputs are huge). Default false. */
  readonly skipRawOutputs?: boolean;
}

export interface PersistedRun {
  readonly outDir: string;
  readonly resultsJsonPath: string;
  readonly reportMdPath: string;
  readonly codesDir?: string;
  readonly codesIndexPath?: string;
}

/**
 * Write a `BenchmarkResult` to disk. Returns the paths written.
 *
 * - `results.json`: machine-readable full result (BenchmarkResult shape).
 *   Run-level `runsRaw[*].text` is preserved so the JSON alone is enough
 *   to re-render REPORT.md without re-running providers.
 * - `REPORT.md`: human report from `renderBenchmarkReport`.
 * - `codes/<variant>--<alias>--run<n>.txt`: raw assistant text per run,
 *   one file each. Failed runs (`error` set) get a `--ERROR.txt` suffix
 *   with the error message. Skipped when `skipRawOutputs: true`.
 * - `codes-index.json`: `{ "<variant>--<alias>--<n>": "<filename>" }` map
 *   so eval cases that programmatically diff before/after can find
 *   files by stable id rather than scanning the directory.
 */
export async function writeBenchmarkReport(
  result: BenchmarkResult,
  options: PersistOptions = {},
): Promise<PersistedRun> {
  const slug = options.timestampSlug ?? timestampSlug(result.startedAt);
  const baseDir = options.outDir ?? path.join(DEFAULT_RESULTS_ROOT, slug);
  await fs.mkdir(baseDir, { recursive: true });

  const resultsJsonPath = path.join(baseDir, 'results.json');
  const reportMdPath = path.join(baseDir, 'REPORT.md');

  await fs.writeFile(resultsJsonPath, JSON.stringify(result, null, 2), 'utf8');
  await fs.writeFile(reportMdPath, renderBenchmarkReport(result), 'utf8');

  let codesDir: string | undefined;
  let codesIndexPath: string | undefined;

  if (!options.skipRawOutputs) {
    codesDir = path.join(baseDir, 'codes');
    await fs.mkdir(codesDir, { recursive: true });
    const index: Record<string, string> = {};
    for (const cell of result.cells) {
      for (const run of cell.runsRaw) {
        const key = `${cell.variantId}--${cell.alias}--${run.runIndex}`;
        const safeAlias = cell.alias.replace(/\//g, '_');
        const filename = run.error
          ? safeFilename(cell.variantId, safeAlias, `run${run.runIndex}`, 'ERROR') + '.txt'
          : safeFilename(cell.variantId, safeAlias, `run${run.runIndex}`) + '.txt';
        const filePath = path.join(codesDir, filename);
        const body = run.error
          ? `ERROR: ${run.error}\n\n(no assistant text — provider call failed)\n`
          : run.text;
        await fs.writeFile(filePath, body, 'utf8');
        index[key] = filename;
      }
    }
    codesIndexPath = path.join(baseDir, 'codes-index.json');
    await fs.writeFile(codesIndexPath, JSON.stringify(index, null, 2), 'utf8');
  }

  return {
    outDir: baseDir,
    resultsJsonPath,
    reportMdPath,
    codesDir,
    codesIndexPath,
  };
}

/**
 * Read a previously-persisted `BenchmarkResult` from disk. Useful for
 * eval cases that compare current run vs a committed baseline.
 *
 * `dir` is the timestamped run directory (containing `results.json`).
 */
export async function readBenchmarkResult(dir: string): Promise<BenchmarkResult> {
  const resultsPath = path.join(dir, 'results.json');
  const text = await fs.readFile(resultsPath, 'utf8');
  return JSON.parse(text) as BenchmarkResult;
}
