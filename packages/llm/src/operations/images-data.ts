import { validateImageBytesInRun } from '../providers/image-serialization.js';
import type { KodaXGeneratedImage, KodaXOperationImage } from './types.js';

export async function admitOperationImage(image: KodaXOperationImage, signal?: AbortSignal, allowUnsupported = false): Promise<KodaXGeneratedImage> {
  signal?.throwIfAborted();
  if (typeof image.data !== 'string' || !image.data || image.data.length > Math.ceil(10 * 1024 * 1024 / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('Invalid or oversized operation image base64.');
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.toString('base64') !== image.data) throw new Error('Operation image requires canonical base64.');
  if (allowUnsupported && image.mediaType === 'image/svg+xml') return { data: image.data, mediaType: image.mediaType,
    validation: { status: 'unverified', reason: 'unsupported_format' } };
  const validation = await validateImageBytesInRun(bytes);
  signal?.throwIfAborted();
  if (validation.status !== 'valid') throw new Error(`Operation image could not be admitted: ${validation.status}.`);
  if (image.mediaType && image.mediaType !== validation.mediaType) throw new Error('Operation image MIME does not match its bytes.');
  return { data: image.data, mediaType: validation.mediaType, validation };
}
export function imageDataUrl(image: KodaXGeneratedImage): string { return `data:${image.mediaType};base64,${image.data}`; }
