import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool, getToolDefinition } from './index.js';
import { getActiveToolDefinitions } from '../agent-runtime/tool-resolution.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { initGitRepo } from './test-helpers.js';

describe('canonical file tool contracts', () => {
  let directory: string;
  let ctx: KodaXToolExecutionContext;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kodax-file-contract-'));
    ctx = { executionCwd: directory, backups: new Map() };
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('executes a sequential atomic edit batch through the public registry', async () => {
    const path = join(directory, 'sample.txt');
    await writeFile(path, 'alpha beta\n');
    const result = await executeTool('edit', { path, edits: [
      { old_string: 'alpha', new_string: 'gamma' },
      { old_string: 'gamma beta', new_string: 'complete' },
    ] }, ctx);
    expect(result).not.toContain('[Tool Error]');
    expect(await readFile(path, 'utf8')).toBe('complete\n');
    expect([...ctx.backups.values()]).toEqual(['alpha beta\n']);
  });

  it('advertises the canonical edit array without changing the raw compatibility contract', () => {
    const raw = getToolDefinition('edit');
    const before = JSON.stringify(raw);
    const [model] = getActiveToolDefinitions(['edit']);
    expect(model?.input_schema.required).toEqual(['path', 'edits']);
    expect(Object.keys(model!.input_schema.properties)).toEqual(['path', 'edits']);
    expect(raw?.input_schema.properties).toHaveProperty('old_string');
    expect(JSON.stringify(getToolDefinition('edit'))).toBe(before);
  });

  it('keeps failed batches untouched, rejects mixed branches, and preserves legacy calls', async () => {
    const path = join(directory, 'sample.txt');
    await writeFile(path, 'alpha beta\n');
    const failed = await executeTool('edit', { path, edits: [
      { old_string: 'alpha', new_string: 'gamma' },
      { old_string: 'absent', new_string: 'complete' },
    ] }, ctx);
    expect(failed).toContain('[Tool Error] edit: edits[1]');
    expect(await readFile(path, 'utf8')).toBe('alpha beta\n');
    expect(ctx.backups.size).toBe(0);
    const mixed = await executeTool('edit', {
      path, edits: [{ old_string: 'alpha', new_string: 'gamma' }],
      old_string: 'beta', new_string: 'delta',
    }, ctx);
    expect(mixed).toContain('[Tool Error] edit:');
    expect(await readFile(path, 'utf8')).toBe('alpha beta\n');
    for (const [name, input] of [
      ['edit', { path, edits: [{ old_string: 'alpha', new_string: 'gamma' }] }],
      ['edit', { path, old_string: 'gamma', new_string: 'delta' }],
      ['multi_edit', { path, edits: [{ old_string: 'delta', new_string: 'done' }] }],
    ] as const) {
      expect(await executeTool(name, input, ctx)).not.toContain('[Tool Error]');
    }
    expect(await readFile(path, 'utf8')).toBe('done beta\n');
  });

  it.each([
    { old_string: 'missing', new_string: 'new' },
    { old_string: 'alpha', new_string: 'new' },
    { old_string: 'x'.repeat(65 * 1024), new_string: 'new' },
  ])('retains precise legacy recovery diagnostics for a single array edit', async (edit) => {
    const path = join(directory, 'sample.txt');
    await writeFile(path, 'alpha\nalpha\n');
    const legacy = await executeTool('edit', { path, ...edit }, ctx);
    const canonical = await executeTool('edit', { path, edits: [edit] }, ctx);
    expect(canonical).toBe(legacy);
    expect(canonical).toMatch(/EDIT_(NOT_FOUND|AMBIGUOUS|TOO_LARGE)/);
    expect(await readFile(path, 'utf8')).toBe('alpha\nalpha\n');
  });

  it('reads one or several changed paths with per-path pagination through changed_diff', async () => {
    initGitRepo(directory);
    await writeFile(join(directory, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    await writeFile(join(directory, 'b.txt'), 'red\nblue\ngreen\n');
    const first = await executeTool('changed_diff', { paths: ['a.txt', 'b.txt'], limit_per_path: 6 }, ctx);
    expect(first).not.toContain('[Tool Error]');
    expect(first).toContain('=== a.txt ===');
    expect(first).toContain('=== b.txt ===');
    expect(first).toContain('Showing diff lines 1-6');
    expect(first).toContain('paths=["a.txt"] offset=7 limit_per_path=6');
    const next = await executeTool('changed_diff', { paths: ['a.txt'], offset: 7, limit_per_path: 6 }, ctx);
    expect(next).toContain('+two');
    expect(next).toContain('[End of diff]');
    for (const [name, input] of [
      ['changed_diff', { path: 'a.txt', limit: 6 }],
      ['changed_diff_bundle', { paths: ['a.txt'], limit_per_path: 6 }],
    ] as const) {
      expect(await executeTool(name, input, ctx)).not.toContain('[Tool Error]');
    }
  });

  it.each([
    { paths: ['a.txt'], path: 'b.txt' },
    { paths: ['a.txt'], limit: 4 },
    { path: 'a.txt', limit_per_path: 4 },
    { paths: [] },
    { paths: 'a.txt' },
    { paths: ['a.txt', 1] },
  ])('rejects malformed or mixed diff branches: %j', async (input) => {
    expect(await executeTool('changed_diff', input, ctx)).toContain('[Tool Error] changed_diff:');
  });

  it('retains workspace containment and the unique-path limit for array diffs', async () => {
    initGitRepo(directory);
    expect(await executeTool('changed_diff', { paths: ['../outside.txt'] }, ctx)).toContain('must stay within');
    expect(await executeTool('changed_diff', { paths: Array.from({ length: 65 }, (_, index) => `${index}.txt`) }, ctx))
      .toContain('at most 64 unique paths');
  });
});
