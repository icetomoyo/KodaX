import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KodaXImageBlock } from '@kodax-ai/llm';
import type { KodaXImageMediaType } from './types.js';

export const PASTE_TMP_DIR_ENV = 'KODAX_PASTE_TMP_DIR';
export const PASTE_TMP_TTL_MS = 24 * 60 * 60 * 1000;

export interface PersistImageAsBlockOptions {
  readonly directory?: string;
  readonly fileNamePrefix?: string;
}

function resolvePasteTmpDir(): string {
  return process.env[PASTE_TMP_DIR_ENV] ?? path.join(tmpdir(), 'kodax-paste');
}

function sanitizeFileNamePrefix(prefix: string | undefined): string {
  const normalized = prefix?.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized && normalized.length > 0 ? normalized : 'paste';
}

export async function persistImageAsBlock(
  image: { readonly buffer: Buffer; readonly mediaType: KodaXImageMediaType },
  options: PersistImageAsBlockOptions = {},
): Promise<KodaXImageBlock> {
  const dir = options.directory ?? resolvePasteTmpDir();
  await mkdir(dir, { recursive: true });
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[image.mediaType];
  const hash = createHash('sha256').update(image.buffer).digest('hex').slice(0, 16);
  const filename = `${sanitizeFileNamePrefix(options.fileNamePrefix)}-${hash}${ext}`;
  const fullPath = path.join(dir, filename);
  await writeFile(fullPath, image.buffer);
  return {
    type: 'image',
    path: fullPath,
    mediaType: image.mediaType,
  };
}

export async function prunePasteTmpDir(now: number = Date.now()): Promise<number> {
  const dir = resolvePasteTmpDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    void error;
    // Missing or unreadable temp directory is equivalent to "nothing to prune".
    return 0;
  }

  const cutoff = now - PASTE_TMP_TTL_MS;
  let deleted = 0;
  await Promise.all(
    entries
      // Match any KodaX-written paste file — `<sanitized-prefix>-<16-hex>.png/jpg`
      // — not just the default `paste-` prefix. Callers can supply a custom
      // fileNamePrefix (e.g. a Partner surface uses 'partner-clip'), and those
      // files would otherwise never be pruned. The `-<16 hex>.<ext>` shape keeps
      // this from touching unrelated files that may share the tmp directory.
      .filter((name) => /-[0-9a-f]{16}\.(?:png|jpg)$/.test(name))
      .map(async (name) => {
        const fullPath = path.join(dir, name);
        try {
          const entry = await stat(fullPath);
          if (entry.mtimeMs < cutoff) {
            await unlink(fullPath);
            deleted += 1;
          }
        } catch (error) {
          void error;
          // Ignore races with other KodaX instances pruning the same temp file.
        }
      }),
  );
  return deleted;
}
