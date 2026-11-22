import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sessionVisualMediaDirectory } from '@kodax-ai/agent/media';
import { afterEach, describe, expect, it } from 'vitest';

import { createHostBlobStore, type HostBlobLimits } from './host-blobs.js';

const LIMITS: HostBlobLimits = { blobChunkBytes: 4, maxBlobBytes: 16, blobQuotaBytes: 24 };

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function store(limits: HostBlobLimits = LIMITS) {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), 'kodax-blobs-'));
  homes.push(sessionsDir);
  return { sessionsDir, blobs: createHostBlobStore({ sessionsDir, limits }) };
}

function facts(text: string) {
  const bytes = Buffer.from(text);
  return { bytes, mediaType: 'image/png', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Writes `bytes` from `from` on, one chunk at a time, as a client does. */
async function upload(blobs: ReturnType<typeof createHostBlobStore>, sessionId: string, blobId: string, bytes: Buffer, from = 0) {
  let received = from;
  while (received < bytes.length) {
    ({ received } = await blobs.write(sessionId, blobId, received, bytes.subarray(received, received + LIMITS.blobChunkBytes)));
  }
  return blobs.commit(sessionId, blobId);
}

describe('the blobs a Host keeps for its Sessions', () => {
  it('takes an upload in chunks, keeps it with the Session, and reads it back in chunks', async () => {
    const { sessionsDir, blobs } = await store();
    const image = facts('ten bytes!');

    const { blobId, received } = await blobs.begin('session-1', image);
    expect(received).toBe(0);
    const ref = await upload(blobs, 'session-1', blobId, image.bytes);
    expect(ref).toEqual({ blobId, mediaType: 'image/png', byteLength: 10, sha256: image.sha256 });

    const { path: file, mediaType } = await blobs.file('session-1', blobId);
    expect(mediaType).toBe('image/png');
    // Inside the Session's media directory, which goes with the Session.
    expect(path.relative(sessionVisualMediaDirectory(sessionsDir, 'session-1'), file).startsWith('..')).toBe(false);

    const first = await blobs.read('session-1', blobId, 0);
    expect(first).toMatchObject({ ref, data: Buffer.from('ten ') });
    const last = await blobs.read('session-1', blobId, 8);
    expect(last.data).toEqual(Buffer.from('s!'));
  });

  it('answers bytes the Session already holds as received, and resumes an upload where it stopped', async () => {
    const { blobs } = await store();
    const image = facts('ten bytes!');
    const { blobId } = await blobs.begin('session-1', image);
    await blobs.write('session-1', blobId, 0, image.bytes.subarray(0, 4));

    // The client lost its place: beginning again says where to go on from.
    expect(await blobs.begin('session-1', image)).toEqual({ blobId, received: 4 });
    await upload(blobs, 'session-1', blobId, image.bytes, 4);

    expect(await blobs.begin('session-1', image)).toEqual({ blobId, received: 10 });
    await expect(blobs.commit('session-1', blobId)).resolves.toMatchObject({ byteLength: 10 });
    // Another Session holds its own copy.
    expect(await blobs.begin('session-2', image)).toMatchObject({ received: 0 });
  });

  it('accepts a chunk again, and refuses one that skips ahead, runs past the length or is too big', async () => {
    const { blobs } = await store();
    const image = facts('ten bytes!');
    const { blobId } = await blobs.begin('session-1', image);
    await blobs.write('session-1', blobId, 0, image.bytes.subarray(0, 4));

    expect(await blobs.write('session-1', blobId, 0, image.bytes.subarray(0, 4))).toEqual({ received: 4 });
    await expect(blobs.write('session-1', blobId, 8, image.bytes.subarray(8)))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'blob_offset_mismatch' });
    await expect(blobs.write('session-1', blobId, 8, Buffer.from('abc')))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'blob_offset_mismatch' });
    await expect(blobs.write('session-1', blobId, 4, Buffer.from('12345')))
      .rejects.toMatchObject({ kodaxCode: 'limit_exceeded', reason: 'blob_chunk_too_large' });
    await blobs.write('session-1', blobId, 4, image.bytes.subarray(4, 8));
    await expect(blobs.write('session-1', blobId, 8, Buffer.from('abc')))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'blob_too_long' });
    // An overlap writes only what the Host does not have yet.
    expect(await blobs.write('session-1', blobId, 6, image.bytes.subarray(6, 10))).toEqual({ received: 10 });
    await expect(blobs.commit('session-1', blobId)).resolves.toMatchObject({ sha256: image.sha256 });
  });

  it('ends an upload whose bytes do not match, and keeps one that is not finished', async () => {
    const { blobs } = await store();
    const image = facts('ten bytes!');
    const { blobId } = await blobs.begin('session-1', image);
    await blobs.write('session-1', blobId, 0, Buffer.from('ten '));
    await expect(blobs.commit('session-1', blobId)).rejects.toMatchObject({ kodaxCode: 'invalid_state', reason: 'blob_incomplete' });

    await expect(upload(blobs, 'session-1', blobId, Buffer.from('ten BYTES!'), 4)).rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'blob_hash_mismatch' });
    expect(await blobs.begin('session-1', image)).toEqual({ blobId, received: 0 });
  }, 10_000);

  it('refuses a blob over the size limit, and one that would pass the quota of all Sessions together', async () => {
    const { blobs } = await store();
    await expect(blobs.begin('session-1', facts('seventeen bytes!!'))).rejects.toMatchObject({
      kodaxCode: 'limit_exceeded', reason: 'blob_too_large',
    });
    const first = facts('sixteen bytes!!!');
    await upload(blobs, 'session-1', (await blobs.begin('session-1', first)).blobId, first.bytes);
    // An open upload counts at the length it declared.
    await blobs.begin('session-2', facts('four'));
    await expect(blobs.begin('session-3', facts('five!'))).rejects.toMatchObject({
      kodaxCode: 'limit_exceeded', reason: 'blob_quota_exceeded',
    });
    // Bytes already held cost nothing more.
    await expect(blobs.begin('session-1', first)).resolves.toMatchObject({ received: 16 });
  });

  it('knows nothing of a blob another Session holds, or one never uploaded', async () => {
    const { blobs } = await store();
    const image = facts('ten bytes!');
    const { blobId } = await blobs.begin('session-1', image);
    await expect(blobs.file('session-1', blobId)).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'blob_not_found' });
    const ref = await upload(blobs, 'session-1', blobId, image.bytes);

    for (const attempt of [
      () => blobs.file('session-2', ref.blobId),
      () => blobs.read('session-2', ref.blobId, 0),
      () => blobs.write('session-2', ref.blobId, 0, image.bytes.subarray(0, 4)),
      () => blobs.commit('session-1', 'b_nope'),
      () => blobs.read('session-1', '../../etc/passwd', 0),
    ]) await expect(attempt()).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'blob_not_found' });
    await expect(blobs.read('session-1', ref.blobId, 11)).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
  });

  it('removes uploads left unfinished for a day, and nothing else', async () => {
    const { sessionsDir, blobs } = await store();
    const kept = facts('kept');
    await upload(blobs, 'session-1', (await blobs.begin('session-1', kept)).blobId, kept.bytes);
    const stale = facts('stale');
    const { blobId } = await blobs.begin('session-1', stale);
    await blobs.begin('session-2', facts('fresh'));
    const directory = path.join(sessionVisualMediaDirectory(sessionsDir, 'session-1'), 'blobs');
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const name of await readdir(directory)) await utimes(path.join(directory, name), dayAgo, dayAgo);

    expect(await blobs.sweep()).toBe(1);
    expect(await blobs.begin('session-1', stale)).toEqual({ blobId, received: 0 });
    expect(await blobs.begin('session-1', kept)).toMatchObject({ received: 4 });
    expect((await stat(directory)).isDirectory()).toBe(true);
  });
});
