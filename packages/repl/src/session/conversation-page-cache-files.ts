import fs from 'node:fs/promises';
import path from 'node:path';

export const CACHE_FILE_MARKER = '.conversation-cache.';
export const CACHE_MANIFEST_SUFFIX = `${CACHE_FILE_MARKER}json`;

export class ConversationPageCacheCleanupError extends Error {
  constructor(
    readonly directory: string,
    readonly cleanupCause: unknown,
  ) {
    super(`Unable to remove recoverable Conversation page caches from ${directory}`);
    this.name = 'ConversationPageCacheCleanupError';
  }
}

export function cacheArtifactSessionId(fileName: string): string | undefined {
  const marker = fileName.lastIndexOf(CACHE_FILE_MARKER);
  if (marker <= 0) return undefined;
  const suffix = fileName.slice(marker + CACHE_FILE_MARKER.length);
  if (
    suffix !== 'json'
    && !(suffix.startsWith('json.') && suffix.endsWith('.tmp'))
    && !suffix.endsWith('.data')
    && !suffix.endsWith('.index')
    && !suffix.endsWith('.revisions')
  ) return undefined;
  return fileName.slice(0, marker);
}

export async function removeConversationPageCache(mainPath: string): Promise<void> {
  const directory = path.dirname(mainPath);
  const sessionId = path.basename(mainPath, path.extname(mainPath));
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(names
    .filter((name) => cacheArtifactSessionId(name) === sessionId)
    .map((name) => fs.rm(path.join(directory, name), { force: true })));
}

/** Remove legacy cache artifacts that are no longer discoverable through a main path. */
export async function removeConversationPageCachesInDirectory(directory: string): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new ConversationPageCacheCleanupError(directory, error);
  }
  try {
    await Promise.all(entries
      .filter((entry) => !entry.isDirectory() && cacheArtifactSessionId(entry.name) !== undefined)
      .map((entry) => fs.rm(path.join(directory, entry.name), { force: true })));
  } catch (error: unknown) {
    throw new ConversationPageCacheCleanupError(directory, error);
  }
}
