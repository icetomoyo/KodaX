import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  KodaXToolExecutionContext,
  KodaXTrustedTextMutationHost,
} from '../../types.js';
import {
  assertTrustedTextMutationPolicy,
  KodaXTrustedTextMutationError,
} from '../../trusted-text-mutation.js';
import {
  recordResolvedFileBackup,
  resolveFileBackupPath,
  normalizePathForKey,
  withPathMutation,
} from './file-mutation-primitives.js';

interface TextFileSnapshot {
  readonly state: 'missing' | 'present';
  readonly content: string;
  readonly revision: string;
  readonly backupPath: string;
}

interface TextFileMutationRequest {
  readonly toolCallId?: string;
  readonly toolName: 'edit' | 'insert_after_anchor' | 'multi_edit' | 'undo' | 'write';
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly path: string;
  readonly signal?: AbortSignal;
}

interface TrustedTextMutationBackupReceipt {
  readonly canonicalPath: string;
  readonly slot: string;
  readonly postRevision: string;
  readonly preimage: string;
}

export interface TextFileMutationSnapshot extends TextFileSnapshot {
  readonly execution: 'host';
  readonly request: TextFileMutationRequest;
  readonly trustedHost?: KodaXTrustedTextMutationHost;
  readonly trustedSlot?: string;
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

async function readHostSnapshot(filePath: string): Promise<TextFileSnapshot> {
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

interface MutationBackup {
  preserveExisting(): void;
  recordLatest(
    content?: string,
    receipt?: TrustedTextMutationBackupReceipt,
  ): void;
}

const trustedTextMutationBackupReceipts = new WeakMap<
  Map<string, string>,
  Map<string, TrustedTextMutationBackupReceipt>
>();

function receiptMap(
  backups: Map<string, string>,
  create: boolean,
): Map<string, TrustedTextMutationBackupReceipt> | undefined {
  const current = trustedTextMutationBackupReceipts.get(backups);
  if (current !== undefined || !create) return current;
  const created = new Map<string, TrustedTextMutationBackupReceipt>();
  trustedTextMutationBackupReceipts.set(backups, created);
  return created;
}

export function getTrustedTextMutationBackupReceipt(
  backups: Map<string, string>,
  backupPath: string,
): TrustedTextMutationBackupReceipt | undefined {
  return receiptMap(backups, false)?.get(backupPath);
}

export function deleteTrustedTextMutationBackupReceipt(
  backups: Map<string, string>,
  backupPath: string,
): void {
  receiptMap(backups, false)?.delete(backupPath);
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
    recordLatest(current = content, receipt) {
      recordResolvedFileBackup(backups, backupPath, current);
      if (receipt === undefined) {
        deleteTrustedTextMutationBackupReceipt(backups, backupPath);
      } else {
        receiptMap(backups, true)?.set(backupPath, receipt);
      }
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
  toolName: TextFileMutationRequest['toolName'],
  toolInput: Readonly<Record<string, unknown>>,
  ctx: KodaXToolExecutionContext,
): TextFileMutationRequest {
  return {
    toolCallId: ctx.toolCallId,
    toolName,
    toolInput,
    path: filePath,
    signal: ctx.abortSignal,
  };
}

/**
 * Text tools execute in the trusted host and never enter the shell sandbox or
 * its filesystem-effect lease. On every supported desktop platform the host
 * snapshots optimistically, then reauthorizes, locks the canonical file slot,
 * rereads, and commits only when CAS still matches. The local path queue is a
 * test-only fallback when no Runtime host is bound.
 */
export function withTextFileMutation<T>(
  filePath: string,
  toolName: TextFileMutationRequest['toolName'],
  toolInput: Readonly<Record<string, unknown>>,
  ctx: KodaXToolExecutionContext,
  operation: (snapshot: TextFileMutationSnapshot) => Promise<T>,
): Promise<T> {
  const request = textFileMutationRequest(filePath, toolName, toolInput, ctx);
  const trustedHost = ctx.trustedTextMutationHost;
  assertTrustedTextMutationPolicy(
    filePath,
    ctx.executionCwd ?? ctx.gitRoot ?? process.cwd(),
  );
  if (trustedHost !== undefined) {
    return trustedHost.snapshot({
      path: filePath,
      createParentDirectories: toolName === 'write',
      signal: ctx.abortSignal,
    }).then((snapshot) => {
      assertTrustedTextMutationPolicy(
        snapshot.canonicalPath,
        ctx.executionCwd ?? ctx.gitRoot ?? process.cwd(),
      );
      return operation({
        state: snapshot.state,
        content: snapshot.content,
        revision: snapshot.revision,
        backupPath: snapshot.canonicalPath,
        execution: 'host',
        request,
        trustedHost,
        trustedSlot: snapshot.slot,
      });
    });
  }
  if (process.env.NODE_ENV !== 'test') {
    return Promise.reject(new KodaXTrustedTextMutationError({
      code: 'text_mutation_unsupported_filesystem',
      path: filePath,
      message: 'The trusted text transaction host is unavailable.',
    }));
  }
  return withPathMutation(filePath, async () => {
    return operation({
      ...await readHostSnapshot(filePath),
      execution: 'host',
      request,
    });
  });
}

function mutationBackup(
  snapshot: TextFileMutationSnapshot,
  ctx: KodaXToolExecutionContext,
  backupContent?: string,
): MutationBackup | undefined {
  if (backupContent === undefined) return undefined;
  return createMutationBackup(
    ctx.backups,
    snapshot.trustedHost === undefined
      ? resolveFileBackupPath(snapshot.request.path)
      : snapshot.backupPath,
    backupContent,
  );
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
  undoReceipt?: TrustedTextMutationBackupReceipt,
): Promise<void> {
  const backup = mutationBackup(snapshot, ctx, backupContent);
  if (snapshot.trustedHost !== undefined) {
    const expectedRevision = undoReceipt?.postRevision ?? snapshot.revision;
    const expectedSlot = undoReceipt?.slot ?? snapshot.trustedSlot;
    const expectedCanonicalPath = undoReceipt?.canonicalPath ?? snapshot.backupPath;
    const undoBackupPath = undoReceipt === undefined ? undefined : snapshot.request.path;
    if (
      snapshot.trustedSlot !== expectedSlot
      || normalizePathForKey(snapshot.backupPath) !== normalizePathForKey(expectedCanonicalPath)
      || (undoBackupPath !== undefined
        && normalizePathForKey(undoBackupPath) !== normalizePathForKey(expectedCanonicalPath))
    ) {
      throw new KodaXTrustedTextMutationError({
        code: 'text_mutation_identity_changed',
        path: snapshot.request.path,
        message: `Trusted text mutation receipt identity changed: ${snapshot.request.path}`,
      });
    }
    const outcome = await snapshot.trustedHost.commit({
      path: snapshot.request.path,
      expectedRevision,
      content,
      createParentDirectories,
      signal: ctx.abortSignal,
    });
    if (outcome.status === 'stale') {
      throw new KodaXTrustedTextMutationError({
        code: 'text_mutation_stale',
        path: snapshot.request.path,
        message: `File changed during mutation: ${snapshot.request.path}. Re-read and retry.`,
        expectedRevision,
        actualRevision: outcome.currentRevision,
      });
    }
    if (
      outcome.before.revision !== expectedRevision
      || outcome.before.slot !== expectedSlot
      || outcome.after.slot !== expectedSlot
      || normalizePathForKey(outcome.before.canonicalPath)
        !== normalizePathForKey(expectedCanonicalPath)
      || normalizePathForKey(outcome.after.canonicalPath)
        !== normalizePathForKey(expectedCanonicalPath)
      || outcome.after.content !== content
    ) {
      throw new KodaXTrustedTextMutationError({
        code: 'text_mutation_identity_changed',
        path: snapshot.request.path,
        message: `Trusted text mutation receipt identity changed: ${snapshot.request.path}`,
      });
    }
    if (backup !== undefined) {
      backup.recordLatest(outcome.before.content, {
        canonicalPath: outcome.after.canonicalPath,
        slot: outcome.after.slot,
        postRevision: outcome.after.revision,
        preimage: outcome.before.content,
      });
    }
    if (outcome.status === 'committed_uncertain') {
      if (undoReceipt !== undefined && undoBackupPath !== undefined) {
        receiptMap(ctx.backups, true)?.set(undoBackupPath, {
          canonicalPath: outcome.after.canonicalPath,
          slot: outcome.after.slot,
          postRevision: outcome.after.revision,
          preimage: undoReceipt.preimage,
        });
      }
      throw new KodaXTrustedTextMutationError({
        code: 'text_mutation_commit_uncertain',
        path: snapshot.request.path,
        message: `Text replacement may have committed, but its durability could not be proven: ${snapshot.request.path}. Re-read before taking any further action. ${outcome.reason}`,
        expectedRevision: outcome.before.revision,
        actualRevision: outcome.after.revision,
        commitReceipt: {
          before: outcome.before,
          after: outcome.after,
        },
      });
    }
    return;
  }
  if (undoReceipt !== undefined) {
    throw new KodaXTrustedTextMutationError({
      code: 'text_mutation_unsupported_filesystem',
      path: snapshot.request.path,
      message: `The trusted text transaction host is unavailable for undo: ${snapshot.request.path}`,
    });
  }
  return writeHostTextFile(snapshot, content, createParentDirectories, backup);
}
