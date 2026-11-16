import fs from 'node:fs/promises';

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100] as const;

function isTransientRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

/** Atomically replaces `targetPath`; Windows refuses while a reader briefly holds it open. */
export async function replaceFileWithRetry(tempPath: string, targetPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tempPath, targetPath);
      return;
    } catch (error: unknown) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientRenameError(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
