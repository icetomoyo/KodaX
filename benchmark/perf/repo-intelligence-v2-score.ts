/**
 * Scoring for the RepoIntel v2 engine against the compiler truth of
 * `repo-intelligence-truth-oracle.ts`. Pure functions, used by
 * `repo-intelligence-v2-truth.bench.ts`.
 *
 * The truth lists top-level functions (including `const f = () => …`),
 * classes with their methods and accessors, interfaces, type aliases and
 * enums. Both engines are scored on that same set: anything else they find
 * (variables, nested functions, interface members) is counted, not scored.
 */
import ts from 'typescript';
import { toMetric, type Metric } from './repo-intelligence-truth-score.js';

export interface V2Definition {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly container: string | null;
  readonly line: number;
  readonly endLine?: number;
}

export interface DefinitionKeys {
  /** Truth-style key -> the lines the engine gives for it. */
  readonly lines: Map<string, number[]>;
  /** What the engine found that the truth does not list, by kind. */
  readonly notComparable: Record<string, number>;
}

const TOP_LEVEL_KINDS = new Set(['function', 'class', 'interface', 'type', 'enum']);
/** Kinds whose body can hold a call; the truth credits a call to each of them around it. */
const BODY_KINDS = new Set(['function', 'class', 'method']);
/** Reference kinds the truth counts as calls: a call and a `new`. */
const CALL_REFERENCE_KINDS = new Set(['call', 'class']);

function addLine(lines: Map<string, number[]>, key: string, line: number): void {
  lines.set(key, [...(lines.get(key) ?? []), line]);
}

function count(tally: Record<string, number>, label: string): void {
  tally[label] = (tally[label] ?? 0) + 1;
}

function topLevelClasses(definitions: readonly V2Definition[]): Set<string> {
  return new Set(definitions.filter((d) => d.kind === 'class' && d.container === null).map((d) => d.name));
}

/** The truth key of a v2 definition, or why the truth does not list it. */
function v2Key(definition: V2Definition, classes: ReadonlySet<string>): { key: string } | { skip: string } {
  if (definition.container === null) {
    return TOP_LEVEL_KINDS.has(definition.kind) ? { key: `${definition.path}:${definition.name}` } : { skip: definition.kind };
  }
  if (definition.kind === 'method') {
    return classes.has(definition.container)
      ? { key: `${definition.path}:${definition.container}.${definition.name}` }
      : { skip: 'method in interface' };
  }
  return { skip: `nested ${definition.kind}` };
}

export function v2DefinitionKeys(outlines: ReadonlyMap<string, readonly V2Definition[]>): DefinitionKeys {
  const lines = new Map<string, number[]>();
  const notComparable: Record<string, number> = {};
  for (const definitions of outlines.values()) {
    const classes = topLevelClasses(definitions);
    for (const definition of definitions) {
      const mapped = v2Key(definition, classes);
      if ('key' in mapped) addLine(lines, mapped.key, definition.line);
      else count(notComparable, mapped.skip);
    }
  }
  return { lines, notComparable };
}

export interface OldSymbol {
  readonly qualifiedName: string;
  readonly kind: string;
  readonly line: number;
  readonly filePath: string;
}

/** The old engine's symbols in `files`, keyed and filtered the same way as v2's. */
export function oldDefinitionKeys(symbols: readonly OldSymbol[], files: ReadonlySet<string>): DefinitionKeys {
  const inScope = symbols.filter((symbol) => files.has(symbol.filePath));
  const classes = new Set(inScope.filter((symbol) => symbol.kind === 'class').map((symbol) => symbol.qualifiedName));
  const lines = new Map<string, number[]>();
  const notComparable: Record<string, number> = {};
  for (const symbol of inScope) {
    const local = symbol.qualifiedName.slice(symbol.filePath.length + 1);
    const dot = local.lastIndexOf('.');
    if (TOP_LEVEL_KINDS.has(symbol.kind) && dot < 0) addLine(lines, symbol.qualifiedName, symbol.line);
    else if (symbol.kind === 'method' && dot > 0 && classes.has(`${symbol.filePath}:${local.slice(0, dot)}`)) addLine(lines, symbol.qualifiedName, symbol.line);
    else count(notComparable, symbol.kind === 'method' ? 'method outside a class' : symbol.kind);
  }
  return { lines, notComparable };
}

export interface DefinitionScore {
  readonly metric: Metric;
  readonly recallByKind: Record<string, Metric>;
  /** Matches where one of the engine's lines is one of the truth's declaration lines. */
  readonly lineAgreement: { readonly checked: number; readonly agree: number; readonly rate: number | null };
  readonly falsePositives: string[];
  readonly falseNegatives: string[];
}

export function scoreDefinitions(
  truth: ReadonlyMap<string, { readonly kind: string; readonly lines: readonly number[] }>,
  engine: DefinitionKeys,
): DefinitionScore {
  const byKind: Record<string, { tp: number; fp: number; fn: number }> = {};
  const falseNegatives: string[] = [];
  let tp = 0;
  let agree = 0;
  for (const [key, unit] of truth) {
    const counts = (byKind[unit.kind] ??= { tp: 0, fp: 0, fn: 0 });
    const lines = engine.lines.get(key);
    if (!lines) {
      counts.fn += 1;
      falseNegatives.push(key);
      continue;
    }
    counts.tp += 1;
    tp += 1;
    if (lines.some((line) => unit.lines.includes(line))) agree += 1;
  }
  const falsePositives = [...engine.lines.keys()].filter((key) => !truth.has(key));
  const recallByKind = Object.fromEntries(Object.entries(byKind).map(([kind, counts]) => [kind, toMetric(counts)]));
  return {
    metric: toMetric({ tp, fp: falsePositives.length, fn: falseNegatives.length }),
    recallByKind,
    lineAgreement: { checked: tp, agree, rate: tp === 0 ? null : agree / tp },
    falsePositives: falsePositives.sort(),
    falseNegatives: falseNegatives.sort(),
  };
}

/**
 * Why an engine key the truth does not list is there. The truth keeps to
 * top-level units, so a real declaration in a local scope (a helper in a
 * test callback, a member of an object literal or of a class inside a
 * function) is right for an engine that reports every scope; only a wrong
 * container or a line that declares nothing is an engine error.
 */
export type ExtraDefinitionClass =
  | 'local declaration'
  | 'member the truth leaves out'
  | 'wrong container'
  | 'no declaration on that line';

const DECLARATION_TESTS: ReadonlyArray<(node: ts.Node) => boolean> = [
  ts.isFunctionDeclaration, ts.isFunctionExpression, ts.isClassDeclaration, ts.isClassExpression,
  ts.isMethodDeclaration, ts.isGetAccessorDeclaration, ts.isSetAccessorDeclaration, ts.isPropertyDeclaration,
  ts.isPropertyAssignment, ts.isShorthandPropertyAssignment, ts.isVariableDeclaration, ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration, ts.isEnumDeclaration, ts.isMethodSignature, ts.isPropertySignature, ts.isModuleDeclaration,
];

function declarationName(node: ts.Node): string | undefined {
  if (!DECLARATION_TESTS.some((test) => test(node))) return undefined;
  const name = (node as ts.NamedDeclaration).name;
  return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

function declarationsOnLines(source: ts.SourceFile, name: string, lines: readonly number[]): ts.Node[] {
  const lineOf = (position: number): number => source.getLineAndCharacterOfPosition(position).line + 1;
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (declarationName(node) === name) {
      const nameNode = (node as ts.NamedDeclaration).name;
      const candidates = [lineOf(node.getStart(source)), nameNode ? lineOf(nameNode.getStart(source)) : 0];
      if (candidates.some((line) => lines.includes(line))) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Classifies an engine key in `source` that the truth does not list; see {@link ExtraDefinitionClass}. */
export function classifyExtraDefinition(source: ts.SourceFile, key: string, lines: readonly number[]): ExtraDefinitionClass {
  const local = key.slice(source.fileName.length + 1);
  const dot = local.lastIndexOf('.');
  const container = dot > 0 ? local.slice(0, dot) : undefined;
  const declarations = declarationsOnLines(source, local.slice(dot + 1), lines);
  if (declarations.length === 0) return 'no declaration on that line';
  if (container === undefined) return 'local declaration';
  const member = declarations.find((node) => ts.isClassLike(node.parent) && node.parent.name?.text === container);
  if (!member) return 'wrong container';
  return ts.isSourceFile(member.parent.parent) ? 'member the truth leaves out' : 'local declaration';
}

export interface ReferenceSite {
  readonly path: string;
  readonly line: number;
  readonly kind: string;
}

export interface CallerResult {
  readonly callers: Set<string>;
  /** Calls in top-level code, which the truth credits to no unit. */
  readonly outsideUnits: number;
  /** Calls in files the truth does not cover; each such file counts as one wrong caller. */
  readonly outsideTruthFiles: number;
}

function enclosingUnits(definitions: readonly V2Definition[], line: number): string[] {
  const classes = topLevelClasses(definitions);
  return definitions
    .filter((d) => BODY_KINDS.has(d.kind) && d.line <= line && line <= (d.endLine ?? d.line))
    .map((d) => v2Key(d, classes))
    .flatMap((mapped) => ('key' in mapped ? [mapped.key] : []));
}

/** Callers as a name-matching engine sees them: the units around each call or `new` of the name. */
export function callersFromReferences(
  references: readonly ReferenceSite[],
  outlines: ReadonlyMap<string, readonly V2Definition[]>,
  selfKey: string,
): CallerResult {
  const callers = new Set<string>();
  let outsideUnits = 0;
  let outsideTruthFiles = 0;
  for (const reference of references) {
    if (!CALL_REFERENCE_KINDS.has(reference.kind)) continue;
    const definitions = outlines.get(reference.path);
    if (!definitions) {
      outsideTruthFiles += 1;
      callers.add(`${reference.path}:*`);
      continue;
    }
    const units = enclosingUnits(definitions, reference.line);
    if (units.length === 0) outsideUnits += 1;
    for (const unit of units) if (unit !== selfKey) callers.add(unit);
  }
  return { callers, outsideUnits, outsideTruthFiles };
}
