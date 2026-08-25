import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  KodaXTextFileMutationRequest,
  KodaXTextFileMutationSandbox,
  KodaXTextFileSnapshot,
  KodaXToolExecutionContext,
} from '../../types.js';
import {
  recordResolvedFileBackup,
  resolveFileBackupPath,
  normalizePathForKey,
  withFileMutation,
  withPathMutation,
  withSandboxedFileMutation,
} from './file-mutation-queue.js';

export interface TextFileMutationSnapshot extends KodaXTextFileSnapshot {
  readonly execution: 'host' | 'sandbox';
  readonly request: KodaXTextFileMutationRequest;
}

function revision(content: string, device: bigint, inode: bigint, linkCount: bigint): string {
  return `present:${createHash('sha256')
    .update(device.toString())
    .update(':')
    .update(inode.toString())
    .update(':')
    .update(linkCount.toString())
    .update('\0')
    .update(content)
    .digest('hex')}`;
}

function assertSingleLink(filePath: string, linkCount: bigint): void {
  if (linkCount > 1n) {
    throw new Error(`Runtime host mutation target is a hard link: ${filePath}`);
  }
}

async function readHostSnapshot(filePath: string): Promise<KodaXTextFileSnapshot> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        state: 'missing',
        content: '',
        revision: 'missing',
        backupPath: path.resolve(filePath),
      };
    }
    throw error;
  }
  try {
    const [content, stat] = await Promise.all([
      handle.readFile('utf8'),
      handle.stat({ bigint: true }),
    ]);
    assertSingleLink(filePath, stat.nlink);
    return {
      state: 'present',
      content,
      revision: revision(content, stat.dev, stat.ino, stat.nlink),
      backupPath: await fs.realpath(filePath),
    };
  } finally {
    await handle?.close();
  }
}

/**
 * A Runtime path outside the workspace has no ASRT sink. Keep its established
 * host behavior only when no existing path component is a symlink/junction.
 * Component metadata avoids mistaking case or short-name spelling changes for
 * aliases. This check runs after the direct lease is held.
 */
async function assertUnaliasedHostMutationPath(filePath: string): Promise<void> {
  const target = path.resolve(filePath);
  const root = path.parse(target).root;
  let candidate = root;
  for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
    candidate = path.join(candidate, component);
    try {
      const stats = await fs.lstat(candidate);
      if (stats.isSymbolicLink()) {
        throw new Error(`Runtime host mutation target is redirected through a link: ${filePath}`);
      }
      if (candidate === target) {
        if (stats.isFile() && stats.nlink > 1) {
          throw new Error(`Runtime host mutation target is a hard link: ${filePath}`);
        }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

interface MutationBackup {
  preserveExisting(): void;
  recordLatest(): void;
}

function createMutationBackup(
  backups: Map<string, string>,
  backupPath: string,
  content: string,
): MutationBackup {
  return {
    preserveExisting() {
      if (!backups.has(backupPath)) {
        recordResolvedFileBackup(backups, backupPath, content);
      }
    },
    recordLatest() {
      recordResolvedFileBackup(backups, backupPath, content);
    },
  };
}

async function writeFileHandleFully(handle: fs.FileHandle, content: string): Promise<void> {
  const encoded = Buffer.from(content, 'utf8');
  let written = 0;
  while (written < encoded.length) {
    const result = await handle.write(encoded, written, encoded.length - written, written);
    if (result.bytesWritten === 0) throw new Error('Text file mutation write made no progress.');
    written += result.bytesWritten;
  }
  await handle.truncate(encoded.length);
}

function textFileMutationRequest(
  filePath: string,
  toolName: KodaXTextFileMutationRequest['toolName'],
  toolInput: Readonly<Record<string, unknown>>,
  ctx: KodaXToolExecutionContext,
): KodaXTextFileMutationRequest {
  return {
    toolCallId: ctx.toolCallId,
    toolName,
    toolInput,
    path: filePath,
    signal: ctx.abortSignal,
  };
}

/**
 * Keep the path queue around the complete read/transform/write transaction.
 * A real workspace sandbox capability bypasses the global direct lease for
 * paths it covers. Uncovered paths and standalone execution retain the legacy
 * host shell/namespace fence; covered-path sandbox failure is fail-closed.
 */
export function withTextFileMutation<T>(
  filePath: string,
  toolName: KodaXTextFileMutationRequest['toolName'],
  toolInput: Readonly<Record<string, unknown>>,
  ctx: KodaXToolExecutionContext,
  operation: (snapshot: TextFileMutationSnapshot) => Promise<T>,
): Promise<T> {
  const request = textFileMutationRequest(filePath, toolName, toolInput, ctx);
  const sandbox = ctx.textFileMutationSandbox;
  const uncoveredRuntimePath = sandbox?.canHandlePath?.(filePath) === false;
  if (sandbox === undefined || uncoveredRuntimePath) {
    return withFileMutation(filePath, async () => {
      if (uncoveredRuntimePath) await assertUnaliasedHostMutationPath(filePath);
      return operation({
        ...await readHostSnapshot(filePath),
        execution: 'host',
        request,
      });
    });
  }
  return withSandboxedFileMutation(filePath, async () => {
    const initial = await readSandboxedSnapshot(sandbox, request);
    const run = (snapshot: KodaXTextFileSnapshot) => operation({
      ...snapshot,
      execution: 'sandbox' as const,
      request,
    });
    if (normalizePathForKey(filePath) === normalizePathForKey(initial.backupPath)) {
      return run(initial);
    }
    return withPathMutation(initial.backupPath, async () => {
      const refreshed = await readSandboxedSnapshot(sandbox, request);
      if (normalizePathForKey(refreshed.backupPath) !== normalizePathForKey(initial.backupPath)) {
        throw new Error(`File identity changed during mutation: ${filePath}. Re-read and retry.`);
      }
      return run(refreshed);
    });
  });
}

async function readSandboxedSnapshot(
  sandbox: KodaXTextFileMutationSandbox,
  request: KodaXTextFileMutationRequest,
): Promise<KodaXTextFileSnapshot> {
  const result = await sandbox.read(request);
  if (result.status === 'ok') return result.snapshot;
  const suffix = result.reason === undefined ? '' : ` (${result.reason})`;
  throw new Error(`The Runtime sandboxed file mutation is unavailable.${suffix}`);
}

function mutationBackup(
  snapshot: TextFileMutationSnapshot,
  ctx: KodaXToolExecutionContext,
  backupContent?: string,
): MutationBackup | undefined {
  if (backupContent === undefined) return undefined;
  return createMutationBackup(
    ctx.backups,
    snapshot.execution === 'sandbox'
      ? snapshot.backupPath
      : resolveFileBackupPath(snapshot.request.path),
    backupContent,
  );
}

async function writeSandboxedTextFile(
  snapshot: TextFileMutationSnapshot,
  content: string,
  createParentDirectories: boolean,
  sandbox: KodaXTextFileMutationSandbox | undefined,
  backup: MutationBackup | undefined,
): Promise<void> {
  let result: Awaited<ReturnType<KodaXTextFileMutationSandbox['write']>> | undefined;
  try {
    result = await sandbox?.write({
      ...snapshot.request,
      content,
      createParentDirectories,
      expectedRevision: snapshot.revision,
    });
  } catch (error: unknown) {
    backup?.preserveExisting();
    throw error;
  }
  if (result?.status === 'written') {
    backup?.recordLatest();
    return;
  }
  if (result?.status === 'conflict') {
    throw new Error(`File changed during mutation: ${snapshot.request.path}. Re-read and retry.`);
  }
  const suffix = result?.reason === undefined ? '' : ` (${result.reason})`;
  throw new Error(`The sandboxed file mutation became unavailable before commit.${suffix}`);
}

async function writeHostTextFile(
  snapshot: TextFileMutationSnapshot,
  content: string,
  createParentDirectories: boolean,
  backup: MutationBackup | undefined,
): Promise<void> {
  if (createParentDirectories) {
    await fs.mkdir(path.dirname(snapshot.request.path), { recursive: true });
  }
  let handle: fs.FileHandle | undefined;
  let commitStarted = false;
  try {
    if (snapshot.state === 'missing') handle = await fs.open(snapshot.request.path, 'wx');
    else {
      handle = await fs.open(snapshot.request.path, 'r+');
      const [currentContent, stat] = await Promise.all([
        handle.readFile('utf8'),
        handle.stat({ bigint: true }),
      ]);
      assertSingleLink(snapshot.request.path, stat.nlink);
      if (revision(currentContent, stat.dev, stat.ino, stat.nlink) !== snapshot.revision) {
        throw new Error(`File changed during mutation: ${snapshot.request.path}. Re-read and retry.`);
      }
    }
    commitStarted = true;
    await writeFileHandleFully(handle, content);
    backup?.recordLatest();
  } catch (error: unknown) {
    if (commitStarted) backup?.preserveExisting();
    if (snapshot.state === 'missing' && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`File changed during mutation: ${snapshot.request.path}. Re-read and retry.`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeTextFileForMutation(
  snapshot: TextFileMutationSnapshot,
  content: string,
  createParentDirectories: boolean,
  ctx: KodaXToolExecutionContext,
  backupContent?: string,
): Promise<void> {
  const backup = mutationBackup(snapshot, ctx, backupContent);
  if (snapshot.execution === 'sandbox') {
    return writeSandboxedTextFile(
      snapshot,
      content,
      createParentDirectories,
      ctx.textFileMutationSandbox,
      backup,
    );
  }
  return writeHostTextFile(snapshot, content, createParentDirectories, backup);
}
