import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function resolveTempPrefix(prefix: string, parentDir?: string): string {
  return join(parentDir ?? tmpdir(), prefix);
}

export async function createTempDir(prefix = 'kodax-test-', parentDir?: string): Promise<string> {
  return mkdtemp(resolveTempPrefix(prefix, parentDir));
}

export async function removeTempDir(dir: string | undefined): Promise<void> {
  if (!dir) {
    return;
  }

  await rm(dir, { recursive: true, force: true });
}

export function createTempDirSync(prefix = 'kodax-test-', parentDir?: string): string {
  return mkdtempSync(resolveTempPrefix(prefix, parentDir));
}

export function removeTempDirSync(dir: string | undefined): void {
  if (!dir) {
    return;
  }

  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // On Windows, temp dir cleanup can fail with EPERM when handles are still open.
    // Swallow cleanup errors in test teardown — the OS will reclaim temp files later.
  }
}
