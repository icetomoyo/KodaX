import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countTokens } from '../tokenizer.js';
import { createEnvelopeAggregateBudgetEnforcer } from './envelope-budget.js';
import type { ToolResultBudget } from './tool-result-budget.js';
import { TOOL_OUTPUT_DIR_ENV } from './truncate.js';

function budget(aggregateInlineTokens: number): ToolResultBudget {
  return { aggregateInlineTokens };
}

function envelopeTokens(fragments: readonly string[]): number {
  return countTokens(fragments.join('\n\n')) + 4;
}

describe('createEnvelopeAggregateBudgetEnforcer', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-envelope-budget-'));
    process.env[TOOL_OUTPUT_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const ctx = () => ({ backups: new Map(), executionCwd: process.cwd() });

  it('does not apply the former fixed 200k-character cap without a physical budget', async () => {
    const fragments = ['A'.repeat(150_000), 'B'.repeat(100_000)];
    const result = await createEnvelopeAggregateBudgetEnforcer(ctx())(fragments);

    expect(result).toEqual(fragments);
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('keeps every fragment verbatim when the complete envelope fits', async () => {
    const fragments = ['A '.repeat(9_000), 'B '.repeat(4_000)];
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx(), () => budget(100_000));

    expect(await enforce(fragments)).toEqual(fragments);
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('spills a pathological fragment at the attention boundary despite spare physical capacity', async () => {
    const fragment = 'attention evidence '.repeat(20_000);
    expect(countTokens(fragment)).toBeGreaterThan(16_000);
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx(), () => budget(200_000));

    const result = await enforce([fragment]);

    expect(result[0]).toContain('KODAX_RESULT_INCOMPLETE');
    const [artifact] = await fs.readdir(tempDir);
    expect(artifact).toBeDefined();
    expect(await fs.readFile(path.join(tempDir, artifact!), 'utf8')).toBe(fragment);
  });

  it('spills only after aggregate physical capacity is exceeded', async () => {
    const fragments = ['small', 'X\n'.repeat(4_000), 'tail'];
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx(), () => budget(500));
    const result = await enforce(fragments);

    expect(result[0]).toBe('small');
    expect(result[2]).toBe('tail');
    expect(result[1]).toContain('KODAX_RESULT_INCOMPLETE');
    expect(result[1]).toContain('Full output saved to:');
    expect(envelopeTokens(result)).toBeLessThanOrEqual(500);
    const [artifact] = await fs.readdir(tempDir);
    expect(artifact).toBeDefined();
    expect(await fs.readFile(path.join(tempDir, artifact!), 'utf-8')).toBe(fragments[1]);
  });

  it('does not nest an artifact when an incomplete envelope is checked again', async () => {
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx(), () => budget(500));
    const first = await enforce(['X\n'.repeat(4_000)]);
    const second = await enforce(first);

    expect((second[0]!.match(/KODAX_RESULT_INCOMPLETE/g) ?? [])).toHaveLength(1);
    expect((second[0]!.match(/Full output saved to:/g) ?? [])).toHaveLength(1);
    expect(await fs.readdir(tempDir)).toHaveLength(1);
  });

  it('admits with a marker and debt when even the minimum recoverable marker cannot fit', async () => {
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx(), () => budget(1));

    const result = await enforce(['X '.repeat(400)]);

    // FEATURE_296 (ADR-067): the envelope no longer fails on an irreducible
    // marker; it admits the marker fragment and records capacity debt.
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('KODAX_RESULT_INCOMPLETE');
  });
});
