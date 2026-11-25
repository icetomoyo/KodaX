/**
 * Ground truth for the repo-intelligence truth bench, built with the
 * TypeScript compiler. Used only by `repo-intelligence-truth.bench.ts`.
 *
 * Symbol granularity mirrors the old engine's TypeScript analyzer so the
 * comparison measures resolution errors, not a different definition of
 * "symbol": top-level functions, top-level `const x = () => …` /
 * function-expression variables, classes, class methods and accessors,
 * interfaces, type aliases and enums. A unit's key is the engine's
 * `qualifiedName` (`<file>:<Name>` or `<file>:<Class>.<member>`); overloads
 * and get/set pairs collapse into one unit. Unlike the engine there is no
 * per-file cap.
 *
 * A call edge U -> T exists when a call or `new` expression inside U's body
 * resolves (through import aliases, via `getAliasedSymbol`) to a declaration
 * of unit T. Module resolution uses the repo's tsconfig plus `paths` that map
 * every workspace package export to its source file, so `.js` specifiers and
 * cross-package imports land on `.ts` source the way tsc resolves them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type UnitKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum';

export interface TruthUnit {
  readonly key: string;
  readonly filePath: string;
  readonly name: string;
  readonly kind: UnitKind;
  readonly lines: number[];
  readonly exported: boolean;
}

/** Where a call site's callee resolved to. Only `unit` sites become edges. */
export type CallSiteOutcome =
  | 'unit'
  | 'interface-or-type-member'
  | 'class-property'
  | 'local-or-nested'
  | 'workspace-dist'
  | 'external'
  | 'unresolved';

export interface TruthIndex {
  readonly tsconfigPath: string;
  readonly sourceFiles: string[];
  readonly units: Map<string, TruthUnit>;
  readonly callees: Map<string, Set<string>>;
  readonly callers: Map<string, Set<string>>;
  /** Repo-relative file -> repo-relative files it imports (static, dynamic, require). */
  readonly fileImports: Map<string, Set<string>>;
  readonly callSites: Record<CallSiteOutcome, number>;
  /** JSX element sites whose tag resolves to a unit; not counted as calls (the engine ignores JSX). */
  readonly jsxElementSites: number;
}

interface OracleContext {
  readonly repoRoot: string;
  readonly fileSet: Set<string>;
  readonly checker: ts.TypeChecker;
  readonly units: Map<string, TruthUnit>;
  readonly bodies: Map<string, ts.Node[]>;
  readonly siteCache: Map<ts.Node, string[]>;
  readonly jsxSites: Set<ts.Node>;
  readonly callSites: Record<CallSiteOutcome, number>;
}

const SOURCE_FILE_PATTERN = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

export function isTestFile(filePath: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(filePath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

export function isTypeScriptSource(filePath: string): boolean {
  return /\.(ts|tsx|mts|cts)$/.test(filePath) && !filePath.endsWith('.d.ts');
}

function toRepoPath(repoRoot: string, fileName: string): string | undefined {
  const relative = path.relative(repoRoot, fileName).split(path.sep).join('/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative;
}

export function listSourceFiles(repoRoot: string): string[] {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return output
    .split('\0')
    .filter((file) => SOURCE_FILE_PATTERN.test(file) && !file.includes('node_modules/'))
    .filter((file) => existsSync(path.join(repoRoot, file)))
    .sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  return isRecord(parsed) ? parsed : {};
}

function workspacePackageDirs(repoRoot: string): string[] {
  const manifest = readJsonRecord(path.join(repoRoot, 'package.json'));
  const raw = manifest.workspaces;
  const patterns = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.packages) ? raw.packages : [];
  const dirs = [repoRoot];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    if (!pattern.endsWith('/*')) {
      dirs.push(path.join(repoRoot, pattern));
      continue;
    }
    const parent = path.join(repoRoot, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(parent, entry.name));
    }
  }
  return dirs.filter((dir) => existsSync(path.join(dir, 'package.json')));
}

function exportTargets(manifest: Record<string, unknown>): Array<[string, string]> {
  const exportsField = manifest.exports;
  if (!isRecord(exportsField)) {
    return typeof manifest.types === 'string' ? [['.', manifest.types]] : [];
  }
  const targets: Array<[string, string]> = [];
  for (const [subpath, value] of Object.entries(exportsField)) {
    const target = typeof value === 'string'
      ? value
      : isRecord(value) ? value.types ?? value.import ?? value.default : undefined;
    if (subpath.startsWith('.') && typeof target === 'string') targets.push([subpath, target]);
  }
  return targets;
}

/** Maps `./dist/x.d.ts` (or `.js`) to the `src/x.ts(x)` file it was built from. */
function sourceForBuildOutput(packageDir: string, target: string): string | undefined {
  const stem = target.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/(\.d\.ts|\.js)$/, '');
  const candidates = [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`];
  return candidates.map((candidate) => path.join(packageDir, candidate)).find((file) => existsSync(file));
}

function workspaceSourcePaths(repoRoot: string): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const dir of workspacePackageDirs(repoRoot)) {
    const manifest = readJsonRecord(path.join(dir, 'package.json'));
    if (typeof manifest.name !== 'string') continue;
    for (const [subpath, target] of exportTargets(manifest)) {
      const source = sourceForBuildOutput(dir, target);
      if (!source) continue;
      const specifier = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
      paths[specifier] = [source.split(path.sep).join('/')];
    }
  }
  return paths;
}

function loadCompilerOptions(repoRoot: string, tsconfigPath: string): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error(`Cannot parse ${tsconfigPath}`);
  return {
    ...parsed.options,
    noEmit: true,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    composite: false,
    declaration: false,
    declarationMap: false,
    incremental: false,
    sourceMap: false,
    tsBuildInfoFile: undefined,
    rootDir: undefined,
    outDir: undefined,
    paths: { ...workspaceSourcePaths(repoRoot), ...(parsed.options.paths ?? {}) },
  };
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return Boolean(ts.getModifiers(node)?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function isFunctionInitializer(node: ts.Expression | undefined): boolean {
  return Boolean(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)));
}

function addUnit(
  ctx: OracleContext,
  unit: Omit<TruthUnit, 'lines'>,
  declaration: ts.Node,
  body: ts.Node | undefined,
): void {
  const sourceFile = declaration.getSourceFile();
  const line = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1;
  const existing = ctx.units.get(unit.key);
  if (existing) {
    existing.lines.push(line);
  } else {
    ctx.units.set(unit.key, { ...unit, lines: [line] });
  }
  if (body) ctx.bodies.set(unit.key, [...(ctx.bodies.get(unit.key) ?? []), body]);
}

function collectClassUnits(ctx: OracleContext, filePath: string, statement: ts.ClassDeclaration): void {
  const className = statement.name?.text;
  if (!className) return;
  const exported = hasExportModifier(statement);
  addUnit(ctx, { key: `${filePath}:${className}`, filePath, name: className, kind: 'class', exported }, statement, statement);
  for (const member of statement.members) {
    const isMethodLike = ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member);
    const name = isMethodLike ? propertyNameText(member.name) : undefined;
    if (!isMethodLike || !name) continue;
    const key = `${filePath}:${className}.${name}`;
    addUnit(ctx, { key, filePath, name, kind: 'method', exported }, member, member.body);
  }
}

function collectStatementUnits(ctx: OracleContext, filePath: string, statement: ts.Statement): void {
  const unit = (name: string, kind: UnitKind, exported: boolean) => ({ key: `${filePath}:${name}`, filePath, name, kind, exported });
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    addUnit(ctx, unit(statement.name.text, 'function', hasExportModifier(statement)), statement, statement.body);
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      const name = propertyNameText(declaration.name);
      if (!name || !isFunctionInitializer(declaration.initializer)) continue;
      addUnit(ctx, unit(name, 'function', hasExportModifier(statement)), declaration, declaration.initializer);
    }
  } else if (ts.isClassDeclaration(statement)) {
    collectClassUnits(ctx, filePath, statement);
  } else if (ts.isInterfaceDeclaration(statement)) {
    addUnit(ctx, unit(statement.name.text, 'interface', hasExportModifier(statement)), statement, undefined);
  } else if (ts.isTypeAliasDeclaration(statement)) {
    addUnit(ctx, unit(statement.name.text, 'type', hasExportModifier(statement)), statement, undefined);
  } else if (ts.isEnumDeclaration(statement)) {
    addUnit(ctx, unit(statement.name.text, 'enum', hasExportModifier(statement)), statement, undefined);
  }
}

/** Engine-style unit key for a declaration, or undefined when the engine would not index it. */
function unitKeyForDeclaration(filePath: string, declaration: ts.Declaration): string | undefined {
  const parent = declaration.parent;
  if ((ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) && declaration.name && ts.isSourceFile(parent)) {
    return `${filePath}:${declaration.name.text}`;
  }
  const isMethodLike = ts.isMethodDeclaration(declaration) || ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration);
  if (isMethodLike && ts.isClassDeclaration(parent) && parent.name && ts.isSourceFile(parent.parent)) {
    const name = propertyNameText(declaration.name);
    return name ? `${filePath}:${parent.name.text}.${name}` : undefined;
  }
  if (ts.isVariableDeclaration(declaration) && ts.isVariableStatement(declaration.parent.parent)) {
    const name = propertyNameText(declaration.name);
    return name && ts.isSourceFile(declaration.parent.parent.parent) ? `${filePath}:${name}` : undefined;
  }
  return undefined;
}

function classifyDeclaration(ctx: OracleContext, declaration: ts.Declaration): { key?: string; outcome: CallSiteOutcome } {
  const filePath = toRepoPath(ctx.repoRoot, declaration.getSourceFile().fileName);
  if (!filePath || filePath.includes('node_modules/')) return { outcome: 'external' };
  if (!ctx.fileSet.has(filePath)) return { outcome: /(^|\/)dist\//.test(filePath) ? 'workspace-dist' : 'external' };
  const key = unitKeyForDeclaration(filePath, declaration);
  if (key && ctx.units.has(key)) return { key, outcome: 'unit' };
  if (
    ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration)
    || ts.isCallSignatureDeclaration(declaration) || ts.isConstructSignatureDeclaration(declaration)
  ) {
    return { outcome: 'interface-or-type-member' };
  }
  if (ts.isPropertyDeclaration(declaration)) return { outcome: 'class-property' };
  return { outcome: 'local-or-nested' };
}

function unwrapCallee(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)
    || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolveSymbol(checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol | undefined {
  const callee = unwrapCallee(expression);
  const location = ts.isPropertyAccessExpression(callee)
    ? callee.name
    : ts.isElementAccessExpression(callee) ? callee.argumentExpression : callee;
  const symbol = checker.getSymbolAtLocation(location);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Resolves one call/new/JSX site to unit keys; each site is resolved and counted once. */
function resolveSite(ctx: OracleContext, node: ts.Node, expression: ts.Expression, countSite: boolean): string[] {
  const cached = ctx.siteCache.get(node);
  if (cached) return cached;
  const keys = new Set<string>();
  let fallback: CallSiteOutcome = 'unresolved';
  for (const declaration of resolveSymbol(ctx.checker, expression)?.declarations ?? []) {
    const resolved = classifyDeclaration(ctx, declaration);
    if (resolved.key) keys.add(resolved.key);
    else if (fallback === 'unresolved') fallback = resolved.outcome;
  }
  if (countSite) ctx.callSites[keys.size > 0 ? 'unit' : fallback] += 1;
  const result = Array.from(keys);
  ctx.siteCache.set(node, result);
  return result;
}

function collectCallees(ctx: OracleContext, key: string, bodies: ts.Node[]): Set<string> {
  const callees = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const kind = node.expression.kind;
      if (kind !== ts.SyntaxKind.SuperKeyword && kind !== ts.SyntaxKind.ImportKeyword) {
        for (const target of resolveSite(ctx, node, node.expression, true)) {
          if (target !== key) callees.add(target);
        }
      }
    } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (ts.isIdentifier(node.tagName) && resolveSite(ctx, node, node.tagName, false).length > 0) {
        ctx.jsxSites.add(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  bodies.forEach(visit);
  return callees;
}

function importSpecifiers(sourceFile: ts.SourceFile): ts.StringLiteralLike[] {
  const specifiers: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      specifiers.push(node.argument.literal);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (ts.isStringLiteralLike(expression)) specifiers.push(expression);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) specifiers.push(node.arguments[0]!);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function collectFileImports(
  repoRoot: string,
  sourceFile: ts.SourceFile,
  options: ts.CompilerOptions,
  cache: ts.ModuleResolutionCache,
): Set<string> {
  const imported = new Set<string>();
  for (const specifier of importSpecifiers(sourceFile)) {
    const mode = ts.getModeForUsageLocation(sourceFile, specifier, options);
    const resolved = ts.resolveModuleName(specifier.text, sourceFile.fileName, options, ts.sys, cache, undefined, mode).resolvedModule;
    const target = resolved ? toRepoPath(repoRoot, resolved.resolvedFileName) : undefined;
    if (target && !target.includes('node_modules/') && !target.endsWith('.json')) imported.add(target);
  }
  return imported;
}

function invert(callees: Map<string, Set<string>>): Map<string, Set<string>> {
  const callers = new Map<string, Set<string>>();
  for (const [source, targets] of callees) {
    for (const target of targets) {
      const bucket = callers.get(target) ?? new Set<string>();
      bucket.add(source);
      callers.set(target, bucket);
    }
  }
  return callers;
}

function emptyCallSites(): Record<CallSiteOutcome, number> {
  return {
    unit: 0,
    'interface-or-type-member': 0,
    'class-property': 0,
    'local-or-nested': 0,
    'workspace-dist': 0,
    external: 0,
    unresolved: 0,
  };
}

export function buildTruthIndex(repoRoot: string, tsconfigPath: string): TruthIndex {
  const sourceFiles = listSourceFiles(repoRoot);
  const options = loadCompilerOptions(repoRoot, tsconfigPath);
  const program = ts.createProgram(sourceFiles.map((file) => path.join(repoRoot, file)), options);
  const ctx: OracleContext = {
    repoRoot,
    fileSet: new Set(sourceFiles),
    checker: program.getTypeChecker(),
    units: new Map(),
    bodies: new Map(),
    siteCache: new Map(),
    jsxSites: new Set(),
    callSites: emptyCallSites(),
  };
  const parsedFiles = sourceFiles.flatMap((filePath) => {
    const sourceFile = program.getSourceFile(path.join(repoRoot, filePath));
    return sourceFile ? [{ filePath, sourceFile }] : [];
  });
  for (const { filePath, sourceFile } of parsedFiles) {
    sourceFile.statements.forEach((statement) => collectStatementUnits(ctx, filePath, statement));
  }
  const callees = new Map<string, Set<string>>();
  for (const key of ctx.units.keys()) callees.set(key, collectCallees(ctx, key, ctx.bodies.get(key) ?? []));
  const cache = ts.createModuleResolutionCache(repoRoot, (fileName) => fileName.toLowerCase(), options);
  const fileImports = new Map<string, Set<string>>();
  for (const { filePath, sourceFile } of parsedFiles) {
    fileImports.set(filePath, collectFileImports(repoRoot, sourceFile, options, cache));
  }
  return {
    tsconfigPath,
    sourceFiles,
    units: ctx.units,
    callees,
    callers: invert(callees),
    fileImports,
    callSites: ctx.callSites,
    jsxElementSites: ctx.jsxSites.size,
  };
}
