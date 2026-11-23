import { execFileSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listWorkspace, readWorkspaceFile, workspaceGitDiff } from './workspace-files.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

/** A workspace holding the project `app`, next to a directory outside it. */
async function makeWorkspace(): Promise<{ root: string; outside: string }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'kodax-workspace-files-')));
  cleanup.push(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'app', 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  return { root, outside };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
}

describe('listWorkspace', () => {
  it('lists a directory by name, a page at a time, without what holds secrets', async () => {
    const { root } = await makeWorkspace();
    await writeFile(path.join(root, 'app', 'b.txt'), 'bee');
    await writeFile(path.join(root, 'app', 'a.txt'), 'a');
    await writeFile(path.join(root, 'app', '.env'), 'KEY=1');
    await writeFile(path.join(root, 'app', '.env.local'), 'KEY=2');
    await mkdir(path.join(root, 'app', '.ssh'));

    const first = await listWorkspace(root, 'app', { limit: 2 });
    expect(first.entries).toEqual([
      { name: 'a.txt', kind: 'file', size: 1, modifiedAt: expect.any(Number) },
      { name: 'b.txt', kind: 'file', size: 3, modifiedAt: expect.any(Number) },
    ]);
    const second = await listWorkspace(root, 'app', { limit: 2, cursor: first.nextCursor });
    expect(second.entries).toEqual([{ name: 'src', kind: 'directory', modifiedAt: expect.any(Number) }]);
    expect(second.nextCursor).toBeUndefined();
    expect((await listWorkspace(root, '.')).entries.map(entry => entry.name)).toEqual(['app']);
  });

  it('shows a link as a link and refuses to list through one that leads out', async () => {
    const { root, outside } = await makeWorkspace();
    symlinkSync(outside, path.join(root, 'app', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    expect((await listWorkspace(root, 'app')).entries).toContainEqual({ name: 'escape', kind: 'link' });
    await expect(listWorkspace(root, 'app/escape'))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'path_outside_workspace' });
  });

  it('says what is wrong with the path it was given', async () => {
    const { root } = await makeWorkspace();
    await writeFile(path.join(root, 'app', 'a.txt'), 'a');
    await mkdir(path.join(root, 'app', '.aws'));

    await expect(listWorkspace(root, 'missing')).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'path_not_found' });
    await expect(listWorkspace(root, 'app/a.txt')).rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'not_a_directory' });
    await expect(listWorkspace(root, 'app/.aws')).rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'path_refused' });
    await expect(listWorkspace(root, '../outside')).rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'path_outside_workspace' });
  });
});

describe('readWorkspaceFile', () => {
  it('reads a file in chunks and asks for a fresh read when it changed under a cursor', async () => {
    const { root } = await makeWorkspace();
    const bytes = Buffer.alloc(600 * 1024, 7);
    await writeFile(path.join(root, 'app', 'big.bin'), bytes);

    const first = await readWorkspaceFile(root, 'app/big.bin');
    expect(first).toMatchObject({ byteLength: bytes.length, modifiedAt: expect.any(Number), nextCursor: expect.any(String) });
    const second = await readWorkspaceFile(root, 'app/big.bin', first.nextCursor);
    expect(second.nextCursor).toBeUndefined();
    expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(second.data, 'base64')])).toEqual(bytes);

    await writeFile(path.join(root, 'app', 'big.bin'), 'shorter now');
    await expect(readWorkspaceFile(root, 'app/big.bin', first.nextCursor))
      .rejects.toMatchObject({ kodaxCode: 'resync_required', reason: 'file_changed' });
  });

  it('refuses what the read tool refuses a remote Agent, and what is not a file', async () => {
    const { root, outside } = await makeWorkspace();
    await writeFile(path.join(root, 'app', '.env'), 'KEY=1');
    await mkdir(path.join(root, 'app', '.ssh'));
    await writeFile(path.join(root, 'app', '.ssh', 'id'), 'key');
    symlinkSync(outside, path.join(root, 'app', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(readWorkspaceFile(root, 'app/.env')).rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'path_refused' });
    await expect(readWorkspaceFile(root, 'app/.ssh/id')).rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'path_refused' });
    await expect(readWorkspaceFile(root, 'app/escape/secret.txt'))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'path_outside_workspace' });
    await expect(readWorkspaceFile(root, 'app/src')).rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'not_a_file' });
    await expect(readWorkspaceFile(root, 'app/none.txt')).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'path_not_found' });
  });
});

describe('workspaceGitDiff', () => {
  it('shows what changed in a project, staged or not, without files that hold secrets', async () => {
    const { root } = await makeWorkspace();
    const app = path.join(root, 'app');
    git(app, 'init', '-q');
    await writeFile(path.join(app, 'src', 'main.ts'), 'one\n');
    await writeFile(path.join(app, 'notes.md'), 'a\n');
    await writeFile(path.join(app, '.env'), 'KEY=old\n');
    git(app, 'add', '-A');
    git(app, 'commit', '-q', '-m', 'start');
    await writeFile(path.join(app, 'src', 'main.ts'), 'two\n');
    await writeFile(path.join(app, 'notes.md'), 'b\n');
    await writeFile(path.join(app, '.env'), 'KEY=new\n');
    git(app, 'add', 'notes.md');

    const unstaged = await workspaceGitDiff(root, 'app', false);
    expect(unstaged.diff).toContain('src/main.ts');
    expect(unstaged.diff).toContain('+two');
    expect(unstaged.diff).not.toContain('notes.md');
    expect(unstaged.diff).not.toContain('KEY=');
    expect(unstaged.truncated).toBeUndefined();
    const staged = await workspaceGitDiff(root, 'app', true);
    expect(staged.diff).toContain('+b');
    expect(staged.diff).not.toContain('main.ts');
  });

  it('cuts a long diff short at a line and says so', async () => {
    const { root } = await makeWorkspace();
    const app = path.join(root, 'app');
    git(app, 'init', '-q');
    await writeFile(path.join(app, 'big.txt'), 'x\n');
    git(app, 'add', '-A');
    git(app, 'commit', '-q', '-m', 'start');
    await writeFile(path.join(app, 'big.txt'), `${'y'.repeat(99)}\n`.repeat(5000));

    const { diff, truncated } = await workspaceGitDiff(root, 'app', false);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(256 * 1024);
    expect(diff.endsWith('\n')).toBe(true);
  });

  it('refuses a repository whose own config names a filter, which git would run as a command', async () => {
    const { root } = await makeWorkspace();
    const app = path.join(root, 'app');
    git(app, 'init', '-q');
    git(app, 'config', 'filter.probe.clean', 'cat');

    await expect(workspaceGitDiff(root, 'app', false))
      .rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'repository_filters' });
  });

  it('says when the directory is not in a git repository', async () => {
    const { root } = await makeWorkspace();
    await expect(workspaceGitDiff(root, 'app', false))
      .rejects.toMatchObject({ kodaxCode: 'invalid_state', reason: 'not_a_git_repository' });
  });
});
