import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { initGitRepo } from '../tools/test-helpers.js';

const { assertNoGitInstallPrompt } = vi.hoisted(() => ({
  assertNoGitInstallPrompt: vi.fn<() => Promise<void>>(),
}));

vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/agent')>(),
  assertNoGitInstallPrompt,
}));

import { analyzeChangedScope, getRepoOverview } from './index.js';

let workspace = '';
afterEach(() => {
  assertNoGitInstallPrompt.mockReset();
  if (workspace) rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

it('keeps filesystem overview available while refusing Git-only change analysis, then recovers', async () => {
  workspace = mkdtempSync(join(tmpdir(), 'kodax-overview-no-git-'));
  initGitRepo(workspace);
  writeFileSync(join(workspace, 'package.json'), '{"name":"git-recovery"}');
  const context = { executionCwd: workspace };
  assertNoGitInstallPrompt.mockRejectedValue(new Error('Git command line tools are unavailable.'));

  expect((await getRepoOverview(context)).source).toBe('filesystem');
  await expect(analyzeChangedScope(context)).rejects.toThrow('requires a git-backed workspace');

  assertNoGitInstallPrompt.mockResolvedValue(undefined);
  expect((await getRepoOverview(context)).source).toBe('git');
  expect((await analyzeChangedScope(context)).files.map((file) => file.path)).toContain('package.json');
});
