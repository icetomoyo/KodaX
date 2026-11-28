import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { scaleImageBytes, validateImageBytes, type ImageValidation } from '../image-validation.js';
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
  "[Image content omitted: this provider does not support inline images in tool results. Visual properties of this image are unverified.]";
export const UNSUPPORTED_MODEL_IMAGE_PLACEHOLDER =
  '[Image content omitted: the selected model does not support image input. Visual properties of this image are unverified.]';
export const INVALID_IMAGE_PLACEHOLDER =
  '[Image unavailable: this attachment cannot be decoded. Re-extract or replace this image; other content remains available.]';
export const IMAGE_INTEGRITY_PLACEHOLDER =
  '[Historical image unavailable: retained image SHA-256 integrity check failed.]';

export type PreparedImage = { data: string; mediaType: string; notice?: string } | { placeholder: string };

type ImageBlock = KodaXImageBlock | KodaXToolResultImageItem;
type SentImage = Extract<PreparedImage, { data: string }>;
type PreparationResult = { image: PreparedImage } | { error: unknown };
type ImageDiagnostic = { dataHash: string; mediaType: string; notice?: string } | { placeholder: string };
interface PreparedEntry {
  path: string;
  mediaType: string | undefined;
  maxSide: number;
  value: Promise<PreparationResult>;
  result?: PreparationResult;
  diagnostic?: ImageDiagnostic;
}
const preparedHistory = new AsyncLocalStorage<{
  images: WeakMap<ImageBlock, PreparedEntry>; signal?: AbortSignal; shouldPrepare?: () => boolean;
  expectedImageHash?: (filePath: string) => string | undefined;
  /** Side limit for every image of the run; `reduced` images use REDUCED_MAX_SIDE regardless. */
  maxSide: number; reduced: WeakSet<ImageBlock>;
}>();

// Anthropic rejects a side over 8000 px and DeepSeek over 8192 px. Providers that accept more scale
// large images down themselves, so this default costs no detail the model would have seen.
const PROVIDER_MAX_SIDE = 8000;
// Anthropic allows only 2000 px per side once a request carries many images; unknown providers may be
// as strict. Used after a provider rejects a request that mentions images.
const REDUCED_MAX_SIDE = 2000;
type Size = { width: number; height: number };
/** Sent and original pixel size of each serialized image, kept off the payload object. */
const imageSizes = new WeakMap<SentImage, { sent: Size; original: Size }>();

/**
 * `target\0sha256` of image payloads a provider/model has answered successfully, across runs of this
 * process. Bounded and in memory only: losing it costs at most one rejected request.
 */
const acceptedImages = new Set<string>();
const ACCEPTED_IMAGES_LIMIT = 4096;

/** Each run owns its prepared payloads. Expected hashes are immutable per path in this scope. */
export function withPreparedImageHistory<T>(run: () => Promise<T>, signal?: AbortSignal,
  shouldPrepare?: () => boolean, expectedImageHash?: (filePath: string) => string | undefined): Promise<T> {
  return preparedHistory.run({ images: new WeakMap(), signal, shouldPrepare, expectedImageHash,
    maxSide: PROVIDER_MAX_SIDE, reduced: new WeakSet() }, run);
}

function maxSideFor(block: ImageBlock): number {
  const store = preparedHistory.getStore();
  if (!store) return PROVIDER_MAX_SIDE;
  return store.reduced.has(block) ? Math.min(store.maxSide, REDUCED_MAX_SIDE) : store.maxSide;
}

function exceeds(image: PreparedImage, maxSide: number): boolean {
  const size = 'data' in image ? imageSizes.get(image)?.sent : undefined;
  return size !== undefined && Math.max(size.width, size.height) > maxSide;
}

/** Request-only scaling: the transcript and the file keep the original. A codec failure sends the image as it was. */
async function fitImage(image: PreparedImage, maxSide: number): Promise<PreparedImage> {
  const sizes = 'data' in image ? imageSizes.get(image) : undefined;
  if (!sizes || !exceeds(image, maxSide)) return image;
  const scale = maxSide / Math.max(sizes.sent.width, sizes.sent.height);
  const sent = { width: Math.max(1, Math.round(sizes.sent.width * scale)), height: Math.max(1, Math.round(sizes.sent.height * scale)) };
  const source = image as SentImage;
  const bytes = await scaleImageBytes(Buffer.from(source.data, 'base64'), source.mediaType, sent.width, sent.height);
  if (!bytes) return image;
  const { original } = sizes;
  const scaled: SentImage = { data: bytes.toString('base64'), mediaType: source.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    notice: `[Image scaled to fit provider limits: original ${original.width}x${original.height} px, sent as ${sent.width}x${sent.height} px. `
      + `Pixel coordinates in the original are ${(original.width / sent.width).toFixed(2)} times those in this image.]` };
  imageSizes.set(scaled, { sent, original });
  return scaled;
}

/** Hash of the payload this run sends for `block`, once it has been prepared as image data. */
function sentHash(block: ImageBlock): string | undefined {
  const diagnostic = getPreparedImageDiagnostic(block);
  return diagnostic && 'dataHash' in diagnostic ? diagnostic.dataHash : undefined;
}

/** Call after `target` (provider and model) answered a request carrying `messages`. */
export function markPreparedImagesAccepted(messages: readonly KodaXMessage[], target: string): void {
  for (const block of imageBlocks(messages)) {
    const hash = sentHash(block);
    if (hash === undefined) continue;
    const key = `${target}\0${hash}`;
    acceptedImages.delete(key);
    acceptedImages.add(key);
    if (acceptedImages.size > ACCEPTED_IMAGES_LIMIT) acceptedImages.delete(acceptedImages.values().next().value!);
  }
}

/** Images of `messages` sent in this run whose exact payload `target` has never answered. */
export function unacceptedPreparedImages(messages: readonly KodaXMessage[], target: string): ImageBlock[] {
  return imageBlocks(messages).filter(block => {
    const hash = sentHash(block);
    return hash !== undefined && !acceptedImages.has(`${target}\0${hash}`);
  });
}

/**
 * After `target` rejects a request, retry its images at 2000 px per side. Only images the provider has
 * never accepted are suspects, so accepted bytes and the cached prefix stay intact. When every image was
 * accepted, a rejection that mentions images points to a request-wide limit, so every image is reduced.
 * Returns false when nothing would change, so the caller does not retry.
 */
export async function reducePreparedImages(messages: readonly KodaXMessage[], target: string,
  mentionsImages: boolean): Promise<boolean> {
  const store = preparedHistory.getStore();
  if (!store) return false;
  await prepareHistoryImages(messages);
  const larger = imageBlocks(messages).filter(block => {
    const result = store.images.get(block)?.result;
    return result !== undefined && 'image' in result && exceeds(result.image, REDUCED_MAX_SIDE) && !store.reduced.has(block);
  });
  const unaccepted = new Set(unacceptedPreparedImages(messages, target));
  const suspects = larger.filter(block => unaccepted.has(block));
  for (const block of suspects) store.reduced.add(block);
  if (suspects.length) return true;
  if (!mentionsImages || !larger.length || store.maxSide <= REDUCED_MAX_SIDE) return false;
  store.maxSide = REDUCED_MAX_SIDE;
  return true;
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
  const image = imageIntegrityFailure(bytes, block.path) ?? serializeValidatedImage(bytes, block.path, block.mediaType, validation);
  const maxSide = maxSideFor(block);
  if (exceeds(image, maxSide)) { rememberEntry(history, block, fitImage(image, maxSide), maxSide); return; }
  const result = { image };
  history.set(block, { path: block.path, mediaType: block.mediaType, maxSide, result, value: Promise.resolve(result) });
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
  const pending = imageBlocks(messages).filter(block => {
    const cached = history.get(block);
    return !cached?.result || !isCurrent(cached, block);
  });
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

function imageBlocks(messages: readonly KodaXMessage[]): ImageBlock[] {
  const blocks: ImageBlock[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'image') blocks.push(block);
      if (block.type === 'tool_result' && typeof block.content !== 'string') {
        for (const item of block.content) {
          if (item.type === 'image') blocks.push(item);
        }
      }
    }
  }
  return blocks;
}

function isCurrent(entry: PreparedEntry, block: ImageBlock): boolean {
  return entry.path === block.path && entry.mediaType === block.mediaType && entry.maxSide === maxSideFor(block);
}

function prepareEntry(history: WeakMap<ImageBlock, PreparedEntry>, block: ImageBlock): PreparedEntry {
  const cached = history.get(block);
  if (cached && isCurrent(cached, block)) return cached;
  const maxSide = maxSideFor(block);
  // A lowered limit rescales the admitted payload: re-reading the file would bypass its snapshot.
  if (cached && cached.path === block.path && cached.mediaType === block.mediaType) {
    return rememberEntry(history, block, cached.value.then(result => {
      if ('error' in result) throw result.error;
      return fitImage(result.image, maxSide);
    }), maxSide);
  }
  return rememberEntry(history, block, prepareImageFile(block.path, block.mediaType, maxSide), maxSide);
}

function rememberEntry(history: WeakMap<ImageBlock, PreparedEntry>, block: ImageBlock,
  preparation: Promise<PreparedImage>, maxSide: number): PreparedEntry {
  const entry: PreparedEntry = { path: block.path, mediaType: block.mediaType, maxSide,
    // Defer I/O failures to the consuming serializer: non-vision providers and history
    // cleanup may omit this block. Never misclassify such failures as corrupt images.
    value: preparation.then(image => (entry.result = { image }), error => (entry.result = { error })) };
  history.set(block, entry);
  return entry;
}

/** Fresh preparation for admission, restore, and direct SDK callers. */
export async function prepareImageFile(filePath: string, mediaType?: string,
  maxSide = preparedHistory.getStore()?.maxSide ?? PROVIDER_MAX_SIDE): Promise<PreparedImage> {
  let bytes: Buffer;
  try { bytes = await readFile(filePath); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { placeholder: MISSING_IMAGE_PLACEHOLDER };
    throw error;
  }
  return prepareImageBytes(bytes, filePath, mediaType, maxSide);
}

async function prepareImageBytes(bytes: Buffer, filePath: string, mediaType: string | undefined, maxSide: number): Promise<PreparedImage> {
  const integrity = imageIntegrityFailure(bytes, filePath);
  if (integrity) return integrity;
  const validation = await validateImageBytes(bytes);
  return fitImage(serializeValidatedImage(bytes, filePath, mediaType, validation), maxSide);
}

function imageIntegrityFailure(bytes: Buffer, filePath: string): PreparedImage | undefined {
  const expected = preparedHistory.getStore()?.expectedImageHash?.(filePath);
  return expected !== undefined && createHash('sha256').update(bytes).digest('hex') !== expected
    ? { placeholder: IMAGE_INTEGRITY_PLACEHOLDER } : undefined;
}

function serializeValidatedImage(bytes: Buffer, filePath: string, mediaType: string | undefined,
  validation: ImageValidation): PreparedImage {
  if (validation.status === 'invalid') return { placeholder: INVALID_IMAGE_PLACEHOLDER };
  const image: SentImage = { data: bytes.toString('base64'), mediaType: validation.mediaType ?? resolveImageMediaType(filePath, mediaType),
    ...(validation.status === 'unverified' ? { notice:
      `[Local image validation unavailable (${validation.reason}); original image bytes retained.]` } : {}) };
  if (validation.status === 'valid' && validation.width && validation.height) {
    const size = { width: validation.width, height: validation.height };
    imageSizes.set(image, { sent: size, original: size });
  }
  return image;
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
