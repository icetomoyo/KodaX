import { readFile } from 'node:fs/promises';
import path from 'node:path';

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function resolveImageMediaType(
  filePath: string,
  fallback?: string,
): string {
  return fallback ?? IMAGE_MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? 'image/png';
}

export async function readImageFileAsBase64(
  filePath: string,
): Promise<string> {
  const content = await readFile(filePath);
  return content.toString('base64');
}

export async function buildImageDataUrl(
  filePath: string,
  mediaType?: string,
): Promise<string> {
  const resolvedMediaType = resolveImageMediaType(filePath, mediaType);
  const encoded = await readImageFileAsBase64(filePath);
  return `data:${resolvedMediaType};base64,${encoded}`;
}
