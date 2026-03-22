import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolGrep } from './grep.js';

describe('toolGrep', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('finds matches for safe regular expressions', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-grep-'));
    const filePath = join(tempDir, 'notes.txt');
    writeFileSync(filePath, 'alpha\nbeta\nGamma\n', 'utf-8');

    const result = await toolGrep({
      pattern: 'beta',
      path: filePath,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('notes.txt:2: beta');
  });

  it('rejects potentially unsafe regular expressions', async () => {
    const result = await toolGrep({
      pattern: '(a+)+$',
      path: process.cwd(),
    }, {
      backups: new Map(),
    });

    expect(result).toContain('[Tool Error] grep: Pattern rejected as potentially unsafe');
  });
});
