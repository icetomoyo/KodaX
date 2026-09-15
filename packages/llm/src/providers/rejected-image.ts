import { createHash } from 'node:crypto';

// Failure-only evidence; never serialized into logs or retained by a global request cache.
const rejectedImages = new WeakMap<object, string>();
export const getRejectedImageHash = (error: object): string | undefined => rejectedImages.get(error);
export function inheritRejectedImage<T extends Error>(source: object, target: T): T {
  const hash = rejectedImages.get(source);
  if (hash) rejectedImages.set(target, hash);
  return target;
}

function details(error: unknown, depth = 0): string {
  if (!error || typeof error !== 'object' || depth > 3) return '';
  const value = error as Record<string, unknown>;
  return [value.message, value.param].filter(item => typeof item === 'string').join(' ').slice(0, 8192)
    + details(value.error, depth + 1);
}

function imageHash(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  const block = value as Record<string, unknown>;
  const source = block.source as { type?: string; data?: string } | undefined;
  const imageUrl = block.image_url as { url?: string } | undefined;
  const data = block.type === 'image' && source?.type === 'base64' ? source.data
    : block.type === 'image_url' ? imageUrl?.url?.match(/^data:image\/[^;]+;base64,(.*)$/)?.[1] : undefined;
  if (typeof data === 'string') return createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
}

/** Resolve only an explicit upstream path against the exact serialized request that failed. */
export function recordRejectedImage(error: unknown, request: { messages: unknown }): void {
  if (!error || typeof error !== 'object') return;
  rejectedImages.delete(error);
  const text = details(error);
  if (!/image|图片/i.test(text) || !/decod|invalid|unsupported|format|解析|格式|尺寸/i.test(text)) return;
  const locations = text.match(/messages(?:\[\d+\]|\.\d+)(?:\.(?:content|source|image_url|url|data)(?:\[\d+\]|\.\d+)*)+/g) ?? [];
  const hashes = new Set<string>();
  for (const location of locations) {
    let value: unknown = request;
    let hash: string | undefined;
    for (const key of location.replace(/\[(\d+)\]/g, '.$1').split('.')) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) { hash = undefined; break; }
      value = (value as Record<string, unknown>)[key];
      hash = imageHash(value) ?? hash;
    }
    if (!hash) return;
    hashes.add(hash);
  }
  if (hashes.size === 1) rejectedImages.set(error, [...hashes][0]!);
}
