/**
 * Bytes that cross the connection: images a client sends with an input, and
 * the attachments of what a Session shows. A blob belongs to one Session and
 * goes when the Session is deleted. Both directions move it in chunks of at
 * most `limits.blobChunkBytes`, so no frame grows past the frame limit and
 * other messages keep flowing between chunks.
 */
import { z } from 'zod/v4';

import { hostCommandParams, hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { SessionRef } from './session.js';

/** Opaque. Only the Session that holds the blob knows it. */
export const BlobId = z.string().min(1).max(1024);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const MediaType = z.string().max(128).regex(/^[\w.+-]+\/[\w.+-]+$/);
const Chunk = z.base64();

/** A blob the Host holds in full. It means the same bytes on this Host only. */
export const BlobRef = z.object({
  blobId: z.string(),
  mediaType: z.string(),
  byteLength: z.int(),
  sha256: z.string(),
});

const BlobTarget = { sessionId: SessionRef, blobId: BlobId };

export const BLOB_METHODS = {
  /**
   * Opens an upload, or finds the one already open for the same bytes.
   * `received` is how many bytes the Host already has: the client writes from
   * there. Bytes the Session already holds come back with `received` equal to
   * `byteLength`, and the client only commits.
   */
  'blob.begin': {
    primitive: 'command',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      mediaType: MediaType,
      byteLength: z.int().positive(),
      sha256: Sha256,
    }),
    result: hostResult({ blobId: z.string(), received: z.int() }),
  },
  /**
   * Writes the next chunk at `offset`, which is the `received` of the last
   * answer. A chunk the Host already has is accepted again, so a write whose
   * answer was lost can be repeated.
   */
  'blob.write': {
    primitive: 'command',
    plane: 'data',
    params: hostCommandParams({ ...BlobTarget, offset: z.int().min(0), data: Chunk }),
    result: hostResult({ received: z.int() }),
  },
  /** Checks the bytes against the `sha256` the upload began with. Bytes that do not match end the upload. */
  'blob.commit': {
    primitive: 'command',
    plane: 'data',
    params: hostCommandParams(BlobTarget),
    result: hostResult({ blob: BlobRef }),
  },
  /**
   * A chunk of a blob, uploaded or attached to an item. Every chunk says the
   * whole blob's length and hash. A cursor whose blob changed fails with
   * `resync_required`, and the client reads again from the start.
   */
  'blob.read': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ ...BlobTarget, cursor: z.string().min(1).max(256).optional() }),
    result: hostResult({
      data: z.string(),
      mediaType: z.string(),
      byteLength: z.int(),
      sha256: z.string(),
      nextCursor: z.string().optional(),
    }),
  },
} as const satisfies HostMethodRegistry;

/** What an input names to send an image the Session holds. */
export const BlobAttachment = z.strictObject({
  blobId: BlobId,
  name: z.string().min(1).max(256).optional(),
});
