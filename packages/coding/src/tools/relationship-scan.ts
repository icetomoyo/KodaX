import fs from 'node:fs/promises';
import path from 'node:path';
import type { KodaXToolExecutionContext } from '../types.js';
import type {
  ImpactEstimateResult,
  ModuleCapsule,
  ModuleContextResult,
  ProcessContextResult,
  RepoSymbolRecord,
  SymbolContextResult,
} from '../repo-intelligence/semantic-types.js';
import {
  getImpactEstimate,
  getModuleContext,
  getProcessContext,
  getSymbolContext,
  readRepoIntelligenceToolWaitMs,
} from '../repo-intelligence/runtime.js';
import { readOptionalString } from './internal.js';
import { toolGrep } from './grep.js';

type RelationshipDirection = 'upstream' | 'downstream' | 'both';

interface RelationshipParts {
  moduleContext?: ModuleContextResult;
  symbolContext?: SymbolContextResult;
  processContext?: ProcessContextResult;
  impactEstimate?: ImpactEstimateResult;
}

interface SupplementalEvidence {
  readonly label: string;
  readonly output: string;
}

interface SymbolLocation {
  readonly filePath: string;
  readonly workspaceRoot?: string;
  readonly line: number;
  readonly column: number;
}

const MAX_ROOT_ASCENT = 3;

function readDirection(value: unknown): RelationshipDirection {
  return value === 'upstream' || value === 'downstream' || value === 'both'
    ? value
    : 'both';
}

function readDepth(value: unknown): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function capture<T>(
  label: string,
  gaps: string[],
  load: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    gaps.push(`${label}: ${errorMessage(error)}`);
    return undefined;
  }
}

function recordCapabilityGap(
  label: string,
  result: ModuleContextResult | SymbolContextResult | ProcessContextResult | ImpactEstimateResult | undefined,
  gaps: string[],
): boolean {
  const capability = result?.capability;
  if (!capability) return false;
  const warning = capability.warnings.join(' ');
  if (warning || capability.status !== 'ok') {
    gaps.push(`${label}: ${warning || `repo-intelligence ${capability.status}; validate with read, grep, glob or LSP and retry when available.`}`);
  }
  return capability.status === 'warming';
}

function symbolRef(symbol: RepoSymbolRecord): string {
  return `${symbol.name} (${symbol.filePath}:${symbol.line})`;
}

function moduleRef(module: ModuleCapsule): string {
  return `${module.label} (${module.root})`;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function candidateRoots(ctx: KodaXToolExecutionContext): string[] {
  const roots: string[] = [];
  if (ctx.gitRoot) roots.push(ctx.gitRoot);
  if (ctx.executionCwd) roots.push(ctx.executionCwd);
  roots.push(process.cwd());

  const expanded = new Set<string>();
  for (const root of roots) {
    let current = path.resolve(root);
    for (let depth = 0; depth <= MAX_ROOT_ASCENT && !expanded.has(current); depth += 1) {
      expanded.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...expanded];
}

function inferWorkspaceRoot(absoluteFilePath: string, repoRelativePath: string): string | undefined {
  const normalizedRelative = path.normalize(repoRelativePath);
  if (!normalizedRelative || path.isAbsolute(normalizedRelative)) return undefined;
  const normalizedAbsolute = path.normalize(absoluteFilePath);
  if (!normalizedAbsolute.endsWith(normalizedRelative)) return undefined;
  const root = normalizedAbsolute.slice(0, normalizedAbsolute.length - normalizedRelative.length);
  return root ? path.resolve(root) : undefined;
}

async function resolveRepoFilePath(
  repoPath: string,
  ctx: KodaXToolExecutionContext,
): Promise<{ filePath: string; workspaceRoot?: string } | undefined> {
  if (path.isAbsolute(repoPath)) {
    const resolved = path.resolve(repoPath);
    return await isFile(resolved) ? { filePath: resolved } : undefined;
  }

  for (const root of candidateRoots(ctx)) {
    const candidate = path.resolve(root, repoPath);
    if (await isFile(candidate)) {
      return {
        filePath: candidate,
        workspaceRoot: inferWorkspaceRoot(candidate, repoPath) ?? root,
      };
    }
  }
  return undefined;
}

async function resolveExistingPath(
  requestedPath: string,
  ctx: KodaXToolExecutionContext,
): Promise<string | undefined> {
  if (path.isAbsolute(requestedPath)) {
    const resolved = path.resolve(requestedPath);
    try {
      await fs.stat(resolved);
      return resolved;
    } catch {
      return undefined;
    }
  }

  for (const root of candidateRoots(ctx)) {
    const candidate = path.resolve(root, requestedPath);
    try {
      await fs.stat(candidate);
      return candidate;
    } catch {
      // Keep probing likely repo roots.
    }
  }
  return undefined;
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

function locateSymbolLineColumn(
  content: string,
  preferredLine: number,
  names: readonly string[],
): { line: number; column: number } {
  const lines = content.split(/\r?\n/);
  const preferredIndex = Math.max(0, Math.min(lines.length - 1, preferredLine - 1));
  const candidateIndexes = uniqueStrings([
    String(preferredIndex),
    String(preferredIndex - 1),
    String(preferredIndex + 1),
    String(preferredIndex - 2),
    String(preferredIndex + 2),
    String(preferredIndex - 3),
    String(preferredIndex + 3),
  ])
    .map((value) => Number(value))
    .filter((value) => value >= 0 && value < lines.length);

  for (const index of candidateIndexes) {
    const lineText = lines[index] ?? '';
    for (const name of names) {
      const columnIndex = lineText.indexOf(name);
      if (columnIndex >= 0) {
        return { line: index + 1, column: columnIndex + 1 };
      }
    }
  }
  return { line: preferredIndex + 1, column: 1 };
}

async function locateSymbol(
  symbol: RepoSymbolRecord,
  ctx: KodaXToolExecutionContext,
): Promise<SymbolLocation | undefined> {
  const resolved = await resolveRepoFilePath(symbol.filePath, ctx);
  if (!resolved) return undefined;
  const content = await fs.readFile(resolved.filePath, 'utf8');
  const names = uniqueStrings([
    symbol.name,
    symbol.qualifiedName.split('.').at(-1),
  ]);
  const position = locateSymbolLineColumn(content, symbol.line, names);
  return {
    filePath: resolved.filePath,
    workspaceRoot: resolved.workspaceRoot,
    line: position.line,
    column: position.column,
  };
}

function navRequest(ctx: KodaXToolExecutionContext): {
  gitRoot?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
} {
  return { gitRoot: ctx.gitRoot, signal: ctx.abortSignal, onProgress: ctx.reportToolProgress };
}

async function buildLspEvidence(
  parts: RelationshipParts,
  direction: RelationshipDirection,
  ctx: KodaXToolExecutionContext,
  gaps: string[],
): Promise<SupplementalEvidence[]> {
  if (!parts.symbolContext) {
    gaps.push('LSP validation: symbol identity is required for call hierarchy expansion.');
    return [];
  }
  if (!ctx.lspService) {
    gaps.push('LSP validation: LSP service is unavailable in this runtime.');
    return [];
  }

  const location = await locateSymbol(parts.symbolContext.symbol, ctx);
  if (!location) {
    gaps.push(`LSP validation: source file not found for ${parts.symbolContext.symbol.filePath}.`);
    return [];
  }

  const position = { line: location.line - 1, character: location.column - 1 };
  const request = { ...navRequest(ctx), gitRoot: ctx.gitRoot ?? location.workspaceRoot };
  const evidence: SupplementalEvidence[] = [];

  if (direction === 'upstream' || direction === 'both') {
    const output = await ctx.lspService.getIncomingCalls(location.filePath, position, request);
    evidence.push({
      label: `lsp_incoming_calls at ${parts.symbolContext.symbol.filePath}:${location.line}:${location.column}`,
      output,
    });
  }
  if (direction === 'downstream' || direction === 'both') {
    const output = await ctx.lspService.getOutgoingCalls(location.filePath, position, request);
    evidence.push({
      label: `lsp_outgoing_calls at ${parts.symbolContext.symbol.filePath}:${location.line}:${location.column}`,
      output,
    });
  }

  return evidence;
}

function escapeRegexPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstEvidenceTarget(
  parts: RelationshipParts,
  symbolTarget: string | undefined,
  moduleName: string | undefined,
  filePath: string | undefined,
  entry: string | undefined,
): string | undefined {
  return parts.symbolContext?.symbol.name
    ?? symbolTarget
    ?? moduleName
    ?? entry
    ?? (filePath ? path.basename(filePath) : undefined);
}

async function buildTextSearchEvidence(
  parts: RelationshipParts,
  symbolTarget: string | undefined,
  moduleName: string | undefined,
  filePath: string | undefined,
  entry: string | undefined,
  targetPath: string | undefined,
  ctx: KodaXToolExecutionContext,
  gaps: string[],
): Promise<SupplementalEvidence[]> {
  const target = firstEvidenceTarget(parts, symbolTarget, moduleName, filePath, entry);
  if (!target?.trim()) {
    gaps.push('Text-search validation: no searchable target was available.');
    return [];
  }
  if (target.length > 128) {
    gaps.push('Text-search validation: target is too long for a bounded exact-name search.');
    return [];
  }

  const symbolLocation = parts.symbolContext
    ? await locateSymbol(parts.symbolContext.symbol, ctx)
    : undefined;
  const requestedSearchPath = targetPath
    ?? symbolLocation?.workspaceRoot
    ?? ctx.gitRoot
    ?? parts.moduleContext?.module.root
    ?? filePath
    ?? '.';
  const searchPath = await resolveExistingPath(requestedSearchPath, ctx) ?? requestedSearchPath;
  const output = await toolGrep({
    pattern: escapeRegexPattern(target),
    path: searchPath,
    output_mode: 'content',
    head_limit: 16,
  }, ctx);
  return [{ label: `grep exact-name evidence for "${target}"`, output }];
}

function pushList(lines: string[], emptyLabel: string, values: readonly string[]): void {
  if (values.length === 0) {
    lines.push(`- ${emptyLabel}`);
    return;
  }
  for (const value of values) {
    lines.push(`- ${value}`);
  }
}

function edgeSource(): string {
  return 'semantic-index';
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function edgeConfidence(
  values: readonly (number | undefined)[],
): string {
  const numbers = values.filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value));
  if (numbers.length === 0) return 'unknown';
  return clampConfidence(Math.min(...numbers)).toFixed(2);
}

function edgeMeta(
  source: string,
  confidence: string,
  evidence: string,
): string {
  return `[source=${source} confidence=${confidence} evidence=${evidence}]`;
}

function symbolEvidence(symbol: RepoSymbolRecord): string {
  return `${symbol.filePath}:${symbol.line}`;
}

function referenceEvidence(
  parts: RelationshipParts,
  target: { readonly symbolId: string; readonly name: string; readonly filePath: string },
): string {
  const matched = parts.impactEstimate?.impactedSymbols.find((symbol) =>
    symbol.id === target.symbolId
    || (symbol.name === target.name && symbol.filePath === target.filePath));
  return matched ? symbolEvidence(matched) : `${target.filePath}:line-unknown`;
}

function targetConfidence(
  parts: RelationshipParts,
  target: { readonly symbolId: string; readonly name: string; readonly filePath: string },
): number | undefined {
  return parts.impactEstimate?.impactedSymbols.find((symbol) =>
    symbol.id === target.symbolId
    || (symbol.name === target.name && symbol.filePath === target.filePath))?.confidence;
}

function moduleEvidence(module: ModuleCapsule): string {
  return module.entryFiles[0] ?? module.sampleFiles[0] ?? module.root;
}

function formatEngine(parts: RelationshipParts): string {
  const capability = parts.symbolContext?.capability
    ?? parts.moduleContext?.capability
    ?? parts.processContext?.capability
    ?? parts.impactEstimate?.capability;
  if (capability?.engine === 'full') {
    return 'full';
  }
  return 'light';
}

function formatConfidence(parts: RelationshipParts): string {
  const values = [
    parts.symbolContext?.confidence,
    parts.moduleContext?.confidence,
    parts.processContext?.confidence,
    parts.impactEstimate?.confidence,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) {
    return 'unknown';
  }
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return average.toFixed(2);
}

function renderIdentity(lines: string[], parts: RelationshipParts, label: string): void {
  lines.push('Identity');
  if (parts.symbolContext) {
    lines.push(`- Symbol: ${symbolRef(parts.symbolContext.symbol)}`);
    lines.push(`- Symbol module: ${parts.symbolContext.symbol.moduleId}`);
    if (parts.symbolContext.alternatives.length > 0) {
      lines.push(`- Alternatives: ${parts.symbolContext.alternatives.map(symbolRef).join('; ')}`);
    }
  } else if (parts.moduleContext) {
    lines.push(`- Module: ${moduleRef(parts.moduleContext.module)}`);
  } else if (parts.processContext) {
    lines.push(`- Process: ${parts.processContext.process.label} (${parts.processContext.process.entryFile})`);
  } else {
    lines.push(`- Target: ${label}`);
  }
  lines.push('');
}

function renderUpstream(lines: string[], parts: RelationshipParts): void {
  lines.push('Upstream');
  if (parts.symbolContext) {
    const source = edgeSource();
    pushList(
      lines,
      'No direct callers found in the light index.',
      parts.symbolContext.callers.map((caller) =>
        `${symbolRef(caller)} ${edgeMeta(
          source,
          edgeConfidence([parts.symbolContext?.confidence, caller.confidence]),
          symbolEvidence(caller),
        )}`),
    );
  }
  if (parts.moduleContext) {
    const source = edgeSource();
    const module = parts.moduleContext.module;
    pushList(
      lines,
      'No module dependents found in the light index.',
      module.dependents.map((id) =>
        `Dependent module: ${id} ${edgeMeta(
          source,
          edgeConfidence([parts.moduleContext?.confidence]),
          moduleEvidence(module),
        )}`),
    );
  }
  if (parts.impactEstimate?.callers.length) {
    const source = edgeSource();
    for (const caller of parts.impactEstimate.callers) {
      lines.push(`- Impact caller: ${symbolRef(caller)} ${edgeMeta(
        source,
        edgeConfidence([parts.impactEstimate.confidence, caller.confidence]),
        symbolEvidence(caller),
      )}`);
    }
  }
  lines.push('');
}

function renderDownstream(lines: string[], parts: RelationshipParts): void {
  lines.push('Downstream');
  if (parts.symbolContext) {
    const callTargets = parts.symbolContext.symbol.callTargets.map((target) =>
      `${target.name} (${referenceEvidence(parts, target)}) ${edgeMeta(
        edgeSource(),
        edgeConfidence([
          parts.symbolContext?.confidence,
          parts.symbolContext?.symbol.confidence,
          targetConfidence(parts, target),
        ]),
        referenceEvidence(parts, target),
      )}`,
    );
    pushList(lines, 'No direct callees found in the light index.', callTargets);
  }
  if (parts.moduleContext) {
    const source = edgeSource();
    const module = parts.moduleContext.module;
    pushList(
      lines,
      'No module dependencies found in the light index.',
      module.dependencies.map((id) =>
        `Dependency module: ${id} ${edgeMeta(
          source,
          edgeConfidence([parts.moduleContext?.confidence]),
          moduleEvidence(module),
        )}`),
    );
  }
  if (parts.processContext) {
    for (const step of parts.processContext.process.steps) {
      const line = step.line === undefined ? '' : `:${step.line}`;
      const evidence = step.line === undefined ? `${step.filePath}:line-unknown` : `${step.filePath}:${step.line}`;
      lines.push(`- Process ${step.kind}: ${step.symbolName} (${step.filePath}${line}) ${edgeMeta(
        edgeSource(),
        edgeConfidence([parts.processContext.confidence]),
        evidence,
      )}`);
    }
  }
  lines.push('');
}

function renderImpact(lines: string[], impact: ImpactEstimateResult | undefined): void {
  lines.push('Impact');
  if (!impact) {
    lines.push('- Impact estimate unavailable for this target.');
    lines.push('');
    return;
  }
  lines.push(`- ${impact.summary}`);
  pushList(
    lines,
    'No impacted modules found in the light index.',
    impact.impactedModules.map((module) => moduleRef(module)),
  );
  if (impact.impactedSymbols.length > 0) {
    lines.push(`- Impacted symbols: ${impact.impactedSymbols.map(symbolRef).join('; ')}`);
  }
  lines.push('');
}

function renderEvidence(lines: string[], parts: RelationshipParts): void {
  lines.push('Evidence');
  if (parts.symbolContext) {
    lines.push(`- symbol_context freshness=${parts.symbolContext.freshness} confidence=${parts.symbolContext.confidence.toFixed(2)}`);
  }
  if (parts.moduleContext) {
    lines.push(`- module_context freshness=${parts.moduleContext.freshness} confidence=${parts.moduleContext.confidence.toFixed(2)}`);
  }
  if (parts.processContext) {
    lines.push(`- process_context freshness=${parts.processContext.freshness} confidence=${parts.processContext.confidence.toFixed(2)}`);
  }
  if (parts.impactEstimate) {
    lines.push(`- impact_estimate freshness=${parts.impactEstimate.freshness} confidence=${parts.impactEstimate.confidence.toFixed(2)}`);
  }
  lines.push('');
}

function splitSupplementOutput(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return ['(no output)'];
  return trimmed.split(/\r?\n/);
}

function renderSupplementalEvidence(
  lines: string[],
  title: string,
  evidence: readonly SupplementalEvidence[],
): void {
  if (evidence.length === 0) return;
  lines.push(title);
  for (const item of evidence) {
    lines.push(`- ${item.label}`);
    for (const outputLine of splitSupplementOutput(item.output)) {
      lines.push(`  ${outputLine}`);
    }
  }
  lines.push('');
}

function renderGaps(
  lines: string[],
  gaps: string[],
  engine: string,
  depth: 1 | 2 | 3,
): void {
  lines.push('Gaps');
  if (engine === 'light') {
    lines.push('- Light engine uses static heuristics; compiler-accurate call hierarchy is not included yet.');
  }
  if (depth > 1) {
    lines.push(`- Requested depth ${depth}; light-mode relationship_scan reports bounded direct edges first.`);
  }
  pushList(lines, 'No additional gaps recorded.', gaps);
}

function renderWarmingRelationshipScan(
  label: string,
  direction: RelationshipDirection,
  gaps: string[],
): string {
  const lines = [
    `Relationship scan for ${label}`,
    'Engine: warming',
    `Direction: ${direction}`,
    'Status: index warming',
    '',
    'Structural relationships unavailable',
    '- The repository intelligence index is still warming; upstream, downstream, and impact edges are not available yet.',
    '- This is NOT a "no relationships found" result — the analysis has not completed.',
    '- Retry relationship_scan shortly for full structural results.',
    '- Use read, grep, glob, and LSP tools for immediate exploration while the index finishes.',
    '',
    'Gaps',
  ];
  pushList(lines, 'No additional gaps recorded.', gaps);
  return lines.join('\n');
}

function renderRelationshipScan(
  label: string,
  direction: RelationshipDirection,
  depth: 1 | 2 | 3,
  parts: RelationshipParts,
  gaps: string[],
  lspEvidence: readonly SupplementalEvidence[],
  textEvidence: readonly SupplementalEvidence[],
): string {
  const lines = [
    `Relationship scan for ${label}`,
    `Engine: ${formatEngine(parts)}`,
    `Direction: ${direction}`,
    `Confidence: ${formatConfidence(parts)}`,
    '',
  ];
  const availableParts = { ...parts };
  for (const key of ['symbolContext', 'moduleContext', 'processContext', 'impactEstimate'] as const) {
    if (availableParts[key]?.capability?.status === 'unavailable') delete availableParts[key];
  }
  renderIdentity(lines, availableParts, label);
  if (direction === 'upstream' || direction === 'both') {
    renderUpstream(lines, availableParts);
  }
  if (direction === 'downstream' || direction === 'both') {
    renderDownstream(lines, availableParts);
  }
  renderImpact(lines, availableParts.impactEstimate);
  renderEvidence(lines, parts);
  renderSupplementalEvidence(lines, 'LSP validation', lspEvidence);
  renderSupplementalEvidence(lines, 'Text-search validation', textEvidence);
  renderGaps(lines, gaps, formatEngine(parts), depth);
  return lines.join('\n');
}

export async function toolRelationshipScan(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const symbol = readOptionalString(input, 'symbol');
    const moduleName = readOptionalString(input, 'module');
    const filePath = readOptionalString(input, 'path');
    const entry = readOptionalString(input, 'entry');
    const targetPath = readOptionalString(input, 'target_path') ?? filePath;
    const direction = readDirection(input.direction);
    const depth = readDepth(input.depth);
    const refresh = input.refresh === true;
    const includeLsp = input.include_lsp === true;
    const includeTextSearch = input.include_text_search === true;
    const label = symbol ?? moduleName ?? filePath ?? entry;
    if (!label) {
      throw new Error('one of symbol, module, path, or entry is required.');
    }

    const gaps: string[] = [];
    const parts: RelationshipParts = {};
    const maxWaitMs = readRepoIntelligenceToolWaitMs();
    let indexWarming = false;
    const symbolTarget = symbol ?? (!moduleName && !filePath ? entry : undefined);
    if (symbolTarget) {
      parts.symbolContext = await capture('symbol_context', gaps, () => getSymbolContext(ctx, {
        symbol: symbolTarget,
        module: moduleName,
        targetPath,
        refresh,
        maxWaitMs,
      }));
      indexWarming = recordCapabilityGap('symbol_context', parts.symbolContext, gaps);
    }
    if (!indexWarming && (moduleName || filePath || parts.symbolContext)) {
      parts.moduleContext = await capture('module_context', gaps, () => getModuleContext(ctx, {
        module: moduleName ?? parts.symbolContext?.symbol.moduleId,
        targetPath,
        refresh: refresh && !symbolTarget,
        maxWaitMs,
      }));
      indexWarming = recordCapabilityGap('module_context', parts.moduleContext, gaps);
    }
    const shouldLoadProcessContext = (direction === 'downstream' || direction === 'both')
      && Boolean(entry || symbolTarget);
    if (!indexWarming && shouldLoadProcessContext) {
      parts.processContext = await capture('process_context', gaps, () => getProcessContext(ctx, {
        entry,
        module: moduleName,
        targetPath: targetPath ?? parts.symbolContext?.symbol.filePath,
        refresh: false,
        maxWaitMs,
      }));
      indexWarming = recordCapabilityGap('process_context', parts.processContext, gaps);
    }
    if (!indexWarming) {
      parts.impactEstimate = await capture('impact_estimate', gaps, () => getImpactEstimate(ctx, {
        symbol: symbolTarget,
        module: moduleName,
        path: filePath,
        targetPath,
        refresh: false,
        maxWaitMs,
      }));
      indexWarming = recordCapabilityGap('impact_estimate', parts.impactEstimate, gaps);
    }

    if (indexWarming) {
      // The semantic index has not finished building. Render a clean
      // "warming" response instead of the relationship sections, whose
      // empty edge lists ("No direct callers found") would otherwise read
      // as a confident "no relationships" finding — a false negative on a
      // cold first call. Mirrors the explicit warming handling in
      // semantic_lookup so the headline tool holds the same honesty bar.
      return renderWarmingRelationshipScan(label, direction, gaps);
    }

    const lspEvidence = includeLsp && !indexWarming
      ? await capture('lsp_validation', gaps, () => buildLspEvidence(parts, direction, ctx, gaps)) ?? []
      : [];
    const textEvidence = includeTextSearch && !indexWarming
      ? await capture('text_search_validation', gaps, () => buildTextSearchEvidence(
          parts,
          symbolTarget,
          moduleName,
          filePath,
          entry,
          targetPath,
          ctx,
          gaps,
        )) ?? []
      : [];

    return renderRelationshipScan(label, direction, depth, parts, gaps, lspEvidence, textEvidence);
  } catch (error) {
    return `[Tool Error] relationship_scan: ${errorMessage(error)}`;
  }
}
