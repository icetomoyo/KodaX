import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { FEATURE_308_READ_CASES, FEATURE_308_WRITE_CASES } from './cases.js';
import {
  FEATURE_308_ALIASES,
  FEATURE_308_BUDGET,
  FEATURE_308_BUDGET_CONFIRMATION,
  FEATURE_308_RAW_ROOT,
  FEATURE_308_READ_CASES_SHA256,
  FEATURE_308_REVISION,
  FEATURE_308_WRITE_CASES_SHA256,
  buildFeature308ExperimentContract,
} from './experiment-contract.js';

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

describe('FEATURE_308 experiment contract', () => {
  it('pins the case data hashes', () => {
    expect(sha(FEATURE_308_READ_CASES)).toBe(FEATURE_308_READ_CASES_SHA256);
    expect(sha(FEATURE_308_WRITE_CASES)).toBe(FEATURE_308_WRITE_CASES_SHA256);
  });

  it('builds a stable contract (same bytes on every call)', () => {
    expect(JSON.stringify(buildFeature308ExperimentContract()))
      .toBe(JSON.stringify(buildFeature308ExperimentContract()));
  });

  it('freezes the panel and revision', () => {
    expect(FEATURE_308_ALIASES).toEqual(['ark/v4flash', 'zhipu/glm52']);
    expect(FEATURE_308_REVISION).toBe('f306-phase0-r2');
    expect(FEATURE_308_RAW_ROOT).toContain('kodax-eval-dumps');
    expect(FEATURE_308_RAW_ROOT).toContain('feature-306');
  });

  it('derives planned calls from cases, aliases and repetitions and leaves headroom', () => {
    const perAliasRepetition = FEATURE_308_READ_CASES.length * 2 + FEATURE_308_WRITE_CASES.length;
    expect(FEATURE_308_BUDGET.plannedCalls)
      .toBe(perAliasRepetition * FEATURE_308_ALIASES.length * FEATURE_308_BUDGET.repetitions);
    expect(FEATURE_308_BUDGET.plannedCalls).toBe(80);
    expect(FEATURE_308_BUDGET.plannedCalls).toBeLessThan(FEATURE_308_BUDGET.maxProviderCalls);
  });

  it('holds the frozen hard budgets', () => {
    expect(FEATURE_308_BUDGET).toMatchObject({
      maxProviderCalls: 108,
      maxCallsPerCell: 1,
      maxRoundsPerCell: 1,
      maxExternalSpendUsd: 8,
    });
    expect(FEATURE_308_BUDGET.maxOutputTokensPerCall).toBeGreaterThanOrEqual(8192);
  });

  it('requires an exact budget confirmation string that names the caps', () => {
    expect(FEATURE_308_BUDGET_CONFIRMATION).toBe('f306-phase0-r2:calls=108:tokens=1250000:usd=8');
  });
});
