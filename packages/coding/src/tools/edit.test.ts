import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KodaXToolExecutionContext } from '../types.js';
import { inspectEditFailure, parseEditToolError, toolEdit } from './edit.js';
import { toolInsertAfterAnchor } from './insert-after-anchor.js';

describe('edit tool', () => {
  let tempDir = '';
  let ctx: KodaXToolExecutionContext;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-edit-'));
    ctx = {
      backups: new Map(),
      executionCwd: tempDir,
    };
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('replaces unique exact matches', async () => {
    const filePath = path.join(tempDir, 'notes.md');
    await fs.writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8');

    const result = await toolEdit({
      path: filePath,
      old_string: 'beta',
      new_string: 'delta',
    }, ctx);

    expect(result).toContain('File edited:');
    await expect(fs.readFile(filePath, 'utf8')).resolves.toContain('delta');
  });

  it('matches safely across CRLF, trailing space, blank-line, and indentation differences', async () => {
    const filePath = path.join(tempDir, 'doc.md');
    await fs.writeFile(
      filePath,
      '# Heading\r\n\r\n  First line   \r\n    Second line\r\n\r\n\r\nAfter\r\n',
      'utf8',
    );

    const result = await toolEdit({
      path: filePath,
      old_string: '# Heading\n\nFirst line\n  Second line\n\nAfter\n',
      new_string: '# Heading\n\nUpdated line\n  Second line\n\nAfter\n',
    }, ctx);

    expect(parseEditToolError(result)).toBeUndefined();
    await expect(fs.readFile(filePath, 'utf8')).resolves.toContain('Updated line');
  });

  it('preserves the target file line endings for normalized replacements', async () => {
    const filePath = path.join(tempDir, 'doc.md');
    await fs.writeFile(
      filePath,
      '# Heading\r\n\r\n  First line   \r\n    Second line\r\n\r\n\r\nAfter\r\n',
      'utf8',
    );

    await toolEdit({
      path: filePath,
      old_string: '# Heading\n\nFirst line\n  Second line\n\nAfter\n',
      new_string: '# Heading\n\nUpdated line\n  Second line\n\nAfter\n',
    }, ctx);

    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(
      '# Heading\r\n\r\nUpdated line\r\n  Second line\r\n\r\nAfter\r\n',
    );
  });

  it('returns a stable not-found error code', async () => {
    const filePath = path.join(tempDir, 'doc.md');
    await fs.writeFile(filePath, 'alpha\nbeta\n', 'utf8');

    const result = await toolEdit({
      path: filePath,
      old_string: 'missing section',
      new_string: 'replacement',
    }, ctx);

    expect(parseEditToolError(result)).toBe('EDIT_NOT_FOUND');
  });

  it('returns a stable too-large error code', async () => {
    const filePath = path.join(tempDir, 'doc.md');
    await fs.writeFile(filePath, 'alpha\nbeta\n', 'utf8');

    const veryLarge = Array.from({ length: 450 }, (_, index) => `line-${index}`).join('\n');
    const result = await toolEdit({
      path: filePath,
      old_string: veryLarge,
      new_string: 'replacement',
    }, ctx);

    expect(parseEditToolError(result)).toBe('EDIT_TOO_LARGE');
  });

  it('collects nearby anchor candidates for edit recovery', async () => {
    const filePath = path.join(tempDir, 'doc.md');
    await fs.writeFile(
      filePath,
      ['# Intro', '', '## Cross-feature intent', '', '- item 1', '- item 2', '', '## Next'].join('\n'),
      'utf8',
    );

    const diagnostic = await inspectEditFailure(
      filePath,
      'Cross-feature intent\n- item 3',
      ctx,
      120,
    );

    expect(diagnostic.candidates.length).toBeGreaterThan(0);
    expect(diagnostic.candidates[0]?.excerpt).toContain('Cross-feature intent');
  });
});

describe('insert_after_anchor tool', () => {
  let tempDir = '';
  let ctx: KodaXToolExecutionContext;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-anchor-'));
    ctx = {
      backups: new Map(),
      executionCwd: tempDir,
    };
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('inserts content after a unique anchor line', async () => {
    const filePath = path.join(tempDir, 'doc.md');
    await fs.writeFile(filePath, '# Intro\r\n\r\n## Cross-feature intent\r\n', 'utf8');

    const result = await toolInsertAfterAnchor({
      path: filePath,
      anchor: '## Cross-feature intent',
      content: '\r\nFEATURE_054 body\r\n',
    }, ctx);

    expect(result).toContain('Content inserted after anchor');
    await expect(fs.readFile(filePath, 'utf8')).resolves.toContain('FEATURE_054 body');
  });

  it('keeps insertion after the full line when the anchor is only a unique prefix', async () => {
    const filePath = path.join(tempDir, 'doc.md');
    await fs.writeFile(filePath, '# Intro\n\n## Cross-feature intent (draft)\nbody\n', 'utf8');

    const result = await toolInsertAfterAnchor({
      path: filePath,
      anchor: '## Cross-feature intent',
      content: '\nFEATURE_055 body\n',
    }, ctx);

    expect(result).toContain('Content inserted after anchor');
    await expect(fs.readFile(filePath, 'utf8')).resolves.toMatch(
      /## Cross-feature intent \(draft\)\n\nFEATURE_055 body\nbody\n$/,
    );
  });

  it('fails safely when the anchor is ambiguous', async () => {
    const filePath = path.join(tempDir, 'doc.md');
    await fs.writeFile(filePath, '## Title\nbody\n## Title\nmore\n', 'utf8');

    const result = await toolInsertAfterAnchor({
      path: filePath,
      anchor: '## Title',
      content: '\nnew section\n',
    }, ctx);

    expect(result).toContain('ANCHOR_AMBIGUOUS');
    await expect(fs.readFile(filePath, 'utf8')).resolves.not.toContain('new section');
  });
});
