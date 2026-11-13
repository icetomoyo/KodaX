import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runOneShotMock = vi.hoisted(() => vi.fn());
vi.mock('../../harness/harness.js', () => ({ runOneShot: runOneShotMock }));

import { FEATURE_308_PROBE_CASES } from './cases.js';
import {
  NOTES_BUDGET,
  NOTES_BUDGET_CONFIRMATION,
  buildNotesExperimentContract,
} from './experiment-contract.js';
import { armOrder, assertLedgerAllows, deriveTokenBudget, plannedCells, prepare, run } from './runner.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'f306-notes-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); runOneShotMock.mockReset(); });

describe('experiment contract', () => {
  it('pins the case hashes and plans exactly the budgeted number of calls', () => {
    expect(() => buildNotesExperimentContract()).not.toThrow();
    expect(plannedCells()).toHaveLength(NOTES_BUDGET.plannedCalls);
    expect(new Set(plannedCells().map((cell) => cell.key)).size).toBe(NOTES_BUDGET.plannedCalls);
    expect(NOTES_BUDGET.maxProviderCalls).toBeGreaterThanOrEqual(NOTES_BUDGET.plannedCalls);
  });

  it('runs probes only on arm N and A/B only for the alias Phase 0 never ran', () => {
    const cells = plannedCells();
    expect(cells.filter((cell) => cell.kind === 'probe').every((cell) => cell.arm === 'N')).toBe(true);
    const baselineAliases = new Set(cells.filter((cell) => cell.arm !== 'N').map((cell) => cell.alias));
    expect([...baselineAliases]).toEqual(['ark/k27']);
    expect(cells.filter((cell) => cell.kind === 'probe')).toHaveLength(FEATURE_308_PROBE_CASES.length * 3 * NOTES_BUDGET.repetitions);
  });
});

describe('budget guards', () => {
  const cell = { key: 'k', alias: 'ark/v4flash' as const, estimatedInputTokens: 10_000 };
  const state = (over: Partial<{ calls: number; committedTokens: number; committedUsd: number; requested: string[] }> = {}) => ({
    calls: over.calls ?? 0,
    committedTokens: over.committedTokens ?? 0,
    committedUsd: over.committedUsd ?? 0,
    requestedCells: new Set(over.requested ?? []),
  });

  it('refuses a repeated cell, the call cap and the token cap', () => {
    expect(() => assertLedgerAllows(state(), cell)).not.toThrow();
    expect(() => assertLedgerAllows(state({ requested: ['k'] }), cell)).toThrow('per-cell');
    expect(() => assertLedgerAllows(state({ calls: NOTES_BUDGET.maxProviderCalls }), cell)).toThrow('call cap');
    expect(() => assertLedgerAllows(state({ committedTokens: NOTES_BUDGET.maxTotalTokens }), cell)).toThrow('token cap');
  });

  it('derives the token budget as 1.25 x (input + expected output), rounded up to 50k', () => {
    const derived = deriveTokenBudget([{ estimatedInputTokens: 100_000 }, { estimatedInputTokens: 100_000 }]);
    expect(derived.derivedMaxTotalTokens).toBe(300_000);
  });
});

describe('paid run gate', () => {
  it('needs the exact confirmation string and makes no provider call without it', async () => {
    await expect(run({ confirmBudget: 'yes', rawRoot: root })).rejects.toThrow(NOTES_BUDGET_CONFIRMATION);
    expect(runOneShotMock).not.toHaveBeenCalled();
  });
});

describe('blinding', () => {
  it('orders the three arms deterministically and as a permutation', () => {
    const order = armOrder('ark_v4flash__c1__rep1');
    expect([...order].sort()).toEqual(['A', 'B', 'N']);
    expect(armOrder('ark_v4flash__c1__rep1')).toEqual(order);
  });
});

describe('prepare', () => {
  it('stays inside the frozen token budget and finds the Phase 0 baseline inputs unchanged', async () => {
    const summary = await prepare(root);
    expect(summary.cells).toBe(NOTES_BUDGET.plannedCalls);
    expect(summary.frozenCoversDerived).toBe(true);
    expect(summary.baselineHashMismatches).toEqual([]);
  }, 300_000);
});
