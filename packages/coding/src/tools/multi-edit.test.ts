/**
 * P2a tests — `multi_edit` tool.
 *
 * Semantic contract this test suite enforces:
 *   - Sequential: edit[i+1] operates on the output of edit[i]
 *   - Atomic: if any single old_string fails, NO edits land on disk
 *   - Match semantics parity with `edit`: exact-match → normalized fallback
 *   - Non-empty, non-identical input validation
 *   - Correct diff / replacement counts in the result summary
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { toolMultiEdit } from './multi-edit.js';
import type { KodaXToolExecutionContext } from '../types.js';

function makeCtx(executionCwd: string): KodaXToolExecutionContext {
  return {
    executionCwd,
    backups: new Map(),
    mutationTracker: { files: new Set() },
  } as unknown as KodaXToolExecutionContext;
}

let workDir: string;
let ctx: KodaXToolExecutionContext;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-multi-edit-'));
  ctx = makeCtx(workDir);
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

async function writeFile(name: string, content: string): Promise<string> {
  const p = path.join(workDir, name);
  await fs.writeFile(p, content, 'utf-8');
  return p;
}

describe('multi_edit — success paths', () => {
  it('applies multiple sequential edits atomically and writes once', async () => {
    const p = await writeFile(
      'skeleton.html',
      [
        '<html>',
        '<!-- SECTION_A -->',
        '<!-- SECTION_B -->',
        '<!-- SECTION_C -->',
        '</html>',
      ].join('\n'),
    );

    const result = await toolMultiEdit(
      {
        path: p,
        edits: [
          { old_string: '<!-- SECTION_A -->', new_string: '<h1>A</h1>' },
          { old_string: '<!-- SECTION_B -->', new_string: '<h1>B</h1>' },
          { old_string: '<!-- SECTION_C -->', new_string: '<h1>C</h1>' },
        ],
      },
      ctx,
    );

    expect(result).toContain('File edited');
    expect(result).toContain('3 edits');
    const written = await fs.readFile(p, 'utf-8');
    expect(written).toContain('<h1>A</h1>');
    expect(written).toContain('<h1>B</h1>');
    expect(written).toContain('<h1>C</h1>');
    expect(written).not.toContain('<!-- SECTION_A -->');
  });

  it('edit[i+1] sees the result of edit[i] (sequential dependency)', async () => {
    const p = await writeFile('dep.txt', 'ONE TWO THREE');

    const result = await toolMultiEdit(
      {
        path: p,
        edits: [
          { old_string: 'ONE', new_string: 'FIRST' },
          // This one only matches AFTER the first edit runs.
          { old_string: 'FIRST TWO', new_string: 'PAIR' },
        ],
      },
      ctx,
    );

    expect(result).toContain('File edited');
    expect(await fs.readFile(p, 'utf-8')).toBe('PAIR THREE');
  });

  it('replace_all per-edit replaces every occurrence', async () => {
    const p = await writeFile('rename.ts', 'foo bar foo baz foo');

    const result = await toolMultiEdit(
      {
        path: p,
        edits: [
          { old_string: 'foo', new_string: 'XXX', replace_all: true },
        ],
      },
      ctx,
    );

    expect(result).toContain('3 replacement');
    expect(await fs.readFile(p, 'utf-8')).toBe('XXX bar XXX baz XXX');
  });

  it('handles CRLF-vs-LF drift via normalized fallback', async () => {
    // Source file has CRLF, old_string uses LF. The normalized fallback
    // path in text-anchor normalizes EOLs before matching, then writes
    // back preserving the file's original EOL style.
    const crlfContent = ['alpha', 'beta', 'gamma'].join('\r\n');
    const p = await writeFile('eol.txt', crlfContent);

    const result = await toolMultiEdit(
      {
        path: p,
        edits: [
          { old_string: 'alpha\nbeta', new_string: 'ONE\nTWO' },
        ],
      },
      ctx,
    );

    expect(result).toContain('File edited');
    const after = await fs.readFile(p, 'utf-8');
    expect(after).toContain('ONE');
    expect(after).toContain('TWO');
    expect(after).toContain('gamma');
  });
});

describe('multi_edit — atomic failure', () => {
  it('writes NOTHING to disk when any single edit fails to match', async () => {
    const p = await writeFile('a.txt', 'KEEP-1 KEEP-2 KEEP-3');
    const original = await fs.readFile(p, 'utf-8');

    const result = await toolMultiEdit(
      {
        path: p,
        edits: [
          { old_string: 'KEEP-1', new_string: 'X' },          // would succeed
          { old_string: 'NONEXISTENT', new_string: 'Y' },     // fails
          { old_string: 'KEEP-3', new_string: 'Z' },          // would succeed
        ],
      },
      ctx,
    );

    expect(result).toContain('[Tool Error]');
    expect(result).toContain('edits[1]');
    expect(result).toContain('old_string not found');
    expect(result).toContain('no edits have been applied');
    const onDisk = await fs.readFile(p, 'utf-8');
    expect(onDisk).toBe(original);
  });

  it('rejects ambiguous match without replace_all and aborts the batch', async () => {
    const p = await writeFile('amb.txt', 'foo foo foo');
    const original = await fs.readFile(p, 'utf-8');

    const result = await toolMultiEdit(
      {
        path: p,
        edits: [
          { old_string: 'foo', new_string: 'bar' }, // ambiguous, no replace_all
        ],
      },
      ctx,
    );

    expect(result).toContain('[Tool Error]');
    expect(result).toContain('matched 3 places');
    expect(await fs.readFile(p, 'utf-8')).toBe(original);
  });
});

describe('multi_edit — input validation', () => {
  it('errors when file does not exist', async () => {
    const result = await toolMultiEdit(
      {
        path: path.join(workDir, 'missing.txt'),
        edits: [{ old_string: 'a', new_string: 'b' }],
      },
      ctx,
    );
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('File not found');
  });

  it('errors when edits is empty', async () => {
    const p = await writeFile('x.txt', 'hello');
    const result = await toolMultiEdit({ path: p, edits: [] }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('non-empty array');
  });

  it('errors when an edit has identical old/new string', async () => {
    const p = await writeFile('x.txt', 'hello');
    const result = await toolMultiEdit(
      {
        path: p,
        edits: [{ old_string: 'hello', new_string: 'hello' }],
      },
      ctx,
    );
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('no-op');
  });

  it('errors when an edit has empty old_string', async () => {
    const p = await writeFile('x.txt', 'hello');
    const result = await toolMultiEdit(
      {
        path: p,
        edits: [{ old_string: '', new_string: 'x' }],
      },
      ctx,
    );
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('old_string must be non-empty');
  });

  it('errors when net content change is zero across all edits', async () => {
    // This can happen if all edits produce no-op substitutions (e.g.
    // writing the same text back). The atomic path still writes a
    // backup but should surface the zero-change case distinctly.
    const p = await writeFile('x.txt', 'AAA BBB');
    const result = await toolMultiEdit(
      {
        path: p,
        edits: [
          // Replacement produces the same final content as the input.
          { old_string: 'AAA BBB', new_string: 'AAA BBB' },
        ],
      },
      ctx,
    );
    // This one is caught by the identical-string check, not the zero-change check.
    expect(result).toContain('[Tool Error]');
  });
});

describe('multi_edit — backups', () => {
  it('records the original content in ctx.backups before writing', async () => {
    const p = await writeFile('x.txt', 'ORIGINAL');
    await toolMultiEdit(
      {
        path: p,
        edits: [{ old_string: 'ORIGINAL', new_string: 'NEW' }],
      },
      ctx,
    );
    expect(ctx.backups.get(p)).toBe('ORIGINAL');
  });

  it('does NOT record a backup when the batch fails', async () => {
    const p = await writeFile('x.txt', 'ORIGINAL');
    await toolMultiEdit(
      {
        path: p,
        edits: [{ old_string: 'NONEXISTENT', new_string: 'X' }],
      },
      ctx,
    );
    expect(ctx.backups.has(p)).toBe(false);
  });
});
