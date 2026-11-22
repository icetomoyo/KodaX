/**
 * Where a Host keeps the blobs clients upload. Each Session's blobs live in
 * `blobs/` inside its visual media directory, which the session store removes
 * with the Session, so a deleted Session leaves no blob behind. A blob is named
 * by its SHA-256: the same bytes uploaded twice to one Session are one blob,
 * and an upload is a `<sha256>.part` file next to a `<sha256>.json` that says
 * what was declared for it.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sessionVisualMediaDirectory } from '@kodax-ai/agent/media';

import { HostProtocolError } from '../host-protocol/codec.js';

export interface HostBlobLimits {
  readonly blobChunkBytes: number;
  readonly maxBlobBytes: number;
  readonly blobQuotaBytes: number;
}

/** 512 KiB chunks, as v1 reads attachments; a chunk in base64 stays well inside the frame limit. */
export const HOST_BLOB_LIMITS: HostBlobLimits = {
  blobChunkBytes: 512 * 1024,
  maxBlobBytes: 32 * 1024 * 1024,
  blobQuotaBytes: 1024 * 1024 * 1024,
};

/** An upload nobody wrote to for this long was given up on. */
const ABANDONED_UPLOAD_MS = 24 * 60 * 60 * 1000;
const BLOB_ID = /^b_([a-f0-9]{64})$/;

export interface HostBlobRef {
  readonly blobId: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface HostBlobStore {
  readonly limits: HostBlobLimits;
  begin(sessionId: string, blob: Omit<HostBlobRef, 'blobId'>): Promise<{ blobId: string; received: number }>;
  write(sessionId: string, blobId: string, offset: number, data: Buffer): Promise<{ received: number }>;
  commit(sessionId: string, blobId: string): Promise<HostBlobRef>;
  read(sessionId: string, blobId: string, offset: number): Promise<{ data: Buffer; ref: HostBlobRef }>;
  /** Where a committed blob is, for handing it to a Run. */
  file(sessionId: string, blobId: string): Promise<{ path: string; mediaType: string }>;
  /** Removes uploads nobody finished. Answers how many. */
  sweep(signal?: AbortSignal): Promise<number>;
}

interface Declared {
  readonly mediaType: string;
  readonly byteLength: number;
}

export function createHostBlobStore(options: { sessionsDir: string; limits?: HostBlobLimits }): HostBlobStore {
  const limits = options.limits ?? HOST_BLOB_LIMITS;
  const mediaRoot = path.join(options.sessionsDir, '.media');
  // Writes to one blob of one Session go one at a time.
  const queues = new Map<string, Promise<unknown>>();

  const locate = (sessionId: string, sha256: string) => {
    const directory = path.join(sessionVisualMediaDirectory(options.sessionsDir, sessionId), 'blobs');
    const base = path.join(directory, sha256);
    return { directory, file: base, part: `${base}.part`, meta: `${base}.json` };
  };

  const serial = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(key) ?? Promise.resolve()).then(work, work);
    const settled = run.then(() => undefined, () => undefined);
    queues.set(key, settled);
    void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return run;
  };

  const committed = async (sessionId: string, blobId: string): Promise<HostBlobRef & { path: string }> => {
    const sha256 = blobSha(blobId);
    const where = locate(sessionId, sha256);
    const [size, declared] = await Promise.all([sizeOf(where.file), readDeclared(where.meta)]);
    if (size === undefined || declared === undefined) throw blobNotFound();
    return { blobId, mediaType: declared.mediaType, byteLength: size, sha256, path: where.file };
  };

  return {
    limits,
    async begin(sessionId, blob) {
      if (blob.byteLength > limits.maxBlobBytes) {
        throw new HostProtocolError('limit_exceeded', `A blob may hold at most ${limits.maxBlobBytes} bytes.`, { reason: 'blob_too_large' });
      }
      const blobId = `b_${blob.sha256}`;
      const where = locate(sessionId, blob.sha256);
      return serial(where.file, async () => {
        const held = await sizeOf(where.file);
        if (held !== undefined) return { blobId, received: held };
        const received = await sizeOf(where.part);
        if (received === undefined && await usage(mediaRoot) + blob.byteLength > limits.blobQuotaBytes) {
          throw new HostProtocolError('limit_exceeded', 'The Host has no room for another blob.', { reason: 'blob_quota_exceeded' });
        }
        await mkdir(where.directory, { recursive: true });
        await writeFile(where.meta, JSON.stringify({ mediaType: blob.mediaType, byteLength: blob.byteLength } satisfies Declared));
        if (received === undefined) await writeFile(where.part, '');
        return { blobId, received: received ?? 0 };
      });
    },

    async write(sessionId, blobId, offset, data) {
      if (data.length > limits.blobChunkBytes) {
        throw new HostProtocolError('limit_exceeded', `A chunk may hold at most ${limits.blobChunkBytes} bytes.`, { reason: 'blob_chunk_too_large' });
      }
      const where = locate(sessionId, blobSha(blobId));
      return serial(where.file, async () => {
        const held = await sizeOf(where.file);
        if (held !== undefined) return { received: held };
        const [received, declared] = await Promise.all([sizeOf(where.part), readDeclared(where.meta)]);
        if (received === undefined || declared === undefined) throw blobNotFound();
        if (offset > received) {
          throw new HostProtocolError('conflict', `The Host has ${received} bytes of this blob; write from there.`, { reason: 'blob_offset_mismatch' });
        }
        const end = offset + data.length;
        if (end > declared.byteLength) {
          throw new HostProtocolError('invalid_params', 'The chunk runs past the length the upload declared.', { reason: 'blob_too_long' });
        }
        // What overlaps bytes the Host has is taken to be them again; the commit checks the hash of all of it.
        if (end > received) await appendFile(where.part, data.subarray(received - offset));
        return { received: Math.max(received, end) };
      });
    },

    async commit(sessionId, blobId) {
      const sha256 = blobSha(blobId);
      const where = locate(sessionId, sha256);
      return serial(where.file, async () => {
        if (await sizeOf(where.file) === undefined) {
          const [received, declared] = await Promise.all([sizeOf(where.part), readDeclared(where.meta)]);
          if (received === undefined || declared === undefined) throw blobNotFound();
          if (received !== declared.byteLength) {
            throw new HostProtocolError('invalid_state', `The Host has ${received} of ${declared.byteLength} bytes.`, { reason: 'blob_incomplete' });
          }
          if (await hashOf(where.part) !== sha256) {
            await Promise.all([rm(where.part, { force: true }), rm(where.meta, { force: true })]);
            throw new HostProtocolError('invalid_params', 'The bytes do not match the sha256 the upload began with.', {
              reason: 'blob_hash_mismatch',
            });
          }
          await rename(where.part, where.file);
        }
        const { path: _path, ...ref } = await committed(sessionId, blobId);
        return ref;
      });
    },

    async read(sessionId, blobId, offset) {
      const { path: file, ...ref } = await committed(sessionId, blobId);
      if (offset >= ref.byteLength) {
        throw new HostProtocolError('invalid_params', 'The cursor is past the end of the blob.', { reason: 'cursor_out_of_range' });
      }
      const data = Buffer.alloc(Math.min(limits.blobChunkBytes, ref.byteLength - offset));
      const handle = await open(file, 'r');
      try {
        await handle.read(data, 0, data.length, offset);
      } finally {
        await handle.close();
      }
      return { data, ref };
    },

    async file(sessionId, blobId) {
      const { path: file, mediaType } = await committed(sessionId, blobId);
      return { path: file, mediaType };
    },

    sweep: signal => sweepAbandoned(mediaRoot, Date.now() - ABANDONED_UPLOAD_MS, signal),
  };
}

function blobSha(blobId: string): string {
  const match = BLOB_ID.exec(blobId);
  if (match === null) throw blobNotFound();
  return match[1]!;
}

function blobNotFound(): HostProtocolError {
  return new HostProtocolError('not_found', 'The Session holds no such blob.', { reason: 'blob_not_found' });
}

async function sizeOf(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).size;
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readDeclared(file: string): Promise<Declared | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Declared;
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function hashOf(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** The `blobs/` directory of every Session. */
async function blobDirectories(mediaRoot: string): Promise<string[]> {
  let owners: string[];
  try {
    owners = await readdir(mediaRoot);
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
  return owners.map(owner => path.join(mediaRoot, owner, 'blobs'));
}

async function namesIn(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Bytes held by every Session: committed blobs as they are, open uploads at the length they declared. */
async function usage(mediaRoot: string): Promise<number> {
  let total = 0;
  for (const directory of await blobDirectories(mediaRoot)) {
    for (const name of await namesIn(directory)) {
      if (/^[a-f0-9]{64}$/.test(name)) total += await sizeOf(path.join(directory, name)) ?? 0;
      else if (name.endsWith('.part')) total += (await readDeclared(path.join(directory, `${name.slice(0, -5)}.json`)))?.byteLength ?? 0;
    }
  }
  return total;
}

async function sweepAbandoned(mediaRoot: string, before: number, signal?: AbortSignal): Promise<number> {
  let removed = 0;
  for (const directory of await blobDirectories(mediaRoot)) {
    for (const name of await namesIn(directory)) {
      signal?.throwIfAborted();
      if (!name.endsWith('.part')) continue;
      const part = path.join(directory, name);
      const modified = await stat(part).then(info => info.mtimeMs, (error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (modified === undefined || modified >= before) continue;
      await Promise.all([rm(part, { force: true }), rm(path.join(directory, `${name.slice(0, -5)}.json`), { force: true })]);
      removed += 1;
    }
  }
  return removed;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
