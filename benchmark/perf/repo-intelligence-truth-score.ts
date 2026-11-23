/**
 * Engine-vs-truth scoring for `repo-intelligence-truth.bench.ts`.
 *
 * The engine side reads only the persisted index data model (symbols with
 * `qualifiedName` / `callTargets`, modules with `root` / `dependencies`), so
 * it survives changes to the query and tool surface. Engine records that
 * share a `qualifiedName` (overloads, get/set pairs) collapse into one unit,
 * matching the truth side.
 */
import { isTestFile, type TruthIndex } from './repo-intelligence-truth-oracle.js';

/** Structural subset of `RepoIntelligenceIndex` the bench relies on. */
export interface EngineIndexLike {
  readonly sourceFileCount: number;
  readonly symbols: ReadonlyArray<{
    readonly id: string;
    readonly qualifiedName: string;
    readonly filePath: string;
    readonly language: string;
    readonly line: number;
    readonly confidence: number;
    readonly callTargets: ReadonlyArray<{ readonly symbolId: string; readonly reason: string }>;
  }>;
  readonly modules: ReadonlyArray<{ readonly moduleId: string; readonly root: string; readonly dependencies: readonly string[] }>;
}

export interface EngineModule {
  readonly id: string;
  readonly root: string;
  readonly dependencies: readonly string[];
}

export interface EngineView {
  readonly sourceFileCount: number;
  readonly symbolCount: number;
  readonly modules: EngineModule[];
  /** unit key -> engine record lines (one per overload / accessor record) */
  readonly lines: Map<string, number[]>;
  readonly language: Map<string, string>;
  /** source key -> target key -> reasons the engine gave */
  readonly callees: Map<string, Map<string, Set<string>>>;
  readonly callers: Map<string, Set<string>>;
  /** callers as `collectCallers` shows them: per record, confidence-sorted, first 8; unioned per unit */
  readonly callersAt8: Map<string, Set<string>>;
  /** source keys where a record hit the 8-target cap */
  readonly targetCapHits: Set<string>;
  readonly fileSymbolCounts: Map<string, number>;
}

export interface Metric {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
}

export interface RelationReport {
  readonly symbols: number;
  readonly overall: Metric;
  readonly byModule: Record<string, Metric>;
}

interface Counts { tp: number; fp: number; fn: number }

const TS_LANGUAGES = new Set(['typescript', 'javascript']);
const TOOL_CALLER_LIMIT = 8;

function addToSetMap<V>(map: Map<string, Set<V>>, key: string, value: V): void {
  const bucket = map.get(key) ?? new Set<V>();
  bucket.add(value);
  map.set(key, bucket);
}

export function moduleForFile(filePath: string, modules: readonly EngineModule[]): string {
  const sorted = [...modules].filter((module) => module.root !== '.').sort((a, b) => b.root.length - a.root.length);
  const match = sorted.find((module) => filePath === module.root || filePath.startsWith(`${module.root}/`));
  return match?.id ?? '.';
}

function collectCallersAt8(index: EngineIndexLike, keyById: Map<string, string>): Map<string, Set<string>> {
  const callerRecords = new Map<string, Array<{ key: string; confidence: number }>>();
  for (const symbol of index.symbols) {
    for (const target of symbol.callTargets) {
      const bucket = callerRecords.get(target.symbolId) ?? [];
      bucket.push({ key: symbol.qualifiedName, confidence: symbol.confidence });
      callerRecords.set(target.symbolId, bucket);
    }
  }
  const result = new Map<string, Set<string>>();
  for (const [recordId, callers] of callerRecords) {
    const targetKey = keyById.get(recordId);
    if (!targetKey) continue;
    const visible = callers.sort((a, b) => b.confidence - a.confidence).slice(0, TOOL_CALLER_LIMIT);
    visible.forEach((caller) => { if (caller.key !== targetKey) addToSetMap(result, targetKey, caller.key); });
  }
  return result;
}

export function buildEngineView(index: EngineIndexLike): EngineView {
  const keyById = new Map(index.symbols.map((symbol) => [symbol.id, symbol.qualifiedName]));
  const lines = new Map<string, number[]>();
  const language = new Map<string, string>();
  const callees = new Map<string, Map<string, Set<string>>>();
  const callers = new Map<string, Set<string>>();
  const targetCapHits = new Set<string>();
  const fileSymbolCounts = new Map<string, number>();
  for (const symbol of index.symbols) {
    const key = symbol.qualifiedName;
    lines.set(key, [...(lines.get(key) ?? []), symbol.line]);
    language.set(key, symbol.language);
    fileSymbolCounts.set(symbol.filePath, (fileSymbolCounts.get(symbol.filePath) ?? 0) + 1);
    if (symbol.callTargets.length >= TOOL_CALLER_LIMIT) targetCapHits.add(key);
    const targets = callees.get(key) ?? new Map<string, Set<string>>();
    for (const target of symbol.callTargets) {
      const targetKey = keyById.get(target.symbolId);
      if (!targetKey || targetKey === key) continue;
      addToSetMap(targets, targetKey, target.reason);
      addToSetMap(callers, targetKey, key);
    }
    callees.set(key, targets);
  }
  return {
    sourceFileCount: index.sourceFileCount,
    symbolCount: index.symbols.length,
    modules: index.modules.map((module) => ({ id: module.moduleId, root: module.root, dependencies: [...module.dependencies] })),
    lines,
    language,
    callees,
    callers,
    callersAt8: collectCallersAt8(index, keyById),
    targetCapHits,
    fileSymbolCounts,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10000) / 10000;
}

export function toMetric(counts: Counts): Metric {
  const precision = ratio(counts.tp, counts.tp + counts.fp);
  const recall = ratio(counts.tp, counts.tp + counts.fn);
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? Math.round(((2 * precision * recall) / (precision + recall)) * 10000) / 10000
    : null;
  return { ...counts, precision, recall, f1 };
}

function addCounts(target: Counts, truth: ReadonlySet<string>, predicted: ReadonlySet<string>): void {
  for (const value of predicted) {
    if (truth.has(value)) target.tp += 1;
    else target.fp += 1;
  }
  for (const value of truth) {
    if (!predicted.has(value)) target.fn += 1;
  }
}

export function evaluateRelation(
  keys: readonly string[],
  truthOf: (key: string) => ReadonlySet<string>,
  engineOf: (key: string) => ReadonlySet<string>,
  moduleOf: (key: string) => string,
): RelationReport {
  const overall: Counts = { tp: 0, fp: 0, fn: 0 };
  const byModule = new Map<string, Counts>();
  for (const key of keys) {
    const bucket = byModule.get(moduleOf(key)) ?? { tp: 0, fp: 0, fn: 0 };
    addCounts(overall, truthOf(key), engineOf(key));
    addCounts(bucket, truthOf(key), engineOf(key));
    byModule.set(moduleOf(key), bucket);
  }
  const sortedModules = Array.from(byModule.entries()).sort(([a], [b]) => a.localeCompare(b));
  return {
    symbols: keys.length,
    overall: toMetric(overall),
    byModule: Object.fromEntries(sortedModules.map(([module, counts]) => [module, toMetric(counts)])),
  };
}

export function fileOfKey(key: string): string {
  const separator = key.lastIndexOf(':');
  return separator > 0 ? key.slice(0, separator) : key;
}

export interface EdgeFlags {
  readonly crossLanguage: boolean;
  readonly intoTestFile: boolean;
  readonly nameMatchOnly: boolean;
}

export function edgeFlags(engine: EngineView, source: string, target: string, reasons: ReadonlySet<string>): EdgeFlags {
  const sourceTs = TS_LANGUAGES.has(engine.language.get(source) ?? '');
  const targetTs = TS_LANGUAGES.has(engine.language.get(target) ?? '');
  return {
    crossLanguage: sourceTs !== targetTs,
    intoTestFile: isTestFile(fileOfKey(target)) && !isTestFile(fileOfKey(source)),
    nameMatchOnly: reasons.size === 1 && reasons.has('name-match'),
  };
}

export interface EdgeComposition {
  readonly edges: number;
  readonly byReason: Record<string, number>;
  readonly crossLanguage: number;
  readonly intoTestFromNonTest: number;
  readonly nameMatchOnly: number;
  readonly shares: { crossLanguage: number | null; intoTestFromNonTest: number | null; nameMatchOnly: number | null };
}

/** Composition of every engine call edge whose source is a TS/JS symbol (collapsed to units). */
export function engineEdgeComposition(engine: EngineView): EdgeComposition {
  const byReason: Record<string, number> = {};
  let edges = 0, crossLanguage = 0, intoTest = 0, nameOnly = 0;
  for (const [source, targets] of engine.callees) {
    if (!TS_LANGUAGES.has(engine.language.get(source) ?? '')) continue;
    for (const [target, reasons] of targets) {
      const flags = edgeFlags(engine, source, target, reasons);
      edges += 1;
      reasons.forEach((reason) => { byReason[reason] = (byReason[reason] ?? 0) + 1; });
      crossLanguage += Number(flags.crossLanguage);
      intoTest += Number(flags.intoTestFile);
      nameOnly += Number(flags.nameMatchOnly);
    }
  }
  return {
    edges,
    byReason,
    crossLanguage,
    intoTestFromNonTest: intoTest,
    nameMatchOnly: nameOnly,
    shares: { crossLanguage: ratio(crossLanguage, edges), intoTestFromNonTest: ratio(intoTest, edges), nameMatchOnly: ratio(nameOnly, edges) },
  };
}

export interface CallTargetErrorBreakdown {
  readonly falsePositives: number;
  readonly fpCrossLanguage: number;
  readonly fpIntoTestFile: number;
  readonly fpNameMatchOnly: number;
  readonly fpTargetNotTruthUnit: number;
  readonly precisionByReason: Record<string, Metric>;
  readonly falseNegatives: number;
  readonly fnSourceNotIndexed: number;
  readonly fnTargetNotIndexed: number;
  readonly fnSourceAtTargetCap: number;
  readonly fnOther: number;
}

function reasonKey(reasons: ReadonlySet<string>): string {
  return Array.from(reasons).sort().join('+');
}

/** Explains call-target errors over the evaluated keys. */
export function explainCallTargetErrors(keys: readonly string[], truth: TruthIndex, engine: EngineView): CallTargetErrorBreakdown {
  const out = { falsePositives: 0, fpCrossLanguage: 0, fpIntoTestFile: 0, fpNameMatchOnly: 0, fpTargetNotTruthUnit: 0, falseNegatives: 0, fnSourceNotIndexed: 0, fnTargetNotIndexed: 0, fnSourceAtTargetCap: 0, fnOther: 0 };
  const byReason = new Map<string, Counts>();
  for (const key of keys) {
    const truthTargets = truth.callees.get(key) ?? new Set<string>();
    const engineTargets = engine.callees.get(key) ?? new Map<string, Set<string>>();
    for (const [target, reasons] of engineTargets) {
      const bucket = byReason.get(reasonKey(reasons)) ?? { tp: 0, fp: 0, fn: 0 };
      byReason.set(reasonKey(reasons), bucket);
      if (truthTargets.has(target)) { bucket.tp += 1; continue; }
      bucket.fp += 1;
      const flags = edgeFlags(engine, key, target, reasons);
      out.falsePositives += 1;
      out.fpCrossLanguage += Number(flags.crossLanguage);
      out.fpIntoTestFile += Number(flags.intoTestFile);
      out.fpNameMatchOnly += Number(flags.nameMatchOnly);
      out.fpTargetNotTruthUnit += Number(!truth.units.has(target));
    }
    for (const target of truthTargets) {
      if (engineTargets.has(target)) continue;
      out.falseNegatives += 1;
      if (!engine.lines.has(key)) out.fnSourceNotIndexed += 1;
      else if (!engine.lines.has(target)) out.fnTargetNotIndexed += 1;
      else if (engine.targetCapHits.has(key)) out.fnSourceAtTargetCap += 1;
      else out.fnOther += 1;
    }
  }
  const precisionByReason = Object.fromEntries(Array.from(byReason.entries()).sort().map(([reason, counts]) => [reason, toMetric(counts)]));
  return { ...out, precisionByReason };
}

export interface MissingSymbolReport {
  readonly truthUnitsInScope: number;
  readonly missing: number;
  readonly byReason: Record<'per-file-cap' | 'file-not-indexed' | 'other', number>;
  readonly filesAtCap: number;
  readonly overloadSplitUnits: number;
  readonly examples: string[];
}

export function missingSymbols(keys: readonly string[], truth: TruthIndex, engine: EngineView, capPerFile: number): MissingSymbolReport {
  const byReason = { 'per-file-cap': 0, 'file-not-indexed': 0, other: 0 };
  const missing: string[] = [];
  for (const key of keys) {
    if (engine.lines.has(key)) continue;
    missing.push(key);
    const count = engine.fileSymbolCounts.get(truth.units.get(key)?.filePath ?? '') ?? 0;
    byReason[count >= capPerFile ? 'per-file-cap' : count === 0 ? 'file-not-indexed' : 'other'] += 1;
  }
  const filesAtCap = Array.from(engine.fileSymbolCounts.values()).filter((count) => count >= capPerFile).length;
  const overloadSplitUnits = keys.filter((key) => (engine.lines.get(key)?.length ?? 0) > 1).length;
  return { truthUnitsInScope: keys.length, missing: missing.length, byReason, filesAtCap, overloadSplitUnits, examples: missing.slice(0, 12) };
}

export function definitionLineAgreement(keys: readonly string[], truth: TruthIndex, engine: EngineView): { checked: number; exact: number; rate: number | null } {
  let checked = 0, exact = 0;
  for (const key of keys) {
    const engineLines = engine.lines.get(key);
    const truthLines = truth.units.get(key)?.lines;
    if (!engineLines || !truthLines) continue;
    checked += 1;
    if (engineLines.every((line) => truthLines.includes(line))) exact += 1;
  }
  return { checked, exact, rate: ratio(exact, checked) };
}

/**
 * Truth module edges `A->B` with one example file import as evidence.
 * Imports of untracked build output count only when it belongs to a named
 * module (e.g. `packages/llm/dist/index.d.ts`); root build output such as
 * `dist/kodax_bootstrap.js` is not a source module.
 */
export function truthModuleEdges(
  truth: TruthIndex,
  modules: readonly EngineModule[],
  includeFile: (filePath: string) => boolean,
): Map<string, string> {
  const tracked = new Set(truth.sourceFiles);
  const edges = new Map<string, string>();
  for (const [file, imports] of truth.fileImports) {
    if (!includeFile(file)) continue;
    const from = moduleForFile(file, modules);
    for (const imported of imports) {
      const to = moduleForFile(imported, modules);
      const edge = `${from}->${to}`;
      if (to === '.' && !tracked.has(imported)) continue;
      if (from !== to && !edges.has(edge)) edges.set(edge, `${file} -> ${imported}`);
    }
  }
  return edges;
}

export function engineModuleEdges(modules: readonly EngineModule[]): Set<string> {
  return new Set(modules.flatMap((module) =>
    module.dependencies.filter((dependency) => dependency !== module.id).map((dependency) => `${module.id}->${dependency}`)));
}

/** Tarjan SCCs with more than one node, each sorted, list sorted. */
export function cyclicComponents(edges: ReadonlySet<string>): string[][] {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    const [from, to] = edge.split('->') as [string, string];
    graph.set(from, [...(graph.get(from) ?? []), to]);
    if (!graph.has(to)) graph.set(to, []);
  }
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const connect = (node: string): void => {
    indexOf.set(node, indexOf.size);
    low.set(node, indexOf.get(node)!);
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indexOf.has(next)) connect(next);
      if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, low.get(next)!, indexOf.get(next)!));
    }
    if (low.get(node) !== indexOf.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1) components.push(component.sort());
  };
  Array.from(graph.keys()).sort().forEach((node) => { if (!indexOf.has(node)) connect(node); });
  return components.sort((a, b) => a.join().localeCompare(b.join()));
}

export interface ModuleEdgeReport {
  readonly metric: Metric;
  readonly falsePositives: string[];
  readonly falseNegatives: Array<{ edge: string; evidence: string }>;
  readonly engineCycles: string[][];
  readonly truthCycles: string[][];
  /** engine cycle components that do not survive once the engine's false edges are removed */
  readonly falseCycles: string[][];
  /** truth cycle components the engine graph does not contain */
  readonly missedCycles: string[][];
}

function containedIn(component: string[], others: string[][]): boolean {
  return others.some((other) => component.every((node) => other.includes(node)));
}

function compareEdgeSets(truthEdges: Map<string, string>, engineEdges: Set<string>): ModuleEdgeReport {
  const counts: Counts = { tp: 0, fp: 0, fn: 0 };
  addCounts(counts, new Set(truthEdges.keys()), engineEdges);
  const engineCycles = cyclicComponents(engineEdges);
  const truthCycles = cyclicComponents(new Set(truthEdges.keys()));
  const trueEngineCycles = cyclicComponents(new Set(Array.from(engineEdges).filter((edge) => truthEdges.has(edge))));
  return {
    metric: toMetric(counts),
    falsePositives: Array.from(engineEdges).filter((edge) => !truthEdges.has(edge)).sort(),
    falseNegatives: Array.from(truthEdges.entries())
      .filter(([edge]) => !engineEdges.has(edge))
      .map(([edge, evidence]) => ({ edge, evidence }))
      .sort((a, b) => a.edge.localeCompare(b.edge)),
    engineCycles,
    truthCycles,
    falseCycles: engineCycles.filter((component) => !containedIn(component, trueEngineCycles)),
    missedCycles: truthCycles.filter((component) => !containedIn(component, engineCycles)),
  };
}

/**
 * The engine has one module graph that mixes test and production imports, so
 * it is compared with truth built from all files and from non-test files only.
 * The production view drops engine edges out of modules that contain only
 * test files (e.g. `tests`), since truth has nothing to say about them.
 */
export function compareModuleEdges(truth: TruthIndex, engine: EngineView): { allFiles: ModuleEdgeReport; productionFiles: ModuleEdgeReport } {
  const engineEdges = engineModuleEdges(engine.modules);
  const isProduction = (file: string) => !isTestFile(file);
  const productionModules = new Set(truth.sourceFiles.filter(isProduction).map((file) => moduleForFile(file, engine.modules)));
  const productionEngineEdges = new Set(Array.from(engineEdges).filter((edge) => productionModules.has(edge.split('->')[0]!)));
  return {
    allFiles: compareEdgeSets(truthModuleEdges(truth, engine.modules, () => true), engineEdges),
    productionFiles: compareEdgeSets(truthModuleEdges(truth, engine.modules, isProduction), productionEngineEdges),
  };
}
