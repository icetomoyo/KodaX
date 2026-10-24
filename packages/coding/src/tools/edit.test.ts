import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KodaXToolExecutionContext } from '../types.js';
import { createContentHashCache } from '../multi-instance/content-hash-cache.js';
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

  it('returns complete single-line replacements without a hidden 100-character preview cap', async () => {
    const filePath = path.join(tempDir, 'long-line.txt');
    const oldLine = `before-${'a'.repeat(180)}-old-tail`;
    const newLine = `after-${'b'.repeat(180)}-new-tail`;
    await fs.writeFile(filePath, oldLine, 'utf8');

    const result = await toolEdit({
      path: filePath,
      old_string: oldLine,
      new_string: newLine,
    }, ctx);

    expect(result).toContain(`- ${oldLine}`);
    expect(result).toContain(`+ ${newLine}`);
    expect(result).not.toContain('...');
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

  it('keeps normalized ambiguous append recovery on edit with unique surrounding text', async () => {
    const filePath = path.join(tempDir, 'sections.md');
    const before = '# Heading\r\nfirst\r\n# Heading\r\nsecond\r\n';
    await fs.writeFile(filePath, before);
    const rejected = await toolEdit({ path: filePath, edits: [
      { old_string: '# Heading\n', new_string: '# Heading\nnew\n' },
    ] }, ctx);
    expect(rejected).toContain('EDIT_AMBIGUOUS');
    expect(rejected).toContain('surrounding lines');
    expect(rejected).not.toContain('insert_after_anchor');
    expect(await fs.readFile(filePath, 'utf8')).toBe(before);
    expect(await toolEdit({ path: filePath, edits: [
      { old_string: '# Heading\r\nsecond', new_string: '# Heading\r\nnew\r\nsecond' },
    ] }, ctx)).not.toContain('[Tool Error]');
    expect(await fs.readFile(filePath, 'utf8')).toBe('# Heading\r\nfirst\r\n# Heading\r\nnew\r\nsecond\r\n');
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

  it('ambiguous exact match error reports the line numbers of each duplicate', async () => {
    // Parity with multi_edit — single-edit tool must also tell the LLM
    // where the duplicates are so it can widen the right one.
    const filePath = path.join(tempDir, 'dup.html');
    await fs.writeFile(
      filePath,
      [
        '<section id="intro">',          // line 1
        '  <h2>Shared heading</h2>',     // line 2 — first match
        '  <p>intro body</p>',           // line 3
        '</section>',                    // line 4
        '<section id="summary">',        // line 5
        '  <h2>Shared heading</h2>',     // line 6 — second match
        '  <p>summary body</p>',         // line 7
        '</section>',                    // line 8
      ].join('\n'),
      'utf8',
    );

    const result = await toolEdit({
      path: filePath,
      old_string: '<h2>Shared heading</h2>',
      new_string: '<h2>Updated</h2>',
    }, ctx);

    expect(parseEditToolError(result)).toBe('EDIT_AMBIGUOUS');
    expect(result).toContain('matched 2 places');
    expect(result).toMatch(/lines\s+2\s+and\s+6/);
    expect(result).toMatch(/replace_all=true/);
    expect(result).toMatch(/[Ss]horter anchors match more/);
  });

  it('not-found error flags the narrow-read pitfall for recovery', async () => {
    const filePath = path.join(tempDir, 'f.txt');
    await fs.writeFile(filePath, 'actual content', 'utf8');

    const result = await toolEdit({
      path: filePath,
      old_string: 'NEVER_IN_FILE',
      new_string: 'X',
    }, ctx);

    expect(parseEditToolError(result)).toBe('EDIT_NOT_FOUND');
    // V3 narrow-read hint: mentions "narrow `read`" (backticked) + the
    // alternative-diagnosis "never in the file" + suggests a wider re-read.
    expect(result).toMatch(/narrow\s*`?read`?/i);
    expect(result).toMatch(/never in the file/i);
    expect(result).toMatch(/wider/i);
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

  it('refreshes the stale-write hash for the next edit', async () => {
    const filePath = path.join(tempDir, 'hash-sequence.md');
    const original = '## Anchor\nold body\n';
    await fs.writeFile(filePath, original, 'utf8');
    const contentHashCache = createContentHashCache();
    contentHashCache.recordRead(filePath, original);
    ctx.contentHashCache = contentHashCache;

    await toolInsertAfterAnchor({
      path: filePath,
      anchor: '## Anchor',
      content: '\ninserted body\n',
    }, ctx);
    const result = await toolEdit({
      path: filePath,
      old_string: 'old body',
      new_string: 'new body',
    }, ctx);

    expect(result).toContain('File edited:');
    await expect(fs.readFile(filePath, 'utf8')).resolves.toContain('new body');
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
