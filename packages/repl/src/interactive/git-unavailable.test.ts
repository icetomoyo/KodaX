import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const { assertNoGitInstallPrompt } = vi.hoisted(() => ({
  assertNoGitInstallPrompt: vi.fn<() => Promise<void>>(),
}));

vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/agent')>(),
  assertNoGitInstallPrompt,
}));

vi.mock('@kodax-ai/agent/runtime/macos-git', () => ({ assertNoGitInstallPrompt }));

import { getGitRoot } from '../common/utils.js';
import { reviewCommand } from '../commands/review-command.js';
import { getRecentWorkingSetFiles } from './recent-files.js';
import { inspectWorkspaceRuntime } from './workspace-runtime.js';

let workspace = '';
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'kodax-repl-no-git-'));
  const options = { cwd: workspace, stdio: 'ignore' as const };
  execFileSync('git', ['init'], options);
  writeFileSync(join(workspace, 'tracked.txt'), 'committed\n');
  execFileSync('git', ['add', '.'], options);
  execFileSync('git', ['-c', 'user.name=KodaX Test', '-c', 'user.email=kodax-test@example.com', 'commit', '-m', 'fixture'], options);
  writeFileSync(join(workspace, 'untracked.txt'), 'new\n');
  assertNoGitInstallPrompt.mockRejectedValue(new Error('Git command line tools are unavailable.'));
});

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

it('omits Git root metadata when Git would trigger an installation prompt', async () => {
  expect(await getGitRoot(workspace)).toBeNull();
});

it('preserves the execution directory when Git runtime inspection is unavailable', async () => {
  expect(await inspectWorkspaceRuntime({ cwd: workspace })).toMatchObject({
    executionCwd: workspace.replace(/\\/g, '/'),
    workspaceRoot: undefined,
    branch: undefined,
  });
});

it('lets the file picker fall back to ordinary files when Git is unavailable', async () => {
  expect(await getRecentWorkingSetFiles(workspace)).toEqual([]);
});

it('reports unavailable Git instead of claiming that a review has no changes', async () => {
  const context = {
    messages: [], sessionId: 'git-unavailable', title: '', gitRoot: workspace,
    createdAt: '', lastAccessed: '',
  };
  expect(await reviewCommand.handler([], context, {} as never, {} as never)).toEqual({
    success: false,
    message: '/review: git failed - Git command line tools are unavailable.',
  });
});
