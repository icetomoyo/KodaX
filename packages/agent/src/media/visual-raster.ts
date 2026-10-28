import { MAX_DIMENSION, TARGET_RAW_SIZE_BYTES } from './image-normalize.js';

export interface VisualRegion { x: number; y: number; width: number; height: number }
export const VISUAL_RASTER_PROFILE = 'png8-rgba-unoriented-no-color-transform';
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;

/** Strict profile: no animation, orientation, color conversion or precision loss. */
function sourceRaster(bytes: Buffer): { width: number; height: number } {
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Visual source exceeds the 10 MiB processing limit.');
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new Error('Visual derivation unsupported: requires a static 8-bit RGB/RGBA PNG. Full-image recall remains available.');
  }
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > MAX_SOURCE_PIXELS) throw new Error('Visual source exceeds the 40 MP processing limit.');
  if (bytes[24] !== 8 || ![2, 6].includes(bytes[25]!) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) {
    throw new Error('Visual derivation unsupported: PNG profile requires 8-bit, non-interlaced RGB/RGBA.');
  }
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('Invalid PNG chunk.');
    const length = bytes.readUInt32BE(offset);
    if (offset + 12 + length > bytes.length) throw new Error('Invalid PNG chunk length.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (['acTL', 'eXIf', 'iCCP', 'gAMA', 'cHRM', 'cICP', 'mDCv', 'cLLi', 'tRNS'].includes(type)) {
      throw new Error(`Visual derivation unsupported: PNG ${type} is outside ${VISUAL_RASTER_PROFILE}.`);
    }
    offset += 12 + length;
  }
  return { width, height };
}

const rasterWork = new WeakMap<object, Promise<void>>();

/** A cancelled waiter never releases a decoder that is still executing. */
export async function deriveVisualRaster(bytes: Buffer, view: { region?: unknown; displayLongEdge?: unknown },
  owner: object, signal?: AbortSignal) {
  const dimensions = sourceRaster(bytes);
  const region = validateRegion(view.region, dimensions);
  const longEdge = view.displayLongEdge;
  if (longEdge !== undefined && (!Number.isInteger(longEdge) || Number(longEdge) < 1 || Number(longEdge) > MAX_DIMENSION)) {
    throw new Error(`displayLongEdge must be an integer from 1 to ${MAX_DIMENSION}.`);
  }
  const scale = longEdge === undefined ? 1 : Number(longEdge) / Math.max(region.width, region.height);
  const width = Math.max(1, Math.round(region.width * scale));
  const height = Math.max(1, Math.round(region.height * scale));
  if (Math.max(width, height) > MAX_DIMENSION) throw new Error('Visual output exceeds the display limit; request a smaller region or displayLongEdge.');
  const previous = rasterWork.get(owner);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  rasterWork.set(owner, current);
  try {
    await previous;
    signal?.throwIfAborted();
    const { Jimp } = await import('jimp');
    const source = await Jimp.read(bytes);
    signal?.throwIfAborted();
    if (source.bitmap.width !== dimensions.width || source.bitmap.height !== dimensions.height) throw new Error('Visual raster dimensions mismatch.');
    const output = new Jimp({ width, height });
    for (let y = 0; y < height; y++) {
      signal?.throwIfAborted();
      const sy = region.y + Math.floor(y * region.height / height);
      for (let x = 0; x < width; x++) {
        const sx = region.x + Math.floor(x * region.width / width);
        source.bitmap.data.copy(output.bitmap.data, (y * width + x) * 4, (sy * dimensions.width + sx) * 4, (sy * dimensions.width + sx) * 4 + 4);
      }
    }
    const result = await output.getBuffer('image/png');
    signal?.throwIfAborted();
    if (result.length > TARGET_RAW_SIZE_BYTES) throw new Error('Visual output exceeds the byte limit; request a smaller displayLongEdge.');
    return { bytes: result, region, width, height, profile: VISUAL_RASTER_PROFILE, resampling: 'nearest' };
  } finally {
    release();
    if (rasterWork.get(owner) === current) rasterWork.delete(owner);
  }
}

function validateRegion(value: unknown, dimensions: { width: number; height: number }): VisualRegion {
  if (value === undefined) return { x: 0, y: 0, ...dimensions };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('region must contain integer x/y/width/height in original raster pixels.');
  const region = value as Record<string, unknown>;
  for (const key of ['x', 'y', 'width', 'height']) if (!Number.isInteger(region[key])) throw new Error('region coordinates must be integers.');
  const { x, y, width, height } = region as unknown as VisualRegion;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > dimensions.width || y + height > dimensions.height) {
    throw new Error('region is outside the original raster or has zero area.');
  }
  return { x, y, width, height };
}
