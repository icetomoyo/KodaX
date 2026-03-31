import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';
import { parser as goParser } from '@lezer/go';
import { parser as pythonParser } from '@lezer/python';
import { parser as rustParser } from '@lezer/rust';
import type { SyntaxNode } from '@lezer/common';
import ts from 'typescript';
import type { KodaXRepoRoutingSignals, KodaXToolExecutionContext } from '../types.js';
import {
  analyzeChangedScopeFromSnapshot,
  collectWorkspaceFilesForSource,
  type ChangedScopeReport,
  type RepoAreaKind,
  type RepoAreaOverview,
  type RepoOverview,
  type RepoOverviewInventory,
  type RepoOverviewSnapshot,
  resolveRepoOverviewSnapshot,
} from './index.js';
import { debugLogRepoIntelligence, safeReadJson } from './internal.js';

const REPO_INTELLIGENCE_DIR = path.join('.agent', 'repo-intelligence');
const QUERY_INDEX_FILE = 'repo-intelligence-index.json';
const QUERY_MANIFEST_FILE = 'repo-intelligence-manifest.json';
const FILE_ANALYSIS_INDEX_FILE = 'file-analysis-index.json';
const DIRTY_SOURCE_HINT_FILE = 'repo-intelligence-dirty-source-hint.json';
const MODULE_INDEX_FILE = 'module-index.json';
const SYMBOL_INDEX_FILE = 'symbol-index.json';
const PROCESS_INDEX_FILE = 'process-index.json';
const QUERY_SCHEMA_VERSION = 9;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SYMBOLS_PER_FILE = 40;
const MAX_PROCESS_STEPS = 8;
const MAX_RELATED_RESULTS = 8;
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.cpp', '.cc', '.cxx', '.c', '.hpp', '.h',
]);
const CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'sizeof', 'new',
  'function', 'class', 'def', 'await', 'yield', 'super', 'import', 'from',
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
}

interface RepoIntelligenceManifest {
  schemaVersion: number;
  workspaceRoot: string;
  generatedAt: string;
  overviewGeneratedAt: string;
  overviewFingerprint: string;
  workspaceSnapshot: RepoWorkspaceSnapshot;
  sourceFileCount: number;
  sourceFingerprint: string;
  languageBreakdown: RepoLanguageSupport[];
  sourceStates: RepoSourceFileState[];
}

interface ExtractedSymbol {
  name: string;
  kind: RepoSymbolKind;
  line: number;
  signature: string;
  exported: boolean;
  confidenceBoost: number;
  qualifier?: string;
  calls?: string[];
}

interface FileAnalysis {
  filePath: string;
  moduleId: string;
  language: RepoLanguageId;
  capabilityTier: LanguageCapabilityTier;
  importPaths: string[];
  symbols: RepoSymbolRecord[];
}

interface RepoSourceFileState {
  filePath: string;
  fileFingerprint: string;
  language: RepoLanguageId;
  moduleId: string;
  analyzerVersion: number;
}

interface RepoWorkspaceSnapshot {
  source: 'git' | 'filesystem';
  branch?: string;
  head?: string;
  hasUncommittedChanges?: boolean;
}

interface CachedRepoSymbolRecord {
  id: string;
  name: string;
  qualifiedName: string;
  kind: RepoSymbolKind;
  line: number;
  signature: string;
  exported: boolean;
  calls: string[];
  confidence: number;
}

interface CachedFileAnalysisEntry {
  importPaths: string[];
  symbols: CachedRepoSymbolRecord[];
}

interface FileAnalysisIndexPayload {
  schemaVersion: number;
  workspaceRoot: string;
  generatedAt: string;
  sourceFingerprint: string;
  analyses: Record<string, CachedFileAnalysisEntry | null>;
}

interface DirtySourceHintPayload {
  schemaVersion: number;
  workspaceRoot: string;
  branch?: string;
  head?: string;
  queryGeneratedAt: string;
  overviewFingerprint: string;
  sourceFingerprint: string;
  sourceFileCount: number;
  dirtyPathsFingerprint: string;
  dirtySourceFingerprint: string;
  dirtySourcePaths: string[];
}

interface TypeScriptSymbolDraft {
  record: RepoSymbolRecord;
  declaration: ts.Node;
  body?: ts.Node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRepoIntelligenceIndexPayload(value: unknown): value is RepoIntelligenceIndex {
  return isRecord(value)
    && typeof value.schemaVersion === 'number'
    && typeof value.workspaceRoot === 'string'
    && typeof value.generatedAt === 'string'
    && typeof value.overviewGeneratedAt === 'string'
    && typeof value.sourceFileCount === 'number'
    && typeof value.sourceFingerprint === 'string'
    && Array.isArray(value.languages)
    && Array.isArray(value.modules)
    && Array.isArray(value.symbols)
    && Array.isArray(value.processes);
}

function isRepoLanguageId(value: unknown): value is RepoLanguageId {
  return value === 'typescript'
    || value === 'javascript'
    || value === 'python'
    || value === 'java'
    || value === 'go'
    || value === 'rust'
    || value === 'cpp'
    || value === 'unknown';
}

function isLanguageCapabilityTier(value: unknown): value is LanguageCapabilityTier {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isRepoSymbolKind(value: unknown): value is RepoSymbolKind {
  return value === 'function'
    || value === 'class'
    || value === 'interface'
    || value === 'type'
    || value === 'enum'
    || value === 'struct'
    || value === 'trait'
    || value === 'method'
    || value === 'constant';
}

function isRepoLanguageSupportPayload(value: unknown): value is RepoLanguageSupport {
  return isRecord(value)
    && isRepoLanguageId(value.language)
    && isLanguageCapabilityTier(value.capabilityTier)
    && typeof value.fileCount === 'number';
}

function isRepoSymbolReferencePayload(value: unknown): value is RepoSymbolReference {
  return isRecord(value)
    && typeof value.symbolId === 'string'
    && typeof value.name === 'string'
    && typeof value.filePath === 'string'
    && typeof value.moduleId === 'string'
    && (value.reason === 'same-module' || value.reason === 'imported-module' || value.reason === 'name-match');
}

function isRepoSymbolRecordPayload(value: unknown): value is RepoSymbolRecord {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.qualifiedName === 'string'
    && isRepoSymbolKind(value.kind)
    && typeof value.filePath === 'string'
    && typeof value.moduleId === 'string'
    && isRepoLanguageId(value.language)
    && isLanguageCapabilityTier(value.capabilityTier)
    && typeof value.line === 'number'
    && typeof value.signature === 'string'
    && typeof value.exported === 'boolean'
    && Array.isArray(value.calls)
    && value.calls.every((call) => typeof call === 'string')
    && Array.isArray(value.callTargets)
    && value.callTargets.every((target) => isRepoSymbolReferencePayload(target))
    && Array.isArray(value.importPaths)
    && value.importPaths.every((importPath) => typeof importPath === 'string')
    && typeof value.confidence === 'number';
}

function isRepoSourceFileStatePayload(value: unknown): value is RepoSourceFileState {
  return isRecord(value)
    && typeof value.filePath === 'string'
    && typeof value.fileFingerprint === 'string'
    && isRepoLanguageId(value.language)
    && typeof value.moduleId === 'string'
    && typeof value.analyzerVersion === 'number';
}

function isRepoWorkspaceSnapshotPayload(value: unknown): value is RepoWorkspaceSnapshot {
  return isRecord(value)
    && (value.source === 'git' || value.source === 'filesystem')
    && (value.branch === undefined || typeof value.branch === 'string')
    && (value.head === undefined || typeof value.head === 'string')
    && (value.hasUncommittedChanges === undefined || typeof value.hasUncommittedChanges === 'boolean');
}

function isRepoIntelligenceManifestPayload(value: unknown): value is RepoIntelligenceManifest {
  return isRecord(value)
    && typeof value.schemaVersion === 'number'
    && typeof value.workspaceRoot === 'string'
    && typeof value.generatedAt === 'string'
    && typeof value.overviewGeneratedAt === 'string'
    && typeof value.overviewFingerprint === 'string'
    && isRepoWorkspaceSnapshotPayload(value.workspaceSnapshot)
    && typeof value.sourceFileCount === 'number'
    && typeof value.sourceFingerprint === 'string'
    && Array.isArray(value.languageBreakdown)
    && value.languageBreakdown.every((entry) => isRepoLanguageSupportPayload(entry))
    && Array.isArray(value.sourceStates)
    && value.sourceStates.every((entry) => isRepoSourceFileStatePayload(entry));
}

function isCachedRepoSymbolRecordPayload(value: unknown): value is CachedRepoSymbolRecord {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.qualifiedName === 'string'
    && isRepoSymbolKind(value.kind)
    && typeof value.line === 'number'
    && typeof value.signature === 'string'
    && typeof value.exported === 'boolean'
    && Array.isArray(value.calls)
    && value.calls.every((call) => typeof call === 'string')
    && typeof value.confidence === 'number';
}

function isCachedFileAnalysisEntryPayload(value: unknown): value is CachedFileAnalysisEntry {
  return isRecord(value)
    && Array.isArray(value.importPaths)
    && value.importPaths.every((importPath) => typeof importPath === 'string')
    && Array.isArray(value.symbols)
    && value.symbols.every((symbol) => isCachedRepoSymbolRecordPayload(symbol));
}

function isFileAnalysisIndexPayload(value: unknown): value is FileAnalysisIndexPayload {
  return isRecord(value)
    && typeof value.schemaVersion === 'number'
    && typeof value.workspaceRoot === 'string'
    && typeof value.generatedAt === 'string'
    && typeof value.sourceFingerprint === 'string'
    && isRecord(value.analyses)
    && Object.values(value.analyses).every((analysis) => analysis === null || isCachedFileAnalysisEntryPayload(analysis));
}

function isDirtySourceHintPayload(value: unknown): value is DirtySourceHintPayload {
  return isRecord(value)
    && typeof value.schemaVersion === 'number'
    && typeof value.workspaceRoot === 'string'
    && (value.branch === undefined || typeof value.branch === 'string')
    && (value.head === undefined || typeof value.head === 'string')
    && typeof value.queryGeneratedAt === 'string'
    && typeof value.overviewFingerprint === 'string'
    && typeof value.sourceFingerprint === 'string'
    && typeof value.sourceFileCount === 'number'
    && typeof value.dirtyPathsFingerprint === 'string'
    && typeof value.dirtySourceFingerprint === 'string'
    && Array.isArray(value.dirtySourcePaths)
    && value.dirtySourcePaths.every((filePath) => typeof filePath === 'string');
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function languageFromFile(filePath: string): RepoLanguageId {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
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
    case '.java':
      return 'java';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
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

function analyzerVersionForLanguage(language: RepoLanguageId): number {
  switch (language) {
    case 'typescript':
    case 'javascript':
    case 'python':
    case 'java':
    case 'go':
    case 'rust':
    case 'cpp':
    case 'unknown':
    default:
      return 1;
  }
}

function baseConfidenceForTier(tier: LanguageCapabilityTier): number {
  switch (tier) {
    case 'high':
      return 0.86;
    case 'medium':
      return 0.74;
    case 'low':
    default:
      return 0.58;
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

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureStorageDir(workspaceRoot: string): Promise<string> {
  const storageRoot = path.join(workspaceRoot, REPO_INTELLIGENCE_DIR);
  await fs.mkdir(storageRoot, { recursive: true });
  return storageRoot;
}

interface SourceFileBuckets {
  typeScriptFiles: string[];
  pythonFiles: string[];
  goFiles: string[];
  rustFiles: string[];
  fallbackFiles: string[];
}

interface RepoIntelligenceWorkspaceInputs {
  overview: RepoOverview;
  overviewFingerprint: string;
  workspaceSnapshot: RepoWorkspaceSnapshot;
  inventory: RepoOverviewInventory | null;
  workspaceRoot: string;
  storageRoot: string;
  allFiles: string[];
  areaByFile: Map<string, RepoAreaOverview>;
  filesByAreaId: Map<string, string[]>;
  testFilesByAreaId: Map<string, string[]>;
  docFilesByAreaId: Map<string, string[]>;
  sourceFiles: string[];
  sourceStates?: RepoSourceFileState[];
  sourceFingerprint?: string;
  sourceFileSet: Set<string>;
  dirtyPaths?: string[];
  dirtyPathsFingerprint?: string;
  dirtySourceFingerprint?: string;
  dirtySourceStateMap?: Map<string, RepoSourceFileState>;
  moduleAliases: Map<string, string>;
  buckets: SourceFileBuckets;
}

interface RepoIntelligencePreflight {
  workspaceRoot: string;
  storageRoot: string;
  workspaceSnapshot: RepoWorkspaceSnapshot;
  overviewGeneratedAt: string;
  dirtyPaths?: string[];
  dirtyPathsFingerprint?: string;
  dirtySourcePaths: string[];
  dirtySourceStateMap?: Map<string, RepoSourceFileState>;
  dirtySourceFingerprint?: string;
}

function computeFileFingerprint(
  filePath: string,
  size: number,
  mtimeMs: number,
): string {
  return createHash('sha256')
    .update(normalizeRelativePath(filePath))
    .update(':')
    .update(String(size))
    .update(':')
    .update(String(Math.trunc(mtimeMs)))
    .digest('hex');
}

function computeSourceFingerprint(
  sourceStates: RepoSourceFileState[],
): string {
  const hash = createHash('sha256');
  for (const state of sourceStates) {
    hash.update(state.filePath);
    hash.update(':');
    hash.update(state.fileFingerprint);
    hash.update('|');
  }
  return hash.digest('hex');
}

function computeOverviewFingerprint(
  overview: RepoOverview,
  allFiles: string[],
): string {
  const hash = createHash('sha256');
  hash.update(overview.workspaceRoot);
  hash.update('|');
  hash.update(overview.source);
  hash.update('|');
  for (const area of overview.areas) {
    hash.update(area.id);
    hash.update(':');
    hash.update(area.label);
    hash.update(':');
    hash.update(area.kind);
    hash.update(':');
    hash.update(area.root);
    hash.update(':');
    hash.update(String(area.fileCount));
    hash.update(':');
    hash.update(area.manifests.join(','));
    hash.update(':');
    hash.update(area.sampleFiles.join(','));
    hash.update('|');
  }
  for (const filePath of allFiles) {
    hash.update(filePath);
    hash.update('|');
  }
  return hash.digest('hex');
}

function computePathFingerprint(
  filePaths: Iterable<string>,
): string {
  const hash = createHash('sha256');
  for (const filePath of Array.from(filePaths, (entry) => normalizeRelativePath(entry)).sort((left, right) => left.localeCompare(right))) {
    hash.update(filePath);
    hash.update('|');
  }
  return hash.digest('hex');
}

function workspaceSnapshotFromOverview(overview: RepoOverview): RepoWorkspaceSnapshot {
  return {
    source: overview.source,
    branch: overview.git?.branch,
    head: overview.git?.head,
    hasUncommittedChanges: overview.git?.hasUncommittedChanges,
  };
}

function isCleanGitSnapshot(snapshot: RepoWorkspaceSnapshot): boolean {
  return snapshot.source === 'git' && snapshot.hasUncommittedChanges !== true;
}

function sameWorkspaceSnapshot(
  left: RepoWorkspaceSnapshot,
  right: RepoWorkspaceSnapshot,
): boolean {
  return left.source === right.source
    && left.branch === right.branch
    && left.head === right.head
    && left.hasUncommittedChanges === right.hasUncommittedChanges;
}

function shouldPersistRepoIntelligenceBaseline(
  inputs: RepoIntelligenceWorkspaceInputs,
): boolean {
  return inputs.workspaceSnapshot.source !== 'git' || isCleanGitSnapshot(inputs.workspaceSnapshot);
}

function getDirtySourcePathsForInputs(
  inputs: Pick<RepoIntelligenceWorkspaceInputs, 'dirtyPaths' | 'sourceFileSet'>,
): string[] {
  return (inputs.dirtyPaths ?? [])
    .filter((filePath) => inputs.sourceFileSet.has(filePath))
    .sort((left, right) => left.localeCompare(right));
}

async function buildRepoIntelligencePreflight(
  snapshot: RepoOverviewSnapshot,
): Promise<RepoIntelligencePreflight> {
  const workspaceRoot = snapshot.workspaceRoot;
  const storageRoot = await ensureStorageDir(workspaceRoot);
  const workspaceSnapshot = workspaceSnapshotFromOverview(snapshot.overview);
  const dirtyPaths = snapshot.dirtyPaths
    ? Array.from(new Set(snapshot.dirtyPaths.map((filePath) => normalizeRelativePath(filePath))))
      .sort((left, right) => left.localeCompare(right))
    : undefined;
  const dirtyPathsFingerprint = dirtyPaths
    ? computePathFingerprint(dirtyPaths)
    : undefined;
  const dirtySourcePaths = (dirtyPaths ?? [])
    .filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));
  const existingDirtySourcePaths: string[] = [];
  for (const filePath of dirtySourcePaths) {
    if (await exists(path.join(workspaceRoot, filePath))) {
      existingDirtySourcePaths.push(filePath);
    }
  }
  const dirtySourceStateMap = existingDirtySourcePaths.length > 0
    ? await collectSourceFileStateMap(
      workspaceRoot,
      existingDirtySourcePaths,
      new Map<string, RepoAreaOverview>(),
      snapshot.overview.areas,
    )
    : undefined;

  return {
    workspaceRoot,
    storageRoot,
    workspaceSnapshot,
    overviewGeneratedAt: snapshot.overview.generatedAt,
    dirtyPaths,
    dirtyPathsFingerprint,
    dirtySourcePaths,
    dirtySourceStateMap,
    dirtySourceFingerprint: dirtyPaths
      ? computeSourceFingerprint(
        dirtySourceStateMap
          ? Array.from(dirtySourceStateMap.values()).sort((left, right) => left.filePath.localeCompare(right.filePath))
          : [],
      )
      : undefined,
  };
}

async function collectSourceFileStates(
  workspaceRoot: string,
  sourceFiles: string[],
  areaByFile: Map<string, RepoAreaOverview>,
  overviewAreas: RepoAreaOverview[],
): Promise<RepoSourceFileState[]> {
  const states: RepoSourceFileState[] = [];
  for (const filePath of sourceFiles) {
    const normalizedFilePath = normalizeRelativePath(filePath);
    const stat = await fs.stat(path.join(workspaceRoot, normalizedFilePath));
    const language = languageFromFile(normalizedFilePath);
    states.push({
      filePath: normalizedFilePath,
      fileFingerprint: computeFileFingerprint(normalizedFilePath, stat.size, stat.mtimeMs),
      language,
      moduleId: areaByFile.get(normalizedFilePath)?.id ?? findAreaForFile(normalizedFilePath, overviewAreas).id,
      analyzerVersion: analyzerVersionForLanguage(language),
    });
  }
  return states.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

async function collectSourceFileStateMap(
  workspaceRoot: string,
  sourceFiles: Iterable<string>,
  areaByFile: Map<string, RepoAreaOverview>,
  overviewAreas: RepoAreaOverview[],
): Promise<Map<string, RepoSourceFileState>> {
  const normalizedFiles = Array.from(new Set(
    Array.from(sourceFiles, (filePath) => normalizeRelativePath(filePath)),
  )).sort((left, right) => left.localeCompare(right));
  const states = await collectSourceFileStates(workspaceRoot, normalizedFiles, areaByFile, overviewAreas);
  return new Map(states.map((state) => [state.filePath, state]));
}

function serializeCachedFileAnalysisEntry(analysis: FileAnalysis | null): CachedFileAnalysisEntry | null {
  if (!analysis) {
    return null;
  }

  return {
    importPaths: analysis.importPaths,
    symbols: analysis.symbols.map((symbol) => ({
      id: symbol.id,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      kind: symbol.kind,
      line: symbol.line,
      signature: symbol.signature,
      exported: symbol.exported,
      calls: symbol.calls,
      confidence: symbol.confidence,
    })),
  };
}

function hydrateCachedFileAnalysis(
  filePath: string,
  state: RepoSourceFileState,
  cached: CachedFileAnalysisEntry | null,
): FileAnalysis | null {
  if (!cached) {
    return null;
  }

  return {
    filePath,
    moduleId: state.moduleId,
    language: state.language,
    capabilityTier: capabilityTierForLanguage(state.language),
    importPaths: cached.importPaths,
    symbols: cached.symbols.map((symbol) => ({
      ...symbol,
      filePath,
      moduleId: state.moduleId,
      language: state.language,
      capabilityTier: capabilityTierForLanguage(state.language),
      importPaths: cached.importPaths,
      callTargets: [],
    })),
  };
}

function bucketSourceFiles(sourceFiles: string[]): SourceFileBuckets {
  return {
    typeScriptFiles: sourceFiles.filter((filePath) => isTypeScriptLikeLanguage(languageFromFile(filePath))),
    pythonFiles: sourceFiles.filter((filePath) => languageFromFile(filePath) === 'python'),
    goFiles: sourceFiles.filter((filePath) => languageFromFile(filePath) === 'go'),
    rustFiles: sourceFiles.filter((filePath) => languageFromFile(filePath) === 'rust'),
    fallbackFiles: sourceFiles.filter((filePath) => {
      const language = languageFromFile(filePath);
      return !isTypeScriptLikeLanguage(language) && language !== 'python' && language !== 'go' && language !== 'rust';
    }),
  };
}

function isTypeScriptLikeLanguage(language: RepoLanguageId): boolean {
  return language === 'typescript' || language === 'javascript';
}

function scriptKindFromFilePath(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
    default:
      return ts.ScriptKind.JS;
  }
}

function getNodeLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function getDeclarationKey(workspaceRoot: string, declaration: ts.Node): string {
  const sourceFile = declaration.getSourceFile();
  const lineAndCharacter = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile));
  const filePath = normalizeRelativePath(path.relative(workspaceRoot, sourceFile.fileName));
  return `${filePath}:${lineAndCharacter.line + 1}:${lineAndCharacter.character + 1}:${declaration.kind}`;
}

function getSignatureSnippet(sourceFile: ts.SourceFile, node: ts.Node): string {
  const start = node.getStart(sourceFile);
  const end = sourceFile.text.indexOf('\n', start);
  const snippet = sourceFile.text.slice(start, end === -1 ? undefined : end).trim();
  return snippet || node.getText(sourceFile).split(/\r?\n/, 1)[0]?.trim() || '<unknown>';
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function isExportedDeclaration(node: ts.Node): boolean {
  if (hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
    return true;
  }

  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent)) {
    return isExportedDeclaration(node.parent.parent);
  }

  return false;
}

function getPropertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) {
    return null;
  }

  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return null;
}

function getCallExpressionName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }

  return null;
}

function collectTypeScriptImportPaths(sourceFile: ts.SourceFile): string[] {
  const imports = new Set<string>();

  const addImport = (value: string | undefined): void => {
    if (value?.trim()) {
      imports.add(value.trim());
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        addImport(node.moduleSpecifier.text);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && reference.expression && ts.isStringLiteralLike(reference.expression)) {
        addImport(reference.expression.text);
      }
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      addImport(node.arguments[0]!.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return Array.from(imports).slice(0, 12);
}

function registerTypeScriptSymbol(
  workspaceRoot: string,
  drafts: TypeScriptSymbolDraft[],
  analysis: FileAnalysis,
  sourceFile: ts.SourceFile,
  declaration: ts.Node,
  name: string,
  kind: RepoSymbolKind,
  exported: boolean,
  confidenceBoost: number,
  declarationMap: Map<string, RepoSymbolRecord>,
  qualifier?: string,
): void {
  if (!name.trim()) {
    return;
  }

  const line = getNodeLine(sourceFile, declaration);
  const qualifiedName = qualifier ? `${analysis.filePath}:${qualifier}.${name}` : `${analysis.filePath}:${name}`;
  const record: RepoSymbolRecord = {
    id: `${analysis.filePath}#${qualifier ? `${qualifier}.` : ''}${name}:${line}`,
    name,
    qualifiedName,
    kind,
    filePath: analysis.filePath,
    moduleId: analysis.moduleId,
    language: analysis.language,
    capabilityTier: analysis.capabilityTier,
    line,
    signature: getSignatureSnippet(sourceFile, declaration),
    exported,
    calls: [],
    callTargets: [],
    importPaths: analysis.importPaths,
    confidence: Math.min(0.99, baseConfidenceForTier(analysis.capabilityTier) + confidenceBoost),
  };

  const duplicate = analysis.symbols.find((candidate) => candidate.id === record.id);
  if (duplicate) {
    return;
  }

  analysis.symbols.push(record);
  let body: ts.Node | undefined;
  if (
    ts.isFunctionDeclaration(declaration)
    || ts.isMethodDeclaration(declaration)
    || ts.isGetAccessorDeclaration(declaration)
    || ts.isSetAccessorDeclaration(declaration)
    || ts.isFunctionExpression(declaration)
    || ts.isArrowFunction(declaration)
  ) {
    body = declaration.body ?? undefined;
  } else if (ts.isVariableDeclaration(declaration)) {
    body = declaration.initializer ?? undefined;
  } else if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
    body = declaration;
  }

  drafts.push({
    record,
    declaration,
    body,
  });
  declarationMap.set(getDeclarationKey(workspaceRoot, declaration), record);
}

function resolveTypeScriptCallSymbol(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return checker.getSymbolAtLocation(expression.name) ?? checker.getSymbolAtLocation(expression);
  }

  if (ts.isElementAccessExpression(expression)) {
    return checker.getSymbolAtLocation(expression.argumentExpression) ?? checker.getSymbolAtLocation(expression);
  }

  return checker.getSymbolAtLocation(expression);
}

async function analyzeTypeScriptFiles(
  workspaceRoot: string,
  sourceFiles: string[],
  overviewAreas: RepoAreaOverview[],
  sourceFileSet: Set<string>,
  moduleAliases: Map<string, string>,
): Promise<FileAnalysis[]> {
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
    noEmit: true,
    allowSyntheticDefaultImports: true,
  };

  const rootNames = sourceFiles.map((filePath) => path.join(workspaceRoot, filePath));
  const program = ts.createProgram(rootNames, compilerOptions);
  const checker = program.getTypeChecker();
  const analyses = new Map<string, FileAnalysis>();
  const declarationMap = new Map<string, RepoSymbolRecord>();
  const drafts: TypeScriptSymbolDraft[] = [];

  for (const filePath of sourceFiles) {
    const language = languageFromFile(filePath);
    if (!isTypeScriptLikeLanguage(language)) {
      continue;
    }

    const sourceFile = program.getSourceFile(path.join(workspaceRoot, filePath));
    if (!sourceFile) {
      continue;
    }

    const analysis: FileAnalysis = {
      filePath,
      moduleId: findAreaForFile(filePath, overviewAreas).id,
      language,
      capabilityTier: capabilityTierForLanguage(language),
      importPaths: collectTypeScriptImportPaths(sourceFile),
      symbols: [],
    };
    analyses.set(filePath, analysis);

    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        registerTypeScriptSymbol(
          workspaceRoot,
          drafts,
          analysis,
          sourceFile,
          statement,
          statement.name.text,
          'function',
          isExportedDeclaration(statement),
          0.1,
          declarationMap,
        );
        continue;
      }

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const variableName = getPropertyNameText(declaration.name);
          if (!variableName) {
            continue;
          }
          if (
            declaration.initializer
            && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
          ) {
            registerTypeScriptSymbol(
              workspaceRoot,
              drafts,
              analysis,
              sourceFile,
              declaration,
              variableName,
              'function',
              isExportedDeclaration(declaration),
              0.08,
              declarationMap,
            );
          }
        }
        continue;
      }

      if (ts.isClassDeclaration(statement) && statement.name) {
        registerTypeScriptSymbol(
          workspaceRoot,
          drafts,
          analysis,
          sourceFile,
          statement,
          statement.name.text,
          'class',
          isExportedDeclaration(statement),
          0.1,
          declarationMap,
        );

        for (const member of statement.members) {
          if (
            (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
            && getPropertyNameText(member.name)
          ) {
            registerTypeScriptSymbol(
              workspaceRoot,
              drafts,
              analysis,
              sourceFile,
              member,
              getPropertyNameText(member.name)!,
              'method',
              false,
              0.05,
              declarationMap,
              statement.name.text,
            );
          }
        }
        continue;
      }

      if (ts.isInterfaceDeclaration(statement) && statement.name) {
        registerTypeScriptSymbol(
          workspaceRoot,
          drafts,
          analysis,
          sourceFile,
          statement,
          statement.name.text,
          'interface',
          isExportedDeclaration(statement),
          0.09,
          declarationMap,
        );
        continue;
      }

      if (ts.isTypeAliasDeclaration(statement) && statement.name) {
        registerTypeScriptSymbol(
          workspaceRoot,
          drafts,
          analysis,
          sourceFile,
          statement,
          statement.name.text,
          'type',
          isExportedDeclaration(statement),
          0.09,
          declarationMap,
        );
        continue;
      }

      if (ts.isEnumDeclaration(statement) && statement.name) {
        registerTypeScriptSymbol(
          workspaceRoot,
          drafts,
          analysis,
          sourceFile,
          statement,
          statement.name.text,
          'enum',
          isExportedDeclaration(statement),
          0.09,
          declarationMap,
        );
      }
    }
  }

  for (const draft of drafts) {
    const importedModules = new Set<string>();
    for (const importPath of draft.record.importPaths) {
      const resolvedModule = resolveImportToModule(
        importPath,
        draft.record.filePath,
        sourceFileSet,
        overviewAreas,
        moduleAliases,
      );
      if (resolvedModule) {
        importedModules.add(resolvedModule);
      }
    }

    const calls = new Set<string>();
    const preciseTargets = new Map<string, RepoSymbolReference>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = getCallExpressionName(node.expression);
        if (name && !CALL_KEYWORDS.has(name)) {
          calls.add(name);
        }

        const targetSymbol = resolveTypeScriptCallSymbol(checker, node.expression);
        const declaration = targetSymbol?.declarations?.[0];
        if (declaration) {
          const target = declarationMap.get(getDeclarationKey(workspaceRoot, declaration));
          if (target && target.id !== draft.record.id) {
            preciseTargets.set(target.id, {
              symbolId: target.id,
              name: target.name,
              filePath: target.filePath,
              moduleId: target.moduleId,
              reason: rankReferenceReason(draft.record.moduleId, target.moduleId, importedModules),
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(draft.body ?? draft.declaration);
    draft.record.calls = Array.from(calls).slice(0, 24);
    draft.record.callTargets = Array.from(preciseTargets.values()).slice(0, MAX_RELATED_RESULTS);
    draft.record.confidence = Math.min(0.99, draft.record.confidence + (draft.record.callTargets.length > 0 ? 0.03 : 0));
  }

  return Array.from(analyses.values());
}

function countOccurrences(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length;
}

function countBraceDelta(value: string): number {
  return countOccurrences(value, /\{/g) - countOccurrences(value, /\}/g);
}

function extractGoReceiverQualifier(receiver: string): string | undefined {
  const parts = receiver
    .replace(/[\*\[\]]/g, ' ')
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[parts.length - 1];
}

function normalizeRustQualifier(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const cleaned = raw
    .replace(/<[^>]+>/g, '')
    .split('::')
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1)
    ?.replace(/[&*]/g, '')
    .trim();
  return cleaned || undefined;
}

function extractSymbolBody(
  lines: string[],
  language: RepoLanguageId,
  entry: ExtractedSymbol,
  allEntries: ExtractedSymbol[],
  index: number,
): string {
  const startIndex = Math.max(0, entry.line - 1);
  const fallbackEndLine = Math.max(entry.line, (allEntries[index + 1]?.line ?? (lines.length + 1)) - 1);

  if (language === 'python') {
    const declarationIndent = lines[startIndex]?.match(/^\s*/)?.[0]?.length ?? 0;
    let endIndex = startIndex + 1;
    while (endIndex < lines.length) {
      const line = lines[endIndex] ?? '';
      const trimmed = line.trim();
      if (!trimmed) {
        endIndex += 1;
        continue;
      }
      const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
      if (indent <= declarationIndent && !trimmed.startsWith('#')) {
        break;
      }
      endIndex += 1;
    }
    return lines.slice(startIndex, endIndex).join('\n');
  }

  let braceDepth = 0;
  let openedBrace = false;
  let endIndex = startIndex;
  for (let cursor = startIndex; cursor < lines.length; cursor += 1) {
    const line = lines[cursor] ?? '';
    braceDepth += countBraceDelta(line);
    if (line.includes('{')) {
      openedBrace = true;
    }
    endIndex = cursor;
    if (openedBrace && braceDepth <= 0 && cursor > startIndex) {
      break;
    }
    if (!openedBrace && cursor + 1 >= fallbackEndLine) {
      break;
    }
  }

  const sliceEnd = openedBrace ? endIndex + 1 : fallbackEndLine;
  return lines.slice(startIndex, sliceEnd).join('\n');
}

function forEachSyntaxChild(
  node: Pick<SyntaxNode, 'firstChild'>,
  callback: (child: SyntaxNode) => void,
): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    callback(child);
  }
}

function getSyntaxNodeText(
  source: string,
  node: Pick<SyntaxNode, 'from' | 'to'>,
): string {
  return source.slice(node.from, node.to);
}

function getPythonNodeLine(
  source: string,
  node: Pick<SyntaxNode, 'from'>,
): number {
  return source.slice(0, node.from).split(/\r?\n/).length;
}

function getPythonSignature(
  lines: string[],
  line: number,
): string {
  return lines[line - 1]?.trim() || '<unknown>';
}

function collectPythonImports(
  source: string,
  topNode: Pick<SyntaxNode, 'firstChild'>,
): string[] {
  const imports: string[] = [];
  forEachSyntaxChild(topNode, (child) => {
    if (child.type.name !== 'ImportStatement') {
      return;
    }
    const text = getSyntaxNodeText(source, child).trim();
    let match = /^from\s+([.\w]+)\s+import\b/.exec(text);
    if (match?.[1]) {
      imports.push(match[1]);
      return;
    }
    match = /^import\s+(.+)$/.exec(text);
    if (match?.[1]) {
      imports.push(
        ...match[1]
          .split(',')
          .map((part) => part.trim().split(/\s+as\s+/i)[0] ?? '')
          .filter(Boolean),
      );
    }
  });
  return dedupeStrings(imports, 12);
}

function getPythonCallName(
  source: string,
  node: SyntaxNode,
): string | null {
  if (node.type.name === 'VariableName' || node.type.name === 'PropertyName') {
    return getSyntaxNodeText(source, node).trim() || null;
  }

  if (node.type.name === 'MemberExpression') {
    let propertyName: string | null = null;
    forEachSyntaxChild(node, (child) => {
      const candidate = getPythonCallName(source, child);
      if (candidate) {
        propertyName = candidate;
      }
    });
    return propertyName;
  }

  const firstChild = node.firstChild;
  return firstChild ? getPythonCallName(source, firstChild) : null;
}

function collectPythonCallNames(
  source: string,
  node: SyntaxNode,
): string[] {
  const calls = new Set<string>();
  const walk = (current: SyntaxNode): void => {
    if (current.type.name === 'CallExpression') {
      const callee = current.firstChild;
      const name = callee ? getPythonCallName(source, callee) : null;
      if (name && !CALL_KEYWORDS.has(name)) {
        calls.add(name);
      }
    }
    forEachSyntaxChild(current, walk);
  };
  walk(node);
  return Array.from(calls).slice(0, 24);
}

async function analyzePythonFiles(
  workspaceRoot: string,
  sourceFiles: string[],
  overviewAreas: RepoAreaOverview[],
): Promise<FileAnalysis[]> {
  const analyses: FileAnalysis[] = [];

  for (const filePath of sourceFiles) {
    const absolutePath = path.join(workspaceRoot, filePath);
    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_FILE_BYTES) {
      continue;
    }

    const content = await fs.readFile(absolutePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const tree = pythonParser.parse(content);
    const topNode = tree.topNode;
    const language = languageFromFile(filePath);
    const capabilityTier = capabilityTierForLanguage(language);
    const baseConfidence = baseConfidenceForTier(capabilityTier);
    const imports = collectPythonImports(content, topNode);
    const symbols: RepoSymbolRecord[] = [];
    const moduleId = findAreaForFile(filePath, overviewAreas).id;

    forEachSyntaxChild(topNode, (child) => {
      if (child.type.name === 'FunctionDefinition') {
        let functionName: string | null = null;
        forEachSyntaxChild(child, (member) => {
          if (member.type.name === 'VariableName' && !functionName) {
            functionName = getSyntaxNodeText(content, member).trim();
          }
        });

        if (!functionName) {
          return;
        }
        const resolvedFunctionName = functionName as string;

        const line = getPythonNodeLine(content, child);
        symbols.push({
          id: `${filePath}#${resolvedFunctionName}:${line}`,
          name: resolvedFunctionName,
          qualifiedName: `${filePath}:${resolvedFunctionName}`,
          kind: 'function',
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: !resolvedFunctionName.startsWith('_'),
          calls: collectPythonCallNames(content, child),
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.99, baseConfidence + 0.1),
        });
        return;
      }

      if (child.type.name !== 'ClassDefinition') {
        return;
      }

      let className: string | null = null;
      let classBody: typeof child | null = null;
      forEachSyntaxChild(child, (member) => {
        if (member.type.name === 'VariableName' && !className) {
          className = getSyntaxNodeText(content, member).trim();
        } else if (member.type.name === 'Body') {
          classBody = member;
        }
      });

      if (!className) {
        return;
      }
      const resolvedClassName = className as string;

      const classLine = getPythonNodeLine(content, child);
      symbols.push({
        id: `${filePath}#${resolvedClassName}:${classLine}`,
        name: resolvedClassName,
        qualifiedName: `${filePath}:${resolvedClassName}`,
        kind: 'class',
        filePath,
        moduleId,
        language,
        capabilityTier,
        line: classLine,
        signature: getPythonSignature(lines, classLine),
        exported: !resolvedClassName.startsWith('_'),
        calls: [],
        callTargets: [],
        importPaths: imports,
        confidence: Math.min(0.99, baseConfidence + 0.08),
      });

      if (!classBody) {
        return;
      }

      forEachSyntaxChild(classBody, (member) => {
        if (member.type.name !== 'FunctionDefinition') {
          return;
        }

        let methodName: string | null = null;
        forEachSyntaxChild(member, (part) => {
          if (part.type.name === 'VariableName' && !methodName) {
            methodName = getSyntaxNodeText(content, part).trim();
          }
        });

        if (!methodName) {
          return;
        }
        const resolvedMethodName = methodName as string;

        const line = getPythonNodeLine(content, member);
        symbols.push({
          id: `${filePath}#${resolvedClassName}.${resolvedMethodName}:${line}`,
          name: resolvedMethodName,
          qualifiedName: `${filePath}:${resolvedClassName}.${resolvedMethodName}`,
          kind: 'method',
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: !resolvedMethodName.startsWith('_'),
          calls: collectPythonCallNames(content, member),
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.99, baseConfidence + 0.06),
        });
      });
    });

    analyses.push({
      filePath,
      moduleId,
      language,
      capabilityTier,
      importPaths: imports,
      symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE),
    });
  }

  return analyses;
}

function findFirstSyntaxChild(
  node: Pick<SyntaxNode, 'firstChild'>,
  predicate: (child: SyntaxNode) => boolean,
): SyntaxNode | null {
  let matched: SyntaxNode | null = null;
  forEachSyntaxChild(node, (child) => {
    if (!matched && predicate(child)) {
      matched = child;
    }
  });
  return matched;
}

function findLastSyntaxChild(
  node: Pick<SyntaxNode, 'firstChild'>,
  predicate: (child: SyntaxNode) => boolean,
): SyntaxNode | null {
  let matched: SyntaxNode | null = null;
  forEachSyntaxChild(node, (child) => {
    if (predicate(child)) {
      matched = child;
    }
  });
  return matched;
}

function findSyntaxDescendant(
  node: SyntaxNode,
  predicate: (child: SyntaxNode) => boolean,
): SyntaxNode | null {
  if (predicate(node)) {
    return node;
  }

  let matched: SyntaxNode | null = null;
  forEachSyntaxChild(node, (child) => {
    if (!matched) {
      matched = findSyntaxDescendant(child, predicate);
    }
  });
  return matched;
}

function collectLezerCallNames(
  source: string,
  node: SyntaxNode,
  getCallName: (source: string, node: SyntaxNode) => string | null,
): string[] {
  const calls = new Set<string>();
  const walk = (current: SyntaxNode): void => {
    if (current.type.name === 'CallExpr' || current.type.name === 'CallExpression') {
      const callee = current.firstChild;
      const name = callee ? getCallName(source, callee) : null;
      if (name && !CALL_KEYWORDS.has(name)) {
        calls.add(name);
      }
    }
    forEachSyntaxChild(current, walk);
  };
  walk(node);
  return Array.from(calls).slice(0, 24);
}

function getGoCallName(source: string, node: SyntaxNode): string | null {
  if (
    node.type.name === 'VariableName'
    || node.type.name === 'FieldName'
    || node.type.name === 'TypeName'
  ) {
    return getSyntaxNodeText(source, node).trim() || null;
  }

  if (node.type.name === 'SelectorExpr') {
    let selector: string | null = null;
    forEachSyntaxChild(node, (child) => {
      const candidate = getGoCallName(source, child);
      if (candidate) {
        selector = candidate;
      }
    });
    return selector;
  }

  const firstChild = node.firstChild;
  return firstChild ? getGoCallName(source, firstChild) : null;
}

function getRustCallName(source: string, node: SyntaxNode): string | null {
  if (
    node.type.name === 'Identifier'
    || node.type.name === 'FieldIdentifier'
    || node.type.name === 'TypeIdentifier'
    || node.type.name === 'BoundIdentifier'
  ) {
    return getSyntaxNodeText(source, node).trim() || null;
  }

  if (node.type.name === 'FieldExpression') {
    let selector: string | null = null;
    forEachSyntaxChild(node, (child) => {
      const candidate = getRustCallName(source, child);
      if (candidate) {
        selector = candidate;
      }
    });
    return selector;
  }

  const firstChild = node.firstChild;
  return firstChild ? getRustCallName(source, firstChild) : null;
}

function findSyntaxNodeText(
  source: string,
  node: Pick<SyntaxNode, 'firstChild'>,
  typeName: string,
): string | null {
  const matched = findFirstSyntaxChild(node, (child) => child.type.name === typeName);
  return matched ? getSyntaxNodeText(source, matched).trim() : null;
}

function isRustExported(source: string, node: Pick<SyntaxNode, 'from' | 'to'>): boolean {
  return /^pub(?:\([^)]*\))?\s/.test(getSyntaxNodeText(source, node).trimStart());
}

async function analyzeGoFiles(
  workspaceRoot: string,
  sourceFiles: string[],
  overviewAreas: RepoAreaOverview[],
): Promise<FileAnalysis[]> {
  const analyses: FileAnalysis[] = [];

  for (const filePath of sourceFiles) {
    const absolutePath = path.join(workspaceRoot, filePath);
    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_FILE_BYTES) {
      continue;
    }

    const content = await fs.readFile(absolutePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const tree = goParser.parse(content);
    const moduleId = findAreaForFile(filePath, overviewAreas).id;
    const language = languageFromFile(filePath);
    const capabilityTier = capabilityTierForLanguage(language);
    const baseConfidence = baseConfidenceForTier(capabilityTier);
    const imports = extractImports(content, language);
    const symbols: RepoSymbolRecord[] = [];

    forEachSyntaxChild(tree.topNode, (child) => {
      if (child.type.name === 'TypeDecl') {
        const typeSpec = findFirstSyntaxChild(child, (member) => member.type.name === 'TypeSpec');
        const typeName = typeSpec ? findSyntaxNodeText(content, typeSpec, 'DefName') : null;
        if (!typeSpec || !typeName) {
          return;
        }
        const kind = findFirstSyntaxChild(typeSpec, (member) => member.type.name === 'InterfaceType')
          ? 'interface'
          : 'struct';
        const line = getPythonNodeLine(content, typeSpec);
        symbols.push({
          id: `${filePath}#${typeName}:${line}`,
          name: typeName,
          qualifiedName: `${filePath}:${typeName}`,
          kind,
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: /^[A-Z]/.test(typeName),
          calls: [],
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.97, baseConfidence + 0.07),
        });
        return;
      }

      if (child.type.name === 'FunctionDecl') {
        const functionName = findSyntaxNodeText(content, child, 'DefName');
        if (!functionName) {
          return;
        }
        const line = getPythonNodeLine(content, child);
        symbols.push({
          id: `${filePath}#${functionName}:${line}`,
          name: functionName,
          qualifiedName: `${filePath}:${functionName}`,
          kind: 'function',
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: /^[A-Z]/.test(functionName),
          calls: collectLezerCallNames(content, child, getGoCallName),
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.97, baseConfidence + 0.07),
        });
        return;
      }

      if (child.type.name !== 'MethodDecl') {
        return;
      }

      const receiverParameters = findFirstSyntaxChild(child, (member) => member.type.name === 'Parameters');
      const methodName = findSyntaxNodeText(content, child, 'FieldName');
      const receiverTypeNode = receiverParameters
        ? findSyntaxDescendant(receiverParameters, (member) => member.type.name === 'TypeName')
        : null;
      const receiverType = receiverTypeNode ? getSyntaxNodeText(content, receiverTypeNode).trim() : undefined;
      if (!methodName) {
        return;
      }
      const line = getPythonNodeLine(content, child);
      symbols.push({
        id: `${filePath}#${receiverType ? `${receiverType}.` : ''}${methodName}:${line}`,
        name: methodName,
        qualifiedName: `${filePath}:${receiverType ? `${receiverType}.` : ''}${methodName}`,
        kind: 'method',
        filePath,
        moduleId,
        language,
        capabilityTier,
        line,
        signature: getPythonSignature(lines, line),
        exported: /^[A-Z]/.test(methodName),
        calls: collectLezerCallNames(content, child, getGoCallName),
        callTargets: [],
        importPaths: imports,
        confidence: Math.min(0.97, baseConfidence + 0.08),
      });
    });

    analyses.push({
      filePath,
      moduleId,
      language,
      capabilityTier,
      importPaths: imports,
      symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE),
    });
  }

  return analyses;
}

async function analyzeRustFiles(
  workspaceRoot: string,
  sourceFiles: string[],
  overviewAreas: RepoAreaOverview[],
): Promise<FileAnalysis[]> {
  const analyses: FileAnalysis[] = [];

  for (const filePath of sourceFiles) {
    const absolutePath = path.join(workspaceRoot, filePath);
    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_FILE_BYTES) {
      continue;
    }

    const content = await fs.readFile(absolutePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const tree = rustParser.parse(content);
    const moduleId = findAreaForFile(filePath, overviewAreas).id;
    const language = languageFromFile(filePath);
    const capabilityTier = capabilityTierForLanguage(language);
    const baseConfidence = baseConfidenceForTier(capabilityTier);
    const imports = extractImports(content, language);
    const symbols: RepoSymbolRecord[] = [];

    forEachSyntaxChild(tree.topNode, (child) => {
      if (child.type.name === 'StructItem' || child.type.name === 'TraitItem' || child.type.name === 'EnumItem') {
        const typeName = findSyntaxNodeText(content, child, 'TypeIdentifier');
        if (!typeName) {
          return;
        }
        const kind = child.type.name === 'TraitItem'
          ? 'trait'
          : child.type.name === 'EnumItem'
            ? 'enum'
            : 'struct';
        const line = getPythonNodeLine(content, child);
        symbols.push({
          id: `${filePath}#${typeName}:${line}`,
          name: typeName,
          qualifiedName: `${filePath}:${typeName}`,
          kind,
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: isRustExported(content, child),
          calls: [],
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.97, baseConfidence + 0.06),
        });
        return;
      }

      if (child.type.name === 'FunctionItem') {
        const functionName = findSyntaxNodeText(content, child, 'BoundIdentifier');
        if (!functionName) {
          return;
        }
        const line = getPythonNodeLine(content, child);
        symbols.push({
          id: `${filePath}#${functionName}:${line}`,
          name: functionName,
          qualifiedName: `${filePath}:${functionName}`,
          kind: 'function',
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: isRustExported(content, child),
          calls: collectLezerCallNames(content, child, getRustCallName),
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.97, baseConfidence + 0.06),
        });
        return;
      }

      if (child.type.name !== 'ImplItem') {
        return;
      }

      const qualifierNode = findLastSyntaxChild(child, (member) => member.type.name === 'TypeIdentifier');
      const qualifier = qualifierNode
        ? normalizeRustQualifier(getSyntaxNodeText(content, qualifierNode).trim())
        : undefined;
      const declarationList = findFirstSyntaxChild(child, (member) => member.type.name === 'DeclarationList');
      if (!qualifier || !declarationList) {
        return;
      }

      forEachSyntaxChild(declarationList, (member) => {
        if (member.type.name !== 'FunctionItem') {
          return;
        }
        const methodName = findSyntaxNodeText(content, member, 'BoundIdentifier');
        if (!methodName) {
          return;
        }
        const line = getPythonNodeLine(content, member);
        symbols.push({
          id: `${filePath}#${qualifier}.${methodName}:${line}`,
          name: methodName,
          qualifiedName: `${filePath}:${qualifier}.${methodName}`,
          kind: 'method',
          filePath,
          moduleId,
          language,
          capabilityTier,
          line,
          signature: getPythonSignature(lines, line),
          exported: isRustExported(content, member),
          calls: collectLezerCallNames(content, member, getRustCallName),
          callTargets: [],
          importPaths: imports,
          confidence: Math.min(0.97, baseConfidence + 0.07),
        });
      });
    });

    analyses.push({
      filePath,
      moduleId,
      language,
      capabilityTier,
      importPaths: imports,
      symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE),
    });
  }

  return analyses;
}

function buildAreaFileLookups(
  files: string[],
  areas: RepoAreaOverview[],
): {
  areaByFile: Map<string, RepoAreaOverview>;
  filesByAreaId: Map<string, string[]>;
  testFilesByAreaId: Map<string, string[]>;
  docFilesByAreaId: Map<string, string[]>;
} {
  const areaByFile = new Map<string, RepoAreaOverview>();
  const filesByAreaId = new Map<string, string[]>();
  const testFilesByAreaId = new Map<string, string[]>();
  const docFilesByAreaId = new Map<string, string[]>();

  for (const filePath of files) {
    const area = findAreaForFile(filePath, areas);
    areaByFile.set(filePath, area);

    const filesBucket = filesByAreaId.get(area.id) ?? [];
    filesBucket.push(filePath);
    filesByAreaId.set(area.id, filesBucket);

    if (isTestFile(filePath)) {
      const testsBucket = testFilesByAreaId.get(area.id) ?? [];
      testsBucket.push(filePath);
      testFilesByAreaId.set(area.id, testsBucket);
    }

    if (isDocFile(filePath)) {
      const docsBucket = docFilesByAreaId.get(area.id) ?? [];
      docsBucket.push(filePath);
      docFilesByAreaId.set(area.id, docsBucket);
    }
  }

  return {
    areaByFile,
    filesByAreaId,
    testFilesByAreaId,
    docFilesByAreaId,
  };
}

async function writeJsonFileAtomic(filePath: string, payload: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    try {
      await fs.rename(tempPath, filePath);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : '';
      if (code === 'EEXIST' || code === 'EPERM') {
        await fs.rm(filePath, { force: true });
        await fs.rename(tempPath, filePath);
      } else {
        throw error;
      }
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function isTestFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  return normalized.includes('/test/')
    || normalized.includes('/tests/')
    || normalized.includes('__tests__')
    || /\.(test|spec)\.[^.]+$/.test(normalized);
}

function isDocFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  return normalized.startsWith('docs/')
    || normalized.endsWith('.md')
    || normalized.endsWith('.mdx')
    || normalized.endsWith('.rst');
}

function findAreaForFile(filePath: string, areas: RepoAreaOverview[]): RepoAreaOverview {
  const normalized = normalizeRelativePath(filePath);
  const sorted = [...areas].sort((left, right) => right.root.length - left.root.length);
  for (const area of sorted) {
    if (area.root === '.') {
      continue;
    }
    if (normalized === area.root || normalized.startsWith(`${area.root}/`)) {
      return area;
    }
  }

  return areas.find((area) => area.root === '.') ?? {
    id: '.',
    label: 'Workspace Root',
    kind: 'root',
    root: '.',
    fileCount: 0,
    manifests: [],
    sampleFiles: [],
  };
}

function dedupeStrings(values: string[], max = values.length): string[] {
  return Array.from(new Set(values.filter(Boolean))).slice(0, max);
}

function extractImports(content: string, language: RepoLanguageId): string[] {
  const matches: string[] = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    let match: RegExpExecArray | null = null;
    if (language === 'typescript' || language === 'javascript') {
      match = /from\s+['"]([^'"]+)['"]/.exec(line) ?? /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(line) ?? /^\s*import\s+['"]([^'"]+)['"]/.exec(line);
      if (match?.[1]) {
        matches.push(match[1]);
      }
      continue;
    }

    if (language === 'python') {
      match = /^\s*from\s+([A-Za-z0-9_\.]+)\s+import/.exec(line);
      if (match?.[1]) {
        matches.push(match[1]);
        continue;
      }
      match = /^\s*import\s+(.+)$/.exec(line);
      if (match?.[1]) {
        matches.push(...match[1].split(',').map((part) => part.trim().split(/\s+/)[0] ?? '').filter(Boolean));
      }
      continue;
    }

    if (language === 'go') {
      match = /^\s*import\s+"([^"]+)"/.exec(line) ?? /^\s*"([^"]+)"/.exec(line);
      if (match?.[1]) {
        matches.push(match[1]);
      }
      continue;
    }

    if (language === 'rust') {
      match = /^\s*use\s+([^;]+);/.exec(line);
      if (match?.[1]) {
        matches.push(match[1].trim());
      }
      continue;
    }

    if (language === 'java') {
      match = /^\s*import\s+([^;]+);/.exec(line);
      if (match?.[1]) {
        matches.push(match[1].trim());
      }
      continue;
    }

    if (language === 'cpp') {
      match = /^\s*#include\s+[<"]([^">]+)[">]/.exec(line);
      if (match?.[1]) {
        matches.push(match[1].trim());
      }
    }
  }

  return dedupeStrings(matches, 12);
}

function extractCallNames(content: string): string[] {
  const names = new Set<string>();
  const patterns = [/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g, /\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (!name || CALL_KEYWORDS.has(name)) {
        continue;
      }
      names.add(name);
      if (names.size >= 24) {
        break;
      }
    }
  }

  return Array.from(names);
}

function pushSymbol(
  entries: ExtractedSymbol[],
  keySet: Set<string>,
  value: ExtractedSymbol,
): void {
  const key = `${value.line}:${value.kind}:${value.name}`;
  if (keySet.has(key)) {
    return;
  }
  keySet.add(key);
  entries.push(value);
}

function extractSymbolsFromLines(lines: string[], language: RepoLanguageId): ExtractedSymbol[] {
  const entries: ExtractedSymbol[] = [];
  const keySet = new Set<string>();
  const javaContextStack: Array<{ name: string; depth: number }> = [];
  const cppContextStack: Array<{ name: string; depth: number }> = [];
  const rustContextStack: Array<{ name?: string; depth: number }> = [];
  let braceDepth = 0;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let match: RegExpExecArray | null = null;
    if (language === 'typescript' || language === 'javascript') {
      match = /^(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: 'function',
          line: index + 1,
          signature: line,
          exported: Boolean(match[1]),
          confidenceBoost: 0.08,
        });
        continue;
      }

      match = /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^=]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: 'function',
          line: index + 1,
          signature: line,
          exported: Boolean(match[1]),
          confidenceBoost: 0.06,
        });
        continue;
      }

      match = /^(export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line)
        ?? /^(export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line)
        ?? /^(export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/.exec(line)
        ?? /^(export\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line);
      if (match) {
        const kind = line.includes('interface')
          ? 'interface'
          : line.includes('type ')
            ? 'type'
            : line.includes('enum ')
              ? 'enum'
              : 'class';
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind,
          line: index + 1,
          signature: line,
          exported: Boolean(match[1]),
          confidenceBoost: 0.08,
        });
      }
      continue;
    }

    if (language === 'python') {
      match = /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: 'function',
          line: index + 1,
          signature: line,
          exported: !match[1]!.startsWith('_'),
          confidenceBoost: 0.08,
        });
        continue;
      }

      match = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: 'class',
          line: index + 1,
          signature: line,
          exported: !match[1]!.startsWith('_'),
          confidenceBoost: 0.08,
        });
      }
      continue;
    }

    if (language === 'go') {
      match = /^func\s+\(([^)]+)\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: 'method',
          line: index + 1,
          signature: line,
          exported: /^[A-Z]/.test(match[2]!),
          confidenceBoost: 0.08,
          qualifier: extractGoReceiverQualifier(match[1]!),
        });
        continue;
      }

      match = /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: 'function',
          line: index + 1,
          signature: line,
          exported: /^[A-Z]/.test(match[1]!),
          confidenceBoost: 0.07,
        });
        continue;
      }

      match = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: line.includes('interface') ? 'interface' : 'struct',
          line: index + 1,
          signature: line,
          exported: /^[A-Z]/.test(match[1]!),
          confidenceBoost: 0.07,
        });
      }
      continue;
    }

    if (language === 'rust') {
      const rustContext = rustContextStack[rustContextStack.length - 1];
      match = /^impl(?:<[^>]+>)?\s+(?:[A-Za-z0-9_:<&>\[\]]+\s+for\s+)?([A-Za-z_][A-Za-z0-9_:<>]*)/.exec(line);
      if (match) {
        const qualifier = normalizeRustQualifier(match[1]);
        rustContextStack.push({
          name: qualifier,
          depth: braceDepth + countBraceDelta(rawLine),
        });
      }

      match = /^(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: rustContext?.name ? 'method' : 'function',
          line: index + 1,
          signature: line,
          exported: line.startsWith('pub '),
          confidenceBoost: rustContext?.name ? 0.07 : 0.06,
          qualifier: rustContext?.name,
        });
        braceDepth += countBraceDelta(rawLine);
        while (rustContextStack.length > 0 && braceDepth < (rustContextStack[rustContextStack.length - 1]?.depth ?? 0)) {
          rustContextStack.pop();
        }
        continue;
      }

      match = /^(?:pub\s+)?(struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: match[1] as 'struct' | 'enum' | 'trait',
          line: index + 1,
          signature: line,
          exported: line.startsWith('pub '),
          confidenceBoost: 0.06,
        });
      }
      braceDepth += countBraceDelta(rawLine);
      while (rustContextStack.length > 0 && braceDepth < (rustContextStack[rustContextStack.length - 1]?.depth ?? 0)) {
        rustContextStack.pop();
      }
      continue;
    }

    if (language === 'java') {
      match = /^(?:public\s+)?(class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: match[1] === 'interface' ? 'interface' : match[1] === 'enum' ? 'enum' : 'class',
          line: index + 1,
          signature: line,
          exported: true,
          confidenceBoost: 0.05,
        });
        javaContextStack.push({
          name: match[2]!,
          depth: braceDepth + countBraceDelta(rawLine),
        });
        braceDepth += countBraceDelta(rawLine);
        while (javaContextStack.length > 0 && braceDepth < (javaContextStack[javaContextStack.length - 1]?.depth ?? 0)) {
          javaContextStack.pop();
        }
        continue;
      }

      match = /^(?:public|protected|private|static|final|synchronized|abstract|\s)+[\w<>\[\], ?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line);
      if (match && !CALL_KEYWORDS.has(match[1]!)) {
        const qualifier = javaContextStack[javaContextStack.length - 1]?.name;
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: qualifier ? 'method' : 'function',
          line: index + 1,
          signature: line,
          exported: line.startsWith('public'),
          confidenceBoost: 0.03,
          qualifier,
        });
      }
      braceDepth += countBraceDelta(rawLine);
      while (javaContextStack.length > 0 && braceDepth < (javaContextStack[javaContextStack.length - 1]?.depth ?? 0)) {
        javaContextStack.pop();
      }
      continue;
    }

    if (language === 'cpp') {
      match = /^(class|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (match) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: match[1] === 'enum' ? 'enum' : match[1] === 'struct' ? 'struct' : 'class',
          line: index + 1,
          signature: line,
          exported: true,
          confidenceBoost: 0.03,
        });
        if (match[1] !== 'enum') {
          cppContextStack.push({
            name: match[2]!,
            depth: braceDepth + countBraceDelta(rawLine),
          });
        }
        braceDepth += countBraceDelta(rawLine);
        while (cppContextStack.length > 0 && braceDepth < (cppContextStack[cppContextStack.length - 1]?.depth ?? 0)) {
          cppContextStack.pop();
        }
        continue;
      }

      match = /^(?:[\w:&*<>,~]+\s+)+([A-Za-z_~][A-Za-z0-9_]*)::([A-Za-z_~][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)/.exec(line);
      if (match && !CALL_KEYWORDS.has(match[2]!)) {
        pushSymbol(entries, keySet, {
          name: match[2]!,
          kind: 'method',
          line: index + 1,
          signature: line,
          exported: true,
          confidenceBoost: 0.04,
          qualifier: match[1]!.split('::').at(-1),
        });
        braceDepth += countBraceDelta(rawLine);
        while (cppContextStack.length > 0 && braceDepth < (cppContextStack[cppContextStack.length - 1]?.depth ?? 0)) {
          cppContextStack.pop();
        }
        continue;
      }

      match = /^(?:[\w:&*<>,~]+\s+)+([A-Za-z_~][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)/.exec(line);
      if (match && !CALL_KEYWORDS.has(match[1]!)) {
        const qualifier = cppContextStack[cppContextStack.length - 1]?.name;
        pushSymbol(entries, keySet, {
          name: match[1]!,
          kind: qualifier ? 'method' : 'function',
          line: index + 1,
          signature: line,
          exported: true,
          confidenceBoost: qualifier ? 0.03 : 0.02,
          qualifier,
        });
      }
      braceDepth += countBraceDelta(rawLine);
      while (cppContextStack.length > 0 && braceDepth < (cppContextStack[cppContextStack.length - 1]?.depth ?? 0)) {
        cppContextStack.pop();
      }
    }
  }

  return entries.slice(0, MAX_SYMBOLS_PER_FILE);
}

async function analyzeSourceFile(
  workspaceRoot: string,
  filePath: string,
  moduleId: string,
): Promise<FileAnalysis | null> {
  const absolutePath = path.join(workspaceRoot, filePath);
  const stat = await fs.stat(absolutePath);
  if (stat.size > MAX_FILE_BYTES) {
    return null;
  }

  const content = await fs.readFile(absolutePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const language = languageFromFile(filePath);
  const capabilityTier = capabilityTierForLanguage(language);
  const imports = extractImports(content, language);
  const symbolMatches = extractSymbolsFromLines(lines, language);
  const baseConfidence = baseConfidenceForTier(capabilityTier);

  const symbols: RepoSymbolRecord[] = symbolMatches.map((entry, index, allEntries) => {
    const symbolBody = extractSymbolBody(lines, language, entry, allEntries, index);
    const calls = entry.calls ?? extractCallNames(symbolBody);
    return {
      id: `${filePath}#${entry.qualifier ? `${entry.qualifier}.` : ''}${entry.name}:${entry.line}`,
      name: entry.name,
      qualifiedName: `${filePath}:${entry.qualifier ? `${entry.qualifier}.` : ''}${entry.name}`,
      kind: entry.kind,
      filePath,
      moduleId,
      language,
      capabilityTier,
      line: entry.line,
      signature: entry.signature,
      exported: entry.exported,
      calls,
      callTargets: [],
      importPaths: imports,
      confidence: Math.min(0.97, baseConfidence + entry.confidenceBoost),
    };
  });

  return {
    filePath,
    moduleId,
    language,
    capabilityTier,
    importPaths: imports,
    symbols,
  };
}

function buildModuleAliases(modules: RepoAreaOverview[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const module of modules) {
    aliases.set(module.id.toLowerCase(), module.id);
    aliases.set(module.label.toLowerCase(), module.id);
    aliases.set(path.posix.basename(module.root).toLowerCase(), module.id);
  }
  return aliases;
}

function resolveRelativeImport(importPath: string, filePath: string, sourceFileSet: Set<string>): string | null {
  if (!importPath.startsWith('.')) {
    return null;
  }

  const baseDir = path.posix.dirname(filePath);
  let baseTarget: string;
  if (!importPath.includes('/')) {
    const leadingDots = importPath.match(/^\.+/)?.[0]?.length ?? 0;
    const relativeModule = importPath.slice(leadingDots).replace(/\./g, '/');
    let resolvedBaseDir = baseDir;
    for (let index = 1; index < leadingDots; index += 1) {
      resolvedBaseDir = path.posix.dirname(resolvedBaseDir);
    }
    baseTarget = normalizeRelativePath(path.posix.join(resolvedBaseDir, relativeModule));
  } else {
    baseTarget = normalizeRelativePath(path.posix.join(baseDir, importPath));
  }
  const candidates = [baseTarget];
  for (const ext of SOURCE_EXTENSIONS) {
    candidates.push(`${baseTarget}${ext}`);
    candidates.push(`${baseTarget}/index${ext}`);
  }

  for (const candidate of candidates) {
    if (sourceFileSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveImportToModule(
  importPath: string,
  filePath: string,
  sourceFileSet: Set<string>,
  modules: RepoAreaOverview[],
  aliases: Map<string, string>,
): string | null {
  const relativeFile = resolveRelativeImport(importPath, filePath, sourceFileSet);
  if (relativeFile) {
    return findAreaForFile(relativeFile, modules).id;
  }

  const normalizedImport = importPath.toLowerCase();
  for (const [alias, moduleId] of aliases.entries()) {
    if (
      normalizedImport === alias
      || normalizedImport.startsWith(`${alias}/`)
      || normalizedImport.endsWith(`/${alias}`)
    ) {
      return moduleId;
    }
  }

  return null;
}

function rankReferenceReason(
  sourceModuleId: string,
  targetModuleId: string,
  importedModules: Set<string>,
): RepoSymbolReference['reason'] {
  if (sourceModuleId === targetModuleId) {
    return 'same-module';
  }
  if (importedModules.has(targetModuleId)) {
    return 'imported-module';
  }
  return 'name-match';
}

function buildProcessCapsules(
  modules: ModuleCapsule[],
  symbols: RepoSymbolRecord[],
): ProcessCapsule[] {
  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const symbolsByModule = new Map<string, RepoSymbolRecord[]>();
  for (const symbol of symbols) {
    const bucket = symbolsByModule.get(symbol.moduleId) ?? [];
    bucket.push(symbol);
    symbolsByModule.set(symbol.moduleId, bucket);
  }

  const processes: ProcessCapsule[] = [];
  for (const module of modules) {
    const moduleSymbols = symbolsByModule.get(module.moduleId) ?? [];
    const entryFiles = module.entryFiles.length > 0 ? module.entryFiles : module.sampleFiles;
    for (const entryFile of entryFiles.slice(0, 2)) {
      const entrySymbol = moduleSymbols.find((symbol) => symbol.filePath === entryFile && symbol.exported)
        ?? moduleSymbols.find((symbol) => symbol.filePath === entryFile)
        ?? moduleSymbols[0];

      if (!entrySymbol) {
        continue;
      }

      const steps: ProcessStep[] = [{
        kind: 'entry',
        symbolName: entrySymbol.name,
        symbolId: entrySymbol.id,
        filePath: entrySymbol.filePath,
        line: entrySymbol.line,
        note: `Entry symbol ${entrySymbol.name} in ${entrySymbol.filePath}`,
      }];

      for (const importPath of entrySymbol.importPaths.slice(0, 3)) {
        steps.push({
          kind: 'imports',
          symbolName: importPath,
          filePath: entrySymbol.filePath,
          note: `Imports ${importPath}`,
        });
      }

      const firstHopTargets = entrySymbol.callTargets.slice(0, 3);
      for (const target of firstHopTargets) {
        const resolved = symbolsById.get(target.symbolId);
        steps.push({
          kind: 'calls',
          symbolName: target.name,
          symbolId: target.symbolId,
          filePath: target.filePath,
          line: resolved?.line,
          note: `Calls ${target.name} (${target.reason})`,
        });
      }

      const secondHopSymbols = firstHopTargets
        .map((target) => symbolsById.get(target.symbolId))
        .filter((symbol): symbol is RepoSymbolRecord => symbol !== undefined)
        .flatMap((symbol) => symbol.callTargets.slice(0, 2))
        .slice(0, 2);
      for (const target of secondHopSymbols) {
        const resolved = symbolsById.get(target.symbolId);
        steps.push({
          kind: 'calls',
          symbolName: target.name,
          symbolId: target.symbolId,
          filePath: target.filePath,
          line: resolved?.line,
          note: `Then reaches ${target.name} (${target.reason})`,
        });
      }

      const dedupedSteps = steps.slice(0, MAX_PROCESS_STEPS);
      const touchedModules = dedupeStrings(
        dedupedSteps
          .map((step) => symbolsById.get(step.symbolId ?? '')?.moduleId)
          .filter((value): value is string => typeof value === 'string'),
        4,
      );

      const processId = `${module.moduleId}::${path.posix.basename(entryFile)}`;
      processes.push({
        id: processId,
        label: `${module.label} entry via ${path.posix.basename(entryFile)}`,
        moduleId: module.moduleId,
        entryFile,
        entrySymbol: entrySymbol.name,
        summary: touchedModules.length > 0
          ? `${entrySymbol.name} fans into ${dedupeStrings(firstHopTargets.map((target) => target.name), 4).join(', ') || 'local work'} and touches modules ${touchedModules.join(', ')}.`
          : `${entrySymbol.name} starts the main path for ${module.label}.`,
        steps: dedupedSteps,
        confidence: Math.min(0.95, entrySymbol.confidence - 0.02 + firstHopTargets.length * 0.03),
      });
    }
  }

  return processes;
}

function orderedSourceFilesForBuild(buckets: SourceFileBuckets): string[] {
  return [
    ...buckets.typeScriptFiles,
    ...buckets.pythonFiles,
    ...buckets.goFiles,
    ...buckets.rustFiles,
    ...buckets.fallbackFiles,
  ];
}

function collectLanguageBreakdown(analyses: FileAnalysis[]): RepoLanguageSupport[] {
  const languageCounts = new Map<RepoLanguageId, number>();
  for (const analysis of analyses) {
    languageCounts.set(analysis.language, (languageCounts.get(analysis.language) ?? 0) + 1);
  }
  return Array.from(languageCounts.entries()).map(([language, fileCount]) => ({
    language,
    capabilityTier: capabilityTierForLanguage(language),
    fileCount,
  }));
}

async function prepareRepoIntelligenceBuildInputsFromSnapshot(
  snapshot: RepoOverviewSnapshot,
  options: { preflight?: RepoIntelligencePreflight } = {},
): Promise<RepoIntelligenceWorkspaceInputs> {
  const overview = snapshot.overview;
  const workspaceRoot = snapshot.workspaceRoot;
  const preflight = options.preflight;
  const storageRoot = preflight?.storageRoot ?? await ensureStorageDir(workspaceRoot);
  const inventory = snapshot.inventory;
  const fallbackFiles = inventory
    ? null
    : await collectWorkspaceFilesForSource(workspaceRoot, overview.source);
  const dirtyPaths = preflight?.dirtyPaths ?? snapshot.dirtyPaths;
  const allFileSet = new Set(
    (inventory?.allFiles ?? fallbackFiles?.files ?? [])
      .map((filePath) => normalizeRelativePath(filePath)),
  );
  if (dirtyPaths && dirtyPaths.length > 0) {
    for (const filePath of dirtyPaths) {
      const absolutePath = path.join(workspaceRoot, filePath);
      if (await exists(absolutePath)) {
        allFileSet.add(filePath);
      } else {
        allFileSet.delete(filePath);
      }
    }
  }
  const allFiles = Array.from(allFileSet).sort((left, right) => left.localeCompare(right));
  const {
    areaByFile,
    filesByAreaId,
    testFilesByAreaId,
    docFilesByAreaId,
  } = buildAreaFileLookups(allFiles, overview.areas);
  const sourceFiles = allFiles.filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const sourceFileSet = new Set(sourceFiles);
  const dirtyPathsFingerprint = preflight?.dirtyPathsFingerprint ?? (dirtyPaths ? computePathFingerprint(dirtyPaths) : undefined);
  const dirtySourceFiles = preflight?.dirtySourcePaths
    ? preflight.dirtySourcePaths.filter((filePath) => sourceFileSet.has(filePath))
    : dirtyPaths
      ? dirtyPaths.filter((filePath) => sourceFileSet.has(filePath))
    : [];
  const dirtySourceStateMap = preflight?.dirtySourceStateMap
    ?? (dirtySourceFiles.length > 0
      ? await collectSourceFileStateMap(
        workspaceRoot,
        dirtySourceFiles,
        areaByFile,
        overview.areas,
      )
      : undefined);
  const dirtySourceFingerprint = preflight?.dirtySourceFingerprint
    ?? (dirtyPaths
      ? computeSourceFingerprint(
        dirtySourceStateMap
          ? Array.from(dirtySourceStateMap.values()).sort((left, right) => left.filePath.localeCompare(right.filePath))
          : [],
      )
      : undefined);
  return {
    overview,
    overviewFingerprint: computeOverviewFingerprint(overview, allFiles),
    workspaceSnapshot: preflight?.workspaceSnapshot ?? workspaceSnapshotFromOverview(overview),
    inventory,
    workspaceRoot,
    storageRoot,
    allFiles,
    areaByFile,
    filesByAreaId,
    testFilesByAreaId,
    docFilesByAreaId,
    sourceFiles,
    sourceFileSet,
    dirtyPaths,
    dirtyPathsFingerprint,
    dirtySourceFingerprint,
    dirtySourceStateMap,
    moduleAliases: buildModuleAliases(overview.areas),
    buckets: bucketSourceFiles(sourceFiles),
  };
}

function finalizeRepoIntelligenceBuildInputs(
  base: RepoIntelligenceWorkspaceInputs,
  sourceStates: RepoSourceFileState[],
): RepoIntelligenceWorkspaceInputs {
  return {
    ...base,
    sourceStates,
    sourceFingerprint: computeSourceFingerprint(sourceStates),
  };
}

async function analyzeSourceFilesForBuild(
  inputs: RepoIntelligenceWorkspaceInputs,
  sourceFiles: string[],
): Promise<Map<string, FileAnalysis | null>> {
  const analysisEntries = new Map<string, FileAnalysis | null>(
    sourceFiles.map((filePath) => [filePath, null]),
  );
  const buckets = bucketSourceFiles(sourceFiles);

  if (buckets.typeScriptFiles.length > 0) {
    const analyses = await analyzeTypeScriptFiles(
      inputs.workspaceRoot,
      buckets.typeScriptFiles,
      inputs.overview.areas,
      inputs.sourceFileSet,
      inputs.moduleAliases,
    );
    for (const analysis of analyses) {
      analysisEntries.set(analysis.filePath, analysis);
    }
  }

  if (buckets.pythonFiles.length > 0) {
    const analyses = await analyzePythonFiles(
      inputs.workspaceRoot,
      buckets.pythonFiles,
      inputs.overview.areas,
    );
    for (const analysis of analyses) {
      analysisEntries.set(analysis.filePath, analysis);
    }
  }

  if (buckets.goFiles.length > 0) {
    const analyses = await analyzeGoFiles(
      inputs.workspaceRoot,
      buckets.goFiles,
      inputs.overview.areas,
    );
    for (const analysis of analyses) {
      analysisEntries.set(analysis.filePath, analysis);
    }
  }

  if (buckets.rustFiles.length > 0) {
    const analyses = await analyzeRustFiles(
      inputs.workspaceRoot,
      buckets.rustFiles,
      inputs.overview.areas,
    );
    for (const analysis of analyses) {
      analysisEntries.set(analysis.filePath, analysis);
    }
  }

  if (buckets.fallbackFiles.length > 0) {
    const analyses = await Promise.all(
      buckets.fallbackFiles.map((filePath) => analyzeSourceFile(
        inputs.workspaceRoot,
        filePath,
        inputs.areaByFile.get(filePath)?.id ?? inputs.overview.areas[0]!.id,
      )),
    );
    for (const [index, analysis] of analyses.entries()) {
      analysisEntries.set(buckets.fallbackFiles[index]!, analysis ?? null);
    }
  }

  return analysisEntries;
}

function collectOrderedAnalyses(
  inputs: RepoIntelligenceWorkspaceInputs,
  analysisEntries: Map<string, FileAnalysis | null>,
): FileAnalysis[] {
  return orderedSourceFilesForBuild(inputs.buckets)
    .flatMap((filePath) => {
      const analysis = analysisEntries.get(filePath) ?? null;
      return analysis ? [analysis] : [];
    });
}

async function materializeRepoIntelligenceIndex(
  inputs: RepoIntelligenceWorkspaceInputs,
  analysisEntries: Map<string, FileAnalysis | null>,
): Promise<RepoIntelligenceIndex> {
  if (!inputs.sourceStates || !inputs.sourceFingerprint) {
    throw new Error('materializeRepoIntelligenceIndex requires source state metadata.');
  }
  const analyses = collectOrderedAnalyses(inputs, analysisEntries);
  const symbols = analyses.flatMap((analysis) => analysis.symbols);
  const symbolsByName = new Map<string, RepoSymbolRecord[]>();
  for (const symbol of symbols) {
    const key = symbol.name.toLowerCase();
    const bucket = symbolsByName.get(key) ?? [];
    bucket.push(symbol);
    symbolsByName.set(key, bucket);
  }

  const symbolsWithTargets = symbols.map((symbol) => {
    const importedModules = new Set<string>();
    for (const importPath of symbol.importPaths) {
      const resolvedModule = resolveImportToModule(
        importPath,
        symbol.filePath,
        inputs.sourceFileSet,
        inputs.overview.areas,
        inputs.moduleAliases,
      );
      if (resolvedModule) {
        importedModules.add(resolvedModule);
      }
    }

    const resolvedTargets = symbol.calls
      .flatMap((callName) => (symbolsByName.get(callName.toLowerCase()) ?? []).map((candidate) => ({
        candidate,
        reason: rankReferenceReason(symbol.moduleId, candidate.moduleId, importedModules),
      })))
      .filter(({ candidate }) => candidate.id !== symbol.id)
      .sort((left, right) => {
        if (left.reason !== right.reason) {
          const order = ['same-module', 'imported-module', 'name-match'];
          return order.indexOf(left.reason) - order.indexOf(right.reason);
        }
        return left.candidate.filePath.localeCompare(right.candidate.filePath);
      });

    const deduped = new Map<string, RepoSymbolReference>();
    for (const { candidate, reason } of resolvedTargets) {
      if (!deduped.has(candidate.id)) {
        deduped.set(candidate.id, {
          symbolId: candidate.id,
          name: candidate.name,
          filePath: candidate.filePath,
          moduleId: candidate.moduleId,
          reason,
        });
      }
      if (deduped.size >= MAX_RELATED_RESULTS) {
        break;
      }
    }
    return {
      ...symbol,
      callTargets: Array.from(deduped.values()),
    };
  });

  const moduleDrafts = new Map<string, {
    dependencies: Set<string>;
    dependents: Set<string>;
    languageCounts: Map<RepoLanguageId, number>;
    sourceFileCount: number;
    symbolCount: number;
    entryFiles: string[];
  }>();

  for (const area of inputs.overview.areas) {
    moduleDrafts.set(area.id, {
      dependencies: new Set<string>(),
      dependents: new Set<string>(),
      languageCounts: new Map<RepoLanguageId, number>(),
      sourceFileCount: 0,
      symbolCount: 0,
      entryFiles: [],
    });
  }

  for (const analysis of analyses) {
    const moduleDraft = moduleDrafts.get(analysis.moduleId);
    if (!moduleDraft) {
      continue;
    }
    const nextLanguageCounts = new Map(moduleDraft.languageCounts);
    nextLanguageCounts.set(
      analysis.language,
      (nextLanguageCounts.get(analysis.language) ?? 0) + 1,
    );
    const nextDependencies = new Set(moduleDraft.dependencies);
    const nextEntryFiles = /\/(?:index|main|app|server|cli)\.[^.]+$/.test(analysis.filePath) || /^(index|main|app|server|cli)\.[^.]+$/.test(analysis.filePath)
      ? dedupeStrings([...moduleDraft.entryFiles, analysis.filePath], 4)
      : moduleDraft.entryFiles;

    for (const importPath of analysis.importPaths) {
      const resolvedModule = resolveImportToModule(
        importPath,
        analysis.filePath,
        inputs.sourceFileSet,
        inputs.overview.areas,
        inputs.moduleAliases,
      );
      if (resolvedModule && resolvedModule !== analysis.moduleId) {
        nextDependencies.add(resolvedModule);
      }
    }
    moduleDrafts.set(analysis.moduleId, {
      ...moduleDraft,
      sourceFileCount: moduleDraft.sourceFileCount + 1,
      symbolCount: moduleDraft.symbolCount + analysis.symbols.length,
      languageCounts: nextLanguageCounts,
      dependencies: nextDependencies,
      entryFiles: nextEntryFiles,
    });
  }

  for (const [moduleId, draft] of moduleDrafts.entries()) {
    for (const dependency of draft.dependencies) {
      const dependencyDraft = moduleDrafts.get(dependency);
      if (!dependencyDraft) {
        continue;
      }
      moduleDrafts.set(dependency, {
        ...dependencyDraft,
        dependents: new Set([...dependencyDraft.dependents, moduleId]),
      });
    }
  }

  const modules = Array.from(moduleDrafts.entries())
    .map(([moduleId, draft]) => {
      const area = inputs.overview.areas.find((candidate) => candidate.id === moduleId);
      if (!area) {
        return null;
      }
      const dependencies = Array.from(draft.dependencies).sort((left, right) => left.localeCompare(right));
      const dependents = Array.from(draft.dependents).sort((left, right) => left.localeCompare(right));
      const languages = Array.from(draft.languageCounts.entries())
        .map(([language, fileCount]) => ({
          language,
          capabilityTier: capabilityTierForLanguage(language),
          fileCount,
        }))
        .sort((left, right) => right.fileCount - left.fileCount);
      return {
        moduleId: area.id,
        label: area.label,
        kind: area.kind,
        root: area.root,
        fileCount: inputs.filesByAreaId.get(area.id)?.length ?? 0,
        sourceFileCount: draft.sourceFileCount,
        symbolCount: draft.symbolCount,
        languages,
        topSymbols: symbolsWithTargets
          .filter((symbol) => symbol.moduleId === moduleId)
          .sort((left, right) => Number(right.exported) - Number(left.exported) || right.confidence - left.confidence)
          .slice(0, 6)
          .map((symbol) => symbol.name),
        dependencies,
        dependents,
        entryFiles: draft.entryFiles,
        keyTests: (inputs.testFilesByAreaId.get(moduleId) ?? []).slice(0, 4),
        keyDocs: (inputs.docFilesByAreaId.get(moduleId) ?? []).slice(0, 4),
        sampleFiles: area.sampleFiles.slice(0, 5),
        processIds: [] as string[],
        confidence: Math.min(
          0.95,
          0.58 + languages.length * 0.06 + Math.min(draft.symbolCount, 12) * 0.01,
        ),
      } satisfies ModuleCapsule;
    })
    .filter((module): module is ModuleCapsule => module !== null)
    .sort((left, right) => right.symbolCount - left.symbolCount || left.moduleId.localeCompare(right.moduleId));

  const processes = buildProcessCapsules(modules, symbolsWithTargets);
  const processIdsByModule = new Map<string, string[]>();
  for (const process of processes) {
    const bucket = processIdsByModule.get(process.moduleId) ?? [];
    bucket.push(process.id);
    processIdsByModule.set(process.moduleId, bucket);
  }
  const modulesWithProcesses = modules.map((module) => ({
    ...module,
    processIds: processIdsByModule.get(module.moduleId) ?? [],
  }));

  const index: RepoIntelligenceIndex = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    workspaceRoot: inputs.workspaceRoot,
    generatedAt: new Date().toISOString(),
    overviewGeneratedAt: inputs.overview.generatedAt,
    sourceFileCount: inputs.sourceFiles.length,
    sourceFingerprint: inputs.sourceFingerprint,
    languages: collectLanguageBreakdown(analyses),
    modules: modulesWithProcesses,
    symbols: symbolsWithTargets,
    processes,
  };

  const manifest: RepoIntelligenceManifest = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    workspaceRoot: inputs.workspaceRoot,
    generatedAt: index.generatedAt,
    overviewGeneratedAt: inputs.overview.generatedAt,
    overviewFingerprint: inputs.overviewFingerprint,
    workspaceSnapshot: inputs.workspaceSnapshot,
    sourceFileCount: inputs.sourceFiles.length,
    sourceFingerprint: inputs.sourceFingerprint,
    languageBreakdown: index.languages,
    sourceStates: inputs.sourceStates,
  };

  const fileAnalysisIndex: FileAnalysisIndexPayload = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    workspaceRoot: inputs.workspaceRoot,
    generatedAt: index.generatedAt,
    sourceFingerprint: inputs.sourceFingerprint,
    analyses: Object.fromEntries(inputs.sourceFiles.map((filePath) => [
      filePath,
      serializeCachedFileAnalysisEntry(analysisEntries.get(filePath) ?? null),
    ])),
  };
  const dirtySourcePaths = getDirtySourcePathsForInputs(inputs);
  const dirtySourceHint: DirtySourceHintPayload = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    workspaceRoot: inputs.workspaceRoot,
    branch: inputs.workspaceSnapshot.branch,
    head: inputs.workspaceSnapshot.head,
    queryGeneratedAt: index.generatedAt,
    overviewFingerprint: inputs.overviewFingerprint,
    sourceFingerprint: inputs.sourceFingerprint,
    sourceFileCount: inputs.sourceFiles.length,
    dirtyPathsFingerprint: inputs.dirtyPathsFingerprint ?? computePathFingerprint(inputs.dirtyPaths ?? []),
    dirtySourceFingerprint: inputs.dirtySourceFingerprint ?? computeSourceFingerprint([]),
    dirtySourcePaths,
  };

  await writeJsonFileAtomic(path.join(inputs.storageRoot, MODULE_INDEX_FILE), modulesWithProcesses);
  await writeJsonFileAtomic(path.join(inputs.storageRoot, SYMBOL_INDEX_FILE), symbolsWithTargets);
  await writeJsonFileAtomic(path.join(inputs.storageRoot, PROCESS_INDEX_FILE), processes);
  await writeJsonFileAtomic(path.join(inputs.storageRoot, QUERY_INDEX_FILE), index);
  await writeJsonFileAtomic(path.join(inputs.storageRoot, DIRTY_SOURCE_HINT_FILE), dirtySourceHint);
  if (shouldPersistRepoIntelligenceBaseline(inputs)) {
    await writeJsonFileAtomic(path.join(inputs.storageRoot, QUERY_MANIFEST_FILE), manifest);
    await writeJsonFileAtomic(path.join(inputs.storageRoot, FILE_ANALYSIS_INDEX_FILE), fileAnalysisIndex);
  }

  return index;
}

async function buildRepoIntelligenceIndexFromInputs(
  inputs: RepoIntelligenceWorkspaceInputs,
): Promise<RepoIntelligenceIndex> {
  const sourceStates = await collectSourceFileStates(
    inputs.workspaceRoot,
    inputs.sourceFiles,
    inputs.areaByFile,
    inputs.overview.areas,
  );
  const completeInputs = finalizeRepoIntelligenceBuildInputs(inputs, sourceStates);
  const analysisEntries = await analyzeSourceFilesForBuild(completeInputs, completeInputs.sourceFiles);
  return materializeRepoIntelligenceIndex(completeInputs, analysisEntries);
}

async function readRepoIntelligenceManifest(
  storageRoot: string,
): Promise<RepoIntelligenceManifest | null> {
  return safeReadJson<RepoIntelligenceManifest>(
    path.join(storageRoot, QUERY_MANIFEST_FILE),
    isRepoIntelligenceManifestPayload,
  );
}

async function readFileAnalysisIndex(
  storageRoot: string,
): Promise<FileAnalysisIndexPayload | null> {
  return safeReadJson<FileAnalysisIndexPayload>(
    path.join(storageRoot, FILE_ANALYSIS_INDEX_FILE),
    isFileAnalysisIndexPayload,
  );
}

async function readDirtySourceHint(
  storageRoot: string,
): Promise<DirtySourceHintPayload | null> {
  return safeReadJson<DirtySourceHintPayload>(
    path.join(storageRoot, DIRTY_SOURCE_HINT_FILE),
    isDirtySourceHintPayload,
  );
}

function hasOwnAnalysisEntry(
  analyses: FileAnalysisIndexPayload['analyses'],
  filePath: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(analyses, filePath);
}

function hasCompatibleIncrementalCache(
  inputs: RepoIntelligenceWorkspaceInputs,
  manifest: RepoIntelligenceManifest,
  fileAnalysisIndex: FileAnalysisIndexPayload,
): boolean {
  return manifest.schemaVersion === QUERY_SCHEMA_VERSION
    && fileAnalysisIndex.schemaVersion === QUERY_SCHEMA_VERSION
    && manifest.workspaceRoot === inputs.workspaceRoot
    && fileAnalysisIndex.workspaceRoot === inputs.workspaceRoot
    && manifest.workspaceSnapshot.source === inputs.workspaceSnapshot.source
    && manifest.sourceStates.length === manifest.sourceFileCount
    && fileAnalysisIndex.sourceFingerprint === manifest.sourceFingerprint;
}

function canDirectReuseCleanCachedQueryIndex(
  inputs: RepoIntelligenceWorkspaceInputs,
  manifest: RepoIntelligenceManifest,
): boolean {
  return isCleanGitSnapshot(inputs.workspaceSnapshot)
    && sameWorkspaceSnapshot(manifest.workspaceSnapshot, inputs.workspaceSnapshot)
    && manifest.overviewFingerprint === inputs.overviewFingerprint
    && manifest.sourceFileCount === inputs.sourceFiles.length;
}

function canDirectReuseDirtyCachedQueryIndex(
  inputs: RepoIntelligenceWorkspaceInputs,
  dirtySourceHint: DirtySourceHintPayload | null,
): boolean {
  return Boolean(
    inputs.workspaceSnapshot.source === 'git'
      && inputs.workspaceSnapshot.hasUncommittedChanges === true
      && dirtySourceHint
      && dirtySourceHint.schemaVersion === QUERY_SCHEMA_VERSION
      && dirtySourceHint.workspaceRoot === inputs.workspaceRoot
      && dirtySourceHint.head === inputs.workspaceSnapshot.head
      && dirtySourceHint.branch === inputs.workspaceSnapshot.branch
      && dirtySourceHint.overviewFingerprint === inputs.overviewFingerprint
      && dirtySourceHint.sourceFileCount === inputs.sourceFiles.length
      && dirtySourceHint.dirtyPathsFingerprint === inputs.dirtyPathsFingerprint
      && dirtySourceHint.dirtySourceFingerprint === inputs.dirtySourceFingerprint,
  );
}

async function tryDirectReuseCleanCachedQueryIndexFromPreflight(
  preflight: RepoIntelligencePreflight,
): Promise<RepoIntelligenceIndex | null> {
  if (!isCleanGitSnapshot(preflight.workspaceSnapshot)) {
    return null;
  }

  const manifest = await readRepoIntelligenceManifest(preflight.storageRoot);
  if (
    !manifest
    || manifest.schemaVersion !== QUERY_SCHEMA_VERSION
    || manifest.workspaceRoot !== preflight.workspaceRoot
    || !sameWorkspaceSnapshot(manifest.workspaceSnapshot, preflight.workspaceSnapshot)
    || manifest.overviewGeneratedAt !== preflight.overviewGeneratedAt
  ) {
    return null;
  }

  const cached = await safeReadJson<RepoIntelligenceIndex>(
    path.join(preflight.storageRoot, QUERY_INDEX_FILE),
    isRepoIntelligenceIndexPayload,
  );
  if (
    cached?.schemaVersion !== QUERY_SCHEMA_VERSION
    || cached.workspaceRoot !== preflight.workspaceRoot
    || cached.overviewGeneratedAt !== manifest.overviewGeneratedAt
    || cached.sourceFileCount !== manifest.sourceFileCount
    || cached.sourceFingerprint !== manifest.sourceFingerprint
  ) {
    return null;
  }

  return cached;
}

async function tryDirectReuseDirtyCachedQueryIndexFromPreflight(
  preflight: RepoIntelligencePreflight,
): Promise<RepoIntelligenceIndex | null> {
  if (
    preflight.workspaceSnapshot.source !== 'git'
    || preflight.workspaceSnapshot.hasUncommittedChanges !== true
  ) {
    return null;
  }

  const dirtySourceHint = await readDirtySourceHint(preflight.storageRoot);
  if (
    !dirtySourceHint
    || dirtySourceHint.schemaVersion !== QUERY_SCHEMA_VERSION
    || dirtySourceHint.workspaceRoot !== preflight.workspaceRoot
    || dirtySourceHint.head !== preflight.workspaceSnapshot.head
    || dirtySourceHint.branch !== preflight.workspaceSnapshot.branch
    || dirtySourceHint.dirtyPathsFingerprint !== preflight.dirtyPathsFingerprint
    || dirtySourceHint.dirtySourceFingerprint !== preflight.dirtySourceFingerprint
  ) {
    return null;
  }

  const cached = await safeReadJson<RepoIntelligenceIndex>(
    path.join(preflight.storageRoot, QUERY_INDEX_FILE),
    isRepoIntelligenceIndexPayload,
  );
  if (
    cached?.schemaVersion !== QUERY_SCHEMA_VERSION
    || cached.workspaceRoot !== preflight.workspaceRoot
    || cached.overviewGeneratedAt !== preflight.overviewGeneratedAt
    || cached.generatedAt !== dirtySourceHint.queryGeneratedAt
    || cached.sourceFileCount !== dirtySourceHint.sourceFileCount
    || cached.sourceFingerprint !== dirtySourceHint.sourceFingerprint
  ) {
    return null;
  }

  return cached;
}

function mapSourceStatesByFile(
  sourceStates: RepoSourceFileState[],
): Map<string, RepoSourceFileState> {
  return new Map(sourceStates.map((state) => [state.filePath, state]));
}

function buildCompleteInputsFromSourceStates(
  inputs: RepoIntelligenceWorkspaceInputs,
  sourceStatesByFile: Map<string, RepoSourceFileState>,
): RepoIntelligenceWorkspaceInputs | null {
  const sourceStates = inputs.sourceFiles
    .map((filePath) => sourceStatesByFile.get(filePath))
    .filter((state): state is RepoSourceFileState => state !== undefined);

  if (sourceStates.length !== inputs.sourceFiles.length) {
    return null;
  }

  return finalizeRepoIntelligenceBuildInputs(inputs, sourceStates);
}

function classifyChangedOrNewSourceFiles(
  sourceStates: RepoSourceFileState[],
  previousByFile: Map<string, RepoSourceFileState>,
): Set<string> | null {
  const changedOrNewFiles = new Set<string>();
  for (const state of sourceStates) {
    const previousState = previousByFile.get(state.filePath);
    if (!previousState) {
      changedOrNewFiles.add(state.filePath);
      continue;
    }
    if (previousState.analyzerVersion !== state.analyzerVersion) {
      return null;
    }
    if (
      previousState.fileFingerprint !== state.fileFingerprint
      || previousState.language !== state.language
      || previousState.moduleId !== state.moduleId
    ) {
      changedOrNewFiles.add(state.filePath);
    }
  }
  return changedOrNewFiles;
}

async function buildIncrementalAnalysisEntries(
  inputs: RepoIntelligenceWorkspaceInputs,
  previousByFile: Map<string, RepoSourceFileState>,
  fileAnalysisIndex: FileAnalysisIndexPayload,
  changedOrNewFiles: Set<string>,
): Promise<Map<string, FileAnalysis | null> | null> {
  if (!inputs.sourceStates) {
    return null;
  }

  const sourceStatesByFile = mapSourceStatesByFile(inputs.sourceStates);
  const shouldReanalyzeTypeScript = Array.from(changedOrNewFiles).some((filePath) => {
    const state = sourceStatesByFile.get(filePath);
    return state ? isTypeScriptLikeLanguage(state.language) : false;
  });

  const filesToAnalyze = new Set<string>();
  for (const state of inputs.sourceStates) {
    if (shouldReanalyzeTypeScript && isTypeScriptLikeLanguage(state.language)) {
      filesToAnalyze.add(state.filePath);
      continue;
    }
    if (changedOrNewFiles.has(state.filePath)) {
      filesToAnalyze.add(state.filePath);
    }
  }

  const analysisEntries = new Map<string, FileAnalysis | null>();
  for (const state of inputs.sourceStates) {
    if (filesToAnalyze.has(state.filePath)) {
      continue;
    }
    if (!hasOwnAnalysisEntry(fileAnalysisIndex.analyses, state.filePath)) {
      return null;
    }
    analysisEntries.set(
      state.filePath,
      hydrateCachedFileAnalysis(
        state.filePath,
        state,
        fileAnalysisIndex.analyses[state.filePath] ?? null,
      ),
    );
  }

  if (filesToAnalyze.size > 0) {
    const freshAnalyses = await analyzeSourceFilesForBuild(
      inputs,
      inputs.sourceFiles.filter((filePath) => filesToAnalyze.has(filePath)),
    );
    for (const filePath of filesToAnalyze) {
      analysisEntries.set(filePath, freshAnalyses.get(filePath) ?? null);
    }
  }

  for (const state of inputs.sourceStates) {
    if (!analysisEntries.has(state.filePath)) {
      return null;
    }
    const analysis = analysisEntries.get(state.filePath) ?? null;
    if (
      analysis
      && (
        analysis.filePath !== state.filePath
        || analysis.moduleId !== state.moduleId
        || analysis.language !== state.language
      )
    ) {
      return null;
    }
    if (previousByFile.get(state.filePath)?.analyzerVersion !== undefined
      && previousByFile.get(state.filePath)?.analyzerVersion !== state.analyzerVersion) {
      return null;
    }
  }

  return analysisEntries;
}

async function tryGitDirtyIncrementalRepoIntelligenceBuild(
  inputs: RepoIntelligenceWorkspaceInputs,
  manifest: RepoIntelligenceManifest,
  fileAnalysisIndex: FileAnalysisIndexPayload,
): Promise<RepoIntelligenceIndex | null> {
  if (
    inputs.workspaceSnapshot.source !== 'git'
    || inputs.workspaceSnapshot.hasUncommittedChanges !== true
    || manifest.workspaceSnapshot.source !== 'git'
    || inputs.workspaceSnapshot.head !== manifest.workspaceSnapshot.head
    || inputs.workspaceSnapshot.branch !== manifest.workspaceSnapshot.branch
  ) {
    return null;
  }

  const dirtyPaths = new Set(inputs.dirtyPaths ?? []);
  const dirtySourceHint = await readDirtySourceHint(inputs.storageRoot);
  const previousDirtySourcePaths = new Set(
    dirtySourceHint
    && dirtySourceHint.workspaceRoot === inputs.workspaceRoot
    && dirtySourceHint.head === inputs.workspaceSnapshot.head
    && dirtySourceHint.branch === inputs.workspaceSnapshot.branch
      ? dirtySourceHint.dirtySourcePaths
      : [],
  );
  const previousByFile = mapSourceStatesByFile(manifest.sourceStates);
  const sourceStateMap = new Map<string, RepoSourceFileState>();
  const filesNeedingFreshState = new Set<string>();
  const precomputedDirtyStates = inputs.dirtySourceStateMap ?? new Map<string, RepoSourceFileState>();

  for (const filePath of inputs.sourceFiles) {
    const previousState = previousByFile.get(filePath);
    if (!previousState) {
      if (!dirtyPaths.has(filePath)) {
        return null;
      }
      filesNeedingFreshState.add(filePath);
      continue;
    }

    if (dirtyPaths.has(filePath) || previousDirtySourcePaths.has(filePath)) {
      filesNeedingFreshState.add(filePath);
      continue;
    }

    sourceStateMap.set(filePath, previousState);
  }

  if (filesNeedingFreshState.size > 0) {
    const missingFreshStateFiles = new Set<string>();
    for (const filePath of filesNeedingFreshState) {
      const precomputedState = precomputedDirtyStates.get(filePath);
      if (precomputedState) {
        sourceStateMap.set(filePath, precomputedState);
        continue;
      }
      missingFreshStateFiles.add(filePath);
    }

    if (missingFreshStateFiles.size > 0) {
      const freshStates = await collectSourceFileStateMap(
        inputs.workspaceRoot,
        missingFreshStateFiles,
        inputs.areaByFile,
        inputs.overview.areas,
      );
      for (const [filePath, state] of freshStates.entries()) {
        sourceStateMap.set(filePath, state);
      }
    }
  }

  const completeInputs = buildCompleteInputsFromSourceStates(inputs, sourceStateMap);
  if (!completeInputs?.sourceStates) {
    return null;
  }

  const changedOrNewFiles = classifyChangedOrNewSourceFiles(completeInputs.sourceStates, previousByFile);
  if (!changedOrNewFiles) {
    return null;
  }

  const analysisEntries = await buildIncrementalAnalysisEntries(
    completeInputs,
    previousByFile,
    fileAnalysisIndex,
    changedOrNewFiles,
  );
  if (!analysisEntries) {
    return null;
  }

  return materializeRepoIntelligenceIndex(completeInputs, analysisEntries);
}

async function tryStatBasedIncrementalRepoIntelligenceBuild(
  inputs: RepoIntelligenceWorkspaceInputs,
  manifest: RepoIntelligenceManifest,
  fileAnalysisIndex: FileAnalysisIndexPayload,
): Promise<RepoIntelligenceIndex | null> {
  const freshStateMap = await collectSourceFileStateMap(
    inputs.workspaceRoot,
    inputs.sourceFiles,
    inputs.areaByFile,
    inputs.overview.areas,
  );
  const completeInputs = buildCompleteInputsFromSourceStates(inputs, freshStateMap);
  if (!completeInputs?.sourceStates) {
    return null;
  }

  const previousByFile = mapSourceStatesByFile(manifest.sourceStates);
  const changedOrNewFiles = classifyChangedOrNewSourceFiles(completeInputs.sourceStates, previousByFile);
  if (!changedOrNewFiles) {
    return null;
  }

  const analysisEntries = await buildIncrementalAnalysisEntries(
    completeInputs,
    previousByFile,
    fileAnalysisIndex,
    changedOrNewFiles,
  );
  if (!analysisEntries) {
    return null;
  }

  return materializeRepoIntelligenceIndex(completeInputs, analysisEntries);
}

async function tryIncrementalRepoIntelligenceBuild(
  inputs: RepoIntelligenceWorkspaceInputs,
  manifest: RepoIntelligenceManifest | null,
): Promise<RepoIntelligenceIndex | null> {
  if (!manifest) {
    return null;
  }
  const fileAnalysisIndex = await readFileAnalysisIndex(inputs.storageRoot);

  if (!fileAnalysisIndex) {
    return null;
  }

  if (!hasCompatibleIncrementalCache(inputs, manifest, fileAnalysisIndex)) {
    return null;
  }

  const gitDirtyResult = await tryGitDirtyIncrementalRepoIntelligenceBuild(inputs, manifest, fileAnalysisIndex);
  if (gitDirtyResult) {
    return gitDirtyResult;
  }

  return tryStatBasedIncrementalRepoIntelligenceBuild(inputs, manifest, fileAnalysisIndex);
}

async function getRepoIntelligenceIndexFromInputs(
  inputs: RepoIntelligenceWorkspaceInputs,
  refresh = false,
): Promise<RepoIntelligenceIndex> {
  const manifest = !refresh
    ? await readRepoIntelligenceManifest(inputs.storageRoot)
    : null;
  const dirtySourceHint = !refresh && inputs.workspaceSnapshot.source === 'git' && inputs.workspaceSnapshot.hasUncommittedChanges === true
    ? await readDirtySourceHint(inputs.storageRoot)
    : null;

  if (
    manifest
    && canDirectReuseCleanCachedQueryIndex(inputs, manifest)
  ) {
    const cached = await safeReadJson<RepoIntelligenceIndex>(
      path.join(inputs.storageRoot, QUERY_INDEX_FILE),
      isRepoIntelligenceIndexPayload,
    );
    if (
      cached?.schemaVersion === QUERY_SCHEMA_VERSION
      && cached.workspaceRoot === inputs.workspaceRoot
      && cached.overviewGeneratedAt === manifest.overviewGeneratedAt
      && cached.sourceFileCount === manifest.sourceFileCount
      && cached.sourceFingerprint === manifest.sourceFingerprint
    ) {
      return cached;
    }
  }

  if (canDirectReuseDirtyCachedQueryIndex(inputs, dirtySourceHint)) {
    const cached = await safeReadJson<RepoIntelligenceIndex>(
      path.join(inputs.storageRoot, QUERY_INDEX_FILE),
      isRepoIntelligenceIndexPayload,
    );
    if (
      cached?.schemaVersion === QUERY_SCHEMA_VERSION
      && cached.workspaceRoot === inputs.workspaceRoot
      && cached.generatedAt === dirtySourceHint?.queryGeneratedAt
      && cached.sourceFileCount === dirtySourceHint.sourceFileCount
      && cached.sourceFingerprint === dirtySourceHint.sourceFingerprint
    ) {
      return cached;
    }
  }

  if (!refresh) {
    const incrementallyRebuilt = await tryIncrementalRepoIntelligenceBuild(inputs, manifest);
    if (incrementallyRebuilt) {
      return incrementallyRebuilt;
    }
  }

  return buildRepoIntelligenceIndexFromInputs(inputs);
}

async function getRepoIntelligenceIndexFromSnapshot(
  snapshot: RepoOverviewSnapshot,
  refresh = false,
): Promise<RepoIntelligenceIndex> {
  if (refresh) {
    const inputs = await prepareRepoIntelligenceBuildInputsFromSnapshot(snapshot);
    return getRepoIntelligenceIndexFromInputs(inputs, true);
  }

  const preflight = await buildRepoIntelligencePreflight(snapshot);
  const cleanCached = await tryDirectReuseCleanCachedQueryIndexFromPreflight(preflight);
  if (cleanCached) {
    return cleanCached;
  }

  const dirtyCached = await tryDirectReuseDirtyCachedQueryIndexFromPreflight(preflight);
  if (dirtyCached) {
    return dirtyCached;
  }

  const inputs = await prepareRepoIntelligenceBuildInputsFromSnapshot(snapshot, {
    preflight,
  });
  return getRepoIntelligenceIndexFromInputs(inputs, false);
}

export async function buildRepoIntelligenceIndex(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<RepoIntelligenceIndex> {
  const snapshot = await resolveRepoOverviewSnapshot(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const inputs = await prepareRepoIntelligenceBuildInputsFromSnapshot(snapshot);
  return buildRepoIntelligenceIndexFromInputs(inputs);
}

export async function getRepoIntelligenceIndex(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<RepoIntelligenceIndex> {
  const snapshot = await resolveRepoOverviewSnapshot(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  return getRepoIntelligenceIndexFromSnapshot(snapshot, options.refresh === true);
}

export interface ModuleContextResult {
  module: ModuleCapsule;
  freshness: string;
  confidence: number;
  evidence: string[];
}

export interface SymbolContextResult {
  symbol: RepoSymbolRecord;
  alternatives: RepoSymbolRecord[];
  callers: RepoSymbolRecord[];
  freshness: string;
  confidence: number;
}

export interface ProcessContextResult {
  process: ProcessCapsule;
  alternatives: ProcessCapsule[];
  freshness: string;
  confidence: number;
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

function buildFreshnessLabel(index: RepoIntelligenceIndex): string {
  return `${index.generatedAt} (overview ${index.overviewGeneratedAt})`;
}

function findModuleMatch(index: RepoIntelligenceIndex, query?: string, targetPath?: string): ModuleCapsule | null {
  if (targetPath) {
    const normalizedPath = normalizeRelativePath(targetPath);
    const byPath = index.modules.find((module) =>
      normalizedPath === module.root
      || normalizedPath.startsWith(`${module.root}/`)
      || module.sampleFiles.includes(normalizedPath),
    );
    if (byPath) {
      return byPath;
    }
  }

  const normalizedQuery = query?.trim().toLowerCase();
  if (!normalizedQuery) {
    return index.modules.find((module) => module.moduleId !== '.') ?? index.modules[0] ?? null;
  }

  return index.modules
    .slice()
    .sort((left, right) => right.symbolCount - left.symbolCount)
    .find((module) =>
      module.moduleId.toLowerCase() === normalizedQuery
      || module.label.toLowerCase() === normalizedQuery
      || module.root.toLowerCase() === normalizedQuery
      || path.posix.basename(module.root).toLowerCase() === normalizedQuery,
    ) ?? index.modules.find((module) =>
      module.moduleId.toLowerCase().includes(normalizedQuery)
      || module.label.toLowerCase().includes(normalizedQuery)
      || module.root.toLowerCase().includes(normalizedQuery),
    ) ?? null;
}

function findSymbolMatches(
  index: RepoIntelligenceIndex,
  symbol: string,
  moduleHint?: string,
): RepoSymbolRecord[] {
  const normalized = symbol.trim().toLowerCase();
  const normalizedModule = moduleHint?.trim().toLowerCase();

  return index.symbols
    .filter((candidate) =>
      candidate.name.toLowerCase() === normalized
      || candidate.qualifiedName.toLowerCase() === normalized
      || candidate.filePath.toLowerCase() === normalized,
    )
    .sort((left, right) => {
      const leftModuleScore = normalizedModule && (
        left.moduleId.toLowerCase().includes(normalizedModule)
        || left.filePath.toLowerCase().includes(normalizedModule)
      ) ? 1 : 0;
      const rightModuleScore = normalizedModule && (
        right.moduleId.toLowerCase().includes(normalizedModule)
        || right.filePath.toLowerCase().includes(normalizedModule)
      ) ? 1 : 0;
      if (rightModuleScore !== leftModuleScore) {
        return rightModuleScore - leftModuleScore;
      }
      return Number(right.exported) - Number(left.exported) || right.confidence - left.confidence;
    });
}

function findProcessMatches(
  index: RepoIntelligenceIndex,
  query?: string,
  moduleHint?: string,
): ProcessCapsule[] {
  const normalizedQuery = query?.trim().toLowerCase();
  const normalizedModule = moduleHint?.trim().toLowerCase();

  return index.processes
    .filter((process) => {
      const matchesQuery = !normalizedQuery
        || process.label.toLowerCase().includes(normalizedQuery)
        || process.entryFile.toLowerCase().includes(normalizedQuery)
        || (process.entrySymbol?.toLowerCase().includes(normalizedQuery) ?? false);
      const matchesModule = !normalizedModule || process.moduleId.toLowerCase().includes(normalizedModule);
      return matchesQuery && matchesModule;
    })
    .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label));
}

function collectCallers(index: RepoIntelligenceIndex, symbolId: string): RepoSymbolRecord[] {
  return index.symbols
    .filter((candidate) => candidate.callTargets.some((target) => target.symbolId === symbolId))
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, MAX_RELATED_RESULTS);
}

function resolveModuleContextFromIndex(
  index: RepoIntelligenceIndex,
  options: { module?: string; targetPath?: string },
): ModuleContextResult {
  const module = findModuleMatch(index, options.module, options.targetPath);
  if (!module) {
    throw new Error(`No module matched "${options.module ?? options.targetPath ?? 'current workspace'}".`);
  }

  return {
    module,
    freshness: buildFreshnessLabel(index),
    confidence: module.confidence,
    evidence: module.sampleFiles.slice(0, 4),
  };
}

function resolveSymbolContextFromIndex(
  index: RepoIntelligenceIndex,
  options: { symbol: string; module?: string },
): SymbolContextResult {
  const matches = findSymbolMatches(index, options.symbol, options.module);
  if (matches.length === 0) {
    throw new Error(`No symbol matched "${options.symbol}".`);
  }

  const [symbol, ...alternatives] = matches;
  return {
    symbol,
    alternatives: alternatives.slice(0, 4),
    callers: collectCallers(index, symbol.id),
    freshness: buildFreshnessLabel(index),
    confidence: symbol.confidence,
  };
}

function resolveProcessContextFromIndex(
  index: RepoIntelligenceIndex,
  options: { entry?: string; module?: string; targetPath?: string },
): ProcessContextResult {
  const processMatches = findProcessMatches(index, options.entry ?? options.targetPath, options.module);
  if (processMatches.length === 0 && options.module) {
    const module = findModuleMatch(index, options.module, options.targetPath);
    if (module?.processIds[0]) {
      const matched = index.processes.find((process) => process.id === module.processIds[0]);
      if (matched) {
        return {
          process: matched,
          alternatives: [],
          freshness: buildFreshnessLabel(index),
          confidence: matched.confidence,
        };
      }
    }
  }

  const [process, ...alternatives] = processMatches;
  if (!process) {
    throw new Error(`No process matched "${options.entry ?? options.module ?? options.targetPath ?? 'request'}".`);
  }

  return {
    process,
    alternatives: alternatives.slice(0, 4),
    freshness: buildFreshnessLabel(index),
    confidence: process.confidence,
  };
}

function resolveImpactEstimateFromIndex(
  index: RepoIntelligenceIndex,
  options: { symbol?: string; module?: string; path?: string; targetPath?: string },
  changedScope?: ChangedScopeReport,
): ImpactEstimateResult {
  let target: ImpactEstimateResult['target'] | null = null;
  let impactedModules: ModuleCapsule[] = [];
  let impactedSymbols: RepoSymbolRecord[] = [];
  let callers: RepoSymbolRecord[] = [];
  let confidence = 0.65;

  if (options.symbol) {
    const symbolContext = resolveSymbolContextFromIndex(index, {
      symbol: options.symbol,
      module: options.module,
    });
    const directModules = dedupeStrings([
      symbolContext.symbol.moduleId,
      ...symbolContext.symbol.callTargets.map((targetRef) => targetRef.moduleId),
      ...symbolContext.callers.map((caller) => caller.moduleId),
    ]);

    target = {
      kind: 'symbol',
      label: symbolContext.symbol.name,
      moduleId: symbolContext.symbol.moduleId,
      filePath: symbolContext.symbol.filePath,
    };
    impactedModules = index.modules.filter((module) => directModules.includes(module.moduleId));
    impactedSymbols = dedupeStrings([
      symbolContext.symbol.id,
      ...symbolContext.symbol.callTargets.map((targetRef) => targetRef.symbolId),
      ...symbolContext.callers.map((caller) => caller.id),
    ])
      .map((id) => index.symbols.find((symbol) => symbol.id === id))
      .filter((symbol): symbol is RepoSymbolRecord => symbol !== undefined);
    callers = symbolContext.callers;
    confidence = symbolContext.confidence;
  } else if (options.path) {
    const normalizedPath = normalizeRelativePath(options.path);
    const module = findModuleMatch(index, undefined, normalizedPath);
    const symbolsInFile = index.symbols.filter((symbol) => symbol.filePath === normalizedPath);
    target = {
      kind: 'path',
      label: normalizedPath,
      moduleId: module?.moduleId,
      filePath: normalizedPath,
    };
    impactedModules = module ? [module, ...index.modules.filter((candidate) => module.dependents.includes(candidate.moduleId))] : [];
    impactedSymbols = symbolsInFile;
    callers = symbolsInFile.flatMap((symbol) => collectCallers(index, symbol.id)).slice(0, MAX_RELATED_RESULTS);
    confidence = module?.confidence ?? 0.62;
  } else {
    const module = findModuleMatch(index, options.module, options.targetPath);
    if (!module) {
      throw new Error('impact_estimate requires one of symbol, path, or module.');
    }
    target = {
      kind: 'module',
      label: module.label,
      moduleId: module.moduleId,
    };
    impactedModules = [module, ...index.modules.filter((candidate) => module.dependents.includes(candidate.moduleId))];
    impactedSymbols = index.symbols.filter((symbol) => symbol.moduleId === module.moduleId).slice(0, MAX_RELATED_RESULTS);
    callers = impactedSymbols.flatMap((symbol) => collectCallers(index, symbol.id)).slice(0, MAX_RELATED_RESULTS);
    confidence = module.confidence;
  }

  const changedOverlap = changedScope
    ? changedScope.files.filter((file) =>
      impactedModules.some((module) => file.areaId === module.moduleId)
      || impactedSymbols.some((symbol) => file.path === symbol.filePath),
    ).length
    : 0;

  return {
    target,
    summary: changedOverlap > 0
      ? `${target.label} overlaps with ${changedOverlap} currently changed file(s); validate blast radius before editing.`
      : `${target.label} primarily affects ${dedupeStrings(impactedModules.map((module) => module.label), 4).join(', ') || 'its local module'} and ${impactedSymbols.length} indexed symbol(s).`,
    impactedModules,
    impactedSymbols: impactedSymbols.slice(0, MAX_RELATED_RESULTS),
    callers: callers.slice(0, MAX_RELATED_RESULTS),
    changedScope,
    freshness: buildFreshnessLabel(index),
    confidence,
  };
}

export async function getModuleContext(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: { module?: string; targetPath?: string; refresh?: boolean } = {},
): Promise<ModuleContextResult> {
  const index = await getRepoIntelligenceIndex(context, options);
  return resolveModuleContextFromIndex(index, options);
}

export async function getSymbolContext(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: { symbol: string; module?: string; targetPath?: string; refresh?: boolean },
): Promise<SymbolContextResult> {
  const index = await getRepoIntelligenceIndex(context, options);
  return resolveSymbolContextFromIndex(index, options);
}

export async function getProcessContext(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: { entry?: string; module?: string; targetPath?: string; refresh?: boolean },
): Promise<ProcessContextResult> {
  const index = await getRepoIntelligenceIndex(context, options);
  return resolveProcessContextFromIndex(index, options);
}

export async function getImpactEstimate(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: { symbol?: string; module?: string; path?: string; targetPath?: string; refresh?: boolean },
): Promise<ImpactEstimateResult> {
  const snapshot = await resolveRepoOverviewSnapshot(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const index = await getRepoIntelligenceIndexFromSnapshot(snapshot, options.refresh === true);
  let changedScope: ChangedScopeReport | undefined;
  try {
    changedScope = await analyzeChangedScopeFromSnapshot(snapshot, {
      scope: 'all',
    });
  } catch (error) {
    debugLogRepoIntelligence('impact_estimate could not load changed scope.', error);
    changedScope = undefined;
  }
  return resolveImpactEstimateFromIndex(index, options, changedScope);
}

export async function getRepoRoutingSignals(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<KodaXRepoRoutingSignals> {
  const snapshot = await resolveRepoOverviewSnapshot(context, {
    targetPath: options.targetPath,
    refresh: options.refresh,
  });
  const activeModuleTargetPath = options.targetPath ?? (context.executionCwd ? '.' : undefined);
  const [index, changedScope] = await Promise.all([
    getRepoIntelligenceIndexFromSnapshot(snapshot, options.refresh === true),
    analyzeChangedScopeFromSnapshot(snapshot, {
      scope: 'all',
    }).catch((error) => {
      debugLogRepoIntelligence('Routing signals could not load changed scope.', error);
      return null;
    }),
  ]);
  let moduleResult: ModuleContextResult | null = null;
  let impactResult: ImpactEstimateResult | null = null;
  try {
    moduleResult = resolveModuleContextFromIndex(index, {
      targetPath: activeModuleTargetPath,
    });
  } catch (error) {
    debugLogRepoIntelligence('Routing signals could not resolve module context.', error);
  }
  try {
    impactResult = resolveImpactEstimateFromIndex(index, {
      targetPath: activeModuleTargetPath,
    }, changedScope ?? undefined);
  } catch (error) {
    debugLogRepoIntelligence('Routing signals could not resolve impact estimate.', error);
  }

  const changedModules = changedScope?.areasTouched.map((area) => area.areaId).slice(0, 8) ?? [];
  const changedFileCount = changedScope?.totalChangedFiles ?? 0;
  const changedLineCount = changedScope?.changedLineCount ?? 0;
  const addedLineCount = changedScope?.addedLineCount ?? 0;
  const deletedLineCount = changedScope?.deletedLineCount ?? 0;
  const touchedModuleCount = changedScope?.areasTouched.length ?? 0;
  const impactedModuleCount = impactResult?.impactedModules.length ?? (moduleResult ? 1 : 0);
  const suggestedComplexity = deriveRoutingComplexity(
    changedFileCount,
    changedLineCount,
    touchedModuleCount,
    impactedModuleCount,
  );
  const reviewScale = deriveReviewScale(
    changedFileCount,
    changedLineCount,
    touchedModuleCount,
  );
  const moduleConfidence = moduleResult?.confidence;
  const impactConfidence = impactResult?.confidence;
  const lowConfidence = (moduleConfidence ?? 1) < 0.72 || (impactConfidence ?? 1) < 0.72;
  const predominantCapabilityTier = moduleResult?.module.languages[0]?.capabilityTier
    ?? index.languages[0]?.capabilityTier
    ?? 'low';
  const plannerBias =
    suggestedComplexity === 'complex'
    || suggestedComplexity === 'systemic'
    || changedModules.length > 1
    || (impactResult?.impactedModules.length ?? 0) > 1;
  const investigationBias =
    lowConfidence
    || (changedScope?.riskHints.length ?? 0) > 0
    || (impactResult?.changedScope?.riskHints.length ?? 0) > 0;

  return {
    workspaceRoot: index.workspaceRoot,
    changedFileCount,
    changedLineCount,
    addedLineCount,
    deletedLineCount,
    touchedModuleCount,
    changedModules,
    crossModule: touchedModuleCount > 1 || impactedModuleCount > 1,
    reviewScale,
    riskHints: dedupeStrings([
      ...(changedScope?.riskHints ?? []),
      ...(impactResult?.changedScope?.riskHints ?? []),
    ], 4),
    activeModuleId: moduleResult?.module.moduleId,
    activeModuleConfidence: moduleConfidence,
    activeImpactConfidence: impactConfidence,
    impactedModuleCount,
    impactedSymbolCount: impactResult?.impactedSymbols.length ?? 0,
    predominantCapabilityTier,
    suggestedComplexity,
    plannerBias,
    investigationBias,
    lowConfidence,
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
  ].join('\n');
}
