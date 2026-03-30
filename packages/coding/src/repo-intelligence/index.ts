import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveExecutionCwd } from '../runtime-paths.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { debugLogRepoIntelligence, safeReadJson } from './internal.js';

const execFileAsync = promisify(execFile);

const REPO_INTELLIGENCE_DIR = path.join('.agent', 'repo-intelligence');
const MANIFEST_FILE = 'manifest.json';
const OVERVIEW_FILE = 'repo-overview.json';
const CHANGED_SCOPE_FILE = 'changed-scope.json';
const SCHEMA_VERSION = 1;
const MAX_TRACKED_FILES = 12000;
const MAX_OUTPUT_AREAS = 8;
const MAX_OUTPUT_FILES = 20;
const MAX_SAMPLE_FILES = 3;
const GIT_TIMEOUT_MS = 5000;
const MANAGED_METADATA_PREFIXES = ['.agent/', '.kodax/'];

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.cpp', '.cc', '.cxx', '.c', '.hpp', '.h',
  '.cs', '.rb', '.php', '.swift', '.kt', '.kts', '.scala', '.sh',
]);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt']);
const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', '__mocks__', 'spec', 'specs']);
const SPECIAL_AREA_KINDS = new Map<string, RepoAreaKind>([
  ['docs', 'docs'],
  ['test', 'tests'],
  ['tests', 'tests'],
  ['scripts', 'scripts'],
  ['bin', 'scripts'],
  ['tools', 'scripts'],
  ['src', 'directory'],
  ['server', 'directory'],
  ['client', 'directory'],
  ['web', 'directory'],
  ['api', 'directory'],
  ['cmd', 'directory'],
  ['examples', 'directory'],
  ['example', 'directory'],
]);
const PACKAGE_CONTAINERS = new Set(['packages', 'apps', 'libs', 'services']);
const CONFIG_FILE_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'tsconfig.json',
  'tsconfig.build.json',
  'vitest.config.ts',
  'vitest.config.js',
  'vite.config.ts',
  'vite.config.js',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Makefile',
  'Dockerfile',
]);
const KEY_DOC_NAMES = new Set([
  'README.md',
  'README_CN.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/HLD.md',
  'docs/PRD.md',
  'docs/ADR.md',
  'docs/DD.md',
  'docs/FEATURE_LIST.md',
]);
const ENTRY_HINT_BASENAMES = [
  'index.ts',
  'index.js',
  'main.ts',
  'main.js',
  'app.ts',
  'app.js',
  'server.ts',
  'server.js',
  'cli.ts',
  'cli.js',
  'kodax_cli.ts',
  'main.py',
];
const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.agent',
  '.kodax',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

export type RepoAreaKind = 'package' | 'directory' | 'docs' | 'tests' | 'scripts' | 'root';
export type ChangedFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface RepoAreaOverview {
  id: string;
  label: string;
  kind: RepoAreaKind;
  root: string;
  fileCount: number;
  manifests: string[];
  sampleFiles: string[];
}

export interface RepoOverview {
  schemaVersion: number;
  workspaceRoot: string;
  source: 'git' | 'filesystem';
  generatedAt: string;
  truncated: boolean;
  git?: {
    branch?: string;
    head?: string;
    hasUncommittedChanges?: boolean;
  };
  fileStats: {
    totalFiles: number;
    sourceFiles: number;
    docFiles: number;
    testFiles: number;
    configFiles: number;
  };
  manifests: string[];
  keyDocs: string[];
  entryHints: string[];
  areas: RepoAreaOverview[];
}

export interface ChangedScopeAreaSummary {
  areaId: string;
  label: string;
  root: string;
  kind: RepoAreaKind;
  fileCount: number;
  files: string[];
}

export interface ChangedFileEntry {
  path: string;
  status: ChangedFileStatus;
  category: 'source' | 'docs' | 'tests' | 'config' | 'other';
  areaId: string;
}

export interface ChangedScopeReport {
  schemaVersion: number;
  workspaceRoot: string;
  analyzedAt: string;
  scope: 'unstaged' | 'staged' | 'all' | 'compare';
  baseRef?: string;
  overviewGeneratedAt?: string;
  totalChangedFiles: number;
  changedLineCount: number;
  addedLineCount: number;
  deletedLineCount: number;
  categories: Record<'source' | 'docs' | 'tests' | 'config' | 'other', number>;
  areasTouched: ChangedScopeAreaSummary[];
  files: ChangedFileEntry[];
  riskHints: string[];
}

interface GitSummary {
  branch?: string;
  head?: string;
  hasUncommittedChanges?: boolean;
}

interface ChangedFileCandidate {
  path: string;
  status: ChangedFileStatus;
}

interface ChangedLineStats {
  changedLineCount: number;
  addedLineCount: number;
  deletedLineCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRepoAreaOverview(value: unknown): value is RepoAreaOverview {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && typeof value.kind === 'string'
    && typeof value.root === 'string'
    && typeof value.fileCount === 'number'
    && Array.isArray(value.manifests)
    && Array.isArray(value.sampleFiles);
}

function isRepoOverviewPayload(value: unknown): value is RepoOverview {
  return isRecord(value)
    && typeof value.schemaVersion === 'number'
    && typeof value.workspaceRoot === 'string'
    && (value.source === 'git' || value.source === 'filesystem')
    && typeof value.generatedAt === 'string'
    && typeof value.truncated === 'boolean'
    && isRecord(value.fileStats)
    && typeof value.fileStats.totalFiles === 'number'
    && typeof value.fileStats.sourceFiles === 'number'
    && typeof value.fileStats.docFiles === 'number'
    && typeof value.fileStats.testFiles === 'number'
    && typeof value.fileStats.configFiles === 'number'
    && Array.isArray(value.manifests)
    && Array.isArray(value.keyDocs)
    && Array.isArray(value.entryHints)
    && Array.isArray(value.areas)
    && value.areas.every((area) => isRepoAreaOverview(area));
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.toString();
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

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isManagedMetadataPath(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath);
  return normalized === '.agent'
    || normalized === '.kodax'
    || MANAGED_METADATA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

async function resolveWorkspaceRoot(targetPath: string): Promise<{ workspaceRoot: string; source: 'git' | 'filesystem' }> {
  try {
    const root = (await runGit(['rev-parse', '--show-toplevel'], targetPath)).trim();
    if (root) {
      return { workspaceRoot: path.resolve(root), source: 'git' };
    }
  } catch {
    // Fall through to filesystem mode.
  }

  return { workspaceRoot: path.resolve(targetPath), source: 'filesystem' };
}

async function resolveTargetDirectory(targetPath: string): Promise<string> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory() ? targetPath : path.dirname(targetPath);
  } catch {
    return targetPath;
  }
}

async function listGitFiles(workspaceRoot: string): Promise<{ files: string[]; truncated: boolean }> {
  const tracked = (await runGit(['ls-files', '-z'], workspaceRoot)).split('\0').filter(Boolean);
  const untracked = (await runGit(['ls-files', '--others', '--exclude-standard', '-z'], workspaceRoot))
    .split('\0')
    .filter(Boolean);
  const files = Array.from(new Set([...tracked, ...untracked]
    .map(normalizeRelativePath)
    .filter((file) => !isManagedMetadataPath(file))));
  return {
    files: files.slice(0, MAX_TRACKED_FILES),
    truncated: files.length > MAX_TRACKED_FILES,
  };
}

async function walkFilesystemFiles(workspaceRoot: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  async function walk(currentDir: string): Promise<void> {
    if (files.length >= MAX_TRACKED_FILES) {
      truncated = true;
      return;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_TRACKED_FILES) {
        truncated = true;
        return;
      }

      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) {
          continue;
        }
        await walk(path.join(currentDir, entry.name));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = normalizeRelativePath(path.relative(workspaceRoot, path.join(currentDir, entry.name)));
      if (!isManagedMetadataPath(relativePath)) {
        files.push(relativePath);
      }
    }
  }

  await walk(workspaceRoot);
  return { files, truncated };
}

function isTestFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  const parts = normalized.split('/');
  if (parts.some((segment) => TEST_SEGMENTS.has(segment))) {
    return true;
  }
  return /\.(test|spec)\.[^.]+$/.test(normalized);
}

function classifyFileCategory(relativePath: string): 'source' | 'docs' | 'tests' | 'config' | 'other' {
  const normalized = normalizeRelativePath(relativePath);
  const ext = path.extname(normalized).toLowerCase();
  const base = path.posix.basename(normalized);

  if (CONFIG_FILE_NAMES.has(base)) {
    return 'config';
  }
  if (normalized.startsWith('docs/') || KEY_DOC_NAMES.has(normalized) || DOC_EXTENSIONS.has(ext)) {
    return 'docs';
  }
  if (isTestFile(normalized)) {
    return 'tests';
  }
  if (SOURCE_EXTENSIONS.has(ext)) {
    return 'source';
  }
  return 'other';
}

async function readAreaLabel(workspaceRoot: string, areaRoot: string): Promise<string> {
  if (areaRoot === '.') {
    return 'Workspace Root';
  }

  const packageJsonPath = path.join(workspaceRoot, areaRoot, 'package.json');
  const pyprojectPath = path.join(workspaceRoot, areaRoot, 'pyproject.toml');
  const cargoTomlPath = path.join(workspaceRoot, areaRoot, 'Cargo.toml');

  if (await exists(packageJsonPath)) {
    try {
      const content = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as { name?: string };
      if (content.name?.trim()) {
        return content.name.trim();
      }
    } catch {
      // Fall back to directory name.
    }
  }

  for (const candidate of [pyprojectPath, cargoTomlPath]) {
    if (!(await exists(candidate))) {
      continue;
    }

    try {
      const content = await fs.readFile(candidate, 'utf8');
      const match = content.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (match?.[1]) {
        return match[1];
      }
    } catch {
      // Fall back to directory name.
    }
  }

  return path.posix.basename(areaRoot);
}

async function buildAreas(workspaceRoot: string, files: string[]): Promise<RepoAreaOverview[]> {
  const roots = new Map<string, RepoAreaKind>();

  for (const file of files) {
    const normalized = normalizeRelativePath(file);
    const parts = normalized.split('/');

    if (parts.length === 1) {
      roots.set('.', 'root');
      continue;
    }

    if (PACKAGE_CONTAINERS.has(parts[0] ?? '') && parts[1]) {
      roots.set(`${parts[0]}/${parts[1]}`, 'package');
      continue;
    }

    const specialKind = SPECIAL_AREA_KINDS.get(parts[0] ?? '');
    if (specialKind) {
      roots.set(parts[0]!, specialKind);
    }
  }

  if (roots.size === 0) {
    roots.set('.', 'root');
  }

  const areas: RepoAreaOverview[] = [];
  for (const [root, kind] of Array.from(roots.entries()).sort((left, right) => left[0].localeCompare(right[0]))) {
    const rootPrefix = root === '.' ? '' : `${root}/`;
    const areaFiles = files
      .filter((file) => root === '.' ? !file.includes('/') : file === root || file.startsWith(rootPrefix))
      .sort((left, right) => left.localeCompare(right));
    const manifests = areaFiles.filter((file) => {
      const relativeToArea = root === '.' ? file : file.slice(rootPrefix.length);
      return !relativeToArea.includes('/') && CONFIG_FILE_NAMES.has(path.posix.basename(file));
    });

    areas.push({
      id: root,
      label: await readAreaLabel(workspaceRoot, root),
      kind,
      root,
      fileCount: areaFiles.length,
      manifests: manifests.slice(0, MAX_SAMPLE_FILES),
      sampleFiles: areaFiles.slice(0, MAX_SAMPLE_FILES),
    });
  }

  return areas.sort((left, right) => {
    if (right.fileCount !== left.fileCount) {
      return right.fileCount - left.fileCount;
    }
    return left.root.localeCompare(right.root);
  });
}

async function getGitSummary(workspaceRoot: string, source: 'git' | 'filesystem'): Promise<GitSummary | undefined> {
  if (source !== 'git') {
    return undefined;
  }

  try {
    const [branch, head, status] = await Promise.all([
      runGit(['branch', '--show-current'], workspaceRoot),
      runGit(['rev-parse', 'HEAD'], workspaceRoot),
      runGit(['status', '--short'], workspaceRoot),
    ]);

    return {
      branch: branch.trim() || undefined,
      head: head.trim() || undefined,
      hasUncommittedChanges: status.trim().length > 0,
    };
  } catch {
    return undefined;
  }
}

export async function collectWorkspaceFilesForSource(
  workspaceRoot: string,
  source: 'git' | 'filesystem',
): Promise<{ files: string[]; truncated: boolean }> {
  if (source === 'git') {
    try {
      return await listGitFiles(workspaceRoot);
    } catch {
      return walkFilesystemFiles(workspaceRoot);
    }
  }

  return walkFilesystemFiles(workspaceRoot);
}

export async function buildRepoOverview(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  targetPath?: string,
): Promise<RepoOverview> {
  const baseDir = resolveExecutionCwd(context);
  const targetDir = await resolveTargetDirectory(targetPath ? path.resolve(baseDir, targetPath) : baseDir);
  const { workspaceRoot, source } = await resolveWorkspaceRoot(targetDir);
  const { files, truncated } = await collectWorkspaceFilesForSource(workspaceRoot, source);
  const git = await getGitSummary(workspaceRoot, source);
  const manifests = files.filter((file) => CONFIG_FILE_NAMES.has(path.posix.basename(file))).slice(0, 12);
  const keyDocs = files
    .filter((file) => KEY_DOC_NAMES.has(file) || (/^README/i.test(path.posix.basename(file)) && DOC_EXTENSIONS.has(path.extname(file).toLowerCase())))
    .slice(0, 8);
  const entryHints = files
    .filter((file) => ENTRY_HINT_BASENAMES.includes(path.posix.basename(file)))
    .slice(0, 8);

  const fileStats = {
    totalFiles: files.length,
    sourceFiles: files.filter((file) => classifyFileCategory(file) === 'source').length,
    docFiles: files.filter((file) => classifyFileCategory(file) === 'docs').length,
    testFiles: files.filter((file) => classifyFileCategory(file) === 'tests').length,
    configFiles: files.filter((file) => classifyFileCategory(file) === 'config').length,
  };

  const overview: RepoOverview = {
    schemaVersion: SCHEMA_VERSION,
    workspaceRoot,
    source,
    generatedAt: new Date().toISOString(),
    truncated,
    git,
    fileStats,
    manifests,
    keyDocs,
    entryHints,
    areas: await buildAreas(workspaceRoot, files),
  };

  const storageRoot = await ensureStorageDir(workspaceRoot);
  await fs.writeFile(path.join(storageRoot, MANIFEST_FILE), `${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: overview.generatedAt,
    workspaceRoot: overview.workspaceRoot,
    git: overview.git ?? null,
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(storageRoot, OVERVIEW_FILE), `${JSON.stringify(overview, null, 2)}\n`, 'utf8');

  return overview;
}

export async function getRepoOverview(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: { targetPath?: string; refresh?: boolean } = {},
): Promise<RepoOverview> {
  const baseDir = resolveExecutionCwd(context);
  const targetDir = await resolveTargetDirectory(options.targetPath ? path.resolve(baseDir, options.targetPath) : baseDir);
  const { workspaceRoot, source } = await resolveWorkspaceRoot(targetDir);
  const storageRoot = path.join(workspaceRoot, REPO_INTELLIGENCE_DIR);
  const cached = await safeReadJson<RepoOverview>(
    path.join(storageRoot, OVERVIEW_FILE),
    isRepoOverviewPayload,
  );

  if (!options.refresh && cached?.schemaVersion === SCHEMA_VERSION) {
    const liveGit = await getGitSummary(workspaceRoot, source);
    const gitMatches = source !== 'git'
      || (
        liveGit?.hasUncommittedChanges !== true
        && cached.git?.head === liveGit?.head
        && cached.git?.branch === liveGit?.branch
        && cached.git?.hasUncommittedChanges === liveGit?.hasUncommittedChanges
      );
    if (gitMatches) {
      return cached;
    }
  }

  return buildRepoOverview(context, options.targetPath);
}

function formatList(label: string, items: string[]): string[] {
  if (items.length === 0) {
    return [];
  }
  return [`${label}: ${items.join(' | ')}`];
}

export function renderRepoOverview(overview: RepoOverview): string {
  const lines: string[] = [
    `Repository overview for ${path.basename(overview.workspaceRoot)}`,
    `Root: ${overview.workspaceRoot}`,
    `Snapshot: ${overview.source} @ ${overview.generatedAt}`,
  ];

  if (overview.git?.branch || overview.git?.head) {
    lines.push(`Git: branch=${overview.git.branch ?? 'unknown'} head=${overview.git.head?.slice(0, 12) ?? 'unknown'} dirty=${overview.git.hasUncommittedChanges ? 'yes' : 'no'}`);
  }

  lines.push(
    `Files: ${overview.fileStats.totalFiles} total | ${overview.fileStats.sourceFiles} source | ${overview.fileStats.docFiles} docs | ${overview.fileStats.testFiles} tests | ${overview.fileStats.configFiles} config`,
  );
  if (overview.truncated) {
    lines.push(`[Overview truncated after ${MAX_TRACKED_FILES} files. Refresh in a narrower workspace if you need higher fidelity.]`);
  }

  lines.push(...formatList('Key manifests', overview.manifests.slice(0, 6)));
  lines.push(...formatList('Key docs', overview.keyDocs.slice(0, 6)));
  lines.push(...formatList('Entry hints', overview.entryHints.slice(0, 6)));

  lines.push('Areas:');
  const areas = overview.areas.slice(0, MAX_OUTPUT_AREAS);
  for (const area of areas) {
    const manifestSuffix = area.manifests.length > 0 ? ` | manifests: ${area.manifests.join(', ')}` : '';
    const sampleSuffix = area.sampleFiles.length > 0 ? ` | sample: ${area.sampleFiles.join(', ')}` : '';
    lines.push(`- ${area.root} [${area.kind}] ${area.label}: ${area.fileCount} files${manifestSuffix}${sampleSuffix}`);
  }
  if (overview.areas.length > areas.length) {
    lines.push(`- ... ${overview.areas.length - areas.length} more areas`);
  }

  return lines.join('\n');
}

export async function buildRepoIntelligenceContext(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: {
    targetPath?: string;
    includeRepoOverview?: boolean;
    includeChangedScope?: boolean;
    refreshOverview?: boolean;
    changedScope?: 'unstaged' | 'staged' | 'all' | 'compare';
    baseRef?: string;
  } = {},
): Promise<string> {
  const sections: string[] = [];
  const includeRepoOverview = options.includeRepoOverview !== false;
  const includeChangedScope = options.includeChangedScope === true;

  if (includeRepoOverview) {
    const overview = await getRepoOverview(context, {
      targetPath: options.targetPath,
      refresh: options.refreshOverview,
    });
    sections.push(['## Repository Intelligence', renderRepoOverview(overview)].join('\n'));
  }

  if (includeChangedScope) {
    try {
      const report = await analyzeChangedScope(context, {
        targetPath: options.targetPath,
        scope: options.changedScope ?? 'all',
        baseRef: options.baseRef,
        refreshOverview: options.refreshOverview,
      });
      sections.push(['## Repository Change Scope', renderChangedScope(report)].join('\n'));
    } catch {
      // Non-git workspaces can still benefit from repo_overview without failing prompt construction.
    }
  }

  return sections.join('\n\n');
}

function resolveChangedStatus(rawStatus: string): ChangedFileStatus {
  if (rawStatus.includes('R')) {
    return 'renamed';
  }
  if (rawStatus.includes('D')) {
    return 'deleted';
  }
  if (rawStatus.includes('A')) {
    return 'added';
  }
  if (rawStatus === '??') {
    return 'untracked';
  }
  return 'modified';
}

function parsePorcelainLine(line: string): { status: string; path: string; staged: boolean; unstaged: boolean } | null {
  if (!line.trim()) {
    return null;
  }

  const status = line.slice(0, 2);
  const payload = line.slice(3).trim();
  const normalizedPath = normalizeRelativePath(payload.includes(' -> ') ? payload.split(' -> ').pop() ?? payload : payload);
  const staged = status[0] !== ' ' && status[0] !== '?';
  const unstaged = status[1] !== ' ' && status[1] !== '?';

  return {
    status,
    path: normalizedPath,
    staged,
    unstaged: unstaged || status === '??',
  };
}

function includesCandidate(
  candidate: ReturnType<typeof parsePorcelainLine>,
  scope: 'unstaged' | 'staged' | 'all',
): boolean {
  if (!candidate) {
    return false;
  }
  if (scope === 'staged') {
    return candidate.staged;
  }
  if (scope === 'unstaged') {
    return candidate.unstaged;
  }
  return candidate.staged || candidate.unstaged;
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

function buildRiskHints(
  changedFiles: ChangedFileEntry[],
  areasTouched: ChangedScopeAreaSummary[],
): string[] {
  const hints: string[] = [];
  if (areasTouched.length > 1) {
    hints.push(`Cross-area change touches ${areasTouched.length} areas.`);
  }
  const configTouched = changedFiles.filter((file) => file.category === 'config').map((file) => file.path);
  if (configTouched.length > 0) {
    hints.push(`Config or manifest changes detected: ${configTouched.slice(0, 4).join(' | ')}.`);
  }
  const docOnly = changedFiles.length > 0 && changedFiles.every((file) => file.category === 'docs' || file.category === 'tests');
  if (docOnly) {
    hints.push('Changes are currently limited to docs/tests; implementation files are untouched.');
  }
  if (changedFiles.some((file) => file.areaId === '.')) {
    hints.push('Workspace-root files changed; validate repo-wide implications.');
  }
  return hints;
}

async function collectChangedFiles(
  workspaceRoot: string,
  scope: 'unstaged' | 'staged' | 'all' | 'compare',
  baseRef?: string,
): Promise<ChangedFileCandidate[]> {
  if (scope === 'compare') {
    const compareBase = baseRef?.trim() || 'HEAD~1';
    if (!compareBase || compareBase.startsWith('-') || /[\u0000-\u001f\s]/.test(compareBase)) {
      throw new Error(`Invalid base ref "${compareBase}".`);
    }
    try {
      await runGit(['rev-parse', '--verify', '--quiet', `${compareBase}^{commit}`], workspaceRoot);
    } catch (error) {
      debugLogRepoIntelligence(`Rejected compare base ref "${compareBase}".`, error);
      throw new Error(`Could not resolve base ref "${compareBase}".`);
    }
    const output = await runGit(['diff', '--name-status', `${compareBase}...HEAD`], workspaceRoot);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [statusToken, ...rest] = line.split(/\s+/);
        const candidatePath = rest.join(' ').split(' -> ').pop() ?? rest.join(' ');
        return {
          path: normalizeRelativePath(candidatePath),
          status: resolveChangedStatus(statusToken ?? 'M'),
        };
      })
      .filter((candidate) => !isManagedMetadataPath(candidate.path));
  }

  const output = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], workspaceRoot);
  const candidates = output
    .split(/\r?\n/)
    .map(parsePorcelainLine)
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .filter((candidate) => includesCandidate(candidate, scope));

  const deduped = new Map<string, ChangedFileCandidate>();
  for (const candidate of candidates) {
    if (isManagedMetadataPath(candidate.path)) {
      continue;
    }
    deduped.set(candidate.path, {
      path: candidate.path,
      status: resolveChangedStatus(candidate.status),
    });
  }

  return Array.from(deduped.values());
}

async function collectChangedLineStats(
  workspaceRoot: string,
  scope: 'unstaged' | 'staged' | 'all' | 'compare',
  baseRef?: string,
): Promise<ChangedLineStats> {
  let output = '';
  if (scope === 'compare') {
    const compareBase = baseRef?.trim() || 'HEAD~1';
    output = await runGit(['diff', '--numstat', `${compareBase}...HEAD`], workspaceRoot);
  } else if (scope === 'staged') {
    output = await runGit(['diff', '--cached', '--numstat'], workspaceRoot);
  } else if (scope === 'unstaged') {
    output = await runGit(['diff', '--numstat'], workspaceRoot);
  } else {
    output = await runGit(['diff', '--numstat', 'HEAD'], workspaceRoot);
  }

  let addedLineCount = 0;
  let deletedLineCount = 0;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const [, addedRaw, deletedRaw, filePathRaw] = match;
    const normalizedPath = normalizeRelativePath(filePathRaw.split(' -> ').pop() ?? filePathRaw);
    if (isManagedMetadataPath(normalizedPath)) {
      continue;
    }
    const added = addedRaw === '-' ? 0 : Number.parseInt(addedRaw, 10);
    const deleted = deletedRaw === '-' ? 0 : Number.parseInt(deletedRaw, 10);
    if (Number.isFinite(added)) {
      addedLineCount += added;
    }
    if (Number.isFinite(deleted)) {
      deletedLineCount += deleted;
    }
  }

  return {
    changedLineCount: addedLineCount + deletedLineCount,
    addedLineCount,
    deletedLineCount,
  };
}

export async function analyzeChangedScope(
  context: Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>,
  options: {
    targetPath?: string;
    scope?: 'unstaged' | 'staged' | 'all' | 'compare';
    baseRef?: string;
    refreshOverview?: boolean;
  } = {},
): Promise<ChangedScopeReport> {
  const scope = options.scope ?? 'all';
  const overview = await getRepoOverview(context, {
    targetPath: options.targetPath,
    refresh: options.refreshOverview,
  });

  if (overview.source !== 'git') {
    throw new Error('changed_scope requires a git-backed workspace.');
  }

  const changedCandidates = await collectChangedFiles(overview.workspaceRoot, scope, options.baseRef);
  const changedLineStats = await collectChangedLineStats(overview.workspaceRoot, scope, options.baseRef)
    .catch((error) => {
      debugLogRepoIntelligence('Changed scope could not load line stats.', error);
      return {
        changedLineCount: 0,
        addedLineCount: 0,
        deletedLineCount: 0,
      } satisfies ChangedLineStats;
    });
  const changedFiles: ChangedFileEntry[] = changedCandidates.map((candidate) => {
    const area = findAreaForFile(candidate.path, overview.areas);
    return {
      path: candidate.path,
      status: candidate.status,
      category: classifyFileCategory(candidate.path),
      areaId: area.id,
    };
  });

  const areasTouchedMap = new Map<string, ChangedScopeAreaSummary>();
  for (const file of changedFiles) {
    const area = findAreaForFile(file.path, overview.areas);
    const current = areasTouchedMap.get(area.id) ?? {
      areaId: area.id,
      label: area.label,
      root: area.root,
      kind: area.kind,
      fileCount: 0,
      files: [],
    };
    areasTouchedMap.set(area.id, {
      ...current,
      fileCount: current.fileCount + 1,
      files: current.files.length < MAX_SAMPLE_FILES
        ? [...current.files, file.path]
        : current.files,
    });
  }

  const categories: ChangedScopeReport['categories'] = {
    source: 0,
    docs: 0,
    tests: 0,
    config: 0,
    other: 0,
  };
  for (const file of changedFiles) {
    categories[file.category] += 1;
  }

  const report: ChangedScopeReport = {
    schemaVersion: SCHEMA_VERSION,
    workspaceRoot: overview.workspaceRoot,
    analyzedAt: new Date().toISOString(),
    scope,
    baseRef: scope === 'compare' ? (options.baseRef?.trim() || 'HEAD~1') : undefined,
    overviewGeneratedAt: overview.generatedAt,
    totalChangedFiles: changedFiles.length,
    changedLineCount: changedLineStats.changedLineCount,
    addedLineCount: changedLineStats.addedLineCount,
    deletedLineCount: changedLineStats.deletedLineCount,
    categories,
    areasTouched: Array.from(areasTouchedMap.values()).sort((left, right) => {
      if (right.fileCount !== left.fileCount) {
        return right.fileCount - left.fileCount;
      }
      return left.root.localeCompare(right.root);
    }),
    files: changedFiles,
    riskHints: buildRiskHints(changedFiles, Array.from(areasTouchedMap.values())),
  };

  const storageRoot = await ensureStorageDir(overview.workspaceRoot);
  await fs.writeFile(path.join(storageRoot, CHANGED_SCOPE_FILE), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function renderChangedScope(report: ChangedScopeReport): string {
  const lines: string[] = [
    `Changed scope for ${path.basename(report.workspaceRoot)}`,
    `Root: ${report.workspaceRoot}`,
    `Scope: ${report.scope}${report.baseRef ? ` vs ${report.baseRef}` : ''}`,
    `Snapshot: ${report.analyzedAt}`,
    `Changed files: ${report.totalChangedFiles}`,
    `Changed lines: ${report.changedLineCount} (+${report.addedLineCount} / -${report.deletedLineCount})`,
    `Categories: source=${report.categories.source} docs=${report.categories.docs} tests=${report.categories.tests} config=${report.categories.config} other=${report.categories.other}`,
  ];

  if (report.overviewGeneratedAt) {
    lines.push(`Repository overview snapshot: ${report.overviewGeneratedAt}`);
  }

  lines.push('Areas touched:');
  if (report.areasTouched.length === 0) {
    lines.push('- none');
  } else {
    for (const area of report.areasTouched.slice(0, MAX_OUTPUT_AREAS)) {
      const sampleSuffix = area.files.length > 0 ? ` | sample: ${area.files.join(', ')}` : '';
      lines.push(`- ${area.root} [${area.kind}] ${area.label}: ${area.fileCount} changed file(s)${sampleSuffix}`);
    }
    if (report.areasTouched.length > MAX_OUTPUT_AREAS) {
      lines.push(`- ... ${report.areasTouched.length - MAX_OUTPUT_AREAS} more areas`);
    }
  }

  if (report.riskHints.length > 0) {
    lines.push('Risk hints:');
    for (const hint of report.riskHints) {
      lines.push(`- ${hint}`);
    }
  }

  lines.push('Changed files:');
  for (const file of report.files.slice(0, MAX_OUTPUT_FILES)) {
    lines.push(`- ${file.status} ${file.path} [${file.category}] -> ${file.areaId}`);
  }
  if (report.files.length > MAX_OUTPUT_FILES) {
    lines.push(`- ... ${report.files.length - MAX_OUTPUT_FILES} more file(s)`);
  }

  return lines.join('\n');
}
