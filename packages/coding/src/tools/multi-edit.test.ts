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
    // Atomicity verified functionally: file on disk is unchanged even
    // though edits[0] would have succeeded in isolation.
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

  it('ambiguous exact match error reports the line numbers of each duplicate', async () => {
    // Reproduces the Scout-narrow-read workflow: the LLM picks a short
    // snippet that unknowingly appears on 2 lines. The error must tell
    // it WHICH lines so the retry can widen the anchor around the one
    // it actually meant.
    const p = await writeFile(
      'dup.html',
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
    );

    const result = await toolMultiEdit(
      {
        path: p,
        edits: [
          { old_string: '<h2>Shared heading</h2>', new_string: '<h2>Updated</h2>' },
        ],
      },
      ctx,
    );

    expect(result).toContain('[Tool Error]');
    expect(result).toContain('matched 2 places');
    // Enriched: includes both line numbers so the LLM can see where the
    // duplicates are and pick a unique surrounding landmark.
    expect(result).toMatch(/lines\s+2\s+and\s+6/);
    // Still suggests both recovery tactics.
    expect(result).toMatch(/replace_all=true/);
    expect(result).toMatch(/[Ww]iden/);
    // Anti-shortening hint is retained so the LLM doesn't respond to
    // ambiguity by picking a shorter snippet.
    expect(result).toMatch(/[Ss]horter anchors match more/);
  });

  it('missing-anchor error points at the narrow-read pitfall', async () => {
    // When the LLM picks an anchor from a narrow read window that doesn't
    // actually match the file (typo / whitespace drift / hallucination),
    // the error must suggest widening the read — not just "re-read".
    const p = await writeFile('f.txt', 'actual content');

    const result = await toolMultiEdit(
      {
        path: p,
        edits: [
          { old_string: 'NEVER_IN_FILE', new_string: 'X' },
        ],
      },
      ctx,
    );

    expect(result).toContain('[Tool Error]');
    expect(result).toContain('old_string not found');
    // V3 narrow-read hint: mentions "narrow `read`" (backticked) + the
    // alternative-diagnosis "never in the file" + suggests a wider re-read.
    expect(result).toMatch(/narrow\s*`?read`?/i);
    expect(result).toMatch(/never in the file/i);
    expect(result).toMatch(/wider/i);
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

describe('multi_edit — anchor-consumed-by-prior-edit diagnostic', () => {
  it('detects when a later edit\'s anchor was swallowed by an earlier edit and gives a targeted hint', async () => {
    // Mirrors the Scout slide-deck case: edits[0] replaces a region that
    // includes the SLIDE_22 marker; edits[1] tries to use SLIDE_22 as an
    // anchor and fails because edits[0] already removed it in memory.
    const p = await writeFile(
      'deck.html',
      [
        '<!-- SLIDE_20 -->',
        '<section>slide 20</section>',
        '<!-- SLIDE_21 -->',
        '<section>slide 21</section>',
        '<!-- SLIDE_22 -->',
        '<section>slide 22</section>',
      ].join('\n'),
    );
    const original = await fs.readFile(p, 'utf-8');

    const result = await toolMultiEdit(
      {
        path: p,
        edits: [
          {
            old_string:
              '<!-- SLIDE_20 -->\n<section>slide 20</section>\n<!-- SLIDE_21 -->\n<section>slide 21</section>\n<!-- SLIDE_22 -->',
            new_string: '',
          },
          {
            // This anchor was just consumed by edits[0] above.
            old_string: '<!-- SLIDE_22 -->',
            new_string: '<!-- SLIDE_22 KEEP -->',
          },
        ],
      },
      ctx,
    );

    // Targeted diagnostic: tells the LLM the anchor was right in the
    // original but was covered by a prior edit in this batch.
    expect(result).toContain('edits[1]');
    expect(result).toMatch(/present in the original file but\s+was consumed/);
    // For index=1 the prior range collapses to just 'edits[0]'
    expect(result).toContain("consumed by edits[0]");
    // Actionable recovery options are both mentioned.
    expect(result).toMatch(/[Ss]hrink that earlier edit/);
    expect(result).toMatch(/[Pp]ick a different anchor/);
    // Atomicity: file unchanged on disk
    const after = await fs.readFile(p, 'utf-8');
    expect(after).toBe(original);
  });

  it('keeps the generic "not found" message when the anchor was never in the file at all', async () => {
    // The LLM-error case: anchor is simply wrong, no prior-edit involvement.
    const p = await writeFile('x.txt', 'alpha beta gamma');
    const result = await toolMultiEdit(
      {
        path: p,
        edits: [
          { old_string: 'alpha', new_string: 'ALPHA' },
          // Truly missing — not consumed by the earlier edit.
          { old_string: 'DEFINITELY_ABSENT', new_string: 'X' },
        ],
      },
      ctx,
    );
    expect(result).toContain('edits[1]');
    expect(result).toContain('not found');
    // The targeted "anchor was consumed" diagnostic must NOT fire here.
    expect(result).not.toMatch(/present in the original file but\s+was consumed/);
  });

  it('does not mistake an ambiguous-in-original anchor as consumed', async () => {
    // Anchor appears twice in the file; edits[1] without replace_all
    // would legitimately fail with the "matched N places" message even
    // before any prior edit was applied. Make sure we still return the
    // ambiguous-match diagnostic, not the consumed-anchor one.
    const p = await writeFile(
      'x.txt',
      ['TARGET', 'middle', 'TARGET'].join('\n'),
    );
    const result = await toolMultiEdit(
      {
        path: p,
        edits: [
          { old_string: 'middle', new_string: 'MIDDLE' },
          { old_string: 'TARGET', new_string: 'X' }, // ambiguous
        ],
      },
      ctx,
    );
    expect(result).toContain('edits[1]');
    // Current content still has both TARGETs → ambiguous, not missing
    expect(result).toContain('matched 2 places');
    expect(result).not.toContain('consumed by an earlier edit');
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
