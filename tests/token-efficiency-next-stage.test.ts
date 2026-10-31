import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FirstTurnBudget } from './first-turn-eval-support.js';
import {
  NEXT_STAGE_LIMITS, assertNextStageReservation, createEditReceiptPair,
  plannedNextStageCells, validateNextStageReview, buildNextStagePairs,
} from './token-efficiency-next-stage-fixtures.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('kodax-next-stage-test-')) throw new Error('Unsafe cleanup');
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('next-stage controlled evaluation', () => {
  it('freezes 21 calls with an eight-call pilot and one observation per identical negative control', () => {
    const cells = plannedNextStageCells();
    expect(cells).toHaveLength(21);
    expect(new Set(cells.map(cell => cell.id)).size).toBe(21);
    expect(cells.filter(cell => cell.caseId === 'edit-warning')).toHaveLength(3);
    expect(cells.filter(cell => cell.caseId === 'edit-warning').every(cell => cell.label === 'A')).toBe(true);
    expect(cells.filter(cell => cell.phase === 'pilot')).toHaveLength(8);
    expect(new Set(cells.map(cell => cell.route))).toEqual(new Set(['zhipu-coding', 'kimi-code', 'deepseek']));
  });

  it('enforces the stricter total-token limit before reserving the shared budget', () => {
    const budget = new FirstTurnBudget(undefined, NEXT_STAGE_LIMITS.calls);
    budget.state.chargedTokens = NEXT_STAGE_LIMITS.tokens - 10;
    expect(() => assertNextStageReservation(budget, 11, 0.01)).toThrow('Token budget');
    expect(budget.state.calls).toBe(0);
  });

  it('requires a review bound to the current blind packet before expanding', () => {
    expect(() => validateNextStageReview({ packetHash: 'old', decision: 'continue', reason: 'reviewed' }, 'current')).toThrow('review');
    expect(() => validateNextStageReview({ packetHash: 'current', decision: 'continue', reason: '' }, 'current')).toThrow('review');
    expect(validateNextStageReview({ packetHash: 'current', decision: 'continue', reason: 'Both arms preserve constraints.' }, 'current')).toBe('continue');
  });

  it.each([false, true])('uses actual edit handlers and preserves the same resulting file (normalized=%s)', async normalized => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-next-stage-test-'));
    roots.push(root);
    const pair = await createEditReceiptPair(root, normalized);
    expect(pair.afterBaseline).toBe(pair.afterCandidate);
    expect(pair.baseline).toContain('File edited:');
    expect(pair.candidate).toContain('File edited:');
    if (normalized) {
      expect(pair.candidate).toBe(pair.baseline);
      expect(pair.candidate).toContain('@@');
      expect(pair.candidate).toContain('[Warning: Another session is editing this file]');
    } else {
      expect(pair.candidate.length).toBeLessThan(pair.baseline.length);
      expect(pair.candidate).toContain('Applied exact replacement');
    }
  });

  it('assembles production root and child contracts without extra discovery calls', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-next-stage-test-'));
    roots.push(root);
    const pairs = await buildNextStagePairs(root);
    expect(pairs).toHaveLength(4);
    for (const pair of pairs) {
      expect(pair.baseline.tools.map(tool => tool.name)).toEqual(pair.candidate.tools.map(tool => tool.name));
      if (pair.id.startsWith('child')) {
        expect(pair.baseline.tools.some(tool => tool.name === 'get_goal')).toBe(false);
        expect(pair.candidate.system).not.toBe(pair.baseline.system);
      } else {
        expect(pair.candidate.system).toBe(pair.baseline.system);
        expect(pair.candidate.tools).toEqual(pair.baseline.tools);
      }
    }
  }, 120_000);
});
