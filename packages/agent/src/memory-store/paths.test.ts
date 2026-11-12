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
});
