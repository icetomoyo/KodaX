import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';
import type {
  LanguageCapabilityTier,
  ModuleCapsule,
  ProcessCapsule,
  RepoIntelligenceIndex,
  RepoLanguageId,
  RepoLanguageSupport,
  RepoSymbolKind,
  RepoSymbolRecord,
  RepoSymbolReference,
} from './semantic-types.js';
import type {
  RepoAreaOverview,
  RepoOverview,
  RepoOverviewInventory,
  RepoOverviewSnapshot,
} from './public-bridge.js';
import {
  ensureRepoIntelligenceStorageDir,
  resolveRepoIntelligenceStorageRoot,
  writeJsonFileAtomic as writeJsonFileAtomicInternal,
} from './internal.js';

export const QUERY_INDEX_FILE = 'repo-intelligence-index.json';
export const QUERY_MANIFEST_FILE = 'repo-intelligence-manifest.json';
export const FILE_ANALYSIS_INDEX_FILE = 'file-analysis-index.json';
export const DIRTY_SOURCE_HINT_FILE = 'repo-intelligence-dirty-source-hint.json';
export const QUERY_SCHEMA_VERSION = 9;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_SYMBOLS_PER_FILE = 40;
export const MAX_PROCESS_STEPS = 8;
export const MAX_RELATED_RESULTS = 8;
export const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.cpp', '.cc', '.cxx', '.c', '.hpp', '.h',
]);
export const CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'sizeof', 'new',
  'function', 'class', 'def', 'await', 'yield', 'super', 'import', 'from',
]);

export type RepoIntelligenceAnalysisProfile = 'full' | 'light';

export interface RepoIntelligenceManifest {
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

export interface ExtractedSymbol {
  name: string;
  kind: RepoSymbolKind;
  line: number;
  signature: string;
  exported: boolean;
  confidenceBoost: number;
  qualifier?: string;
  calls?: string[];
}

export interface FileAnalysis {
  filePath: string;
  moduleId: string;
  language: RepoLanguageId;
  capabilityTier: LanguageCapabilityTier;
  importPaths: string[];
  symbols: RepoSymbolRecord[];
}

export interface RepoSourceFileState {
  filePath: string;
  fileFingerprint: string;
  language: RepoLanguageId;
  moduleId: string;
  analyzerVersion: number;
}

export interface RepoWorkspaceSnapshot {
  source: 'git' | 'filesystem';
  branch?: string;
  head?: string;
  hasUncommittedChanges?: boolean;
}

export interface CachedRepoSymbolRecord {
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

export interface CachedFileAnalysisEntry {
  importPaths: string[];
  symbols: CachedRepoSymbolRecord[];
}

export interface FileAnalysisIndexPayload {
  schemaVersion: number;
  workspaceRoot: string;
  generatedAt: string;
  sourceFingerprint: string;
  analyses: Record<string, CachedFileAnalysisEntry | null>;
}

export interface DirtySourceHintPayload {
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


export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isRepoIntelligenceIndexPayload(value: unknown): value is RepoIntelligenceIndex {
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

export function isRepoLanguageId(value: unknown): value is RepoLanguageId {
  return value === 'typescript'
    || value === 'javascript'
    || value === 'python'
    || value === 'java'
    || value === 'go'
    || value === 'rust'
    || value === 'cpp'
    || value === 'unknown';
}

export function isLanguageCapabilityTier(value: unknown): value is LanguageCapabilityTier {
  return value === 'high' || value === 'medium' || value === 'low';
}

export function isRepoSymbolKind(value: unknown): value is RepoSymbolKind {
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

export function isRepoLanguageSupportPayload(value: unknown): value is RepoLanguageSupport {
  return isRecord(value)
    && isRepoLanguageId(value.language)
    && isLanguageCapabilityTier(value.capabilityTier)
    && typeof value.fileCount === 'number';
}

export function isRepoSymbolReferencePayload(value: unknown): value is RepoSymbolReference {
  return isRecord(value)
    && typeof value.symbolId === 'string'
    && typeof value.name === 'string'
    && typeof value.filePath === 'string'
    && typeof value.moduleId === 'string'
    && (value.reason === 'same-module' || value.reason === 'imported-module' || value.reason === 'name-match');
}

export function isRepoSymbolRecordPayload(value: unknown): value is RepoSymbolRecord {
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

export function isRepoSourceFileStatePayload(value: unknown): value is RepoSourceFileState {
  return isRecord(value)
    && typeof value.filePath === 'string'
    && typeof value.fileFingerprint === 'string'
    && isRepoLanguageId(value.language)
    && typeof value.moduleId === 'string'
    && typeof value.analyzerVersion === 'number';
}

export function isRepoWorkspaceSnapshotPayload(value: unknown): value is RepoWorkspaceSnapshot {
  return isRecord(value)
    && (value.source === 'git' || value.source === 'filesystem')
    && (value.branch === undefined || typeof value.branch === 'string')
    && (value.head === undefined || typeof value.head === 'string')
    && (value.hasUncommittedChanges === undefined || typeof value.hasUncommittedChanges === 'boolean');
}

export function isRepoIntelligenceManifestPayload(value: unknown): value is RepoIntelligenceManifest {
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

export function isCachedRepoSymbolRecordPayload(value: unknown): value is CachedRepoSymbolRecord {
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

export function isCachedFileAnalysisEntryPayload(value: unknown): value is CachedFileAnalysisEntry {
  return isRecord(value)
    && Array.isArray(value.importPaths)
    && value.importPaths.every((importPath) => typeof importPath === 'string')
    && Array.isArray(value.symbols)
    && value.symbols.every((symbol) => isCachedRepoSymbolRecordPayload(symbol));
}

export function isFileAnalysisIndexPayload(value: unknown): value is FileAnalysisIndexPayload {
  return isRecord(value)
    && typeof value.schemaVersion === 'number'
    && typeof value.workspaceRoot === 'string'
    && typeof value.generatedAt === 'string'
    && typeof value.sourceFingerprint === 'string'
    && isRecord(value.analyses)
    && Object.values(value.analyses).every((analysis) => analysis === null || isCachedFileAnalysisEntryPayload(analysis));
}

export function isDirtySourceHintPayload(value: unknown): value is DirtySourceHintPayload {
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

export function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function languageFromFile(filePath: string): RepoLanguageId {
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

export function capabilityTierForLanguage(language: RepoLanguageId): LanguageCapabilityTier {
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

export function analyzerVersionForLanguage(
  language: RepoLanguageId,
  profile: RepoIntelligenceAnalysisProfile = 'full',
): number {
  if ((language === 'typescript' || language === 'javascript') && profile === 'light') {
    return 2;
  }
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

export function baseConfidenceForTier(tier: LanguageCapabilityTier): number {
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

/**
 * Compute module-level confidence as an aggregate of per-symbol confidences.
 *
 * **Why this replaces the previous formula** (2026-05-14 / FEATURE_162):
 *
 * The old formula was `Math.min(0.95, 0.58 + languages.length * 0.06 +
 * Math.min(symbolCount, 12) * 0.01)` — purely a function of module
 * complexity (language diversity + capped symbol count). For any TS-only
 * module with ≥12 symbols (i.e. virtually every meaningful module in a
 * single-language stack), this saturated to a fixed 0.76. The consumer-
 * side gate at `repo-intelligence.ts:198` (KodaX) checks `confidence < 0.72`
 * as a "should I tell the LLM to use refinement tools?" trigger, but with
 * the old formula the gate barely fires in homogeneous-language repos —
 * the metric being thresholded was misnamed and effectively static.
 *
 * **New semantics**: each `RepoSymbolRecord.confidence` already encodes
 * (a) parser capability tier (via `baseConfidenceForTier`) and (b) per-
 * symbol resolution boost (e.g. +0.03 when call targets resolved). Those
 * are real signals of analysis quality. Averaging them gives a module-
 * level number that actually means "how much should the LLM trust this
 * module capsule".
 *
 * **Fallback**: when a module has no analyzed symbols (rare — docs-only
 * or config-only "areas" carry no symbols), use the dominant language
 * tier as a baseline floor.
 *
 * Range floor/ceiling clamps (0.32 / 0.95) match the legacy formula's
 * range so downstream code paths comparing against fixed offsets (e.g.
 * `Math.max(0.32, module.confidence - 0.08)` at the impact-estimate
 * call site) preserve their guarantees.
 */
export function computeModuleConfidence(
  symbolsInModule: readonly RepoSymbolRecord[],
  languages: readonly { capabilityTier: LanguageCapabilityTier }[],
): number {
  if (symbolsInModule.length > 0) {
    const sum = symbolsInModule.reduce((acc, symbol) => acc + symbol.confidence, 0);
    return Math.min(0.95, Math.max(0.32, sum / symbolsInModule.length));
  }
  const dominantLang = languages[0];
  if (dominantLang) {
    return baseConfidenceForTier(dominantLang.capabilityTier);
  }
  return 0.4;
}

export async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureStorageDir(
  workspaceRoot: string,
  profile: RepoIntelligenceAnalysisProfile = 'full',
): Promise<string> {
  const baseStorageRoot = resolveRepoIntelligenceStorageRoot(workspaceRoot);
  const storageRoot = profile === 'light'
    ? path.join(baseStorageRoot, 'light')
    : baseStorageRoot;
  await ensureRepoIntelligenceStorageDir(storageRoot);
  return storageRoot;
}

export interface SourceFileBuckets {
  typeScriptFiles: string[];
  pythonFiles: string[];
  goFiles: string[];
  rustFiles: string[];
  fallbackFiles: string[];
}

export interface RepoIntelligenceWorkspaceInputs {
  analysisProfile: RepoIntelligenceAnalysisProfile;
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

export interface RepoIntelligencePreflight {
  analysisProfile: RepoIntelligenceAnalysisProfile;
  workspaceRoot: string;
  storageRoot: string;
  workspaceSnapshot: RepoWorkspaceSnapshot;
  overviewGeneratedAt: string;
  overviewFingerprint: string;
  dirtyPaths?: string[];
  dirtyPathsFingerprint?: string;
  dirtySourcePaths: string[];
  dirtySourceStateMap?: Map<string, RepoSourceFileState>;
  dirtySourceFingerprint?: string;
}

export function computeFileFingerprint(
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

export function computeSourceFingerprint(
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

export function computeOverviewFingerprint(
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

export function computePathFingerprint(
  filePaths: Iterable<string>,
): string {
  const hash = createHash('sha256');
  for (const filePath of Array.from(filePaths, (entry) => normalizeRelativePath(entry)).sort((left, right) => left.localeCompare(right))) {
    hash.update(filePath);
    hash.update('|');
  }
  return hash.digest('hex');
}

export function workspaceSnapshotFromOverview(overview: RepoOverview): RepoWorkspaceSnapshot {
  return {
    source: overview.source,
    branch: overview.git?.branch,
    head: overview.git?.head,
    hasUncommittedChanges: overview.git?.hasUncommittedChanges,
  };
}

export function isCleanGitSnapshot(snapshot: RepoWorkspaceSnapshot): boolean {
  return snapshot.source === 'git' && snapshot.hasUncommittedChanges === false;
}

export function sameWorkspaceSnapshot(
  left: RepoWorkspaceSnapshot,
  right: RepoWorkspaceSnapshot,
): boolean {
  return left.source === right.source
    && left.branch === right.branch
    && left.head === right.head
    && left.hasUncommittedChanges === right.hasUncommittedChanges;
}

export function shouldPersistRepoIntelligenceBaseline(
  inputs: RepoIntelligenceWorkspaceInputs,
): boolean {
  return inputs.workspaceSnapshot.source !== 'git' || isCleanGitSnapshot(inputs.workspaceSnapshot);
}

export function getDirtySourcePathsForInputs(
  inputs: Pick<RepoIntelligenceWorkspaceInputs, 'dirtyPaths' | 'sourceFileSet'>,
): string[] {
  return (inputs.dirtyPaths ?? [])
    .filter((filePath) => inputs.sourceFileSet.has(filePath))
    .sort((left, right) => left.localeCompare(right));
}


export async function writeJsonFileAtomic(filePath: string, payload: unknown): Promise<void> {
  return writeJsonFileAtomicInternal(filePath, payload);
}

export function isTestFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  return normalized.includes('/test/')
    || normalized.includes('/tests/')
    || normalized.includes('__tests__')
    || /\.(test|spec)\.[^.]+$/.test(normalized);
}

export function isDocFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  return normalized.startsWith('docs/')
    || normalized.endsWith('.md')
    || normalized.endsWith('.mdx')
    || normalized.endsWith('.rst');
}

export function findAreaForFile(filePath: string, areas: RepoAreaOverview[]): RepoAreaOverview {
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

export function dedupeStrings(values: string[], max = values.length): string[] {
  return Array.from(new Set(values.filter(Boolean))).slice(0, max);
}

export function extractImports(content: string, language: RepoLanguageId): string[] {
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
