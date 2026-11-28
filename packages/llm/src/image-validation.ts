import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
export type ImageValidation =
  // Pixel size is present when this module decoded the image; callers that build a verdict may omit it.
  | { status: 'valid'; mediaType: ImageMediaType; width?: number; height?: number }
  | { status: 'invalid' }
  | { status: 'unverified'; reason: 'unsupported_format' | 'decoder_unavailable' | 'processing_limit'; mediaType?: ImageMediaType };

const MEDIA_TYPES: Record<string, ImageMediaType> = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
// Local processing bounds, not provider upload limits. Exceeding them is NOT proof of corruption.
const MAX_DECODE_BYTES = 10 * 1024 * 1024;
const MAX_DECODE_PIXELS = 40_000_000;
const MAX_DECODE_MS = 10_000;
const CACHE_ENTRIES = 256;
const cache = new Map<string, ImageValidation | Promise<ImageValidation>>();
let decoderTail: Promise<void> | undefined;
// Provider modules initialize before run/credential scopes. Capture that context for local
// codec work only: lazy-import promises must not retain a caller; its waiting stays outside.
const runLocalValidation = AsyncLocalStorage.snapshot();

// A separate worker contains decoder failures and avoids blocking the host/UI event loop.
// Its module path is owned by installation/build tooling, never by the input image.
const DECODE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
let photon;
try { photon = require(workerData.modulePath); }
catch { parentPort.postMessage('unavailable'); }
if (photon) {
  let image;
  try {
    image = photon.PhotonImage.new_from_byteslice(workerData.bytes);
    parentPort.postMessage(image.get_width() > 0 && image.get_height() > 0 ? 'valid' : 'invalid');
  } catch (error) {
    parentPort.postMessage(/memory|allocation|limit/i.test(String(error)) ? 'unavailable' : 'invalid');
  } finally { if (image) image.free(); }
}
`;

// Scales one already validated image. Any failure answers null, and the caller keeps the original bytes.
const SCALE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
let image, scaled;
try {
  const photon = require(workerData.modulePath);
  image = photon.PhotonImage.new_from_byteslice(workerData.bytes);
  scaled = photon.resize(image, workerData.width, workerData.height, photon.SamplingFilter.Lanczos3);
  const out = workerData.jpeg ? scaled.get_bytes_jpeg(90) : scaled.get_bytes();
  parentPort.postMessage(out, [out.buffer]);
} catch { parentPort.postMessage(null); }
finally { if (scaled) scaled.free(); if (image) image.free(); }
`;
const MAX_SCALE_MS = 30_000;

function codecPath(): string | undefined {
  const sidecar = path.join(path.dirname(process.execPath), 'image-codec', 'photon_rs.js');
  if (process.env.KODAX_BUNDLED === 'true') return existsSync(sidecar) ? sidecar : undefined;
  try { return createRequire(import.meta.url).resolve('@silvia-odwyer/photon-node'); }
  catch {
    // Bun standalone artifacts ship the unchanged codec JS + WASM beside the executable.
    return existsSync(sidecar) ? sidecar : undefined;
  }
}

/** One codec worker at a time bounds memory; queueing time counts against the caller's deadline. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = (decoderTail ?? Promise.resolve()).then(task);
  const tail = run.then(() => undefined, () => undefined);
  decoderTail = tail;
  void tail.then(() => { if (decoderTail === tail) decoderTail = undefined; });
  return run;
}

/** Re-encodes a valid image at the given size: JPEG stays JPEG, every other format becomes PNG. */
export function scaleImageBytes(bytes: Buffer, mediaType: string, width: number, height: number): Promise<Buffer | undefined> {
  const deadline = performance.now() + MAX_SCALE_MS;
  return runLocalValidation(() => serial(() => new Promise<Buffer | undefined>((resolve) => {
    const modulePath = codecPath();
    const remainingMs = deadline - performance.now();
    if (!modulePath || remainingMs <= 0) { resolve(undefined); return; }
    let worker: Worker;
    try { worker = new Worker(SCALE_WORKER, { eval: true, workerData: { modulePath, bytes: Buffer.from(bytes), width, height,
      jpeg: mediaType === 'image/jpeg' }, resourceLimits: { maxOldGenerationSizeMb: 128 } }); }
    catch { resolve(undefined); return; }
    let settled = false;
    const finish = (result: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const scaled = result instanceof Uint8Array && result.length ? Buffer.from(result) : undefined;
      void worker.terminate().then(() => resolve(scaled), () => resolve(scaled));
    };
    const timer = setTimeout(() => finish(null), remainingMs);
    worker.once('message', finish);
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
  })));
}

async function decode(bytes: Buffer, mediaType: ImageMediaType, remainingMs: number,
  size: { width: number; height: number }): Promise<ImageValidation> {
  if (remainingMs <= 0) return { status: 'unverified', reason: 'processing_limit', mediaType };
  const modulePath = codecPath();
  if (!modulePath) return { status: 'unverified', reason: 'decoder_unavailable', mediaType };
  return new Promise((resolve) => {
    let worker: Worker;
    try { worker = new Worker(DECODE_WORKER, { eval: true, workerData: { modulePath, bytes },
      resourceLimits: { maxOldGenerationSizeMb: 128 } }); }
    catch { resolve({ status: 'unverified', reason: 'decoder_unavailable', mediaType }); return; }
    let settled = false;
    const finish = (status: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Do not release the serial decoder slot until the worker has actually exited.
      void worker.terminate().then(() => resolve(status === 'valid' ? { status, mediaType, ...size }
        : status === 'invalid' ? { status } : { status: 'unverified', reason: 'decoder_unavailable', mediaType }),
      () => resolve({ status: 'unverified', reason: 'decoder_unavailable', mediaType }));
    };
    const timer = setTimeout(() => finish('unavailable'), remainingMs);
    worker.once('message', finish);
    worker.once('error', () => finish('unavailable'));
    worker.once('exit', () => finish('unavailable'));
  });
}

async function inspect(bytes: Buffer): Promise<ImageValidation> {
  const deadline = performance.now() + MAX_DECODE_MS;
  if (!bytes.length) return { status: 'invalid' };
  if (bytes.length > MAX_DECODE_BYTES) return { status: 'unverified', reason: 'processing_limit' };
  let imageSize: typeof import('image-size').imageSize;
  try { ({ imageSize } = await import('image-size')); }
  catch { return { status: 'unverified', reason: 'decoder_unavailable' }; }
  let dimensions: ReturnType<typeof imageSize>;
  try { dimensions = imageSize(bytes); }
  catch { return { status: 'invalid' }; }
  const mediaType = MEDIA_TYPES[dimensions.type ?? ''];
  if (!mediaType) return { status: 'unverified', reason: 'unsupported_format' };
  if (!dimensions.width || !dimensions.height) return { status: 'invalid' };
  if (dimensions.width * dimensions.height > MAX_DECODE_PIXELS) {
    return { status: 'unverified', reason: 'processing_limit', mediaType };
  }
  // Queueing consumes the same budget: stalled inputs cannot each add another full timeout.
  const size = { width: dimensions.width, height: dimensions.height };
  return serial(() => decode(bytes, mediaType, deadline - performance.now(), size));
}

/** Validate actual bytes without converting valid images or changing their metadata/animation. */
export async function validateImageBytes(bytes: Buffer): Promise<ImageValidation> {
  if (bytes.length > MAX_DECODE_BYTES) return { status: 'unverified', reason: 'processing_limit' };
  const key = createHash('sha256').update(bytes).digest('hex');
  let result = cache.get(key);
  if (!result) {
    result = runLocalValidation(() => inspect(Buffer.from(bytes)));
    cache.set(key, result);
    if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  try {
    const validation = await result;
    if (cache.get(key) === result) {
      // Settled promises retain caller AsyncLocalStorage contexts; cache only the verdict.
      if (validation.status === 'unverified') cache.delete(key);
      else cache.set(key, validation);
    }
    return validation;
  } catch (error) {
    if (cache.get(key) === result) cache.delete(key);
    throw error;
  }
}
