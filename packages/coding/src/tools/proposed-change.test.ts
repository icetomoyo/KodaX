import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { proposeFileChange } from './proposed-change.js';

describe('proposeFileChange', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-proposed-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('shows what an edit would change, resolving the path against the working directory', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'one\ntwo\nthree\n');
    const change = await proposeFileChange('edit', { path: 'a.ts', old_string: 'two', new_string: 'TWO\nmore' }, dir);
    expect(change).toEqual({
      path: path.join(dir, 'a.ts'),
      added: 2,
      removed: 1,
      unified: '@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+more\n three',
    });
  });

  it('applies a batch of edits in order, as edit with edits[] and multi_edit do', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'alpha\nbeta\n');
    const input = { path: 'a.ts', edits: [{ old_string: 'alpha', new_string: 'gamma' }, { old_string: 'gamma', new_string: 'delta' }] };
    for (const tool of ['edit', 'multi_edit']) {
      expect(await proposeFileChange(tool, input, dir)).toMatchObject({ added: 1, removed: 1, unified: expect.stringContaining('+delta') });
    }
  });

  it('shows a write as the whole new file, or as the change to the file it replaces', async () => {
    expect(await proposeFileChange('write', { path: 'new.txt', content: 'x\ny\n' }, dir)).toMatchObject({ added: 2, removed: 0, unified: '@@ -0,0 +1,2 @@\n+x\n+y' });
    await fs.writeFile(path.join(dir, 'old.txt'), 'x\n');
    expect(await proposeFileChange('write', { path: path.join(dir, 'old.txt'), content: 'z\n' }, dir))
      .toMatchObject({ path: path.join(dir, 'old.txt'), added: 1, removed: 1 });
  });

  it('shows an insertion after its anchor', async () => {
    await fs.writeFile(path.join(dir, 'a.md'), '# Title\nbody\n');
    expect(await proposeFileChange('insert_after_anchor', { path: 'a.md', anchor: '# Title', content: 'new line' }, dir))
      .toMatchObject({ added: 1, removed: 0, unified: expect.stringContaining('+new line') });
  });

  it('cuts a long diff at a line and says so', async () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n');
    const change = await proposeFileChange('write', { path: 'big.txt', content: lines }, dir);
    expect(change).toMatchObject({ added: 20_000, removed: 0, truncated: true });
    expect(change!.unified.length).toBeLessThanOrEqual(64 * 1024);
    expect(change!.unified.endsWith('\n')).toBe(false);
    expect(change!.unified.split('\n').at(-1)).toMatch(/^\+line \d+$/);
  });

  it('has nothing to show when the tool would refuse or is not a file change', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'same\nsame\n');
    const cases: [string, Record<string, unknown>][] = [
      ['edit', { path: 'missing.ts', old_string: 'a', new_string: 'b' }],
      ['edit', { path: 'a.ts', old_string: 'absent', new_string: 'b' }],
      ['edit', { path: 'a.ts', old_string: 'same', new_string: 'b' }],
      ['edit', { path: 'a.ts', old_string: '', new_string: 'b' }],
      ['edit', { path: 'a.ts', old_string: 'same', new_string: 'same', replace_all: true }],
      ['multi_edit', { path: 'a.ts', edits: [] }],
      ['insert_after_anchor', { path: 'a.ts', anchor: 'same', content: 'x' }],
      ['write', { path: 'a.ts' }],
      ['write', { path: 'a.ts', content: 'same\nsame\n' }],
      ['write', { content: 'x' }],
      ['bash', { command: 'echo hi' }],
    ];
    for (const [tool, input] of cases) expect(await proposeFileChange(tool, input, dir), `${tool} ${JSON.stringify(input)}`).toBeUndefined();
  });
});
