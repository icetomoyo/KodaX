#!/usr/bin/env tsx
/**
 * Repo-intelligence truth-set accuracy bench (Layer 1: deterministic, no LLM calls).
 *
 * Builds the old semantic engine's full index for a TypeScript repo, builds
 * ground truth with the TypeScript compiler (see
 * `repo-intelligence-truth-oracle.ts`), and reports precision / recall for:
 *   - call targets  (outgoing calls of a symbol)
 *   - callers       (incoming calls; whole index, and the 8-per-record view
 *                    that `symbol_context` shows)
 *   - module dependency edges, plus cycles that only exist because of false edges
 * with diagnostics that explain the errors (cross-language, test-file and
 * name-only edges, symbols missing from the index, cap hits).
 *
 * Scopes:
 *   - sample:     seeded sample of exported functions/methods in non-test TS files
 *   - pinned:     every symbol in 5 pinned files (3 largest, 2 seeded mid-size)
 *   - population: every symbol in every TS file
 * A seeded subset of the sample is also queried by name through the public
 * `getSymbolContext` surface.
 *
 * Usage (from the repo root):
 *   npm run bench:repo-intel-truth -- [repoRoot] [--sample=300] [--seed=20261123]
 *     [--tool-queries=40] [--tsconfig=path] [--out=dir]
 *
 * Engine storage goes to a mkdtemp dir under the OS temp root, removed at the
 * end. Results go to benchmark/results/<timestamp>-repo-intel-truth/
 * (gitignored): report.json, details.json (per-symbol edges for the sample
 * and pinned scopes) and SUMMARY.md. Runtime on KodaX is about one minute;
 * the engine worker gets a 6 GB heap because the default 2 GB runs out of
 * memory on this repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

import {
  getRepoIntelligenceIndex,
  getSymbolContext,
} from '../../packages/coding/src/repo-intelligence/runtime.js';
import * as workerClient from '../../packages/coding/src/repo-intelligence/semantic-worker-client.js';
import {
  buildTruthIndex,
  isTestFile,
  isTypeScriptSource,
  type TruthIndex,
} from './repo-intelligence-truth-oracle.js';
import {
  buildEngineView,
  compareModuleEdges,
  definitionLineAgreement,
  engineEdgeComposition,
  evaluateRelation,
  explainCallTargetErrors,
  missingSymbols,
  moduleForFile,
  toMetric,
  type EngineIndexLike,
  type EngineView,
  type ModuleEdgeReport,
  type RelationReport,
} from './repo-intelligence-truth-score.js';

const ENGINE_SYMBOLS_PER_FILE_CAP = 40;
const SCOPES = ['sample', 'pinned', 'population'] as const;
type Scope = typeof SCOPES[number];

interface BenchOptions {
  readonly repoRoot: string;
  readonly sampleSize: number;
  readonly seed: number;
  readonly toolQueries: number;
  readonly tsconfigPath: string;
  readonly outDir: string;
}

interface EvaluationSet {
  readonly pinnedFiles: string[];
  readonly keys: Record<Scope, string[]>;
}

function readFlag(args: readonly string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function parseOptions(argv: readonly string[]): BenchOptions {
  const repoRoot = path.resolve(argv.find((arg) => !arg.startsWith('--')) ?? process.cwd());
  const defaultTsconfig = ['tsconfig.test.json', 'tsconfig.json']
    .map((name) => path.join(repoRoot, name))
    .find((file) => existsSync(file));
  const tsconfigPath = path.resolve(repoRoot, readFlag(argv, 'tsconfig') ?? defaultTsconfig ?? 'tsconfig.json');
  const slug = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    repoRoot,
    sampleSize: Number(readFlag(argv, 'sample') ?? 300),
    seed: Number(readFlag(argv, 'seed') ?? 20261123),
    toolQueries: Number(readFlag(argv, 'tool-queries') ?? 40),
    tsconfigPath,
    outDir: path.resolve(readFlag(argv, 'out') ?? path.join(process.cwd(), 'benchmark', 'results', `${slug}-repo-intel-truth`)),
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

function pickPinnedFiles(truth: TruthIndex, seed: number): string[] {
  const counts = new Map<string, number>();
  for (const unit of truth.units.values()) {
    if (isTypeScriptSource(unit.filePath) && !isTestFile(unit.filePath)) {
      counts.set(unit.filePath, (counts.get(unit.filePath) ?? 0) + 1);
    }
  }
  const bySize = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const largest = bySize.slice(0, 3).map(([file]) => file);
  const midSize = bySize.filter(([, count]) => count >= 5 && count < ENGINE_SYMBOLS_PER_FILE_CAP).map(([file]) => file).sort();
  return [...largest, ...seededShuffle(midSize, seed).slice(0, 2)];
}

function selectEvaluationSet(truth: TruthIndex, sampleSize: number, seed: number): EvaluationSet {
  const units = Array.from(truth.units.values());
  const pool = units
    .filter((unit) => (unit.kind === 'function' || unit.kind === 'method') && unit.exported)
    .filter((unit) => isTypeScriptSource(unit.filePath) && !isTestFile(unit.filePath))
    .map((unit) => unit.key)
    .sort();
  const pinnedFiles = pickPinnedFiles(truth, seed);
  return {
    pinnedFiles,
    keys: {
      sample: seededShuffle(pool, seed).slice(0, sampleSize),
      pinned: units.filter((unit) => pinnedFiles.includes(unit.filePath)).map((unit) => unit.key).sort(),
      population: units.filter((unit) => isTypeScriptSource(unit.filePath)).map((unit) => unit.key).sort(),
    },
  };
}

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

/** Samples process RSS (the engine worker is a thread, so it is included) overall and per phase. */
function startMemorySampler() {
  let peak = rssMb();
  let phasePeak = peak;
  const phases: Record<string, { peakRssMb: number; endRssMb: number }> = {};
  const timer = setInterval(() => {
    const current = rssMb();
    peak = Math.max(peak, current);
    phasePeak = Math.max(phasePeak, current);
  }, 200);
  timer.unref();
  return {
    mark: (phase: string) => {
      const end = rssMb();
      phases[phase] = { peakRssMb: Math.max(phasePeak, end), endRssMb: end };
      phasePeak = end;
    },
    stop: () => {
      clearInterval(timer);
      return { peakRssMb: peak, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024), phases };
    },
  };
}

/** Engine env: full mode, temp storage, and enough worker heap to finish (2 GB runs out on KodaX). */
function configureEngineEnv(storageRoot: string): Record<string, string> {
  process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR = storageRoot;
  process.env.KODAX_REPO_INTELLIGENCE = 'full';
  process.env.KODAX_REPO_INTELLIGENCE_WORKER_OLD_SPACE_MB ??= '6144';
  process.env.KODAX_REPO_INTELLIGENCE_WORKER_TIMEOUT_MS ??= '600000';
  return {
    KODAX_REPO_INTELLIGENCE: 'full',
    KODAX_REPO_INTELLIGENCE_WORKER_OLD_SPACE_MB: process.env.KODAX_REPO_INTELLIGENCE_WORKER_OLD_SPACE_MB,
    KODAX_REPO_INTELLIGENCE_WORKER_TIMEOUT_MS: process.env.KODAX_REPO_INTELLIGENCE_WORKER_TIMEOUT_MS,
  };
}

// Looked up by name so the bench keeps running if these internal helpers move.
async function shutdownWorker(): Promise<void> {
  const shutdown: unknown = Reflect.get(workerClient, 'shutdownRepoIntelligenceWorkerForTest');
  if (typeof shutdown === 'function') await shutdown();
}

function workerPath(): string | undefined {
  const read: unknown = Reflect.get(workerClient, 'getRepoIntelligenceWorkerPathForDiagnostics');
  return typeof read === 'function' ? String(read()) : undefined;
}

async function buildEngine(repoRoot: string): Promise<{ view: EngineView; ms: number; status: string }> {
  const start = performance.now();
  const options = { refresh: true, mode: 'full' as const };
  const index = await getRepoIntelligenceIndex({ executionCwd: repoRoot, gitRoot: repoRoot }, options);
  const ms = Math.round(performance.now() - start);
  const status = index.capability?.status ?? 'unknown';
  if (index.symbols.length === 0) {
    throw new Error(`Engine returned an empty index (capability status: ${status}). Check worker heap / timeout.`);
  }
  const view = buildEngineView(index as EngineIndexLike);
  await shutdownWorker();
  return { view, ms, status };
}

type ToolOutcome = 'exact' | 'alternative' | 'wrong-symbol' | 'not-ok-status' | 'error';

interface ToolQueryResult {
  readonly outcome: ToolOutcome;
  readonly callers?: Set<string>;
  readonly detail?: string;
}

async function queryOneSymbol(repoRoot: string, key: string, name: string): Promise<ToolQueryResult> {
  try {
    const result = await getSymbolContext({ executionCwd: repoRoot, gitRoot: repoRoot }, { symbol: name, mode: 'full' });
    const status = result.capability?.status;
    if (status && status !== 'ok') return { outcome: 'not-ok-status', detail: status };
    if (result.symbol.qualifiedName === key) {
      return { outcome: 'exact', callers: new Set(result.callers.map((caller) => caller.qualifiedName)) };
    }
    const isAlternative = result.alternatives.some((alternative) => alternative.qualifiedName === key);
    return { outcome: isAlternative ? 'alternative' : 'wrong-symbol', detail: result.symbol.qualifiedName };
  } catch (error) {
    return { outcome: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

function addCallerCounts(counts: { tp: number; fp: number; fn: number }, truth: ReadonlySet<string>, shown: ReadonlySet<string>): void {
  for (const caller of shown) {
    if (truth.has(caller)) counts.tp += 1;
    else counts.fp += 1;
  }
  for (const caller of truth) {
    if (!shown.has(caller)) counts.fn += 1;
  }
}

async function runToolQueries(repoRoot: string, keys: readonly string[], truth: TruthIndex, engine: EngineView) {
  const outcomes: Record<ToolOutcome, number> = { exact: 0, alternative: 0, 'wrong-symbol': 0, 'not-ok-status': 0, error: 0 };
  const counts = { tp: 0, fp: 0, fn: 0 };
  const rows: Array<{ key: string; inEngineIndex: boolean; outcome: ToolOutcome; detail?: string }> = [];
  const start = performance.now();
  for (const key of keys) {
    const result = await queryOneSymbol(repoRoot, key, truth.units.get(key)?.name ?? key);
    outcomes[result.outcome] += 1;
    rows.push({ key, inEngineIndex: engine.lines.has(key), outcome: result.outcome, ...(result.detail ? { detail: result.detail } : {}) });
    if (result.callers) addCallerCounts(counts, truth.callers.get(key) ?? new Set<string>(), result.callers);
  }
  await shutdownWorker();
  return { queried: keys.length, ms: Math.round(performance.now() - start), outcomes, callersOnExactMatches: toMetric(counts), rows };
}

function gitText(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message.split('\n', 1)[0] : String(error)}`;
  }
}

function perScope<T>(compute: (keys: readonly string[]) => T, set: EvaluationSet): Record<Scope, T> {
  return { sample: compute(set.keys.sample), pinned: compute(set.keys.pinned), population: compute(set.keys.population) };
}

function scoreRelations(truth: TruthIndex, engine: EngineView, set: EvaluationSet) {
  const none: ReadonlySet<string> = new Set<string>();
  const moduleOf = (key: string) => moduleForFile(truth.units.get(key)?.filePath ?? key, engine.modules);
  const truthCallees = (key: string) => truth.callees.get(key) ?? none;
  const engineCallees = (key: string) => new Set(engine.callees.get(key)?.keys() ?? []);
  const truthCallers = (key: string) => truth.callers.get(key) ?? none;
  return {
    callTargets: perScope((keys) => evaluateRelation(keys, truthCallees, engineCallees, moduleOf), set),
    callers: perScope((keys) => evaluateRelation(keys, truthCallers, (key) => engine.callers.get(key) ?? none, moduleOf), set),
    callersAt8: perScope((keys) => evaluateRelation(keys, truthCallers, (key) => engine.callersAt8.get(key) ?? none, moduleOf), set),
    moduleDependencies: compareModuleEdges(truth, engine),
  };
}

function scoreDiagnostics(truth: TruthIndex, engine: EngineView, set: EvaluationSet) {
  return {
    engineEdgeComposition: engineEdgeComposition(engine),
    callTargetErrors: perScope((keys) => explainCallTargetErrors(keys, truth, engine), set),
    missingSymbols: perScope((keys) => missingSymbols(keys, truth, engine, ENGINE_SYMBOLS_PER_FILE_CAP), set),
    callTargetCapHits: perScope((keys) => keys.filter((key) => engine.targetCapHits.has(key)).length, set),
    definitionLines: perScope((keys) => definitionLineAgreement(keys, truth, engine), set),
    truthCallSites: truth.callSites,
    truthJsxElementSitesNotCounted: truth.jsxElementSites,
  };
}

function symbolDetails(truth: TruthIndex, engine: EngineView, keys: readonly string[]) {
  return keys.map((key) => {
    const engineTargets = engine.callees.get(key) ?? new Map<string, Set<string>>();
    return {
      key,
      module: moduleForFile(truth.units.get(key)?.filePath ?? key, engine.modules),
      inEngineIndex: engine.lines.has(key),
      engineRecords: engine.lines.get(key)?.length ?? 0,
      truthCallTargets: Array.from(truth.callees.get(key) ?? []).sort(),
      engineCallTargets: Array.from(engineTargets.entries())
        .map(([target, reasons]) => ({ target, reasons: Array.from(reasons).sort(), correct: truth.callees.get(key)?.has(target) ?? false }))
        .sort((a, b) => a.target.localeCompare(b.target)),
      truthCallers: Array.from(truth.callers.get(key) ?? []).sort(),
      engineCallers: Array.from(engine.callers.get(key) ?? []).sort(),
    };
  });
}

type Relations = ReturnType<typeof scoreRelations>;
type Diagnostics = ReturnType<typeof scoreDiagnostics>;
type ToolQueries = Awaited<ReturnType<typeof runToolQueries>>;

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function relationRows(label: string, reports: Record<Scope, RelationReport>): string[] {
  return SCOPES.map((scope) => {
    const { overall } = reports[scope];
    return `| ${label} | ${scope} (${reports[scope].symbols}) | ${pct(overall.precision)} | ${pct(overall.recall)} | ${overall.tp} | ${overall.fp} | ${overall.fn} |`;
  });
}

function moduleEdgeRow(label: string, report: ModuleEdgeReport): string {
  const { metric } = report;
  return `| module edges | ${label} | ${pct(metric.precision)} | ${pct(metric.recall)} | ${metric.tp} | ${metric.fp} | ${metric.fn} |`;
}

function moduleTable(relations: Relations, scope: Scope): string[] {
  const lines = [`| Module (${scope}) | call targets P / R | callers P / R | callers@8 R |`, '|---|---|---|---|'];
  for (const module of Object.keys(relations.callTargets[scope].byModule)) {
    const targets = relations.callTargets[scope].byModule[module]!;
    const callers = relations.callers[scope].byModule[module]!;
    const at8 = relations.callersAt8[scope].byModule[module]!;
    lines.push(`| ${module} | ${pct(targets.precision)} / ${pct(targets.recall)} | ${pct(callers.precision)} / ${pct(callers.recall)} | ${pct(at8.recall)} |`);
  }
  return lines;
}

function errorLines(diagnostics: Diagnostics, scope: Scope): string[] {
  const errors = diagnostics.callTargetErrors[scope];
  const missing = diagnostics.missingSymbols[scope];
  const precisionByReason = Object.entries(errors.precisionByReason).map(([reason, metric]) => `${reason} ${pct(metric.precision)} (${metric.tp}/${metric.tp + metric.fp})`).join(', ');
  return [
    `- [${scope}] call-target FP ${errors.falsePositives}: name-match only ${errors.fpNameMatchOnly}, cross-language ${errors.fpCrossLanguage}, production -> test ${errors.fpIntoTestFile}, target not a TS symbol ${errors.fpTargetNotTruthUnit}. Precision by engine reason: ${precisionByReason}.`,
    `- [${scope}] call-target FN ${errors.falseNegatives}: source not indexed ${errors.fnSourceNotIndexed}, target not indexed ${errors.fnTargetNotIndexed}, source at 8-target cap ${errors.fnSourceAtTargetCap}, other ${errors.fnOther}.`,
    `- [${scope}] symbols missing from the index: ${missing.missing} / ${missing.truthUnitsInScope} (per-file cap ${missing.byReason['per-file-cap']}, file not indexed ${missing.byReason['file-not-indexed']}, other ${missing.byReason.other}); ${missing.overloadSplitUnits} split into several records; ${diagnostics.callTargetCapHits[scope]} at the 8-target cap.`,
  ];
}

function moduleEdgeLines(label: string, report: ModuleEdgeReport): string[] {
  return [
    `- [${label}] false edges: ${report.falsePositives.join(', ') || 'none'}; missed: ${report.falseNegatives.map((edge) => edge.edge).join(', ') || 'none'}.`,
    `- [${label}] engine cycles ${JSON.stringify(report.engineCycles)}; truth cycles ${JSON.stringify(report.truthCycles)}; engine cycles that need a false edge ${JSON.stringify(report.falseCycles)}.`,
  ];
}

function diagnosticLines(diagnostics: Diagnostics, relations: Relations, toolQueries: ToolQueries): string[] {
  const composition = diagnostics.engineEdgeComposition;
  return [
    `- Engine call edges from TS/JS symbols: ${composition.edges}; name-match only ${pct(composition.shares.nameMatchOnly)}, cross-language ${pct(composition.shares.crossLanguage)}, production -> test file ${pct(composition.shares.intoTestFromNonTest)}.`,
    ...errorLines(diagnostics, 'sample'),
    ...errorLines(diagnostics, 'population'),
    `- Files at the ${ENGINE_SYMBOLS_PER_FILE_CAP}-symbol cap: ${diagnostics.missingSymbols.population.filesAtCap}.`,
    ...moduleEdgeLines('all files', relations.moduleDependencies.allFiles),
    ...moduleEdgeLines('production files', relations.moduleDependencies.productionFiles),
    `- Definition lines agree for ${pct(diagnostics.definitionLines.population.rate)} of ${diagnostics.definitionLines.population.checked} indexed symbols.`,
    `- Truth call sites by resolution: ${JSON.stringify(diagnostics.truthCallSites)}; JSX element sites not counted as calls: ${diagnostics.truthJsxElementSitesNotCounted}.`,
    `- symbol_context by name (${toolQueries.queried} queries): ${JSON.stringify(toolQueries.outcomes)}; callers on exact matches P ${pct(toolQueries.callersOnExactMatches.precision)} / R ${pct(toolQueries.callersOnExactMatches.recall)}.`,
  ];
}

function renderSummary(meta: Record<string, unknown>, relations: Relations, diagnostics: Diagnostics, toolQueries: ToolQueries): string {
  return [
    '# Repo-intelligence truth bench',
    '',
    '```json',
    JSON.stringify(meta, null, 2),
    '```',
    '',
    '| Relation | Scope (symbols) | Precision | Recall | TP | FP | FN |',
    '|---|---|---|---|---|---|---|',
    ...relationRows('call targets', relations.callTargets),
    ...relationRows('callers (whole index)', relations.callers),
    ...relationRows('callers (8 per record)', relations.callersAt8),
    moduleEdgeRow('all files', relations.moduleDependencies.allFiles),
    moduleEdgeRow('production files', relations.moduleDependencies.productionFiles),
    '',
    ...moduleTable(relations, 'sample'),
    '',
    ...moduleTable(relations, 'population'),
    '',
    '## Diagnostics',
    '',
    ...diagnosticLines(diagnostics, relations, toolQueries),
    '',
  ].join('\n');
}

function safeRemoveTempDir(dir: string): void {
  const root = path.resolve(tmpdir());
  const target = path.resolve(dir);
  if (path.dirname(target) === root && path.basename(target).startsWith('kodax-repointel-truth-')) {
    rmSync(target, { recursive: true, force: true });
  }
}

function writeOutputs(outDir: string, files: Record<string, string>): void {
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(outDir, name), content, 'utf8');
}

function log(message: string): void {
  process.stdout.write(`[truth-bench] ${message}\n`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const memory = startMemorySampler();
  const storageRoot = mkdtempSync(path.join(tmpdir(), 'kodax-repointel-truth-'));
  const started = performance.now();
  try {
    const engineEnv = configureEngineEnv(storageRoot);
    log(`building engine index for ${options.repoRoot}`);
    const engine = await buildEngine(options.repoRoot);
    memory.mark('engine');
    log(`engine: ${engine.view.symbolCount} symbols in ${engine.ms} ms; building TypeScript truth`);
    const truthStart = performance.now();
    const truth = buildTruthIndex(options.repoRoot, options.tsconfigPath);
    const truthMs = Math.round(performance.now() - truthStart);
    memory.mark('truth');
    log(`truth: ${truth.units.size} units in ${truthMs} ms; scoring and querying symbol_context`);
    const set = selectEvaluationSet(truth, options.sampleSize, options.seed);
    const relations = scoreRelations(truth, engine.view, set);
    const diagnostics = scoreDiagnostics(truth, engine.view, set);
    const toolKeys = seededShuffle(set.keys.sample, options.seed + 1).slice(0, options.toolQueries);
    const toolQueries = await runToolQueries(options.repoRoot, toolKeys, truth, engine.view);
    memory.mark('toolQueries');
    const meta = {
      bench: 'repo-intelligence-truth',
      generatedAt: new Date().toISOString(),
      repoRoot: options.repoRoot,
      commit: gitText(options.repoRoot, ['rev-parse', 'HEAD']),
      dirtyFiles: gitText(options.repoRoot, ['status', '--porcelain']).split('\n').filter(Boolean).length,
      node: process.version,
      typescript: ts.version,
      tsconfig: path.relative(options.repoRoot, options.tsconfigPath),
      seed: options.seed,
      scopeSizes: { sample: set.keys.sample.length, pinned: set.keys.pinned.length, population: set.keys.population.length },
      pinnedFiles: set.pinnedFiles,
      engine: { sourceFileCount: engine.view.sourceFileCount, symbols: engine.view.symbolCount, modules: engine.view.modules.length, status: engine.status, workerPath: workerPath(), env: engineEnv },
      truth: { sourceFiles: truth.sourceFiles.length, units: truth.units.size, callEdges: Array.from(truth.callees.values()).reduce((sum, targets) => sum + targets.size, 0) },
      timingMs: { engineColdBuild: engine.ms, truthBuild: truthMs, toolQueries: toolQueries.ms, total: Math.round(performance.now() - started) },
      memory: memory.stop(),
    };
    const summary = renderSummary(meta, relations, diagnostics, toolQueries);
    writeOutputs(options.outDir, {
      'report.json': `${JSON.stringify({ meta, relations, diagnostics, toolQueries }, null, 2)}\n`,
      'details.json': `${JSON.stringify(symbolDetails(truth, engine.view, [...set.keys.sample, ...set.keys.pinned]), null, 2)}\n`,
      'SUMMARY.md': summary,
    });
    process.stdout.write(`${summary}\n`);
    log(`wrote ${options.outDir}`);
  } finally {
    await shutdownWorker();
    safeRemoveTempDir(storageRoot);
  }
}

await main();
