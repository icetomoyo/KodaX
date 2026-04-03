import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  KodaXRepoIntelligenceCapability,
  KodaXRepoIntelligenceTrace,
  KodaXRepoRoutingSignals,
  KodaXToolExecutionContext,
} from '../types.js';
import {
  analyzeChangedScopeFromSnapshot,
  collectWorkspaceFilesForSource,
  type ChangedScopeReport,
  type RepoAreaKind,
  type RepoAreaOverview,
  type RepoOverviewSnapshot,
  resolveRepoOverviewSnapshot,
} from './index.js';
import {
  debugLogRepoIntelligence,
  resolveRepoIntelligenceStorageDir,
  safeReadJson,
  writeJsonFileAtomic,
} from './internal.js';
import { buildRepoIntelligenceMetadataLines } from './trace-events.js';

const DEFAULT_REPO_INTELLIGENCE_DIR = path.join('.agent', 'repo-intelligence');
const QUERY_INDEX_FILE = 'repo-intelligence-index.json';
const QUERY_MANIFEST_FILE = 'repo-intelligence-manifest.json';
const QUERY_SCHEMA_VERSION = 10;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ANALYZED_FILES = 250;
const MAX_MODULE_SYMBOLS = 8;
const MAX_IMPACTED_SYMBOLS = 8;
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.cpp', '.cc', '.cxx', '.c', '.hpp', '.h',
]);

export type RepoLanguageId =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'go'
  | 'rust'
  | 'cpp'
  | 'unknown';

export type LanguageCapabilityTier = 'high' | 'medium' | 'low';
export type RepoSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'method'
  | 'constant';

export interface RepoLanguageSupport {
  language: RepoLanguageId;
  capabilityTier: LanguageCapabilityTier;
  fileCount: number;
}

export interface RepoSymbolReference {
  symbolId: string;
  name: string;
  filePath: string;
  moduleId: string;
  reason: 'same-module' | 'imported-module' | 'name-match';
}

export interface RepoSymbolRecord {
  id: string;
  name: string;
  qualifiedName: string;
  kind: RepoSymbolKind;
  filePath: string;
  moduleId: string;
  language: RepoLanguageId;
  capabilityTier: LanguageCapabilityTier;
  line: number;
  signature: string;
  exported: boolean;
  calls: string[];
  callTargets: RepoSymbolReference[];
  importPaths: string[];
  confidence: number;
}

export interface ModuleCapsule {
  moduleId: string;
  label: string;
  kind: RepoAreaKind;
  root: string;
  fileCount: number;
  sourceFileCount: number;
  symbolCount: number;
  languages: RepoLanguageSupport[];
  topSymbols: string[];
  dependencies: string[];
  dependents: string[];
  entryFiles: string[];
  keyTests: string[];
  keyDocs: string[];
  sampleFiles: string[];
  processIds: string[];
  confidence: number;
}

export interface ProcessStep {
  kind: 'entry' | 'imports' | 'calls';
  symbolName: string;
  symbolId?: string;
  filePath: string;
  note: string;
  line?: number;
}

export interface ProcessCapsule {
  id: string;
  label: string;
  moduleId: string;
  entryFile: string;
  entrySymbol?: string;
  summary: string;
  steps: ProcessStep[];
  confidence: number;
}

export interface RepoIntelligenceIndex {
  schemaVersion: number;
  workspaceRoot: string;
  generatedAt: string;
  overviewGeneratedAt: string;
  sourceFileCount: number;
  sourceFingerprint: string;
  languages: RepoLanguageSupport[];
  modules: ModuleCapsule[];
  symbols: RepoSymbolRecord[];
  processes: ProcessCapsule[];
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

interface RepoIntelligenceManifest {
  schemaVersion: number;
  workspaceRoot: string;
  generatedAt: string;
  overviewGeneratedAt: string;
  sourceFileCount: number;
  sourceFingerprint: string;
}

export interface ModuleContextResult {
  module: ModuleCapsule;
  freshness: string;
  confidence: number;
  evidence: string[];
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface SymbolContextResult {
  symbol: RepoSymbolRecord;
  alternatives: RepoSymbolRecord[];
  callers: RepoSymbolRecord[];
  freshness: string;
  confidence: number;
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface ProcessContextResult {
  process: ProcessCapsule;
  alternatives: ProcessCapsule[];
  freshness: string;
  confidence: number;
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface ImpactEstimateResult {
  target: {
    kind: 'symbol' | 'module' | 'path';
    label: string;
    moduleId?: string;
    filePath?: string;
  };
  summary: string;
  impactedModules: ModuleCapsule[];
  impactedSymbols: RepoSymbolRecord[];
  callers: RepoSymbolRecord[];
  changedScope?: ChangedScopeReport;
  freshness: string;
  confidence: number;
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

interface ExtractedSymbol {
  name: string;
  kind: RepoSymbolKind;
  line: number;
  signature: string;
  exported: boolean;
  qualifier?: string;
}

interface FallbackFileAnalysis {
  filePath: string;
  moduleId: string;
  language: RepoLanguageId;
  capabilityTier: LanguageCapabilityTier;
  importPaths: string[];
  symbols: ExtractedSymbol[];
  content: string;
}

type RepoContext = Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>;

function getRepoIntelligenceDir(): string {
  return resolveRepoIntelligenceStorageDir(DEFAULT_REPO_INTELLIGENCE_DIR);
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function hashValues(parts: Array<string | number | boolean | undefined>): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(part ?? ''));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function lineNumberForOffset(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

function languageFromFile(filePath: string): RepoLanguageId {
  switch (path.extname(filePath).toLowerCase()) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.java':
      return 'java';
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.c':
    case '.hpp':
    case '.h':
      return 'cpp';
    default:
      return 'unknown';
  }
}

function capabilityTierForLanguage(language: RepoLanguageId): LanguageCapabilityTier {
  switch (language) {
    case 'typescript':
    case 'javascript':
    case 'python':
    case 'go':
    case 'rust':
      return 'high';
    case 'java':
      return 'medium';
    case 'cpp':
    case 'unknown':
    default:
      return 'low';
  }
}

function confidenceLabel(value: number): string {
  if (value >= 0.8) {
    return 'high';
  }
  if (value >= 0.65) {
    return 'medium';
  }
  return 'low';
}

function resolveStorageRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, getRepoIntelligenceDir());
}

function resolveIndexFiles(workspaceRoot: string): {
  storageRoot: string;
  indexPath: string;
  manifestPath: string;
} {
  const storageRoot = resolveStorageRoot(workspaceRoot);
  return {
    storageRoot,
    indexPath: path.join(storageRoot, QUERY_INDEX_FILE),
    manifestPath: path.join(storageRoot, QUERY_MANIFEST_FILE),
  };
}

function isIndexPayload(value: unknown): value is RepoIntelligenceIndex {
  return typeof value === 'object'
    && value !== null
    && (value as RepoIntelligenceIndex).schemaVersion === QUERY_SCHEMA_VERSION
    && typeof (value as RepoIntelligenceIndex).workspaceRoot === 'string'
    && typeof (value as RepoIntelligenceIndex).generatedAt === 'string'
    && Array.isArray((value as RepoIntelligenceIndex).modules)
    && Array.isArray((value as RepoIntelligenceIndex).symbols)
    && Array.isArray((value as RepoIntelligenceIndex).processes);
}

function isManifestPayload(value: unknown): value is RepoIntelligenceManifest {
  return typeof value === 'object'
    && value !== null
    && (value as RepoIntelligenceManifest).schemaVersion === QUERY_SCHEMA_VERSION
    && typeof (value as RepoIntelligenceManifest).workspaceRoot === 'string'
    && typeof (value as RepoIntelligenceManifest).generatedAt === 'string'
    && typeof (value as RepoIntelligenceManifest).overviewGeneratedAt === 'string';
}

async function ensureDir(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
}

async function readCachedIndex(
  workspaceRoot: string,
  overviewGeneratedAt: string,
  sourceFingerprint: string,
): Promise<RepoIntelligenceIndex | null> {
  const { indexPath, manifestPath } = resolveIndexFiles(workspaceRoot);
  const [indexPayload, manifestPayload] = await Promise.all([
    safeReadJson<unknown>(indexPath),
    safeReadJson<unknown>(manifestPath),
  ]);
  if (!isIndexPayload(indexPayload) || !isManifestPayload(manifestPayload)) {
    return null;
  }
  if (manifestPayload.overviewGeneratedAt !== overviewGeneratedAt) {
    return null;
  }
  if (manifestPayload.sourceFingerprint !== sourceFingerprint) {
    return null;
  }
  return indexPayload;
}

function withinModuleRoot(filePath: string, root: string): boolean {
  if (root === '.' || root === '') {
    return true;
  }
  return filePath === root || filePath.startsWith(`${root}/`);
}

function pickModuleAreaForFile(filePath: string, areas: RepoAreaOverview[]): RepoAreaOverview {
  const sorted = [...areas].sort((left, right) => right.root.length - left.root.length);
  return sorted.find((area) => withinModuleRoot(filePath, area.root))
    ?? {
      id: '.',
      label: 'workspace-root',
      kind: 'root',
      root: '.',
      fileCount: 0,
      manifests: [],
      sampleFiles: [],
    };
}

function extractImports(content: string, language: RepoLanguageId): string[] {
  const imports = new Set<string>();
  const pushAll = (regex: RegExp, valueIndex: number): void => {
    for (const match of content.matchAll(regex)) {
      const value = match[valueIndex]?.trim();
      if (value) {
        imports.add(normalizeRelativePath(value));
      }
    }
  };

  switch (language) {
    case 'typescript':
    case 'javascript':
      pushAll(/from\s+['"]([^'"]+)['"]/g, 1);
      pushAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g, 1);
      break;
    case 'python':
      pushAll(/^\s*from\s+([A-Za-z0-9_./]+)\s+import\s+/gm, 1);
      pushAll(/^\s*import\s+([A-Za-z0-9_./]+)/gm, 1);
      break;
    case 'go':
      pushAll(/import\s+(?:\(\s*)?"([^"]+)"/g, 1);
      break;
    case 'rust':
      pushAll(/^\s*use\s+([^;]+);/gm, 1);
      break;
    case 'java':
      pushAll(/^\s*import\s+([^;]+);/gm, 1);
      break;
    case 'cpp':
      pushAll(/^\s*#include\s+[<"]([^>"]+)[>"]/gm, 1);
      break;
    default:
      break;
  }

  return Array.from(imports.values()).slice(0, 16);
}

function extractTypescriptLikeSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const patterns: Array<{ regex: RegExp; kind: RepoSymbolKind }> = [
    { regex: /(^|\n)(export\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)/g, kind: 'function' },
    { regex: /(^|\n)(export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/g, kind: 'class' },
    { regex: /(^|\n)(export\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)/g, kind: 'interface' },
    { regex: /(^|\n)(export\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g, kind: 'type' },
    { regex: /(^|\n)(export\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/g, kind: 'enum' },
    { regex: /(^|\n)(export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g, kind: 'function' },
    { regex: /(^|\n)(export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g, kind: 'constant' },
  ];
  for (const { regex, kind } of patterns) {
    for (const match of content.matchAll(regex)) {
      const name = match[3];
      if (!name) {
        continue;
      }
      symbols.push({
        name,
        kind,
        line: lineNumberForOffset(content, match.index ?? 0),
        signature: match[0].trim().split('\n')[0] ?? name,
        exported: match[2]?.includes('export') ?? false,
      });
    }
  }

  let currentClass: { name: string; depth: number } | null = null;
  let braceDepth = 0;
  const lines = content.split('\n');
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    const classMatch = /^(export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (classMatch) {
      currentClass = {
        name: classMatch[2],
        depth: braceDepth + (line.includes('{') ? 1 : 0),
      };
    } else if (currentClass) {
      const methodMatch = /^(?:public|private|protected|static|async|get|set|\s)*\s*([A-Za-z_][A-Za-z0-9_]*)\s*\([^;)]*\)\s*\{?$/.exec(line);
      if (methodMatch && methodMatch[1] !== 'constructor') {
        symbols.push({
          name: methodMatch[1],
          kind: 'method',
          line: index + 1,
          signature: line,
          exported: true,
          qualifier: currentClass.name,
        });
      }
    }
    braceDepth += (rawLine.match(/\{/g) ?? []).length;
    braceDepth -= (rawLine.match(/\}/g) ?? []).length;
    if (currentClass && braceDepth < currentClass.depth) {
      currentClass = null;
    }
  }
  return symbols;
}

function extractPythonSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  let currentClass: { name: string; indent: number } | null = null;
  const lines = content.split('\n');
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trimEnd();
    const indent = rawLine.length - rawLine.trimStart().length;
    const classMatch = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (classMatch) {
      currentClass = {
        name: classMatch[1],
        indent,
      };
      symbols.push({
        name: classMatch[1],
        kind: 'class',
        line: index + 1,
        signature: line.trim(),
        exported: true,
      });
      continue;
    }
    if (currentClass && indent <= currentClass.indent && rawLine.trim()) {
      currentClass = null;
    }
    const defMatch = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (defMatch) {
      symbols.push({
        name: defMatch[1],
        kind: currentClass ? 'method' : 'function',
        line: index + 1,
        signature: line.trim(),
        exported: currentClass === null,
        qualifier: currentClass?.name,
      });
    }
  }
  return symbols;
}

function extractGoSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  for (const match of content.matchAll(/(^|\n)\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)/g)) {
    symbols.push({
      name: match[2],
      kind: match[3] === 'interface' ? 'trait' : 'struct',
      line: lineNumberForOffset(content, match.index ?? 0),
      signature: match[0].trim(),
      exported: /^[A-Z]/.test(match[2]),
    });
  }
  for (const match of content.matchAll(/(^|\n)\s*func\s*(\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const receiver = match[2];
    symbols.push({
      name: match[3],
      kind: receiver ? 'method' : 'function',
      line: lineNumberForOffset(content, match.index ?? 0),
      signature: match[0].trim(),
      exported: /^[A-Z]/.test(match[3]),
    });
  }
  return symbols;
}

function extractRustSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  for (const match of content.matchAll(/(^|\n)\s*(pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    symbols.push({
      name: match[3],
      kind: 'struct',
      line: lineNumberForOffset(content, match.index ?? 0),
      signature: match[0].trim(),
      exported: Boolean(match[2]),
    });
  }
  for (const match of content.matchAll(/(^|\n)\s*(pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    symbols.push({
      name: match[3],
      kind: 'trait',
      line: lineNumberForOffset(content, match.index ?? 0),
      signature: match[0].trim(),
      exported: Boolean(match[2]),
    });
  }
  for (const match of content.matchAll(/(^|\n)\s*(pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    symbols.push({
      name: match[3],
      kind: 'function',
      line: lineNumberForOffset(content, match.index ?? 0),
      signature: match[0].trim(),
      exported: Boolean(match[2]),
    });
  }
  return symbols;
}

function extractJavaOrCppSymbols(content: string, language: RepoLanguageId): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  for (const match of content.matchAll(/(^|\n)\s*(?:public\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    symbols.push({
      name: match[2],
      kind: 'class',
      line: lineNumberForOffset(content, match.index ?? 0),
      signature: match[0].trim(),
      exported: true,
    });
  }
  const methodRegex = language === 'java'
    ? /(^|\n)\s*(?:public|private|protected)?\s*(?:static\s+)?[A-Za-z0-9_<>\[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{)]*\)\s*\{/g
    : /(^|\n)\s*[A-Za-z0-9_:<>\*&\s]+\s+([A-Za-z_][A-Za-z0-9_:]*)\s*\([^;{)]*\)\s*\{/g;
  for (const match of content.matchAll(methodRegex)) {
    const rawName = match[2];
    const name = rawName.includes('::') ? rawName.split('::').at(-1)! : rawName;
    symbols.push({
      name,
      kind: 'method',
      line: lineNumberForOffset(content, match.index ?? 0),
      signature: match[0].trim().split('\n')[0] ?? name,
      exported: language !== 'java' || match[0].includes('public'),
    });
  }
  return symbols;
}

function extractSymbols(content: string, language: RepoLanguageId): ExtractedSymbol[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return extractTypescriptLikeSymbols(content);
    case 'python':
      return extractPythonSymbols(content);
    case 'go':
      return extractGoSymbols(content);
    case 'rust':
      return extractRustSymbols(content);
    case 'java':
    case 'cpp':
      return extractJavaOrCppSymbols(content, language);
    default:
      return [];
  }
}

function resolveImportToFile(
  importPath: string,
  currentFilePath: string,
  knownFiles: Set<string>,
): string | null {
  if (!importPath.startsWith('.')) {
    return null;
  }
  const baseDir = path.posix.dirname(currentFilePath);
  const normalizedBase = baseDir === '.' ? '' : baseDir;
  const rawResolved = normalizeRelativePath(path.posix.normalize(path.posix.join(normalizedBase, importPath)));
  const candidates = [
    rawResolved,
    `${rawResolved}.ts`,
    `${rawResolved}.tsx`,
    `${rawResolved}.js`,
    `${rawResolved}.jsx`,
    `${rawResolved}.py`,
    `${rawResolved}.go`,
    `${rawResolved}.rs`,
    `${rawResolved}.java`,
    `${rawResolved}.cpp`,
    `${rawResolved}/index.ts`,
    `${rawResolved}/index.js`,
    `${rawResolved}/__init__.py`,
  ];
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
}

function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.name)) {
      continue;
    }
    seen.add(item.name);
    result.push(item);
  }
  return result;
}

async function analyzeSourceFile(
  workspaceRoot: string,
  filePath: string,
  moduleId: string,
): Promise<FallbackFileAnalysis | null> {
  const absolutePath = path.join(workspaceRoot, filePath);
  const stat = await fs.stat(absolutePath);
  if (stat.size > MAX_FILE_BYTES) {
    return null;
  }
  const content = await fs.readFile(absolutePath, 'utf8');
  const language = languageFromFile(filePath);
  return {
    filePath,
    moduleId,
    language,
    capabilityTier: capabilityTierForLanguage(language),
    importPaths: extractImports(content, language),
    symbols: dedupeByName(extractSymbols(content, language)),
    content,
  };
}

async function collectSourceFileCandidates(
  snapshot: RepoOverviewSnapshot,
): Promise<string[]> {
  return snapshot.inventory?.sourceFiles
    ?? (await collectWorkspaceFilesForSource(snapshot.workspaceRoot, snapshot.source)).files
      .filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
      .map((filePath) => normalizeRelativePath(filePath));
}

async function computeSourceFingerprint(
  workspaceRoot: string,
  sourceFiles: string[],
): Promise<string> {
  const fingerprintParts: string[] = [];
  for (const filePath of sourceFiles.slice(0, MAX_ANALYZED_FILES)) {
    try {
      const stat = await fs.stat(path.join(workspaceRoot, filePath));
      fingerprintParts.push(`${filePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
    } catch (error) {
      debugLogRepoIntelligence(`Fallback repo intelligence could not stat ${filePath} for fingerprinting.`, error);
      fingerprintParts.push(`${filePath}:missing`);
    }
  }
  return hashValues([workspaceRoot, ...fingerprintParts]);
}

function buildRepoLanguageSupport(analyses: FallbackFileAnalysis[]): RepoLanguageSupport[] {
  const counts = new Map<RepoLanguageId, number>();
  for (const analysis of analyses) {
    counts.set(analysis.language, (counts.get(analysis.language) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([language, fileCount]) => ({
      language,
      capabilityTier: capabilityTierForLanguage(language),
      fileCount,
    }))
    .sort((left, right) => right.fileCount - left.fileCount || left.language.localeCompare(right.language));
}

function buildModuleLanguages(files: FallbackFileAnalysis[]): RepoLanguageSupport[] {
  return buildRepoLanguageSupport(files);
}

function buildSymbolRecordId(moduleId: string, filePath: string, name: string, line: number): string {
  return hashValues([moduleId, filePath, name, line]);
}

function collectLikelyCalls(content: string, symbolNames: string[]): string[] {
  const calls = new Set<string>();
  for (const symbolName of symbolNames) {
    const pattern = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\(`, 'g');
    if (pattern.test(content)) {
      calls.add(symbolName);
    }
  }
  return Array.from(calls.values());
}

function buildModuleDependencyMaps(
  analyses: FallbackFileAnalysis[],
  modulesById: Map<string, ModuleCapsule>,
): {
  dependencies: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
} {
  const knownFiles = new Set(analyses.map((analysis) => analysis.filePath));
  const fileToModule = new Map(analyses.map((analysis) => [analysis.filePath, analysis.moduleId]));
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const moduleId of modulesById.keys()) {
    dependencies.set(moduleId, new Set<string>());
    dependents.set(moduleId, new Set<string>());
  }

  for (const analysis of analyses) {
    const importedModules = new Set<string>();
    for (const importPath of analysis.importPaths) {
      const resolvedFile = resolveImportToFile(importPath, analysis.filePath, knownFiles);
      if (!resolvedFile) {
        continue;
      }
      const importedModuleId = fileToModule.get(resolvedFile);
      if (!importedModuleId || importedModuleId === analysis.moduleId) {
        continue;
      }
      importedModules.add(importedModuleId);
    }
    const dependencySet = dependencies.get(analysis.moduleId) ?? new Set<string>();
    for (const importedModuleId of importedModules) {
      dependencySet.add(importedModuleId);
      const dependentSet = dependents.get(importedModuleId) ?? new Set<string>();
      dependentSet.add(analysis.moduleId);
      dependents.set(importedModuleId, dependentSet);
    }
    dependencies.set(analysis.moduleId, dependencySet);
  }

  return { dependencies, dependents };
}

function buildModules(
  snapshot: RepoOverviewSnapshot,
  analyses: FallbackFileAnalysis[],
): ModuleCapsule[] {
  const allAreas = snapshot.overview.areas.length > 0
    ? snapshot.overview.areas
    : [{
      id: '.',
      label: path.basename(snapshot.workspaceRoot),
      kind: 'root' as const,
      root: '.',
      fileCount: analyses.length,
      manifests: snapshot.overview.manifests,
      sampleFiles: [],
    }];

  const modulesById = new Map<string, ModuleCapsule>();
  for (const area of allAreas) {
    const areaFiles = analyses.filter((analysis) => withinModuleRoot(analysis.filePath, area.root));
    const entryFiles = snapshot.overview.entryHints.filter((entry) => withinModuleRoot(entry, area.root)).slice(0, 4);
    const keyTests = (snapshot.inventory?.allFiles ?? [])
      .filter((filePath) => withinModuleRoot(filePath, area.root) && /(test|spec)\./i.test(path.basename(filePath)))
      .slice(0, 4);
    const keyDocs = snapshot.overview.keyDocs.filter((filePath) => withinModuleRoot(filePath, area.root)).slice(0, 4);
    const topSymbols = areaFiles
      .flatMap((analysis) => analysis.symbols.map((symbol) => symbol.name))
      .slice(0, MAX_MODULE_SYMBOLS);
    modulesById.set(area.id, {
      moduleId: area.id,
      label: area.label,
      kind: area.kind,
      root: area.root,
      fileCount: area.fileCount,
      sourceFileCount: areaFiles.length,
      symbolCount: areaFiles.reduce((sum, analysis) => sum + analysis.symbols.length, 0),
      languages: buildModuleLanguages(areaFiles),
      topSymbols,
      dependencies: [],
      dependents: [],
      entryFiles,
      keyTests,
      keyDocs,
      sampleFiles: area.sampleFiles,
      processIds: [],
      confidence: areaFiles.length > 0 ? 0.54 : 0.25,
    });
  }

  const { dependencies, dependents } = buildModuleDependencyMaps(analyses, modulesById);
  for (const module of modulesById.values()) {
    module.dependencies = Array.from(dependencies.get(module.moduleId) ?? []).sort();
    module.dependents = Array.from(dependents.get(module.moduleId) ?? []).sort();
  }
  return Array.from(modulesById.values()).sort((left, right) => left.root.localeCompare(right.root));
}

function buildSymbolRecords(
  analyses: FallbackFileAnalysis[],
  modulesById: Map<string, ModuleCapsule>,
): RepoSymbolRecord[] {
  const knownNames = Array.from(new Set(
    analyses.flatMap((analysis) => analysis.symbols.map((symbol) => symbol.name)),
  )).sort();

  const records: RepoSymbolRecord[] = [];
  for (const analysis of analyses) {
    const fileLevelCalls = collectLikelyCalls(analysis.content, knownNames);
    for (const symbol of analysis.symbols) {
      const record: RepoSymbolRecord = {
        id: buildSymbolRecordId(analysis.moduleId, analysis.filePath, symbol.name, symbol.line),
        name: symbol.name,
        qualifiedName: symbol.qualifier ? `${symbol.qualifier}.${symbol.name}` : symbol.name,
        kind: symbol.kind,
        filePath: analysis.filePath,
        moduleId: analysis.moduleId,
        language: analysis.language,
        capabilityTier: analysis.capabilityTier,
        line: symbol.line,
        signature: symbol.signature,
        exported: symbol.exported,
        calls: fileLevelCalls.filter((call) => call !== symbol.name).slice(0, 8),
        callTargets: [],
        importPaths: analysis.importPaths,
        confidence: Math.min(0.74, symbol.exported ? 0.64 : 0.52),
      };
      if (!modulesById.has(record.moduleId)) {
        continue;
      }
      records.push(record);
    }
  }

  const byName = new Map<string, RepoSymbolRecord[]>();
  for (const record of records) {
    const bucket = byName.get(record.name) ?? [];
    bucket.push(record);
    byName.set(record.name, bucket);
  }

  for (const record of records) {
    record.callTargets = record.calls
      .flatMap((callName) => (byName.get(callName) ?? []).slice(0, 2))
      .filter((target) => target.id !== record.id)
      .map((target) => ({
        symbolId: target.id,
        name: target.name,
        filePath: target.filePath,
        moduleId: target.moduleId,
        reason: (target.moduleId === record.moduleId ? 'same-module' : 'name-match') as RepoSymbolReference['reason'],
      }))
      .slice(0, 6);
  }

  return records.sort((left, right) =>
    left.filePath.localeCompare(right.filePath)
    || left.line - right.line
    || left.name.localeCompare(right.name));
}

function buildProcesses(
  modules: ModuleCapsule[],
  analyses: FallbackFileAnalysis[],
  symbols: RepoSymbolRecord[],
): ProcessCapsule[] {
  const analysesByModule = new Map<string, FallbackFileAnalysis[]>();
  for (const analysis of analyses) {
    const bucket = analysesByModule.get(analysis.moduleId) ?? [];
    bucket.push(analysis);
    analysesByModule.set(analysis.moduleId, bucket);
  }

  const symbolsByModule = new Map<string, RepoSymbolRecord[]>();
  for (const symbol of symbols) {
    const bucket = symbolsByModule.get(symbol.moduleId) ?? [];
    bucket.push(symbol);
    symbolsByModule.set(symbol.moduleId, bucket);
  }

  const processes: ProcessCapsule[] = [];
  for (const module of modules) {
    const moduleAnalyses = analysesByModule.get(module.moduleId) ?? [];
    const moduleSymbols = symbolsByModule.get(module.moduleId) ?? [];
    const entryFile = module.entryFiles[0] ?? module.sampleFiles[0] ?? moduleAnalyses[0]?.filePath;
    if (!entryFile) {
      continue;
    }
    const entrySymbol = moduleSymbols.find((symbol) => symbol.exported)?.name ?? moduleSymbols[0]?.name;
    const entryAnalysis = moduleAnalyses.find((analysis) => analysis.filePath === entryFile) ?? moduleAnalyses[0];
    const steps: ProcessStep[] = [
      {
        kind: 'entry' as const,
        symbolName: entrySymbol ?? path.basename(entryFile),
        filePath: entryFile,
        note: 'Fallback entrypoint inference from repo overview and source layout.',
      },
      ...(entryAnalysis?.importPaths.slice(0, 2).map((importPath) => ({
        kind: 'imports' as const,
        symbolName: importPath,
        filePath: entryFile,
        note: 'Related import path observed in the entry file.',
      })) ?? []),
    ];

    const leadSymbol = moduleSymbols.find((symbol) => symbol.filePath === entryFile)
      ?? moduleSymbols[0];
    for (const target of leadSymbol?.callTargets.slice(0, 3) ?? []) {
      steps.push({
        kind: 'calls',
        symbolName: target.name,
        symbolId: target.symbolId,
        filePath: target.filePath,
        note: 'Potential downstream call inferred from fallback symbol scanning.',
      });
    }

    const processId = `${module.moduleId}:fallback-main`;
    module.processIds = [processId];
    processes.push({
      id: processId,
      label: `${module.label} main flow`,
      moduleId: module.moduleId,
      entryFile,
      entrySymbol,
      summary: `Fallback process capsule for ${module.label} based on entry files and lightweight symbol scanning.`,
      steps,
      confidence: Math.max(0.32, module.confidence - 0.08),
    });
  }
  return processes;
}

async function buildIndexFromSnapshot(
  snapshot: RepoOverviewSnapshot,
  sourceFileCandidates: string[],
  sourceFingerprint: string,
): Promise<RepoIntelligenceIndex> {
  const analyzedFiles = sourceFileCandidates.slice(0, MAX_ANALYZED_FILES);
  const moduleAreas = snapshot.overview.areas.length > 0
    ? snapshot.overview.areas
    : [{
      id: '.',
      label: path.basename(snapshot.workspaceRoot),
      kind: 'root' as const,
      root: '.',
      fileCount: analyzedFiles.length,
      manifests: snapshot.overview.manifests,
      sampleFiles: [],
    }];
  const analyses = (await Promise.all(
    analyzedFiles.map((filePath) => analyzeSourceFile(
      snapshot.workspaceRoot,
      filePath,
      pickModuleAreaForFile(filePath, moduleAreas).id,
    ).catch((error) => {
      debugLogRepoIntelligence(`Fallback repo intelligence skipped unreadable source file ${filePath}.`, error);
      return null;
    })),
  )).filter((analysis): analysis is FallbackFileAnalysis => analysis !== null);

  const modules = buildModules(snapshot, analyses);
  const modulesById = new Map(modules.map((module) => [module.moduleId, module]));
  const symbols = buildSymbolRecords(analyses, modulesById);
  const processes = buildProcesses(modules, analyses, symbols);
  const languages = buildRepoLanguageSupport(analyses);
  const generatedAt = new Date().toISOString();

  return {
    schemaVersion: QUERY_SCHEMA_VERSION,
    workspaceRoot: snapshot.workspaceRoot,
    generatedAt,
    overviewGeneratedAt: snapshot.overview.generatedAt,
    sourceFileCount: sourceFileCandidates.length,
    sourceFingerprint,
    languages,
    modules,
    symbols,
    processes,
  };
}

async function writeIndexArtifacts(index: RepoIntelligenceIndex): Promise<void> {
  const { storageRoot, indexPath, manifestPath } = resolveIndexFiles(index.workspaceRoot);
  await ensureDir(storageRoot);
  await Promise.all([
    writeJsonFileAtomic(indexPath, index),
    writeJsonFileAtomic(manifestPath, {
      schemaVersion: QUERY_SCHEMA_VERSION,
      workspaceRoot: index.workspaceRoot,
      generatedAt: index.generatedAt,
      overviewGeneratedAt: index.overviewGeneratedAt,
      sourceFileCount: index.sourceFileCount,
      sourceFingerprint: index.sourceFingerprint,
    } satisfies RepoIntelligenceManifest),
  ]);
}

function buildFreshnessLabel(index: RepoIntelligenceIndex): string {
  return `${index.generatedAt} (overview ${index.overviewGeneratedAt})`;
}

function findModuleMatch(index: RepoIntelligenceIndex, query?: string, targetPath?: string): ModuleCapsule | null {
  if (query) {
    const normalizedQuery = query.trim().toLowerCase();
    const byQuery = index.modules.find((module) =>
      module.moduleId.toLowerCase() === normalizedQuery
      || module.label.toLowerCase() === normalizedQuery
      || module.root.toLowerCase() === normalizedQuery,
    );
    if (byQuery) {
      return byQuery;
    }
  }

  if (targetPath) {
    const normalizedPath = normalizeRelativePath(targetPath);
    const byPath = [...index.modules]
      .sort((left, right) => right.root.length - left.root.length)
      .find((module) =>
        normalizedPath === module.root
        || normalizedPath.startsWith(`${module.root}/`)
        || module.sampleFiles.includes(normalizedPath)
        || module.entryFiles.includes(normalizedPath),
      );
    if (byPath) {
      return byPath;
    }
  }

  return index.modules[0] ?? null;
}

function findSymbolCandidates(
  index: RepoIntelligenceIndex,
  symbolName: string,
  moduleId?: string,
  targetPath?: string,
): RepoSymbolRecord[] {
  const normalizedName = symbolName.trim().toLowerCase();
  const preferredModule = findModuleMatch(index, moduleId, targetPath)?.moduleId;
  return index.symbols
    .filter((symbol) => symbol.name.toLowerCase() === normalizedName)
    .sort((left, right) => {
      const leftScore = left.moduleId === preferredModule ? 1 : 0;
      const rightScore = right.moduleId === preferredModule ? 1 : 0;
      return rightScore - leftScore || right.confidence - left.confidence;
    });
}

function buildCallers(index: RepoIntelligenceIndex, symbol: RepoSymbolRecord): RepoSymbolRecord[] {
  return index.symbols
    .filter((candidate) => candidate.callTargets.some((target) => target.symbolId === symbol.id))
    .slice(0, 6);
}

function findProcessCandidates(
  index: RepoIntelligenceIndex,
  entry?: string,
  module?: string,
  targetPath?: string,
): ProcessCapsule[] {
  const preferredModule = findModuleMatch(index, module, targetPath)?.moduleId;
  if (!entry) {
    return index.processes
      .filter((process) => !preferredModule || process.moduleId === preferredModule)
      .slice(0, 4);
  }
  const normalizedEntry = entry.trim().toLowerCase();
  return index.processes
    .filter((process) =>
      process.label.toLowerCase().includes(normalizedEntry)
      || process.entrySymbol?.toLowerCase() === normalizedEntry
      || process.entryFile.toLowerCase().includes(normalizedEntry),
    )
    .sort((left, right) => {
      const leftScore = left.moduleId === preferredModule ? 1 : 0;
      const rightScore = right.moduleId === preferredModule ? 1 : 0;
      return rightScore - leftScore || right.confidence - left.confidence;
    });
}

function deriveRoutingComplexity(
  changedFileCount: number,
  changedLineCount: number,
  touchedModuleCount: number,
  impactedModuleCount: number,
): KodaXRepoRoutingSignals['suggestedComplexity'] {
  if (
    changedFileCount >= 20
    || changedLineCount >= 4000
    || touchedModuleCount >= 5
    || impactedModuleCount >= 5
  ) {
    return 'systemic';
  }
  if (
    changedFileCount >= 8
    || changedLineCount >= 1200
    || touchedModuleCount >= 3
    || impactedModuleCount >= 3
  ) {
    return 'complex';
  }
  if (
    changedFileCount >= 3
    || changedLineCount >= 250
    || touchedModuleCount >= 2
    || impactedModuleCount >= 2
  ) {
    return 'moderate';
  }
  return 'simple';
}

function deriveReviewScale(
  changedFileCount: number,
  changedLineCount: number,
  touchedModuleCount: number,
): KodaXRepoRoutingSignals['reviewScale'] {
  if (
    changedFileCount >= 30
    || changedLineCount >= 4000
    || touchedModuleCount >= 5
  ) {
    return 'massive';
  }
  if (
    changedFileCount >= 10
    || changedLineCount >= 1200
    || touchedModuleCount >= 3
  ) {
    return 'large';
  }
  return 'small';
}

export async function buildRepoIntelligenceIndex(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<RepoIntelligenceIndex> {
  const snapshot = await resolveRepoOverviewSnapshot(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const sourceFileCandidates = await collectSourceFileCandidates(snapshot);
  const sourceFingerprint = await computeSourceFingerprint(snapshot.workspaceRoot, sourceFileCandidates);
  const index = await buildIndexFromSnapshot(snapshot, sourceFileCandidates, sourceFingerprint);
  await writeIndexArtifacts(index);
  return index;
}

export async function getRepoIntelligenceIndex(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<RepoIntelligenceIndex> {
  const snapshot = await resolveRepoOverviewSnapshot(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const sourceFileCandidates = await collectSourceFileCandidates(snapshot);
  const sourceFingerprint = await computeSourceFingerprint(snapshot.workspaceRoot, sourceFileCandidates);
  if (!options.refresh) {
    const cached = await readCachedIndex(snapshot.workspaceRoot, snapshot.overview.generatedAt, sourceFingerprint);
    if (cached) {
      return cached;
    }
  }
  const index = await buildIndexFromSnapshot(snapshot, sourceFileCandidates, sourceFingerprint);
  await writeIndexArtifacts(index);
  return index;
}

export async function getModuleContext(
  context: RepoContext,
  options: { module?: string; targetPath?: string; refresh?: boolean } = {},
): Promise<ModuleContextResult> {
  const index = await getRepoIntelligenceIndex(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const module = findModuleMatch(index, options.module, options.targetPath);
  if (!module) {
    throw new Error('No repo module context could be inferred for this workspace.');
  }

  return {
    module,
    freshness: buildFreshnessLabel(index),
    confidence: Math.max(0.32, module.confidence),
    evidence: [
      `root=${module.root}`,
      `sample_files=${module.sampleFiles.slice(0, 3).join(', ') || 'none'}`,
      `entry_files=${module.entryFiles.slice(0, 3).join(', ') || 'none'}`,
      'fallback_module_heuristics=true',
    ],
  };
}

export async function getSymbolContext(
  context: RepoContext,
  options: { symbol: string; module?: string; targetPath?: string; refresh?: boolean },
): Promise<SymbolContextResult> {
  const index = await getRepoIntelligenceIndex(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const [symbol, ...alternatives] = findSymbolCandidates(index, options.symbol, options.module, options.targetPath);
  if (!symbol) {
    throw new Error(`No symbol context found for ${options.symbol}.`);
  }
  const callers = buildCallers(index, symbol);
  return {
    symbol,
    alternatives: alternatives.slice(0, 6),
    callers,
    freshness: buildFreshnessLabel(index),
    confidence: Math.min(0.62, Math.max(symbol.confidence, callers.length > 0 ? 0.58 : 0.46)),
  };
}

export async function getProcessContext(
  context: RepoContext,
  options: { entry?: string; module?: string; targetPath?: string; refresh?: boolean },
): Promise<ProcessContextResult> {
  const index = await getRepoIntelligenceIndex(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const [process, ...alternatives] = findProcessCandidates(index, options.entry, options.module, options.targetPath);
  if (!process) {
    throw new Error('No process context could be inferred for this workspace.');
  }
  return {
    process,
    alternatives: alternatives.slice(0, 4),
    freshness: buildFreshnessLabel(index),
    confidence: process.confidence,
  };
}

export async function getImpactEstimate(
  context: RepoContext,
  options: { symbol?: string; module?: string; path?: string; targetPath?: string; refresh?: boolean },
): Promise<ImpactEstimateResult> {
  const index = await getRepoIntelligenceIndex(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const snapshot = await resolveRepoOverviewSnapshot(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const changedScope = snapshot.source === 'git'
    ? await analyzeChangedScopeFromSnapshot(snapshot, { scope: 'all' }).catch(() => undefined)
    : undefined;

  if (options.symbol) {
    const symbolContext = await getSymbolContext(context, {
      symbol: options.symbol,
      module: options.module,
      targetPath: options.targetPath,
      refresh: options.refresh,
    });
    const impactedModuleIds = new Set<string>([
      symbolContext.symbol.moduleId,
      ...symbolContext.callers.map((caller) => caller.moduleId),
      ...symbolContext.symbol.callTargets.map((target) => target.moduleId),
    ]);
    const impactedModules = index.modules.filter((module) => impactedModuleIds.has(module.moduleId));
    return {
      target: {
        kind: 'symbol',
        label: symbolContext.symbol.name,
        moduleId: symbolContext.symbol.moduleId,
        filePath: symbolContext.symbol.filePath,
      },
      summary: `Fallback impact suggests ${symbolContext.symbol.name} may ripple into ${impactedModules.length} module(s) through lightweight caller and dependency inference.`,
      impactedModules,
      impactedSymbols: [
        symbolContext.symbol,
        ...symbolContext.symbol.callTargets
          .map((target) => index.symbols.find((candidate) => candidate.id === target.symbolId))
          .filter((candidate): candidate is RepoSymbolRecord => candidate !== undefined),
      ].slice(0, MAX_IMPACTED_SYMBOLS),
      callers: symbolContext.callers.slice(0, MAX_IMPACTED_SYMBOLS),
      changedScope,
      freshness: buildFreshnessLabel(index),
      confidence: Math.min(0.6, Math.max(symbolContext.confidence - 0.04, 0.42)),
    };
  }

  const targetModule = findModuleMatch(index, options.module, options.path ?? options.targetPath);
  if (targetModule) {
    const impactedModuleIds = new Set<string>([
      targetModule.moduleId,
      ...targetModule.dependencies,
      ...targetModule.dependents,
    ]);
    const impactedModules = index.modules.filter((module) => impactedModuleIds.has(module.moduleId));
    const impactedSymbols = index.symbols
      .filter((symbol) => impactedModules.some((module) => module.moduleId === symbol.moduleId))
      .slice(0, MAX_IMPACTED_SYMBOLS);
    return {
      target: {
        kind: options.path ? 'path' : 'module',
        label: options.path ?? targetModule.label,
        moduleId: targetModule.moduleId,
        filePath: options.path,
      },
      summary: `Fallback impact suggests changes around ${options.path ?? targetModule.label} may affect ${impactedModules.length} module(s) via coarse dependency heuristics.`,
      impactedModules,
      impactedSymbols,
      callers: [],
      changedScope,
      freshness: buildFreshnessLabel(index),
      confidence: Math.max(0.36, targetModule.confidence - 0.08),
    };
  }

  throw new Error('No impact target could be inferred from the provided module/path/symbol inputs.');
}

export async function getRepoRoutingSignals(
  context: RepoContext,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<KodaXRepoRoutingSignals> {
  const index = await getRepoIntelligenceIndex(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const snapshot = await resolveRepoOverviewSnapshot(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const changedScope = snapshot.source === 'git'
    ? await analyzeChangedScopeFromSnapshot(snapshot, { scope: 'all' }).catch(() => undefined)
    : undefined;
  const activeModule = findModuleMatch(index, undefined, options.targetPath);
  const touchedModuleIds = new Set(changedScope?.areasTouched.map((area) => area.areaId) ?? []);
  if (activeModule?.moduleId) {
    touchedModuleIds.add(activeModule.moduleId);
  }
  const touchedModuleCount = Math.max(1, touchedModuleIds.size);
  const changedFileCount = changedScope?.totalChangedFiles ?? 0;
  const changedLineCount = changedScope?.changedLineCount ?? 0;
  const reviewScale = deriveReviewScale(changedFileCount, changedLineCount, touchedModuleCount);
  const impactedModuleCount = activeModule
    ? new Set([activeModule.moduleId, ...activeModule.dependencies, ...activeModule.dependents]).size
    : touchedModuleCount;
  const predominantCapabilityTier = activeModule?.languages[0]?.capabilityTier
    ?? index.languages[0]?.capabilityTier
    ?? 'low';

  return {
    workspaceRoot: index.workspaceRoot,
    changedFileCount,
    changedLineCount,
    addedLineCount: changedScope?.addedLineCount ?? 0,
    deletedLineCount: changedScope?.deletedLineCount ?? 0,
    touchedModuleCount,
    changedModules: Array.from(touchedModuleIds.values()),
    crossModule: touchedModuleCount > 1,
    reviewScale,
    riskHints: [
      ...(changedScope?.riskHints ?? []),
      'Fallback repo routing uses OSS baseline heuristics.',
    ],
    activeModuleId: activeModule?.moduleId,
    activeModuleConfidence: activeModule ? Math.max(0.3, activeModule.confidence - 0.08) : 0.22,
    activeImpactConfidence: activeModule ? Math.max(0.28, activeModule.confidence - 0.12) : 0.18,
    impactedModuleCount,
    impactedSymbolCount: activeModule?.topSymbols.length ?? 0,
    predominantCapabilityTier,
    suggestedComplexity: deriveRoutingComplexity(
      changedFileCount,
      changedLineCount,
      touchedModuleCount,
      impactedModuleCount,
    ),
    plannerBias: changedLineCount >= 400 || touchedModuleCount >= 3,
    investigationBias: changedFileCount === 0 || !activeModule,
    lowConfidence: true,
  };
}

export function renderModuleContext(result: ModuleContextResult): string {
  const { module } = result;
  return [
    `Module context for ${module.label}`,
    `Module: ${module.moduleId} [${module.kind}]`,
    `Freshness: ${result.freshness}`,
    `Confidence: ${confidenceLabel(result.confidence)} (${result.confidence.toFixed(2)})`,
    `Files: ${module.fileCount} total | ${module.sourceFileCount} source | ${module.symbolCount} symbols`,
    `Languages: ${module.languages.map((language) => `${language.language}/${language.capabilityTier}:${language.fileCount}`).join(' | ') || 'none'}`,
    `Dependencies: ${module.dependencies.join(' | ') || 'none'}`,
    `Dependents: ${module.dependents.join(' | ') || 'none'}`,
    `Entry files: ${module.entryFiles.join(' | ') || 'none'}`,
    `Top symbols: ${module.topSymbols.join(' | ') || 'none'}`,
    `Tests: ${module.keyTests.join(' | ') || 'none'}`,
    `Docs: ${module.keyDocs.join(' | ') || 'none'}`,
    `Processes: ${module.processIds.join(' | ') || 'none'}`,
    `Evidence: ${result.evidence.join(' | ') || 'none'}`,
    ...buildRepoIntelligenceMetadataLines(result),
  ].join('\n');
}

export function renderSymbolContext(result: SymbolContextResult): string {
  const { symbol } = result;
  return [
    `Symbol context for ${symbol.name}`,
    `Definition: ${symbol.filePath}:${symbol.line}`,
    `Module: ${symbol.moduleId} | Kind: ${symbol.kind} | Exported: ${symbol.exported ? 'yes' : 'no'}`,
    `Language: ${symbol.language}/${symbol.capabilityTier}`,
    `Freshness: ${result.freshness}`,
    `Confidence: ${confidenceLabel(result.confidence)} (${result.confidence.toFixed(2)})`,
    `Signature: ${symbol.signature}`,
    `Possible callees: ${symbol.callTargets.map((target) => `${target.name} -> ${target.filePath}`).join(' | ') || 'none'}`,
    `Possible callers: ${result.callers.map((caller) => `${caller.name} -> ${caller.filePath}`).join(' | ') || 'none'}`,
    `Imports: ${symbol.importPaths.join(' | ') || 'none'}`,
    result.alternatives.length > 0
      ? `Alternatives: ${result.alternatives.map((candidate) => `${candidate.name} @ ${candidate.filePath}:${candidate.line}`).join(' | ')}`
      : 'Alternatives: none',
    ...buildRepoIntelligenceMetadataLines(result),
  ].join('\n');
}

export function renderProcessContext(result: ProcessContextResult): string {
  const { process } = result;
  return [
    `Process context for ${process.label}`,
    `Module: ${process.moduleId}`,
    `Entry: ${process.entryFile}${process.entrySymbol ? ` -> ${process.entrySymbol}` : ''}`,
    `Freshness: ${result.freshness}`,
    `Confidence: ${confidenceLabel(result.confidence)} (${result.confidence.toFixed(2)})`,
    `Summary: ${process.summary}`,
    'Steps:',
    ...process.steps.map((step) => `- ${step.kind} ${step.symbolName} @ ${step.filePath}${step.line ? `:${step.line}` : ''} | ${step.note}`),
    result.alternatives.length > 0
      ? `Alternatives: ${result.alternatives.map((candidate) => candidate.label).join(' | ')}`
      : 'Alternatives: none',
    ...buildRepoIntelligenceMetadataLines(result),
  ].join('\n');
}

export function renderImpactEstimate(result: ImpactEstimateResult): string {
  return [
    `Impact estimate for ${result.target.label}`,
    `Target: ${result.target.kind}${result.target.moduleId ? ` | module=${result.target.moduleId}` : ''}${result.target.filePath ? ` | file=${result.target.filePath}` : ''}`,
    `Freshness: ${result.freshness}`,
    `Confidence: ${confidenceLabel(result.confidence)} (${result.confidence.toFixed(2)})`,
    `Summary: ${result.summary}`,
    `Impacted modules: ${result.impactedModules.map((module) => `${module.label}(${module.moduleId})`).join(' | ') || 'none'}`,
    `Impacted symbols: ${result.impactedSymbols.map((symbol) => `${symbol.name} -> ${symbol.filePath}:${symbol.line}`).join(' | ') || 'none'}`,
    `Possible callers: ${result.callers.map((caller) => `${caller.name} -> ${caller.filePath}:${caller.line}`).join(' | ') || 'none'}`,
    result.changedScope
      ? `Changed-scope overlap: ${result.changedScope.files.filter((file) =>
        result.impactedModules.some((module) => module.moduleId === file.areaId)
        || result.impactedSymbols.some((symbol) => symbol.filePath === file.path),
      ).length} file(s)`
      : 'Changed-scope overlap: unavailable',
    ...buildRepoIntelligenceMetadataLines(result),
  ].join('\n');
}
