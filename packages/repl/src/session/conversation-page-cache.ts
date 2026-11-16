import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { replaceFileWithRetry } from './replace-file.js';

import type {
  KodaXSessionEntry,
  KodaXSessionLineage,
  KodaXSessionRuntimeInfo,
} from '@kodax-ai/agent';

import {
  createConversationEntryChain,
  createSessionConversationHistoryRevision,
  extendConversationEntryChain,
  isManagedContextMessage,
  isOrdinaryConversationMessageEntry,
  type SessionConversationHistoryData,
  type SessionConversationHistoryEntry,
  type SessionConversationHistoryIssue,
  type SessionConversationHistoryStatus,
} from './conversation-history.js';
import {
  createSessionSourceRevision,
  isSessionSourceRevisionState,
  type SessionSourceRevisionState,
} from './source-revision.js';
import {
  CACHE_FILE_MARKER,
  CACHE_MANIFEST_SUFFIX,
  cacheArtifactSessionId,
} from './conversation-page-cache-files.js';
export {
  ConversationPageCacheCleanupError,
  removeConversationPageCache,
  removeConversationPageCachesInDirectory,
} from './conversation-page-cache-files.js';

// v11 moves superseded revisions from the manifest into an append-only revision log.
const CACHE_VERSION = 11;
const INDEX_RECORD_BYTES = 24;
const WRITE_BATCH_BYTES = 1024 * 1024;
const MAX_CACHE_MANIFEST_BYTES = 1024 * 1024;
const MAX_CACHE_DESCRIPTOR_BYTES = 1024 * 1024;
const MAX_CACHE_CHUNK_BYTES = 4 * 1024 * 1024;
// Fixed-size, no-false-negative membership witness. A false positive only
// invalidates the optimization and falls back to canonical reconstruction.
const IDENTITY_FILTER_BYTES = 128 * 1024;
const IDENTITY_FILTER_HASHES = 7;
// A Run checkpoints its view about twice a second, and every save supersedes the page revision.
// Superseded revisions whose entries are a prefix of the current ones stay readable through an
// append-only log of fixed records: revision digest, source revision digest, uint64 entry count.
const REVISION_RECORD_BYTES = 72;
const MAX_REVISION_LOG_BYTES = REVISION_RECORD_BYTES * 16_384;
const REVISION_SCAN_BYTES = REVISION_RECORD_BYTES * 1024;

export interface ConversationPageCacheAdmission {
  readonly surface?: string;
  readonly profileId?: string;
}

/** A readable revision: the current one, or a superseded one whose entries are a prefix of it. */
export interface ConversationPageCacheRevision {
  readonly revision: string;
  readonly sourceRevision: string;
  readonly entryCount: number;
}

interface ConversationCacheManifest {
  readonly version: 11;
  readonly sessionId: string;
  readonly generation: string;
  readonly sourceRevision: string;
  readonly sourceRevisionState: SessionSourceRevisionState;
  readonly identityFilter: string;
  readonly boundaryRevision: string;
  readonly revision: string;
  readonly entryChain: string;
  readonly status: SessionConversationHistoryStatus;
  readonly issues: readonly SessionConversationHistoryIssue[];
  readonly entryCount: number;
  readonly lineageEntryCount: number;
  readonly activeEntryId: string | null;
  readonly admission: ConversationPageCacheAdmission;
  readonly chunkBytes: number;
  readonly dataFile: string;
  readonly dataBytes: number;
  readonly indexFile: string;
  readonly indexBytes: number;
  /** File name of the superseded-revision log; the file is absent until a revision is superseded. */
  readonly revisionLog: string;
}

interface ConversationCacheDescriptor {
  readonly chunkDigests: readonly string[];
  readonly boundaryId?: string;
  readonly sourceKeys: readonly string[];
}

interface ConversationCacheIndexRecord {
  readonly entryOffset: number;
  readonly entryLength: number;
  readonly descriptorOffset: number;
  readonly descriptorLength: number;
}

export interface ConversationPageCacheInput {
  /**
   * Page cursor revision. Any revision of the current generation is served from
   * its immutable entry prefix, without the writer boundary.
   */
  readonly expectedRevision?: string;
  readonly end?: number;
  readonly limit: number;
  readonly maxPageBytes: number;
  readonly maxInlineEntryBytes: number;
  readonly reservedBytes: number;
  /** Internal source lookup: returns matching entry locators without reading bodies. */
  readonly sourceKeys?: readonly string[];
  readonly authorize?: (
    admission: ConversationPageCacheAdmission,
  ) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

export interface ConversationPageCacheEntry {
  readonly index: number;
  readonly boundaryId?: string;
  readonly byteLength: number;
  readonly oversized: boolean;
  readonly entry?: SessionConversationHistoryEntry;
}

export interface ConversationPageCachePage {
  readonly revision: string;
  readonly sourceRevision: string;
  readonly status: SessionConversationHistoryStatus;
  readonly issues: readonly SessionConversationHistoryIssue[];
  readonly entries: readonly ConversationPageCacheEntry[];
  readonly hasMore: boolean;
  readonly nextEnd?: number;
  readonly newerStart?: number;
}

export interface ConversationPageCacheChunkInput {
  readonly revision: string;
  readonly entryIndex: number;
  readonly offset: number;
  readonly authorize?: (
    admission: ConversationPageCacheAdmission,
  ) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

export interface ConversationPageCacheChunk {
  readonly revision: string;
  readonly entryIndex: number;
  readonly boundaryId?: string;
  readonly data: Buffer;
  readonly nextOffset?: number;
}

export class ConversationPageCacheStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationPageCacheStaleError';
  }
}

export class ConversationPageCacheCapacityError extends Error {
  constructor() {
    super('Conversation page capacity exceeded');
    this.name = 'ConversationPageCacheCapacityError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ConversationPageCacheStaleError('Conversation page read cancelled');
}

function cacheManifestPath(mainPath: string): string {
  return mainPath.slice(0, -path.extname(mainPath).length) + CACHE_MANIFEST_SUFFIX;
}

function cacheGenerationPath(mainPath: string, generation: string, kind: 'data' | 'index'): string {
  const stem = mainPath.slice(0, -path.extname(mainPath).length);
  return `${stem}${CACHE_FILE_MARKER}${generation}.${kind}`;
}

function isSafeCacheFileName(
  mainPath: string,
  fileName: string,
  kind: 'data' | 'index' | 'revisions',
): boolean {
  const sessionId = path.basename(mainPath, path.extname(mainPath));
  return path.basename(fileName) === fileName
    && fileName.startsWith(`${sessionId}${CACHE_FILE_MARKER}`)
    && fileName.endsWith(`.${kind}`);
}

function isConversationIssue(value: unknown): value is SessionConversationHistoryIssue {
  if (!isRecord(value)) return false;
  const codes = new Set([
    'active_entry_missing',
    'compaction_boundary_invalid',
    'compaction_history_truncated',
    'compaction_predecessor_ambiguous',
    'compaction_predecessor_missing',
    'legacy_overlap_ambiguous',
    'lineage_path_incomplete',
    'lineage_unavailable',
    'logical_identity_conflict',
  ]);
  return typeof value.code === 'string'
    && codes.has(value.code)
    && typeof value.message === 'string'
    && Number.isSafeInteger(value.occurrenceCount)
    && Number(value.occurrenceCount) >= 0
    && Number.isSafeInteger(value.entryCount)
    && Number(value.entryCount) >= 0
    && Array.isArray(value.entryIds)
    && value.entryIds.every((entryId) => typeof entryId === 'string');
}

function isConversationPageCacheAdmission(
  value: unknown,
): value is ConversationPageCacheAdmission {
  return isRecord(value)
    && (value.surface === undefined || typeof value.surface === 'string')
    && (value.profileId === undefined || typeof value.profileId === 'string');
}

function identityPositions(identity: string): readonly number[] {
  const digest = createHash('sha256')
    .update('kodax-conversation-identity-filter-v1\0')
    .update(identity, 'utf8')
    .digest();
  return Array.from({ length: IDENTITY_FILTER_HASHES }, (_, index) =>
    digest.readUInt32LE(index * 4) % (IDENTITY_FILTER_BYTES * 8));
}

function identityFilterContains(filter: Buffer, identity: string): boolean {
  return identityPositions(identity).every((position) =>
    (filter[position >>> 3]! & (1 << (position & 7))) !== 0);
}

function addIdentityToFilter(filter: Buffer, identity: string): void {
  for (const position of identityPositions(identity)) {
    filter[position >>> 3] = filter[position >>> 3]! | (1 << (position & 7));
  }
}

function lineageEntryIdentities(entry: KodaXSessionLineage['entries'][number]): readonly string[] {
  return [entry.id, entry.logicalId, entry.sourceEntryId]
    .filter((identity): identity is string => identity !== undefined);
}

export function createConversationPageIdentityFilter(lineage: KodaXSessionLineage): string {
  const filter = Buffer.alloc(IDENTITY_FILTER_BYTES);
  for (const entry of lineage.entries) {
    for (const identity of lineageEntryIdentities(entry)) addIdentityToFilter(filter, identity);
  }
  return filter.toString('base64');
}

export function extendConversationPageIdentityFilter(
  encoded: string,
  entries: readonly KodaXSessionEntry[],
): string {
  const filter = Buffer.from(encoded, 'base64');
  for (const entry of entries) {
    for (const identity of lineageEntryIdentities(entry)) addIdentityToFilter(filter, identity);
  }
  return filter.toString('base64');
}

function isIdentityFilter(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === IDENTITY_FILTER_BYTES && decoded.toString('base64') === value;
}

export function conversationPageIdentityFilterContains(
  encoded: string,
  identity: string,
): boolean {
  if (!isIdentityFilter(encoded)) return true;
  return identityFilterContains(Buffer.from(encoded, 'base64'), identity);
}

function newRevisionLogName(mainPath: string): string {
  return `${path.basename(mainPath, path.extname(mainPath))}${CACHE_FILE_MARKER}${randomUUID()}.revisions`;
}

function revisionDigest(value: string): Buffer | undefined {
  return /^sha256:[0-9a-f]{64}$/.test(value) ? Buffer.from(value.slice(7), 'hex') : undefined;
}

function encodeRevisionRecord(manifest: ConversationCacheManifest): Buffer | undefined {
  const revision = revisionDigest(manifest.revision);
  const sourceRevision = revisionDigest(manifest.sourceRevision);
  if (revision === undefined || sourceRevision === undefined) return undefined;
  const record = Buffer.alloc(REVISION_RECORD_BYTES);
  revision.copy(record, 0);
  sourceRevision.copy(record, 32);
  record.writeBigUInt64LE(BigInt(manifest.entryCount), 64);
  return record;
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * Logs `previous` as superseded by `revision`, whose entries keep its entries as a prefix.
 * Returns the log the next manifest names: a full log is rewritten with its newest half.
 * No fsync: a record lost to a crash only makes an older cursor request a fresh page.
 */
async function recordSupersededRevision(
  mainPath: string,
  previous: ConversationCacheManifest,
  revision: string,
): Promise<string> {
  const record = encodeRevisionRecord(previous);
  if (revision === previous.revision || record === undefined) return previous.revisionLog;
  const logPath = path.join(path.dirname(mainPath), previous.revisionLog);
  const size = await fileSize(logPath);
  if (size % REVISION_RECORD_BYTES === 0 && size + REVISION_RECORD_BYTES <= MAX_REVISION_LOG_BYTES) {
    await fs.appendFile(logPath, record);
    return previous.revisionLog;
  }
  const aligned = size - (size % REVISION_RECORD_BYTES);
  const keptBytes = Math.min(aligned, MAX_REVISION_LOG_BYTES / 2);
  const handle = await fs.open(logPath, 'r');
  let kept: Buffer;
  try {
    kept = await readFully(handle, aligned - keptBytes, keptBytes);
  } finally {
    await handle.close();
  }
  const next = newRevisionLogName(mainPath);
  await fs.writeFile(path.join(path.dirname(mainPath), next), Buffer.concat([kept, record]), { flag: 'wx' });
  return next;
}

async function retireRevisionLog(mainPath: string, previous: string, current: string): Promise<void> {
  if (previous === current) return;
  try {
    await fs.rm(path.join(path.dirname(mainPath), previous), { force: true });
  } catch (error: unknown) {
    process.emitWarning(
      `Unable to remove an old Conversation page revision log: ${String(error)}`,
      { code: 'KODAX_CONVERSATION_PAGE_CACHE_GC_FAILED' },
    );
  }
}

/**
 * A Run saves by rewriting the session, which rebuilds the cache. Earlier revisions stay readable
 * when the rebuilt entries keep theirs as an unchanged prefix; any other rewrite retires them.
 */
function extendsPreviousEntries(
  previous: ConversationCacheManifest,
  history: SessionConversationHistoryData,
  chunkBytes: number,
): boolean {
  return previous.chunkBytes === chunkBytes
    && previous.status === history.status
    && JSON.stringify(previous.issues) === JSON.stringify(history.issues)
    && previous.entryCount <= history.entries.length
    && createConversationEntryChain(history.entries.slice(0, previous.entryCount)) === previous.entryChain;
}

export type ConversationPageCacheRevisionKey =
  | { readonly revision: string }
  | { readonly sourceRevision: string };

/** Newest first; undefined when `key` is neither current nor a logged prefix of this cache. */
async function findConversationRevision(
  mainPath: string,
  manifest: ConversationCacheManifest,
  key: ConversationPageCacheRevisionKey,
): Promise<ConversationPageCacheRevision | undefined> {
  const byRevision = 'revision' in key;
  if (byRevision ? key.revision === manifest.revision : key.sourceRevision === manifest.sourceRevision) {
    return { revision: manifest.revision, sourceRevision: manifest.sourceRevision, entryCount: manifest.entryCount };
  }
  const target = revisionDigest(byRevision ? key.revision : key.sourceRevision);
  if (target === undefined) return undefined;
  const field = byRevision ? 0 : 32;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(path.join(path.dirname(mainPath), manifest.revisionLog), 'r');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    // A torn trailing record from an interrupted append is ignored.
    for (let end = size - (size % REVISION_RECORD_BYTES); end > 0;) {
      const start = Math.max(0, end - REVISION_SCAN_BYTES);
      const records = await readFully(handle, start, end - start);
      for (let offset = records.length - REVISION_RECORD_BYTES; offset >= 0; offset -= REVISION_RECORD_BYTES) {
        if (!records.subarray(offset + field, offset + field + 32).equals(target)) continue;
        const entryCount = Number(records.readBigUInt64LE(offset + 64));
        if (entryCount > manifest.entryCount) return undefined;
        return {
          revision: `sha256:${records.toString('hex', offset, offset + 32)}`,
          sourceRevision: `sha256:${records.toString('hex', offset + 32, offset + 64)}`,
          entryCount,
        };
      }
      end = start;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Resolves a page or source revision against the current cache, without the writer boundary. */
export async function readConversationPageCacheRevision(
  mainPath: string,
  key: ConversationPageCacheRevisionKey,
): Promise<(ConversationPageCacheRevision & { readonly currentRevision: string }) | undefined> {
  const manifest = await readConversationPageCacheManifest(mainPath);
  if (manifest === undefined) return undefined;
  const found = await findConversationRevision(mainPath, manifest, key);
  return found && { ...found, currentRevision: manifest.revision };
}

function parseManifest(value: unknown, mainPath: string): ConversationCacheManifest | undefined {
  if (!isRecord(value) || value.version !== CACHE_VERSION) return undefined;
  if (
    typeof value.sessionId !== 'string'
    || typeof value.generation !== 'string'
    || typeof value.sourceRevision !== 'string'
    || !isSessionSourceRevisionState(value.sourceRevisionState)
    || createSessionSourceRevision(value.sourceRevisionState) !== value.sourceRevision
    || !isIdentityFilter(value.identityFilter)
    || typeof value.boundaryRevision !== 'string'
    || typeof value.revision !== 'string'
    || typeof value.entryChain !== 'string'
    || (value.status !== 'resolved' && value.status !== 'partial' && value.status !== 'ambiguous')
    || !Array.isArray(value.issues) || !value.issues.every(isConversationIssue)
    || !Number.isSafeInteger(value.entryCount) || Number(value.entryCount) < 0
    || !Number.isSafeInteger(value.lineageEntryCount) || Number(value.lineageEntryCount) < 0
    || (value.activeEntryId !== null && typeof value.activeEntryId !== 'string')
    || !isConversationPageCacheAdmission(value.admission)
    || !Number.isSafeInteger(value.chunkBytes) || Number(value.chunkBytes) <= 0
    || Number(value.chunkBytes) > MAX_CACHE_CHUNK_BYTES
    || typeof value.dataFile !== 'string'
    || !Number.isSafeInteger(value.dataBytes) || Number(value.dataBytes) < 0
    || typeof value.indexFile !== 'string'
    || !Number.isSafeInteger(value.indexBytes) || Number(value.indexBytes) < 0
    || !isSafeCacheFileName(mainPath, value.dataFile, 'data')
    || !isSafeCacheFileName(mainPath, value.indexFile, 'index')
    || value.dataFile !== `${value.sessionId}${CACHE_FILE_MARKER}${value.generation}.data`
    || value.indexFile !== `${value.sessionId}${CACHE_FILE_MARKER}${value.generation}.index`
    || value.sessionId !== path.basename(mainPath, path.extname(mainPath))
    || Number(value.indexBytes) !== Number(value.entryCount) * INDEX_RECORD_BYTES
    || typeof value.revisionLog !== 'string'
    || !isSafeCacheFileName(mainPath, value.revisionLog, 'revisions')
  ) {
    return undefined;
  }
  return value as unknown as ConversationCacheManifest;
}

function cacheAdmission(
  runtimeInfo: KodaXSessionRuntimeInfo | undefined,
): ConversationPageCacheAdmission {
  return {
    ...(runtimeInfo?.surface !== undefined ? { surface: runtimeInfo.surface } : {}),
    ...(runtimeInfo?.profileId !== undefined ? { profileId: runtimeInfo.profileId } : {}),
  };
}

export async function readConversationPageCacheManifest(
  mainPath: string,
): Promise<ConversationCacheManifest | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(cacheManifestPath(mainPath), 'r');
    const size = (await handle.stat()).size;
    if (size > MAX_CACHE_MANIFEST_BYTES) return undefined;
    const value: unknown = JSON.parse((await readFully(handle, 0, size)).toString('utf8'));
    return parseManifest(value, mainPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function cachePaths(mainPath: string, manifest: ConversationCacheManifest): {
  readonly dataPath: string;
  readonly indexPath: string;
} {
  const directory = path.dirname(mainPath);
  return {
    dataPath: path.join(directory, manifest.dataFile),
    indexPath: path.join(directory, manifest.indexFile),
  };
}

async function assertCacheFilesStable(
  mainPath: string,
  manifest: ConversationCacheManifest,
  allowGrowth = false,
): Promise<void> {
  const paths = cachePaths(mainPath, manifest);
  const [data, index] = await Promise.all([fs.stat(paths.dataPath), fs.stat(paths.indexPath)]);
  // Readers tolerate an append in flight: it only grows the files past this manifest.
  const stable = (size: number, expected: number): boolean =>
    allowGrowth ? size >= expected : size === expected;
  if (!stable(data.size, manifest.dataBytes) || !stable(index.size, manifest.indexBytes)) {
    throw new ConversationPageCacheStaleError('Conversation page cache changed');
  }
}

async function readFully(
  handle: Awaited<ReturnType<typeof fs.open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead === 0) {
      throw new ConversationPageCacheStaleError('Conversation page cache ended unexpectedly');
    }
    read += result.bytesRead;
  }
  return buffer;
}

function decodeIndexRecord(buffer: Buffer, offset: number): ConversationCacheIndexRecord {
  const entryOffset = buffer.readBigUInt64LE(offset);
  const descriptorOffset = buffer.readBigUInt64LE(offset + 12);
  if (
    entryOffset > BigInt(Number.MAX_SAFE_INTEGER)
    || descriptorOffset > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ConversationPageCacheStaleError('Conversation page index offset is invalid');
  }
  return {
    entryOffset: Number(entryOffset),
    entryLength: buffer.readUInt32LE(offset + 8),
    descriptorOffset: Number(descriptorOffset),
    descriptorLength: buffer.readUInt32LE(offset + 20),
  };
}

function assertIndexRecordBounds(
  record: ConversationCacheIndexRecord,
  dataBytes: number,
  chunkBytes: number,
): void {
  const entryEnd = record.entryOffset + record.entryLength;
  const descriptorEnd = record.descriptorOffset + record.descriptorLength;
  const digestCount = Math.ceil(record.entryLength / chunkBytes);
  const derivedDescriptorLimit = Math.min(
    MAX_CACHE_DESCRIPTOR_BYTES,
    record.entryLength + digestCount * 70 + 256,
  );
  if (
    !Number.isSafeInteger(entryEnd)
    || !Number.isSafeInteger(descriptorEnd)
    || entryEnd > dataBytes
    || descriptorEnd > dataBytes
    || record.descriptorOffset < entryEnd
    || record.descriptorLength > derivedDescriptorLimit
  ) {
    throw new ConversationPageCacheStaleError('Conversation page index is out of bounds');
  }
}

function encodeIndexRecord(record: ConversationCacheIndexRecord): Buffer {
  const buffer = Buffer.allocUnsafe(INDEX_RECORD_BYTES);
  buffer.writeBigUInt64LE(BigInt(record.entryOffset), 0);
  buffer.writeUInt32LE(record.entryLength, 8);
  buffer.writeBigUInt64LE(BigInt(record.descriptorOffset), 12);
  buffer.writeUInt32LE(record.descriptorLength, 20);
  return buffer;
}

function parseDescriptor(value: unknown): ConversationCacheDescriptor {
  if (
    !isRecord(value)
    || !Array.isArray(value.chunkDigests)
    || !value.chunkDigests.every((digest) =>
      typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest))
    || (value.boundaryId !== undefined && typeof value.boundaryId !== 'string')
    || !Array.isArray(value.sourceKeys) || !value.sourceKeys.every(key => typeof key === 'string')
  ) {
    throw new ConversationPageCacheStaleError('Conversation page descriptor is invalid');
  }
  return {
    chunkDigests: value.chunkDigests,
    sourceKeys: value.sourceKeys,
    ...(typeof value.boundaryId === 'string' ? { boundaryId: value.boundaryId } : {}),
  };
}

async function readDescriptor(
  data: Awaited<ReturnType<typeof fs.open>>,
  record: ConversationCacheIndexRecord,
): Promise<ConversationCacheDescriptor> {
  const encoded = await readFully(data, record.descriptorOffset, record.descriptorLength);
  try {
    return parseDescriptor(JSON.parse(encoded.toString('utf8')));
  } catch (error: unknown) {
    if (error instanceof ConversationPageCacheStaleError) throw error;
    throw new ConversationPageCacheStaleError('Conversation page descriptor is corrupt');
  }
}

function entryChunkDigests(encoded: Buffer, chunkBytes: number): string[] {
  const digests: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += chunkBytes) {
    digests.push(createHash('sha256')
      .update(encoded.subarray(offset, Math.min(encoded.length, offset + chunkBytes)))
      .digest('hex'));
  }
  return digests;
}

function assertEntryIntegrity(
  encoded: Buffer,
  descriptor: ConversationCacheDescriptor,
  chunkBytes: number,
): void {
  const actual = entryChunkDigests(encoded, chunkBytes);
  if (
    actual.length !== descriptor.chunkDigests.length
    || actual.some((digest, index) => digest !== descriptor.chunkDigests[index])
  ) {
    throw new ConversationPageCacheStaleError('Conversation page cache entry is corrupt');
  }
}

const CACHE_IO_ERROR_CODES = new Set([
  'EACCES',
  'EBADF',
  'EBUSY',
  'EIO',
  'EISDIR',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
  'ESTALE',
]);

function isCacheIoError(error: unknown): boolean {
  return isRecord(error) && typeof error.code === 'string' && CACHE_IO_ERROR_CODES.has(error.code);
}

function normalizeConversationPageCacheReadError(error: unknown): Error {
  if (
    error instanceof ConversationPageCacheStaleError
    || error instanceof ConversationPageCacheCapacityError
  ) return error;
  if (error instanceof SyntaxError || isCacheIoError(error)) {
    return new ConversationPageCacheStaleError('Conversation page cache changed or is unavailable');
  }
  return error instanceof Error ? error : new Error(String(error));
}

interface CacheGenerationSeen {
  generation?: string;
}

const MAX_CACHE_GENERATION_READ_ATTEMPTS = 3;

/**
 * A rebuild retires the generation files a reader's manifest named. When an IO error coincides
 * with a newer generation, the read restarts on it; an older revision kept as its prefix still
 * resolves there, and any other rewrite reports a stale revision.
 */
async function readAcrossCacheGenerations<T>(
  mainPath: string,
  read: (seen: CacheGenerationSeen) => Promise<T>,
): Promise<T> {
  try {
    for (let attempt = 1; ; attempt += 1) {
      const seen: CacheGenerationSeen = {};
      try {
        return await read(seen);
      } catch (error: unknown) {
        if (
          attempt >= MAX_CACHE_GENERATION_READ_ATTEMPTS
          || seen.generation === undefined
          || !isCacheIoError(error)
          || (await readConversationPageCacheManifest(mainPath))?.generation === seen.generation
        ) throw error;
      }
    }
  } catch (error: unknown) {
    throw normalizeConversationPageCacheReadError(error);
  }
}

async function openCachePair(
  dataPath: string,
  indexPath: string,
  flags: 'r' | 'wx',
): Promise<{
  readonly data: Awaited<ReturnType<typeof fs.open>>;
  readonly index: Awaited<ReturnType<typeof fs.open>>;
}> {
  const data = await fs.open(dataPath, flags);
  try {
    const index = await fs.open(indexPath, flags);
    return { data, index };
  } catch (error: unknown) {
    await data.close();
    throw error;
  }
}

/**
 * `boundaryRevision` is only checked for a newest read: an `expectedRevision`
 * read is witnessed by its revision, whose entries are an immutable prefix.
 */
export async function readConversationPageCache(
  mainPath: string,
  boundaryRevision: string | undefined,
  input: ConversationPageCacheInput,
): Promise<ConversationPageCachePage | null> {
  return readAcrossCacheGenerations(mainPath, (seen) =>
    readConversationPageCacheInternal(mainPath, boundaryRevision, input, seen));
}

async function readConversationPageCacheInternal(
  mainPath: string,
  boundaryRevision: string | undefined,
  input: ConversationPageCacheInput,
  seen: CacheGenerationSeen,
): Promise<ConversationPageCachePage | null> {
  throwIfAborted(input.signal);
  const manifest = await readConversationPageCacheManifest(mainPath);
  if (manifest === undefined) return null;
  seen.generation = manifest.generation;
  if (input.expectedRevision === undefined && manifest.boundaryRevision !== boundaryRevision) {
    return null;
  }
  await input.authorize?.(manifest.admission);
  const located = await findConversationRevision(mainPath, manifest, {
    revision: input.expectedRevision ?? manifest.revision,
  });
  if (located === undefined) {
    throw new ConversationPageCacheStaleError('Conversation history changed; request a fresh page');
  }
  const { revision, sourceRevision, entryCount } = located;
  await assertCacheFilesStable(mainPath, manifest, true);
  const end = Math.min(input.end ?? entryCount, entryCount);
  const start = Math.max(0, end - input.limit);
  const paths = cachePaths(mainPath, manifest);
  const { data, index } = await openCachePair(paths.dataPath, paths.indexPath, 'r');
  try {
    if (input.sourceKeys) {
      const entries = await findConversationSourceEntries(data, index, manifest, entryCount, input);
      await assertCacheFilesStable(mainPath, manifest, true);
      return { revision, sourceRevision,
        status: manifest.status, issues: structuredClone(manifest.issues), entries, hasMore: false };
    }
    const encodedIndex = await readFully(
      index,
      start * INDEX_RECORD_BYTES,
      (end - start) * INDEX_RECORD_BYTES,
    );
    const entries: ConversationPageCacheEntry[] = [];
    let encodedBytes = input.reservedBytes + Buffer.byteLength(JSON.stringify({
      revision,
      sourceRevision,
      status: manifest.status,
      issues: manifest.issues,
    }), 'utf8');
    if (encodedBytes > input.maxPageBytes) {
      throw new ConversationPageCacheCapacityError();
    }
    for (let relative = end - start - 1; relative >= 0; relative -= 1) {
      throwIfAborted(input.signal);
      const indexValue = start + relative;
      const record = decodeIndexRecord(encodedIndex, relative * INDEX_RECORD_BYTES);
      assertIndexRecordBounds(record, manifest.dataBytes, manifest.chunkBytes);
      const descriptor = await readDescriptor(data, record);
      const entry = record.entryLength <= input.maxInlineEntryBytes
        ? await readFully(data, record.entryOffset, record.entryLength)
        : undefined;
      if (entry !== undefined) assertEntryIntegrity(entry, descriptor, manifest.chunkBytes);
      const item: ConversationPageCacheEntry = {
        index: indexValue,
        ...(descriptor.boundaryId !== undefined ? { boundaryId: descriptor.boundaryId } : {}),
        byteLength: record.entryLength,
        oversized: record.entryLength > input.maxInlineEntryBytes,
        ...(entry !== undefined
          ? { entry: JSON.parse(entry.toString('utf8')) as SessionConversationHistoryEntry }
          : {}),
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
      if (encodedBytes + itemBytes > input.maxPageBytes) {
        if (entries.length === 0) throw new ConversationPageCacheCapacityError();
        break;
      }
      entries.unshift(item);
      encodedBytes += itemBytes;
    }
    const firstIndex = entries[0]?.index ?? end;
    await assertCacheFilesStable(mainPath, manifest, true);
    return {
      revision,
      sourceRevision,
      status: manifest.status,
      issues: structuredClone(manifest.issues),
      entries,
      hasMore: firstIndex > 0,
      ...(end < entryCount ? { newerStart: end } : {}),
      ...(firstIndex > 0 ? { nextEnd: firstIndex } : {}),
    };
  } finally {
    await Promise.all([data.close(), index.close()]);
  }
}

async function findConversationSourceEntries(
  data: Awaited<ReturnType<typeof fs.open>>,
  index: Awaited<ReturnType<typeof fs.open>>,
  manifest: ConversationCacheManifest,
  entryCount: number,
  input: ConversationPageCacheInput,
): Promise<ConversationPageCacheEntry[]> {
  const pending = new Set(input.sourceKeys);
  const entries: ConversationPageCacheEntry[] = [];
  let bytes = input.reservedBytes;
  for (let end = entryCount; end > 0 && pending.size > 0;) {
    const start = Math.max(0, end - 256);
    const encoded = await readFully(index, start * INDEX_RECORD_BYTES, (end - start) * INDEX_RECORD_BYTES);
    for (let position = end - 1; position >= start && pending.size > 0; position -= 1) {
      throwIfAborted(input.signal);
      const record = decodeIndexRecord(encoded, (position - start) * INDEX_RECORD_BYTES);
      assertIndexRecordBounds(record, manifest.dataBytes, manifest.chunkBytes);
      const descriptor = await readDescriptor(data, record);
      if (!descriptor.sourceKeys.some(key => pending.has(key))) continue;
      for (const key of descriptor.sourceKeys) pending.delete(key);
      const entry = { index: position, boundaryId: descriptor.boundaryId,
        byteLength: record.entryLength, oversized: true };
      bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8');
      if (bytes > input.maxPageBytes) throw new ConversationPageCacheCapacityError();
      entries.push(entry);
    }
    end = start;
  }
  return entries.reverse();
}

/** Any revision of the current generation reads its immutable entries; the boundary is optional. */
export async function readConversationPageCacheChunk(
  mainPath: string,
  boundaryRevision: string | undefined,
  input: ConversationPageCacheChunkInput,
): Promise<ConversationPageCacheChunk | null | undefined> {
  return readAcrossCacheGenerations(mainPath, (seen) =>
    readConversationPageCacheChunkInternal(mainPath, boundaryRevision, input, seen));
}

async function readConversationPageCacheChunkInternal(
  mainPath: string,
  boundaryRevision: string | undefined,
  input: ConversationPageCacheChunkInput,
  seen: CacheGenerationSeen,
): Promise<ConversationPageCacheChunk | null | undefined> {
  throwIfAborted(input.signal);
  const manifest = await readConversationPageCacheManifest(mainPath);
  if (manifest === undefined) return null;
  seen.generation = manifest.generation;
  if (boundaryRevision !== undefined && manifest.boundaryRevision !== boundaryRevision) return null;
  await input.authorize?.(manifest.admission);
  const located = await findConversationRevision(mainPath, manifest, { revision: input.revision });
  if (located === undefined) {
    throw new ConversationPageCacheStaleError('Conversation history changed; request a fresh page');
  }
  await assertCacheFilesStable(mainPath, manifest, true);
  if (input.entryIndex >= located.entryCount) {
    // Let storage verify its final source/topology boundary before reporting EOF.
    return undefined;
  }
  if (input.offset < 0 || input.offset % manifest.chunkBytes !== 0) {
    throw new ConversationPageCacheStaleError('Conversation entry cursor is invalid');
  }
  const paths = cachePaths(mainPath, manifest);
  const { data, index } = await openCachePair(paths.dataPath, paths.indexPath, 'r');
  try {
    const encodedIndex = await readFully(index, input.entryIndex * INDEX_RECORD_BYTES, INDEX_RECORD_BYTES);
    const record = decodeIndexRecord(encodedIndex, 0);
    assertIndexRecordBounds(record, manifest.dataBytes, manifest.chunkBytes);
    const descriptor = await readDescriptor(data, record);
    if (input.offset > record.entryLength) {
      throw new ConversationPageCacheStaleError('Conversation entry cursor is invalid');
    }
    const end = Math.min(record.entryLength, input.offset + manifest.chunkBytes);
    const chunk = await readFully(data, record.entryOffset + input.offset, end - input.offset);
    const digest = createHash('sha256').update(chunk).digest('hex');
    if (digest !== descriptor.chunkDigests[input.offset / manifest.chunkBytes]) {
      throw new ConversationPageCacheStaleError('Conversation page cache entry is corrupt');
    }
    await assertCacheFilesStable(mainPath, manifest, true);
    return {
      revision: input.revision,
      entryIndex: input.entryIndex,
      ...(descriptor.boundaryId !== undefined ? { boundaryId: descriptor.boundaryId } : {}),
      data: chunk,
      ...(end < record.entryLength ? { nextOffset: end } : {}),
    };
  } finally {
    await Promise.all([data.close(), index.close()]);
  }
}

async function writeFully(
  handle: Awaited<ReturnType<typeof fs.open>>,
  buffer: Buffer,
): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written);
    if (result.bytesWritten === 0) throw new Error('Conversation page cache write made no progress');
    written += result.bytesWritten;
  }
}

function createDescriptor(
  entry: SessionConversationHistoryEntry,
  encoded: Buffer,
  chunkBytes: number,
): Buffer {
  return Buffer.from(JSON.stringify({
    ...(entry.boundaryId !== undefined ? { boundaryId: entry.boundaryId } : {}),
    sourceKeys: [
      ...(entry.message.outputId ? [`output:${entry.message.outputId}`] : []),
      ...[entry.message.inputId, ...(entry.message.inputIds ?? [])].flatMap(id => id ? [`input:${id}`] : []),
      ...(typeof entry.message.content === 'string' ? [] : entry.message.content.flatMap(block =>
        block.type === 'tool_use' ? [`tool-use:${block.id}`]
          : block.type === 'tool_result' ? [`tool-result:${block.tool_use_id}`] : [])),
    ],
    chunkDigests: entryChunkDigests(encoded, chunkBytes),
  }), 'utf8');
}

async function writeCacheEntries(
  dataPath: string,
  indexPath: string,
  entries: readonly SessionConversationHistoryEntry[],
  chunkBytes: number,
): Promise<{ readonly dataBytes: number; readonly indexBytes: number }> {
  const { data, index } = await openCachePair(dataPath, indexPath, 'wx');
  let dataBytes = 0;
  let indexBytes = 0;
  let dataBatch: Buffer[] = [];
  let indexBatch: Buffer[] = [];
  let batchBytes = 0;
  const flush = async (): Promise<void> => {
    if (batchBytes === 0) return;
    await Promise.all([
      writeFully(data, Buffer.concat(dataBatch)),
      writeFully(index, Buffer.concat(indexBatch)),
    ]);
    dataBatch = [];
    indexBatch = [];
    batchBytes = 0;
  };
  try {
    for (const entry of entries) {
      const encoded = Buffer.from(JSON.stringify(entry), 'utf8');
      const descriptor = createDescriptor(entry, encoded, chunkBytes);
      dataBatch.push(encoded, descriptor);
      indexBatch.push(encodeIndexRecord({
        entryOffset: dataBytes,
        entryLength: encoded.length,
        descriptorOffset: dataBytes + encoded.length,
        descriptorLength: descriptor.length,
      }));
      dataBytes += encoded.length + descriptor.length;
      indexBytes += INDEX_RECORD_BYTES;
      batchBytes += encoded.length + descriptor.length + INDEX_RECORD_BYTES;
      if (batchBytes >= WRITE_BATCH_BYTES) await flush();
    }
    await flush();
    await Promise.all([data.sync(), index.sync()]);
    return { dataBytes, indexBytes };
  } finally {
    await Promise.all([data.close(), index.close()]);
  }
}

async function replaceManifest(mainPath: string, manifest: ConversationCacheManifest): Promise<void> {
  const target = cacheManifestPath(mainPath);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx' });
  try {
    await replaceFileWithRetry(temp, target);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function removeGenerationFiles(
  mainPath: string,
  keepGeneration: string,
  keepRevisionLog: string,
): Promise<void> {
  const directory = path.dirname(mainPath);
  const sessionId = path.basename(mainPath, path.extname(mainPath));
  const prefix = `${sessionId}${CACHE_FILE_MARKER}`;
  const keepPrefix = `${prefix}${keepGeneration}.`;
  const names = await fs.readdir(directory);
  await Promise.all(names
    .filter((name) => cacheArtifactSessionId(name) === sessionId
      && !name.startsWith(keepPrefix)
      && name !== keepRevisionLog
      && name !== path.basename(cacheManifestPath(mainPath)))
    .map((name) => fs.rm(path.join(directory, name), { force: true })));
}

export async function writeConversationPageCache(
  mainPath: string,
  boundaryRevision: string,
  sourceRevisionState: SessionSourceRevisionState,
  history: SessionConversationHistoryData,
  lineage: KodaXSessionLineage,
  runtimeInfo: KodaXSessionRuntimeInfo | undefined,
  chunkBytes: number,
): Promise<void> {
  if (createSessionSourceRevision(sourceRevisionState) !== history.sourceRevision) {
    throw new ConversationPageCacheStaleError('Conversation source revision state is inconsistent');
  }
  const generation = randomUUID();
  const dataPath = cacheGenerationPath(mainPath, generation, 'data');
  const indexPath = cacheGenerationPath(mainPath, generation, 'index');
  let revisionLog: string;
  try {
    const sizes = await writeCacheEntries(dataPath, indexPath, history.entries, chunkBytes);
    const previous = await readConversationPageCacheManifest(mainPath);
    const entryChain = createConversationEntryChain(history.entries);
    const revision = createSessionConversationHistoryRevision(history, entryChain);
    revisionLog = previous !== undefined && extendsPreviousEntries(previous, history, chunkBytes)
      ? await recordSupersededRevision(mainPath, previous, revision)
      : newRevisionLogName(mainPath);
    await replaceManifest(mainPath, {
      version: CACHE_VERSION,
      sessionId: path.basename(mainPath, path.extname(mainPath)),
      generation,
      sourceRevision: history.sourceRevision,
      sourceRevisionState,
      identityFilter: createConversationPageIdentityFilter(lineage),
      boundaryRevision,
      revision,
      entryChain,
      status: history.status,
      issues: history.issues,
      entryCount: history.entries.length,
      lineageEntryCount: lineage.entries.length,
      activeEntryId: lineage.activeEntryId,
      admission: cacheAdmission(runtimeInfo),
      chunkBytes,
      dataFile: path.basename(dataPath),
      dataBytes: sizes.dataBytes,
      indexFile: path.basename(indexPath),
      indexBytes: sizes.indexBytes,
      revisionLog,
    });
  } catch (error: unknown) {
    await Promise.all([fs.rm(dataPath, { force: true }), fs.rm(indexPath, { force: true })]);
    throw error;
  }
  try {
    await removeGenerationFiles(mainPath, generation, revisionLog);
  } catch (error: unknown) {
    process.emitWarning(
      `Unable to remove an old Conversation page cache generation: ${String(error)}`,
      { code: 'KODAX_CONVERSATION_PAGE_CACHE_GC_FAILED' },
    );
  }
}

export async function refreshConversationPageCache(
  mainPath: string,
  boundaryRevision: string,
  sourceRevisionState: SessionSourceRevisionState,
  history: SessionConversationHistoryData,
  lineage: KodaXSessionLineage,
  runtimeInfo: KodaXSessionRuntimeInfo | undefined,
): Promise<boolean> {
  if (createSessionSourceRevision(sourceRevisionState) !== history.sourceRevision) return false;
  const manifest = await readConversationPageCacheManifest(mainPath);
  if (manifest === undefined || manifest.entryCount !== history.entries.length) return false;
  await assertCacheFilesStable(mainPath, manifest);
  const entryChain = createConversationEntryChain(history.entries);
  if (
    entryChain !== manifest.entryChain
    || history.status !== manifest.status
    || JSON.stringify(history.issues) !== JSON.stringify(manifest.issues)
  ) return false;
  const revision = createSessionConversationHistoryRevision(history, entryChain);
  const revisionLog = await recordSupersededRevision(mainPath, manifest, revision);
  await replaceManifest(mainPath, {
    ...manifest,
    revisionLog,
    sourceRevision: history.sourceRevision,
    sourceRevisionState,
    identityFilter: createConversationPageIdentityFilter(lineage),
    boundaryRevision,
    revision,
    entryChain,
    status: history.status,
    issues: history.issues,
    lineageEntryCount: lineage.entries.length,
    activeEntryId: lineage.activeEntryId,
    admission: cacheAdmission(runtimeInfo),
  });
  await retireRevisionLog(mainPath, manifest.revisionLog, revisionLog);
  await assertCacheFilesStable(mainPath, manifest);
  return true;
}

async function appendBuffers(
  filePath: string,
  buffers: readonly Buffer[],
): Promise<void> {
  if (buffers.length === 0) return;
  const handle = await fs.open(filePath, 'a');
  try {
    await writeFully(handle, Buffer.concat(buffers));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendConversationPageCache(
  mainPath: string,
  previous: ConversationCacheManifest,
  boundaryRevision: string,
  sourceRevisionState: SessionSourceRevisionState,
  entries: readonly SessionConversationHistoryEntry[],
  appendedLineageEntries: readonly KodaXSessionEntry[],
  activeEntryId: string | null,
): Promise<void> {
  const sourceRevision = createSessionSourceRevision(sourceRevisionState);
  const paths = cachePaths(mainPath, previous);
  await assertCacheFilesStable(mainPath, previous);
  const dataBuffers: Buffer[] = [];
  const indexBuffers: Buffer[] = [];
  let dataBytes = previous.dataBytes;
  for (const entry of entries) {
    const encoded = Buffer.from(JSON.stringify(entry), 'utf8');
    const descriptor = createDescriptor(entry, encoded, previous.chunkBytes);
    dataBuffers.push(encoded, descriptor);
    indexBuffers.push(encodeIndexRecord({
      entryOffset: dataBytes,
      entryLength: encoded.length,
      descriptorOffset: dataBytes + encoded.length,
      descriptorLength: descriptor.length,
    }));
    dataBytes += encoded.length + descriptor.length;
  }
  await appendBuffers(paths.dataPath, dataBuffers);
  await appendBuffers(paths.indexPath, indexBuffers);
  const entryChain = extendConversationEntryChain(previous.entryChain, entries);
  const history = {
    sourceRevision,
    status: previous.status,
    issues: previous.issues,
    entries: [],
  } satisfies SessionConversationHistoryData;
  const revision = createSessionConversationHistoryRevision(history, entryChain);
  const revisionLog = await recordSupersededRevision(mainPath, previous, revision);
  await replaceManifest(mainPath, {
    ...previous,
    revisionLog,
    sourceRevision,
    sourceRevisionState,
    identityFilter: extendConversationPageIdentityFilter(
      previous.identityFilter,
      appendedLineageEntries,
    ),
    boundaryRevision,
    revision,
    entryChain,
    entryCount: previous.entryCount + entries.length,
    lineageEntryCount: previous.lineageEntryCount + appendedLineageEntries.length,
    activeEntryId,
    dataBytes,
    indexBytes: previous.indexBytes + entries.length * INDEX_RECORD_BYTES,
  });
  await retireRevisionLog(mainPath, previous.revisionLog, revisionLog);
}

export function canAppendConversationPageCache(
  manifest: ConversationCacheManifest,
  priorActiveEntryId: string | null | undefined,
  appended: readonly KodaXSessionEntry[],
  activeEntryId: string | null,
): readonly SessionConversationHistoryEntry[] | undefined {
  if (
    manifest.status !== 'resolved'
    || manifest.issues.length > 0
    || manifest.activeEntryId !== priorActiveEntryId
  ) {
    return undefined;
  }
  if (appended.length === 0) {
    return activeEntryId === priorActiveEntryId ? [] : undefined;
  }
  const priorIdentities = Buffer.from(manifest.identityFilter, 'base64');
  const appendedIdentities = new Set<string>();
  let parentId = priorActiveEntryId;
  const projected: SessionConversationHistoryEntry[] = [];
  for (const entry of appended) {
    if (entry.type === 'message' && isManagedContextMessage(entry.message)) {
      // Topology-transparent envelope: keep the physical parent chain
      // linear without projecting it as an ordinary conversation entry.
      if (entry.parentId !== parentId) return undefined;
      parentId = entry.id;
      continue;
    }
    if (
      !isOrdinaryConversationMessageEntry(entry)
      || entry.parentId !== parentId
      || (entry.logicalId !== undefined && entry.logicalId !== entry.id)
      || entry.sourceEntryId !== undefined
      || identityFilterContains(priorIdentities, entry.id)
      || appendedIdentities.has(entry.id)
    ) {
      return undefined;
    }
    projected.push({
      boundaryId: entry.id,
      auditEntryIds: [entry.id],
      message: entry.message,
    });
    appendedIdentities.add(entry.id);
    parentId = entry.id;
  }
  return activeEntryId === parentId ? projected : undefined;
}
