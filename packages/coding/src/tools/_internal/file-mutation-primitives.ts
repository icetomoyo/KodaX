import {
  canonicalizeAgentHomePolicyPath,
} from '../../permissions/agent-home-policy.js';

const fileMutationQueue = new Map<string, Promise<unknown>>();

/** Capture a stable canonical backup key before a concurrent sink commits. */
export function resolveFileBackupPath(filePath: string): string {
  const backupPath = canonicalizeAgentHomePolicyPath(filePath);
  if (backupPath === undefined) throw new Error(`Cannot identify backup path: ${filePath}`);
  return backupPath;
}

/** Record against a canonical key captured before the corresponding commit. */
export function recordResolvedFileBackup(
  backups: Map<string, string>,
  backupPath: string,
  content: string,
): void {
  backups.delete(backupPath);
  backups.set(backupPath, content);
}

function isWindowsPathPlatform(): boolean {
  const override = process.env.KODAX_PATH_KEY_PLATFORM;
  if (override === 'win32') return true;
  if (override === 'posix') return false;
  return process.platform === 'win32';
}

/** Normalize equivalent spellings to one process-local path queue key. */
export function normalizePathForKey(absolutePath: string): string {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) return '';
  let normalized = absolutePath.replace(/\\/g, '/');
  if (normalized.startsWith('//')) {
    normalized = '//' + normalized.slice(2).replace(/\/+/g, '/');
  } else {
    normalized = normalized.replace(/\/+/g, '/');
  }
  if (isWindowsPathPlatform()) {
    normalized = normalized.toLowerCase();
  } else if (normalized.length >= 2 && /^[A-Za-z]:/.test(normalized)) {
    normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  }
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.replace(/\/+$/g, '');
  }
  return normalized;
}

/** Serialize only mutations whose normalized path key is identical. */
export async function withPathMutation<T>(
  absolutePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = normalizePathForKey(absolutePath);
  const previous = fileMutationQueue.get(key) ?? Promise.resolve();
  const next: Promise<T> = previous.catch(() => undefined).then(fn);
  const trackable: Promise<unknown> = next.catch(() => undefined).finally(() => {
    if (fileMutationQueue.get(key) === trackable) fileMutationQueue.delete(key);
  });
  fileMutationQueue.set(key, trackable);
  return next;
}

export function _peekFileMutationQueueSizeForTests(): number {
  return fileMutationQueue.size;
}

export function _resetFileMutationQueueForTests(): void {
  fileMutationQueue.clear();
}
