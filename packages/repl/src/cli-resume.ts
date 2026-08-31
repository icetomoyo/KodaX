import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureLayoutMigrated } from './interactive/session-migration.js';
import {
  deriveProjectKeyFromRoot,
  sessionProjectMatchesAnyRoot,
} from './interactive/project-key.js';
import {
  projectManifestExists,
  publishProjectManifest,
} from './interactive/project-manifest.js';
import {
  discoverLinkedWorkspaceRoots,
  resolveWorkspaceProjectIdentity,
} from './interactive/workspace-runtime.js';
import {
  completeResumeIndex,
  readResumeIndex,
  type ResumeIndexEntry,
  type ResumeIndexScanEntry,
  type ResumeIndexScannedFile,
} from './session/resume-index.js';
import {
  runSessionPicker,
  type SessionPickerItem,
  type SessionPickerRunOptions,
} from './ui/SessionPicker.js';
import { countResumableSessionItems } from './session/resumable-session.js';

const SESSION_HEAD_READ_BYTES = 65536;
const SESSION_READ_CONCURRENCY = 48;

interface PersistedRuntimeSummary {
  readonly canonicalRepoRoot?: string;
  readonly workspaceRoot?: string;
  readonly surface?: string;
}

interface ResumeCandidate extends ResumeIndexEntry {
  readonly createdAtMs?: number;
  readonly sourceSize?: number;
  readonly sourceMtimeMs?: number;
  readonly sourceCtimeMs?: number;
  readonly sourceDev?: number;
  readonly sourceIno?: number;
}

interface ResumeFileCandidate {
  readonly filePath: string;
  readonly trustedProjectDir: boolean;
}

interface ResumeFileScan {
  readonly candidate?: ResumeCandidate;
  readonly source?: ResumeIndexScannedFile;
  readonly matchesProject?: boolean;
}

export interface ListCliResumeSessionsOptions {
  readonly projectRoot: string;
  readonly sessionsDir?: string;
  readonly limit?: number;
}

function defaultSessionsDir(): string {
  const envHome = process.env.KODAX_HOME;
  const configHome = envHome && envHome.length > 0
    ? envHome
    : path.join(os.homedir(), '.kodax');
  return path.join(configHome, 'sessions');
}

function isSessionFile(name: string): boolean {
  return name.endsWith('.jsonl')
    && !name.endsWith('.archive.jsonl')
    && !name.endsWith('.islands.jsonl')
    && !name.startsWith('archived-')
    && !name.startsWith('.');
}

async function readProjectSessionFiles(projectDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(projectDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isSessionFile(entry.name))
      .map((entry) => path.join(projectDir, entry.name));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readOptionalProjectSessionFiles(projectDir: string): Promise<string[]> {
  try {
    return await readProjectSessionFiles(projectDir);
  } catch (error: unknown) {
    reportResumeCompatibilityFailure(`read ${projectDir}`, error);
    return [];
  }
}

async function collectActiveSessionFiles(
  sessionsDir: string,
  projectDir: string,
  useResumeIndex: boolean,
  trustedProjectDir: boolean,
  compatibilityProjectDirs: readonly string[],
): Promise<ResumeFileCandidate[]> {
  const projectFiles = useResumeIndex ? [] : await readProjectSessionFiles(projectDir);
  const compatibilityFiles = (await Promise.all(
    compatibilityProjectDirs.map((directory) => readOptionalProjectSessionFiles(directory)),
  )).flat();
  const legacyFiles = (await fs.readdir(sessionsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile()
      && isSessionFile(entry.name))
    .map((entry) => path.join(sessionsDir, entry.name));
  return [
    ...projectFiles.map((filePath) => ({ filePath, trustedProjectDir })),
    ...compatibilityFiles.map((filePath) => ({ filePath, trustedProjectDir: false })),
    ...legacyFiles.map((filePath) => ({ filePath, trustedProjectDir: false })),
  ];
}

async function isTrustedProjectDir(projectDir: string, canonicalProjectRoot: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(path.join(projectDir, 'project.json'), 'utf8'),
    );
    if (parsed === null || typeof parsed !== 'object') return false;
    const canonicalRoot = (parsed as Record<string, unknown>).canonicalRoot;
    return typeof canonicalRoot === 'string'
      && normalizeComparableRoot(canonicalRoot) === normalizeComparableRoot(canonicalProjectRoot);
  } catch {
    return false;
  }
}

function indexedCandidate(entry: ResumeIndexEntry): ResumeCandidate {
  return {
    ...entry,
    ...(entry.createdAt !== undefined ? { createdAtMs: Date.parse(entry.createdAt) } : {}),
  };
}

function reportResumeIndexFailure(action: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.emitWarning(`Resume index ${action} failed; using canonical sessions instead: ${reason}`, {
    code: 'KODAX_RESUME_INDEX',
  });
}

function reportResumeCompatibilityFailure(action: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.emitWarning(`Resume compatibility ${action} failed; continuing with the current project: ${reason}`, {
    code: 'KODAX_RESUME_COMPATIBILITY',
  });
}

function normalizeComparableRoot(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}

function matchesProjectRoot(meta: Record<string, unknown>, projectRoots: readonly string[]): boolean {
  if (projectRoots.length === 0) return true;
  const runtime = meta.runtimeInfo !== null && typeof meta.runtimeInfo === 'object'
    ? meta.runtimeInfo as Record<string, unknown>
    : undefined;
  return sessionProjectMatchesAnyRoot({
    ...(typeof meta.gitRoot === 'string' ? { gitRoot: meta.gitRoot } : {}),
    ...(runtime === undefined ? {} : {
      runtimeInfo: {
        ...(typeof runtime.canonicalRepoRoot === 'string'
          ? { canonicalRepoRoot: runtime.canonicalRepoRoot }
          : {}),
        ...(typeof runtime.workspaceRoot === 'string' ? { workspaceRoot: runtime.workspaceRoot } : {}),
        ...(typeof runtime.executionCwd === 'string' ? { executionCwd: runtime.executionCwd } : {}),
      },
    }),
  }, projectRoots);
}

interface SessionEnvelope {
  readonly line: string;
  readonly tailLine: string;
  readonly sourceSize: number;
  readonly sourceMtimeMs: number;
  readonly sourceCtimeMs: number;
  readonly sourceDev: number;
  readonly sourceIno: number;
}

function sameSource(
  left: Pick<SessionEnvelope, 'sourceSize' | 'sourceMtimeMs' | 'sourceCtimeMs' | 'sourceDev' | 'sourceIno'>,
  right: Awaited<ReturnType<fs.FileHandle['stat']>>,
): boolean {
  return left.sourceSize === right.size
    && left.sourceMtimeMs === right.mtimeMs
    && left.sourceCtimeMs === right.ctimeMs
    && left.sourceDev === right.dev
    && left.sourceIno === right.ino;
}

async function readLastNonEmptyLine(handle: fs.FileHandle, size: number): Promise<string> {
  const chunks: Buffer[] = [];
  let position = size;
  let foundContent = false;
  while (position > 0) {
    const start = Math.max(0, position - SESSION_HEAD_READ_BYTES);
    const buffer = Buffer.allocUnsafe(position - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (bytesRead === 0) break;
    let end = bytesRead;
    if (!foundContent) {
      while (end > 0 && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) end -= 1;
      if (end === 0) {
        position = start;
        continue;
      }
      foundContent = true;
    }
    const newline = buffer.lastIndexOf(0x0a, end - 1);
    chunks.unshift(buffer.subarray(newline + 1, end));
    if (newline >= 0) break;
    position = start;
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function readSessionEnvelope(filePath: string): Promise<SessionEnvelope | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const before = await handle.stat();
    const chunks: Buffer[] = [];
    let lineBytes = 0;
    let position = 0;
    let firstLineEnd = before.size;
    while (true) {
      const remaining = before.size - position;
      if (remaining <= 0) break;
      const buffer = Buffer.allocUnsafe(Math.min(SESSION_HEAD_READ_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      const lineChunk = newline >= 0 ? chunk.subarray(0, newline) : chunk;
      chunks.push(lineChunk);
      lineBytes += lineChunk.length;
      if (newline >= 0) {
        firstLineEnd = position + newline;
        break;
      }
      position += bytesRead;
    }
    if (lineBytes === 0) return undefined;
    const line = Buffer.concat(chunks, lineBytes).toString('utf8').trim();
    const tailLine = before.size <= firstLineEnd + 1
      ? line
      : await readLastNonEmptyLine(handle, before.size);
    const source = {
      sourceSize: before.size,
      sourceMtimeMs: before.mtimeMs,
      sourceCtimeMs: before.ctimeMs,
      sourceDev: before.dev,
      sourceIno: before.ino,
    };
    const after = await handle.stat();
    return sameSource(source, after) ? { line, tailLine, ...source } : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function applyMetaUpdate(
  meta: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  if (update._type !== 'meta_update') return meta;
  return {
    ...meta,
    ...(typeof update.title === 'string' ? { title: update.title } : {}),
    ...(typeof update.activeMessageCount === 'number' && update.activeMessageCount >= 0
      ? { activeMessageCount: update.activeMessageCount }
      : {}),
    ...(Array.isArray(update.uiHistory) ? { uiHistory: update.uiHistory } : {}),
    ...(typeof update.scope === 'string' ? { scope: update.scope } : {}),
  };
}

function parseJsonRecord(line: string): { readonly valid: boolean; readonly value?: Record<string, unknown> } {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object'
      ? { valid: true, value: parsed as Record<string, unknown> }
      : { valid: true };
  } catch {
    return { valid: false };
  }
}

async function applyEffectiveTailMetadata(
  filePath: string,
  meta: Record<string, unknown>,
  tailLine: string,
): Promise<Record<string, unknown>> {
  const tail = parseJsonRecord(tailLine);
  if (tail.valid) return tail.value === undefined ? meta : applyMetaUpdate(meta, tail.value);

  // A process may crash after a complete meta_update but before finishing the
  // next JSONL record. Only that rare recovery path reads the full file.
  const lines = (await fs.readFile(filePath, 'utf8')).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    const parsed = parseJsonRecord(line);
    if (parsed.valid && parsed.value?._type === 'meta_update') {
      return applyMetaUpdate(meta, parsed.value);
    }
  }
  return meta;
}

async function readMessageCount(filePath: string, meta: Record<string, unknown>): Promise<number> {
  if (typeof meta.activeMessageCount === 'number' && meta.activeMessageCount >= 0) {
    return countResumableSessionItems(meta.activeMessageCount, meta.uiHistory);
  }
  const content = (await fs.readFile(filePath, 'utf8')).trim();
  if (!content) return 0;
  const extensionRecords = typeof meta.extensionRecordCount === 'number' && meta.extensionRecordCount > 0
    ? meta.extensionRecordCount
    : 0;
  return countResumableSessionItems(
    Math.max(0, content.split('\n').length - 1 - extensionRecords),
    meta.uiHistory,
  );
}

function runtimeSummary(meta: Record<string, unknown>): PersistedRuntimeSummary | undefined {
  if (meta.runtimeInfo === null || typeof meta.runtimeInfo !== 'object') return undefined;
  const runtime = meta.runtimeInfo as Record<string, unknown>;
  return {
    ...(typeof runtime.canonicalRepoRoot === 'string' ? { canonicalRepoRoot: runtime.canonicalRepoRoot } : {}),
    ...(typeof runtime.workspaceRoot === 'string' ? { workspaceRoot: runtime.workspaceRoot } : {}),
    ...(typeof runtime.surface === 'string' ? { surface: runtime.surface } : {}),
  };
}

async function readResumeCandidate(
  filePath: string,
  projectRoots: readonly string[],
  trustedProjectDir: boolean,
): Promise<ResumeFileScan> {
  const head = await readSessionEnvelope(filePath);
  if (!head?.line) return {};
  const source: ResumeIndexScannedFile = {
    name: path.basename(filePath),
    sourceSize: head.sourceSize,
    sourceMtimeMs: head.sourceMtimeMs,
    sourceCtimeMs: head.sourceCtimeMs,
    sourceDev: head.sourceDev,
    sourceIno: head.sourceIno,
  };
  try {
    const parsed: unknown = JSON.parse(head.line);
    if (parsed === null || typeof parsed !== 'object') return { source };
    const meta = await applyEffectiveTailMetadata(
      filePath,
      parsed as Record<string, unknown>,
      head.tailLine,
    );
    if (meta._type !== 'meta') return { source, matchesProject: false };
    const matchesProject = trustedProjectDir || matchesProjectRoot(meta, projectRoots);
    if (!matchesProject || meta.scope === 'managed-task-worker') return { source, matchesProject };
    const msgCount = await readMessageCount(filePath, meta);
    if (msgCount <= 0) return { source, matchesProject };
    const createdAt = typeof meta.createdAt === 'string' ? meta.createdAt : undefined;
    const runtime = runtimeSummary(meta);
    return {
      source,
      matchesProject,
      candidate: {
        id: path.basename(filePath, '.jsonl'),
        title: typeof meta.title === 'string' ? meta.title : '',
        msgCount,
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(runtime?.surface !== undefined ? { surface: runtime.surface } : {}),
        ...(createdAt !== undefined ? { createdAtMs: Date.parse(createdAt) } : {}),
        sourceSize: head.sourceSize,
        sourceMtimeMs: head.sourceMtimeMs,
        sourceCtimeMs: head.sourceCtimeMs,
        sourceDev: head.sourceDev,
        sourceIno: head.sourceIno,
      },
    };
  } catch {
    return { source };
  }
}

export async function listCliResumeSessions(
  options: ListCliResumeSessionsOptions,
): Promise<SessionPickerItem[]> {
  const sessionsDir = options.sessionsDir ?? defaultSessionsDir();
  await ensureLayoutMigrated(sessionsDir);
  await fs.mkdir(sessionsDir, { recursive: true });
  const projectIdentity = await resolveWorkspaceProjectIdentity({ cwd: options.projectRoot });
  const canonicalProjectRoot = projectIdentity.canonicalRoot;
  const projectDir = path.join(
    sessionsDir,
    deriveProjectKeyFromRoot(canonicalProjectRoot).key,
  );
  let linkedWorkspaceRoots: readonly string[] = [];
  try {
    linkedWorkspaceRoots = discoverLinkedWorkspaceRoots(canonicalProjectRoot);
  } catch (error: unknown) {
    reportResumeCompatibilityFailure('linked-worktree discovery', error);
  }
  const compatibleRoots = [
    projectIdentity.workspaceRoot,
    ...linkedWorkspaceRoots,
  ].filter((root, index, roots) => {
    const normalized = normalizeComparableRoot(root);
    return normalized !== normalizeComparableRoot(canonicalProjectRoot)
      && roots.findIndex((candidate) => normalizeComparableRoot(candidate) === normalized) === index;
  });
  const compatibilityProjectDirs = compatibleRoots.map((root) =>
    path.join(sessionsDir, deriveProjectKeyFromRoot(root).key));
  const trustedProjectDir = await isTrustedProjectDir(projectDir, canonicalProjectRoot);
  let projectManifestMissing = false;
  if (!trustedProjectDir) {
    try {
      projectManifestMissing = !await projectManifestExists(projectDir);
    } catch {
      // Invalid or unreadable identity remains untrusted and is never replaced.
    }
  }
  let indexedEntries: readonly ResumeIndexEntry[] | undefined;
  if (trustedProjectDir) {
    try {
      indexedEntries = await readResumeIndex(projectDir);
    } catch (error: unknown) {
      reportResumeIndexFailure('read', error);
    }
  }
  const filePaths = await collectActiveSessionFiles(
    sessionsDir,
    projectDir,
    indexedEntries !== undefined,
    trustedProjectDir && indexedEntries !== undefined,
    compatibilityProjectDirs,
  );
  const candidates = indexedEntries?.map(indexedCandidate) ?? [];
  const scannedProjectCandidates: ResumeIndexScanEntry[] = [];
  const scannedProjectFiles: ResumeIndexScannedFile[] = [];
  let primaryProjectFilesMatch = true;
  const seenIds = new Set(candidates.map((candidate) => candidate.id));
  for (let index = 0; index < filePaths.length; index += SESSION_READ_CONCURRENCY) {
    const batchFiles = filePaths.slice(index, index + SESSION_READ_CONCURRENCY);
    const batch = await Promise.all(batchFiles.map((candidate) => readResumeCandidate(
      candidate.filePath,
      [canonicalProjectRoot, ...compatibleRoots],
      candidate.trustedProjectDir,
    )));
    for (let offset = 0; offset < batch.length; offset += 1) {
      const scan = batch[offset];
      const batchFile = batchFiles[offset];
      const isPrimaryProjectFile = batchFile !== undefined
        && normalizeComparableRoot(path.dirname(batchFile.filePath))
          === normalizeComparableRoot(projectDir);
      if (isPrimaryProjectFile) {
        if (scan?.source) scannedProjectFiles.push(scan.source);
        if (scan?.source === undefined || scan.matchesProject !== true) primaryProjectFilesMatch = false;
      }
      const candidate = scan?.candidate;
      if (
        indexedEntries === undefined
        && isPrimaryProjectFile
        && candidate?.sourceSize !== undefined
        && candidate.sourceMtimeMs !== undefined
        && candidate.sourceCtimeMs !== undefined
        && candidate.sourceDev !== undefined
        && candidate.sourceIno !== undefined
      ) {
        scannedProjectCandidates.push({
          ...candidate,
          sourceSize: candidate.sourceSize,
          sourceMtimeMs: candidate.sourceMtimeMs,
          sourceCtimeMs: candidate.sourceCtimeMs,
          sourceDev: candidate.sourceDev,
          sourceIno: candidate.sourceIno,
        });
      }
      if (candidate && !seenIds.has(candidate.id)) {
        seenIds.add(candidate.id);
        candidates.push(candidate);
      }
    }
  }
  if (projectManifestMissing && primaryProjectFilesMatch) {
    let archivedFiles: readonly string[] = [];
    try {
      archivedFiles = await readProjectSessionFiles(path.join(projectDir, 'archived'));
    } catch (error: unknown) {
      primaryProjectFilesMatch = false;
      reportResumeCompatibilityFailure('legacy archived-session certification', error);
    }
    for (let index = 0; index < archivedFiles.length; index += SESSION_READ_CONCURRENCY) {
      const batch = await Promise.all(archivedFiles
        .slice(index, index + SESSION_READ_CONCURRENCY)
        .map((filePath) => readResumeCandidate(
          filePath,
          [canonicalProjectRoot, ...compatibleRoots],
          false,
        )));
      if (batch.some((scan) => scan.source === undefined || scan.matchesProject !== true)) {
        primaryProjectFilesMatch = false;
        break;
      }
    }
  }
  let indexProjectDirTrusted = trustedProjectDir;
  if (projectManifestMissing && primaryProjectFilesMatch) {
    try {
      await publishProjectManifest(projectDir, deriveProjectKeyFromRoot(canonicalProjectRoot));
      indexProjectDirTrusted = true;
    } catch (error: unknown) {
      reportResumeIndexFailure('project identity publication', error);
    }
  }
  if (indexedEntries === undefined && indexProjectDirTrusted) {
    try {
      await completeResumeIndex(
        projectDir,
        scannedProjectCandidates,
        scannedProjectFiles,
      );
    } catch (error: unknown) {
      reportResumeIndexFailure('rebuild', error);
    }
  }
  candidates.sort((left, right) => {
    if (Number.isFinite(left.createdAtMs) && Number.isFinite(right.createdAtMs)
        && left.createdAtMs !== right.createdAtMs) {
      return (right.createdAtMs as number) - (left.createdAtMs as number);
    }
    if (Number.isFinite(right.createdAtMs) && !Number.isFinite(left.createdAtMs)) return 1;
    if (Number.isFinite(left.createdAtMs) && !Number.isFinite(right.createdAtMs)) return -1;
    return right.id.localeCompare(left.id);
  });
  return candidates.slice(0, options.limit ?? 1000).map(({
    createdAtMs: _createdAtMs,
    sourceSize: _sourceSize,
    sourceMtimeMs: _sourceMtimeMs,
    sourceCtimeMs: _sourceCtimeMs,
    sourceDev: _sourceDev,
    sourceIno: _sourceIno,
    ...item
  }) => item);
}

export async function runCliResumePicker(
  sessions: readonly SessionPickerItem[],
  options: SessionPickerRunOptions = {},
): Promise<SessionPickerItem | undefined> {
  return runSessionPicker(sessions, options);
}

export type {
  SessionPickerItem,
  SessionPickerRunOptions,
} from './ui/SessionPicker.js';
