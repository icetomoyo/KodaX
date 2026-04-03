import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveRepoIntelligenceStorageDir,
  withRepoIntelligenceStorageDir,
} from './internal.js';

describe('repo-intelligence internal storage overrides', () => {
  const originalStorageDir = process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR;

  afterEach(() => {
    if (originalStorageDir === undefined) {
      delete process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR;
    } else {
      process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR = originalStorageDir;
    }
  });

  it('keeps concurrent async storage overrides isolated', async () => {
    delete process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR;

    const [left, right] = await Promise.all([
      withRepoIntelligenceStorageDir('.repointel-a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return resolveRepoIntelligenceStorageDir('.agent/repo-intelligence');
      }),
      withRepoIntelligenceStorageDir('.repointel-b', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return resolveRepoIntelligenceStorageDir('.agent/repo-intelligence');
      }),
    ]);

    expect(left).toBe('.repointel-a');
    expect(right).toBe('.repointel-b');
  });

  it('falls back to env and then default when no async override is active', () => {
    process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR = '.repointel-env';
    expect(resolveRepoIntelligenceStorageDir('.agent/repo-intelligence')).toBe('.repointel-env');

    delete process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR;
    expect(resolveRepoIntelligenceStorageDir('.agent/repo-intelligence')).toBe('.agent/repo-intelligence');
  });
});
