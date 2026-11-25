#!/usr/bin/env tsx
/**
 * RepoIntel v2 engine performance on one repository (Layer 1: deterministic, no LLM calls).
 *
 * Measures against the budgets of docs/designs/repointel-v2-2026-11-23.md §5:
 *   - cold index: a fresh index of the whole repository, with the engine's
 *     resident memory sampled while it builds;
 *   - index size on disk and program size;
 *   - warm queries: `symbols.definitions`, `symbols.references` and
 *     `file.outline` for a seeded sample of names the repository defines;
 *   - single-file edit: append a function to `--edit`, tell the engine, and
 *     time until `symbols.definitions` finds it (the file is restored after);
 *   - reopen: a new engine on the same index, as after a Host restart.
 * It also checks the reference contract on every query: pages labeled
 * `heuristic`, and paging to the end returns exactly `total` hits.
 *
 * Usage (from the repo root, after `cargo build --release` in native/repo-intel):
 *   npm run bench:repo-intel-v2 -- [repoRoot] [--names=200] [--seed=20261125]
 *     [--edit=relative/path.ts] [--edits=5] [--out=dir]
 * `--edit` writes to that file in `repoRoot`, so point it at a clone.
 *
 * Engine storage goes to a mkdtemp dir under the OS temp root, removed at the
 * end. Results go to benchmark/results/<timestamp>-repo-intel-v2/
 * (gitignored): report.json and SUMMARY.md.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { seededShuffle } from './repo-intelligence-truth-run.js';
import {
  benchEngineProgram, findAll, openAndWait, outlineOf, startBenchEngine,
  type BenchEngine, type FindPage, type WorkspaceStatus,
} from './repo-intelligence-v2-engine.js';

const MB = 1024 * 1024;
const OUTLINE_FILES = 150;
const PAGED_NAMES = 30;
const MEMORY_SAMPLE_EVERY = 4;
const EDIT_TIMEOUT_MS = 30_000;
const SCRIPT_EDIT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

interface BenchOptions {
  readonly repoRoot: string;
  readonly names: number;
  readonly seed: number;
  readonly edit?: string;
  readonly edits: number;
  readonly outDir: string;
}

function readFlag(args: readonly string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function parseOptions(argv: readonly string[]): BenchOptions {
  const slug = new Date().toISOString().replace(/[:.]/g, '-');
  const edit = readFlag(argv, 'edit');
  if (edit !== undefined && !SCRIPT_EDIT.test(edit)) throw new Error(`--edit must name a TypeScript or JavaScript file, not ${edit}`);
  return {
    repoRoot: path.resolve(argv.find((arg) => !arg.startsWith('--')) ?? process.cwd()),
    names: Number(readFlag(argv, 'names') ?? 200),
    seed: Number(readFlag(argv, 'seed') ?? 20261125),
    ...(edit === undefined ? {} : { edit }),
    edits: Number(readFlag(argv, 'edits') ?? 5),
    outDir: path.resolve(readFlag(argv, 'out') ?? path.join(process.cwd(), 'benchmark', 'results', `${slug}-repo-intel-v2`)),
  };
}

interface Latencies { count: number; p50: number; p95: number; max: number }

function latencies(samples: readonly number[]): Latencies {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0) * 10) / 10;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

async function timed<T>(work: () => Promise<T>, into: number[]): Promise<T> {
  const start = performance.now();
  const result = await work();
  into.push(performance.now() - start);
  return result;
}

function directoryBytes(dir: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) sizes[path.relative(dir, path.join(entry.parentPath, entry.name))] = statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return sizes;
}

/** Cold index with the engine's memory sampled every few status polls. */
async function coldIndex(engine: BenchEngine, root: string): Promise<{ ms: number; status: WorkspaceStatus; peakBytes: number }> {
  let polls = 0;
  let peakBytes = 0;
  const sample = async (): Promise<void> => {
    polls += 1;
    if (polls % MEMORY_SAMPLE_EVERY === 0) peakBytes = Math.max(peakBytes, (await engine.residentBytes()) ?? 0);
  };
  const cold = await openAndWait(engine, root, sample);
  peakBytes = Math.max(peakBytes, (await engine.residentBytes()) ?? 0);
  return { ...cold, peakBytes };
}

async function sampleNames(engine: BenchEngine, options: BenchOptions): Promise<{ names: string[]; outline: Latencies }> {
  const listed = execFileSync('git', ['ls-files'], { cwd: options.repoRoot, encoding: 'utf8', maxBuffer: 256 * MB }).split('\n').filter(Boolean);
  const names = new Set<string>();
  const outlineMs: number[] = [];
  for (const file of seededShuffle(listed, options.seed).slice(0, OUTLINE_FILES * 4)) {
    if (outlineMs.length >= OUTLINE_FILES) break;
    const answer = await timed(() => outlineOf(engine, options.repoRoot, file), outlineMs);
    for (const definition of answer.definitions ?? []) names.add(definition.name);
  }
  return { names: seededShuffle([...names].sort(), options.seed).slice(0, options.names), outline: latencies(outlineMs) };
}

interface QueryReport {
  readonly definitions: Latencies;
  readonly references: Latencies;
  readonly outline: Latencies;
  readonly contract: { labels: Record<string, number>; paged: number; largestTotal: number; incomplete: string[] };
}

async function warmQueries(engine: BenchEngine, options: BenchOptions): Promise<QueryReport> {
  const { names, outline } = await sampleNames(engine, options);
  const definitionMs: number[] = [];
  const referenceMs: number[] = [];
  const contract = { labels: {} as Record<string, number>, paged: 0, largestTotal: 0, incomplete: [] as string[] };
  const totals: Array<[string, number]> = [];
  for (const name of names) {
    await timed(() => engine.call('symbols.definitions', { root: options.repoRoot, name }), definitionMs);
    const page = await timed(() => engine.call<FindPage<unknown>>('symbols.references', { root: options.repoRoot, name }), referenceMs);
    contract.labels[page.precision] = (contract.labels[page.precision] ?? 0) + 1;
    totals.push([name, page.total]);
  }
  const mostReferenced = totals.sort((a, b) => b[1] - a[1]).slice(0, PAGED_NAMES);
  for (const [name] of mostReferenced) {
    const all = await findAll(engine, 'symbols.references', options.repoRoot, name);
    contract.paged += 1;
    contract.largestTotal = Math.max(contract.largestTotal, all.total);
    for (const label of all.precisions) contract.labels[label] = (contract.labels[label] ?? 0) + 1;
    if (all.hits.length !== all.total) contract.incomplete.push(`${name}: ${all.hits.length} of ${all.total}`);
  }
  return { definitions: latencies(definitionMs), references: latencies(referenceMs), outline, contract };
}

async function waitForDefinition(engine: BenchEngine, root: string, name: string): Promise<void> {
  const deadline = performance.now() + EDIT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const page = await engine.call<FindPage<unknown>>('symbols.definitions', { root, name });
    if (page.total > 0) return;
  }
  throw new Error(`The engine did not index ${name} within ${EDIT_TIMEOUT_MS} ms`);
}

/** Appends a function to the file, tells the engine, and times until a query finds it. */
async function singleFileEdits(engine: BenchEngine, options: BenchOptions): Promise<Latencies | undefined> {
  if (options.edit === undefined) return undefined;
  const file = path.join(options.repoRoot, options.edit);
  const original = readFileSync(file);
  const samples: number[] = [];
  try {
    for (let index = 0; index < options.edits; index += 1) {
      const name = `kodaxBenchProbe${index}x${Date.now()}`;
      appendFileSync(file, `\nexport function ${name}() {}\n`);
      const start = performance.now();
      engine.connection.notify('files.changed', { root: options.repoRoot, paths: [options.edit] });
      await waitForDefinition(engine, options.repoRoot, name);
      samples.push(performance.now() - start);
    }
  } finally {
    writeFileSync(file, original);
    engine.connection.notify('files.changed', { root: options.repoRoot, paths: [options.edit] });
  }
  return latencies(samples);
}

async function reopen(program: string, storage: string, root: string): Promise<{ ms: number; residentBytes?: number }> {
  const engine = await startBenchEngine(program, storage);
  try {
    const { ms } = await openAndWait(engine, root);
    const residentBytes = await engine.residentBytes();
    return { ms, ...(residentBytes === undefined ? {} : { residentBytes }) };
  } finally {
    await engine.stop();
  }
}

function mb(bytes: number | undefined): string {
  return bytes === undefined ? 'n/a' : `${(bytes / MB).toFixed(1)} MB`;
}

function latencyRow(label: string, value: Latencies | undefined, budget: string): string {
  return value === undefined
    ? `| ${label} | not run (no --edit) | ${budget} |`
    : `| ${label} | p50 ${value.p50} ms, p95 ${value.p95} ms, max ${value.max} ms (${value.count}) | ${budget} |`;
}

interface Measures {
  readonly binaryBytes: number;
  readonly cold: Awaited<ReturnType<typeof coldIndex>>;
  readonly memory: { afterCold?: number; afterQueries?: number; afterEdits?: number };
  readonly disk: Record<string, number>;
  readonly queries: QueryReport;
  readonly edits?: Latencies;
  readonly reopen: Awaited<ReturnType<typeof reopen>>;
}

function renderSummary(meta: Record<string, unknown>, m: Measures): string {
  const diskTotal = Object.values(m.disk).reduce((sum, size) => sum + size, 0);
  const contract = m.queries.contract;
  return [
    '# RepoIntel v2 performance bench',
    '',
    '```json',
    JSON.stringify(meta, null, 2),
    '```',
    '',
    '| Measure | Result | Budget |',
    '|---|---|---|',
    `| Cold index | ${m.cold.ms} ms for ${m.cold.status.indexed} files (${m.cold.status.filesRead} read) | tens of seconds at 10k files |`,
    `| Engine memory, peak while indexing | ${mb(m.cold.peakBytes)} | ≤ 300 MB at 10k files |`,
    `| Engine memory after index / queries / edits | ${mb(m.memory.afterCold)} / ${mb(m.memory.afterQueries)} / ${mb(m.memory.afterEdits)} | ≤ 300 MB |`,
    `| Index on disk | ${mb(diskTotal)} (${Object.entries(m.disk).map(([file, size]) => `${file} ${mb(size)}`).join(', ')}) | far below 60 MB |`,
    `| Program size | ${mb(m.binaryBytes)} | measured |`,
    latencyRow('symbols.definitions', m.queries.definitions, 'p95 < 50 ms'),
    latencyRow('symbols.references (first page)', m.queries.references, 'p95 < 50 ms'),
    latencyRow('file.outline', m.queries.outline, 'p95 < 50 ms'),
    latencyRow('Single-file edit until found', m.edits, '< 100 ms'),
    `| Reopen with the index on disk | ${m.reopen.ms} ms, then ${mb(m.reopen.residentBytes)} | — |`,
    '',
    `- Syntax errors in ${m.cold.status.withSyntaxErrors} files; not indexed: ${JSON.stringify(m.cold.status.notIndexed)}.`,
    `- Reference contract: page labels ${JSON.stringify(contract.labels)}; paged ${contract.paged} most-referenced names to the end (largest total ${contract.largestTotal}); incomplete: ${contract.incomplete.length === 0 ? 'none' : contract.incomplete.join('; ')}.`,
    '',
  ].join('\n');
}

function safeRemoveTempDir(dir: string): void {
  const root = path.resolve(tmpdir());
  const target = path.resolve(dir);
  if (path.dirname(target) === root && path.basename(target).startsWith('kodax-repointel-v2-perf-')) {
    rmSync(target, { recursive: true, force: true });
  }
}

function log(message: string): void {
  process.stdout.write(`[v2-perf] ${message}\n`);
}

async function firstRun(engine: BenchEngine, storage: string, options: BenchOptions): Promise<Omit<Measures, 'binaryBytes' | 'reopen'>> {
  log(`cold index of ${options.repoRoot}`);
  const cold = await coldIndex(engine, options.repoRoot);
  const memory: Measures['memory'] = { afterCold: await engine.residentBytes() };
  const disk = directoryBytes(storage);
  log(`indexed ${cold.status.indexed} files in ${cold.ms} ms; querying`);
  const queries = await warmQueries(engine, options);
  memory.afterQueries = await engine.residentBytes();
  const edits = await singleFileEdits(engine, options);
  memory.afterEdits = await engine.residentBytes();
  return { cold, memory, disk, queries, ...(edits ? { edits } : {}) };
}

async function measure(program: string, storage: string, options: BenchOptions): Promise<Measures> {
  const engine = await startBenchEngine(program, storage);
  let first: Awaited<ReturnType<typeof firstRun>>;
  try {
    first = await firstRun(engine, storage, options);
  } finally {
    await engine.stop();
  }
  log('reopening on the same index');
  return { binaryBytes: statSync(program).size, ...first, reopen: await reopen(program, storage, options.repoRoot) };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const program = benchEngineProgram();
  const storage = mkdtempSync(path.join(tmpdir(), 'kodax-repointel-v2-perf-'));
  try {
    const measures = await measure(program, storage, options);
    const meta = {
      bench: 'repo-intelligence-v2',
      generatedAt: new Date().toISOString(),
      repoRoot: options.repoRoot,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: options.repoRoot, encoding: 'utf8' }).trim(),
      program,
      platform: `${process.platform}-${process.arch}`,
      seed: options.seed,
      names: options.names,
      edit: options.edit ?? null,
    };
    const summary = renderSummary(meta, measures);
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(path.join(options.outDir, 'report.json'), `${JSON.stringify({ meta, measures }, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(options.outDir, 'SUMMARY.md'), summary, 'utf8');
    process.stdout.write(`${summary}\n`);
    log(`wrote ${options.outDir}`);
  } finally {
    safeRemoveTempDir(storage);
  }
}

await main();
