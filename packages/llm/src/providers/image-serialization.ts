import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { validateImageBytes, type ImageValidation } from '../image-validation.js';
import type { KodaXImageBlock, KodaXMessage, KodaXToolResultImageItem } from '../types.js';

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export const MISSING_IMAGE_PLACEHOLDER =
  "[Historical image unavailable: the local attachment file is missing.]";
export const UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER =
  "[Image content omitted: this provider does not support inline images in tool results.]";
export const INVALID_IMAGE_PLACEHOLDER =
  '[Image unavailable: this attachment cannot be decoded. Re-extract or replace this image; other content remains available.]';

export type PreparedImage = { data: string; mediaType: string; notice?: string } | { placeholder: string };

type ImageBlock = KodaXImageBlock | KodaXToolResultImageItem;
type PreparationResult = { image: PreparedImage } | { error: unknown };
type ImageDiagnostic = { dataHash: string; mediaType: string; notice?: string } | { placeholder: string };
interface PreparedEntry {
  path: string;
  mediaType: string | undefined;
  value: Promise<PreparationResult>;
  result?: PreparationResult;
  diagnostic?: ImageDiagnostic;
}
const preparedHistory = new AsyncLocalStorage<{
  images: WeakMap<ImageBlock, PreparedEntry>; signal?: AbortSignal; shouldPrepare?: () => boolean;
}>();

/** Each run owns its prepared payloads; nested/parallel runs cannot contaminate one another. */
export function withPreparedImageHistory<T>(run: () => Promise<T>, signal?: AbortSignal,
  shouldPrepare?: () => boolean): Promise<T> {
  return preparedHistory.run({ images: new WeakMap(), signal, shouldPrepare }, run);
}

/** Entry adapters must also be cancellable while their first validation is in progress. */
export function validateImageBytesInRun(bytes: Buffer): ReturnType<typeof validateImageBytes> {
  preparedHistory.getStore()?.signal?.throwIfAborted();
  return waitForPreparation(validateImageBytes(bytes));
}

/** Tool adapters already own these bytes: snapshot them before publishing the result. */
export function prepareValidatedImageBlock(block: ImageBlock, bytes: Buffer, validation: ImageValidation): void {
  if (preparedHistory.getStore()?.shouldPrepare?.() === false) return;
  const history = preparedHistory.getStore()?.images;
  if (!history) return;
  preparedHistory.getStore()?.signal?.throwIfAborted();
  const result = { image: serializeValidatedImage(bytes, block.path, block.mediaType, validation) };
  history.set(block, { path: block.path, mediaType: block.mediaType, result, value: Promise.resolve(result) });
}

/** Synchronous diagnostics use the actual admitted payload, with no repeated filesystem I/O. */
export function getPreparedImageDiagnostic(block: ImageBlock): ImageDiagnostic | undefined {
  const entry = preparedHistory.getStore()?.images.get(block);
  if (!entry || entry.path !== block.path || entry.mediaType !== block.mediaType) return undefined;
  if (!entry.result || !('image' in entry.result)) return undefined;
  const image = entry.result.image;
  entry.diagnostic ??= 'placeholder' in image ? image : {
    dataHash: createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex'),
    mediaType: image.mediaType, ...(image.notice ? { notice: image.notice } : {}),
  };
  return entry.diagnostic;
}

/** Read-only failure inspection uses the bytes actually admitted, not a changed source path. */
export async function inspectPreparedImage(block: ImageBlock): Promise<{
  validation: ImageValidation; dataHash: string;
} | { placeholder: string }> {
  const image = await prepareImageBlock(block);
  if ('placeholder' in image) return image;
  const bytes = Buffer.from(image.data, 'base64');
  return { validation: await validateImageBytesInRun(bytes), dataHash: createHash('sha256').update(bytes).digest('hex') };
}

/** Admit new/restored blocks without modifying the canonical transcript or its attachment files. */
export function prepareHistoryImages(messages: readonly KodaXMessage[]): Promise<void> | undefined {
  if (preparedHistory.getStore()?.shouldPrepare?.() === false) return;
  const history = preparedHistory.getStore()?.images;
  if (!history) return;
  const pending: ImageBlock[] = [];
  const collect = (block: ImageBlock): void => {
    const cached = history.get(block);
    if (!cached?.result || cached.path !== block.path || cached.mediaType !== block.mediaType) pending.push(block);
  };
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'image') collect(block);
      if (block.type === 'tool_result' && typeof block.content !== 'string') {
        for (const item of block.content) {
          if (item.type === 'image') collect(item);
        }
      }
    }
  }
  // No new images means no asynchronous boundary; preserve text-only scheduling.
  if (!pending.length) return;
  return (async () => {
    for (const block of pending) {
      preparedHistory.getStore()?.signal?.throwIfAborted();
      await waitForPreparation(prepareEntry(history, block).value);
    }
  })();
}

/** Native serializers reuse admitted bytes. Unmanaged SDK callers retain fresh-file semantics. */
export async function prepareImageBlock(block: ImageBlock): Promise<PreparedImage> {
  const history = preparedHistory.getStore()?.images;
  if (!history) return prepareImageFile(block.path, block.mediaType);
  preparedHistory.getStore()?.signal?.throwIfAborted();
  const entry = prepareEntry(history, block);
  const result = await waitForPreparation(entry.value);
  if ('image' in result) return result.image;
  if (history.get(block) === entry) history.delete(block);
  throw result.error;
}

function waitForPreparation<T>(value: Promise<T>): Promise<T> {
  const signal = preparedHistory.getStore()?.signal;
  if (!signal) return value;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    // The shared, bounded decoder may finish for other consumers; the cancelled run stops now.
    void value.then(result => { signal.removeEventListener('abort', abort); resolve(result); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function prepareEntry(history: WeakMap<ImageBlock, PreparedEntry>, block: ImageBlock): PreparedEntry {
  const cached = history.get(block);
  if (cached && cached.path === block.path && cached.mediaType === block.mediaType) return cached;
  return rememberEntry(history, block, prepareImageFile(block.path, block.mediaType));
}

function rememberEntry(history: WeakMap<ImageBlock, PreparedEntry>, block: ImageBlock,
  preparation: Promise<PreparedImage>): PreparedEntry {
  const entry: PreparedEntry = { path: block.path, mediaType: block.mediaType,
    // Defer I/O failures to the consuming serializer: non-vision providers and history
    // cleanup may omit this block. Never misclassify such failures as corrupt images.
    value: preparation.then(image => (entry.result = { image }), error => (entry.result = { error })) };
  history.set(block, entry);
  return entry;
}

/** Fresh preparation for admission, restore, and direct SDK callers. */
export async function prepareImageFile(filePath: string, mediaType?: string): Promise<PreparedImage> {
  let bytes: Buffer;
  try { bytes = await readFile(filePath); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { placeholder: MISSING_IMAGE_PLACEHOLDER };
    throw error;
  }
  return prepareImageBytes(bytes, filePath, mediaType);
}

async function prepareImageBytes(bytes: Buffer, filePath: string, mediaType?: string): Promise<PreparedImage> {
  const validation = await validateImageBytes(bytes);
  return serializeValidatedImage(bytes, filePath, mediaType, validation);
}

function serializeValidatedImage(bytes: Buffer, filePath: string, mediaType: string | undefined,
  validation: ImageValidation): PreparedImage {
  if (validation.status === 'invalid') return { placeholder: INVALID_IMAGE_PLACEHOLDER };
  return { data: bytes.toString('base64'), mediaType: validation.mediaType ?? resolveImageMediaType(filePath, mediaType),
    ...(validation.status === 'unverified' ? { notice:
      `[Local image validation unavailable (${validation.reason}); original image bytes retained.]` } : {}) };
}

export async function isImageFileMissing(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

export function resolveImageMediaType(
  filePath: string,
  fallback?: string,
): string {
  return (
    fallback ??
    IMAGE_MEDIA_TYPES[path.extname(filePath).toLowerCase()] ??
    "image/png"
  );
}

export async function readImageFileAsBase64(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return content.toString("base64");
}

export async function readImageFileAsBase64IfAvailable(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await readImageFileAsBase64(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

export async function buildImageDataUrl(
  filePath: string,
  mediaType?: string,
): Promise<string> {
  const resolvedMediaType = resolveImageMediaType(filePath, mediaType);
  const encoded = await readImageFileAsBase64(filePath);
  return `data:${resolvedMediaType};base64,${encoded}`;
}

export async function buildImageDataUrlIfAvailable(
  filePath: string,
  mediaType?: string,
): Promise<string | undefined> {
  const encoded = await readImageFileAsBase64IfAvailable(filePath);
  if (encoded === undefined) return undefined;
  return `data:${resolveImageMediaType(filePath, mediaType)};base64,${encoded}`;
}
