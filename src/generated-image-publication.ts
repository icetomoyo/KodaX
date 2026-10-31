import { randomUUID } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { validateImageBytes, type KodaXGeneratedImage } from '@kodax-ai/llm';
import type { RuntimeArtifact, RuntimeArtifactService } from './sdk-runtime.js';

/** Trusted Main/Host selects the destination and artifact service; model outputs cannot choose paths. */
export async function publishGeneratedImages(input: {
  images: readonly KodaXGeneratedImage[]; directory: string;
  artifacts: Pick<RuntimeArtifactService, 'create' | 'delete'>; signal?: AbortSignal;
}): Promise<RuntimeArtifact[]> {
  const { directory, artifacts, signal } = input;
  const images = input.images.map(image => ({ data: image.data, mediaType: image.mediaType }));
  signal?.throwIfAborted();
  if (!path.isAbsolute(directory) || !(await lstat(directory)).isDirectory()) throw new Error('Image publication requires an existing absolute output directory.');
  if (!images.length || images.length > 10) throw new Error('Invalid generated image count.');
  const admitted: Array<{ bytes: Buffer; mediaType: string; extension: string }> = [];
  let total = 0;
  for (const image of images) {
    if (typeof image.data !== 'string' || image.data.length > Math.ceil(10 * 1024 * 1024 / 3) * 4) throw new Error('Generated image exceeds the publication limit.');
    const bytes = Buffer.from(image.data, 'base64'); total += bytes.length;
    if (bytes.toString('base64') !== image.data || total > 20 * 1024 * 1024) throw new Error('Invalid or oversized generated image data.');
    const validation = await validateImageBytes(bytes);
    signal?.throwIfAborted();
    if (validation.status !== 'valid' || validation.mediaType !== image.mediaType) throw new Error('Only decoded images with matching MIME may be published as image artifacts.');
    admitted.push({ bytes, mediaType: validation.mediaType, extension: validation.mediaType === 'image/jpeg' ? 'jpg' : validation.mediaType.slice(6) });
  }
  const written: Array<{ path: string; artifact?: RuntimeArtifact }> = [];
  try {
    for (const image of admitted) {
      signal?.throwIfAborted();
      const destination = path.join(directory, `generated-${randomUUID()}.${image.extension}`);
      const handle = await open(destination, 'wx', 0o600);
      const entry: { path: string; artifact?: RuntimeArtifact } = { path: destination }; written.push(entry);
      try { await handle.writeFile(image.bytes); } finally { await handle.close(); }
      signal?.throwIfAborted();
      entry.artifact = await artifacts.create({ kind: 'image', path: destination, mediaType: image.mediaType });
      signal?.throwIfAborted();
    }
    return written.map(entry => entry.artifact!);
  } catch (error) {
    const cleanup = await Promise.allSettled(written.map(async entry => {
      const failures = await Promise.allSettled([...(entry.artifact ? [artifacts.delete(entry.artifact.id)] : []), unlink(entry.path)]);
      const errors = failures.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason as unknown);
      if (errors.length) throw new AggregateError(errors, 'Generated image cleanup failed.');
    }));
    const failures = cleanup.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason as unknown);
    if (failures.length) throw new AggregateError([error, ...failures], 'Image publication failed and cleanup requires attention.', { cause: error });
    throw error;
  }
}
