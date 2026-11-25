#!/usr/bin/env tsx
/**
 * RepoIntel v2 accuracy against compiler truth (Layer 1: deterministic, no LLM calls).
 *
 * Drives the native engine the way the Host does, builds the TypeScript
 * truth of `repo-intelligence-truth-oracle.ts`, and reports:
 *   - definitions: precision / recall over every TypeScript file, for v2 and
 *     for the old engine, on the same comparable set (see
 *     `repo-intelligence-v2-score.ts`), plus how often the lines agree; v2's
 *     extra keys are checked against the syntax tree, since the truth lists
 *     top-level units only and v2 reports every scope;
 *   - callers: v2 references are name matches, so the callers they imply are
 *     the baseline phase 2 must beat; scored on the old truth bench's seeded
 *     sample next to the old engine's callers;
 *   - the reference contract: every page labeled `heuristic`, and paging
 *     through `nextOffset` returns exactly `total` hits;
 *   - import edges: `file.imports` targets of every TypeScript file against
 *     the files the compiler resolves (see `scoreImportEdges`).
 *
 * Usage (from the repo root, after `cargo build --release` in native/repo-intel):
 *   npm run bench:repo-intel-v2-truth -- [repoRoot] [--sample=300] [--seed=20261123]
 *     [--tsconfig=path] [--out=dir] [--no-old]
 *
 * Engine storage goes to mkdtemp dirs under the OS temp root, removed at the
 * end. Results go to benchmark/results/<timestamp>-repo-intel-v2-truth/
 * (gitignored): report.json (with every false positive and miss) and SUMMARY.md.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import ts from 'typescript';

import { buildTruthIndex, isTypeScriptSource, type TruthIndex } from './repo-intelligence-truth-oracle.js';
import { buildEngine, configureEngineEnv, sampleKeys, shutdownWorker } from './repo-intelligence-truth-run.js';
import { evaluateRelation, type Metric } from './repo-intelligence-truth-score.js';
import {
  benchEngineProgram, findAll, importsOf, openAndWait, outlineOf, startBenchEngine,
  type BenchEngine, type ReferenceHit, type WorkspaceStatus,
} from './repo-intelligence-v2-engine.js';
import {
  callersFromReferences, classifyExtraDefinition, oldDefinitionKeys, scoreDefinitions, scoreImportEdges, v2DefinitionKeys,
  type DefinitionKeys, type DefinitionScore, type ExtraDefinitionClass, type ImportEdgeScore, type V2Definition,
} from './repo-intelligence-v2-score.js';

const OUTLINE_BATCH = 32;
const LISTED_ERRORS = 25;

interface BenchOptions {
  readonly repoRoot: string;
  readonly sampleSize: number;
  readonly seed: number;
  readonly tsconfigPath: string;
  readonly outDir: string;
  readonly withOld: boolean;
}

function readFlag(args: readonly string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function parseOptions(argv: readonly string[]): BenchOptions {
  const repoRoot = path.resolve(argv.find((arg) => !arg.startsWith('--')) ?? process.cwd());
  const defaultTsconfig = ['tsconfig.test.json', 'tsconfig.json'].map((name) => path.join(repoRoot, name)).find((file) => existsSync(file));
  const slug = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    repoRoot,
    sampleSize: Number(readFlag(argv, 'sample') ?? 300),
    seed: Number(readFlag(argv, 'seed') ?? 20261123),
    tsconfigPath: path.resolve(repoRoot, readFlag(argv, 'tsconfig') ?? defaultTsconfig ?? 'tsconfig.json'),
    outDir: path.resolve(readFlag(argv, 'out') ?? path.join(process.cwd(), 'benchmark', 'results', `${slug}-repo-intel-v2-truth`)),
    withOld: !argv.includes('--no-old'),
  };
}

interface Outlines {
  readonly definitions: Map<string, V2Definition[]>;
  readonly withSyntaxErrors: Set<string>;
  readonly notIndexed: Record<string, number>;
}

async function readOutlines(engine: BenchEngine, root: string, files: readonly string[]): Promise<Outlines> {
  const definitions = new Map<string, V2Definition[]>();
  const withSyntaxErrors = new Set<string>();
  const notIndexed: Record<string, number> = {};
  for (let start = 0; start < files.length; start += OUTLINE_BATCH) {
    const batch = files.slice(start, start + OUTLINE_BATCH);
    const answers = await Promise.all(batch.map((file) => outlineOf(engine, root, file)));
    answers.forEach((answer, index) => {
      const file = batch[index]!;
      if (!answer.indexed) {
        notIndexed[answer.reason ?? 'unknown'] = (notIndexed[answer.reason ?? 'unknown'] ?? 0) + 1;
        return;
      }
      definitions.set(file, answer.definitions ?? []);
      if (answer.withSyntaxErrors) withSyntaxErrors.add(file);
    });
  }
  return { definitions, withSyntaxErrors, notIndexed };
}

interface Imports {
  readonly edges: Map<string, Set<string>>;
  /** Imports with no target, by why. */
  readonly unresolved: Record<string, number>;
  /** `missing` ones: the import names a repository file that is not there. */
  readonly missing: string[];
  readonly ms: number;
}

async function readImports(engine: BenchEngine, root: string, files: readonly string[]): Promise<Imports> {
  const start = performance.now();
  const edges = new Map<string, Set<string>>();
  const unresolved: Record<string, number> = {};
  const missing: string[] = [];
  for (let first = 0; first < files.length; first += OUTLINE_BATCH) {
    const batch = files.slice(first, first + OUTLINE_BATCH);
    const answers = await Promise.all(batch.map((file) => importsOf(engine, root, file)));
    answers.forEach((answer, index) => {
      const file = batch[index]!;
      const targets = new Set<string>();
      for (const item of answer.imports ?? []) {
        if (item.target) targets.add(item.target);
        const reason = item.unresolved ?? (item.target ? undefined : 'not resolved');
        if (reason) unresolved[reason] = (unresolved[reason] ?? 0) + 1;
        if (reason === 'missing') missing.push(`${file}: ${item.module}`);
      }
      edges.set(file, targets);
    });
  }
  return { edges, unresolved, missing: [...new Set(missing)], ms: Math.round(performance.now() - start) };
}

interface ReferenceContract {
  queries: number;
  pages: number;
  hits: number;
  largestTotal: number;
  labels: Record<string, number>;
  /** Queries whose pages did not add up to `total`. */
  incomplete: string[];
}

interface V2Callers {
  readonly callers: Map<string, Set<string>>;
  readonly contract: ReferenceContract;
  readonly outsideUnits: number;
  readonly outsideTruthFiles: number;
  readonly ms: number;
}

async function v2Callers(engine: BenchEngine, root: string, keys: readonly string[], truth: TruthIndex, outlines: Outlines): Promise<V2Callers> {
  const start = performance.now();
  const callers = new Map<string, Set<string>>();
  const contract: ReferenceContract = { queries: 0, pages: 0, hits: 0, largestTotal: 0, labels: {}, incomplete: [] };
  let outsideUnits = 0;
  let outsideTruthFiles = 0;
  for (const key of keys) {
    const name = truth.units.get(key)?.name ?? key;
    const found = await findAll<ReferenceHit>(engine, 'symbols.references', root, name);
    contract.queries += 1;
    contract.pages += found.pages;
    contract.hits += found.hits.length;
    contract.largestTotal = Math.max(contract.largestTotal, found.total);
    for (const label of found.precisions) contract.labels[label] = (contract.labels[label] ?? 0) + 1;
    if (found.hits.length !== found.total) contract.incomplete.push(`${name}: ${found.hits.length} of ${found.total}`);
    const result = callersFromReferences(found.hits, outlines.definitions, key);
    callers.set(key, result.callers);
    outsideUnits += result.outsideUnits;
    outsideTruthFiles += result.outsideTruthFiles;
  }
  return { callers, contract, outsideUnits, outsideTruthFiles, ms: Math.round(performance.now() - start) };
}

interface V2Run {
  readonly cold: { readonly ms: number; readonly status: WorkspaceStatus };
  readonly outlines: Outlines;
  readonly keys: DefinitionKeys;
  readonly callers: V2Callers;
  readonly imports: Imports;
  readonly version: unknown;
}

async function runV2(options: BenchOptions, files: readonly string[], sample: readonly string[], truth: TruthIndex): Promise<V2Run> {
  const storage = mkdtempSync(path.join(tmpdir(), 'kodax-repointel-v2-truth-'));
  const engine = await startBenchEngine(benchEngineProgram(), storage);
  try {
    const cold = await openAndWait(engine, options.repoRoot);
    log(`v2: ${cold.status.indexed} files indexed in ${cold.ms} ms; reading ${files.length} outlines`);
    const outlines = await readOutlines(engine, options.repoRoot, files);
    const callers = await v2Callers(engine, options.repoRoot, sample, truth, outlines);
    const imports = await readImports(engine, options.repoRoot, files);
    return { cold, outlines, keys: v2DefinitionKeys(outlines.definitions), callers, imports, version: engine.initialize.version };
  } finally {
    await engine.stop();
    safeRemoveTempDir(storage);
  }
}

interface OldRun {
  readonly ms: number;
  readonly keys: DefinitionKeys;
  readonly callers: Metric;
  readonly callersAt8: Metric;
}

async function runOld(options: BenchOptions, files: ReadonlySet<string>, sample: readonly string[], truth: TruthIndex): Promise<OldRun> {
  const storage = mkdtempSync(path.join(tmpdir(), 'kodax-repointel-v2-truth-'));
  try {
    configureEngineEnv(storage);
    const built = await buildEngine(options.repoRoot);
    const none: ReadonlySet<string> = new Set<string>();
    const truthCallers = (key: string) => truth.callers.get(key) ?? none;
    return {
      ms: built.ms,
      keys: oldDefinitionKeys(built.symbols, files),
      callers: evaluateRelation(sample, truthCallers, (key) => built.view.callers.get(key) ?? none, () => '.').overall,
      callersAt8: evaluateRelation(sample, truthCallers, (key) => built.view.callersAt8.get(key) ?? none, () => '.').overall,
    };
  } finally {
    await shutdownWorker();
    safeRemoveTempDir(storage);
  }
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function metricCells(metric: Metric): string {
  return `${pct(metric.precision)} | ${pct(metric.recall)} | ${metric.tp} | ${metric.fp} | ${metric.fn}`;
}

function definitionRow(label: string, score: DefinitionScore): string {
  return `| ${label} | ${metricCells(score.metric)} | ${pct(score.lineAgreement.rate)} |`;
}

function kindTable(v2: DefinitionScore, old: DefinitionScore | undefined): string[] {
  const lines = ['| Kind | v2 recall | old recall |', '|---|---|---|'];
  for (const [kind, metric] of Object.entries(v2.recallByKind).sort()) {
    lines.push(`| ${kind} | ${pct(metric.recall)} (${metric.tp}/${metric.tp + metric.fn}) | ${old ? pct(old.recallByKind[kind]?.recall ?? null) : 'n/a'} |`);
  }
  return lines;
}

/** v2 keys the truth does not list, by what the syntax tree says they are. */
interface ExtraDefinitions {
  readonly counts: Partial<Record<ExtraDefinitionClass, number>>;
  readonly examples: Partial<Record<ExtraDefinitionClass, string[]>>;
}

const KEY_FILE = /^(.*?\.(?:ts|tsx|mts|cts)):/;
const REAL_DECLARATIONS: readonly ExtraDefinitionClass[] = ['local declaration', 'member the truth leaves out'];

function classifyExtras(repoRoot: string, falsePositives: readonly string[], keys: DefinitionKeys): ExtraDefinitions {
  const counts: Partial<Record<ExtraDefinitionClass, number>> = {};
  const examples: Partial<Record<ExtraDefinitionClass, string[]>> = {};
  const sources = new Map<string, ts.SourceFile>();
  for (const key of falsePositives) {
    const file = KEY_FILE.exec(key)?.[1];
    if (!file) throw new Error(`no TypeScript file in key ${key}`);
    let source = sources.get(file);
    if (!source) {
      const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      source = ts.createSourceFile(file, readFileSync(path.join(repoRoot, file), 'utf8'), ts.ScriptTarget.Latest, true, kind);
      sources.set(file, source);
    }
    const label = classifyExtraDefinition(source, key, keys.lines.get(key) ?? []);
    counts[label] = (counts[label] ?? 0) + 1;
    (examples[label] ??= []).push(key);
  }
  return { counts, examples };
}

/** Precision when real declarations the truth leaves out count as right. */
function precisionWithLocals(score: DefinitionScore, extras: ExtraDefinitions): number | null {
  const real = REAL_DECLARATIONS.reduce((sum, label) => sum + (extras.counts[label] ?? 0), 0);
  const all = score.metric.tp + score.metric.fp;
  return all === 0 ? null : (score.metric.tp + real) / all;
}

interface Scores {
  readonly v2: DefinitionScore;
  readonly v2Extras: ExtraDefinitions;
  readonly v2PrecisionWithLocals: number | null;
  readonly old?: DefinitionScore;
  readonly v2Callers: Metric;
  readonly fnInFilesWithSyntaxErrors: number;
  readonly importEdges: ImportEdgeScore;
}

function renderSummary(meta: Record<string, unknown>, scores: Scores, v2: V2Run, old: OldRun | undefined): string {
  const contract = v2.callers.contract;
  return [
    '# RepoIntel v2 truth bench',
    '',
    '```json',
    JSON.stringify(meta, null, 2),
    '```',
    '',
    '## Definitions (every TypeScript file)',
    '',
    '| Engine | Precision | Recall | TP | FP | FN | Lines agree |',
    '|---|---|---|---|---|---|---|',
    definitionRow('v2', scores.v2),
    ...(scores.old ? [definitionRow('old', scores.old)] : []),
    '',
    ...kindTable(scores.v2, scores.old),
    '',
    `- v2 misses in files with syntax errors: ${scores.fnInFilesWithSyntaxErrors} of ${scores.v2.metric.fn} (${v2.outlines.withSyntaxErrors.size} files with syntax errors).`,
    `- Not scored, v2: ${JSON.stringify(v2.keys.notComparable)}${old ? `; old: ${JSON.stringify(old.keys.notComparable)}` : ''}.`,
    `- Truth files the v2 outline did not index: ${JSON.stringify(v2.outlines.notIndexed)}.`,
    `- v2 keys the truth does not list, by the syntax tree: ${JSON.stringify(scores.v2Extras.counts)}; precision counting real declarations as right: ${pct(scores.v2PrecisionWithLocals)}.`,
    ...(['wrong container', 'no declaration on that line'] as const).map((label) =>
      `- v2 ${label} (first ${LISTED_ERRORS}): ${scores.v2Extras.examples[label]?.slice(0, LISTED_ERRORS).join(', ') || 'none'}.`),
    `- v2 misses (first ${LISTED_ERRORS}): ${scores.v2.falseNegatives.slice(0, LISTED_ERRORS).join(', ') || 'none'}.`,
    '',
    `## Callers (sample of ${contract.queries} exported functions and methods)`,
    '',
    '| Source | Precision | Recall | TP | FP | FN |',
    '|---|---|---|---|---|---|',
    `| v2 references (name match) | ${metricCells(scores.v2Callers)} |`,
    ...(old ? [`| old, whole index | ${metricCells(old.callers)} |`, `| old, 8 per record | ${metricCells(old.callersAt8)} |`] : []),
    '',
    `- v2 calls in top-level code (no caller unit): ${v2.callers.outsideUnits}; calls in files outside the truth: ${v2.callers.outsideTruthFiles}.`,
    '',
    '## Reference contract',
    '',
    `- ${contract.queries} names, ${contract.pages} pages, ${contract.hits} hits, largest total ${contract.largestTotal}.`,
    `- Page labels: ${JSON.stringify(contract.labels)}; every page heuristic: ${Object.keys(contract.labels).join() === 'heuristic' ? 'yes' : 'NO'}.`,
    `- Queries whose pages did not add up to total: ${contract.incomplete.length === 0 ? 'none' : contract.incomplete.join('; ')}.`,
    '',
    '## Import edges (every TypeScript file, file to file)',
    '',
    '| Source | Precision | Recall | TP | FP | FN |',
    '|---|---|---|---|---|---|',
    `| v2 file.imports | ${metricCells(scores.importEdges.metric)} |`,
    '',
    `- Truth edges to build output with no listed source, left out: ${scores.importEdges.buildOutputDropped}.`,
    `- v2 imports without a target: ${JSON.stringify(v2.imports.unresolved)}.`,
    `- v2 \`missing\` (first ${LISTED_ERRORS}): ${v2.imports.missing.slice(0, LISTED_ERRORS).join(', ') || 'none'}.`,
    `- False positives (first ${LISTED_ERRORS}): ${scores.importEdges.falsePositives.slice(0, LISTED_ERRORS).join(', ') || 'none'}.`,
    `- Misses (first ${LISTED_ERRORS}): ${scores.importEdges.falseNegatives.slice(0, LISTED_ERRORS).join(', ') || 'none'}.`,
    '',
  ].join('\n');
}

function safeRemoveTempDir(dir: string): void {
  const root = path.resolve(tmpdir());
  const target = path.resolve(dir);
  if (path.dirname(target) === root && path.basename(target).startsWith('kodax-repointel-v2-truth-')) {
    rmSync(target, { recursive: true, force: true });
  }
}

function log(message: string): void {
  process.stdout.write(`[v2-truth] ${message}\n`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const started = performance.now();
  log(`building TypeScript truth for ${options.repoRoot}`);
  const truth = buildTruthIndex(options.repoRoot, options.tsconfigPath);
  const files = truth.sourceFiles.filter(isTypeScriptSource).sort();
  const fileSet = new Set(files);
  const units = new Map([...truth.units].filter(([, unit]) => fileSet.has(unit.filePath)));
  const sample = sampleKeys(truth, options.sampleSize, options.seed);
  log(`truth: ${units.size} units in ${files.length} files; running v2`);
  const v2 = await runV2(options, files, sample, truth);
  if (options.withOld) log('running the old engine');
  const old = options.withOld ? await runOld(options, fileSet, sample, truth) : undefined;
  const none: ReadonlySet<string> = new Set<string>();
  const v2Score = scoreDefinitions(units, v2.keys);
  const v2Extras = classifyExtras(options.repoRoot, v2Score.falsePositives, v2.keys);
  const scores: Scores = {
    v2: v2Score,
    v2Extras,
    v2PrecisionWithLocals: precisionWithLocals(v2Score, v2Extras),
    ...(old ? { old: scoreDefinitions(units, old.keys) } : {}),
    v2Callers: evaluateRelation(sample, (key) => truth.callers.get(key) ?? none, (key) => v2.callers.callers.get(key) ?? none, () => '.').overall,
    fnInFilesWithSyntaxErrors: v2Score.falseNegatives.filter((key) => v2.outlines.withSyntaxErrors.has(units.get(key)!.filePath)).length,
    importEdges: scoreImportEdges(
      new Map([...truth.fileImports].filter(([file]) => fileSet.has(file))),
      v2.imports.edges,
      new Set(truth.sourceFiles),
    ),
  };
  const meta = {
    bench: 'repo-intelligence-v2-truth',
    generatedAt: new Date().toISOString(),
    repoRoot: options.repoRoot,
    engineVersion: v2.version,
    node: process.version,
    tsconfig: path.relative(options.repoRoot, options.tsconfigPath),
    seed: options.seed,
    truth: { typeScriptFiles: files.length, units: units.size, sample: sample.length },
    v2Index: v2.cold.status,
    timingMs: { v2Cold: v2.cold.ms, v2CallerQueries: v2.callers.ms, v2Imports: v2.imports.ms, oldCold: old?.ms, total: Math.round(performance.now() - started) },
  };
  const summary = renderSummary(meta, scores, v2, old);
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(path.join(options.outDir, 'report.json'), `${JSON.stringify({ meta, scores }, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(options.outDir, 'SUMMARY.md'), summary, 'utf8');
  process.stdout.write(`${summary}\n`);
  log(`wrote ${options.outDir}`);
}

await main();
