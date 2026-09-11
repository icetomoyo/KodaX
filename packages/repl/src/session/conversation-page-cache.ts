import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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

// v6 includes persisted operator-confirmed identity aliases in the projection.
const CACHE_VERSION = 6;
const INDEX_RECORD_BYTES = 24;
const WRITE_BATCH_BYTES = 1024 * 1024;
const MAX_CACHE_MANIFEST_BYTES = 1024 * 1024;
const MAX_CACHE_DESCRIPTOR_BYTES = 1024 * 1024;
const MAX_CACHE_CHUNK_BYTES = 4 * 1024 * 1024;
// Fixed-size, no-false-negative membership witness. A false positive only
// invalidates the optimization and falls back to canonical reconstruction.
const IDENTITY_FILTER_BYTES = 128 * 1024;
const IDENTITY_FILTER_HASHES = 7;

export interface ConversationPageCacheAdmission {
  readonly surface?: string;
  readonly profileId?: string;
}

interface ConversationCacheManifest {
  readonly version: 6;
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
}

interface ConversationCacheDescriptor {
  readonly chunkDigests: readonly string[];
  readonly boundaryId?: string;
}

interface ConversationCacheIndexRecord {
  readonly entryOffset: number;
  readonly entryLength: number;
  readonly descriptorOffset: number;
  readonly descriptorLength: number;
}

export interface ConversationPageCacheInput {
  readonly expectedRevision?: string;
  readonly end?: number;
  readonly limit: number;
  readonly maxPageBytes: number;
  readonly maxInlineEntryBytes: number;
  readonly reservedBytes: number;
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

function isSafeCacheFileName(mainPath: string, fileName: string, kind: 'data' | 'index'): boolean {
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
): Promise<void> {
  const paths = cachePaths(mainPath, manifest);
  const [data, index] = await Promise.all([fs.stat(paths.dataPath), fs.stat(paths.indexPath)]);
  if (data.size !== manifest.dataBytes || index.size !== manifest.indexBytes) {
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
  ) {
    throw new ConversationPageCacheStaleError('Conversation page descriptor is invalid');
  }
  return {
    chunkDigests: value.chunkDigests,
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

function normalizeConversationPageCacheReadError(error: unknown): Error {
  if (
    error instanceof ConversationPageCacheStaleError
    || error instanceof ConversationPageCacheCapacityError
  ) return error;
  const cacheIoErrorCodes = new Set([
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
  if (
    error instanceof SyntaxError
    || (
      isRecord(error)
      && typeof error.code === 'string'
      && cacheIoErrorCodes.has(error.code)
    )
  ) {
    return new ConversationPageCacheStaleError('Conversation page cache changed or is unavailable');
  }
  return error instanceof Error ? error : new Error(String(error));
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

export async function readConversationPageCache(
  mainPath: string,
  boundaryRevision: string,
  input: ConversationPageCacheInput,
): Promise<ConversationPageCachePage | null> {
  try {
    return await readConversationPageCacheInternal(mainPath, boundaryRevision, input);
  } catch (error: unknown) {
    throw normalizeConversationPageCacheReadError(error);
  }
}

async function readConversationPageCacheInternal(
  mainPath: string,
  boundaryRevision: string,
  input: ConversationPageCacheInput,
): Promise<ConversationPageCachePage | null> {
  throwIfAborted(input.signal);
  const manifest = await readConversationPageCacheManifest(mainPath);
  if (manifest === undefined || manifest.boundaryRevision !== boundaryRevision) return null;
  await input.authorize?.(manifest.admission);
  if (input.expectedRevision !== undefined && input.expectedRevision !== manifest.revision) {
    throw new ConversationPageCacheStaleError('Conversation history changed; request a fresh page');
  }
  await assertCacheFilesStable(mainPath, manifest);
  const end = Math.min(input.end ?? manifest.entryCount, manifest.entryCount);
  const start = Math.max(0, end - input.limit);
  const paths = cachePaths(mainPath, manifest);
  const { data, index } = await openCachePair(paths.dataPath, paths.indexPath, 'r');
  try {
    const encodedIndex = await readFully(
      index,
      start * INDEX_RECORD_BYTES,
      (end - start) * INDEX_RECORD_BYTES,
    );
    const entries: ConversationPageCacheEntry[] = [];
    let encodedBytes = input.reservedBytes + Buffer.byteLength(JSON.stringify({
      revision: manifest.revision,
      sourceRevision: manifest.sourceRevision,
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
    await assertCacheFilesStable(mainPath, manifest);
    return {
      revision: manifest.revision,
      sourceRevision: manifest.sourceRevision,
      status: manifest.status,
      issues: structuredClone(manifest.issues),
      entries,
      hasMore: firstIndex > 0,
      ...(firstIndex > 0 ? { nextEnd: firstIndex } : {}),
    };
  } finally {
    await Promise.all([data.close(), index.close()]);
  }
}

export async function readConversationPageCacheChunk(
  mainPath: string,
  boundaryRevision: string,
  input: ConversationPageCacheChunkInput,
): Promise<ConversationPageCacheChunk | null> {
  try {
    return await readConversationPageCacheChunkInternal(mainPath, boundaryRevision, input);
  } catch (error: unknown) {
    throw normalizeConversationPageCacheReadError(error);
  }
}

async function readConversationPageCacheChunkInternal(
  mainPath: string,
  boundaryRevision: string,
  input: ConversationPageCacheChunkInput,
): Promise<ConversationPageCacheChunk | null> {
  throwIfAborted(input.signal);
  const manifest = await readConversationPageCacheManifest(mainPath);
  if (manifest === undefined || manifest.boundaryRevision !== boundaryRevision) return null;
  await input.authorize?.(manifest.admission);
  if (manifest.revision !== input.revision || input.entryIndex >= manifest.entryCount) {
    throw new ConversationPageCacheStaleError('Conversation history changed; request a fresh page');
  }
  if (input.offset < 0 || input.offset % manifest.chunkBytes !== 0) {
    throw new ConversationPageCacheStaleError('Conversation entry cursor is invalid');
  }
  await assertCacheFilesStable(mainPath, manifest);
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
    await assertCacheFilesStable(mainPath, manifest);
    return {
      revision: manifest.revision,
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
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function removeGenerationFiles(
  mainPath: string,
  keepGeneration: string,
): Promise<void> {
  const directory = path.dirname(mainPath);
  const sessionId = path.basename(mainPath, path.extname(mainPath));
  const prefix = `${sessionId}${CACHE_FILE_MARKER}`;
  const keepPrefix = `${prefix}${keepGeneration}.`;
  const names = await fs.readdir(directory);
  await Promise.all(names
    .filter((name) => cacheArtifactSessionId(name) === sessionId
      && !name.startsWith(keepPrefix)
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
  try {
    const sizes = await writeCacheEntries(dataPath, indexPath, history.entries, chunkBytes);
    const entryChain = createConversationEntryChain(history.entries);
    await replaceManifest(mainPath, {
      version: CACHE_VERSION,
      sessionId: path.basename(mainPath, path.extname(mainPath)),
      generation,
      sourceRevision: history.sourceRevision,
      sourceRevisionState,
      identityFilter: createConversationPageIdentityFilter(lineage),
      boundaryRevision,
      revision: createSessionConversationHistoryRevision(history, entryChain),
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
    });
  } catch (error: unknown) {
    await Promise.all([fs.rm(dataPath, { force: true }), fs.rm(indexPath, { force: true })]);
    throw error;
  }
  try {
    await removeGenerationFiles(mainPath, generation);
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
  await replaceManifest(mainPath, {
    ...manifest,
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
  await replaceManifest(mainPath, {
    ...previous,
    sourceRevision,
    sourceRevisionState,
    identityFilter: extendConversationPageIdentityFilter(
      previous.identityFilter,
      appendedLineageEntries,
    ),
    boundaryRevision,
    revision: createSessionConversationHistoryRevision(history, entryChain),
    entryChain,
    entryCount: previous.entryCount + entries.length,
    lineageEntryCount: previous.lineageEntryCount + appendedLineageEntries.length,
    activeEntryId,
    dataBytes,
    indexBytes: previous.indexBytes + entries.length * INDEX_RECORD_BYTES,
  });
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
