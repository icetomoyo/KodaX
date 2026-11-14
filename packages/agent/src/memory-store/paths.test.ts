import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAutoManagedMemoryFile } from '../memory/paths.js';
import { setAgentConfigHome } from '../runtime/agent-home.js';
import { resolveNoteRoot } from './paths.js';

let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'note-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'note-cwd-'));
  setAgentConfigHome(home);
});
afterEach(() => {
  setAgentConfigHome(undefined);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('note roots', () => {
  it('keeps the project store out of the legacy memory directory', () => {
    const project = resolveNoteRoot(cwd, 'project');
    expect(path.basename(project)).toBe('notes');
    expect(project.startsWith(path.join(home, 'projects'))).toBe(true);
    expect(project).not.toContain(`${path.sep}memory${path.sep}`);
  });

  it('puts the user store directly under the config home', () => {
    expect(resolveNoteRoot(cwd, 'user')).toBe(path.join(home, 'notes'));
  });

  it('gives different projects different roots', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'note-cwd2-'));
    try {
      expect(resolveNoteRoot(other, 'project')).not.toBe(resolveNoteRoot(cwd, 'project'));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('treats note files as governed so file tools cannot write them directly', () => {
    expect(isAutoManagedMemoryFile(path.join(resolveNoteRoot(cwd, 'project'), 'tests.md'))).toBe(true);
    expect(isAutoManagedMemoryFile(path.join(resolveNoteRoot(cwd, 'user'), 'tests.md'))).toBe(true);
  });

  it('does not treat sibling directories as governed', () => {
    const sessions = path.join(path.dirname(resolveNoteRoot(cwd, 'project')), 'sessions', 'x.md');
    expect(isAutoManagedMemoryFile(sessions)).toBe(false);
  });

  it('roots both stores in the config home it is given', () => {
    const other = path.join(home, 'runtime-home');
    expect(resolveNoteRoot(cwd, 'user', other)).toBe(path.join(other, 'notes'));
    expect(resolveNoteRoot(cwd, 'project', other)).toBe(path.join(other, path.relative(home, resolveNoteRoot(cwd, 'project'))));
  });
});

describe('a repository without a remote', () => {
  const git = (dir: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'ignore', windowsHide: true });
  };

  it('keeps one project store for its subdirectories and its linked worktrees', () => {
    git(cwd, 'init', '-q');
    fs.mkdirSync(path.join(cwd, 'packages', 'a'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'packages', 'a', 'f.txt'), 'x');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'init');
    const trees = fs.mkdtempSync(path.join(os.tmpdir(), 'note-wt-'));
    try {
      git(cwd, 'worktree', 'add', '-q', path.join(trees, 'wt'));
      const root = resolveNoteRoot(cwd, 'project');
      expect(resolveNoteRoot(path.join(cwd, 'packages', 'a'), 'project')).toBe(root);
      expect(resolveNoteRoot(path.join(trees, 'wt'), 'project')).toBe(root);
      expect(resolveNoteRoot(path.join(trees, 'wt', 'packages', 'a'), 'project')).toBe(root);
    } finally {
      fs.rmSync(trees, { recursive: true, force: true });
    }
  });

  it('still separates two repositories', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'note-cwd3-'));
    try {
      git(cwd, 'init', '-q');
      git(other, 'init', '-q');
      expect(resolveNoteRoot(other, 'project')).not.toBe(resolveNoteRoot(cwd, 'project'));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
