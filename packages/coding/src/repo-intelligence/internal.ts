import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'fs/promises';
import path from 'path';

const repoIntelligenceStorageDirContext = new AsyncLocalStorage<string | undefined>();

export async function safeReadJson<T>(
  filePath: string,
  validator?: (value: unknown) => value is T,
): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (validator && !validator(parsed)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

export function debugLogRepoIntelligence(message: string, error?: unknown): void {
  if (!process.env.KODAX_DEBUG_REPO_INTELLIGENCE) {
    return;
  }
  if (error === undefined) {
    console.debug('[kodax:repo-intelligence]', message);
    return;
  }
  console.debug('[kodax:repo-intelligence]', message, error);
}

export function withRepoIntelligenceStorageDir<T>(
  storageDir: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return repoIntelligenceStorageDirContext.run(storageDir?.trim() || undefined, work);
}

export function resolveRepoIntelligenceStorageDir(
  defaultStorageDir: string,
): string {
  return repoIntelligenceStorageDirContext.getStore()?.trim()
    || process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR?.trim()
    || defaultStorageDir;
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}
